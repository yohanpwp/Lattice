package outbox

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 2, 10, 0, 0, 0, time.UTC)

func quietConfig(now *time.Time) Config {
	return Config{
		MaxAttempts: 3,
		BaseDelay:   10 * time.Second,
		MaxDelay:    time.Minute,
		Now:         func() time.Time { return *now },
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func mustEvent(t *testing.T, typ string, at time.Time) Event {
	t.Helper()
	e, err := NewEvent("tenant_dev", typ, 1, map[string]any{"k": "v"}, at)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestNewEventAndValidate(t *testing.T) {
	e := mustEvent(t, "payment.succeeded", t0)
	if !strings.HasPrefix(e.ID, "evt_") || e.OccurredAt != t0 {
		t.Fatalf("unexpected event: %+v", e)
	}

	cases := map[string]func(*Event){
		"empty id":    func(e *Event) { e.ID = "" },
		"bad type":    func(e *Event) { e.Type = "Payment" },
		"type no dot": func(e *Event) { e.Type = "payment" },
		"bad version": func(e *Event) { e.Version = 0 },
		"no tenant":   func(e *Event) { e.TenantID = "" },
		"zero time":   func(e *Event) { e.OccurredAt = time.Time{} },
		"nil data":    func(e *Event) { e.Data = nil },
		"non-json data": func(e *Event) { e.Data = map[string]any{"bad": make(chan int)} },
		"non-finite data": func(e *Event) { e.Data = map[string]any{"bad": math.NaN()} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bad := mustEvent(t, "payment.succeeded", t0)
			mutate(&bad)
			if err := bad.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestBackoff(t *testing.T) {
	base, max := 10*time.Second, time.Minute
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, time.Minute, time.Minute}
	for i, w := range want {
		if got := Backoff(i+1, base, max); got != w {
			t.Fatalf("attempt %d: got %v want %v", i+1, got, w)
		}
	}
	if got := Backoff(1000, base, max); got != max {
		t.Fatalf("huge attempt must cap at max, got %v", got)
	}
}

func TestWorker_DeliversAndMarksDelivered(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	d := NewDispatcher()
	var seen []string
	d.Subscribe("order.created", func(_ context.Context, e Event) error {
		seen = append(seen, e.ID)
		return nil
	})

	e := mustEvent(t, "order.created", t0)
	if err := store.Enqueue(context.Background(), e); err != nil {
		t.Fatal(err)
	}

	w := NewWorker(store, d, quietConfig(&now))
	n, err := w.RunOnce(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("RunOnce = %d, %v", n, err)
	}
	if len(seen) != 1 || seen[0] != e.ID {
		t.Fatalf("handler not called as expected: %v", seen)
	}
	if entry, _ := store.Get(e.ID); entry.Status != StatusDelivered {
		t.Fatalf("status = %s", entry.Status)
	}

	// Delivered events are not delivered again.
	if n, _ := w.RunOnce(context.Background()); n != 0 {
		t.Fatalf("expected nothing due, got %d", n)
	}
}

func TestWorker_EventWithoutSubscribersIsDelivered(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	e := mustEvent(t, "audit.logged", t0)
	_ = store.Enqueue(context.Background(), e)

	w := NewWorker(store, NewDispatcher(), quietConfig(&now))
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if entry, _ := store.Get(e.ID); entry.Status != StatusDelivered {
		t.Fatalf("status = %s", entry.Status)
	}
}

func TestWorker_RetriesWithBackoffThenFails(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	d := NewDispatcher()
	calls := 0
	d.Subscribe("order.created", func(context.Context, Event) error {
		calls++
		return errors.New("boom")
	})

	e := mustEvent(t, "order.created", t0)
	_ = store.Enqueue(context.Background(), e)
	w := NewWorker(store, d, quietConfig(&now))

	// Attempt 1 fails: retry in 10s.
	_, _ = w.RunOnce(context.Background())
	entry, _ := store.Get(e.ID)
	if entry.Status != StatusPending || entry.Attempts != 1 || !entry.NextAttemptAt.Equal(t0.Add(10*time.Second)) {
		t.Fatalf("after attempt 1: %+v", entry)
	}
	if !strings.Contains(entry.LastError, "boom") {
		t.Fatalf("last error not recorded: %q", entry.LastError)
	}

	// Not due yet: nothing happens.
	if n, _ := w.RunOnce(context.Background()); n != 0 || calls != 1 {
		t.Fatalf("expected no redelivery before backoff, n=%d calls=%d", n, calls)
	}

	// Attempt 2 fails: retry in 20s.
	now = t0.Add(10 * time.Second)
	_, _ = w.RunOnce(context.Background())
	entry, _ = store.Get(e.ID)
	if entry.Attempts != 2 || !entry.NextAttemptAt.Equal(now.Add(20*time.Second)) {
		t.Fatalf("after attempt 2: %+v", entry)
	}

	// Attempt 3 hits MaxAttempts: failed for good.
	now = now.Add(20 * time.Second)
	_, _ = w.RunOnce(context.Background())
	entry, _ = store.Get(e.ID)
	if entry.Status != StatusFailed || entry.Attempts != 3 || calls != 3 {
		t.Fatalf("after attempt 3: %+v calls=%d", entry, calls)
	}
}

func TestWorker_RecoversFromPanickingHandler(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	d := NewDispatcher()
	d.Subscribe("order.created", func(context.Context, Event) error { panic("kaboom") })

	e := mustEvent(t, "order.created", t0)
	_ = store.Enqueue(context.Background(), e)

	w := NewWorker(store, d, quietConfig(&now))
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatalf("a panicking handler must not break the worker: %v", err)
	}
	entry, _ := store.Get(e.ID)
	if entry.Attempts != 1 || !strings.Contains(entry.LastError, "panicked") {
		t.Fatalf("panic not recorded as a failed attempt: %+v", entry)
	}
}

func TestWorker_FailingEventDoesNotBlockOthers(t *testing.T) {
	now := t0.Add(time.Hour)
	store := NewMemoryStore()
	d := NewDispatcher()
	d.Subscribe("a.failed", func(context.Context, Event) error { return errors.New("no") })
	delivered := 0
	d.Subscribe("b.ok", func(context.Context, Event) error { delivered++; return nil })

	_ = store.Enqueue(context.Background(), mustEvent(t, "a.failed", t0))
	_ = store.Enqueue(context.Background(), mustEvent(t, "b.ok", t0.Add(time.Second)))

	w := NewWorker(store, d, quietConfig(&now))
	if _, err := w.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if delivered != 1 {
		t.Fatalf("second event should still be delivered, got %d", delivered)
	}
}

func TestWorker_DoesNotDispatchAfterCancellation(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	d := NewDispatcher()
	ctx, cancel := context.WithCancel(context.Background())
	called := 0
	d.Subscribe("order.created", func(context.Context, Event) error {
		called++
		cancel()
		return nil
	})
	d.Subscribe("order.created", func(context.Context, Event) error {
		called++
		return nil
	})
	_ = store.Enqueue(context.Background(), mustEvent(t, "order.created", t0))
	secondEvent := mustEvent(t, "order.created", t0.Add(time.Second))
	_ = store.Enqueue(context.Background(), secondEvent)

	w := NewWorker(store, d, quietConfig(&now))
	_, _ = w.RunOnce(ctx)
	if called != 1 {
		t.Fatalf("handlers started after cancellation: called %d times", called)
	}
	entries, err := store.Due(context.Background(), now.Add(time.Hour), 10)
	if err != nil || len(entries) != 2 {
		t.Fatalf("canceled deliveries should remain pending: entries=%+v err=%v", entries, err)
	}
	for _, entry := range entries {
		if entry.Attempts != 0 || entry.Status != StatusPending {
			t.Fatalf("shutdown cancellation consumed a retry: %+v", entry)
		}
	}
}

func TestWorker_PreCanceledContextDoesNotLoadOrDispatch(t *testing.T) {
	now := t0
	store := NewMemoryStore()
	_ = store.Enqueue(context.Background(), mustEvent(t, "order.created", t0))
	d := NewDispatcher()
	called := false
	d.Subscribe("order.created", func(context.Context, Event) error { called = true; return nil })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if n, err := NewWorker(store, d, quietConfig(&now)).RunOnce(ctx); n != 0 || !errors.Is(err, context.Canceled) || called {
		t.Fatalf("pre-canceled RunOnce = (%d, %v), called=%v", n, err, called)
	}
}

func TestMemoryStore_RejectsDuplicates(t *testing.T) {
	store := NewMemoryStore()
	e := mustEvent(t, "order.created", t0)
	if err := store.Enqueue(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	if err := store.Enqueue(context.Background(), e); !errors.Is(err, ErrDuplicateEvent) {
		t.Fatalf("expected ErrDuplicateEvent, got %v", err)
	}
}

func TestBus_EmitEnqueuesValidatedEvent(t *testing.T) {
	store := NewMemoryStore()
	bus := NewBus(store, "tenant_dev")

	if err := bus.Emit(context.Background(), "payment.succeeded", 1, map[string]any{"order_id": "o1"}); err != nil {
		t.Fatal(err)
	}
	if err := bus.Emit(context.Background(), "BadType", 1, nil); err == nil {
		t.Fatal("invalid event type must be rejected")
	}

	due, _ := store.Due(context.Background(), time.Now().Add(time.Second), 10)
	if len(due) != 1 || due[0].Event.TenantID != "tenant_dev" {
		t.Fatalf("unexpected due entries: %+v", due)
	}
}
