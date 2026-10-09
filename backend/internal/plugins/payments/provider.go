package payments

import (
	"context"
	"net/http"
)

// ChargeRequest defines the input to a payment provider's charge creation.
type ChargeRequest struct {
	OrderID        string         `json:"order_id"`
	UserID         string         `json:"user_id,omitempty"`
	Amount         int64          `json:"amount"`
	Currency       string         `json:"currency"`
	IdempotencyKey string         `json:"idempotency_key"`
	ReturnURL      string         `json:"return_url,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

// ChargeResult is returned by the provider upon initiating a charge.
type ChargeResult struct {
	ProviderChargeID string `json:"provider_charge_id"`
	Status           string `json:"status"` // "pending" or "succeeded"
	PaymentURL       string `json:"payment_url,omitempty"`
}

// WebhookEvent represents an incoming webhook parsed and verified by a provider.
type WebhookEvent struct {
	ProviderChargeID string         `json:"provider_charge_id"`
	OrderID          string         `json:"order_id,omitempty"`
	Status           string         `json:"status"` // "succeeded", "failed", "refunded"
	Amount           int64          `json:"amount"`
	Currency         string         `json:"currency"`
	EventType        string         `json:"event_type"`
	RawData          map[string]any `json:"raw_data,omitempty"`
}

// RefundRequest supports both full and partial refunds with context and idempotency.
type RefundRequest struct {
	ProviderChargeID string         `json:"provider_charge_id"`
	Amount           int64          `json:"amount"` // partial refund amount
	Currency         string         `json:"currency"`
	Reason           string         `json:"reason,omitempty"`
	IdempotencyKey   string         `json:"idempotency_key,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
}

// RefundResult is returned upon issuing a refund.
type RefundResult struct {
	RefundID         string `json:"refund_id"`
	ProviderChargeID string `json:"provider_charge_id"`
	AmountRefunded   int64  `json:"amount_refunded"`
	Status           string `json:"status"` // "succeeded", "pending", "failed"
}

// PaymentProvider is the interface that payment implementations must satisfy.
// As mandated by the spec: includes context, idempotency key, and partial refund.
type PaymentProvider interface {
	Name() string
	CreateCharge(ctx context.Context, req ChargeRequest) (*ChargeResult, error)
	VerifyWebhook(ctx context.Context, rawBody []byte, headers http.Header) (*WebhookEvent, error)
	Refund(ctx context.Context, req RefundRequest) (*RefundResult, error)
}
