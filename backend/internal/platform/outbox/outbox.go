// Package outbox implements a small transactional-outbox style event system.
//
// Events are written to a Store, then a Worker delivers them to subscribed
// handlers with retry and exponential backoff.
//
// Delivery is AT-LEAST-ONCE: a handler can see the same event more than once
// (retry after a crash or a failing sibling handler). Handlers MUST be
// idempotent; use Event.ID as the idempotency key.
//
// This package has no PocketBase dependency so it can be tested in isolation.
// The PocketBase-backed Store lives in the pbstore sub-package.
package outbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/Lattice/backend/internal/platform/tenant"
)

var typePattern = regexp.MustCompile(`^[a-z_]+(\.[a-z_]+)+$`)

// Event mirrors contracts/schemas/events/envelope.json.
type Event struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"` // e.g. "payment.succeeded"
	Version    int            `json:"version"`
	OccurredAt time.Time      `json:"occurred_at"`
	TenantID   string         `json:"tenant_id"`
	Data       map[string]any `json:"data"`
}

// NewEvent builds and validates an event with a fresh random ID.
func NewEvent(tenantID, eventType string, version int, data map[string]any, now time.Time) (Event, error) {
	id, err := newID()
	if err != nil {
		return Event{}, err
	}
	if data == nil {
		data = map[string]any{}
	}
	e := Event{
		ID:         id,
		Type:       eventType,
		Version:    version,
		OccurredAt: now.UTC(),
		TenantID:   tenantID,
		Data:       data,
	}
	return e, e.Validate()
}

// Validate checks the event against the envelope contract.
func (e Event) Validate() error {
	encoded, err := json.Marshal(e)
	if err != nil {
		return fmt.Errorf("encode event: %w", err)
	}
	var document any
	if err := json.Unmarshal(encoded, &document); err != nil {
		return fmt.Errorf("decode event: %w", err)
	}
	if err := tenant.ValidateContractDocument("EventEnvelope", document); err != nil {
		return err
	}

	var errs []error
	if e.ID == "" {
		errs = append(errs, errors.New("id is required"))
	}
	if !typePattern.MatchString(e.Type) {
		errs = append(errs, fmt.Errorf("type %q must look like \"domain.action\"", e.Type))
	}
	if e.Version < 1 {
		errs = append(errs, errors.New("version must be >= 1"))
	}
	if e.TenantID == "" {
		errs = append(errs, errors.New("tenant_id is required"))
	}
	if e.OccurredAt.IsZero() {
		errs = append(errs, errors.New("occurred_at is required"))
	}
	if e.Data == nil {
		errs = append(errs, errors.New("data is required (use an empty object)"))
	}
	return errors.Join(errs...)
}

func newID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate event id: %w", err)
	}
	return "evt_" + hex.EncodeToString(buf), nil
}

// Status is the delivery state of a stored event.
type Status string

const (
	StatusPending   Status = "pending"
	StatusDelivered Status = "delivered"
	StatusFailed    Status = "failed" // gave up after MaxAttempts
)

// Entry is an event plus its delivery bookkeeping.
type Entry struct {
	Event         Event
	Status        Status
	Attempts      int
	NextAttemptAt time.Time
	LastError     string
}

// ErrDuplicateEvent is returned when an event ID is enqueued twice.
var ErrDuplicateEvent = errors.New("outbox: duplicate event id")

// Store persists events and their delivery state.
type Store interface {
	// Enqueue stores a new pending event, due immediately.
	Enqueue(ctx context.Context, e Event) error
	// Due returns up to limit pending entries whose NextAttemptAt <= now, oldest first.
	Due(ctx context.Context, now time.Time, limit int) ([]Entry, error)
	MarkDelivered(ctx context.Context, eventID string) error
	MarkRetry(ctx context.Context, eventID string, attempts int, next time.Time, lastErr string) error
	MarkFailed(ctx context.Context, eventID string, attempts int, lastErr string) error
}

// Handler processes one event. Return an error to request a retry.
type Handler func(ctx context.Context, e Event) error

// Dispatcher routes events to the handlers subscribed to their type.
type Dispatcher struct {
	mu       sync.RWMutex
	handlers map[string][]Handler
}

func NewDispatcher() *Dispatcher {
	return &Dispatcher{handlers: map[string][]Handler{}}
}

// Subscribe registers a handler for an event type such as "payment.succeeded".
func (d *Dispatcher) Subscribe(eventType string, h Handler) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.handlers[eventType] = append(d.handlers[eventType], h)
}

// Dispatch runs every handler for the event's type. A panic in a handler is
// recovered and reported as an error. Events with no subscribers succeed.
func (d *Dispatcher) Dispatch(ctx context.Context, e Event) error {
	d.mu.RLock()
	handlers := append([]Handler(nil), d.handlers[e.Type]...)
	d.mu.RUnlock()

	var errs []error
	for i, h := range handlers {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		if err := safeCall(ctx, h, e); err != nil {
			errs = append(errs, fmt.Errorf("handler %d for %s: %w", i, e.Type, err))
		}
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
	}
	return errors.Join(errs...)
}

func safeCall(ctx context.Context, h Handler, e Event) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panicked: %v", r)
		}
	}()
	return h(ctx, e)
}

// Emitter creates events and stores them.
type Emitter struct {
	store    Store
	tenantID string
	now      func() time.Time
}

func NewEmitter(store Store, tenantID string) *Emitter {
	return &Emitter{store: store, tenantID: tenantID, now: time.Now}
}

// Emit builds a validated event and enqueues it for delivery.
func (em *Emitter) Emit(ctx context.Context, eventType string, version int, data map[string]any) error {
	e, err := NewEvent(em.tenantID, eventType, version, data, em.now())
	if err != nil {
		return err
	}
	return em.store.Enqueue(ctx, e)
}

// Bus combines an Emitter and a Dispatcher: plugins call Emit and Subscribe.
type Bus struct {
	*Emitter
	*Dispatcher
}

func NewBus(store Store, tenantID string) *Bus {
	return &Bus{Emitter: NewEmitter(store, tenantID), Dispatcher: NewDispatcher()}
}
