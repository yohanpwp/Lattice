package ledger

import (
	"errors"
	"testing"

	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
)

func newApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestLedgerCRUDAndIndexes(t *testing.T) {
	app := newApp(t)

	// Create record
	item := Record{
		OrderID:          "ord_1",
		UserID:           "usr_1",
		Status:           "pending",
		Amount:           1500,
		Currency:         "USD",
		Provider:         "mock",
		ProviderChargeID: "ch_mock_1",
		IdempotencyKey:   "idem_1",
		PaymentURL:       "https://pay.example.com",
		Metadata:         map[string]any{"source": "web"},
	}

	created, err := Create(app, item)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected assigned record id")
	}
	if created.Amount != 1500 || created.Status != "pending" {
		t.Fatalf("unexpected created record: %#v", created)
	}

	// FindByID
	found, err := FindByID(app, created.ID)
	if err != nil {
		t.Fatalf("find by id failed: %v", err)
	}
	if found.ID != created.ID || found.OrderID != "ord_1" {
		t.Fatalf("mismatched record: %#v", found)
	}

	// FindByIdempotencyKey
	byIdem, err := FindByIdempotencyKey(app, "idem_1")
	if err != nil {
		t.Fatalf("find by idempotency key failed: %v", err)
	}
	if byIdem.ID != created.ID {
		t.Fatalf("mismatched record by idempotency: %#v", byIdem)
	}

	// FindByProviderChargeID
	byCharge, err := FindByProviderChargeID(app, "ch_mock_1")
	if err != nil {
		t.Fatalf("find by provider charge id failed: %v", err)
	}
	if byCharge.ID != created.ID {
		t.Fatalf("mismatched record by charge id: %#v", byCharge)
	}

	// Duplicate idempotency_key rejection
	dupItem := item
	dupItem.OrderID = "ord_2"
	dupItem.ProviderChargeID = "ch_mock_2"
	_, err = Create(app, dupItem)
	if err == nil {
		t.Fatal("expected error on duplicate idempotency key, got nil")
	}

	// Duplicate provider_charge_id rejection
	dupCharge := item
	dupCharge.IdempotencyKey = "idem_2"
	dupCharge.ProviderChargeID = "ch_mock_1"
	_, err = Create(app, dupCharge)
	if err == nil {
		t.Fatal("expected error on duplicate provider charge id, got nil")
	}

	// UpdateStatus
	updated, err := UpdateStatus(app, created.ID, "succeeded", "ch_mock_1_updated", map[string]any{"wh": true})
	if err != nil {
		t.Fatalf("update status failed: %v", err)
	}
	if updated.Status != "succeeded" || updated.ProviderChargeID != "ch_mock_1_updated" {
		t.Fatalf("unexpected updated status: %#v", updated)
	}
	if updated.Metadata["wh"] != true {
		t.Fatalf("expected metadata update, got %#v", updated.Metadata)
	}
}

func TestLedgerNotFound(t *testing.T) {
	app := newApp(t)

	_, err := FindByID(app, "non_existent")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	_, err = FindByIdempotencyKey(app, "non_existent")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	_, err = FindByProviderChargeID(app, "non_existent")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}
