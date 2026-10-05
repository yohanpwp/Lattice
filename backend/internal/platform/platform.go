// Package platform wires the features, plugin registry and outbox into a
// PocketBase app.
package platform

import (
	"context"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/outbox/pbstore"
	"github.com/Lattice/backend/internal/platform/registry"
)

// Start activates the enabled plugins and runs the outbox worker.
// Call it once from the app.OnServe() hook, after the tenant config and the
// feature flags have been loaded. It returns an error (and starts nothing
// long-lived) if plugin activation fails, so a misconfigured tenant never
// serves traffic half-started.
func Start(app core.App, tenantID string, flags *features.Flags, reg *registry.Registry) error {
	store := pbstore.New(app)
	bus := outbox.NewBus(store, tenantID)

	ctx, cancel := context.WithCancel(context.Background())

	report, err := reg.Activate(ctx, flags, bus)
	if err != nil {
		cancel()
		return err
	}
	app.Logger().Info("plugins activated", "started", report.Started, "skipped", report.Skipped)

	// One worker per instance: PocketBase uses a single SQLite database per tenant.
	worker := outbox.NewWorker(store, bus.Dispatcher, outbox.DefaultConfig(app.Logger()))
	go worker.Run(ctx)

	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		cancel()
		return e.Next()
	})

	return nil
}
