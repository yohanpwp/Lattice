package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	"github.com/Lattice/backend/internal/api"
	_ "github.com/Lattice/backend/internal/migrations" // registers our schema migrations
	"github.com/Lattice/backend/internal/platform"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/registry"
	"github.com/Lattice/backend/internal/platform/secrets"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func main() {
	app := pocketbase.New()
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})

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
		secretStore, err := secrets.NewConfigured(nil)
		if err != nil {
			return err
		}

		if err := platform.StartWithSecrets(se.App, cfg.TenantID, flags, registry.Default, secretStore); err != nil {
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
