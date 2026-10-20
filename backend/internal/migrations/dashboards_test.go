package migrations_test

import (
	"encoding/json"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func TestDashboardsMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Verify "dashboards" collection was created
	col, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil {
		t.Fatalf("expected dashboards collection to exist, got error: %v", err)
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
	if f := col.Fields.GetByName("name"); f == nil {
		t.Error("expected field 'name' to exist")
	}
	if f := col.Fields.GetByName("layout"); f == nil {
		t.Error("expected field 'layout' to exist")
	}

	// 4. Test creating and saving a record conforming to dashboard-layout.json
	layoutDoc := map[string]any{
		"id":   "main",
		"name": "Main Dashboard",
		"layout": []any{
			map[string]any{
				"id":         "default-kpi-users",
				"type":       "kpi",
				"collection": "users",
				"x":          0,
				"y":          0,
				"w":          3,
				"h":          2,
				"props": map[string]any{
					"metric": "count",
				},
			},
		},
	}

	// Contract validation check against the embedded JSON schema
	if err := tenant.ValidateContractDocument("DashboardLayout", layoutDoc); err != nil {
		t.Fatalf("layoutDoc does not satisfy DashboardLayout contract: %v", err)
	}

	record := core.NewRecord(col)
	record.Set("name", "main")
	record.Set("layout", layoutDoc)

	if err := app.Save(record); err != nil {
		t.Fatalf("failed to save dashboard record: %v", err)
	}

	// 5. Query record back and verify layout payload
	found, err := app.FindFirstRecordByFilter("dashboards", "name = {:name}", map[string]any{
		"name": "main",
	})
	if err != nil {
		t.Fatalf("failed to find dashboard record: %v", err)
	}

	if found.GetString("name") != "main" {
		t.Errorf("expected name 'main', got %q", found.GetString("name"))
	}

	rawLayout := found.Get("layout")
	layoutBytes, err := json.Marshal(rawLayout)
	if err != nil {
		t.Fatalf("failed to marshal loaded layout: %v", err)
	}

	var parsedLayout map[string]any
	if err := json.Unmarshal(layoutBytes, &parsedLayout); err != nil {
		t.Fatalf("failed to unmarshal loaded layout: %v", err)
	}

	if err := tenant.ValidateContractDocument("DashboardLayout", parsedLayout); err != nil {
		t.Errorf("loaded layout failed contract validation: %v", err)
	}
}

func TestSchemaDefinitionsMigration(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Verify "schema_definitions" collection was created
	col, err := app.FindCollectionByNameOrId("schema_definitions")
	if err != nil {
		t.Fatalf("expected schema_definitions collection to exist, got error: %v", err)
	}

	// 2. Verify all API rules are nil (Superuser only)
	if col.ListRule != nil {
		t.Errorf("expected ListRule to be nil, got %v", col.ListRule)
	}
	if col.ViewRule != nil {
		t.Errorf("expected ViewRule to be nil, got %v", col.ViewRule)
	}
	if col.CreateRule != nil {
		t.Errorf("expected CreateRule to be nil, got %v", col.CreateRule)
	}
	if col.UpdateRule != nil {
		t.Errorf("expected UpdateRule to be nil, got %v", col.UpdateRule)
	}
	if col.DeleteRule != nil {
		t.Errorf("expected DeleteRule to be nil, got %v", col.DeleteRule)
	}

	// 3. Verify fields
	for _, fieldName := range []string{"schema_id", "name", "description", "icon", "fields", "collection_id", "created", "updated"} {
		if f := col.Fields.GetByName(fieldName); f == nil {
			t.Errorf("expected field %q to exist in schema_definitions", fieldName)
		}
	}
}
