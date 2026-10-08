package platform

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/registry"
	"github.com/Lattice/backend/internal/platform/secrets"
)

type startupPlugin struct {
	name  string
	start func(context.Context)
}

func (p startupPlugin) Manifest() registry.Manifest {
	return registry.Manifest{Name: p.name, Version: "1.0.0", InterfaceVersion: 1, License: "MIT"}
}
func (p startupPlugin) Start(ctx context.Context, _ registry.Host) error {
	p.start(ctx)
	return nil
}

type failingPlugin struct {
	startupPlugin
	err error
}

func (p failingPlugin) Start(context.Context, registry.Host) error { return p.err }

type lifecyclePlugin struct {
	pluginCanceled       chan struct{}
	firstHandlerStarted  chan struct{}
	firstHandlerStopped  chan struct{}
	secondHandlerStarted chan struct{}
}

func (p lifecyclePlugin) Manifest() registry.Manifest {
	return registry.Manifest{Name: "lifecycle-plugin", Version: "1.0.0", InterfaceVersion: 1, License: "MIT"}
}

func (p lifecyclePlugin) Start(ctx context.Context, host registry.Host) error {
	go func() { <-ctx.Done(); close(p.pluginCanceled) }()
	var count int
	host.Events.Subscribe("test.lifecycle", func(ctx context.Context, _ outbox.Event) error {
		count++
		if count == 1 {
			close(p.firstHandlerStarted)
			<-ctx.Done()
			close(p.firstHandlerStopped)
			return ctx.Err()
		}
		p.secondHandlerStarted <- struct{}{}
		return nil
	})
	if err := host.Events.Emit(ctx, "test.lifecycle", 1, map[string]any{"item": 1}); err != nil {
		return err
	}
	return host.Events.Emit(ctx, "test.lifecycle", 1, map[string]any{"item": 2})
}

type closeStore struct{ closed chan struct{} }

func (s closeStore) Get(context.Context, string) (string, error) { return "", secrets.ErrNotFound }
func (s closeStore) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	return nil
}

type ignoredBus struct{}

func (ignoredBus) Emit(context.Context, string, int, map[string]any) error { return nil }
func (ignoredBus) Subscribe(string, outbox.Handler)                        {}

func TestStartWithSecretsCancelsPartialPluginsAndClosesStoreOnActivationFailure(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	reg := registry.New("outbox")
	started := make(chan struct{})
	canceled := make(chan struct{})
	if err := reg.Register(startupPlugin{name: "alpha-plugin", start: func(ctx context.Context) {
		close(started)
		go func() { <-ctx.Done(); close(canceled) }()
	}}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("plugin startup failed")
	if err := reg.Register(failingPlugin{startupPlugin: startupPlugin{name: "beta-plugin"}, err: failure}); err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	err = StartWithSecrets(app, "tenant_test", &features.Flags{Features: map[string]features.Feature{
		"alpha-plugin": {Enabled: true}, "beta-plugin": {Enabled: true},
	}}, reg, closeStore{closed: closed})
	if !errors.Is(err, failure) {
		t.Fatalf("StartWithSecrets error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("first plugin did not start")
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("partial plugin was not canceled after startup failure")
	}
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("secret store was not closed after startup failure")
	}
}

func TestTerminateCancelsPluginsStopsWorkerBeforeNextHookAndClosesStore(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)

	reg := registry.New("outbox")
	pluginCanceled := make(chan struct{})
	firstHandlerStarted := make(chan struct{})
	firstHandlerStopped := make(chan struct{})
	secondHandlerStarted := make(chan struct{}, 1)
	if err := reg.Register(lifecyclePlugin{
		pluginCanceled:       pluginCanceled,
		firstHandlerStarted:  firstHandlerStarted,
		firstHandlerStopped:  firstHandlerStopped,
		secondHandlerStarted: secondHandlerStarted,
	}); err != nil {
		t.Fatal(err)
	}
	store := closeStore{closed: make(chan struct{})}
	flags := &features.Flags{Features: map[string]features.Feature{"lifecycle-plugin": {Enabled: true}}}
	if err := StartWithSecrets(app, "tenant_test", flags, reg, store); err != nil {
		t.Fatal(err)
	}

	// Wait until the real PocketBase-backed worker has entered the first
	// handler before terminating, while the second event remains queued.
	select {
	case <-firstHandlerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("outbox worker did not start the first event")
	}

	nextHookCalled := make(chan struct{})
	hookID := app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		select {
		case <-pluginCanceled:
		case <-time.After(time.Second):
			t.Error("plugin context was not canceled before the next termination hook")
		}
		select {
		case <-firstHandlerStopped:
		default:
			t.Error("worker handler was still running at the next termination hook")
		}
		select {
		case <-secondHandlerStarted:
			t.Error("worker started a later event after shutdown cancellation")
		default:
		}
		select {
		case <-store.closed:
			t.Error("secret store closed before the next termination hook")
		default:
		}
		close(nextHookCalled)
		return e.Next()
	})

	event := &core.TerminateEvent{App: app}
	if err := app.OnTerminate().Trigger(event, func(*core.TerminateEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	app.OnTerminate().Unbind(hookID)
	select {
	case <-nextHookCalled:
	case <-time.After(time.Second):
		t.Fatal("next termination hook did not run")
	}
	select {
	case <-store.closed:
	case <-time.After(time.Second):
		t.Fatal("secret store was not closed after termination hooks")
	}
}
