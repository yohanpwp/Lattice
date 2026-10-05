package outbox

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// MemoryStore is an in-memory Store for tests and local experiments.
// Nothing is persisted.
type MemoryStore struct {
	mu      sync.Mutex
	entries map[string]*Entry
	order   []string
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{entries: map[string]*Entry{}}
}

func (m *MemoryStore) Enqueue(_ context.Context, e Event) error {
	if err := e.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.entries[e.ID]; exists {
		return ErrDuplicateEvent
	}
	m.entries[e.ID] = &Entry{Event: e, Status: StatusPending, NextAttemptAt: e.OccurredAt}
	m.order = append(m.order, e.ID)
	return nil
}

func (m *MemoryStore) Due(_ context.Context, now time.Time, limit int) ([]Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var due []Entry
	for _, id := range m.order {
		entry := m.entries[id]
		if entry.Status == StatusPending && !entry.NextAttemptAt.After(now) {
			due = append(due, *entry)
		}
	}
	sort.SliceStable(due, func(i, j int) bool {
		return due[i].Event.OccurredAt.Before(due[j].Event.OccurredAt)
	})
	if limit > 0 && len(due) > limit {
		due = due[:limit]
	}
	return due, nil
}

func (m *MemoryStore) update(id string, fn func(*Entry)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[id]
	if !ok {
		return fmt.Errorf("outbox: unknown event %q", id)
	}
	fn(entry)
	return nil
}

func (m *MemoryStore) MarkDelivered(_ context.Context, id string) error {
	return m.update(id, func(e *Entry) { e.Status = StatusDelivered })
}

func (m *MemoryStore) MarkRetry(_ context.Context, id string, attempts int, next time.Time, lastErr string) error {
	return m.update(id, func(e *Entry) {
		e.Attempts, e.NextAttemptAt, e.LastError = attempts, next, lastErr
	})
}

func (m *MemoryStore) MarkFailed(_ context.Context, id string, attempts int, lastErr string) error {
	return m.update(id, func(e *Entry) {
		e.Status, e.Attempts, e.LastError = StatusFailed, attempts, lastErr
	})
}

// Get returns a copy of the entry for assertions in tests.
func (m *MemoryStore) Get(id string) (Entry, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.entries[id]
	if !ok {
		return Entry{}, false
	}
	return *entry, true
}
