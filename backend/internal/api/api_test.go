package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"

	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/tenant"
)

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
