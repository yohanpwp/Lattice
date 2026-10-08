package outbox

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

// Config tunes the worker. Zero values fall back to defaults.
type Config struct {
	BatchSize   int           // events per poll (default 50)
	MaxAttempts int           // total delivery attempts before giving up (default 8)
	BaseDelay   time.Duration // first retry delay (default 5s)
	MaxDelay    time.Duration // retry delay cap (default 15m)
	Interval    time.Duration // poll interval for Run (default 2s)
	Now         func() time.Time
	Logger      *slog.Logger
}

// DefaultConfig returns sensible defaults.
func DefaultConfig(logger *slog.Logger) Config {
	return Config{Logger: logger}.withDefaults()
}

func (c Config) withDefaults() Config {
	if c.BatchSize <= 0 {
		c.BatchSize = 50
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = 8
	}
	if c.BaseDelay <= 0 {
		c.BaseDelay = 5 * time.Second
	}
	if c.MaxDelay <= 0 {
		c.MaxDelay = 15 * time.Minute
	}
	if c.Interval <= 0 {
		c.Interval = 2 * time.Second
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	return c
}

// Worker polls the store and delivers due events.
//
// Run exactly one Worker per data directory: PocketBase uses a single SQLite
// database per tenant instance, so there is one process and no cross-process
// claiming. Events are delivered oldest-first per poll, but a failing event
// does not block newer ones (no strict ordering guarantee).
type Worker struct {
	store      Store
	dispatcher *Dispatcher
	cfg        Config
}

func NewWorker(store Store, dispatcher *Dispatcher, cfg Config) *Worker {
	return &Worker{store: store, dispatcher: dispatcher, cfg: cfg.withDefaults()}
}

// Backoff returns the delay before retry number attempt (1-based):
// base, 2*base, 4*base ... capped at max.
func Backoff(attempt int, base, max time.Duration) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := base
	for i := 1; i < attempt; i++ {
		d *= 2
		if d >= max || d <= 0 { // d <= 0 guards against overflow
			return max
		}
	}
	if d > max {
		return max
	}
	return d
}

// RunOnce delivers one batch of due events and returns how many it processed.
func (w *Worker) RunOnce(ctx context.Context) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	now := w.cfg.Now()
	entries, err := w.store.Due(ctx, now, w.cfg.BatchSize)
	if err != nil {
		return 0, err
	}

	var errs []error
	processed := 0
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if err := w.deliver(ctx, entry, now); err != nil {
			errs = append(errs, err)
		}
		processed++
	}
	return processed, errors.Join(errs...)
}

func (w *Worker) deliver(ctx context.Context, entry Entry, now time.Time) error {
	id := entry.Event.ID

	handlerErr := w.dispatcher.Dispatch(ctx, entry.Event)
	if ctx.Err() != nil {
		// Shutdown is not a delivery failure. Keep the event pending without
		// consuming an attempt; the next process can safely retry it.
		return ctx.Err()
	}
	if handlerErr == nil {
		return w.store.MarkDelivered(ctx, id)
	}

	attempts := entry.Attempts + 1
	if attempts >= w.cfg.MaxAttempts {
		w.cfg.Logger.Error("outbox: giving up on event", "event_id", id, "type", entry.Event.Type, "attempts", attempts, "error", handlerErr)
		return w.store.MarkFailed(ctx, id, attempts, handlerErr.Error())
	}

	next := now.Add(Backoff(attempts, w.cfg.BaseDelay, w.cfg.MaxDelay))
	w.cfg.Logger.Warn("outbox: delivery failed, will retry", "event_id", id, "type", entry.Event.Type, "attempts", attempts, "retry_at", next, "error", handlerErr)
	return w.store.MarkRetry(ctx, id, attempts, next, handlerErr.Error())
}

// Run polls until ctx is cancelled.
func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(w.cfg.Interval)
	defer ticker.Stop()

	for {
		if _, err := w.RunOnce(ctx); err != nil && ctx.Err() == nil {
			w.cfg.Logger.Error("outbox: poll failed", "error", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
