package payments

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/outbox/pbstore"
	"github.com/Lattice/backend/internal/plugins/payments/ledger"
)

var (
	ErrProviderNotFound         = errors.New("payment provider not found")
	ErrIdempotencyConflict       = errors.New("idempotency key reused with different parameters")
	ErrAmountCurrencyMismatch    = errors.New("webhook amount or currency does not match ledger record")
	ErrPaymentNotFound           = errors.New("payment record not found")
	ErrInvalidRefundAmount       = errors.New("refund amount must be positive and cannot exceed remaining balance")
	ErrInvalidStatusTransition   = errors.New("invalid payment status transition")
	ErrPaymentNotRefundable      = errors.New("payment cannot be refunded in its current status")
)

type CheckoutInput struct {
	OrderID        string         `json:"order_id"`
	UserID         string         `json:"user_id,omitempty"`
	Amount         int64          `json:"amount"`
	Currency       string         `json:"currency"`
	Provider       string         `json:"provider,omitempty"`
	IdempotencyKey string         `json:"idempotency_key"`
	ReturnURL      string         `json:"return_url,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

type Service struct {
	mu              sync.RWMutex
	app             core.App
	outboxStore     *pbstore.Store
	providers       map[string]PaymentProvider
	defaultProvider string
}

func NewService(app core.App) *Service {
	return &Service{
		app:         app,
		outboxStore: pbstore.New(app),
		providers:   make(map[string]PaymentProvider),
	}
}

func (s *Service) RegisterProvider(p PaymentProvider) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.providers[p.Name()] = p
	if s.defaultProvider == "" {
		s.defaultProvider = p.Name()
	}
}

func (s *Service) SetDefaultProvider(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.defaultProvider = name
}

func (s *Service) GetProvider(name string) (PaymentProvider, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if name == "" {
		name = s.defaultProvider
	}
	p, ok := s.providers[name]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrProviderNotFound, name)
	}
	return p, nil
}

// CreateCheckout initiates or replays a payment transaction.
// Enforces ownership check and provider comparison on idempotency replays.
func (s *Service) CreateCheckout(ctx context.Context, tenantID string, in CheckoutInput) (*ledger.Record, error) {
	provider, err := s.GetProvider(in.Provider)
	if err != nil {
		return nil, err
	}

	if in.IdempotencyKey != "" {
		existing, err := ledger.FindByIdempotencyKey(s.app, in.IdempotencyKey)
		if err == nil && existing != nil {
			// Require matching ownership before returning an existing checkout
			if in.UserID != "" && existing.UserID != in.UserID {
				return nil, ErrIdempotencyConflict
			}
			if existing.UserID != "" && existing.UserID != in.UserID {
				return nil, ErrIdempotencyConflict
			}
			// Include the resolved provider in the replay comparison
			if existing.Amount == in.Amount &&
				existing.Currency == in.Currency &&
				existing.OrderID == in.OrderID &&
				existing.Provider == provider.Name() {
				return existing, nil
			}
			return nil, ErrIdempotencyConflict
		}
	}

	chargeRes, err := provider.CreateCharge(ctx, ChargeRequest{
		OrderID:        in.OrderID,
		UserID:         in.UserID,
		Amount:         in.Amount,
		Currency:       in.Currency,
		IdempotencyKey: in.IdempotencyKey,
		ReturnURL:      in.ReturnURL,
		Metadata:       in.Metadata,
	})
	if err != nil {
		return nil, fmt.Errorf("provider charge failed: %w", err)
	}

	var created *ledger.Record
	err = s.app.RunInTransaction(func(txApp core.App) error {
		var err error
		created, err = ledger.Create(txApp, ledger.Record{
			OrderID:          in.OrderID,
			UserID:           in.UserID,
			Status:           chargeRes.Status,
			Amount:           in.Amount,
			Currency:         in.Currency,
			Provider:         provider.Name(),
			ProviderChargeID: chargeRes.ProviderChargeID,
			IdempotencyKey:   in.IdempotencyKey,
			PaymentURL:       chargeRes.PaymentURL,
			Metadata:         in.Metadata,
		})
		if err != nil {
			return err
		}

		event := outbox.Event{
			ID:         fmt.Sprintf("evt_checkout_%s", created.ID),
			Type:       "payment.created",
			Version:    1,
			OccurredAt: time.Now().UTC(),
			TenantID:   tenantID,
			Data: map[string]any{
				"payment_id":         created.ID,
				"order_id":           created.OrderID,
				"user_id":            created.UserID,
				"amount":             created.Amount,
				"currency":           created.Currency,
				"provider":           created.Provider,
				"provider_charge_id": created.ProviderChargeID,
				"status":             created.Status,
			},
		}
		return s.outboxStore.EnqueueTx(txApp, event)
	})
	if err != nil {
		return nil, fmt.Errorf("transaction failed: %w", err)
	}

	return created, nil
}

func isValidStatusTransition(current, target string) bool {
	if current == target {
		return true
	}
	switch current {
	case "pending":
		return target == "succeeded" || target == "failed"
	case "succeeded":
		return target == "partially_refunded" || target == "refunded"
	case "partially_refunded":
		return target == "refunded"
	case "failed", "refunded":
		return false
	default:
		return false
	}
}

// HandleWebhook verifies the raw body HMAC signature and updates ledger status.
// It strictly validates amount and currency, and enforces valid state transitions inside the transaction.
func (s *Service) HandleWebhook(ctx context.Context, tenantID string, providerName string, rawBody []byte, headers http.Header) (*ledger.Record, error) {
	provider, err := s.GetProvider(providerName)
	if err != nil {
		return nil, err
	}

	event, err := provider.VerifyWebhook(ctx, rawBody, headers)
	if err != nil {
		return nil, fmt.Errorf("verify webhook: %w", err)
	}

	rec, err := ledger.FindByProviderChargeID(s.app, event.ProviderChargeID)
	if err != nil {
		return nil, fmt.Errorf("%w for provider_charge_id: %s", ErrPaymentNotFound, event.ProviderChargeID)
	}

	if rec.Amount != event.Amount || rec.Currency != event.Currency {
		return nil, fmt.Errorf("%w: expected %d %s, got %d %s", ErrAmountCurrencyMismatch, rec.Amount, rec.Currency, event.Amount, event.Currency)
	}

	var updated *ledger.Record
	err = s.app.RunInTransaction(func(txApp core.App) error {
		currentRec, err := ledger.FindByID(txApp, rec.ID)
		if err != nil {
			return err
		}

		if currentRec.Amount != event.Amount || currentRec.Currency != event.Currency {
			return fmt.Errorf("%w: expected %d %s, got %d %s", ErrAmountCurrencyMismatch, currentRec.Amount, currentRec.Currency, event.Amount, event.Currency)
		}

		// Idempotent duplicate: same status already reached
		if currentRec.Status == event.Status {
			updated = currentRec
			return nil
		}

		// Validate transition from current authoritative state
		if !isValidStatusTransition(currentRec.Status, event.Status) {
			return fmt.Errorf("%w: cannot transition from %q to %q", ErrInvalidStatusTransition, currentRec.Status, event.Status)
		}

		updated, err = ledger.UpdateStatus(txApp, currentRec.ID, event.Status, event.ProviderChargeID, event.RawData)
		if err != nil {
			return err
		}

		outboxEvent := outbox.Event{
			ID:         fmt.Sprintf("evt_wh_%s_%s", currentRec.ID, event.Status),
			Type:       fmt.Sprintf("payment.%s", event.Status),
			Version:    1,
			OccurredAt: time.Now().UTC(),
			TenantID:   tenantID,
			Data: map[string]any{
				"payment_id":         currentRec.ID,
				"order_id":           currentRec.OrderID,
				"status":             event.Status,
				"amount":             currentRec.Amount,
				"currency":           currentRec.Currency,
				"provider":           provider.Name(),
				"provider_charge_id": event.ProviderChargeID,
			},
		}
		return s.outboxStore.EnqueueTx(txApp, outboxEvent)
	})
	if err != nil {
		return nil, fmt.Errorf("webhook update transaction: %w", err)
	}

	return updated, nil
}

func parseAmount(val any) int64 {
	switch v := val.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	default:
		return 0
	}
}

func getRefundHistory(metadata map[string]any) (int64, map[string]map[string]any) {
	if metadata == nil {
		return 0, make(map[string]map[string]any)
	}

	history := make(map[string]map[string]any)
	var totalFromHistory int64
	if rawRefunds, ok := metadata["refunds"].(map[string]any); ok {
		for k, raw := range rawRefunds {
			if entryMap, ok := raw.(map[string]any); ok {
				history[k] = entryMap
				totalFromHistory += parseAmount(entryMap["amount"])
			}
		}
	}

	var totalRefunded int64
	if val, ok := metadata["refunded_amount"]; ok {
		totalRefunded = parseAmount(val)
	}
	if totalFromHistory > totalRefunded {
		totalRefunded = totalFromHistory
	}

	return totalRefunded, history
}

// Refund initiates a refund (full or partial) and updates the ledger record atomically.
// Accumulates cumulative refunds against remaining balance, and handles idempotent replays and conflicts.
func (s *Service) Refund(ctx context.Context, tenantID string, paymentID string, amount int64, reason string, idempotencyKey string) (*ledger.Record, error) {
	rec, err := ledger.FindByID(s.app, paymentID)
	if err != nil {
		return nil, ErrPaymentNotFound
	}

	if rec.Status != "succeeded" && rec.Status != "partially_refunded" {
		return nil, ErrPaymentNotRefundable
	}

	totalRefunded, history := getRefundHistory(rec.Metadata)

	// Check idempotency replay before calling provider
	if idempotencyKey != "" {
		if prev, ok := history[idempotencyKey]; ok {
			prevAmount := parseAmount(prev["amount"])
			prevReason, _ := prev["reason"].(string)
			if prevAmount == amount && (reason == "" || prevReason == reason) {
				// Replay of previous successful refund
				return rec, nil
			}
			return nil, ErrIdempotencyConflict
		}
	}

	remaining := rec.Amount - totalRefunded
	if amount <= 0 || amount > remaining {
		return nil, ErrInvalidRefundAmount
	}

	provider, err := s.GetProvider(rec.Provider)
	if err != nil {
		return nil, err
	}

	res, err := provider.Refund(ctx, RefundRequest{
		ProviderChargeID: rec.ProviderChargeID,
		Amount:           amount,
		Currency:         rec.Currency,
		Reason:           reason,
		IdempotencyKey:   idempotencyKey,
	})
	if err != nil {
		return nil, fmt.Errorf("provider refund failed: %w", err)
	}

	var updated *ledger.Record
	err = s.app.RunInTransaction(func(txApp core.App) error {
		txRec, err := ledger.FindByID(txApp, rec.ID)
		if err != nil {
			return err
		}

		txTotalRefunded, txHistory := getRefundHistory(txRec.Metadata)
		if idempotencyKey != "" {
			if prev, ok := txHistory[idempotencyKey]; ok {
				prevAmount := parseAmount(prev["amount"])
				if prevAmount == amount {
					updated = txRec
					return nil
				}
				return ErrIdempotencyConflict
			}
		}

		txRemaining := txRec.Amount - txTotalRefunded
		if amount > txRemaining {
			return ErrInvalidRefundAmount
		}

		newTotal := txTotalRefunded + amount
		targetStatus := "partially_refunded"
		if newTotal >= txRec.Amount {
			targetStatus = "refunded"
		}

		refundKey := idempotencyKey
		if refundKey == "" {
			refundKey = res.RefundID
		}
		txHistory[refundKey] = map[string]any{
			"refund_id":       res.RefundID,
			"amount":          amount,
			"reason":          reason,
			"idempotency_key": idempotencyKey,
		}

		extraMeta := map[string]any{
			"refund_id":       res.RefundID,
			"refunded_amount": newTotal,
			"refund_reason":   reason,
			"refunds":         txHistory,
		}

		updated, err = ledger.UpdateStatus(txApp, txRec.ID, targetStatus, txRec.ProviderChargeID, extraMeta)
		if err != nil {
			return err
		}

		event := outbox.Event{
			ID:         fmt.Sprintf("evt_ref_%s", res.RefundID),
			Type:       "payment.refunded",
			Version:    1,
			OccurredAt: time.Now().UTC(),
			TenantID:   tenantID,
			Data: map[string]any{
				"payment_id":      txRec.ID,
				"order_id":        txRec.OrderID,
				"refund_id":       res.RefundID,
				"refunded_amount": amount,
				"total_refunded":  newTotal,
				"total_amount":    txRec.Amount,
				"status":          targetStatus,
			},
		}
		return s.outboxStore.EnqueueTx(txApp, event)
	})
	if err != nil {
		return nil, fmt.Errorf("refund transaction failed: %w", err)
	}

	return updated, nil
}

func (s *Service) GetPayment(_ context.Context, paymentID string) (*ledger.Record, error) {
	return ledger.FindByID(s.app, paymentID)
}
