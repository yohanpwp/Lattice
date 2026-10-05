// Package api registers our custom /v1/* routes on top of PocketBase's router.
// PocketBase's own /api/* endpoints are left untouched.
package api

import (
	"net/http"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/tenant"
)

// Register adds the /v1 routes. Call it from the app.OnServe() hook.
func Register(se *core.ServeEvent, cfg *tenant.Config, flags *features.Flags) {
	if flags == nil {
		flags = features.Empty()
	}

	se.Router.GET("/v1/health", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	// Public, non-secret configuration for clients (web, desktop, mobile).
	se.Router.GET("/v1/config", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "public, max-age=60")
		return e.JSON(http.StatusOK, cfg)
	})

	// Per-tenant feature flags and their non-secret options.
	// Requires a signed-in user: options such as the default payment provider
	// are only meaningful after login and need not be public.
	se.Router.GET("/v1/features", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, flags)
	}).Bind(apis.RequireAuth())
}
