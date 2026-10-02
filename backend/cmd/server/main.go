package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/api"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func main() {
	app := pocketbase.New()

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Load the tenant config only when serving, so other CLI commands
		// (e.g. `superuser create`, `migrate`) work without it.
		cfgPath := os.Getenv("TENANT_CONFIG")
		if cfgPath == "" {
			cfgPath = "tenant.json"
		}

		cfg, err := tenant.Load(cfgPath)
		if err != nil {
			return err
		}

		api.Register(se, cfg)

		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
