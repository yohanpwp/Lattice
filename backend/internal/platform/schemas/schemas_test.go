package schemas_test

import (
	"context"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func TestSchemasServiceCRUD(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Initial listing should discover "users" but no system/platform collections
	initial, err := svc.ListSchemas(ctx)
	if err != nil {
		t.Fatalf("failed to list schemas: %v", err)
	}

	for _, s := range initial {
		if tenant.PlatformCollections[s.SchemaID] {
			t.Errorf("platform collection %q should not be in schemas list", s.SchemaID)
		}
		if s.SchemaID[0] == '_' {
			t.Errorf("system collection %q should not be in schemas list", s.SchemaID)
		}
	}

	// 2. Reject reserved schema IDs
	badDefs := []string{"outbox", "payment_ledger", "dashboards", "schema_definitions", "users", "_custom"}
	for _, bad := range badDefs {
		_, err := svc.CreateSchema(ctx, schemas.SchemaDefinition{
			SchemaID: bad,
			Name:     "Test",
			Fields:   []schemas.FieldDefinition{{Name: "title", Type: "text"}},
		})
		if err == nil {
			t.Errorf("expected error creating reserved schema %q, got nil", bad)
		}
	}

	// 3. Create a valid business schema
	inventoryDef := schemas.SchemaDefinition{
		SchemaID:    "inventory",
		Name:        "คลังสินค้า",
		Description: "รายการสินค้าคงคลัง",
		Icon:        "📦",
		Fields: []schemas.FieldDefinition{
			{Name: "item_name", Label: "ชื่อสินค้า", Type: "text", Required: true},
			{Name: "quantity", Label: "จำนวน", Type: "number", Required: true},
			{Name: "price", Label: "ราคา", Type: "number", Required: false},
			{Name: "status", Label: "สถานะ", Type: "select", Required: true, Options: []string{"in_stock", "out_of_stock"}},
		},
	}

	created, err := svc.CreateSchema(ctx, inventoryDef)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}
	if created.SchemaID != "inventory" || created.Name != "คลังสินค้า" {
		t.Errorf("unexpected created schema: %+v", created)
	}

	// 4. Verify PocketBase collection exists and has table in SQLite
	col, err := app.FindCollectionByNameOrId("inventory")
	if err != nil || col == nil {
		t.Fatalf("expected PocketBase collection 'inventory' to exist: %v", err)
	}

	// Check fields
	if f := col.Fields.GetByName("item_name"); f == nil {
		t.Error("expected field 'item_name' to exist in PocketBase collection")
	}
	if f := col.Fields.GetByName("status"); f == nil {
		t.Error("expected field 'status' to exist in PocketBase collection")
	}

	// 5. Test saving and retrieving a record in the new collection
	rec := core.NewRecord(col)
	rec.Set("item_name", "เครื่องพิมพ์บาร์โค้ด")
	rec.Set("quantity", 10)
	rec.Set("price", 2500)
	rec.Set("status", "in_stock")
	if err := app.Save(rec); err != nil {
		t.Fatalf("failed to save record into new collection: %v", err)
	}

	// 6. GetSchema returns rich metadata
	fetched, err := svc.GetSchema(ctx, "inventory")
	if err != nil {
		t.Fatalf("failed to get schema: %v", err)
	}
	if fetched.SchemaID != "inventory" || fetched.Icon != "📦" {
		t.Errorf("unexpected fetched schema: %+v", fetched)
	}

	// 7. Test contract validation against embedded SchemaDefinition schema
	jsonMap := map[string]any{
		"schema_id": fetched.SchemaID,
		"name":      fetched.Name,
		"fields": []any{
			map[string]any{"name": "item_name", "type": "text"},
		},
	}
	if err := tenant.ValidateContractDocument("SchemaDefinition", jsonMap); err != nil {
		t.Errorf("contract validation failed: %v", err)
	}

	// 8. DeleteSchema
	if err := svc.DeleteSchema(ctx, "inventory"); err != nil {
		t.Fatalf("failed to delete schema: %v", err)
	}

	// Ensure it is gone
	_, err = svc.GetSchema(ctx, "inventory")
	if err == nil {
		t.Error("expected schema 'inventory' to be deleted")
	}
}

func TestSchemasSyncHooks(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	schemas.RegisterSyncHooks(app)
	svc := schemas.NewService(app)
	ctx := context.Background()

	// Create collection directly via PocketBase core
	directCol := core.NewBaseCollection("customers")
	directCol.Fields.Add(&core.TextField{Name: "customer_name", Required: true})
	if err := app.Save(directCol); err != nil {
		t.Fatalf("failed to save direct collection: %v", err)
	}

	// Verify hook auto-synced it into schema_definitions
	synced, err := svc.GetSchema(ctx, "customers")
	if err != nil {
		t.Fatalf("expected customers to be auto-synced into schema_definitions: %v", err)
	}
	if synced.SchemaID != "customers" {
		t.Errorf("expected schema_id 'customers', got %q", synced.SchemaID)
	}
}
