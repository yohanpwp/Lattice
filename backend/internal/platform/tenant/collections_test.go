package tenant_test

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func TestDiscoveredCollections(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Initial app should discover "users" (auth collection), but NOT system (_*) or platform (outbox, payment_ledger, dashboards)
	discovered := tenant.DiscoveredCollections(app, nil)
	hasUsers := false
	for _, col := range discovered {
		if col == "users" {
			hasUsers = true
		}
		if tenant.PlatformCollections[col] {
			t.Errorf("platform collection %q should not be discovered", col)
		}
		if col[0] == '_' {
			t.Errorf("system collection %q should not be discovered", col)
		}
	}
	if !hasUsers {
		t.Errorf("expected 'users' to be discovered, got %v", discovered)
	}

	// 2. Create a new custom dynamic business collection (e.g. "inventory")
	invCol := core.NewBaseCollection("inventory")
	invCol.Fields.Add(&core.TextField{Name: "item_name", Required: true})
	if err := app.Save(invCol); err != nil {
		t.Fatalf("failed to save custom business collection: %v", err)
	}

	// 3. Re-discover collections; "inventory" should now be included
	discoveredAfter := tenant.DiscoveredCollections(app, nil)
	hasInventory := false
	for _, col := range discoveredAfter {
		if col == "inventory" {
			hasInventory = true
		}
	}
	if !hasInventory {
		t.Errorf("expected 'inventory' to be discovered after creation, got %v", discoveredAfter)
	}

	// 4. Test explicit config preservation
	explicit := []string{"custom_external"}
	withExplicit := tenant.DiscoveredCollections(app, explicit)
	if len(withExplicit) == 0 || withExplicit[0] != "custom_external" {
		t.Errorf("expected explicit collection to be preserved, got %v", withExplicit)
	}

	// 5. Safe handling of nil app
	nilRes := tenant.DiscoveredCollections(nil, []string{"fallback"})
	if len(nilRes) != 1 || nilRes[0] != "fallback" {
		t.Errorf("expected fallback for nil app, got %v", nilRes)
	}
}
