package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/tenant"
	"github.com/Lattice/backend/internal/plugins/payments"
)

func newTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestConfigRouteServesSharedSchemaDocument(t *testing.T) {
	app := pocketbase.New()
	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_dev", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_dev_000000",
		SchemaVersion: "opaque_schema_id", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		return &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}, func() {}
	})
	Register(&core.ServeEvent{App: app, Router: r}, cfg, features.Empty())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/config", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if response.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatal("config cache header missing")
	}
	var document any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if err := tenant.ValidateContractDocument("AppConfig", document); err != nil {
		t.Fatalf("GET /v1/config returned raw data outside the shared schema: %v", err)
	}
	var received tenant.Config
	if err := json.Unmarshal(response.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}
	if err := received.Validate(); err != nil {
		t.Fatalf("GET /v1/config returned data outside the shared schema: %v", err)
	}
	if received.Version != 1 || received.SchemaVersion != "opaque_schema_id" {
		t.Fatalf("unexpected config document: %#v", received)
	}
}

func TestFeaturesRouteRequiresAuthAndServesSharedSchemaDocument(t *testing.T) {
	app := pocketbase.New()
	flags := &features.Flags{Features: map[string]features.Feature{
		"orders": {Enabled: true, Options: map[string]any{"mode": "read"}},
	}}
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		if req.Header.Get("Authorization") != "" {
			event.Auth = core.NewRecord(core.NewAuthCollection("users"))
		}
		return event, func() {}
	})
	Register(&core.ServeEvent{App: app, Router: r}, nil, flags)
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	unauthorized := httptest.NewRecorder()
	mux.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/features", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /v1/features status = %d, want 401", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/features", nil)
	request.Header.Set("Authorization", "pb-test-token")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("authenticated /v1/features status = %d", response.Code)
	}
	var document any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if err := tenant.ValidateContractDocument("Features", document); err != nil {
		t.Fatalf("GET /v1/features returned raw data outside shared schema: %v", err)
	}
	if err := flags.Validate(); err != nil {
		t.Fatalf("fixture features should validate: %v", err)
	}
	if strings.Contains(response.Body.String(), "pb-test-token") {
		t.Fatal("auth token leaked into features response")
	}
}

func TestPaymentsCheckoutAndWebhookFlow(t *testing.T) {
	app := newTestApp(t)
	flags := &features.Flags{Features: map[string]features.Feature{
		"payments": {Enabled: true},
	}}
	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_dev", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_dev_000000",
		SchemaVersion: "opaque_schema_id", MinClientVersion: "0.1.0",
		Features: []string{"payments"}, Collections: []string{},
	}

	testUser := core.NewRecord(core.NewAuthCollection("users"))
	testUser.Id = "usr_test_1"

	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		if req.Header.Get("Authorization") == "Bearer valid_token" {
			event.Auth = testUser
		}
		return event, func() {}
	})
	Register(&core.ServeEvent{App: app, Router: r}, cfg, flags)
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Unauthenticated checkout -> 401
	checkoutBody := []byte(`{"order_id":"ord_1","amount":2000,"currency":"USD","idempotency_key":"idem_api_1"}`)
	unauthReq := httptest.NewRequest(http.MethodPost, "/v1/payments/checkout", bytes.NewReader(checkoutBody))
	unauthReq.Header.Set("Content-Type", "application/json")
	unauthRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth checkout status = %d, want 401", unauthRec.Code)
	}

	// 2. Authenticated checkout -> 200 with valid Payment contract document
	authReq := httptest.NewRequest(http.MethodPost, "/v1/payments/checkout", bytes.NewReader(checkoutBody))
	authReq.Header.Set("Authorization", "Bearer valid_token")
	authReq.Header.Set("Content-Type", "application/json")
	authRec := httptest.NewRecorder()
	mux.ServeHTTP(authRec, authReq)
	if authRec.Code != http.StatusOK {
		t.Fatalf("auth checkout status = %d (body: %s), want 200", authRec.Code, authRec.Body.String())
	}

	var paymentDoc any
	if err := json.Unmarshal(authRec.Body.Bytes(), &paymentDoc); err != nil {
		t.Fatal(err)
	}
	if err := tenant.ValidateContractDocument("Payment", paymentDoc); err != nil {
		t.Fatalf("checkout response violates Payment contract: %v", err)
	}

	var paymentData map[string]any
	_ = json.Unmarshal(authRec.Body.Bytes(), &paymentData)
	paymentID := paymentData["id"].(string)
	providerChargeID := paymentData["provider_charge_id"].(string)

	// 3. Replay with exact same idempotency_key returns identical record
	replayReq := httptest.NewRequest(http.MethodPost, "/v1/payments/checkout", bytes.NewReader(checkoutBody))
	replayReq.Header.Set("Authorization", "Bearer valid_token")
	replayReq.Header.Set("Content-Type", "application/json")
	replayRec := httptest.NewRecorder()
	mux.ServeHTTP(replayRec, replayReq)
	if replayRec.Code != http.StatusOK {
		t.Fatalf("replay status = %d, want 200", replayRec.Code)
	}
	var replayData map[string]any
	_ = json.Unmarshal(replayRec.Body.Bytes(), &replayData)
	if replayData["id"] != paymentID {
		t.Fatalf("expected replayed id = %s, got %s", paymentID, replayData["id"])
	}

	// 4. GET /v1/payments/{id} by owner returns 200
	getReq := httptest.NewRequest(http.MethodGet, "/v1/payments/"+paymentID, nil)
	getReq.Header.Set("Authorization", "Bearer valid_token")
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get payment status = %d, want 200", getRec.Code)
	}
	var getDoc any
	if err := json.Unmarshal(getRec.Body.Bytes(), &getDoc); err != nil {
		t.Fatal(err)
	}
	if err := tenant.ValidateContractDocument("Payment", getDoc); err != nil {
		t.Fatalf("GET /v1/payments/{id} violates Payment contract: %v", err)
	}

	// 5. Webhook: valid HMAC updates payment status to succeeded
	mockP := payments.NewMockProvider(payments.DefaultWebhookSecret)
	webhookPayload := []byte(`{
		"provider_charge_id": "` + providerChargeID + `",
		"order_id": "ord_1",
		"status": "succeeded",
		"amount": 2000,
		"currency": "USD"
	}`)
	whReq := httptest.NewRequest(http.MethodPost, "/v1/webhooks/payments/mock", bytes.NewReader(webhookPayload))
	whReq.Header.Set("Content-Type", "application/json")
	whReq.Header.Set(payments.SignatureHeader, mockP.Sign(webhookPayload))
	whRec := httptest.NewRecorder()
	mux.ServeHTTP(whRec, whReq)
	if whRec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d (body: %s), want 200", whRec.Code, whRec.Body.String())
	}

	// 6. Verify status updated via GET
	getRec2 := httptest.NewRecorder()
	getReq2 := httptest.NewRequest(http.MethodGet, "/v1/payments/"+paymentID, nil)
	getReq2.Header.Set("Authorization", "Bearer valid_token")
	mux.ServeHTTP(getRec2, getReq2)
	var finalData map[string]any
	_ = json.Unmarshal(getRec2.Body.Bytes(), &finalData)
	if finalData["status"] != "succeeded" {
		t.Fatalf("expected status succeeded, got %s", finalData["status"])
	}

	// 7. Webhook with tampered amount is rejected with 400
	tamperedPayload := []byte(`{
		"provider_charge_id": "` + providerChargeID + `",
		"order_id": "ord_1",
		"status": "succeeded",
		"amount": 9999,
		"currency": "USD"
	}`)
	badWhReq := httptest.NewRequest(http.MethodPost, "/v1/webhooks/payments/mock", bytes.NewReader(tamperedPayload))
	badWhReq.Header.Set("Content-Type", "application/json")
	badWhReq.Header.Set(payments.SignatureHeader, mockP.Sign(tamperedPayload))
	badWhRec := httptest.NewRecorder()
	mux.ServeHTTP(badWhRec, badWhReq)
	if badWhRec.Code != http.StatusBadRequest {
		t.Fatalf("tampered webhook status = %d, want 400", badWhRec.Code)
	}
}
