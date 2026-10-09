package ledger

import (
	"errors"
	"fmt"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

const CollectionName = "payment_ledger"

var (
	ErrNotFound             = errors.New("payment ledger record not found")
	ErrDuplicateIdempotency = errors.New("payment with idempotency key already exists")
	ErrDuplicateChargeID    = errors.New("payment with provider charge id already exists")
)

type Record struct {
	ID               string         `json:"id"`
	OrderID          string         `json:"order_id"`
	UserID           string         `json:"user_id,omitempty"`
	Status           string         `json:"status"`
	Amount           int64          `json:"amount"`
	Currency         string         `json:"currency"`
	Provider         string         `json:"provider"`
	ProviderChargeID string         `json:"provider_charge_id,omitempty"`
	IdempotencyKey   string         `json:"idempotency_key"`
	PaymentURL       string         `json:"payment_url,omitempty"`
	Metadata         map[string]any `json:"metadata,omitempty"`
	Created          string         `json:"created,omitempty"`
	Updated          string         `json:"updated,omitempty"`
}

func FromRecord(r *core.Record) (*Record, error) {
	if r == nil {
		return nil, ErrNotFound
	}
	var metadata map[string]any
	_ = r.UnmarshalJSONField("metadata", &metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}

	return &Record{
		ID:               r.Id,
		OrderID:          r.GetString("order_id"),
		UserID:           r.GetString("user_id"),
		Status:           r.GetString("status"),
		Amount:           r.GetInt64("amount"),
		Currency:         r.GetString("currency"),
		Provider:         r.GetString("provider"),
		ProviderChargeID: r.GetString("provider_charge_id"),
		IdempotencyKey:   r.GetString("idempotency_key"),
		PaymentURL:       r.GetString("payment_url"),
		Metadata:         metadata,
		Created:          r.GetDateTime("created").String(),
		Updated:          r.GetDateTime("updated").String(),
	}, nil
}

// Create persists a new payment record using PocketBase's service layer.
func Create(app core.App, item Record) (*Record, error) {
	collection, err := app.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		return nil, fmt.Errorf("collection %q missing: %w", CollectionName, err)
	}

	record := core.NewRecord(collection)
	record.Set("order_id", item.OrderID)
	record.Set("user_id", item.UserID)
	record.Set("status", item.Status)
	record.Set("amount", item.Amount)
	record.Set("currency", item.Currency)
	record.Set("provider", item.Provider)
	record.Set("provider_charge_id", item.ProviderChargeID)
	record.Set("idempotency_key", item.IdempotencyKey)
	record.Set("payment_url", item.PaymentURL)
	if item.Metadata != nil {
		record.Set("metadata", item.Metadata)
	}

	if err := app.Save(record); err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "idx_payment_ledger_idempotency") || strings.Contains(errStr, "idempotency_key") {
			return nil, ErrDuplicateIdempotency
		}
		if strings.Contains(errStr, "idx_payment_ledger_provider_charge") || strings.Contains(errStr, "provider_charge_id") {
			return nil, ErrDuplicateChargeID
		}
		return nil, fmt.Errorf("save payment ledger record: %w", err)
	}

	return FromRecord(record)
}

// FindByID retrieves a payment record by its unique primary key.
func FindByID(app core.App, id string) (*Record, error) {
	record, err := app.FindRecordById(CollectionName, id)
	if err != nil {
		return nil, ErrNotFound
	}
	return FromRecord(record)
}

// FindByIdempotencyKey retrieves an existing payment record for request replay.
func FindByIdempotencyKey(app core.App, key string) (*Record, error) {
	record, err := app.FindFirstRecordByFilter(
		CollectionName,
		"idempotency_key = {:key}",
		dbx.Params{"key": key},
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return FromRecord(record)
}

// FindByProviderChargeID finds a payment record matching a provider's charge ID.
func FindByProviderChargeID(app core.App, chargeID string) (*Record, error) {
	record, err := app.FindFirstRecordByFilter(
		CollectionName,
		"provider_charge_id = {:charge_id}",
		dbx.Params{"charge_id": chargeID},
	)
	if err != nil {
		return nil, ErrNotFound
	}
	return FromRecord(record)
}

// UpdateStatus atomically updates status, provider_charge_id, and merges metadata.
func UpdateStatus(app core.App, id string, status string, providerChargeID string, extraMetadata map[string]any) (*Record, error) {
	record, err := app.FindRecordById(CollectionName, id)
	if err != nil {
		return nil, ErrNotFound
	}

	record.Set("status", status)
	if providerChargeID != "" {
		record.Set("provider_charge_id", providerChargeID)
	}

	if len(extraMetadata) > 0 {
		var existing map[string]any
		_ = record.UnmarshalJSONField("metadata", &existing)
		if existing == nil {
			existing = map[string]any{}
		}
		for k, v := range extraMetadata {
			existing[k] = v
		}
		record.Set("metadata", existing)
	}

	if err := app.Save(record); err != nil {
		errStr := err.Error()
		if strings.Contains(errStr, "idx_payment_ledger_provider_charge") {
			return nil, ErrDuplicateChargeID
		}
		return nil, fmt.Errorf("update payment status: %w", err)
	}

	return FromRecord(record)
}
