package migrations_test

import (
	"encoding/json"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func TestAppPagesMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Verify "app_pages" collection was created
	col, err := app.FindCollectionByNameOrId("app_pages")
	if err != nil {
		t.Fatalf("expected app_pages collection to exist, got error: %v", err)
	}

	// 2. Verify API rules require authentication
	expectedRule := "@request.auth.id != ''"
	if col.ListRule == nil || *col.ListRule != expectedRule {
		t.Errorf("expected ListRule %q, got %v", expectedRule, col.ListRule)
	}
	if col.ViewRule == nil || *col.ViewRule != expectedRule {
		t.Errorf("expected ViewRule %q, got %v", expectedRule, col.ViewRule)
	}
	if col.CreateRule == nil || *col.CreateRule != expectedRule {
		t.Errorf("expected CreateRule %q, got %v", expectedRule, col.CreateRule)
	}
	if col.UpdateRule == nil || *col.UpdateRule != expectedRule {
		t.Errorf("expected UpdateRule %q, got %v", expectedRule, col.UpdateRule)
	}
	if col.DeleteRule == nil || *col.DeleteRule != expectedRule {
		t.Errorf("expected DeleteRule %q, got %v", expectedRule, col.DeleteRule)
	}

	// 3. Verify fields exist
	requiredFields := []string{"page_id", "name", "view_type", "collection", "config"}
	for _, fieldName := range requiredFields {
		f := col.Fields.GetByName(fieldName)
		if f == nil {
			t.Errorf("expected field %q to exist in app_pages", fieldName)
		}
	}

	// 4. Test creating and saving a page record conforming to page-definition
	configDoc := map[string]any{
		"columns": []string{"title", "status"},
		"perPage": 20,
	}
	configBytes, err := json.Marshal(configDoc)
	if err != nil {
		t.Fatalf("failed to marshal config JSON: %v", err)
	}

	record := core.NewRecord(col)
	record.Set("page_id", "orders-table")
	record.Set("name", "Orders Table")
	record.Set("view_type", "table")
	record.Set("collection", "orders")
	record.Set("config", string(configBytes))

	if err := app.Save(record); err != nil {
		t.Fatalf("failed to save app_pages record: %v", err)
	}

	// 5. Verify record can be retrieved
	found, err := app.FindFirstRecordByFilter("app_pages", "page_id = {:id}", map[string]any{"id": "orders-table"})
	if err != nil {
		t.Fatalf("failed to find created app_pages record: %v", err)
	}
	if found.GetString("name") != "Orders Table" {
		t.Errorf("expected name %q, got %q", "Orders Table", found.GetString("name"))
	}
	if found.GetString("view_type") != "table" {
		t.Errorf("expected view_type %q, got %q", "table", found.GetString("view_type"))
	}

	// 6. Verify "app_pages" is excluded from public business collections
	discovered := tenant.DiscoveredCollections(app, nil)
	for _, name := range discovered {
		if name == "app_pages" {
			t.Errorf("app_pages should be excluded from DiscoveredCollections, but was found")
		}
	}
}
