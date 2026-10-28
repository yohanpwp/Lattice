package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/authz"
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

func TestConfigRouteDiscoversDynamicCollections(t *testing.T) {
	app := newTestApp(t)

	// Save a new business collection dynamically
	productsCol := core.NewBaseCollection("products")
	productsCol.Fields.Add(&core.TextField{Name: "title", Required: true})
	if err := app.Save(productsCol); err != nil {
		t.Fatalf("failed to save products collection: %v", err)
	}

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

	var received tenant.Config
	if err := json.Unmarshal(response.Body.Bytes(), &received); err != nil {
		t.Fatal(err)
	}

	hasProducts := false
	hasUsers := false
	for _, col := range received.Collections {
		if col == "products" {
			hasProducts = true
		}
		if col == "users" {
			hasUsers = true
		}
		if tenant.PlatformCollections[col] {
			t.Errorf("platform collection %q should not be in config.collections", col)
		}
	}

	if !hasProducts {
		t.Errorf("expected 'products' to be dynamically discovered in config.collections, got: %v", received.Collections)
	}
	if !hasUsers {
		t.Errorf("expected 'users' to be in config.collections, got: %v", received.Collections)
	}
}

func TestFeaturesRouteRequiresAuthAndServesSharedSchemaDocument(t *testing.T) {
	app := pocketbase.New()
	flags := &features.Flags{Features: map[string]features.Feature{
		"orders": {Enabled: true, Options: map[string]any{"mode": "read"}},
	}}
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		if token := req.Header.Get("Authorization"); token != "" {
			rec := core.NewRecord(core.NewAuthCollection("users"))
			if token == "Bearer member_token" {
				rec.Set("role", "member")
			} else {
				rec.Set("role", "owner")
			}
			event.Auth = rec
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

func TestSchemasAPIFlow(t *testing.T) {
	app := newTestApp(t)
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		if token := req.Header.Get("Authorization"); token != "" {
			rec := core.NewRecord(core.NewAuthCollection("users"))
			if token == "Bearer member_token" {
				rec.Set("role", "member")
			} else {
				rec.Set("role", "owner")
			}
			event.Auth = rec
		}
		return event, func() {}
	})

	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_dev", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_dev_000000",
		SchemaVersion: "opaque_schema_id", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}
	Register(&core.ServeEvent{App: app, Router: r}, cfg, features.Empty())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Unauthenticated requests must fail with 401
	unauthReq := httptest.NewRequest(http.MethodGet, "/v1/schemas", nil)
	unauthRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /v1/schemas status = %d, want 401", unauthRec.Code)
	}

	// 2. Create schema without auth must fail with 401
	body := []byte(`{
		"schema_id": "customers",
		"name": "ข้อมูลลูกค้า",
		"description": "ทะเบียนลูกค้ารายย่อย",
		"icon": "👥",
		"fields": [
			{"name": "customer_name", "label": "ชื่อลูกค้า", "type": "text", "required": true},
			{"name": "phone", "label": "เบอร์โทร", "type": "text", "required": false}
		]
	}`)
	unauthPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", bytes.NewReader(body))
	unauthPostRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthPostRec, unauthPost)
	if unauthPostRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST /v1/schemas status = %d, want 401", unauthPostRec.Code)
	}

	// 2b. Member attempt to create schema must fail with 403 Forbidden
	memberPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", bytes.NewReader(body))
	memberPost.Header.Set("Authorization", "Bearer member_token")
	memberPost.Header.Set("Content-Type", "application/json")
	memberPostRec := httptest.NewRecorder()
	mux.ServeHTTP(memberPostRec, memberPost)
	if memberPostRec.Code != http.StatusForbidden {
		t.Fatalf("member POST /v1/schemas status = %d, want 403", memberPostRec.Code)
	}

	// 3. Create schema with auth (owner) must succeed
	authPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", bytes.NewReader(body))
	authPost.Header.Set("Authorization", "Bearer valid_token")
	authPost.Header.Set("Content-Type", "application/json")
	authPostRec := httptest.NewRecorder()
	mux.ServeHTTP(authPostRec, authPost)
	if authPostRec.Code != http.StatusOK {
		t.Fatalf("create schema status = %d (body: %s), want 200", authPostRec.Code, authPostRec.Body.String())
	}

	var createdDoc any
	if err := json.Unmarshal(authPostRec.Body.Bytes(), &createdDoc); err != nil {
		t.Fatal(err)
	}
	if err := tenant.ValidateContractDocument("SchemaDefinition", createdDoc); err != nil {
		t.Fatalf("created schema violates SchemaDefinition contract: %v", err)
	}

	// 4. Verify PocketBase collection and SQLite table were created
	col, err := app.FindCollectionByNameOrId("customers")
	if err != nil || col == nil {
		t.Fatalf("expected PocketBase collection 'customers' to exist: %v", err)
	}

	// 5. GET /v1/schemas lists the new schema
	listReq := httptest.NewRequest(http.MethodGet, "/v1/schemas", nil)
	listReq.Header.Set("Authorization", "Bearer valid_token")
	listRec := httptest.NewRecorder()
	mux.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK {
		t.Fatalf("list schemas status = %d, want 200", listRec.Code)
	}
	var listData []map[string]any
	if err := json.Unmarshal(listRec.Body.Bytes(), &listData); err != nil {
		t.Fatal(err)
	}
	hasCustomers := false
	for _, item := range listData {
		if item["schema_id"] == "customers" {
			hasCustomers = true
			if item["name"] != "ข้อมูลลูกค้า" || item["icon"] != "👥" {
				t.Errorf("unexpected schema metadata in list: %+v", item)
			}
		}
	}
	if !hasCustomers {
		t.Fatalf("expected customers schema in list, got: %+v", listData)
	}

	// 6. GET /v1/schemas/customers returns the schema
	getReq := httptest.NewRequest(http.MethodGet, "/v1/schemas/customers", nil)
	getReq.Header.Set("Authorization", "Bearer valid_token")
	getRec := httptest.NewRecorder()
	mux.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("get schema status = %d, want 200", getRec.Code)
	}

	// 6b. Member attempt to delete schema must fail with 403 Forbidden
	memberDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/customers", nil)
	memberDel.Header.Set("Authorization", "Bearer member_token")
	memberDelRec := httptest.NewRecorder()
	mux.ServeHTTP(memberDelRec, memberDel)
	if memberDelRec.Code != http.StatusForbidden {
		t.Fatalf("member DELETE /v1/schemas/customers status = %d, want 403", memberDelRec.Code)
	}

	// 7. DELETE /v1/schemas/customers drops collection and metadata (owner)
	delReq := httptest.NewRequest(http.MethodDelete, "/v1/schemas/customers", nil)
	delReq.Header.Set("Authorization", "Bearer valid_token")
	delRec := httptest.NewRecorder()
	mux.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete schema status = %d, want 200", delRec.Code)
	}

	// 8. GET /v1/schemas/customers after delete returns 404
	getAfterDel := httptest.NewRequest(http.MethodGet, "/v1/schemas/customers", nil)
	getAfterDel.Header.Set("Authorization", "Bearer valid_token")
	getAfterDelRec := httptest.NewRecorder()
	mux.ServeHTTP(getAfterDelRec, getAfterDel)
	if getAfterDelRec.Code != http.StatusNotFound {
		t.Fatalf("get schema after delete status = %d, want 404", getAfterDelRec.Code)
	}
}

func TestWorkspaceAPIRoutes(t *testing.T) {
	app := newTestApp(t)
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		token := req.Header.Get("Authorization")
		if token == "Bearer member_token" {
			rec := core.NewRecord(core.NewAuthCollection("users"))
			rec.Set("role", "member")
			event.Auth = rec
		} else if token == "Bearer admin_token" {
			rec := core.NewRecord(core.NewAuthCollection("users"))
			rec.Set("role", "admin")
			event.Auth = rec
		} else if token == "Bearer owner_token" {
			rec := core.NewRecord(core.NewAuthCollection("users"))
			rec.Set("role", "owner")
			event.Auth = rec
		}
		return event, func() {}
	})

	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_dev", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_dev_000000",
		SchemaVersion: "opaque_schema_id", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}
	Register(&core.ServeEvent{App: app, Router: r}, cfg, features.Empty())
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}

	// 1. Setup route with wrong token returns 401
	badSetupReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/setup", strings.NewReader(`{
		"token": "wrong_token_123",
		"name": "First Owner",
		"email": "owner@example.com",
		"password": "Password123456!"
	}`))
	badSetupReq.Header.Set("Content-Type", "application/json")
	badSetupRec := httptest.NewRecorder()
	mux.ServeHTTP(badSetupRec, badSetupReq)
	if badSetupRec.Code != http.StatusUnauthorized {
		t.Fatalf("setup with wrong token status = %d, want 401", badSetupRec.Code)
	}

	// 2. Setup with valid setup token returns 200
	setupToken, _ := authz.GetOrCreateSetupToken(app)
	validSetupReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/setup", strings.NewReader(fmt.Sprintf(`{
		"token": %q,
		"name": "First Owner",
		"email": "owner@example.com",
		"password": "Password123456!"
	}`, setupToken)))
	validSetupReq.Header.Set("Content-Type", "application/json")
	validSetupRec := httptest.NewRecorder()
	mux.ServeHTTP(validSetupRec, validSetupReq)
	if validSetupRec.Code != http.StatusOK {
		t.Fatalf("setup with valid token status = %d (body: %s), want 200", validSetupRec.Code, validSetupRec.Body.String())
	}

	// 3. Repeated setup returns 409 Conflict
	repeatSetupReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/setup", strings.NewReader(fmt.Sprintf(`{
		"token": %q,
		"name": "Second Owner",
		"email": "owner2@example.com",
		"password": "Password123456!"
	}`, setupToken)))
	repeatSetupReq.Header.Set("Content-Type", "application/json")
	repeatSetupRec := httptest.NewRecorder()
	mux.ServeHTTP(repeatSetupRec, repeatSetupReq)
	if repeatSetupRec.Code != http.StatusConflict {
		t.Fatalf("repeat setup status = %d, want 409", repeatSetupRec.Code)
	}

	// 4. Member cannot list workspace users (403)
	memberListUsers := httptest.NewRequest(http.MethodGet, "/v1/workspace/users", nil)
	memberListUsers.Header.Set("Authorization", "Bearer member_token")
	memberListUsersRec := httptest.NewRecorder()
	mux.ServeHTTP(memberListUsersRec, memberListUsers)
	if memberListUsersRec.Code != http.StatusForbidden {
		t.Fatalf("member GET /v1/workspace/users status = %d, want 403", memberListUsersRec.Code)
	}

	// 5. Owner can list workspace users (200)
	ownerListUsers := httptest.NewRequest(http.MethodGet, "/v1/workspace/users", nil)
	ownerListUsers.Header.Set("Authorization", "Bearer owner_token")
	ownerListUsersRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerListUsersRec, ownerListUsers)
	if ownerListUsersRec.Code != http.StatusOK {
		t.Fatalf("owner GET /v1/workspace/users status = %d, want 200", ownerListUsersRec.Code)
	}

	// 6. Member cannot invite (403)
	memberInvite := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations", strings.NewReader(`{
		"email": "newbie@example.com",
		"role": "member"
	}`))
	memberInvite.Header.Set("Authorization", "Bearer member_token")
	memberInvite.Header.Set("Content-Type", "application/json")
	memberInviteRec := httptest.NewRecorder()
	mux.ServeHTTP(memberInviteRec, memberInvite)
	if memberInviteRec.Code != http.StatusForbidden {
		t.Fatalf("member POST /v1/workspace/invitations status = %d, want 403", memberInviteRec.Code)
	}

	// 7. Owner creates invitation (200)
	ownerInvite := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations", strings.NewReader(`{
		"email": "newbie@example.com",
		"role": "member",
		"permissions": {"jobs": {"read": true, "create": true}}
	}`))
	ownerInvite.Header.Set("Authorization", "Bearer owner_token")
	ownerInvite.Header.Set("Content-Type", "application/json")
	ownerInviteRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerInviteRec, ownerInvite)
	if ownerInviteRec.Code != http.StatusOK {
		t.Fatalf("owner POST /v1/workspace/invitations status = %d (body: %s), want 200", ownerInviteRec.Code, ownerInviteRec.Body.String())
	}

	var invData map[string]any
	_ = json.Unmarshal(ownerInviteRec.Body.Bytes(), &invData)
	invToken, _ := invData["token"].(string)

	// 8. Accept invitation (public with token)
	acceptReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations/accept", strings.NewReader(fmt.Sprintf(`{
		"token": %q,
		"name": "Newbie Member",
		"password": "Password123456!"
	}`, invToken)))
	acceptReq.Header.Set("Content-Type", "application/json")
	acceptRec := httptest.NewRecorder()
	mux.ServeHTTP(acceptRec, acceptReq)
	if acceptRec.Code != http.StatusOK {
		t.Fatalf("accept invitation status = %d (body: %s), want 200", acceptRec.Code, acceptRec.Body.String())
	}

	// 9. GET /v1/workspace/permissions returns role and permissions
	permReq := httptest.NewRequest(http.MethodGet, "/v1/workspace/permissions", nil)
	permReq.Header.Set("Authorization", "Bearer member_token")
	permRec := httptest.NewRecorder()
	mux.ServeHTTP(permRec, permReq)
	if permRec.Code != http.StatusOK {
		t.Fatalf("GET /v1/workspace/permissions status = %d, want 200", permRec.Code)
	}

	// 10. GET /v1/workspace/invitations
	// Member gets 403
	memberGetInvs := httptest.NewRequest(http.MethodGet, "/v1/workspace/invitations", nil)
	memberGetInvs.Header.Set("Authorization", "Bearer member_token")
	memberGetInvsRec := httptest.NewRecorder()
	mux.ServeHTTP(memberGetInvsRec, memberGetInvs)
	if memberGetInvsRec.Code != http.StatusForbidden {
		t.Fatalf("member GET /v1/workspace/invitations status = %d, want 403", memberGetInvsRec.Code)
	}

	// Owner gets 200 with list
	ownerGetInvs := httptest.NewRequest(http.MethodGet, "/v1/workspace/invitations", nil)
	ownerGetInvs.Header.Set("Authorization", "Bearer owner_token")
	ownerGetInvsRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerGetInvsRec, ownerGetInvs)
	if ownerGetInvsRec.Code != http.StatusOK {
		t.Fatalf("owner GET /v1/workspace/invitations status = %d, want 200", ownerGetInvsRec.Code)
	}

	var pendingList []map[string]any
	_ = json.Unmarshal(ownerGetInvsRec.Body.Bytes(), &pendingList)
	for _, item := range pendingList {
		if _, hasToken := item["token"]; hasToken {
			t.Fatal("security violation: GET /v1/workspace/invitations disclosed token in shared listing")
		}
	}

	// Owner invites an admin
	ownerInviteAdmin := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations", strings.NewReader(`{
		"email": "future_admin@example.com",
		"role": "admin"
	}`))
	ownerInviteAdmin.Header.Set("Authorization", "Bearer owner_token")
	ownerInviteAdmin.Header.Set("Content-Type", "application/json")
	ownerInviteAdminRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerInviteAdminRec, ownerInviteAdmin)
	if ownerInviteAdminRec.Code != http.StatusOK {
		t.Fatalf("owner invite admin status = %d, want 200", ownerInviteAdminRec.Code)
	}
	var adminInvData map[string]any
	_ = json.Unmarshal(ownerInviteAdminRec.Body.Bytes(), &adminInvData)
	adminInvId := adminInvData["id"].(string)

	// Admin listing invitations must NOT see admin invitation (only member invitations)
	adminGetInvs := httptest.NewRequest(http.MethodGet, "/v1/workspace/invitations", nil)
	adminGetInvs.Header.Set("Authorization", "Bearer admin_token")
	adminGetInvsRec := httptest.NewRecorder()
	mux.ServeHTTP(adminGetInvsRec, adminGetInvs)
	if adminGetInvsRec.Code != http.StatusOK {
		t.Fatalf("admin GET /v1/workspace/invitations status = %d, want 200", adminGetInvsRec.Code)
	}
	var adminSeenInvs []map[string]any
	_ = json.Unmarshal(adminGetInvsRec.Body.Bytes(), &adminSeenInvs)
	for _, inv := range adminSeenInvs {
		if inv["role"] == "admin" {
			t.Fatal("security violation: admin can see pending admin invitations created by owner!")
		}
	}

	// Admin attempting to revoke admin invitation must get 403 Forbidden
	adminRevokeAdminReq := httptest.NewRequest(http.MethodDelete, "/v1/workspace/invitations/"+adminInvId, nil)
	adminRevokeAdminReq.Header.Set("Authorization", "Bearer admin_token")
	adminRevokeAdminRec := httptest.NewRecorder()
	mux.ServeHTTP(adminRevokeAdminRec, adminRevokeAdminReq)
	if adminRevokeAdminRec.Code != http.StatusForbidden {
		t.Fatalf("admin revoke admin invitation status = %d, want 403", adminRevokeAdminRec.Code)
	}

	// Admin attempting to reissue admin invitation must get 403 Forbidden
	adminReissueAdminReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations/"+adminInvId+"/reissue", nil)
	adminReissueAdminReq.Header.Set("Authorization", "Bearer admin_token")
	adminReissueAdminRec := httptest.NewRecorder()
	mux.ServeHTTP(adminReissueAdminRec, adminReissueAdminReq)
	if adminReissueAdminRec.Code != http.StatusForbidden {
		t.Fatalf("admin reissue admin invitation status = %d, want 403", adminReissueAdminRec.Code)
	}

	// Owner CAN reissue admin invitation
	ownerReissueAdminReq := httptest.NewRequest(http.MethodPost, "/v1/workspace/invitations/"+adminInvId+"/reissue", nil)
	ownerReissueAdminReq.Header.Set("Authorization", "Bearer owner_token")
	ownerReissueAdminRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerReissueAdminRec, ownerReissueAdminReq)
	if ownerReissueAdminRec.Code != http.StatusOK {
		t.Fatalf("owner reissue admin invitation status = %d, want 200", ownerReissueAdminRec.Code)
	}
	var reissuedData map[string]any
	_ = json.Unmarshal(ownerReissueAdminRec.Body.Bytes(), &reissuedData)
	if reissuedData["token"] == "" {
		t.Fatal("expected non-empty token on reissue")
	}

	// 11. Admin cannot promote member to admin (403 Forbidden)
	usersCol, _ := app.FindCollectionByNameOrId("users")
	targetMember := core.NewRecord(usersCol)
	targetMember.Set("email", "promoteme@example.com")
	targetMember.Set("role", "member")
	targetMember.SetPassword("Password123!")
	_ = app.Save(targetMember)

	adminPromoteAdminReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetMember.Id, strings.NewReader(`{
		"role": "admin"
	}`))
	adminPromoteAdminReq.Header.Set("Authorization", "Bearer admin_token")
	adminPromoteAdminReq.Header.Set("Content-Type", "application/json")
	adminPromoteAdminRec := httptest.NewRecorder()
	mux.ServeHTTP(adminPromoteAdminRec, adminPromoteAdminReq)
	if adminPromoteAdminRec.Code != http.StatusForbidden {
		t.Fatalf("admin promoting to admin status = %d, want 403", adminPromoteAdminRec.Code)
	}

	// Admin cannot promote member to owner (403 Forbidden)
	adminPromoteOwnerReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetMember.Id, strings.NewReader(`{
		"role": "owner"
	}`))
	adminPromoteOwnerReq.Header.Set("Authorization", "Bearer admin_token")
	adminPromoteOwnerReq.Header.Set("Content-Type", "application/json")
	adminPromoteOwnerRec := httptest.NewRecorder()
	mux.ServeHTTP(adminPromoteOwnerRec, adminPromoteOwnerReq)
	if adminPromoteOwnerRec.Code != http.StatusForbidden {
		t.Fatalf("admin promoting to owner status = %d, want 403", adminPromoteOwnerRec.Code)
	}
}
