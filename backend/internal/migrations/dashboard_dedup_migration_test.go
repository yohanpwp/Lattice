package migrations_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
)

// findMigration1799 returns the registered 1799 migration or fails the test.
func findMigration1799(t *testing.T) *core.Migration {
	t.Helper()
	for _, m := range core.AppMigrations.Items() {
		if m.File == "1799000000_ensure_protected_file_fields.go" {
			return m
		}
	}
	t.Fatal("1799000000_ensure_protected_file_fields.go not registered in AppMigrations")
	return nil
}

// seedDuplicateDashboards drops the unique name index, inserts duplicate-named
// dashboard records via raw SQL (bypassing PocketBase collection validation),
// and re-verifies that duplicates exist before the test migration runs.
//
// The unique index was added in migration 1792000000_create_dashboards.go, so a
// fresh test app already has it.  To simulate a database that pre-dates the unique
// index, we drop it here, insert duplicates, and let migration 1799 reconcile them.
func seedDuplicateDashboards(t *testing.T, app *tests.TestApp) (rec1ID, rec2ID, rec3ID string) {
	t.Helper()

	// Drop the unique index so we can insert duplicates directly.
	if _, err := app.DB().NewQuery("DROP INDEX IF EXISTS idx_dashboards_name").Execute(); err != nil {
		t.Fatalf("failed to drop unique index: %v", err)
	}

	dashboardsCol, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil || dashboardsCol == nil {
		t.Fatal("dashboards collection not found")
	}

	now := time.Now().UTC()
	// rec1: revision=1, earliest created  → will be renamed (lowest rev)
	rec1 := core.NewRecord(dashboardsCol)
	rec1.Set("name", "main")
	rec1.Set("revision", 1)
	rec1.Set("layout", `{"id":"main","name":"Main v1","layout":[]}`)
	rec1.SetRaw("created", now.Add(-10*time.Second).Format(time.RFC3339))
	if err := app.SaveNoValidate(rec1); err != nil {
		t.Fatalf("failed to seed rec1: %v", err)
	}

	// rec2: revision=3, latest created  → authoritative (highest rev)
	rec2 := core.NewRecord(dashboardsCol)
	rec2.Set("name", "main")
	rec2.Set("revision", 3)
	rec2.Set("layout", `{"id":"main","name":"Main v3","layout":[]}`)
	rec2.SetRaw("created", now.Add(-5*time.Second).Format(time.RFC3339))
	if err := app.SaveNoValidate(rec2); err != nil {
		t.Fatalf("failed to seed rec2: %v", err)
	}

	// rec3: revision=2, middle  → will be renamed
	rec3 := core.NewRecord(dashboardsCol)
	rec3.Set("name", "main")
	rec3.Set("revision", 2)
	rec3.Set("layout", `{"id":"main","name":"Main v2","layout":[]}`)
	rec3.SetRaw("created", now.Add(-8*time.Second).Format(time.RFC3339))
	if err := app.SaveNoValidate(rec3); err != nil {
		t.Fatalf("failed to seed rec3: %v", err)
	}

	return rec1.Id, rec2.Id, rec3.Id
}

// TestDashboardDedupMigration_DuplicateNamesResolvedBeforeUniqueIndex verifies:
//   - Migration 1799 reconciles an existing DB that has two or more dashboard records
//     sharing the same name (which was valid before the unique index was introduced).
//   - The authoritative record (highest revision, most-recently created as tiebreaker)
//     retains the original name.
//   - Every non-authoritative duplicate is renamed to "<name>_dup_<id>"; no layout is
//     silently discarded.
//   - The unique index is applied successfully after deduplication (migration does not
//     error out).
//   - Migration Down runs without error.
//   - A second Up run (idempotency) does not corrupt data or fail.
func TestDashboardDedupMigration_DuplicateNamesResolvedBeforeUniqueIndex(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	targetMigration := findMigration1799(t)

	// Seed a unique-named record that must remain untouched.
	dashboardsCol, _ := app.FindCollectionByNameOrId("dashboards")
	uniqueRec := core.NewRecord(dashboardsCol)
	uniqueRec.Set("name", "secondary")
	uniqueRec.Set("revision", 1)
	uniqueRec.Set("layout", `{"id":"secondary","name":"Secondary","layout":[]}`)
	if err := app.SaveNoValidate(uniqueRec); err != nil {
		t.Fatalf("failed to seed uniqueRec: %v", err)
	}

	// Seed the three duplicate-named records (drops unique index internally).
	rec1ID, rec2ID, rec3ID := seedDuplicateDashboards(t, app)

	// Confirm we actually have 3 records named "main" before the migration.
	allBefore, _ := app.FindAllRecords("dashboards")
	mainCountBefore := 0
	for _, r := range allBefore {
		if r.GetString("name") == "main" {
			mainCountBefore++
		}
	}
	if mainCountBefore != 3 {
		t.Fatalf("precondition failed: expected 3 'main' records before migration, got %d", mainCountBefore)
	}

	// --- Run migration Up ---
	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("migration Up failed (should not fail even with duplicate names): %v", err)
	}

	// --- Assertions ---
	allAfter, err := app.FindAllRecords("dashboards")
	if err != nil {
		t.Fatalf("failed to list dashboards after migration: %v", err)
	}

	// Total count must be unchanged (no records deleted).
	if len(allAfter) != 4 {
		t.Errorf("expected 4 dashboard records after migration (no deletions), got %d", len(allAfter))
	}

	// Exactly one record named "main" must remain.
	mainCount := 0
	var authoritativeRec *core.Record
	var dupNames []string
	for _, rec := range allAfter {
		name := rec.GetString("name")
		switch name {
		case "main":
			mainCount++
			authoritativeRec = rec
		default:
			dupNames = append(dupNames, name)
		}
	}
	if mainCount != 1 {
		t.Errorf("expected exactly 1 dashboard named 'main' after dedup, got %d", mainCount)
	}

	// The authoritative record must be rec2 (revision=3, the highest).
	if authoritativeRec != nil && authoritativeRec.Id != rec2ID {
		t.Errorf("expected authoritative record to be rec2 (highest revision=%s), got id=%s", rec2ID, authoritativeRec.Id)
	}

	// rec1 (lowest revision) must have been renamed.
	expectedRec1Name := fmt.Sprintf("main_dup_%s", rec1ID)
	rec1Renamed := false
	for _, n := range dupNames {
		if n == expectedRec1Name {
			rec1Renamed = true
		}
	}
	if !rec1Renamed {
		t.Errorf("expected rec1 to be renamed to %q, found dup names: %v", expectedRec1Name, dupNames)
	}

	// rec3 (middle revision) must have been renamed.
	expectedRec3Name := fmt.Sprintf("main_dup_%s", rec3ID)
	rec3Renamed := false
	for _, n := range dupNames {
		if n == expectedRec3Name {
			rec3Renamed = true
		}
	}
	if !rec3Renamed {
		t.Errorf("expected rec3 to be renamed to %q, found dup names: %v", expectedRec3Name, dupNames)
	}

	// The unique record "secondary" must be untouched.
	secondaryAfter, err := app.FindFirstRecordByFilter("dashboards", "name = 'secondary'")
	if err != nil || secondaryAfter == nil {
		t.Error("expected unique 'secondary' dashboard to still exist unchanged after migration")
	}

	// --- Down migration ---
	if err := targetMigration.Down(app); err != nil {
		t.Fatalf("migration Down failed: %v", err)
	}

	// --- Second Up run (idempotency) ---
	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("second migration Up (idempotency) failed: %v", err)
	}
	authAfterSecondRun, err := app.FindFirstRecordByFilter("dashboards", "name = 'main'")
	if err != nil || authAfterSecondRun == nil {
		t.Error("expected 'main' dashboard to still exist after second migration Up run")
	} else if authAfterSecondRun.Id != rec2ID {
		t.Errorf("after second run, authoritative id changed: expected %s, got %s", rec2ID, authAfterSecondRun.Id)
	}

	// Unused var guard.
	_ = rec3ID
}

// TestDashboardDedupMigration_RevisionTiebreakerUsesCreatedTimestamp verifies that
// when two records share the same revision value, the more recently created one is
// treated as authoritative (retained under the original name).
func TestDashboardDedupMigration_RevisionTiebreakerUsesCreatedTimestamp(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	targetMigration := findMigration1799(t)

	dashboardsCol, _ := app.FindCollectionByNameOrId("dashboards")

	// Drop unique index to allow duplicate inserts.
	if _, err := app.DB().NewQuery("DROP INDEX IF EXISTS idx_dashboards_name").Execute(); err != nil {
		t.Fatalf("failed to drop unique index: %v", err)
	}

	now := time.Now().UTC()

	recEarlier := core.NewRecord(dashboardsCol)
	recEarlier.Set("name", "shared")
	recEarlier.Set("revision", 2)
	recEarlier.Set("layout", `{"id":"shared","name":"Shared Early","layout":[]}`)
	recEarlier.SetRaw("created", now.Add(-10*time.Second).Format(time.RFC3339))
	if err := app.SaveNoValidate(recEarlier); err != nil {
		t.Fatalf("failed to seed recEarlier: %v", err)
	}

	recLater := core.NewRecord(dashboardsCol)
	recLater.Set("name", "shared")
	recLater.Set("revision", 2)
	recLater.Set("layout", `{"id":"shared","name":"Shared Later","layout":[]}`)
	recLater.SetRaw("created", now.Add(-2*time.Second).Format(time.RFC3339))
	if err := app.SaveNoValidate(recLater); err != nil {
		t.Fatalf("failed to seed recLater: %v", err)
	}

	if err := targetMigration.Up(app); err != nil {
		t.Fatalf("migration Up failed: %v", err)
	}

	all, _ := app.FindAllRecords("dashboards")
	sharedCount := 0
	var winner *core.Record
	for _, r := range all {
		if r.GetString("name") == "shared" {
			sharedCount++
			winner = r
		}
	}
	if sharedCount != 1 {
		t.Errorf("expected exactly 1 'shared' record, got %d", sharedCount)
	}
	if winner != nil && winner.Id != recLater.Id {
		t.Errorf("expected later-created record to win tiebreaker, got winner id=%s (want %s)", winner.Id, recLater.Id)
	}
}
