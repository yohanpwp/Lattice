// Package pbstore is the PocketBase-backed outbox.Store.
//
// Events live in the "outbox" collection (created by internal/migrations).
// That collection has no API rules, so only superusers can reach it over HTTP.
package pbstore

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/Lattice/backend/internal/platform/outbox"
)

// CollectionName is the PocketBase collection that holds outbox events.
const CollectionName = "outbox"

const maxErrorLen = 2000 // keep in sync with the last_error field's Max in the migration

// Store implements outbox.Store on top of a PocketBase app.
type Store struct {
	app core.App
}

var _ outbox.Store = (*Store)(nil)

func New(app core.App) *Store {
	return &Store{app: app}
}

// Enqueue stores the event in its own write.
func (s *Store) Enqueue(_ context.Context, e outbox.Event) error {
	return s.EnqueueTx(s.app, e)
}

// EnqueueTx stores the event using the given app. Pass the txApp from
// app.RunInTransaction so the event commits atomically with your business data:
// either both are saved or neither is. This is the point of the outbox.
func (s *Store) EnqueueTx(app core.App, e outbox.Event) error {
	if err := e.Validate(); err != nil {
		return err
	}

	collection, err := app.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		return fmt.Errorf("outbox collection missing (did the migration run?): %w", err)
	}
	existing, err := app.FindRecordsByFilter(
		CollectionName,
		"event_id = {:id}",
		"",
		1,
		0,
		dbx.Params{"id": e.ID},
	)
	if err != nil {
		return fmt.Errorf("outbox: check duplicate event id: %w", err)
	}
	if len(existing) > 0 {
		return outbox.ErrDuplicateEvent
	}

	occurred, err := types.ParseDateTime(e.OccurredAt)
	if err != nil {
		return fmt.Errorf("outbox: invalid occurred_at: %w", err)
	}

	record := core.NewRecord(collection)
	record.Set("event_id", e.ID)
	record.Set("type", e.Type)
	record.Set("version", e.Version)
	record.Set("occurred_at", occurred)
	record.Set("tenant_id", e.TenantID)
	record.Set("data", e.Data)
	record.Set("status", string(outbox.StatusPending))
	record.Set("attempts", 0)
	record.Set("next_attempt_at", occurred) // due immediately

	if err := app.Save(record); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return outbox.ErrDuplicateEvent
		}
		// PocketBase can report a uniqueness collision through record field
		// validation instead of the database constraint. Recheck with a bound
		// filter to classify that concurrent duplicate without hiding other
		// validation or persistence errors.
		duplicates, checkErr := app.FindRecordsByFilter(
			CollectionName,
			"event_id = {:id}",
			"",
			1,
			0,
			dbx.Params{"id": e.ID},
		)
		if checkErr == nil && len(duplicates) > 0 {
			return outbox.ErrDuplicateEvent
		}
		return fmt.Errorf("outbox: save event: %w", err)
	}
	return nil
}

// Due returns pending events whose next attempt time has passed, oldest first.
func (s *Store) Due(_ context.Context, now time.Time, limit int) ([]outbox.Entry, error) {
	nowValue, err := types.ParseDateTime(now)
	if err != nil {
		return nil, err
	}

	records, err := s.app.FindRecordsByFilter(
		CollectionName,
		"status = 'pending' && next_attempt_at <= {:now}",
		"+occurred_at,+event_id",
		limit,
		0,
		dbx.Params{"now": nowValue.String()},
	)
	if err != nil {
		return nil, fmt.Errorf("outbox: query due events: %w", err)
	}

	entries := make([]outbox.Entry, 0, len(records))
	for _, record := range records {
		entry, err := toEntry(record)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

func (s *Store) MarkDelivered(_ context.Context, eventID string) error {
	return s.update(eventID, func(r *core.Record) {
		r.Set("status", string(outbox.StatusDelivered))
		r.Set("last_error", "")
	})
}

func (s *Store) MarkRetry(_ context.Context, eventID string, attempts int, next time.Time, lastErr string) error {
	nextValue, err := types.ParseDateTime(next)
	if err != nil {
		return err
	}
	return s.update(eventID, func(r *core.Record) {
		r.Set("attempts", attempts)
		r.Set("next_attempt_at", nextValue)
		r.Set("last_error", truncate(lastErr))
	})
}

func (s *Store) MarkFailed(_ context.Context, eventID string, attempts int, lastErr string) error {
	return s.update(eventID, func(r *core.Record) {
		r.Set("status", string(outbox.StatusFailed))
		r.Set("attempts", attempts)
		r.Set("last_error", truncate(lastErr))
	})
}

func (s *Store) update(eventID string, mutate func(*core.Record)) error {
	record, err := s.app.FindFirstRecordByFilter(CollectionName, "event_id = {:id}", dbx.Params{"id": eventID})
	if err != nil {
		return fmt.Errorf("outbox: find event %q: %w", eventID, err)
	}
	mutate(record)
	return s.app.Save(record)
}

func toEntry(r *core.Record) (outbox.Entry, error) {
	var data map[string]any
	if err := r.UnmarshalJSONField("data", &data); err != nil {
		return outbox.Entry{}, fmt.Errorf("outbox: decode data of %q: %w", r.GetString("event_id"), err)
	}
	if data == nil {
		data = map[string]any{}
	}

	return outbox.Entry{
		Event: outbox.Event{
			ID:         r.GetString("event_id"),
			Type:       r.GetString("type"),
			Version:    r.GetInt("version"),
			OccurredAt: r.GetDateTime("occurred_at").Time(),
			TenantID:   r.GetString("tenant_id"),
			Data:       data,
		},
		Status:        outbox.Status(r.GetString("status")),
		Attempts:      r.GetInt("attempts"),
		NextAttemptAt: r.GetDateTime("next_attempt_at").Time(),
		LastError:     r.GetString("last_error"),
	}, nil
}

func truncate(s string) string {
	runes := []rune(s)
	if len(runes) <= maxErrorLen {
		return s
	}
	return string(runes[:maxErrorLen])
}
