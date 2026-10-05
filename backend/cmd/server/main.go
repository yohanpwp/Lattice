package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/api"
	_ "github.com/Lattice/backend/internal/migrations" // registers our schema migrations
	"github.com/Lattice/backend/internal/platform"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/registry"
	"github.com/Lattice/backend/internal/platform/tenant"
	// paymentspb "github.com/Lattice/backend/internal/plugins/payments/pb"
)

func main() {
	app := pocketbase.New()

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Load config only when serving, so other CLI commands
		// (e.g. `superuser create`, `migrate`) work without it.
		cfg, err := tenant.Load(envOr("TENANT_CONFIG", "tenant.json"))
		if err != nil {
			return err
		}

		flags, err := features.Load(envOr("FEATURES_CONFIG", "features.json"))
		if err != nil {
			return err
		}

		// The feature flags file is the single source of truth for which
		// features are on; it overrides any list in the tenant config.
		cfg.Features = flags.EnabledNames()

		// Plugins that need PocketBase (routes, collections) are registered here,
		// before platform.Start activates the ones this tenant has enabled.
		/* deps := platform.NewDeps(se, cfg.TenantID, cfg.BackendURL)
		if err := paymentspb.Register(registry.Default, deps); err != nil {
			return err
		} */

		if err := platform.Start(se.App, cfg.TenantID, flags, registry.Default); err != nil {
			return err
		}

		api.Register(se, cfg, flags)

		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
