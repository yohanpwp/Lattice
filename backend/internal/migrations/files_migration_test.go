package migrations_test

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/types"

	_ "github.com/Lattice/backend/internal/migrations"
)

func TestFilesMigration_UnprotectedFileFieldBecomesProtected(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// Create an imported collection with an unprotected FileField and un-reconciled public ViewRule
	col := core.NewBaseCollection("documents")
	fileField := &core.FileField{
		Name:      "attachment",
		Protected: false, // Unprotected
	}
	col.Fields.Add(fileField)
	publicRule := ""
	col.ViewRule = &publicRule
	if err := app.Save(col); err != nil {
		t.Fatalf("failed to create test collection: %v", err)
	}

	// Verify it starts unprotected
	loadedCol, err := app.FindCollectionByNameOrId("documents")
	if err != nil {
		t.Fatalf("failed to reload collection: %v", err)
	}
	ff, ok := loadedCol.Fields.GetByName("attachment").(*core.FileField)
	if !ok || ff.Protected {
		t.Fatalf("expected FileField to start unprotected")
	}

	// Find and run the registered 1799000000_ensure_protected_file_fields.go migration Up
	var targetMigration *core.Migration
	for _, m := range core.AppMigrations.Items() {
		if m.File == "1799000000_ensure_protected_file_fields.go" {
			targetMigration = m
			break
		}
	}
	if targetMigration == nil {
		t.Fatalf("expected 1799000000_ensure_protected_file_fields.go to be registered in AppMigrations")
	}

	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("registered migration Up failed: %v", err)
	}

	// Verify the field is now protected
	reloadedCol, err := app.FindCollectionByNameOrId("documents")
	if err != nil {
		t.Fatalf("failed to reload collection: %v", err)
	}
	ffAfter, ok := reloadedCol.Fields.GetByName("attachment").(*core.FileField)
	if !ok || !ffAfter.Protected {
		t.Errorf("expected attachment field to be Protected: true after migration, got %v", ffAfter.Protected)
	}

	// Verify collection's ViewRule was reconciled to enforce Lattice permissions
	if reloadedCol.ViewRule == nil || !strings.Contains(*reloadedCol.ViewRule, "@request.auth.permissions.documents.read") {
		t.Errorf("expected reconciled ViewRule to enforce dataset permissions, got: %v", reloadedCol.ViewRule)
	}

	// Verify Down migration runs without error
	if err := targetMigration.Down(app); err != nil {
		t.Fatalf("registered migration Down failed: %v", err)
	}
}

func TestFilesMigration_PreservesLockedAndCustomRestrictiveRules(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Locked collection: ViewRule is nil, ListRule is nil (superuser only)
	lockedCol := core.NewBaseCollection("locked_docs")
	lockedCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	lockedCol.ViewRule = nil
	lockedCol.ListRule = nil
	if err := app.Save(lockedCol); err != nil {
		t.Fatal(err)
	}

	// 2. Custom restricted collection: ViewRule has custom restrictive business constraint
	customCol := core.NewBaseCollection("custom_docs")
	customCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	customCol.Fields.Add(&core.TextField{Name: "status"})
	customCol.Fields.Add(&core.BoolField{Name: "confidential"})
	customViewRule := "status = 'active' && confidential != true"
	customListRule := "status = 'active'"
	customCol.ViewRule = types.Pointer(customViewRule)
	customCol.ListRule = types.Pointer(customListRule)
	if err := app.Save(customCol); err != nil {
		t.Fatal(err)
	}

	// 3. Public collection: ViewRule is ""
	publicCol := core.NewBaseCollection("public_docs")
	publicCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	publicRule := ""
	publicCol.ViewRule = types.Pointer(publicRule)
	publicCol.ListRule = types.Pointer(publicRule)
	if err := app.Save(publicCol); err != nil {
		t.Fatal(err)
	}

	// Find the registered migration
	var targetMigration *core.Migration
	for _, m := range core.AppMigrations.Items() {
		if m.File == "1799000000_ensure_protected_file_fields.go" {
			targetMigration = m
			break
		}
	}
	if targetMigration == nil {
		t.Fatalf("expected 1799000000_ensure_protected_file_fields.go in AppMigrations")
	}

	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("migration Up failed: %v", err)
	}

	// Verify Locked collection:
	// - Field must become Protected: true
	// - ViewRule MUST REMAIN nil (locked to superusers, not broadened)
	// - ListRule MUST REMAIN nil (locked to superusers, not broadened)
	reloadedLocked, err := app.FindCollectionByNameOrId("locked_docs")
	if err != nil {
		t.Fatal(err)
	}
	ffLocked := reloadedLocked.Fields.GetByName("file").(*core.FileField)
	if !ffLocked.Protected {
		t.Errorf("expected locked_docs file field to be Protected: true")
	}
	if reloadedLocked.ViewRule != nil {
		t.Errorf("security violation: locked ViewRule was broadened from nil to %q", *reloadedLocked.ViewRule)
	}
	if reloadedLocked.ListRule != nil {
		t.Errorf("security violation: locked ListRule was broadened from nil to %q", *reloadedLocked.ListRule)
	}

	// Verify Custom restricted collection:
	// - Field must become Protected: true
	// - ViewRule must retain original constraint AND include Lattice permissions check
	reloadedCustom, err := app.FindCollectionByNameOrId("custom_docs")
	if err != nil {
		t.Fatal(err)
	}
	ffCustom := reloadedCustom.Fields.GetByName("file").(*core.FileField)
	if !ffCustom.Protected {
		t.Errorf("expected custom_docs file field to be Protected: true")
	}
	if reloadedCustom.ViewRule == nil {
		t.Fatalf("expected custom ViewRule to exist")
	}
	if !strings.Contains(*reloadedCustom.ViewRule, "status = 'active' && confidential != true") {
		t.Errorf("security violation: original restrictive ViewRule was lost: %s", *reloadedCustom.ViewRule)
	}
	if !strings.Contains(*reloadedCustom.ViewRule, "@request.auth.permissions.custom_docs.read") {
		t.Errorf("expected ViewRule to include Lattice dataset read check: %s", *reloadedCustom.ViewRule)
	}
	if !strings.Contains(*reloadedCustom.ListRule, "status = 'active'") {
		t.Errorf("security violation: original restrictive ListRule was lost: %s", *reloadedCustom.ListRule)
	}
	if !strings.Contains(*reloadedCustom.ListRule, "@request.auth.permissions.custom_docs.read") {
		t.Errorf("expected ListRule to include Lattice dataset read check: %s", *reloadedCustom.ListRule)
	}

	// Verify Public collection:
	// - Field must become Protected: true
	// - ViewRule must now require Lattice permissions instead of being public
	reloadedPublic, err := app.FindCollectionByNameOrId("public_docs")
	if err != nil {
		t.Fatal(err)
	}
	ffPublic := reloadedPublic.Fields.GetByName("file").(*core.FileField)
	if !ffPublic.Protected {
		t.Errorf("expected public_docs file field to be Protected: true")
	}
	if reloadedPublic.ViewRule == nil || *reloadedPublic.ViewRule == "" {
		t.Errorf("security violation: public ViewRule was not restricted")
	}
	if !strings.Contains(*reloadedPublic.ViewRule, "@request.auth.permissions.public_docs.read") {
		t.Errorf("expected ViewRule to require Lattice dataset read permissions: %s", *reloadedPublic.ViewRule)
	}
}

func TestFilesMigration_UpgradedDatabaseViaMigrationsRunner(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// Seed pre-existing collection with unprotected file field
	col := core.NewBaseCollection("legacy_reports")
	col.Fields.Add(&core.FileField{Name: "report", Protected: false})
	col.Fields.Add(&core.TextField{Name: "status"})
	customRule := "status = 'archived'"
	col.ViewRule = types.Pointer(customRule)
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}

	// Remove 1799000000_ensure_protected_file_fields.go from _migrations to simulate an upgraded DB
	// where this migration has not yet run
	_, err = app.DB().NewQuery("DELETE FROM _migrations WHERE file = '1799000000_ensure_protected_file_fields.go'").Execute()
	if err != nil {
		t.Fatalf("failed to reset migration entry: %v", err)
	}

	// Execute via PocketBase migration runner
	runner := core.NewMigrationsRunner(app, core.AppMigrations)
	applied, err := runner.Up()
	if err != nil {
		t.Fatalf("migrations runner Up failed: %v", err)
	}

	foundApplied := false
	for _, f := range applied {
		if f == "1799000000_ensure_protected_file_fields.go" {
			foundApplied = true
			break
		}
	}
	if !foundApplied {
		t.Fatalf("expected 1799000000_ensure_protected_file_fields.go to be applied by runner, got: %v", applied)
	}

	// Verify legacy_reports was upgraded
	reloaded, err := app.FindCollectionByNameOrId("legacy_reports")
	if err != nil {
		t.Fatal(err)
	}
	ff := reloaded.Fields.GetByName("report").(*core.FileField)
	if !ff.Protected {
		t.Errorf("expected report field to be Protected: true after migration runner")
	}
	if !strings.Contains(*reloaded.ViewRule, "status = 'archived'") || !strings.Contains(*reloaded.ViewRule, "@request.auth.permissions.legacy_reports.read") {
		t.Errorf("expected combined ViewRule after migration runner, got: %v", reloaded.ViewRule)
	}
}

func TestFilesMigration_PermissiveAlternativeAndForeignDatasetReconciled(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// 1. Collection with a permissive alternative (public = true || permissions...)
	permissiveCol := core.NewBaseCollection("permissive_docs")
	permissiveCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	permissiveCol.Fields.Add(&core.BoolField{Name: "public"})
	permissiveCol.ViewRule = types.Pointer("public = true || @request.auth.permissions.permissive_docs.read = true")
	permissiveCol.ListRule = types.Pointer("public = true || @request.auth.permissions.permissive_docs.read = true")
	if err := app.Save(permissiveCol); err != nil {
		t.Fatal(err)
	}

	// 2. Collection with foreign dataset reference
	foreignCol := core.NewBaseCollection("foreign_docs")
	foreignCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	foreignCol.ViewRule = types.Pointer("@request.auth.permissions.other_dataset.read = true")
	foreignCol.ListRule = types.Pointer("@request.auth.permissions.other_dataset.read = true")
	if err := app.Save(foreignCol); err != nil {
		t.Fatal(err)
	}

	// 3. Collection that already structurally conjoins the canonical rule
	canonicalSafeRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.safe_docs.read = true))"
	safeCol := core.NewBaseCollection("safe_docs")
	safeCol.Fields.Add(&core.FileField{Name: "file", Protected: false})
	safeCol.Fields.Add(&core.TextField{Name: "status"})
	initialSafeRule := "(status = 'active') && (" + canonicalSafeRule + ")"
	safeCol.ViewRule = types.Pointer(initialSafeRule)
	safeCol.ListRule = types.Pointer(initialSafeRule)
	if err := app.Save(safeCol); err != nil {
		t.Fatal(err)
	}

	// Run migration Up
	var targetMigration *core.Migration
	for _, m := range core.AppMigrations.Items() {
		if m.File == "1799000000_ensure_protected_file_fields.go" {
			targetMigration = m
			break
		}
	}
	if targetMigration == nil {
		t.Fatalf("expected 1799000000_ensure_protected_file_fields.go in AppMigrations")
	}

	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("migration Up failed: %v", err)
	}

	// 1. Verify permissive_docs: rule must now mandate the canonical Lattice read policy
	reloadedPermissive, err := app.FindCollectionByNameOrId("permissive_docs")
	if err != nil {
		t.Fatal(err)
	}
	if reloadedPermissive.ViewRule == nil {
		t.Fatalf("expected permissive ViewRule to exist")
	}
	expectedPermissiveConjunction := " && (" + strings.ReplaceAll(canonicalSafeRule, "safe_docs", "permissive_docs") + ")"
	if !strings.HasSuffix(*reloadedPermissive.ViewRule, expectedPermissiveConjunction) {
		t.Errorf("expected permissive alternative to be structurally conjoined with canonical rule, got: %s", *reloadedPermissive.ViewRule)
	}

	// 2. Verify foreign_docs: rule must now mandate canonical read check for foreign_docs
	reloadedForeign, err := app.FindCollectionByNameOrId("foreign_docs")
	if err != nil {
		t.Fatal(err)
	}
	if reloadedForeign.ViewRule == nil {
		t.Fatalf("expected foreign ViewRule to exist")
	}
	expectedForeignConjunction := " && (" + strings.ReplaceAll(canonicalSafeRule, "safe_docs", "foreign_docs") + ")"
	if !strings.HasSuffix(*reloadedForeign.ViewRule, expectedForeignConjunction) {
		t.Errorf("expected foreign dataset rule to be conjoined with canonical foreign_docs rule, got: %s", *reloadedForeign.ViewRule)
	}

	// 3. Verify safe_docs: already conjoined rule was left intact without duplicate conjunction
	reloadedSafe, err := app.FindCollectionByNameOrId("safe_docs")
	if err != nil {
		t.Fatal(err)
	}
	if *reloadedSafe.ViewRule != initialSafeRule {
		t.Errorf("expected already enforcing rule to be preserved as-is, got: %s", *reloadedSafe.ViewRule)
	}

	// 4. Verify dashboards collection has revision field
	dashboardsCol, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil {
		t.Fatal(err)
	}
	if dashboardsCol.Fields.GetByName("revision") == nil {
		t.Errorf("expected dashboards collection to have revision field after migration")
	}

	// 5. Run migration Up again to verify idempotency
	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("second migration Up failed: %v", err)
	}
	reloadedPermissive2, _ := app.FindCollectionByNameOrId("permissive_docs")
	if *reloadedPermissive2.ViewRule != *reloadedPermissive.ViewRule {
		t.Errorf("migration was not idempotent on permissive_docs, changed from %s to %s", *reloadedPermissive.ViewRule, *reloadedPermissive2.ViewRule)
	}
}

func TestFilesMigration_MixedOperatorPermissiveOrBranchReconciled(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// Collection with mixed operators: (canonical_read_rule) && status = 'active' || public = true
	// Even though the required rule appears in a conjunct, the top-level '|| public = true' permits records independently.
	mixedCol := core.NewBaseCollection("mixed_docs")
	mixedCol.Fields.Add(&core.FileField{Name: "attachment", Protected: false})
	mixedCol.Fields.Add(&core.TextField{Name: "status"})
	mixedCol.Fields.Add(&core.BoolField{Name: "public"})

	canonicalRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.mixed_docs.read = true))"
	mixedRule := "(" + canonicalRule + ") && status = 'active' || public = true"
	mixedCol.ViewRule = types.Pointer(mixedRule)
	mixedCol.ListRule = types.Pointer(mixedRule)
	if err := app.Save(mixedCol); err != nil {
		t.Fatal(err)
	}

	var targetMigration *core.Migration
	for _, m := range core.AppMigrations.Items() {
		if m.File == "1799000000_ensure_protected_file_fields.go" {
			targetMigration = m
			break
		}
	}
	if targetMigration == nil {
		t.Fatalf("expected 1799000000_ensure_protected_file_fields.go in AppMigrations")
	}

	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("migration Up failed: %v", err)
	}

	reloadedMixed, err := app.FindCollectionByNameOrId("mixed_docs")
	if err != nil {
		t.Fatal(err)
	}

	// Verify the mixed rule was conjoined with the canonical rule so that public = true cannot bypass Lattice auth
	expectedSuffix := " && (" + canonicalRule + ")"
	if reloadedMixed.ViewRule == nil || !strings.HasSuffix(*reloadedMixed.ViewRule, expectedSuffix) {
		t.Fatalf("expected mixed operator rule to be conjoined with canonical rule, got: %v", reloadedMixed.ViewRule)
	}
	if reloadedMixed.ListRule == nil || !strings.HasSuffix(*reloadedMixed.ListRule, expectedSuffix) {
		t.Fatalf("expected mixed operator list rule to be conjoined with canonical rule, got: %v", reloadedMixed.ListRule)
	}

	// Verify idempotency on second run
	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("second migration Up failed: %v", err)
	}
	reloadedMixed2, _ := app.FindCollectionByNameOrId("mixed_docs")
	if *reloadedMixed2.ViewRule != *reloadedMixed.ViewRule {
		t.Errorf("migration was not idempotent on mixed_docs, changed from %s to %s", *reloadedMixed.ViewRule, *reloadedMixed2.ViewRule)
	}
}
