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

func TestSchemaAdministrationAuthorization(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		token := req.Header.Get("Authorization")
		if token != "" {
			rec := core.NewRecord(usersCol)
			switch token {
			case "Bearer owner_token":
				rec.Set("role", "owner")
				rec.Set("disabled", false)
			case "Bearer admin_token":
				rec.Set("role", "admin")
				rec.Set("disabled", false)
			case "Bearer member_token":
				rec.Set("role", "member")
				rec.Set("disabled", false)
			case "Bearer disabled_token":
				rec.Set("role", "owner")
				rec.Set("disabled", true)
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

	makeSchemaPayload := func(id, name string) string {
		return fmt.Sprintf(`{
			"schema_id": "%s",
			"name": "%s",
			"fields": [
				{"name": "title", "label": "Title", "type": "text", "required": true}
			]
		}`, id, name)
	}

	// 1. Unauthenticated requests to POST, DELETE, GET schemas
	unauthPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", strings.NewReader(makeSchemaPayload("unauth_schema", "Unauth")))
	unauthPost.Header.Set("Content-Type", "application/json")
	unauthPostRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthPostRec, unauthPost)
	if unauthPostRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth POST /v1/schemas status = %d, want 401", unauthPostRec.Code)
	}

	unauthDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/some_schema", nil)
	unauthDelRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthDelRec, unauthDel)
	if unauthDelRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth DELETE /v1/schemas/some_schema status = %d, want 401", unauthDelRec.Code)
	}

	unauthGet := httptest.NewRequest(http.MethodGet, "/v1/schemas", nil)
	unauthGetRec := httptest.NewRecorder()
	mux.ServeHTTP(unauthGetRec, unauthGet)
	if unauthGetRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth GET /v1/schemas status = %d, want 401", unauthGetRec.Code)
	}

	// 2. Disabled account requests to POST, DELETE, GET schemas
	disPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", strings.NewReader(makeSchemaPayload("dis_schema", "Disabled")))
	disPost.Header.Set("Authorization", "Bearer disabled_token")
	disPost.Header.Set("Content-Type", "application/json")
	disPostRec := httptest.NewRecorder()
	mux.ServeHTTP(disPostRec, disPost)
	if disPostRec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled POST /v1/schemas status = %d, want 401", disPostRec.Code)
	}

	disDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/some_schema", nil)
	disDel.Header.Set("Authorization", "Bearer disabled_token")
	disDelRec := httptest.NewRecorder()
	mux.ServeHTTP(disDelRec, disDel)
	if disDelRec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled DELETE /v1/schemas/some_schema status = %d, want 401", disDelRec.Code)
	}

	disGet := httptest.NewRequest(http.MethodGet, "/v1/schemas", nil)
	disGet.Header.Set("Authorization", "Bearer disabled_token")
	disGetRec := httptest.NewRecorder()
	mux.ServeHTTP(disGetRec, disGet)
	if disGetRec.Code != http.StatusUnauthorized {
		t.Fatalf("disabled GET /v1/schemas status = %d, want 401", disGetRec.Code)
	}

	// 3. Member role cannot create or delete schemas (403 Forbidden), but CAN view/list schemas
	memberPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", strings.NewReader(makeSchemaPayload("member_schema", "Member Schema")))
	memberPost.Header.Set("Authorization", "Bearer member_token")
	memberPost.Header.Set("Content-Type", "application/json")
	memberPostRec := httptest.NewRecorder()
	mux.ServeHTTP(memberPostRec, memberPost)
	if memberPostRec.Code != http.StatusForbidden {
		t.Fatalf("member POST /v1/schemas status = %d, want 403", memberPostRec.Code)
	}

	memberDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/some_schema", nil)
	memberDel.Header.Set("Authorization", "Bearer member_token")
	memberDelRec := httptest.NewRecorder()
	mux.ServeHTTP(memberDelRec, memberDel)
	if memberDelRec.Code != http.StatusForbidden {
		t.Fatalf("member DELETE /v1/schemas/some_schema status = %d, want 403", memberDelRec.Code)
	}

	memberGet := httptest.NewRequest(http.MethodGet, "/v1/schemas", nil)
	memberGet.Header.Set("Authorization", "Bearer member_token")
	memberGetRec := httptest.NewRecorder()
	mux.ServeHTTP(memberGetRec, memberGet)
	if memberGetRec.Code != http.StatusOK {
		t.Fatalf("member GET /v1/schemas status = %d, want 200", memberGetRec.Code)
	}

	// 4. Admin role CAN create, view, and delete schemas
	adminPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", strings.NewReader(makeSchemaPayload("admin_created_schema", "Admin Schema")))
	adminPost.Header.Set("Authorization", "Bearer admin_token")
	adminPost.Header.Set("Content-Type", "application/json")
	adminPostRec := httptest.NewRecorder()
	mux.ServeHTTP(adminPostRec, adminPost)
	if adminPostRec.Code != http.StatusOK {
		t.Fatalf("admin POST /v1/schemas status = %d, want 200, body: %s", adminPostRec.Code, adminPostRec.Body.String())
	}

	// Verify schema exists
	adminGet := httptest.NewRequest(http.MethodGet, "/v1/schemas/admin_created_schema", nil)
	adminGet.Header.Set("Authorization", "Bearer admin_token")
	adminGetRec := httptest.NewRecorder()
	mux.ServeHTTP(adminGetRec, adminGet)
	if adminGetRec.Code != http.StatusOK {
		t.Fatalf("admin GET /v1/schemas/admin_created_schema status = %d, want 200", adminGetRec.Code)
	}

	// Member can read the admin-created schema
	memberGetSpecific := httptest.NewRequest(http.MethodGet, "/v1/schemas/admin_created_schema", nil)
	memberGetSpecific.Header.Set("Authorization", "Bearer member_token")
	memberGetSpecificRec := httptest.NewRecorder()
	mux.ServeHTTP(memberGetSpecificRec, memberGetSpecific)
	if memberGetSpecificRec.Code != http.StatusOK {
		t.Fatalf("member GET /v1/schemas/admin_created_schema status = %d, want 200", memberGetSpecificRec.Code)
	}

	// Admin deletes the schema
	adminDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/admin_created_schema", nil)
	adminDel.Header.Set("Authorization", "Bearer admin_token")
	adminDelRec := httptest.NewRecorder()
	mux.ServeHTTP(adminDelRec, adminDel)
	if adminDelRec.Code != http.StatusOK {
		t.Fatalf("admin DELETE /v1/schemas/admin_created_schema status = %d, want 200", adminDelRec.Code)
	}

	// 5. Owner role CAN create, view, and delete schemas
	ownerPost := httptest.NewRequest(http.MethodPost, "/v1/schemas", strings.NewReader(makeSchemaPayload("owner_created_schema", "Owner Schema")))
	ownerPost.Header.Set("Authorization", "Bearer owner_token")
	ownerPost.Header.Set("Content-Type", "application/json")
	ownerPostRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerPostRec, ownerPost)
	if ownerPostRec.Code != http.StatusOK {
		t.Fatalf("owner POST /v1/schemas status = %d, want 200, body: %s", ownerPostRec.Code, ownerPostRec.Body.String())
	}

	ownerDel := httptest.NewRequest(http.MethodDelete, "/v1/schemas/owner_created_schema", nil)
	ownerDel.Header.Set("Authorization", "Bearer owner_token")
	ownerDelRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerDelRec, ownerDel)
	if ownerDelRec.Code != http.StatusOK {
		t.Fatalf("owner DELETE /v1/schemas/owner_created_schema status = %d, want 200", ownerDelRec.Code)
	}
}

func TestMemberUpdate_ConcurrentDemotionOfOwners(t *testing.T) {
	app := newTestApp(t)
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	owner1 := core.NewRecord(usersCol)
	owner1.Set("email", "owner1@example.com")
	owner1.Set("role", authz.RoleOwner)
	owner1.Set("disabled", false)
	owner1.SetPassword("Password123!")
	if err := app.Save(owner1); err != nil {
		t.Fatal(err)
	}

	owner2 := core.NewRecord(usersCol)
	owner2.Set("email", "owner2@example.com")
	owner2.Set("role", authz.RoleOwner)
	owner2.Set("disabled", false)
	owner2.SetPassword("Password123!")
	if err := app.Save(owner2); err != nil {
		t.Fatal(err)
	}

	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		token := req.Header.Get("Authorization")
		if token == "Bearer owner_token" {
			rec := core.NewRecord(usersCol)
			rec.Set("role", authz.RoleOwner)
			rec.Set("disabled", false)
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

	startBarrier := make(chan struct{})
	type result struct {
		id   string
		code int
		body string
	}
	resChan := make(chan result, 2)

	go func() {
		<-startBarrier
		req := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+owner1.Id, strings.NewReader(`{"role":"member"}`))
		req.Header.Set("Authorization", "Bearer owner_token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		resChan <- result{id: owner1.Id, code: rec.Code, body: rec.Body.String()}
	}()

	go func() {
		<-startBarrier
		req := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+owner2.Id, strings.NewReader(`{"role":"member"}`))
		req.Header.Set("Authorization", "Bearer owner_token")
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		resChan <- result{id: owner2.Id, code: rec.Code, body: rec.Body.String()}
	}()

	close(startBarrier)
	r1 := <-resChan
	r2 := <-resChan

	// Exactly one request must succeed (200) and the other must be rejected (403)
	successCount := 0
	forbiddenCount := 0
	for _, res := range []result{r1, r2} {
		if res.code == http.StatusOK {
			successCount++
		} else if res.code == http.StatusForbidden {
			forbiddenCount++
			if !strings.Contains(res.body, "Cannot demote or disable the last active workspace owner") {
				t.Fatalf("unexpected forbidden message: %s", res.body)
			}
		} else {
			t.Fatalf("unexpected status code: %d, body: %s", res.code, res.body)
		}
	}

	if successCount != 1 || forbiddenCount != 1 {
		t.Fatalf("expected 1 success (200) and 1 forbidden (403), got %d success and %d forbidden", successCount, forbiddenCount)
	}

	// Verify database state: exactly 1 active owner remains
	activeOwners, err := app.FindRecordsByFilter("users", "role = {:role} && disabled != true", "", 10, 0, map[string]any{
		"role": authz.RoleOwner,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(activeOwners) != 1 {
		t.Fatalf("expected exactly 1 active owner remaining, found %d", len(activeOwners))
	}
}

func TestMemberUpdate_TargetPromotedConcurrently(t *testing.T) {
	app := newTestApp(t)
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	targetMember := core.NewRecord(usersCol)
	targetMember.Set("email", "target@example.com")
	targetMember.Set("role", authz.RoleMember)
	targetMember.Set("disabled", false)
	targetMember.SetPassword("Password123!")
	if err := app.Save(targetMember); err != nil {
		t.Fatal(err)
	}

	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		token := req.Header.Get("Authorization")
		if token == "Bearer admin_token" {
			rec := core.NewRecord(usersCol)
			rec.Set("role", authz.RoleAdmin)
			rec.Set("disabled", false)
			event.Auth = rec
		} else if token == "Bearer owner_token" {
			rec := core.NewRecord(usersCol)
			rec.Set("role", authz.RoleOwner)
			rec.Set("disabled", false)
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

	// 1. Owner promotes target to admin
	ownerPromoteReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetMember.Id, strings.NewReader(`{"role":"admin"}`))
	ownerPromoteReq.Header.Set("Authorization", "Bearer owner_token")
	ownerPromoteReq.Header.Set("Content-Type", "application/json")
	ownerPromoteRec := httptest.NewRecorder()
	mux.ServeHTTP(ownerPromoteRec, ownerPromoteReq)
	if ownerPromoteRec.Code != http.StatusOK {
		t.Fatalf("owner promotion status = %d, want 200", ownerPromoteRec.Code)
	}

	// 2. Admin attempts to modify the target member (e.g. disable them)
	// Because target has been promoted to admin, freshTarget reload in the transaction must catch this and return 403 Forbidden
	adminDisableReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetMember.Id, strings.NewReader(`{"disabled":true}`))
	adminDisableReq.Header.Set("Authorization", "Bearer admin_token")
	adminDisableReq.Header.Set("Content-Type", "application/json")
	adminDisableRec := httptest.NewRecorder()
	mux.ServeHTTP(adminDisableRec, adminDisableReq)
	if adminDisableRec.Code != http.StatusForbidden {
		t.Fatalf("admin modifying promoted admin status = %d, want 403. body: %s", adminDisableRec.Code, adminDisableRec.Body.String())
	}
	if !strings.Contains(adminDisableRec.Body.String(), "Admins cannot modify owner or admin accounts") {
		t.Fatalf("unexpected error message: %s", adminDisableRec.Body.String())
	}

	// Verify target is still active and was NOT disabled
	freshTarget, err := app.FindRecordById("users", targetMember.Id)
	if err != nil {
		t.Fatal(err)
	}
	if freshTarget.GetBool("disabled") {
		t.Fatal("target member was unexpectedly disabled by admin")
	}
	if freshTarget.GetString("role") != authz.RoleAdmin {
		t.Fatalf("target role = %s, want admin", freshTarget.GetString("role"))
	}
}

func TestMemberUpdate_ActingUserDemotedOrDisabledBeforeTransaction(t *testing.T) {
	app := newTestApp(t)
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	// Acting owner account in DB
	actingOwner := core.NewRecord(usersCol)
	actingOwner.Set("email", "acting_owner@example.com")
	actingOwner.Set("role", authz.RoleOwner)
	actingOwner.Set("disabled", false)
	actingOwner.SetPassword("Password123!")
	if err := app.Save(actingOwner); err != nil {
		t.Fatal(err)
	}

	// Another active owner so actingOwner is not the only owner
	otherOwner := core.NewRecord(usersCol)
	otherOwner.Set("email", "other_owner@example.com")
	otherOwner.Set("role", authz.RoleOwner)
	otherOwner.Set("disabled", false)
	otherOwner.SetPassword("Password123!")
	if err := app.Save(otherOwner); err != nil {
		t.Fatal(err)
	}

	// Target user
	targetUser := core.NewRecord(usersCol)
	targetUser.Set("email", "target_user@example.com")
	targetUser.Set("role", authz.RoleMember)
	targetUser.Set("disabled", false)
	targetUser.SetPassword("Password123!")
	if err := app.Save(targetUser); err != nil {
		t.Fatal(err)
	}

	// Stale auth copy: role is owner, disabled is false
	staleOwnerAuth := core.NewRecord(usersCol)
	staleOwnerAuth.Id = actingOwner.Id
	staleOwnerAuth.Set("role", authz.RoleOwner)
	staleOwnerAuth.Set("disabled", false)

	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		token := req.Header.Get("Authorization")
		if token == "Bearer stale_owner_token" {
			// Simulates e.Auth populated outside the transaction before the actor was demoted
			event.Auth = staleOwnerAuth
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

	// Case 1: Acting owner was demoted to member before the transaction runs
	actingOwner.Set("role", authz.RoleMember)
	if err := app.Save(actingOwner); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetUser.Id, strings.NewReader(`{"disabled":true}`))
	req.Header.Set("Authorization", "Bearer stale_owner_token")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for demoted acting user, got %d (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Only workspace owners and admins can update team members") {
		t.Fatalf("unexpected error message: %s", rec.Body.String())
	}

	// Case 2: Acting owner was disabled before the transaction runs
	actingOwner.Set("role", authz.RoleOwner)
	actingOwner.Set("disabled", true)
	if err := app.Save(actingOwner); err != nil {
		t.Fatal(err)
	}

	req2 := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetUser.Id, strings.NewReader(`{"disabled":true}`))
	req2.Header.Set("Authorization", "Bearer stale_owner_token")
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	mux.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for disabled acting user, got %d (body: %s)", rec2.Code, rec2.Body.String())
	}

	// Case 3: Acting owner was demoted to admin, and tries to appoint an owner
	actingOwner.Set("role", authz.RoleAdmin)
	actingOwner.Set("disabled", false)
	if err := app.Save(actingOwner); err != nil {
		t.Fatal(err)
	}

	appointReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+targetUser.Id, strings.NewReader(`{"role":"owner"}`))
	appointReq.Header.Set("Authorization", "Bearer stale_owner_token")
	appointReq.Header.Set("Content-Type", "application/json")
	appointRec := httptest.NewRecorder()
	mux.ServeHTTP(appointRec, appointReq)

	if appointRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for demoted admin appointing owner, got %d (body: %s)", appointRec.Code, appointRec.Body.String())
	}
	if !strings.Contains(appointRec.Body.String(), "Only workspace owners can appoint admins or owners") {
		t.Fatalf("unexpected error message: %s", appointRec.Body.String())
	}

	// Verify target was never modified
	freshTarget, err := app.FindRecordById("users", targetUser.Id)
	if err != nil {
		t.Fatal(err)
	}
	if freshTarget.GetString("role") != authz.RoleMember || freshTarget.GetBool("disabled") {
		t.Fatal("target user was modified despite unauthorized acting user")
	}
}

func TestMemberUpdate_LastOwnerCheckQueryErrorFailsClosed(t *testing.T) {
	app := newTestApp(t)
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	soleOwner := core.NewRecord(usersCol)
	soleOwner.Set("email", "sole_owner@example.com")
	soleOwner.Set("role", authz.RoleOwner)
	soleOwner.Set("disabled", false)
	soleOwner.SetPassword("Password123!")
	if err := app.Save(soleOwner); err != nil {
		t.Fatal(err)
	}

	// 1. Calling IsLastOwner with nil app fails closed with an error
	isLast, err := authz.IsLastOwner(nil, soleOwner.Id)
	if err == nil {
		t.Fatal("expected error from IsLastOwner on nil app, got nil")
	}
	if isLast {
		t.Fatal("expected isLast to be false when error occurs")
	}

	// 2. Calling IsLastOwner with empty owners table fails closed with an error
	emptyApp := newTestApp(t)
	isLast, err = authz.IsLastOwner(emptyApp, "any_id")
	if err == nil {
		t.Fatal("expected error from IsLastOwner on empty app, got nil")
	}
	if isLast {
		t.Fatal("expected isLast to be false when error occurs")
	}

	// 3. Test through HTTP API: demoting sole owner is rejected with 403 Forbidden
	r := router.NewRouter[*core.RequestEvent](func(w http.ResponseWriter, req *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		event := &core.RequestEvent{App: app, Event: router.Event{Response: w, Request: req}}
		if req.Header.Get("Authorization") == "Bearer sole_owner" {
			event.Auth = soleOwner
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

	demoteReq := httptest.NewRequest(http.MethodPatch, "/v1/workspace/users/"+soleOwner.Id, strings.NewReader(`{"role":"member"}`))
	demoteReq.Header.Set("Authorization", "Bearer sole_owner")
	demoteReq.Header.Set("Content-Type", "application/json")
	demoteRec := httptest.NewRecorder()
	mux.ServeHTTP(demoteRec, demoteReq)

	if demoteRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden when demoting sole owner, got %d: %s", demoteRec.Code, demoteRec.Body.String())
	}
}

