package pbstore

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/outbox"
)

func newTestEvent(id string, at time.Time, typ string) outbox.Event {
	return outbox.Event{
		ID: id, Type: typ, Version: 1, OccurredAt: at,
		TenantID: "tenant_test", Data: map[string]any{"record_id": "order_1"},
	}
}

func newApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	return app
}

func TestOutboxDefinitionIsAcceptedByPocketBase(t *testing.T) {
	app := newApp(t)
	existing, err := app.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.Delete(existing); err != nil {
		t.Fatal(err)
	}
	definitionPath := filepath.Join("..", "..", "..", "..", "..", "contracts", "collections", "outbox.json")
	raw, err := os.ReadFile(definitionPath)
	if err != nil {
		t.Fatal(err)
	}
	var definition core.Collection
	if err := json.Unmarshal(raw, &definition); err != nil {
		t.Fatalf("decode PocketBase definition: %v", err)
	}
	if err := app.Save(&definition); err != nil {
		t.Fatalf("PocketBase rejected outbox collection definition: %v", err)
	}
	if _, err := app.FindCollectionByNameOrId(CollectionName); err != nil {
		t.Fatalf("saved collection cannot be read: %v", err)
	}
}

func TestStorePocketBaseTransactionAndWorkerLifecycle(t *testing.T) {
	app := newApp(t)
	collection, err := app.FindCollectionByNameOrId(CollectionName)
	if err != nil {
		t.Fatal(err)
	}
	if collection.ListRule != nil || collection.ViewRule != nil || collection.CreateRule != nil || collection.UpdateRule != nil || collection.DeleteRule != nil {
		t.Fatal("outbox must remain superuser-only")
	}
	for _, name := range []string{"event_id", "type", "version", "occurred_at", "tenant_id", "data", "status", "attempts", "next_attempt_at", "last_error"} {
		if collection.Fields.GetByName(name) == nil {
			t.Fatalf("outbox migration is missing %q", name)
		}
	}
	definitionPath := filepath.Join("..", "..", "..", "..", "..", "contracts", "collections", "outbox.json")
	definitionBytes, err := os.ReadFile(definitionPath)
	if err != nil {
		t.Fatal(err)
	}
	var definition core.Collection
	if err := json.Unmarshal(definitionBytes, &definition); err != nil {
		t.Fatalf("outbox.json is not a PocketBase collection definition: %v", err)
	}
	actualShape, err := stableCollectionShape(collection)
	if err != nil {
		t.Fatal(err)
	}
	definitionShape, err := stableCollectionShape(&definition)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualShape, definitionShape) {
		t.Fatalf("contracts/collections/outbox.json is out of sync with migration:\nactual:     %s\ndefinition: %s", actualShape, definitionShape)
	}

	business := core.NewBaseCollection("orders_test")
	business.Fields.Add(&core.TextField{Name: "order_name", Required: true})
	if err := app.Save(business); err != nil {
		t.Fatal(err)
	}
	store := New(app)
	now := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	rolledBack := newTestEvent("evt_rollback", now, "order.created")
	rollbackErr := errors.New("rollback transaction")
	err = app.RunInTransaction(func(txApp core.App) error {
		record := core.NewRecord(business)
		record.Set("order_name", "rolled back")
		if err := txApp.Save(record); err != nil {
			return err
		}
		if err := store.EnqueueTx(txApp, rolledBack); err != nil {
			return err
		}
		return rollbackErr
	})
	if !errors.Is(err, rollbackErr) {
		t.Fatalf("transaction error = %v, want rollback", err)
	}
	if _, err := app.FindFirstRecordByFilter("orders_test", "order_name = {:name}", map[string]any{"name": "rolled back"}); err == nil {
		t.Fatal("business row survived transaction rollback")
	}
	if due, err := store.Due(context.Background(), now.Add(time.Hour), 20); err != nil || len(due) != 0 {
		t.Fatalf("outbox row survived transaction rollback: due=%+v err=%v", due, err)
	}

	first := newTestEvent("evt_first", now, "order.failed")
	second := newTestEvent("evt_second", now.Add(time.Second), "order.created")
	if err := app.RunInTransaction(func(txApp core.App) error {
		record := core.NewRecord(business)
		record.Set("order_name", "committed")
		if err := txApp.Save(record); err != nil {
			return err
		}
		if err := store.EnqueueTx(txApp, first); err != nil {
			return err
		}
		return store.EnqueueTx(txApp, second)
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.Enqueue(context.Background(), first); !errors.Is(err, outbox.ErrDuplicateEvent) {
		t.Fatalf("duplicate event error = %v, want ErrDuplicateEvent", err)
	}

	due, err := store.Due(context.Background(), now.Add(time.Hour), 20)
	if err != nil || len(due) != 2 || due[0].Event.ID != first.ID || due[1].Event.ID != second.ID {
		t.Fatalf("due events are not oldest-first: %+v err=%v", due, err)
	}

	dispatcher := outbox.NewDispatcher()
	failedCalls := 0
	var delivered []string
	dispatcher.Subscribe("order.failed", func(context.Context, outbox.Event) error {
		failedCalls++
		return errors.New("temporary")
	})
	dispatcher.Subscribe("order.created", func(_ context.Context, event outbox.Event) error {
		delivered = append(delivered, event.ID)
		return nil
	})
	current := now.Add(time.Hour)
	worker := outbox.NewWorker(store, dispatcher, outbox.Config{
		MaxAttempts: 2, BaseDelay: time.Second, MaxDelay: time.Minute,
		Now: func() time.Time { return current },
	})
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	firstEntry, err := findEntry(t, store, first.ID, current.Add(time.Hour))
	if err != nil || firstEntry.Status != outbox.StatusPending || firstEntry.Attempts != 1 {
		t.Fatalf("first retry state = %+v err=%v", firstEntry, err)
	}
	secondEntry, err := findEntry(t, store, second.ID, current.Add(time.Hour))
	if err != nil || secondEntry.Status != outbox.StatusDelivered {
		t.Fatalf("second delivery state = %+v err=%v", secondEntry, err)
	}
	if len(delivered) != 1 || delivered[0] != second.ID {
		t.Fatalf("unexpected delivered events: %v", delivered)
	}

	current = firstEntry.NextAttemptAt
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	firstEntry, err = findEntry(t, store, first.ID, current.Add(time.Hour))
	if err != nil || firstEntry.Status != outbox.StatusFailed || firstEntry.Attempts != 2 || failedCalls != 2 {
		t.Fatalf("failed delivery state = %+v calls=%d err=%v", firstEntry, failedCalls, err)
	}
	if _, err := app.FindFirstRecordByFilter("orders_test", "order_name = {:name}", map[string]any{"name": "committed"}); err != nil {
		t.Fatalf("committed business record missing before restart: %v", err)
	}

	dataDir := app.DataDir()
	if err := app.ClearBootstrap(); err != nil {
		t.Fatal(err)
	}
	reopened := core.NewBaseApp(core.BaseAppConfig{DataDir: dataDir, EncryptionEnv: "pb_test_env"})
	if err := reopened.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := reopened.ClearBootstrap(); err != nil {
			t.Errorf("close reopened app: %v", err)
		}
	})
	if err := reopened.RunAllMigrations(); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.FindFirstRecordByFilter("orders_test", "order_name = {:name}", map[string]any{"name": "committed"}); err != nil {
		t.Fatalf("committed business record missing after restart: %v", err)
	}
	reopenedStore := New(reopened)
	for _, expected := range []struct {
		id     string
		status outbox.Status
	}{
		{first.ID, outbox.StatusFailed},
		{second.ID, outbox.StatusDelivered},
	} {
		entry, err := findEntry(t, reopenedStore, expected.id, current.Add(time.Hour))
		if err != nil || entry.Status != expected.status {
			t.Fatalf("persisted event %q state = %+v err=%v, want %s", expected.id, entry, err, expected.status)
		}
	}
}

func stableCollectionShape(collection *core.Collection) ([]byte, error) {
	encoded, err := json.Marshal(collection)
	if err != nil {
		return nil, err
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		return nil, err
	}
	delete(document, "id")
	delete(document, "created")
	delete(document, "updated")
	fields, ok := document["fields"].([]any)
	if !ok {
		return nil, errors.New("collection fields are missing")
	}
	for _, raw := range fields {
		field, ok := raw.(map[string]any)
		if !ok {
			return nil, errors.New("invalid collection field")
		}
		delete(field, "id")
	}
	return json.Marshal(document)
}

func findEntry(t *testing.T, store *Store, eventID string, now time.Time) (outbox.Entry, error) {
	t.Helper()
	record, err := store.app.FindFirstRecordByFilter(CollectionName, "event_id = {:id}", map[string]any{"id": eventID})
	if err != nil {
		return outbox.Entry{}, err
	}
	return toEntry(record)
}
