// Package api registers our custom /v1/* routes on top of PocketBase's router.
// PocketBase's own /api/* endpoints are left untouched.
package api

import (
	"net/http"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/tenant"
)

// Register adds the /v1 routes. Call it from the app.OnServe() hook.
func Register(se *core.ServeEvent, cfg *tenant.Config) {
	se.Router.GET("/v1/health", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	// Public, non-secret configuration for clients (web, desktop, mobile).
	se.Router.GET("/v1/config", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "public, max-age=60")
		return e.JSON(http.StatusOK, cfg)
	})
}
