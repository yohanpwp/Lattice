package modules_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/modules"
	"github.com/Lattice/backend/internal/platform/schemas"
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

func TestRegisterCatalogModule_AppearsInListCatalogModules(t *testing.T) {
	// Base catalog check
	initialList := modules.ListCatalogModules()
	initialCount := len(initialList)

	// Create and register a new valid module contract
	customContract := modules.CustomerJobTrackingContract
	customContract.ModuleID = "equipment_inventory"
	customContract.Name = "Equipment Inventory"
	customContract.Version = "1.0.0"

	err := modules.RegisterCatalogModule(customContract)
	if err != nil {
		t.Fatalf("expected successful registration of valid contract: %v", err)
	}
	t.Cleanup(func() {
		delete(modules.Catalog, "equipment_inventory")
	})

	// Verify it can be retrieved by ID
	retrieved, ok := modules.GetCatalogModule("equipment_inventory")
	if !ok || retrieved == nil {
		t.Fatal("expected registered module to be retrieved by ID")
	}
	if retrieved.Name != "Equipment Inventory" {
		t.Fatalf("expected name 'Equipment Inventory', got %q", retrieved.Name)
	}

	// Verify it appears in ListCatalogModules()
	afterList := modules.ListCatalogModules()
	if len(afterList) != initialCount+1 {
		t.Fatalf("expected catalog list count to be %d, got %d", initialCount+1, len(afterList))
	}

	found := false
	for _, m := range afterList {
		if m.ModuleID == "equipment_inventory" {
			found = true
			if m.Name != "Equipment Inventory" {
				t.Fatalf("unexpected name in list: %q", m.Name)
			}
			break
		}
	}
	if !found {
		t.Fatal("expected registered module 'equipment_inventory' to appear in ListCatalogModules()")
	}
}

func TestValidateModuleContract(t *testing.T) {
	// 1. Valid contract from catalog
	mod, ok := modules.GetCatalogModule("customer_job_tracking")
	if !ok || mod == nil {
		t.Fatal("expected customer_job_tracking module in catalog")
	}
	if err := modules.ValidateModuleContract(*mod); err != nil {
		t.Fatalf("expected valid contract to pass validation: %v", err)
	}

	// 2. Malformed version format rejected by schema
	malformedMod := *mod
	malformedMod.Version = "v1.0-incompatible"
	if err := modules.ValidateModuleContract(malformedMod); err == nil {
		t.Fatal("expected error for malformed non-semver version")
	}

	// 3. Syntactically valid semver but incompatible version rejected by supported-version policy
	incompatMod := *mod
	incompatMod.Version = "2.0.0"
	if err := modules.ValidateModuleContract(incompatMod); err == nil || !errors.Is(err, modules.ErrIncompatibleModuleVersion) {
		t.Fatalf("expected ErrIncompatibleModuleVersion for syntactically valid version 2.0.0, got: %v", err)
	}

	// 4. Runtime boundary rejection when registering incompatible contract
	incompatRegMod := *mod
	incompatRegMod.ModuleID = "custom_module_v2"
	incompatRegMod.Version = "2.0.0"
	if err := modules.RegisterCatalogModule(incompatRegMod); err == nil || !errors.Is(err, modules.ErrIncompatibleModuleVersion) {
		t.Fatalf("expected RegisterCatalogModule to reject incompatible version 2.0.0 at runtime boundary, got: %v", err)
	}

	// 5. Missing requirement: empty required_datasets
	missingReqMod := *mod
	missingReqMod.RequiredDatasets = nil
	if err := modules.ValidateModuleContract(missingReqMod); err == nil {
		t.Fatal("expected error for missing required_datasets requirement")
	}

	// 6. Missing requirement: empty required_fields on dataset
	emptyFieldsMod := *mod
	emptyFieldsMod.RequiredDatasets = []modules.RequiredDatasetSpec{
		{
			DatasetRole:    "customers",
			Name:           "Customers",
			RequiredFields: []modules.RequiredFieldSpec{},
		},
	}
	if err := modules.ValidateModuleContract(emptyFieldsMod); err == nil {
		t.Fatal("expected error for empty required_fields requirement")
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

func TestProvisionSuggestedDatasets_RecoveryAfterPartialFailure(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()

	// Inject failure specifically when creating "jobs" collection
	var failJobsCreate = true
	app.OnCollectionCreate().BindFunc(func(e *core.CollectionEvent) error {
		if failJobsCreate && e.Collection != nil && e.Collection.Name == "jobs" {
			return errors.New("simulated disk error creating jobs")
		}
		return e.Next()
	})

	// 1. First provision attempt fails during jobs creation
	_, err = modules.ProvisionSuggestedDatasets(ctx, app)
	if err == nil {
		t.Fatal("expected ProvisionSuggestedDatasets to fail when jobs creation fails")
	}

	var provErr *modules.ProvisionError
	if !errors.As(err, &provErr) {
		t.Fatalf("expected *ProvisionError, got %T: %v", err, err)
	}
	if len(provErr.Created) != 1 || provErr.Created[0] != "customers" {
		t.Fatalf("expected Created to report ['customers'], got: %v", provErr.Created)
	}

	// Reported database state:
	// "customers" was created
	custCol, err := app.FindCollectionByNameOrId("customers")
	if err != nil || custCol == nil {
		t.Fatalf("expected customers collection to exist after partial provisioning: %v", err)
	}
	// "jobs" was NOT created
	jobCol, _ := app.FindCollectionByNameOrId("jobs")
	if jobCol != nil {
		t.Fatal("jobs collection should NOT exist after failure")
	}

	// 2. Resolve failure condition and retry
	failJobsCreate = false
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("retry ProvisionSuggestedDatasets failed: %v", err)
	}

	if mapping.CustomerDataset != "customers" || mapping.JobDataset != "jobs" {
		t.Fatalf("unexpected mapping after retry: %+v", mapping)
	}

	// Both collections exist cleanly without duplicate
	custCol2, err := app.FindCollectionByNameOrId("customers")
	if err != nil || custCol2 == nil {
		t.Fatalf("customers collection missing after retry: %v", err)
	}
	jobCol2, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobCol2 == nil {
		t.Fatalf("jobs collection missing after retry: %v", err)
	}

	if err := modules.ValidateModuleMapping(app, mapping); err != nil {
		t.Fatalf("ValidateModuleMapping failed after retry: %v", err)
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

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	// Incompatible type: status field with missing required status values
	jobsCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobsCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Change status field to have missing options
	statusField := jobsCol.Fields.GetByName("status")
	if sf, ok := statusField.(*core.SelectField); ok {
		sf.Values = []string{"Open"} // Missing "In progress" and "Done"
	}
	if err := app.Save(jobsCol); err != nil {
		t.Fatalf("failed to save jobs col: %v", err)
	}

	if err := modules.ValidateModuleMapping(app, mapping); err == nil {
		t.Fatal("expected error for status field missing required values")
	}

	// Assignee protection fails if job schema does not exist
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, "nonexistent_jobs", "assignee"); err == nil {
		t.Fatal("expected error when schema definition cannot be loaded")
	}
}

func TestValidateModuleMapping_MultiRelationAndExtraRequiredFields(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Multi-relation customer field should be rejected
	custRel := jobCol.Fields.GetByName("customer").(*core.RelationField)
	custRel.MaxSelect = 5
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.ValidateModuleMapping(app, mapping); err == nil {
		t.Fatal("expected error for multi-relation customer field")
	}
	custRel.MaxSelect = 1
	_ = app.Save(jobCol)

	// 2. Multi-select status field should be rejected
	statusF := jobCol.Fields.GetByName("status")
	if sf, ok := statusF.(*core.SelectField); ok {
		sf.MaxSelect = 2
		_ = app.Save(jobCol)
		if err := modules.ValidateModuleMapping(app, mapping); err == nil {
			t.Fatal("expected error for multi-select status field (MaxSelect > 1)")
		}
		sf.MaxSelect = 1
		_ = app.Save(jobCol)
	}

	// 3. Extra required field on job dataset should be rejected
	extraField := &core.TextField{Name: "priority", Required: true}
	jobCol.Fields.Add(extraField)
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.ValidateModuleMapping(app, mapping); err == nil {
		t.Fatal("expected error for unmapped required field on job dataset")
	}
}

func TestEnsureJobDatasetAssigneeProtection_PreservesRestrictiveRules(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Set restrictive owner-only rules and locked-down nil create rule
	ownerOnly := "@request.auth.role = 'owner'"
	jobCol.ListRule = &ownerOnly
	jobCol.ViewRule = &ownerOnly
	jobCol.CreateRule = nil
	jobCol.UpdateRule = &ownerOnly
	jobCol.DeleteRule = &ownerOnly
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// EnsureJobDatasetAssigneeProtection must NOT broaden access to members by overwriting owner-only or nil rules,
	// and must report an IncompatibleRulesError when rules block members from performing module operations.
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError when rules block members")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got %T: %v", err, err)
	}
	if incompErr.Dataset != mapping.JobDataset {
		t.Fatalf("expected dataset %q in error, got %q", mapping.JobDataset, incompErr.Dataset)
	}
	if len(incompErr.BlockedOps) == 0 {
		t.Fatal("expected blocked operations reported, got none")
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != ownerOnly {
		t.Fatalf("expected preserved owner-only list rule, got: %v", reloadedCol.ListRule)
	}
	if reloadedCol.ViewRule == nil || *reloadedCol.ViewRule != ownerOnly {
		t.Fatalf("expected preserved owner-only view rule, got: %v", reloadedCol.ViewRule)
	}
	if reloadedCol.CreateRule != nil {
		t.Fatalf("expected preserved nil create rule, got: %v", reloadedCol.CreateRule)
	}
	if reloadedCol.UpdateRule == nil || *reloadedCol.UpdateRule != ownerOnly {
		t.Fatalf("expected preserved owner-only update rule, got: %v", reloadedCol.UpdateRule)
	}
	if reloadedCol.DeleteRule == nil || *reloadedCol.DeleteRule != ownerOnly {
		t.Fatalf("expected preserved owner-only delete rule, got: %v", reloadedCol.DeleteRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_RepairsBroadRules(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	// Modify jobs collection to have broad/open rules (e.g. legacy/external modification)
	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}
	broadRule := "@request.auth.id != ''"
	jobCol.ListRule = &broadRule
	jobCol.ViewRule = &broadRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// Even though def.AssigneeField is already "assignee", EnsureJobDatasetAssigneeProtection
	// must detect the broad collection rules and repair them with assigned-scope protection.
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("EnsureJobDatasetAssigneeProtection failed: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	if reloadedCol.ListRule == nil || *reloadedCol.ListRule == broadRule {
		t.Fatalf("expected repaired list rule, got: %v", reloadedCol.ListRule)
	}
	if !strings.Contains(*reloadedCol.ListRule, "assignee = @request.auth.id") {
		t.Fatalf("expected repaired list rule to include assignee isolation: %s", *reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_ReconcilesCompoundOrRule(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Rule that contains an assignee check but also allows any authenticated user via OR
	compoundOr := "assignee = @request.auth.id || @request.auth.id != ''"
	jobCol.ListRule = &compoundOr
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("EnsureJobDatasetAssigneeProtection failed: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	// Must NOT remain as compoundOr alone; must be reconciled with expected assigned-scope rule
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule == compoundOr {
		t.Fatalf("compound OR rule was not reconciled with assigned-scope protection: %v", reloadedCol.ListRule)
	}
	if !strings.Contains(*reloadedCol.ListRule, "permissions.jobs.read") {
		t.Fatalf("expected rule to be reconciled with Lattice permission checks, got: %s", *reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_PreservesCustomStatusCondition(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Rule requiring authentication and status = 'Open'
	customStatus := "@request.auth.id != '' && status = 'Open'"
	jobCol.ListRule = &customStatus
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("EnsureJobDatasetAssigneeProtection failed: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	// Must preserve status = 'Open' AND enforce assigned-scope protection
	if reloadedCol.ListRule == nil {
		t.Fatal("expected non-nil list rule")
	}
	if !strings.Contains(*reloadedCol.ListRule, "status = 'Open'") {
		t.Fatalf("expected custom status = 'Open' restriction to be preserved, got: %s", *reloadedCol.ListRule)
	}
	if !strings.Contains(*reloadedCol.ListRule, "assignee = @request.auth.id") {
		t.Fatalf("expected assigned-scope protection in reconciled rule, got: %s", *reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_AtomicAssigneeChange(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		t.Fatal("users collection not found")
	}

	// Add new assignee field "user_id"
	jobCol.Fields.Add(&core.RelationField{
		Name:         "user_id",
		CollectionId: usersCol.Id,
		MaxSelect:    1,
	})
	customRule := "status = 'Open'"
	jobCol.ListRule = &customRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// Update assignee field to "user_id" - should update schema_definitions and rules atomically
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, "user_id"); err != nil {
		t.Fatalf("EnsureJobDatasetAssigneeProtection failed: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	// Verify rule updated with user_id AND preserved status = 'Open'
	if reloadedCol.ListRule == nil || !strings.Contains(*reloadedCol.ListRule, "user_id = @request.auth.id") {
		t.Fatalf("expected rule to use user_id, got: %v", reloadedCol.ListRule)
	}
	if !strings.Contains(*reloadedCol.ListRule, "status = 'Open'") {
		t.Fatalf("expected status = 'Open' preserved, got: %v", reloadedCol.ListRule)
	}

	// Verify schema definition record updated
	schemaRec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": mapping.JobDataset})
	if err != nil || schemaRec == nil {
		t.Fatal("schema_definitions record not found")
	}
	if schemaRec.GetString("assignee_field") != "user_id" {
		t.Fatalf("expected assignee_field user_id in schema_definitions, got: %s", schemaRec.GetString("assignee_field"))
	}
}

func TestEnsureJobDatasetAssigneeProtection_GeneratedRuleWithAppendedCondition(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Start with generated rule and append a custom condition
	expList, _, _, _, _ := schemas.BuildCollectionRules(mapping.JobDataset, mapping.JobAssigneeField)
	ruleWithAppended := fmt.Sprintf("%s && status = 'Open'", *expList)
	jobCol.ListRule = &ruleWithAppended
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("EnsureJobDatasetAssigneeProtection failed: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}

	// Must NOT be replaced wholesale with bare expList; status = 'Open' must be preserved
	if reloadedCol.ListRule == nil {
		t.Fatal("expected non-nil list rule")
	}
	if !strings.Contains(*reloadedCol.ListRule, "status = 'Open'") {
		t.Fatalf("expected appended condition status = 'Open' to be preserved, got: %s", *reloadedCol.ListRule)
	}
	if !strings.Contains(*reloadedCol.ListRule, "assignee = @request.auth.id") {
		t.Fatalf("expected assigned-scope protection in rule, got: %s", *reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_TransactionRollback(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		t.Fatal("users collection not found")
	}

	// Add new assignee relation field "user_id"
	jobCol.Fields.Add(&core.RelationField{
		Name:         "user_id",
		CollectionId: usersCol.Id,
		MaxSelect:    1,
	})
	initialRule := "status = 'Open'"
	jobCol.ListRule = &initialRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// Verify initial assignee_field in schema_definitions is "assignee"
	schemaRec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": mapping.JobDataset})
	if err != nil || schemaRec == nil {
		t.Fatal("schema definition not found")
	}
	if schemaRec.GetString("assignee_field") != "assignee" {
		t.Fatalf("expected initial assignee_field 'assignee', got %s", schemaRec.GetString("assignee_field"))
	}

	// Intercept and fail record updates on schema_definitions inside the transaction
	app.OnRecordUpdate("schema_definitions").BindFunc(func(e *core.RecordEvent) error {
		return errors.New("simulated metadata update failure")
	})

	// Attempt to change assignee field to "user_id". The transaction should fail and roll back.
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, "user_id")
	if err == nil {
		t.Fatal("expected EnsureJobDatasetAssigneeProtection to fail when transaction fails")
	}

	// Reload collection and schema_definitions to verify complete rollback
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != initialRule {
		t.Fatalf("expected ListRule to roll back to initial rule %q, got: %v", initialRule, reloadedCol.ListRule)
	}

	reloadedSchema, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": mapping.JobDataset})
	if err != nil || reloadedSchema == nil {
		t.Fatal("failed to reload schema definition")
	}
	if reloadedSchema.GetString("assignee_field") != "assignee" {
		t.Fatalf("expected assignee_field to roll back to 'assignee', got: %s", reloadedSchema.GetString("assignee_field"))
	}
}

func TestEnsureJobDatasetAssigneeProtection_RemapAssigneeCustomRuleConflict(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		t.Fatal("users collection not found")
	}

	// Add new assignee relation field "user_id"
	jobCol.Fields.Add(&core.RelationField{
		Name:         "user_id",
		CollectionId: usersCol.Id,
		MaxSelect:    1,
	})

	// Rule contains a custom condition alongside the old assignee field
	customWithOldAssignee := "assignee = @request.auth.id && status = 'Open'"
	jobCol.ListRule = &customWithOldAssignee
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// Remapping assignee from "assignee" to "user_id" must be rejected because custom rule references "assignee"
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, "user_id")
	if err == nil {
		t.Fatal("expected remapping conflict error when custom rule references old assignee")
	}
	if !strings.Contains(err.Error(), "cannot remap assignee field from \"assignee\" to \"user_id\"") ||
		!strings.Contains(err.Error(), "contains custom restrictions referencing \"assignee\"") {
		t.Fatalf("unexpected error message: %v", err)
	}

	// Verify collection and schema definition were not modified
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != customWithOldAssignee {
		t.Fatalf("expected rule to remain unchanged, got: %v", reloadedCol.ListRule)
	}

	schemaRec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": mapping.JobDataset})
	if err != nil || schemaRec == nil {
		t.Fatal("failed to reload schema definition")
	}
	if schemaRec.GetString("assignee_field") != "assignee" {
		t.Fatalf("expected assignee_field to remain 'assignee', got: %s", schemaRec.GetString("assignee_field"))
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

func TestEnsureJobDatasetAssigneeProtection_ParenthesizedOwnerRuleDetected(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Set an owner-only rule wrapped in parentheses: should NOT pass setup or be combined with generated rule
	parenthesizedOwner := "(@request.auth.role = 'owner')"
	jobCol.ListRule = &parenthesizedOwner
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for parenthesized owner-only rule")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	if incompErr.Dataset != mapping.JobDataset {
		t.Fatalf("expected dataset %q, got: %q", mapping.JobDataset, incompErr.Dataset)
	}
	foundList := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "restricted to owners/admins") {
			foundList = true
			break
		}
	}
	if !foundList {
		t.Fatalf("expected blocked ops to include list restriction, got: %v", incompErr.BlockedOps)
	}

	// Verify original collection rule was preserved unchanged on disk (not combined with Lattice rule)
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != parenthesizedOwner {
		t.Fatalf("expected ListRule to remain exactly %q, got: %v", parenthesizedOwner, reloadedCol.ListRule)
	}
}

func TestValidateCustomerDatasetAccess_LockedOrOwnerOnlyRules(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	custCol, err := app.FindCollectionByNameOrId(mapping.CustomerDataset)
	if err != nil || custCol == nil {
		t.Fatal("customers collection not found")
	}

	// 1. Default provisioned customer collection should pass validation
	if err := modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset); err != nil {
		t.Fatalf("expected valid provisioned customer collection to pass, got: %v", err)
	}

	// 2. Parenthesized owner-only list rule should fail validation
	parenthesizedOwner := "(@request.auth.role = 'owner')"
	custCol.ListRule = &parenthesizedOwner
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}

	err = modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for owner-only customer list rule")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	if incompErr.Dataset != mapping.CustomerDataset {
		t.Fatalf("expected dataset %q, got: %q", mapping.CustomerDataset, incompErr.Dataset)
	}
	foundList := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "restricted to owners/admins") {
			foundList = true
			break
		}
	}
	if !foundList {
		t.Fatalf("expected blocked ops to include list restriction, got: %v", incompErr.BlockedOps)
	}

	// 3. Locked create rule (nil) should fail validation
	openRule := "@request.auth.id != ''"
	custCol.ListRule = &openRule
	custCol.CreateRule = nil
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}

	err = modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for locked customer create rule")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundCreate := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "create") && strings.Contains(op, "locked") {
			foundCreate = true
			break
		}
	}
	if !foundCreate {
		t.Fatalf("expected blocked ops to include create lock, got: %v", incompErr.BlockedOps)
	}

	// 4. Customer rules comparing field to false should pass validation
	custCol.Fields.Add(&core.BoolField{
		Name: "archived",
	})
	archivedRule := "archived = false"
	custCol.ListRule = &archivedRule
	custCol.CreateRule = &openRule
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset); err != nil {
		t.Fatalf("expected customer rule with archived = false to pass, got: %v", err)
	}

	disabledRule := "@request.auth.disabled = false"
	custCol.ListRule = &disabledRule
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset); err != nil {
		t.Fatalf("expected customer rule with @request.auth.disabled = false to pass, got: %v", err)
	}

	// 5. Customer rule with conflicting permission condition should fail validation
	conflictingCustRule := "@request.auth.permissions.customers.read = false"
	custCol.ListRule = &conflictingCustRule
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	err = modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for customer collection with conflicting permission rule")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundConflict := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "conflicting permission condition") {
			foundConflict = true
			break
		}
	}
	if !foundConflict {
		t.Fatalf("expected customer blocked ops to report conflicting permission condition, got: %v", incompErr.BlockedOps)
	}
}

func TestEnsureJobDatasetAssigneeProtection_GeneratedRuleWithAppendedOwnerCondition(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Generated rule followed by && @request.auth.role = 'owner' blocks members despite containing 'member'
	expList, _, _, _, _ := schemas.BuildCollectionRules(mapping.JobDataset, mapping.JobAssigneeField)
	ruleWithAppendedOwner := fmt.Sprintf("%s && @request.auth.role = 'owner'", *expList)
	jobCol.ListRule = &ruleWithAppendedOwner
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for generated rule with appended owner condition")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	if incompErr.Dataset != mapping.JobDataset {
		t.Fatalf("expected dataset %q, got: %q", mapping.JobDataset, incompErr.Dataset)
	}
	foundList := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "restricted to owners/admins") {
			foundList = true
			break
		}
	}
	if !foundList {
		t.Fatalf("expected blocked ops to include list restriction, got: %v", incompErr.BlockedOps)
	}

	// Verify original collection rule was preserved unchanged on disk
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != ruleWithAppendedOwner {
		t.Fatalf("expected ListRule to remain %q, got: %v", ruleWithAppendedOwner, reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_BooleanStructureAllowsMembers(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Rule contains @request.auth.role != 'member' but also an || branch allowing members
	disjunctiveRule := "@request.auth.role != 'member' || @request.auth.role = 'member'"
	jobCol.ListRule = &disjunctiveRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	// Boolean structure allows members, so setup must succeed and reconcile rule
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected rule to pass setup due to boolean structure allowing members, got: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil {
		t.Fatal("expected non-nil ListRule")
	}
	if !strings.Contains(*reloadedCol.ListRule, "permissions.jobs.read") {
		t.Fatalf("expected reconciled rule with assigned protection, got: %s", *reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_UnknownCustomExpressionReported(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// Custom expression with unknown attribute whose compatibility cannot be established
	unknownRule := "@request.auth.department = 'Engineering'"
	jobCol.ListRule = &unknownRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for unknown custom expression")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundUnknown := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "unknown compatibility") {
			foundUnknown = true
			break
		}
	}
	if !foundUnknown {
		t.Fatalf("expected blocked ops to report unknown compatibility, got: %v", incompErr.BlockedOps)
	}
}

func TestEnsureJobDatasetAssigneeProtection_FalseEqualityWithFieldAllowsMembers(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Rule comparing a data field to false: archived = false
	jobCol.Fields.Add(&core.BoolField{
		Name: "archived",
	})
	archivedFalseRule := "archived = false"
	jobCol.ListRule = &archivedFalseRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected archived = false to allow members and pass setup, got: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || !strings.Contains(*reloadedCol.ListRule, "archived = false") {
		t.Fatalf("expected reconciled rule to preserve archived = false, got: %v", reloadedCol.ListRule)
	}

	// 2. Rule comparing auth disabled to false: @request.auth.disabled = false
	disabledFalseRule := "@request.auth.disabled = false"
	jobCol.ListRule = &disabledFalseRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected @request.auth.disabled = false to allow members and pass setup, got: %v", err)
	}

	reloadedCol, err = app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || !strings.Contains(*reloadedCol.ListRule, "@request.auth.disabled = false") {
		t.Fatalf("expected reconciled rule to preserve @request.auth.disabled = false, got: %v", reloadedCol.ListRule)
	}
}

func TestEnsureJobDatasetAssigneeProtection_ConflictingPermissionRule(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Conflicting permission rule: @request.auth.permissions.jobs.read = false
	conflictingRule := "@request.auth.permissions.jobs.read = false"
	jobCol.ListRule = &conflictingRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for conflicting permission rule")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	if incompErr.Dataset != mapping.JobDataset {
		t.Fatalf("expected dataset %q, got: %q", mapping.JobDataset, incompErr.Dataset)
	}
	foundConflict := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "conflicting permission condition") {
			foundConflict = true
			break
		}
	}
	if !foundConflict {
		t.Fatalf("expected blocked ops to report conflicting permission condition, got: %v", incompErr.BlockedOps)
	}

	// Verify original collection rule was preserved unchanged on disk
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != conflictingRule {
		t.Fatalf("expected ListRule to remain %q, got: %v", conflictingRule, reloadedCol.ListRule)
	}

	// 2. Conflicting permission inequality: @request.auth.permissions.jobs.read != true
	conflictingIneq := "@request.auth.permissions.jobs.read != true"
	jobCol.ListRule = &conflictingIneq
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for conflicting permission inequality")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}

	// 3. Compatible permission rule: @request.auth.permissions.jobs.read = true
	compatibleRule := "@request.auth.permissions.jobs.read = true"
	jobCol.ListRule = &compatibleRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected compatible permission rule to pass setup, got: %v", err)
	}
}

func TestEnsureJobDatasetAssigneeProtection_UnrelatedPermissionAllowed(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Jobs list rule requiring unrelated operation permission to be false:
	// @request.auth.permissions.jobs.update = false can coexist with the generated list rule requiring jobs.read = true
	unrelatedOpRule := "@request.auth.permissions.jobs.update = false"
	jobCol.ListRule = &unrelatedOpRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected jobs list rule with unrelated operation permission to pass setup, got: %v", err)
	}

	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || !strings.Contains(*reloadedCol.ListRule, unrelatedOpRule) {
		t.Fatalf("expected reconciled ListRule to preserve %q, got: %v", unrelatedOpRule, reloadedCol.ListRule)
	}

	// 2. Jobs list rule requiring unrelated dataset permission:
	// @request.auth.permissions.customers.create = false
	unrelatedDatasetRule := "@request.auth.permissions.customers.create = false"
	jobCol.ListRule = &unrelatedDatasetRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected jobs list rule with unrelated dataset permission to pass setup, got: %v", err)
	}

	// 3. Same permission check on its own operation:
	// When update rule requires @request.auth.permissions.jobs.update = false, it conflicts with update = true
	jobCol.UpdateRule = &unrelatedOpRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError when update rule has conflicting update permission")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundUpdateConflict := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "update") && strings.Contains(op, "conflicting permission condition") {
			foundUpdateConflict = true
			break
		}
	}
	if !foundUpdateConflict {
		t.Fatalf("expected blocked ops to report update conflict, got: %v", incompErr.BlockedOps)
	}

	// 4. Customer dataset list rule requiring unrelated operation permission:
	// @request.auth.permissions.customers.create = false can coexist with customers.read = true
	custCol, err := app.FindCollectionByNameOrId(mapping.CustomerDataset)
	if err != nil || custCol == nil {
		t.Fatal("customers collection not found")
	}
	custUnrelatedRule := "@request.auth.permissions.customers.create = false"
	custCol.ListRule = &custUnrelatedRule
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset); err != nil {
		t.Fatalf("expected customer list rule with unrelated create permission to pass, got: %v", err)
	}
}

func TestEnsureJobDatasetAssigneeProtection_ContradictoryConditionsInAndBranch(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Contradictory custom permission conditions across && branch:
	// @request.auth.permissions.jobs.update = true && @request.auth.permissions.jobs.update = false
	contradictoryRule := "@request.auth.permissions.jobs.update = true && @request.auth.permissions.jobs.update = false"
	jobCol.ListRule = &contradictoryRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for contradictory permission conditions across && branch")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundConflict := false
	for _, op := range incompErr.BlockedOps {
		if strings.HasPrefix(op, "list") && strings.Contains(op, "conflicting permission condition") {
			foundConflict = true
			break
		}
	}
	if !foundConflict {
		t.Fatalf("expected blocked ops to report conflicting permission condition, got: %v", incompErr.BlockedOps)
	}

	// Verify original collection rule was preserved unchanged on disk
	reloadedCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || reloadedCol == nil {
		t.Fatal("failed to reload jobs collection")
	}
	if reloadedCol.ListRule == nil || *reloadedCol.ListRule != contradictoryRule {
		t.Fatalf("expected ListRule to remain %q, got: %v", contradictoryRule, reloadedCol.ListRule)
	}

	// 2. Parenthesized contradictory conditions:
	// (@request.auth.permissions.jobs.update = true) && (@request.auth.permissions.jobs.update = false)
	parenRule := "(@request.auth.permissions.jobs.update = true) && (@request.auth.permissions.jobs.update = false)"
	jobCol.ListRule = &parenRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for parenthesized contradictory permission conditions")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}

	// 3. Contradictory scope conditions across && branch:
	// @request.auth.permissions.jobs.scope = 'all' && @request.auth.permissions.jobs.scope = 'assigned'
	scopeConflictRule := "@request.auth.permissions.jobs.scope = 'all' && @request.auth.permissions.jobs.scope = 'assigned'"
	jobCol.ListRule = &scopeConflictRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for conflicting scope conditions")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}

	// 4. Equality contradicts inequality across && branch:
	// @request.auth.permissions.jobs.update = true && @request.auth.permissions.jobs.update != true
	ineqConflictRule := "@request.auth.permissions.jobs.update = true && @request.auth.permissions.jobs.update != true"
	jobCol.ListRule = &ineqConflictRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for equality contradicting inequality")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}

	// 5. Customer collection with contradictory conditions in list rule
	custCol, err := app.FindCollectionByNameOrId(mapping.CustomerDataset)
	if err != nil || custCol == nil {
		t.Fatal("customers collection not found")
	}
	custContradictoryRule := "@request.auth.permissions.customers.update = true && @request.auth.permissions.customers.update = false"
	custCol.ListRule = &custContradictoryRule
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	err = modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for customer collection with contradictory permission rule")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}

	// 6. Distinct compatible conditions on different permissions should succeed:
	// @request.auth.permissions.jobs.update = true && @request.auth.permissions.customers.create = false
	compatibleRule := "@request.auth.permissions.jobs.update = true && @request.auth.permissions.customers.create = false"
	jobCol.ListRule = &compatibleRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected distinct permission conditions across && branch to pass setup, got: %v", err)
	}
}

func TestEnsureJobDatasetAssigneeProtection_NestedOrGroupContradiction(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	ctx := context.Background()
	mapping, err := modules.ProvisionSuggestedDatasets(ctx, app)
	if err != nil {
		t.Fatalf("provision failed: %v", err)
	}

	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 1. Contradictory nested || group with outer && terms:
	// (jobs.update = true || jobs.create = true) && jobs.update = false && jobs.create = false
	// Neither alternative in the || group can be satisfied because outer && requires both to be false.
	nestedConflictRule := "(@request.auth.permissions.jobs.update = true || @request.auth.permissions.jobs.create = true) && @request.auth.permissions.jobs.update = false && @request.auth.permissions.jobs.create = false"
	jobCol.ListRule = &nestedConflictRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}

	err = modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for nested || group where all alternatives contradict outer && terms")
	}
	var incompErr *modules.IncompatibleRulesError
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
	foundConflict := false
	for _, op := range incompErr.BlockedOps {
		if strings.Contains(op, "list") && strings.Contains(op, "conflicting permission condition") {
			foundConflict = true
			break
		}
	}
	if !foundConflict {
		t.Fatalf("expected blocked ops to mention list conflicting permission condition, got: %v", incompErr.BlockedOps)
	}

	// 2. Compatible variation where one alternative of the || group remains satisfiable:
	// (jobs.update = true || jobs.create = true) && jobs.update = false
	// The jobs.create = true alternative survives outer conjunction with jobs.update = false.
	nestedCompatibleRule := "(@request.auth.permissions.jobs.update = true || @request.auth.permissions.jobs.create = true) && @request.auth.permissions.jobs.update = false"
	jobCol.ListRule = &nestedCompatibleRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected surviving alternative in nested || group to pass setup, got: %v", err)
	}

	// 3. Nested contradiction inside an || branch where a sibling || branch allows members:
	// ((jobs.update = true || jobs.create = true) && jobs.update = false && jobs.create = false) || jobs.delete = true
	// The right || branch allows members who have jobs.delete = true.
	siblingOrRule := "((@request.auth.permissions.jobs.update = true || @request.auth.permissions.jobs.create = true) && @request.auth.permissions.jobs.update = false && @request.auth.permissions.jobs.create = false) || @request.auth.permissions.jobs.delete = true"
	jobCol.ListRule = &siblingOrRule
	if err := app.Save(jobCol); err != nil {
		t.Fatal(err)
	}
	if err := modules.EnsureJobDatasetAssigneeProtection(ctx, app, mapping.JobDataset, mapping.JobAssigneeField); err != nil {
		t.Fatalf("expected sibling || branch to allow members and pass setup, got: %v", err)
	}

	// 4. Customer dataset validation with nested || contradiction:
	custCol, err := app.FindCollectionByNameOrId(mapping.CustomerDataset)
	if err != nil || custCol == nil {
		t.Fatal("customers collection not found")
	}
	custNestedConflict := "(@request.auth.permissions.customers.update = true || @request.auth.permissions.customers.create = true) && @request.auth.permissions.customers.update = false && @request.auth.permissions.customers.create = false"
	custCol.ListRule = &custNestedConflict
	if err := app.Save(custCol); err != nil {
		t.Fatal(err)
	}
	err = modules.ValidateCustomerDatasetAccess(ctx, app, mapping.CustomerDataset)
	if err == nil {
		t.Fatal("expected IncompatibleRulesError for customer collection with nested || group contradiction")
	}
	if !errors.As(err, &incompErr) {
		t.Fatalf("expected IncompatibleRulesError, got: %v", err)
	}
}
