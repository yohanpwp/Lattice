// Package platform wires the features, plugin registry and outbox into a
// PocketBase app.
package platform

import (
	"context"
	"errors"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/outbox/pbstore"
	"github.com/Lattice/backend/internal/platform/registry"
	"github.com/Lattice/backend/internal/platform/secrets"
)

// Start activates the enabled plugins and runs the outbox worker.
// Call it once from the app.OnServe() hook, after the tenant config and the
// feature flags have been loaded. It returns an error (and starts nothing
// long-lived) if plugin activation fails, so a misconfigured tenant never
// serves traffic half-started.
func Start(app core.App, tenantID string, flags *features.Flags, reg *registry.Registry) error {
	return StartWithSecrets(app, tenantID, flags, reg, secrets.EmptyStore{})
}

// StartWithSecrets starts plugins and the outbox worker with a private secret
// provider. Store values are available only through registry.Host.
func StartWithSecrets(app core.App, tenantID string, flags *features.Flags, reg *registry.Registry, secretStore secrets.Store) error {
	if secretStore == nil {
		secretStore = secrets.EmptyStore{}
	}
	store := pbstore.New(app)
	bus := outbox.NewBus(store, tenantID)

	ctx, cancel := context.WithCancel(context.Background())

	report, err := reg.ActivateWithSecrets(ctx, flags, bus, secretStore)
	if err != nil {
		cancel()
		return errors.Join(err, closeSecretStore(secretStore))
	}
	app.Logger().Info("plugins activated", "started", report.Started, "skipped", report.Skipped)

	// One worker per instance: PocketBase uses a single SQLite database per tenant.
	worker := outbox.NewWorker(store, bus.Dispatcher, outbox.DefaultConfig(app.Logger()))
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		worker.Run(ctx)
	}()

	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		cancel()
		<-workerDone
		nextErr := e.Next()
		return errors.Join(nextErr, closeSecretStore(secretStore))
	})

	return nil
}

func closeSecretStore(store secrets.Store) error {
	closer, ok := store.(secrets.Closer)
	if !ok {
		return nil
	}
	return closer.Close()
}
