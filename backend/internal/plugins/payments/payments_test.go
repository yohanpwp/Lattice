package payments

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/registry"
	"github.com/Lattice/backend/internal/platform/secrets"
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

func TestPaymentsServiceLifecycle(t *testing.T) {
	app := newApp(t)
	svc := NewService(app)
	mockProvider := NewMockProvider("webhook_secret_123")
	svc.RegisterProvider(mockProvider)

	ctx := context.Background()
	tenantID := "tenant_test"

	// 1. Create Checkout
	input := CheckoutInput{
		OrderID:        "ord_100",
		UserID:         "usr_100",
		Amount:         2500,
		Currency:       "USD",
		Provider:       "mock",
		IdempotencyKey: "idem_checkout_1",
		ReturnURL:      "https://shop.example.com/done",
	}

	record, err := svc.CreateCheckout(ctx, tenantID, input)
	if err != nil {
		t.Fatalf("create checkout failed: %v", err)
	}
	if record.ID == "" || record.Status != "pending" || record.Amount != 2500 {
		t.Fatalf("unexpected record: %#v", record)
	}

	// Verify Outbox received the event
	due, err := svc.outboxStore.Due(ctx, time.Now().Add(time.Minute), 10)
	if err != nil {
		t.Fatalf("query outbox due: %v", err)
	}
	var foundOutbox bool
	for _, entry := range due {
		if entry.Event.Type == "payment.created" && entry.Event.Data["payment_id"] == record.ID {
			foundOutbox = true
			break
		}
	}
	if !foundOutbox {
		t.Fatal("expected payment.created event in outbox")
	}

	// 2. Replay with exact same idempotency_key returns identical record without duplicate charge
	replay, err := svc.CreateCheckout(ctx, tenantID, input)
	if err != nil {
		t.Fatalf("replay checkout failed: %v", err)
	}
	if replay.ID != record.ID {
		t.Fatalf("expected identical record on replay: got %s, want %s", replay.ID, record.ID)
	}

	// 3. Replay with same idempotency_key but different amount returns conflict
	conflictInput := input
	conflictInput.Amount = 9999
	_, err = svc.CreateCheckout(ctx, tenantID, conflictInput)
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict, got %v", err)
	}

	// 4. Webhook: valid delivery updates ledger and enqueues outbox event
	webhookPayload := []byte(`{
		"provider_charge_id": "` + record.ProviderChargeID + `",
		"order_id": "ord_100",
		"status": "succeeded",
		"amount": 2500,
		"currency": "USD",
		"event_type": "payment.succeeded"
	}`)
	sig := mockProvider.Sign(webhookPayload)
	headers := http.Header{}
	headers.Set(SignatureHeader, sig)

	updated, err := svc.HandleWebhook(ctx, tenantID, "mock", webhookPayload, headers)
	if err != nil {
		t.Fatalf("webhook handle failed: %v", err)
	}
	if updated.Status != "succeeded" {
		t.Fatalf("expected status succeeded, got %s", updated.Status)
	}

	// 5. Webhook: tamper amount or currency rejected
	tamperedPayload := []byte(`{
		"provider_charge_id": "` + record.ProviderChargeID + `",
		"order_id": "ord_100",
		"status": "succeeded",
		"amount": 9999,
		"currency": "USD"
	}`)
	tamperedSig := mockProvider.Sign(tamperedPayload)
	headers.Set(SignatureHeader, tamperedSig)
	_, err = svc.HandleWebhook(ctx, tenantID, "mock", tamperedPayload, headers)
	if !errors.Is(err, ErrAmountCurrencyMismatch) {
		t.Fatalf("expected ErrAmountCurrencyMismatch, got %v", err)
	}

	// 6. Partial refund (1000 of 2500)
	refunded, err := svc.Refund(ctx, tenantID, record.ID, 1000, "customer requested partial refund", "ref_idem_1")
	if err != nil {
		t.Fatalf("partial refund failed: %v", err)
	}
	if refunded.Status != "partially_refunded" {
		t.Fatalf("expected status partially_refunded, got %s", refunded.Status)
	}

	// 7. Remaining refund (1500 of remaining 1500 -> total 2500)
	fullRefunded, err := svc.Refund(ctx, tenantID, record.ID, 1500, "remaining balance refund", "ref_idem_2")
	if err != nil {
		t.Fatalf("full refund failed: %v", err)
	}
	if fullRefunded.Status != "refunded" {
		t.Fatalf("expected status refunded, got %s", fullRefunded.Status)
	}
}

func TestCheckoutReplayOwnershipAndProviderCheck(t *testing.T) {
	app := newApp(t)
	svc := NewService(app)
	svc.RegisterProvider(NewMockProvider("secret"))

	ctx := context.Background()
	tenantID := "tenant_test"

	input := CheckoutInput{
		OrderID:        "ord_user1",
		UserID:         "user_1",
		Amount:         5000,
		Currency:       "USD",
		Provider:       "mock",
		IdempotencyKey: "shared_idem_key",
	}

	rec, err := svc.CreateCheckout(ctx, tenantID, input)
	if err != nil {
		t.Fatalf("initial checkout failed: %v", err)
	}

	// Replay by same user succeeds
	replayed, err := svc.CreateCheckout(ctx, tenantID, input)
	if err != nil {
		t.Fatalf("same user replay failed: %v", err)
	}
	if replayed.ID != rec.ID {
		t.Fatalf("expected same record on replay")
	}

	// Replay attempt by different user is rejected with conflict
	differentUserInput := input
	differentUserInput.UserID = "user_2"
	_, err = svc.CreateCheckout(ctx, tenantID, differentUserInput)
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict for different user, got %v", err)
	}
}

func TestRefundAccountingAndReplay(t *testing.T) {
	app := newApp(t)
	svc := NewService(app)
	mockProvider := NewMockProvider("secret")
	svc.RegisterProvider(mockProvider)

	ctx := context.Background()
	tenantID := "tenant_test"

	rec, err := svc.CreateCheckout(ctx, tenantID, CheckoutInput{
		OrderID:        "ord_refund_test",
		UserID:         "usr_refund",
		Amount:         2500,
		Currency:       "USD",
		Provider:       "mock",
		IdempotencyKey: "idem_pay_refund",
	})
	if err != nil {
		t.Fatalf("create checkout: %v", err)
	}

	// Webhook transitions to succeeded
	payload := []byte(`{"provider_charge_id":"` + rec.ProviderChargeID + `","amount":2500,"currency":"USD","status":"succeeded"}`)
	headers := http.Header{}
	headers.Set(SignatureHeader, mockProvider.Sign(payload))
	succeededRec, err := svc.HandleWebhook(ctx, tenantID, "mock", payload, headers)
	if err != nil || succeededRec.Status != "succeeded" {
		t.Fatalf("webhook to succeeded failed: %v", err)
	}

	// Partial refund: 1000 units
	r1, err := svc.Refund(ctx, tenantID, rec.ID, 1000, "reason1", "ref_idem_first")
	if err != nil {
		t.Fatalf("refund 1 failed: %v", err)
	}
	if r1.Status != "partially_refunded" {
		t.Fatalf("expected partially_refunded, got %s", r1.Status)
	}

	// Replay refund 1 with exact same parameters -> succeeds without error
	r1Replay, err := svc.Refund(ctx, tenantID, rec.ID, 1000, "reason1", "ref_idem_first")
	if err != nil {
		t.Fatalf("refund replay failed: %v", err)
	}
	if r1Replay.ID != r1.ID {
		t.Fatalf("expected matching record on refund replay")
	}

	// Replay refund 1 with different amount -> conflict
	_, err = svc.Refund(ctx, tenantID, rec.ID, 500, "reason1", "ref_idem_first")
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected ErrIdempotencyConflict on refund key reuse with different amount, got %v", err)
	}

	// Attempt refund exceeding remaining balance (remaining: 1500, attempt: 2000)
	_, err = svc.Refund(ctx, tenantID, rec.ID, 2000, "too much", "ref_idem_overflow")
	if !errors.Is(err, ErrInvalidRefundAmount) {
		t.Fatalf("expected ErrInvalidRefundAmount when exceeding balance, got %v", err)
	}

	// Complete remaining balance refund: 1500 units -> exactly reaches 2500, status must become refunded
	r2, err := svc.Refund(ctx, tenantID, rec.ID, 1500, "reason2", "ref_idem_second")
	if err != nil {
		t.Fatalf("refund 2 failed: %v", err)
	}
	if r2.Status != "refunded" {
		t.Fatalf("expected status refunded after full accumulation, got %s", r2.Status)
	}

	// Further refund attempt must fail since balance is 0 and status is refunded
	_, err = svc.Refund(ctx, tenantID, rec.ID, 100, "excess", "ref_idem_third")
	if err == nil {
		t.Fatal("expected error when refunding fully refunded payment")
	}
}

func TestWebhookStatusTransitions(t *testing.T) {
	app := newApp(t)
	svc := NewService(app)
	mockProvider := NewMockProvider("secret")
	svc.RegisterProvider(mockProvider)

	ctx := context.Background()
	tenantID := "tenant_test"

	rec, err := svc.CreateCheckout(ctx, tenantID, CheckoutInput{
		OrderID:        "ord_wh_trans",
		Amount:         3000,
		Currency:       "USD",
		Provider:       "mock",
		IdempotencyKey: "idem_wh_trans",
	})
	if err != nil {
		t.Fatalf("create checkout: %v", err)
	}

	// 1. Pending -> Succeeded (Valid)
	succeededPayload := []byte(`{"provider_charge_id":"` + rec.ProviderChargeID + `","amount":3000,"currency":"USD","status":"succeeded"}`)
	h1 := http.Header{}
	h1.Set(SignatureHeader, mockProvider.Sign(succeededPayload))
	updated, err := svc.HandleWebhook(ctx, tenantID, "mock", succeededPayload, h1)
	if err != nil || updated.Status != "succeeded" {
		t.Fatalf("pending -> succeeded failed: %v", err)
	}

	// 2. Duplicate Succeeded (Valid idempotent replay)
	dupUpdated, err := svc.HandleWebhook(ctx, tenantID, "mock", succeededPayload, h1)
	if err != nil || dupUpdated.Status != "succeeded" {
		t.Fatalf("duplicate succeeded failed: %v", err)
	}

	// 3. Succeeded -> Failed (Invalid: delayed failed webhook arrives after succeeded)
	failedPayload := []byte(`{"provider_charge_id":"` + rec.ProviderChargeID + `","amount":3000,"currency":"USD","status":"failed"}`)
	h2 := http.Header{}
	h2.Set(SignatureHeader, mockProvider.Sign(failedPayload))
	_, err = svc.HandleWebhook(ctx, tenantID, "mock", failedPayload, h2)
	if !errors.Is(err, ErrInvalidStatusTransition) {
		t.Fatalf("expected ErrInvalidStatusTransition for succeeded -> failed, got %v", err)
	}

	// Ensure ledger record remained succeeded
	current, err := svc.GetPayment(ctx, rec.ID)
	if err != nil || current.Status != "succeeded" {
		t.Fatalf("expected status to remain succeeded, got %s", current.Status)
	}
}

func TestPaymentsPluginStartupOrderingAndSecretPreservation(t *testing.T) {
	ResetService()
	plugin := &Plugin{}

	configuredSecret := "custom_secret_998877"
	secStore := secrets.EnvStore{
		LookupEnv: func(key string) (string, bool) {
			if key == "LATTICE_SECRET_PAYMENT_MOCK_SECRET" {
				return configuredSecret, true
			}
			return "", false
		},
	}

	// Simulate platform.StartWithSecrets activating plugin BEFORE InitService is called
	err := plugin.Start(context.Background(), registry.Host{
		Secrets: secStore,
		Options: map[string]any{"default_provider": "mock"},
		Events:  &fakeBus{},
	})
	if err != nil {
		t.Fatalf("plugin start failed: %v", err)
	}

	// Later, api.Register calls InitService
	app := newApp(t)
	svc := InitService(app)

	p, err := svc.GetProvider("mock")
	if err != nil {
		t.Fatalf("get mock provider: %v", err)
	}
	mockP, ok := p.(*MockProvider)
	if !ok {
		t.Fatalf("expected *MockProvider, got %T", p)
	}

	// Ensure configured secret was retained and applied, NOT the public DefaultWebhookSecret
	rawBody := []byte(`{"event":"test"}`)
	legitSig := mockP.Sign(rawBody)
	expectedSig := NewMockProvider(configuredSecret).Sign(rawBody)
	if legitSig != expectedSig {
		t.Fatalf("expected signature to match configured secret")
	}

	// Default secret signature must be rejected
	defaultSecretSig := NewMockProvider(DefaultWebhookSecret).Sign(rawBody)
	reqHeaders := http.Header{}
	reqHeaders.Set(SignatureHeader, defaultSecretSig)
	_, err = mockP.VerifyWebhook(context.Background(), rawBody, reqHeaders)
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected default secret signature to be rejected as invalid, got %v", err)
	}
}

type fakeBus struct{}

func (f *fakeBus) Emit(_ context.Context, _ string, _ int, _ map[string]any) error { return nil }
func (f *fakeBus) Subscribe(_ string, _ outbox.Handler)                             {}
