package modules_test

import (
	"context"
	"testing"

	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/modules"
)

func TestCatalog(t *testing.T) {
	cat := modules.ListCatalogModules()
	if len(cat) == 0 {
		t.Fatal("expected at least one catalog module")
	}

	mod, ok := modules.GetCatalogModule("customer_job_tracking")
	if !ok || mod == nil {
		t.Fatal("expected customer_job_tracking module in catalog")
	}

	if mod.Name != "Customer & Job Tracking" {
		t.Errorf("expected module name 'Customer & Job Tracking', got %q", mod.Name)
	}
	if len(mod.RequiredDatasets) != 2 {
		t.Errorf("expected 2 required datasets, got %d", len(mod.RequiredDatasets))
	}
}

func TestProvisionSuggestedDatasets_Idempotent(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()

	// Provision once
	mapping1, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("first provision failed: %v", err)
	}

	if mapping1.CustomerDataset != "customers" || mapping1.JobDataset != "jobs" {
		t.Errorf("unexpected mapping: %+v", mapping1)
	}

	custCol, err := app.FindCollectionByNameOrId("customers")
	if err != nil || custCol == nil {
		t.Fatal("customers collection should exist after provisioning")
	}

	jobCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection should exist after provisioning")
	}

	// Validate mapping passes
	if err := modules.ValidateModuleMapping(app, mapping1); err != nil {
		t.Fatalf("ValidateModuleMapping failed on provisioned mapping: %v", err)
	}

	// Provision again (should be idempotent without error)
	mapping2, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("second provision failed: %v", err)
	}
	if mapping2.CustomerDataset != mapping1.CustomerDataset {
		t.Errorf("mapping changed on second provision: %+v vs %+v", mapping1, mapping2)
	}
}

func TestValidateModuleMapping_Invalid(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	// Missing fields
	badMapping := modules.ModuleMapping{
		CustomerDataset: "nonexistent",
	}
	if err := modules.ValidateModuleMapping(app, badMapping); err == nil {
		t.Fatal("expected error for nonexistent dataset")
	}
}

func TestSaveAndGetInstalledModule(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	inst := &modules.WorkspaceModuleInstallation{
		ModuleID: "customer_job_tracking",
		Version:  "1.0.0",
		Enabled:  true,
		Mapping: modules.ModuleMapping{
			CustomerDataset:   "customers",
			CustomerNameField: "name",
			JobDataset:        "jobs",
			JobTitleField:     "title",
			JobCustomerField:  "customer",
			JobStatusField:    "status",
			JobAssigneeField:  "assignee",
		},
	}

	saved, err := modules.SaveModuleInstallation(app, inst)
	if err != nil {
		t.Fatalf("failed to save module installation: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("saved record should have ID")
	}

	loaded, err := modules.GetInstalledModule(app, "customer_job_tracking")
	if err != nil {
		t.Fatalf("failed to get installed module: %v", err)
	}
	if loaded == nil || !loaded.Enabled {
		t.Fatalf("expected loaded module to be enabled: %+v", loaded)
	}
	if loaded.Mapping.CustomerDataset != "customers" {
		t.Errorf("expected customer dataset customers, got %s", loaded.Mapping.CustomerDataset)
	}

	list, err := modules.ListInstalledModules(app)
	if err != nil {
		t.Fatalf("failed to list installed modules: %v", err)
	}
	if len(list) != 1 {
		t.Errorf("expected 1 installed module, got %d", len(list))
	}
}
