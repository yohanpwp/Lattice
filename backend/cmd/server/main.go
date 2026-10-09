package main

import (
	"errors"
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
	"github.com/Lattice/backend/internal/plugins/payments"
)

func main() {
	app := pocketbase.New()
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Load config only when serving, so other CLI commands
		// (e.g. `superuser create`, `migrate`) work without it.
		cfg, err := loadTenantConfig()
		if err != nil {
			return err
		}

		flags, err := loadFeaturesConfig()
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

		if flags.Enabled("payments") {
			payments.InitService(se.App)
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

func loadTenantConfig() (*tenant.Config, error) {
	if path := os.Getenv("TENANT_CONFIG"); path != "" {
		return tenant.Load(path)
	}
	if _, err := os.Stat("tenant.json"); err == nil {
		return tenant.Load("tenant.json")
	}
	if _, err := os.Stat("tenant.example.json"); err == nil {
		log.Println("Notice: tenant.json not found, using tenant.example.json for development")
		return tenant.Load("tenant.example.json")
	}
	return nil, errors.New("tenant configuration not found (expected tenant.json or tenant.example.json)")
}

func loadFeaturesConfig() (*features.Flags, error) {
	if path := os.Getenv("FEATURES_CONFIG"); path != "" {
		return features.Load(path)
	}
	if _, err := os.Stat("features.json"); err == nil {
		return features.Load("features.json")
	}
	if _, err := os.Stat("features.example.json"); err == nil {
		log.Println("Notice: features.json not found, using features.example.json for development")
		return features.Load("features.example.json")
	}
	log.Println("Notice: features config not found, defaulting to empty features")
	return features.Empty(), nil
}
