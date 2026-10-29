package schemas_test

import (
	"context"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/authz"
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

func TestAssigneeFieldValidation(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Non-existent assignee field
	_, err = svc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID:      "bad_assignee_1",
		Name:          "Bad Assignee 1",
		AssigneeField: "non_existent",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
		},
	})
	if err == nil {
		t.Fatal("expected error when assignee_field does not exist in fields, got nil")
	}

	// 2. Assignee field is not a relation (e.g. number)
	_, err = svc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID:      "bad_assignee_2",
		Name:          "Bad Assignee 2",
		AssigneeField: "amount",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "amount", Type: "number", Required: true},
		},
	})
	if err == nil {
		t.Fatal("expected error when assignee_field is not a relation, got nil")
	}

	// 3. Assignee field is a relation but does not target "users"
	_, err = svc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID:      "bad_assignee_3",
		Name:          "Bad Assignee 3",
		AssigneeField: "customer_id",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "customer_id", Type: "relation", Target: "customers"},
		},
	})
	if err == nil {
		t.Fatal("expected error when assignee_field targets collection other than users, got nil")
	}

	// 4. Valid assignee field targeting users
	valid, err := svc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID:      "valid_assignee",
		Name:          "Valid Assignee",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
		},
	})
	if err != nil || valid == nil {
		t.Fatalf("expected valid assignee schema to succeed, got error: %v", err)
	}
	if valid.AssigneeField != "assignee" {
		t.Fatalf("expected assignee_field to be 'assignee', got %q", valid.AssigneeField)
	}
}

func TestTwoDatasetsCRUDAndRelationshipValidationAndRecovery(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create Dataset 1: customers
	custDef := schemas.SchemaDefinition{
		SchemaID: "customers",
		Name:     "ลูกค้า (Customers)",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Label: "Customer Name", Type: "text", Required: true},
			{Name: "email", Label: "Email", Type: "email", Required: false},
			{Name: "phone", Label: "Phone", Type: "text", Required: false},
		},
	}
	createdCust, err := svc.CreateSchema(ctx, custDef)
	if err != nil {
		t.Fatalf("failed to create customers dataset: %v", err)
	}
	if createdCust.SchemaID != "customers" {
		t.Fatalf("expected customers schema, got: %v", createdCust)
	}

	// 2. Create Dataset 2: jobs (with relation to customers and assignee pointing to users)
	jobDef := schemas.SchemaDefinition{
		SchemaID:      "jobs",
		Name:          "งานบริการ (Jobs)",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Label: "Job Title", Type: "text", Required: true},
			{Name: "status", Label: "Status", Type: "select", Required: true, Options: []string{"pending", "in_progress", "completed"}},
			{Name: "customer", Label: "Customer", Type: "relation", Target: "customers", Required: true},
			{Name: "assignee", Label: "Assignee", Type: "relation", Target: "users", Required: false},
		},
	}
	createdJob, err := svc.CreateSchema(ctx, jobDef)
	if err != nil {
		t.Fatalf("failed to create jobs dataset: %v", err)
	}
	if createdJob.SchemaID != "jobs" || createdJob.AssigneeField != "assignee" {
		t.Fatalf("expected jobs schema with assignee_field, got: %v", createdJob)
	}

	custCol, err := app.FindCollectionByNameOrId("customers")
	if err != nil || custCol == nil {
		t.Fatal("customers collection not found")
	}
	jobsCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobsCol == nil {
		t.Fatal("jobs collection not found")
	}

	// 3. Customer CRUD operations
	// Create customer C1
	c1 := core.NewRecord(custCol)
	c1.Set("name", "Acme Industries")
	c1.Set("email", "info@acme.com")
	c1.Set("phone", "555-0100")
	if err := app.Save(c1); err != nil {
		t.Fatalf("failed to create customer C1: %v", err)
	}
	if c1.Id == "" {
		t.Fatal("expected C1 to have generated ID")
	}

	// Read customer C1
	readC1, err := app.FindRecordById("customers", c1.Id)
	if err != nil || readC1 == nil {
		t.Fatalf("failed to read customer C1: %v", err)
	}
	if readC1.GetString("name") != "Acme Industries" {
		t.Fatalf("expected Acme Industries, got %q", readC1.GetString("name"))
	}

	// Update customer C1
	readC1.Set("phone", "555-0199")
	if err := app.Save(readC1); err != nil {
		t.Fatalf("failed to update customer C1: %v", err)
	}
	updatedC1, _ := app.FindRecordById("customers", c1.Id)
	if updatedC1.GetString("phone") != "555-0199" {
		t.Fatalf("expected updated phone 555-0199, got %q", updatedC1.GetString("phone"))
	}

	// 4. Relationship Validation: Create job with invalid customer ID
	invalidJob := core.NewRecord(jobsCol)
	invalidJob.Set("title", "Broken Job")
	invalidJob.Set("status", "pending")
	invalidJob.Set("customer", "non_existent_customer_id")
	err = app.Save(invalidJob)
	if err == nil {
		t.Fatal("security violation: expected relation validation error on non-existent customer, got nil")
	}

	// 5. Failure Recovery: Client catches relation failure, recovers by providing valid C1 ID
	recoveryJob := invalidJob
	recoveryJob.Set("customer", c1.Id)
	if err := app.Save(recoveryJob); err != nil {
		t.Fatalf("failed to save job after relationship failure recovery: %v", err)
	}
	if recoveryJob.Id == "" {
		t.Fatal("expected recoveryJob to have valid ID after recovery")
	}

	// 6. Read Job and verify relation
	readJob, err := app.FindRecordById("jobs", recoveryJob.Id)
	if err != nil || readJob == nil {
		t.Fatalf("failed to read job: %v", err)
	}
	if readJob.GetString("customer") != c1.Id {
		t.Fatalf("expected customer %q, got %q", c1.Id, readJob.GetString("customer"))
	}

	// 7. Update Job
	readJob.Set("status", "in_progress")
	if err := app.Save(readJob); err != nil {
		t.Fatalf("failed to update job status: %v", err)
	}
	updatedJob, _ := app.FindRecordById("jobs", readJob.Id)
	if updatedJob.GetString("status") != "in_progress" {
		t.Fatalf("expected status in_progress, got %q", updatedJob.GetString("status"))
	}

	// 8. Relationship validation on update: attempting to change customer to an invalid relation ID
	updatedJob.Set("customer", "bad_relation_id_on_update")
	err = app.Save(updatedJob)
	if err == nil {
		t.Fatal("expected relation validation error when updating customer to invalid ID, got nil")
	}

	// 9. Recover from update error by restoring valid customer ID
	updatedJob.Set("customer", c1.Id)
	if err := app.Save(updatedJob); err != nil {
		t.Fatalf("failed to save job after update error recovery: %v", err)
	}

	// 10. Delete Job and verify customer remains intact
	if err := app.Delete(updatedJob); err != nil {
		t.Fatalf("failed to delete job: %v", err)
	}
	deletedJobCheck, _ := app.FindRecordById("jobs", updatedJob.Id)
	if deletedJobCheck != nil {
		t.Fatal("expected job to be deleted")
	}
	customerAfterJobDelete, _ := app.FindRecordById("customers", c1.Id)
	if customerAfterJobDelete == nil {
		t.Fatal("expected customer C1 to remain intact after job deletion")
	}
}

func TestSchemaAutodateFieldsAndUpdates(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create a schema and verify autodate fields are present on the PocketBase collection
	tasksDef := schemas.SchemaDefinition{
		SchemaID: "tasks",
		Name:     "Tasks",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
		},
	}
	created, err := svc.CreateSchema(ctx, tasksDef)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	col, err := app.FindCollectionByNameOrId("tasks")
	if err != nil || col == nil {
		t.Fatalf("expected tasks collection to exist: %v", err)
	}

	createdField := col.Fields.GetByName("created")
	if createdField == nil {
		t.Fatal("expected 'created' autodate field to be present on new collection")
	}
	if createdField.Type() != "autodate" {
		t.Fatalf("expected 'created' field type to be autodate, got %s", createdField.Type())
	}

	updatedField := col.Fields.GetByName("updated")
	if updatedField == nil {
		t.Fatal("expected 'updated' autodate field to be present on new collection")
	}
	if updatedField.Type() != "autodate" {
		t.Fatalf("expected 'updated' field type to be autodate, got %s", updatedField.Type())
	}

	// 2. Safe UpdateSchema: add an optional field
	updateDef := *created
	updateDef.Fields = append(updateDef.Fields, schemas.FieldDefinition{
		Name:     "description",
		Label:    "Task Description",
		Type:     "text",
		Required: false,
	})
	updatedSchema, err := svc.UpdateSchema(ctx, "tasks", updateDef)
	if err != nil {
		t.Fatalf("failed to safely update schema with new optional field: %v", err)
	}
	if len(updatedSchema.Fields) < 2 {
		t.Fatalf("expected at least 2 fields after schema update, got %d", len(updatedSchema.Fields))
	}

	// Verify collection also has the new field
	colUpdated, err := app.FindCollectionByNameOrId("tasks")
	if err != nil || colUpdated.Fields.GetByName("description") == nil {
		t.Fatal("expected collection 'tasks' to have field 'description' added")
	}

	// 3. Reject destructive update: deleting existing field "title"
	destructiveDelete := *updatedSchema
	destructiveDelete.Fields = []schemas.FieldDefinition{
		{Name: "description", Type: "text", Required: false},
	}
	_, err = svc.UpdateSchema(ctx, "tasks", destructiveDelete)
	if err == nil {
		t.Fatal("expected destructive field deletion to be rejected, got nil")
	}

	// 4. Reject destructive update: changing field type of "title" from text to number
	destructiveTypeChange := *updatedSchema
	destructiveTypeChange.Fields = []schemas.FieldDefinition{
		{Name: "title", Type: "number", Required: true},
		{Name: "description", Type: "text", Required: false},
	}
	_, err = svc.UpdateSchema(ctx, "tasks", destructiveTypeChange)
	if err == nil {
		t.Fatal("expected destructive field type change to be rejected, got nil")
	}

	// 5. Reject adding a new required field
	requiredNewField := *updatedSchema
	requiredNewField.Fields = append(requiredNewField.Fields, schemas.FieldDefinition{
		Name:     "priority",
		Type:     "text",
		Required: true,
	})
	_, err = svc.UpdateSchema(ctx, "tasks", requiredNewField)
	if err == nil {
		t.Fatal("expected adding new required field without default to be rejected, got nil")
	}
}

func TestSchemaCreationAtomicity(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// Definition with an invalid field name
	badDef := schemas.SchemaDefinition{
		SchemaID: "atomic_test",
		Name:     "Atomic Test",
		Fields: []schemas.FieldDefinition{
			{Name: "valid_field", Type: "text"},
			{Name: "INVALID-FIELD!", Type: "text"},
		},
	}
	_, err = svc.CreateSchema(ctx, badDef)
	if err == nil {
		t.Fatal("expected error creating schema with invalid field name, got nil")
	}

	// Verify no partial collection exists
	col, _ := app.FindCollectionByNameOrId("atomic_test")
	if col != nil {
		t.Fatal("expected collection 'atomic_test' not to exist after failed creation")
	}

	// Verify no partial schema_definitions record exists
	rec, _ := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": "atomic_test"})
	if rec != nil {
		t.Fatal("expected schema_definitions record for 'atomic_test' not to exist after failed creation")
	}
}

func TestCustomersJobsAssignedMemberWorkflow(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	authz.RegisterAuthnHooks(app)
	schemas.RegisterSyncHooks(app)
	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create Customers dataset
	custDef := schemas.SchemaDefinition{
		SchemaID: "customers",
		Name:     "Customers",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Label: "Customer Name", Type: "text", Required: true},
			{Name: "email", Label: "Email", Type: "email", Required: false},
		},
	}
	if _, err := svc.CreateSchema(ctx, custDef); err != nil {
		t.Fatalf("failed to create customers schema: %v", err)
	}

	// 2. Create Jobs dataset with customer relation and REQUIRED assignee relation
	jobDef := schemas.SchemaDefinition{
		SchemaID:      "jobs",
		Name:          "Jobs",
		AssigneeField: "assigned_user",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Label: "Job Title", Type: "text", Required: true},
			{Name: "customer", Label: "Customer", Type: "relation", Target: "customers", Required: true},
			{Name: "assigned_user", Label: "Assigned User", Type: "relation", Target: "users", Required: true},
		},
	}
	if _, err := svc.CreateSchema(ctx, jobDef); err != nil {
		t.Fatalf("failed to create jobs schema: %v", err)
	}

	// 3. Add two distinct customer records
	custCol, _ := app.FindCollectionByNameOrId("customers")
	c1 := core.NewRecord(custCol)
	c1.Set("name", "Alpha Corp")
	c1.Set("email", "alpha@example.com")
	if err := app.Save(c1); err != nil {
		t.Fatalf("failed to save customer 1: %v", err)
	}

	c2 := core.NewRecord(custCol)
	c2.Set("name", "Beta LLC")
	c2.Set("email", "beta@example.com")
	if err := app.Save(c2); err != nil {
		t.Fatalf("failed to save customer 2: %v", err)
	}
	if c1.Id == c2.Id {
		t.Fatal("customers should have distinct IDs")
	}

	// 4. Verify sorting by -created works on the newly created dataset
	jobsCol, _ := app.FindCollectionByNameOrId("jobs")
	listRecords, err := app.FindRecordsByFilter("jobs", "", "-created", 10, 0)
	if err != nil {
		t.Fatalf("list request with -created failed on new dataset: %v", err)
	}
	if len(listRecords) != 0 {
		t.Fatalf("expected 0 jobs initially, got %d", len(listRecords))
	}

	// 5. Create assigned-scope member "bob"
	usersCol, _ := app.FindCollectionByNameOrId("users")
	bob := core.NewRecord(usersCol)
	bob.Set("email", "bob@example.com")
	bob.SetPassword("validPassword123!")
	bob.Set("role", authz.RoleMember)
	bob.Set("permissions", map[string]authz.DatasetPermission{
		"customers": {Read: true},
		"jobs":      {Read: true, Create: true, Update: true, Scope: authz.ScopeAssigned},
	})
	if err := app.Save(bob); err != nil {
		t.Fatalf("failed to create member bob: %v", err)
	}

	// Create another member "charlie"
	charlie := core.NewRecord(usersCol)
	charlie.Set("email", "charlie@example.com")
	charlie.SetPassword("validPassword123!")
	charlie.Set("role", authz.RoleMember)
	charlie.Set("permissions", map[string]authz.DatasetPermission{
		"jobs": {Read: true, Create: true, Update: true, Scope: authz.ScopeAssigned},
	})
	if err := app.Save(charlie); err != nil {
		t.Fatalf("failed to create member charlie: %v", err)
	}

	// 6. Test Record Creation with auto-assignment via RecordRequestEvent simulation
	rec := core.NewRecord(jobsCol)
	rec.Set("title", "Job 1 for Alpha")
	rec.Set("customer", c1.Id)
	// assigned_user is omitted/empty; server auto-assignment sets it to bob.Id
	createReqEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{
			Auth: bob,
		},
		Record: rec,
	}
	err = app.OnRecordCreateRequest().Trigger(createReqEvent, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	})
	if err != nil {
		t.Fatalf("assigned member blocked from creating job: %v", err)
	}

	if rec.GetString("assigned_user") != bob.Id {
		t.Fatalf("expected job to be auto-assigned to bob (%s), got %q", bob.Id, rec.GetString("assigned_user"))
	}

	// 7. Test Record Update as bob: update title, preserving assignment
	rec.Set("title", "Job 1 for Alpha (Updated)")
	rec.Set("assigned_user", "") // omitted in payload
	updateReqEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{
			Auth: bob,
		},
		Record: rec,
	}
	err = app.OnRecordUpdateRequest().Trigger(updateReqEvent, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	})
	if err != nil {
		t.Fatalf("assigned member failed to update their own record: %v", err)
	}
	if rec.GetString("assigned_user") != bob.Id {
		t.Fatalf("expected assigned_user to remain bob.Id, got %q", rec.GetString("assigned_user"))
	}

	// 8. Test Member Reassign Prevention: bob tries to reassign their job to charlie
	rec.Set("assigned_user", charlie.Id)
	reassignReqEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{
			Auth: bob,
		},
		Record: rec,
	}
	err = app.OnRecordUpdateRequest().Trigger(reassignReqEvent, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	})
	if err == nil {
		t.Fatal("expected error when assigned member attempts to reassign record to another user, got nil")
	}

	// 9. Test charlie trying to update bob's record: charlie is rejected
	rec.Set("assigned_user", bob.Id)
	charlieUpdateEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{
			Auth: charlie,
		},
		Record: rec,
	}
	err = app.OnRecordUpdateRequest().Trigger(charlieUpdateEvent, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	})
	if err == nil {
		t.Fatal("expected error when charlie attempts to update bob's record, got nil")
	}
}

func TestConcurrentSchemaCreation_DoesNotDeleteCommittedDataset(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Initial successful creation
	def := schemas.SchemaDefinition{
		SchemaID: "concurrent_dataset",
		Name:     "Concurrent Dataset",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
		},
	}

	created, err := svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("initial CreateSchema failed: %v", err)
	}
	if created.SchemaID != "concurrent_dataset" {
		t.Fatalf("unexpected schema id: %s", created.SchemaID)
	}

	// 2. Second creation of the exact same schema (simulating a concurrent race that passes initial checks)
	_, err = svc.CreateSchema(ctx, def)
	if err == nil {
		t.Fatal("expected second CreateSchema to fail, got nil")
	}

	// 3. Verify that the committed dataset was NOT deleted by error cleanup
	col, err := app.FindCollectionByNameOrId("concurrent_dataset")
	if err != nil || col == nil {
		t.Fatalf("committed collection 'concurrent_dataset' was erroneously deleted after duplicate failed: %v", err)
	}

	meta, err := svc.GetSchema(ctx, "concurrent_dataset")
	if err != nil || meta == nil {
		t.Fatalf("committed schema metadata 'concurrent_dataset' was erroneously deleted: %v", err)
	}
}

func TestPartialUpdatePreservesAssigneeField(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create schema with assignee_field
	def := schemas.SchemaDefinition{
		SchemaID:      "projects",
		Name:          "Projects",
		AssigneeField: "lead_user",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Type: "text", Required: true},
			{Name: "lead_user", Type: "relation", Target: "users"},
		},
	}

	created, err := svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}
	if created.AssigneeField != "lead_user" {
		t.Fatalf("expected AssigneeField 'lead_user', got %q", created.AssigneeField)
	}

	// 2. Partial update via raw JSON where assignee_field is omitted
	partialJSON := []byte(`{
		"name": "Projects Renamed",
		"fields": [
			{"name": "name", "type": "text", "required": true},
			{"name": "lead_user", "type": "relation", "target": "users"},
			{"name": "description", "type": "text", "required": false}
		]
	}`)

	updated, err := svc.UpdateSchema(ctx, "projects", partialJSON)
	if err != nil {
		t.Fatalf("UpdateSchema failed: %v", err)
	}

	// Verify AssigneeField is preserved
	if updated.AssigneeField != "lead_user" {
		t.Fatalf("expected AssigneeField to be preserved as 'lead_user', got %q", updated.AssigneeField)
	}
	if updated.Name != "Projects Renamed" {
		t.Fatalf("expected Name to be 'Projects Renamed', got %q", updated.Name)
	}

	// Verify PocketBase collection rule still contains assignee restriction
	col, err := app.FindCollectionByNameOrId("projects")
	if err != nil {
		t.Fatalf("failed to find collection: %v", err)
	}
	if col.ListRule == nil || *col.ListRule == "" {
		t.Fatal("expected ListRule to be present on collection with assignee_field")
	}
	if col.ViewRule == nil || *col.ViewRule == "" {
		t.Fatal("expected ViewRule to be present on collection with assignee_field")
	}
}

func TestExplicitRemovalOfAssigneeField_RejectedWhenAssignedMembersExist(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create schema with assignee_field
	def := schemas.SchemaDefinition{
		SchemaID:      "work_orders",
		Name:          "Work Orders",
		AssigneeField: "worker",
		Fields: []schemas.FieldDefinition{
			{Name: "summary", Type: "text", Required: true},
			{Name: "worker", Type: "relation", Target: "users"},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// 2. Create member with assigned scope on work_orders
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection not found: %v", err)
	}
	workerUser := core.NewRecord(usersCol)
	workerUser.Set("email", "worker@example.com")
	workerUser.SetPassword("validPassword123!")
	workerUser.Set("role", authz.RoleMember)
	workerUser.Set("permissions", map[string]authz.DatasetPermission{
		"work_orders": {Read: true, Create: true, Scope: authz.ScopeAssigned},
	})
	if err := app.Save(workerUser); err != nil {
		t.Fatalf("failed to save worker member: %v", err)
	}

	// 3. Attempt to explicitly remove assignee_field while assigned member exists
	removalJSON := []byte(`{
		"assignee_field": "",
		"fields": [
			{"name": "summary", "type": "text", "required": true},
			{"name": "worker", "type": "relation", "target": "users"}
		]
	}`)

	_, err = svc.UpdateSchema(ctx, "work_orders", removalJSON)
	if err == nil {
		t.Fatal("expected UpdateSchema to reject removal of assignee_field when assigned-scope members exist, got nil")
	}

	// 4. Update member to have scope "all" instead of "assigned"
	workerUser.Set("permissions", map[string]authz.DatasetPermission{
		"work_orders": {Read: true, Create: true, Scope: authz.ScopeAll},
	})
	if err := app.Save(workerUser); err != nil {
		t.Fatalf("failed to update worker permissions: %v", err)
	}

	// 5. Now explicitly remove assignee_field -> should succeed
	updated, err := svc.UpdateSchema(ctx, "work_orders", removalJSON)
	if err != nil {
		t.Fatalf("expected UpdateSchema to succeed after changing member scope to 'all': %v", err)
	}
	if updated.AssigneeField != "" {
		t.Fatalf("expected AssigneeField to be empty, got %q", updated.AssigneeField)
	}
}

func TestSchemaUpdateSynchronizesPocketBaseFields(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create schema
	def := schemas.SchemaDefinition{
		SchemaID: "tickets",
		Name:     "Tickets",
		Fields: []schemas.FieldDefinition{
			{Name: "subject", Type: "text", Required: false},
			{Name: "stage", Type: "select", Options: []string{"open", "closed"}},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// 2. Update schema: change 'subject' to required, add 'in_progress' to 'stage' options
	updateJSON := []byte(`{
		"fields": [
			{"name": "subject", "type": "text", "required": true},
			{"name": "stage", "type": "select", "options": ["open", "in_progress", "closed"]}
		]
	}`)
	_, err = svc.UpdateSchema(ctx, "tickets", updateJSON)
	if err != nil {
		t.Fatalf("UpdateSchema failed: %v", err)
	}

	// Verify PocketBase collection reflects the new field properties
	col, err := app.FindCollectionByNameOrId("tickets")
	if err != nil {
		t.Fatalf("failed to find collection: %v", err)
	}
	subjField := col.Fields.GetByName("subject")
	if subjField == nil {
		t.Fatal("field 'subject' not found in collection")
	}
	if textField, ok := subjField.(*core.TextField); !ok || !textField.Required {
		t.Fatalf("expected subject to be required TextField, got: %+v", subjField)
	}

	stageField := col.Fields.GetByName("stage")
	if stageField == nil {
		t.Fatal("field 'stage' not found in collection")
	}
	selectField, ok := stageField.(*core.SelectField)
	if !ok {
		t.Fatalf("expected stage to be SelectField, got %T", stageField)
	}
	if len(selectField.Values) != 3 || selectField.Values[1] != "in_progress" {
		t.Fatalf("expected selectField values to be ['open', 'in_progress', 'closed'], got %v", selectField.Values)
	}

	// 3. Attempt unsupported type change: text -> number
	badTypeJSON := []byte(`{
		"fields": [
			{"name": "subject", "type": "number"},
			{"name": "stage", "type": "select", "options": ["open", "in_progress", "closed"]}
		]
	}`)
	_, err = svc.UpdateSchema(ctx, "tickets", badTypeJSON)
	if err == nil {
		t.Fatal("expected error on field type change from text to number, got nil")
	}

	// 4. Attempt unsupported field removal
	removalFieldJSON := []byte(`{
		"fields": [
			{"name": "subject", "type": "text", "required": true}
		]
	}`)
	_, err = svc.UpdateSchema(ctx, "tickets", removalFieldJSON)
	if err == nil {
		t.Fatal("expected error on field removal, got nil")
	}
}

func TestConcurrentSchemaUpdates_SimultaneousFieldAdditions(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Initial schema definition with a single base field
	initDef := schemas.SchemaDefinition{
		SchemaID: "concurrent_fields",
		Name:     "Concurrent Fields Test",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
		},
	}
	_, err = svc.CreateSchema(ctx, initDef)
	if err != nil {
		t.Fatalf("failed to create initial schema: %v", err)
	}

	// 2. Prepare two simultaneous updates, each adding a distinct field
	updateA := schemas.SchemaUpdateInput{
		Fields: &[]schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "field_alpha", Type: "text", Required: false},
		},
	}
	updateB := schemas.SchemaUpdateInput{
		Fields: &[]schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "field_beta", Type: "text", Required: false},
		},
	}

	errChanA := make(chan error, 1)
	errChanB := make(chan error, 1)
	startBarrier := make(chan struct{})

	go func() {
		<-startBarrier
		_, uErr := svc.UpdateSchema(ctx, "concurrent_fields", updateA)
		errChanA <- uErr
	}()

	go func() {
		<-startBarrier
		_, uErr := svc.UpdateSchema(ctx, "concurrent_fields", updateB)
		errChanB <- uErr
	}()

	close(startBarrier)
	errA := <-errChanA
	errB := <-errChanB

	// At least one of the concurrent updates must succeed
	if errA != nil && errB != nil {
		t.Fatalf("both concurrent updates failed: errA=%v, errB=%v", errA, errB)
	}

	// 3. Verify that the winner's field is safely committed and was NOT overwritten/deleted by the loser
	col, err := app.FindCollectionByNameOrId("concurrent_fields")
	if err != nil || col == nil {
		t.Fatalf("failed to find collection after concurrent updates: %v", err)
	}

	meta, err := svc.GetSchema(ctx, "concurrent_fields")
	if err != nil || meta == nil {
		t.Fatalf("failed to fetch schema after concurrent updates: %v", err)
	}

	if errA == nil {
		if f := col.Fields.GetByName("field_alpha"); f == nil {
			t.Fatal("field_alpha was committed by updateA but erroneously overwritten/removed from collection")
		}
		foundMeta := false
		for _, f := range meta.Fields {
			if f.Name == "field_alpha" {
				foundMeta = true
				break
			}
		}
		if !foundMeta {
			t.Fatal("field_alpha was committed by updateA but erroneously missing from schema metadata")
		}
	}

	if errB == nil {
		if f := col.Fields.GetByName("field_beta"); f == nil {
			t.Fatal("field_beta was committed by updateB but erroneously overwritten/removed from collection")
		}
		foundMeta := false
		for _, f := range meta.Fields {
			if f.Name == "field_beta" {
				foundMeta = true
				break
			}
		}
		if !foundMeta {
			t.Fatal("field_beta was committed by updateB but erroneously missing from schema metadata")
		}
	}
}

func TestAssigneeFieldRemoval_GuardsDisabledUsersAndInvitations(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create dataset with assignee_field
	def := schemas.SchemaDefinition{
		SchemaID:      "incidents",
		Name:          "Incidents",
		AssigneeField: "handler",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "handler", Type: "relation", Target: "users"},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// 2. Create a DISABLED member who holds assigned-scope permission
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection not found: %v", err)
	}
	disabledUser := core.NewRecord(usersCol)
	disabledUser.Set("email", "disabled_handler@example.com")
	disabledUser.SetPassword("validPassword123!")
	disabledUser.Set("role", authz.RoleMember)
	disabledUser.Set("disabled", true)
	disabledUser.Set("permissions", map[string]authz.DatasetPermission{
		"incidents": {Read: true, Create: true, Scope: authz.ScopeAssigned},
	})
	if err := app.Save(disabledUser); err != nil {
		t.Fatalf("failed to save disabled user: %v", err)
	}

	// 3. Removal must be REJECTED even though user is disabled (user may be re-enabled)
	removalInput := schemas.SchemaUpdateInput{
		AssigneeField: new(string), // empty string explicitly requests removal
	}
	_, err = svc.UpdateSchema(ctx, "incidents", removalInput)
	if err == nil {
		t.Fatal("expected removal of assignee_field to be rejected due to disabled user with assigned scope, got nil")
	}

	// 4. Update the disabled user to scope "all"
	disabledUser.Set("permissions", map[string]authz.DatasetPermission{
		"incidents": {Read: true, Create: true, Scope: authz.ScopeAll},
	})
	if err := app.Save(disabledUser); err != nil {
		t.Fatalf("failed to update user permissions: %v", err)
	}

	// 5. Create a PENDING invitation that holds assigned-scope permission
	ownerRec := core.NewRecord(usersCol)
	ownerRec.Set("email", "owner@example.com")
	ownerRec.SetPassword("validPassword123!")
	ownerRec.Set("role", authz.RoleOwner)
	if err := app.Save(ownerRec); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}

	inv, err := authz.CreateInvitation(app, ownerRec, "invitee@example.com", authz.RoleMember, map[string]any{
		"incidents": map[string]any{"read": true, "scope": "assigned"},
	})
	if err != nil {
		t.Fatalf("failed to create invitation: %v", err)
	}

	// 6. Removal must still be REJECTED due to the pending invitation
	_, err = svc.UpdateSchema(ctx, "incidents", removalInput)
	if err == nil {
		t.Fatal("expected removal of assignee_field to be rejected due to pending invitation with assigned scope, got nil")
	}

	// 7. Revoke the pending invitation
	inv.Set("revoked", true)
	if err := app.Save(inv); err != nil {
		t.Fatalf("failed to revoke invitation: %v", err)
	}

	// 8. Now removal should succeed
	updated, err := svc.UpdateSchema(ctx, "incidents", removalInput)
	if err != nil {
		t.Fatalf("expected removal of assignee_field to succeed after revoking invitation: %v", err)
	}
	if updated.AssigneeField != "" {
		t.Fatalf("expected empty AssigneeField, got %q", updated.AssigneeField)
	}

	// 9. Enforce invariant: creating new invitation with assigned-scope on dataset without assignee_field MUST be rejected
	_, err = authz.CreateInvitation(app, ownerRec, "newinvitee@example.com", authz.RoleMember, map[string]any{
		"incidents": map[string]any{"read": true, "scope": "assigned"},
	})
	if err == nil {
		t.Fatal("expected CreateInvitation to be rejected when dataset has no assignee_field configured, got nil")
	}

	// 10. Enforce invariant: updating user with assigned-scope on dataset without assignee_field MUST be rejected
	err = authz.ValidateAssignedScopePermissions(app, map[string]any{
		"incidents": map[string]any{"read": true, "scope": "assigned"},
	})
	if err == nil {
		t.Fatal("expected ValidateAssignedScopePermissions to reject assigned scope when dataset has no assignee_field, got nil")
	}
}

func TestSchemaUpdate_PreservesOmittedRelationTarget(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create target collection "customers" first so relation target is valid
	custDef := schemas.SchemaDefinition{
		SchemaID: "customers",
		Name:     "Customers",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Type: "text", Required: true},
		},
	}
	_, err = svc.CreateSchema(ctx, custDef)
	if err != nil {
		t.Fatalf("failed to create customers schema: %v", err)
	}

	// Create "invoices" with relation field targeting "customers"
	def := schemas.SchemaDefinition{
		SchemaID: "invoices",
		Name:     "Invoices",
		Fields: []schemas.FieldDefinition{
			{Name: "invoice_number", Type: "text", Required: true},
			{Name: "customer_ref", Type: "relation", Target: "customers"},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create invoices schema: %v", err)
	}

	// 2. Update schema with target omitted on customer_ref
	updateJSON := []byte(`{
		"name": "Invoices Renamed",
		"fields": [
			{"name": "invoice_number", "type": "text", "required": true},
			{"name": "customer_ref", "type": "relation"},
			{"name": "notes", "type": "text", "required": false}
		]
	}`)
	updated, err := svc.UpdateSchema(ctx, "invoices", updateJSON)
	if err != nil {
		t.Fatalf("UpdateSchema failed: %v", err)
	}

	// 3. Verify Target is preserved as "customers"
	var customerField *schemas.FieldDefinition
	for i := range updated.Fields {
		if updated.Fields[i].Name == "customer_ref" {
			customerField = &updated.Fields[i]
			break
		}
	}
	if customerField == nil {
		t.Fatal("customer_ref field missing after update")
	}
	if customerField.Target != "customers" {
		t.Fatalf("expected customer_ref Target to be preserved as 'customers', got %q", customerField.Target)
	}

	// 4. Verify that attempting to change the relation target is rejected
	badTargetJSON := []byte(`{
		"fields": [
			{"name": "invoice_number", "type": "text", "required": true},
			{"name": "customer_ref", "type": "relation", "target": "vendors"}
		]
	}`)
	_, err = svc.UpdateSchema(ctx, "invoices", badTargetJSON)
	if err == nil {
		t.Fatal("expected error when attempting to change relation target from 'customers' to 'vendors', got nil")
	}
}

func TestSchemaUpdate_PreservesOmittedSelectOptions(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create schema with select field containing options
	initialOptions := []string{"open", "in_progress", "resolved", "closed"}
	def := schemas.SchemaDefinition{
		SchemaID: "support_tickets",
		Name:     "Support Tickets",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "status", Type: "select", Required: true, Options: initialOptions},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// 2. Partial update with fields list where select field omits 'options'
	updateJSON := []byte(`{
		"name": "Support Tickets Renamed",
		"fields": [
			{"name": "title", "type": "text", "required": true},
			{"name": "status", "type": "select", "required": true},
			{"name": "priority", "type": "text", "required": false}
		]
	}`)

	updated, err := svc.UpdateSchema(ctx, "support_tickets", updateJSON)
	if err != nil {
		t.Fatalf("UpdateSchema failed: %v", err)
	}

	// 3. Verify options are preserved in the returned schema definition
	var statusField *schemas.FieldDefinition
	for i := range updated.Fields {
		if updated.Fields[i].Name == "status" {
			statusField = &updated.Fields[i]
			break
		}
	}
	if statusField == nil {
		t.Fatal("status field missing after update")
	}
	if len(statusField.Options) != len(initialOptions) {
		t.Fatalf("expected status field to retain %d options, got %d: %v", len(initialOptions), len(statusField.Options), statusField.Options)
	}
	for i, opt := range initialOptions {
		if statusField.Options[i] != opt {
			t.Errorf("option %d: expected %q, got %q", i, opt, statusField.Options[i])
		}
	}

	// 4. Verify options are preserved in underlying PocketBase collection
	col, err := app.FindCollectionByNameOrId("support_tickets")
	if err != nil || col == nil {
		t.Fatalf("failed to find collection: %v", err)
	}
	pbStatus := col.Fields.GetByName("status")
	if pbStatus == nil {
		t.Fatal("status field missing from PocketBase collection")
	}
	selectField, ok := pbStatus.(*core.SelectField)
	if !ok {
		t.Fatalf("expected *core.SelectField, got %T", pbStatus)
	}
	if len(selectField.Values) != len(initialOptions) {
		t.Fatalf("expected PocketBase SelectField.Values to retain %d options, got %d: %v", len(initialOptions), len(selectField.Values), selectField.Values)
	}

	// 5. Verify options are preserved in schema_definitions record
	meta, err := svc.GetSchema(ctx, "support_tickets")
	if err != nil || meta == nil {
		t.Fatalf("failed to get schema metadata: %v", err)
	}
	for _, f := range meta.Fields {
		if f.Name == "status" {
			if len(f.Options) != len(initialOptions) {
				t.Fatalf("schema metadata has empty or partial options: %v", f.Options)
			}
		}
	}
}

func TestPermissionGrant_CannotRaceWithAssigneeRemoval(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	svc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create dataset with assignee_field
	def := schemas.SchemaDefinition{
		SchemaID:      "order_records",
		Name:          "Order Records",
		AssigneeField: "rep",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "rep", Type: "relation", Target: "users"},
		},
	}
	_, err = svc.CreateSchema(ctx, def)
	if err != nil {
		t.Fatalf("failed to create schema: %v", err)
	}

	// 2. Create user with no initial permissions
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection not found: %v", err)
	}
	user := core.NewRecord(usersCol)
	user.Set("email", "rep1@example.com")
	user.SetPassword("validPassword123!")
	user.Set("role", authz.RoleMember)
	if err := app.Save(user); err != nil {
		t.Fatalf("failed to save user: %v", err)
	}

	// 3. Concurrently execute:
	//    A) Grant user 'assigned' scope on order_records inside transaction
	//    B) Remove assignee_field from order_records
	startBarrier := make(chan struct{})
	errAChan := make(chan error, 1)
	errBChan := make(chan error, 1)

	go func() {
		<-startBarrier
		// Grant permissions atomically inside transaction
		txErr := app.RunInTransaction(func(txApp core.App) error {
			perms := map[string]any{
				"order_records": map[string]any{"read": true, "create": true, "scope": "assigned"},
			}
			if vErr := authz.ValidateAssignedScopePermissions(txApp, perms); vErr != nil {
				return vErr
			}
			freshUser, fErr := txApp.FindRecordById("users", user.Id)
			if fErr != nil {
				return fErr
			}
			freshUser.Set("permissions", perms)
			return txApp.Save(freshUser)
		})
		errAChan <- txErr
	}()

	go func() {
		<-startBarrier
		removalInput := schemas.SchemaUpdateInput{
			AssigneeField: new(string), // empty string requests removal
		}
		_, uErr := svc.UpdateSchema(ctx, "order_records", removalInput)
		errBChan <- uErr
	}()

	close(startBarrier)
	errA := <-errAChan
	errB := <-errBChan

	// At least one must fail due to invariant enforcement (they cannot both succeed!)
	if errA == nil && errB == nil {
		t.Fatal("security violation: both permission grant and assignee removal succeeded concurrently!")
	}

	// Verify post-condition: an assigned-scope grant is NEVER saved against an unscoped dataset
	finalMeta, err := svc.GetSchema(ctx, "order_records")
	if err != nil {
		t.Fatalf("failed to get schema: %v", err)
	}
	finalUser, err := app.FindRecordById("users", user.Id)
	if err != nil {
		t.Fatalf("failed to get user: %v", err)
	}
	userPerms := authz.GetUserPermissions(finalUser)

	if p, ok := userPerms["order_records"]; ok && p.Scope == authz.ScopeAssigned {
		if finalMeta.AssigneeField == "" {
			t.Fatal("security violation: user has assigned-scope permission on dataset without an assignee_field!")
		}
	}
}
