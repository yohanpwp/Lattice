package authz_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/search"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
	"github.com/pocketbase/pocketbase/tools/types"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/platform/authz"
	"github.com/Lattice/backend/internal/platform/schemas"
)

func newTestApp(t *testing.T) *tests.TestApp {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Cleanup)
	authz.RegisterAuthnHooks(app)
	return app
}

func TestWorkspaceOneTimeSetupAndOperatorSecurity(t *testing.T) {
	app := newTestApp(t)

	// 1. Fresh instance: HasOwner must be false initially
	hasOwner, err := authz.HasOwner(app)
	if err != nil {
		t.Fatalf("unexpected error checking HasOwner: %v", err)
	}
	if hasOwner {
		t.Fatal("expected fresh instance to have no owner")
	}

	// 2. Generate setup token
	token, err := authz.GetOrCreateSetupToken(app)
	if err != nil {
		t.Fatalf("failed to get setup token: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty setup token")
	}

	// 3. Repeated call to GetOrCreateSetupToken returns the same token before completion
	token2, err := authz.GetOrCreateSetupToken(app)
	if err != nil || token2 != token {
		t.Fatalf("expected identical setup token, got: %s (want %s)", token2, token)
	}

	// 4. Validate and consume with wrong token must fail
	if err := authz.ValidateAndConsumeSetupToken(app, "invalid_token_123"); err == nil {
		t.Fatal("expected error validating invalid setup token, got nil")
	}

	// 5. Validate and consume with valid token must succeed
	if err := authz.ValidateAndConsumeSetupToken(app, token); err != nil {
		t.Fatalf("failed to consume valid setup token: %v", err)
	}

	// Create owner record
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		t.Fatal("users collection not found")
	}

	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123456!")
	if err := app.Save(owner); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}

	// 6. HasOwner is now true
	hasOwner, err = authz.HasOwner(app)
	if err != nil || !hasOwner {
		t.Fatal("expected HasOwner to be true after owner creation")
	}

	// 7. Second setup attempt must fail with ErrSetupAlreadyCompleted
	if err := authz.ValidateAndConsumeSetupToken(app, token); err != authz.ErrSetupAlreadyCompleted {
		t.Fatalf("expected ErrSetupAlreadyCompleted, got: %v", err)
	}

	// 8. Public registration is locked (users.CreateRule == nil)
	if usersCol.CreateRule != nil {
		t.Fatalf("expected users.CreateRule to be nil (disabled public signup), got: %v", *usersCol.CreateRule)
	}

	// 9. Operator recovery CLI function can reset owner or promote
	recovered, err := authz.RecoverOwner(app, "operator_owner@example.com", "Password123456!")
	if err != nil {
		t.Fatalf("failed to recover owner: %v", err)
	}
	if recovered.GetString("role") != authz.RoleOwner {
		t.Fatalf("expected recovered user to have role owner, got: %s", recovered.GetString("role"))
	}
}

func TestAuthorityHierarchyAndPrivilegeProtection(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	// Create Owner
	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123456!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	// Create Admin
	admin := core.NewRecord(usersCol)
	admin.Set("email", "admin@example.com")
	admin.Set("role", authz.RoleAdmin)
	admin.Set("disabled", false)
	admin.SetPassword("Password123456!")
	if err := app.Save(admin); err != nil {
		t.Fatal(err)
	}

	// Create Member
	member := core.NewRecord(usersCol)
	member.Set("email", "member@example.com")
	member.Set("role", authz.RoleMember)
	member.Set("disabled", false)
	member.SetPassword("Password123456!")
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	// 1. Last owner protection check
	isLast, err := authz.IsLastOwner(app, owner.Id)
	if err != nil {
		t.Fatalf("unexpected error checking last owner: %v", err)
	}
	if !isLast {
		t.Fatal("expected owner to be detected as last owner")
	}

	// 2. Add second owner
	owner2 := core.NewRecord(usersCol)
	owner2.Set("email", "owner2@example.com")
	owner2.Set("role", authz.RoleOwner)
	owner2.Set("disabled", false)
	owner2.SetPassword("Password123456!")
	if err := app.Save(owner2); err != nil {
		t.Fatal(err)
	}

	// Now neither is the last owner
	isLast, err = authz.IsLastOwner(app, owner.Id)
	if err != nil {
		t.Fatalf("unexpected error checking last owner: %v", err)
	}
	if isLast {
		t.Fatal("expected owner not to be last owner when owner2 exists")
	}

	// Role helpers verification
	if !authz.IsOwner(owner) || !authz.IsOwnerOrAdmin(owner) {
		t.Error("expected IsOwner and IsOwnerOrAdmin to be true for owner")
	}
	if authz.IsOwner(admin) || !authz.IsAdmin(admin) || !authz.IsOwnerOrAdmin(admin) {
		t.Error("expected IsAdmin and IsOwnerOrAdmin to be true for admin, IsOwner false")
	}
	if authz.IsOwner(member) || authz.IsAdmin(member) || authz.IsOwnerOrAdmin(member) {
		t.Error("expected member not to be owner or admin")
	}
}

func TestInvitationLifecycle(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123456!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	admin := core.NewRecord(usersCol)
	admin.Set("email", "admin@example.com")
	admin.Set("role", authz.RoleAdmin)
	admin.Set("disabled", false)
	admin.SetPassword("Password123456!")
	if err := app.Save(admin); err != nil {
		t.Fatal(err)
	}

	// 1. Admin cannot invite Admin (only Owner can invite Admin)
	_, err := authz.CreateInvitation(app, admin, "new_admin@example.com", authz.RoleAdmin, nil)
	if err != authz.ErrAdminCannotEscalate {
		t.Fatalf("expected ErrAdminCannotEscalate, got: %v", err)
	}

	// 2. Owner can invite Admin
	invAdmin, err := authz.CreateInvitation(app, owner, "new_admin@example.com", authz.RoleAdmin, nil)
	if err != nil {
		t.Fatalf("expected owner to be able to invite admin: %v", err)
	}
	if invAdmin.GetString("token") == "" {
		t.Fatal("expected invitation token")
	}

	// 3. Admin can invite Member with dataset permissions
	schemaSvc := schemas.NewService(app)
	_, _ = schemaSvc.CreateSchema(context.Background(), schemas.SchemaDefinition{
		SchemaID:      "jobs",
		Name:          "Jobs",
		AssigneeField: "assigned_user",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assigned_user", Type: "relation", Target: "users"},
		},
	})

	perms := map[string]any{
		"jobs": map[string]any{
			"read":   true,
			"create": true,
			"update": true,
			"delete": false,
			"scope":  "assigned",
		},
	}
	invMember, err := authz.CreateInvitation(app, admin, "bob@example.com", authz.RoleMember, perms)
	if err != nil {
		t.Fatalf("expected admin to invite member: %v", err)
	}

	// 4. Accept invitation
	user, err := authz.AcceptInvitation(app, invMember.GetString("token"), "Bob Smith", "Password123456!")
	if err != nil {
		t.Fatalf("failed to accept invitation: %v", err)
	}
	if user.GetString("role") != authz.RoleMember {
		t.Fatalf("expected user role member, got: %s", user.GetString("role"))
	}
	if user.GetString("name") != "Bob Smith" {
		t.Fatalf("expected user name Bob Smith, got: %s", user.GetString("name"))
	}

	// 5. Repeated acceptance of same token must fail
	_, err = authz.AcceptInvitation(app, invMember.GetString("token"), "Bob Duplicate", "Password123456!")
	if err == nil {
		t.Fatal("expected error on repeated invitation acceptance, got nil")
	}

	// 6. Revoked invitation cannot be accepted
	invToRevoke, _ := authz.CreateInvitation(app, owner, "charlie@example.com", authz.RoleMember, nil)
	invToRevoke.Set("revoked", true)
	_ = app.Save(invToRevoke)

	_, err = authz.AcceptInvitation(app, invToRevoke.GetString("token"), "Charlie", "Password123456!")
	if err == nil {
		t.Fatal("expected error accepting revoked invitation, got nil")
	}
}

func TestCustomerAndJobAssignedScoping(t *testing.T) {
	app := newTestApp(t)
	schemaSvc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create customers schema
	custDef := schemas.SchemaDefinition{
		SchemaID: "customers",
		Name:     "ลูกค้า",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Type: "text", Required: true},
			{Name: "phone", Type: "text"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, custDef); err != nil {
		t.Fatalf("failed to create customers schema: %v", err)
	}

	// Verify customers rules include read check
	customersCol, _ := app.FindCollectionByNameOrId("customers")
	expectedCustRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.customers.read = true))"
	if customersCol.ListRule == nil || *customersCol.ListRule != expectedCustRule {
		t.Fatalf("expected customers ListRule %q, got: %v", expectedCustRule, *customersCol.ListRule)
	}

	// 2. Create jobs schema with assignee relation targeting users
	jobDef := schemas.SchemaDefinition{
		SchemaID:      "jobs",
		Name:          "งานบริการ",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
			{Name: "customer", Type: "relation", Target: "customers"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, jobDef); err != nil {
		t.Fatalf("failed to create jobs schema: %v", err)
	}

	// Verify jobs collection API rules include active check, action check, and scope check
	jobsCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobsCol == nil {
		t.Fatal("jobs collection not found")
	}
	expectedJobsRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.jobs.read = true && (@request.auth.permissions.jobs.scope = 'all' || assignee = @request.auth.id)))"
	if jobsCol.ListRule == nil || *jobsCol.ListRule != expectedJobsRule {
		t.Fatalf("expected jobs ListRule %q, got: %v", expectedJobsRule, *jobsCol.ListRule)
	}
	if jobsCol.ViewRule == nil || *jobsCol.ViewRule != expectedJobsRule {
		t.Fatalf("expected jobs ViewRule %q, got: %v", expectedJobsRule, *jobsCol.ViewRule)
	}

	// 3. Create users: Member A and Member B
	usersCol, _ := app.FindCollectionByNameOrId("users")

	memberA := core.NewRecord(usersCol)
	memberA.Set("email", "memberA@example.com")
	memberA.Set("role", authz.RoleMember)
	memberA.Set("permissions", map[string]any{
		"jobs": map[string]any{
			"read":   true,
			"create": true,
			"update": true,
			"delete": false,
			"scope":  "assigned",
		},
	})
	memberA.SetPassword("Password123456!")
	if err := app.Save(memberA); err != nil {
		t.Fatal(err)
	}

	memberB := core.NewRecord(usersCol)
	memberB.Set("email", "memberB@example.com")
	memberB.Set("role", authz.RoleMember)
	memberB.Set("permissions", map[string]any{
		"jobs": map[string]any{
			"read":   true,
			"create": true,
			"update": true,
			"delete": false,
			"scope":  "assigned",
		},
	})
	memberB.SetPassword("Password123456!")
	if err := app.Save(memberB); err != nil {
		t.Fatal(err)
	}

	// 4. Create Job 1 (assigned to Member A) and Job 2 (assigned to Member B)
	job1 := core.NewRecord(jobsCol)
	job1.Set("title", "ซ่อมแอร์บ้านนาย A")
	job1.Set("assignee", memberA.Id)
	if err := app.Save(job1); err != nil {
		t.Fatal(err)
	}

	job2 := core.NewRecord(jobsCol)
	job2.Set("title", "ติดตั้งปั๊มน้ำบ้านนาย B")
	job2.Set("assignee", memberB.Id)
	if err := app.Save(job2); err != nil {
		t.Fatal(err)
	}

	// 5. Check permissions evaluation
	// Member A has read, create, update on jobs, but NOT delete
	if !authz.CheckDatasetAction(memberA, "jobs", "read") {
		t.Error("expected Member A to have read action on jobs")
	}
	if !authz.CheckDatasetAction(memberA, "jobs", "create") {
		t.Error("expected Member A to have create action on jobs")
	}
	if !authz.CheckDatasetAction(memberA, "jobs", "update") {
		t.Error("expected Member A to have update action on jobs")
	}
	if authz.CheckDatasetAction(memberA, "jobs", "delete") {
		t.Error("expected Member A NOT to have delete action on jobs")
	}

	// Deny by default: Member A has NO permissions on customers dataset
	if authz.CheckDatasetAction(memberA, "customers", "read") {
		t.Error("expected Member A NOT to have read action on customers (deny by default)")
	}
	if authz.CheckDatasetAction(memberA, "customers", "create") {
		t.Error("expected Member A NOT to have create action on customers (deny by default)")
	}
}

func TestDisabledMemberImmediateRejection(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	member := core.NewRecord(usersCol)
	member.Set("email", "active@example.com")
	member.Set("role", authz.RoleMember)
	member.Set("disabled", false)
	member.SetPassword("Password123456!")
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	// When active: CheckDatasetAction returns according to permissions
	member.Set("permissions", map[string]any{
		"inventory": map[string]any{"read": true},
	})
	if !authz.CheckDatasetAction(member, "inventory", "read") {
		t.Error("expected active member with read permission to be allowed")
	}

	// When disabled: CheckDatasetAction immediately returns false
	member.Set("disabled", true)
	if authz.CheckDatasetAction(member, "inventory", "read") {
		t.Error("expected disabled member to be denied immediately")
	}
	if authz.IsOwnerOrAdmin(member) {
		t.Error("expected disabled account not to be considered active owner or admin")
	}
}

func TestConcurrentWorkspaceSetup(t *testing.T) {
	app := newTestApp(t)

	token, err := authz.GetOrCreateSetupToken(app)
	if err != nil {
		t.Fatalf("failed to create setup token: %v", err)
	}

	const concurrency = 10
	var successCount int32
	var conflictCount int32
	var wg sync.WaitGroup

	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, err := authz.CreateOwnerWithSetupToken(
				app,
				token,
				"owner@example.com",
				"Owner",
				"SecurePassword123!",
			)
			if err == nil {
				atomic.AddInt32(&successCount, 1)
			} else if errors.Is(err, authz.ErrSetupAlreadyCompleted) {
				atomic.AddInt32(&conflictCount, 1)
			}
		}(i)
	}

	wg.Wait()

	if successCount != 1 {
		t.Fatalf("expected exactly 1 successful setup, got %d", successCount)
	}
	if conflictCount != concurrency-1 {
		t.Fatalf("expected %d conflict rejections, got %d", concurrency-1, conflictCount)
	}

	// Verify only 1 owner was created in users collection
	owners, err := app.FindRecordsByFilter("users", "role = 'owner'", "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(owners) != 1 {
		t.Fatalf("expected exactly 1 owner record in database, found %d", len(owners))
	}
}

func TestAdminCannotAppointOrModifyAdmins(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.SetPassword("Password123!")
	_ = app.Save(owner)

	admin1 := core.NewRecord(usersCol)
	admin1.Set("email", "admin1@example.com")
	admin1.Set("role", authz.RoleAdmin)
	admin1.SetPassword("Password123!")
	_ = app.Save(admin1)

	admin2 := core.NewRecord(usersCol)
	admin2.Set("email", "admin2@example.com")
	admin2.Set("role", authz.RoleAdmin)
	admin2.SetPassword("Password123!")
	_ = app.Save(admin2)

	member := core.NewRecord(usersCol)
	member.Set("email", "member@example.com")
	member.Set("role", authz.RoleMember)
	member.SetPassword("Password123!")
	_ = app.Save(member)

	// Admin cannot invite admin
	_, err := authz.CreateInvitation(app, admin1, "newadmin@example.com", authz.RoleAdmin, nil)
	if !errors.Is(err, authz.ErrAdminCannotEscalate) && !errors.Is(err, authz.ErrPermissionDenied) {
		t.Errorf("expected ErrAdminCannotEscalate when admin invites admin, got: %v", err)
	}

	// Admin CAN invite member
	inv, err := authz.CreateInvitation(app, admin1, "newmember@example.com", authz.RoleMember, nil)
	if err != nil || inv == nil {
		t.Fatalf("expected admin to be able to invite member, got: %v", err)
	}
}

func TestTwoMembersTwoAssignedRecordsAndAllScope(t *testing.T) {
	app := newTestApp(t)
	schemaSvc := schemas.NewService(app)
	ctx := context.Background()

	// Create jobs schema with assignee relation targeting users
	jobDef := schemas.SchemaDefinition{
		SchemaID:      "jobs",
		Name:          "Jobs",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, jobDef); err != nil {
		t.Fatalf("failed to create jobs schema: %v", err)
	}

	usersCol, _ := app.FindCollectionByNameOrId("users")

	// Member A (assigned scope)
	mA := core.NewRecord(usersCol)
	mA.Set("email", "ma@example.com")
	mA.Set("role", authz.RoleMember)
	mA.Set("permissions", map[string]any{
		"jobs": map[string]any{"read": true, "create": true, "update": true, "scope": "assigned"},
	})
	mA.SetPassword("Password123!")
	_ = app.Save(mA)

	// Member B (assigned scope)
	mB := core.NewRecord(usersCol)
	mB.Set("email", "mb@example.com")
	mB.Set("role", authz.RoleMember)
	mB.Set("permissions", map[string]any{
		"jobs": map[string]any{"read": true, "create": true, "update": true, "scope": "assigned"},
	})
	mB.SetPassword("Password123!")
	_ = app.Save(mB)

	// Member C (all scope)
	mC := core.NewRecord(usersCol)
	mC.Set("email", "mc@example.com")
	mC.Set("role", authz.RoleMember)
	mC.Set("permissions", map[string]any{
		"jobs": map[string]any{"read": true, "create": true, "update": true, "scope": "all"},
	})
	mC.SetPassword("Password123!")
	_ = app.Save(mC)

	jobsCol, _ := app.FindCollectionByNameOrId("jobs")

	// Create Job 1 assigned to A
	j1 := core.NewRecord(jobsCol)
	j1.Set("title", "Job 1 for A")
	j1.Set("assignee", mA.Id)
	if err := app.Save(j1); err != nil {
		t.Fatal(err)
	}

	// Create Job 2 assigned to B
	j2 := core.NewRecord(jobsCol)
	j2.Set("title", "Job 2 for B")
	j2.Set("assignee", mB.Id)
	if err := app.Save(j2); err != nil {
		t.Fatal(err)
	}

	// Check permissions check function
	if !authz.CheckDatasetAction(mA, "jobs", "read") {
		t.Error("mA should have read permission")
	}
	if !authz.CheckDatasetAction(mB, "jobs", "read") {
		t.Error("mB should have read permission")
	}
	if !authz.CheckDatasetAction(mC, "jobs", "read") {
		t.Error("mC should have read permission")
	}

	// Verify scopes
	permsA := authz.GetUserPermissions(mA)
	if permsA["jobs"].Scope != authz.ScopeAssigned {
		t.Errorf("mA expected assigned scope, got %s", permsA["jobs"].Scope)
	}

	permsC := authz.GetUserPermissions(mC)
	if permsC["jobs"].Scope != authz.ScopeAll {
		t.Errorf("mC expected all scope, got %s", permsC["jobs"].Scope)
	}
}

func TestMemberCannotModifyPermissionsOrRole(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	member := core.NewRecord(usersCol)
	member.Set("email", "member_tamper@example.com")
	member.Set("role", authz.RoleMember)
	member.Set("disabled", false)
	member.Set("permissions", map[string]any{
		"jobs": map[string]any{"read": true},
	})
	member.SetPassword("Password123!")
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	// 1. Member attempting to update their own permissions must fail
	updatedRecord := core.NewRecord(usersCol)
	updatedRecord.Id = member.Id
	updatedRecord.Set("email", member.GetString("email"))
	updatedRecord.Set("role", authz.RoleMember)
	updatedRecord.Set("disabled", false)
	updatedRecord.Set("permissions", map[string]any{
		"jobs": map[string]any{"read": true, "delete": true, "scope": "all"},
	})

	event := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{
			App:  app,
			Auth: member,
		},
		Record: updatedRecord,
	}
	event.Collection = usersCol

	// Trigger hook
	err := app.OnRecordUpdateRequest("users").Trigger(event, func(e *core.RecordRequestEvent) error {
		return nil
	})
	if err == nil {
		t.Fatal("expected error when member attempts to modify permissions, got nil")
	}

	// 2. Member attempting to promote self to owner must fail
	updatedRecord.Set("permissions", map[string]any{"jobs": map[string]any{"read": true}})
	updatedRecord.Set("role", authz.RoleOwner)
	err = app.OnRecordUpdateRequest("users").Trigger(event, func(e *core.RecordRequestEvent) error {
		return nil
	})
	if err == nil {
		t.Fatal("expected error when member attempts to modify role, got nil")
	}

	// 3. Member updating legitimate fields (e.g. name) must succeed
	updatedRecord.Set("role", authz.RoleMember)
	updatedRecord.Set("name", "New Valid Name")
	err = app.OnRecordUpdateRequest("users").Trigger(event, func(e *core.RecordRequestEvent) error {
		return nil
	})
	if err != nil {
		t.Fatalf("expected member to be able to update name, got error: %v", err)
	}
}

func TestAssignedScopeUpdateAndDeletionBypassPrevented(t *testing.T) {
	app := newTestApp(t)
	schemaSvc := schemas.NewService(app)
	ctx := context.Background()

	jobDef := schemas.SchemaDefinition{
		SchemaID:      "tasks",
		Name:          "Tasks",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, jobDef); err != nil {
		t.Fatalf("failed to create tasks schema: %v", err)
	}

	usersCol, _ := app.FindCollectionByNameOrId("users")
	tasksCol, _ := app.FindCollectionByNameOrId("tasks")

	memberA := core.NewRecord(usersCol)
	memberA.Set("email", "workerA@example.com")
	memberA.Set("role", authz.RoleMember)
	memberA.Set("permissions", map[string]any{
		"tasks": map[string]any{"read": true, "update": true, "delete": true, "scope": "assigned"},
	})
	memberA.SetPassword("Password123!")
	_ = app.Save(memberA)

	memberB := core.NewRecord(usersCol)
	memberB.Set("email", "workerB@example.com")
	memberB.Set("role", authz.RoleMember)
	memberB.Set("permissions", map[string]any{
		"tasks": map[string]any{"read": true, "update": true, "delete": true, "scope": "assigned"},
	})
	memberB.SetPassword("Password123!")
	_ = app.Save(memberB)

	// Task 1 assigned to A, Task 2 assigned to B
	task1 := core.NewRecord(tasksCol)
	task1.Set("title", "Task 1 for A")
	task1.Set("assignee", memberA.Id)
	_ = app.Save(task1)

	task2 := core.NewRecord(tasksCol)
	task2.Set("title", "Task 2 for B")
	task2.Set("assignee", memberB.Id)
	_ = app.Save(task2)

	// 1. Member A tries to view Task 2 (assigned to B) -> must fail with not found
	viewEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberA},
		Record:       task2,
	}
	err := app.OnRecordViewRequest().Trigger(viewEvent, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Fatal("expected view error for task assigned to another member, got nil")
	}

	// 2. Member A tries to hijack Task 2 by submitting an update with assignee = memberA.Id
	hijackRecord := core.NewRecord(tasksCol)
	hijackRecord.Id = task2.Id
	hijackRecord.Set("title", "Hijacked Task 2")
	hijackRecord.Set("assignee", memberA.Id) // submitting caller's ID!

	updateEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberA},
		Record:       hijackRecord,
	}
	err = app.OnRecordUpdateRequest().Trigger(updateEvent, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Fatal("expected update rejection when member attempts to hijack another member's record, got nil")
	}

	// 3. Member A tries to reassign Task 1 (assigned to A) to Member B -> must fail
	reassignRecord := core.NewRecord(tasksCol)
	reassignRecord.Id = task1.Id
	reassignRecord.Set("title", "Reassigned Task 1")
	reassignRecord.Set("assignee", memberB.Id)

	reassignEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberA},
		Record:       reassignRecord,
	}
	err = app.OnRecordUpdateRequest().Trigger(reassignEvent, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Fatal("expected error when member attempts to reassign record, got nil")
	}

	// 4. Member A tries to delete Task 2 (assigned to B) -> must fail
	deleteEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberA},
		Record:       task2,
	}
	err = app.OnRecordDeleteRequest().Trigger(deleteEvent, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Fatal("expected error when member attempts to delete another member's record, got nil")
	}

	// 5. Member A legitimate update on Task 1 -> must succeed
	legitRecord := core.NewRecord(tasksCol)
	legitRecord.Id = task1.Id
	legitRecord.Set("title", "Updated Task 1")
	legitRecord.Set("assignee", memberA.Id)

	legitEvent := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberA},
		Record:       legitRecord,
	}
	err = app.OnRecordUpdateRequest().Trigger(legitEvent, func(e *core.RecordRequestEvent) error { return nil })
	if err != nil {
		t.Fatalf("expected legitimate update to succeed, got: %v", err)
	}
}

func TestCollectionRulesEnforcePermissionsAndRelationExpansion(t *testing.T) {
	app := newTestApp(t)
	schemaSvc := schemas.NewService(app)
	ctx := context.Background()

	// 1. Create customers dataset (no assignee field)
	custDef := schemas.SchemaDefinition{
		SchemaID: "clients",
		Name:     "Clients",
		Fields: []schemas.FieldDefinition{
			{Name: "client_name", Type: "text", Required: true},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, custDef); err != nil {
		t.Fatalf("failed to create clients schema: %v", err)
	}

	// 2. Create projects dataset with relation to clients and assignee field pointing to users
	projDef := schemas.SchemaDefinition{
		SchemaID:      "projects",
		Name:          "Projects",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
			{Name: "client", Type: "relation", Target: "clients"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, projDef); err != nil {
		t.Fatalf("failed to create projects schema: %v", err)
	}

	usersCol, _ := app.FindCollectionByNameOrId("users")
	clientsCol, _ := app.FindCollectionByNameOrId("clients")
	projectsCol, _ := app.FindCollectionByNameOrId("projects")

	// Member A: projects read (assigned scope), NO clients access
	mA := core.NewRecord(usersCol)
	mA.Set("email", "member_a_rule@example.com")
	mA.Set("role", authz.RoleMember)
	mA.Set("disabled", false)
	mA.Set("permissions", map[string]any{
		"projects": map[string]any{"read": true, "update": true, "scope": "assigned"},
	})
	mA.SetPassword("Password123!")
	_ = app.Save(mA)

	// Member B: projects read (assigned scope), clients read (all scope)
	mB := core.NewRecord(usersCol)
	mB.Set("email", "member_b_rule@example.com")
	mB.Set("role", authz.RoleMember)
	mB.Set("disabled", false)
	mB.Set("permissions", map[string]any{
		"projects": map[string]any{"read": true, "update": true, "scope": "assigned"},
		"clients":  map[string]any{"read": true, "scope": "all"},
	})
	mB.SetPassword("Password123!")
	_ = app.Save(mB)

	// Member Disabled: projects read (all scope), but account is disabled
	mDisabled := core.NewRecord(usersCol)
	mDisabled.Set("email", "member_disabled_rule@example.com")
	mDisabled.Set("role", authz.RoleMember)
	mDisabled.Set("disabled", true)
	mDisabled.Set("permissions", map[string]any{
		"projects": map[string]any{"read": true, "scope": "all"},
		"clients":  map[string]any{"read": true, "scope": "all"},
	})
	mDisabled.SetPassword("Password123!")
	_ = app.Save(mDisabled)

	// Owner
	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner_rule@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123!")
	_ = app.Save(owner)

	// Create test client record
	clientRec := core.NewRecord(clientsCol)
	clientRec.Set("client_name", "Acme Corp")
	if err := app.Save(clientRec); err != nil {
		t.Fatalf("failed to save client record: %v", err)
	}

	// Create test project 1 (assigned to Member A, linking to Acme Corp)
	proj1 := core.NewRecord(projectsCol)
	proj1.Set("title", "Project for Member A")
	proj1.Set("assignee", mA.Id)
	proj1.Set("client", clientRec.Id)
	if err := app.Save(proj1); err != nil {
		t.Fatalf("failed to save proj1: %v", err)
	}

	// Create test project 2 (assigned to Member B, linking to Acme Corp)
	proj2 := core.NewRecord(projectsCol)
	proj2.Set("title", "Project for Member B")
	proj2.Set("assignee", mB.Id)
	proj2.Set("client", clientRec.Id)
	if err := app.Save(proj2); err != nil {
		t.Fatalf("failed to save proj2: %v", err)
	}

	reqInfoA := &core.RequestInfo{Auth: mA}
	reqInfoB := &core.RequestInfo{Auth: mB}
	reqInfoDisabled := &core.RequestInfo{Auth: mDisabled}
	reqInfoOwner := &core.RequestInfo{Auth: owner}

	// --- 1. Collection ViewRule evaluation ---
	// Member A on proj1 (assigned to A) -> Allowed
	okA1, err := app.CanAccessRecord(proj1, reqInfoA, projectsCol.ViewRule)
	if err != nil || !okA1 {
		t.Fatalf("expected Member A to have View access to assigned proj1, got ok=%v, err=%v", okA1, err)
	}

	// Member A on proj2 (assigned to B) -> Denied
	okA2, _ := app.CanAccessRecord(proj2, reqInfoA, projectsCol.ViewRule)
	if okA2 {
		t.Fatal("expected Member A to be DENIED View access to proj2 assigned to Member B")
	}

	// Member A on clientRec -> Denied (Member A has NO permissions on clients)
	okAClient, _ := app.CanAccessRecord(clientRec, reqInfoA, clientsCol.ViewRule)
	if okAClient {
		t.Fatal("expected Member A to be DENIED View access to clientRec (no permission)")
	}

	// Member B on proj1 (assigned to A) -> Denied
	okB1, _ := app.CanAccessRecord(proj1, reqInfoB, projectsCol.ViewRule)
	if okB1 {
		t.Fatal("expected Member B to be DENIED View access to proj1 assigned to Member A")
	}

	// Member B on proj2 (assigned to B) -> Allowed
	okB2, err := app.CanAccessRecord(proj2, reqInfoB, projectsCol.ViewRule)
	if err != nil || !okB2 {
		t.Fatalf("expected Member B to have View access to assigned proj2, got ok=%v, err=%v", okB2, err)
	}

	// Member B on clientRec -> Allowed (Member B has read permission on clients)
	okBClient, err := app.CanAccessRecord(clientRec, reqInfoB, clientsCol.ViewRule)
	if err != nil || !okBClient {
		t.Fatalf("expected Member B to have View access to clientRec, got ok=%v, err=%v", okBClient, err)
	}

	// Disabled Member on proj1 and clientRec -> Denied
	okDisProj, _ := app.CanAccessRecord(proj1, reqInfoDisabled, projectsCol.ViewRule)
	if okDisProj {
		t.Fatal("expected disabled member to be DENIED access to proj1")
	}
	okDisClient, _ := app.CanAccessRecord(clientRec, reqInfoDisabled, clientsCol.ViewRule)
	if okDisClient {
		t.Fatal("expected disabled member to be DENIED access to clientRec")
	}

	// Owner -> Allowed on everything
	okOwnerProj, err := app.CanAccessRecord(proj1, reqInfoOwner, projectsCol.ViewRule)
	if err != nil || !okOwnerProj {
		t.Fatalf("expected Owner to have access to proj1, got ok=%v, err=%v", okOwnerProj, err)
	}
	okOwnerClient, err := app.CanAccessRecord(clientRec, reqInfoOwner, clientsCol.ViewRule)
	if err != nil || !okOwnerClient {
		t.Fatalf("expected Owner to have access to clientRec, got ok=%v, err=%v", okOwnerClient, err)
	}

	// --- 2. Relation Expansion Security ---
	// Expand fetch function as executed by PocketBase router for authenticated requests:
	// Only returns related records if caller satisfies the target collection's ViewRule.
	expandFetchForAuth := func(reqInfo *core.RequestInfo) core.ExpandFetchFunc {
		return func(relCol *core.Collection, relIds []string) ([]*core.Record, error) {
			records, err := app.FindRecordsByIds(relCol.Id, relIds)
			if err != nil {
				return nil, err
			}
			filtered := make([]*core.Record, 0, len(records))
			for _, r := range records {
				if canAccess, _ := app.CanAccessRecord(r, reqInfo, relCol.ViewRule); canAccess {
					filtered = append(filtered, r)
				}
			}
			return filtered, nil
		}
	}

	// Member A attempts to expand "client" on proj1:
	// Member A has access to proj1, but NOT clients -> client must NOT be expanded
	projCopyA := *proj1
	errsA := app.ExpandRecord(&projCopyA, []string{"client"}, expandFetchForAuth(reqInfoA))
	if len(errsA) > 0 {
		t.Fatalf("unexpected error during expand: %v", errsA)
	}
	expandedA := projCopyA.ExpandedOne("client")
	if expandedA != nil {
		t.Fatalf("security violation: Member A expanded client record without permissions! Got: %v", expandedA)
	}

	// Member B attempts to expand "client" on proj2:
	// Member B has access to proj2 AND clients -> client MUST be expanded
	projCopyB := *proj2
	errsB := app.ExpandRecord(&projCopyB, []string{"client"}, expandFetchForAuth(reqInfoB))
	if len(errsB) > 0 {
		t.Fatalf("unexpected error during expand: %v", errsB)
	}
	expandedB := projCopyB.ExpandedOne("client")
	if expandedB == nil || expandedB.Id != clientRec.Id {
		t.Fatalf("expected Member B to have client expanded, got: %v", expandedB)
	}

	// --- 3. Realtime Filtering Rule Verification ---
	// PocketBase filters realtime SSE events against collection.ViewRule for each subscriber's RequestInfo
	realtimeProj1ForA, _ := app.CanAccessRecord(proj1, reqInfoA, projectsCol.ViewRule)
	realtimeProj2ForA, _ := app.CanAccessRecord(proj2, reqInfoA, projectsCol.ViewRule)
	if !realtimeProj1ForA {
		t.Fatal("expected realtime event for proj1 to be delivered to Member A")
	}
	if realtimeProj2ForA {
		t.Fatal("expected realtime event for proj2 to be FILTERED OUT for Member A")
	}

	realtimeProj1ForB, _ := app.CanAccessRecord(proj1, reqInfoB, projectsCol.ViewRule)
	realtimeProj2ForB, _ := app.CanAccessRecord(proj2, reqInfoB, projectsCol.ViewRule)
	if realtimeProj1ForB {
		t.Fatal("expected realtime event for proj1 to be FILTERED OUT for Member B")
	}
	if !realtimeProj2ForB {
		t.Fatal("expected realtime event for proj2 to be delivered to Member B")
	}
}

func TestLiveSessionRealtimeEventRevocationAndExistingCollections(t *testing.T) {
	app := newTestApp(t)
	_, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("failed to init apis router: %v", err)
	}

	usersCol, _ := app.FindCollectionByNameOrId("users")

	// 1. Create legacy/existing collection directly with broad rules
	legacy := core.NewBaseCollection("legacy_orders")
	legacy.Fields.Add(&core.TextField{Name: "title", Required: true})
	legacy.Fields.Add(&core.RelationField{Name: "assignee", CollectionId: usersCol.Id, Required: true, MaxSelect: 1})
	legacy.ListRule = types.Pointer("@request.auth.id != ''")
	legacy.ViewRule = types.Pointer("@request.auth.id != ''")
	if err := app.Save(legacy); err != nil {
		t.Fatalf("failed to create legacy_orders collection: %v", err)
	}

	// Migrate legacy_orders to secure permission-aware rules
	listR, viewR, createR, updateR, deleteR := schemas.BuildCollectionRules("legacy_orders", "assignee")
	legacy.ListRule = listR
	legacy.ViewRule = viewR
	legacy.CreateRule = createR
	legacy.UpdateRule = updateR
	legacy.DeleteRule = deleteR
	if err := app.Save(legacy); err != nil {
		t.Fatalf("failed to migrate legacy_orders: %v", err)
	}

	// 2. Create newly generated schema via schemas.Service
	schemaSvc := schemas.NewService(app)
	ctx := context.Background()
	taskDef := schemas.SchemaDefinition{
		SchemaID:      "live_tasks",
		Name:          "Live Tasks",
		AssigneeField: "assignee",
		Fields: []schemas.FieldDefinition{
			{Name: "title", Type: "text", Required: true},
			{Name: "assignee", Type: "relation", Target: "users"},
		},
	}
	if _, err := schemaSvc.CreateSchema(ctx, taskDef); err != nil {
		t.Fatalf("failed to create live_tasks schema: %v", err)
	}
	liveTasksCol, _ := app.FindCollectionByNameOrId("live_tasks")

	// 3. Setup members
	member := core.NewRecord(usersCol)
	member.Set("email", "live_member@example.com")
	member.Set("role", authz.RoleMember)
	member.Set("disabled", false)
	member.Set("permissions", map[string]any{
		"legacy_orders": map[string]any{"read": true, "update": true, "scope": "assigned"},
		"live_tasks":    map[string]any{"read": true, "update": true, "scope": "assigned"},
	})
	member.SetPassword("Password123!")
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	colleague := core.NewRecord(usersCol)
	colleague.Set("email", "colleague@example.com")
	colleague.Set("role", authz.RoleMember)
	colleague.Set("disabled", false)
	colleague.SetPassword("Password123!")
	if err := app.Save(colleague); err != nil {
		t.Fatal(err)
	}

	// 4. Create records in both datasets
	order1 := core.NewRecord(legacy)
	order1.Set("title", "Member Order")
	order1.Set("assignee", member.Id)
	if err := app.Save(order1); err != nil {
		t.Fatal(err)
	}

	order2 := core.NewRecord(legacy)
	order2.Set("title", "Colleague Order")
	order2.Set("assignee", colleague.Id)
	if err := app.Save(order2); err != nil {
		t.Fatal(err)
	}

	task1 := core.NewRecord(liveTasksCol)
	task1.Set("title", "Member Task")
	task1.Set("assignee", member.Id)
	if err := app.Save(task1); err != nil {
		t.Fatal(err)
	}

	task2 := core.NewRecord(liveTasksCol)
	task2.Set("title", "Colleague Task")
	task2.Set("assignee", colleague.Id)
	if err := app.Save(task2); err != nil {
		t.Fatal(err)
	}

	// 5. Verify OnRecordsListRequest enforces assigned scope even if broad rules were present
	orderListEvent := &core.RecordsListRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: member},
		Records:      []*core.Record{order1, order2},
		Result:       &search.Result{Items: []any{order1, order2}, TotalItems: 2},
	}
	orderListEvent.Collection = legacy
	err = app.OnRecordsListRequest().Trigger(orderListEvent, func(e *core.RecordsListRequestEvent) error { return nil })
	if err != nil {
		t.Fatalf("unexpected list error: %v", err)
	}
	if len(orderListEvent.Records) != 1 || orderListEvent.Records[0].Id != order1.Id {
		t.Fatalf("expected legacy_orders list to filter to order1, got %d records", len(orderListEvent.Records))
	}

	// 6. Realtime live session test
	client := subscriptions.NewDefaultClient()
	client.Set(apis.RealtimeClientAuthKey, member)
	client.Subscribe("legacy_orders/*", "live_tasks/*")
	app.SubscriptionsBroker().Register(client)
	defer app.SubscriptionsBroker().Unregister(client.Id())

	waitForMessage := func(timeout time.Duration) bool {
		select {
		case <-client.Channel():
			return true
		case <-time.After(timeout):
			return false
		}
	}

	// Event for order1 (assigned to member) -> must receive
	order1.Set("title", "Member Order Mutated")
	if err := app.Save(order1); err != nil {
		t.Fatal(err)
	}
	if !waitForMessage(500 * time.Millisecond) {
		t.Fatal("expected subscriber to receive realtime event for assigned order1")
	}

	// Event for order2 (assigned to colleague) -> must NOT receive
	order2.Set("title", "Colleague Order Mutated")
	if err := app.Save(order2); err != nil {
		t.Fatal(err)
	}
	if waitForMessage(200 * time.Millisecond) {
		t.Fatal("security violation: subscriber received realtime event for colleague's order2!")
	}

	// Event for task1 (assigned to member) -> must receive
	task1.Set("title", "Member Task Mutated")
	if err := app.Save(task1); err != nil {
		t.Fatal(err)
	}
	if !waitForMessage(500 * time.Millisecond) {
		t.Fatal("expected subscriber to receive realtime event for assigned task1")
	}

	// --- 7. Permission Revocation ---
	// Revoke live_tasks permission from member
	member.Set("permissions", map[string]any{
		"legacy_orders": map[string]any{"read": true, "update": true, "scope": "assigned"},
	})
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	// Now mutate task1 -> event must NOT be delivered
	task1.Set("title", "Task 1 Mutated After Revocation")
	if err := app.Save(task1); err != nil {
		t.Fatal(err)
	}
	if waitForMessage(200 * time.Millisecond) {
		t.Fatal("security violation: subscriber received realtime event after permissions were revoked!")
	}

	// Mutate order1 -> event still delivered (permission still present)
	order1.Set("title", "Order 1 Mutated Still Permitted")
	if err := app.Save(order1); err != nil {
		t.Fatal(err)
	}
	if !waitForMessage(500 * time.Millisecond) {
		t.Fatal("expected subscriber to receive realtime event for legacy_orders")
	}

	// --- 8. Account Disabling ---
	// Disable member account
	member.Set("disabled", true)
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	// Now mutate order1 -> event must NOT be delivered
	order1.Set("title", "Order 1 Mutated After Disabled")
	if err := app.Save(order1); err != nil {
		t.Fatal(err)
	}
	if waitForMessage(200 * time.Millisecond) {
		t.Fatal("security violation: subscriber received realtime event after account was disabled!")
	}
}

func TestPageAndSchemaAdministrationAuthorization(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	authz.RegisterAuthnHooks(app)

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	appPagesCol, err := app.FindCollectionByNameOrId("app_pages")
	if err != nil {
		t.Fatal(err)
	}
	schemaDefsCol, err := app.FindCollectionByNameOrId("schema_definitions")
	if err != nil {
		t.Fatal(err)
	}
	dashboardsCol, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil {
		t.Fatal(err)
	}

	ordersCol := core.NewBaseCollection("orders")
	ordersCol.Fields.Add(&core.TextField{Name: "id"})
	ordersCol.Fields.Add(&core.TextField{Name: "title"})
	if err := app.Save(ordersCol); err != nil {
		t.Fatal(err)
	}

	// 1. Create accounts for each role
	owner := core.NewRecord(usersCol)
	owner.Set("email", "page_owner@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	admin := core.NewRecord(usersCol)
	admin.Set("email", "page_admin@example.com")
	admin.Set("role", authz.RoleAdmin)
	admin.Set("disabled", false)
	admin.SetPassword("Password123!")
	if err := app.Save(admin); err != nil {
		t.Fatal(err)
	}

	member := core.NewRecord(usersCol)
	member.Set("email", "page_member@example.com")
	member.Set("role", authz.RoleMember)
	member.Set("disabled", false)
	member.SetPassword("Password123!")
	if err := app.Save(member); err != nil {
		t.Fatal(err)
	}

	disabledOwner := core.NewRecord(usersCol)
	disabledOwner.Set("email", "page_dis_owner@example.com")
	disabledOwner.Set("role", authz.RoleOwner)
	disabledOwner.Set("disabled", true)
	disabledOwner.SetPassword("Password123!")
	if err := app.Save(disabledOwner); err != nil {
		t.Fatal(err)
	}

	disabledMember := core.NewRecord(usersCol)
	disabledMember.Set("email", "page_dis_member@example.com")
	disabledMember.Set("role", authz.RoleMember)
	disabledMember.Set("disabled", true)
	disabledMember.SetPassword("Password123!")
	if err := app.Save(disabledMember); err != nil {
		t.Fatal(err)
	}

	reqOwner := &core.RequestInfo{Auth: owner}
	reqAdmin := &core.RequestInfo{Auth: admin}
	reqMember := &core.RequestInfo{Auth: member}
	reqDisOwner := &core.RequestInfo{Auth: disabledOwner}
	reqDisMember := &core.RequestInfo{Auth: disabledMember}
	reqUnauth := &core.RequestInfo{Auth: nil}

	// 2. Create sample page record (published)
	pageRec := core.NewRecord(appPagesCol)
	pageRec.Set("page_id", "admin-orders-table")
	pageRec.Set("name", "Admin Orders")
	pageRec.Set("view_type", "table")
	pageRec.Set("collection", "orders")
	pageRec.Set("published", true)
	pageRec.Set("config", map[string]any{"columns": []string{"id", "title"}})
	if err := app.Save(pageRec); err != nil {
		t.Fatalf("failed to seed pageRec: %v", err)
	}

	// Create sample draft page record (unpublished)
	draftPageRec := core.NewRecord(appPagesCol)
	draftPageRec.Set("page_id", "draft-page")
	draftPageRec.Set("name", "Draft Page")
	draftPageRec.Set("view_type", "table")
	draftPageRec.Set("collection", "orders")
	draftPageRec.Set("published", false)
	draftPageRec.Set("config", map[string]any{"columns": []string{"id"}})
	if err := app.Save(draftPageRec); err != nil {
		t.Fatalf("failed to seed draftPageRec: %v", err)
	}

	// ==========================================
	// Part A: Collection Rule Checks on app_pages
	// ==========================================
	// ListRule
	checkRule := func(name string, rule *string, req *core.RequestInfo, record *core.Record) bool {
		ok, _ := app.CanAccessRecord(record, req, rule)
		return ok
	}

	// Owner & Admin: allowed for all operations
	for _, req := range []*core.RequestInfo{reqOwner, reqAdmin} {
		if !checkRule("List", appPagesCol.ListRule, req, pageRec) {
			t.Errorf("expected owner/admin to pass ListRule on app_pages")
		}
		if !checkRule("View", appPagesCol.ViewRule, req, pageRec) {
			t.Errorf("expected owner/admin to pass ViewRule on app_pages")
		}
		if !checkRule("Create", appPagesCol.CreateRule, req, pageRec) {
			t.Errorf("expected owner/admin to pass CreateRule on app_pages")
		}
		if !checkRule("Update", appPagesCol.UpdateRule, req, pageRec) {
			t.Errorf("expected owner/admin to pass UpdateRule on app_pages")
		}
		if !checkRule("Delete", appPagesCol.DeleteRule, req, pageRec) {
			t.Errorf("expected owner/admin to pass DeleteRule on app_pages")
		}
	}

	// Member: allowed to List and View published pages, strictly DENIED from unpublished drafts
	if !checkRule("List", appPagesCol.ListRule, reqMember, pageRec) {
		t.Errorf("expected member to pass ListRule on published app_pages")
	}
	if !checkRule("View", appPagesCol.ViewRule, reqMember, pageRec) {
		t.Errorf("expected member to pass ViewRule on published app_pages")
	}
	if checkRule("View", appPagesCol.ViewRule, reqMember, draftPageRec) {
		t.Errorf("security violation: member passed ViewRule on unpublished draft page")
	}
	if !checkRule("View", appPagesCol.ViewRule, reqAdmin, draftPageRec) {
		t.Errorf("expected admin to pass ViewRule on unpublished draft page")
	}
	if checkRule("Create", appPagesCol.CreateRule, reqMember, pageRec) {
		t.Errorf("security violation: member passed CreateRule on app_pages")
	}
	if checkRule("Update", appPagesCol.UpdateRule, reqMember, pageRec) {
		t.Errorf("security violation: member passed UpdateRule on app_pages")
	}
	if checkRule("Delete", appPagesCol.DeleteRule, reqMember, pageRec) {
		t.Errorf("security violation: member passed DeleteRule on app_pages")
	}

	// Disabled accounts: strictly DENIED from all operations
	for _, req := range []*core.RequestInfo{reqDisOwner, reqDisMember} {
		if checkRule("List", appPagesCol.ListRule, req, pageRec) {
			t.Errorf("security violation: disabled user passed ListRule on app_pages")
		}
		if checkRule("View", appPagesCol.ViewRule, req, pageRec) {
			t.Errorf("security violation: disabled user passed ViewRule on app_pages")
		}
		if checkRule("Create", appPagesCol.CreateRule, req, pageRec) {
			t.Errorf("security violation: disabled user passed CreateRule on app_pages")
		}
		if checkRule("Update", appPagesCol.UpdateRule, req, pageRec) {
			t.Errorf("security violation: disabled user passed UpdateRule on app_pages")
		}
		if checkRule("Delete", appPagesCol.DeleteRule, req, pageRec) {
			t.Errorf("security violation: disabled user passed DeleteRule on app_pages")
		}
	}

	// Unauthenticated: strictly DENIED from all operations
	if checkRule("List", appPagesCol.ListRule, reqUnauth, pageRec) {
		t.Errorf("security violation: unauthenticated user passed ListRule on app_pages")
	}
	if checkRule("View", appPagesCol.ViewRule, reqUnauth, pageRec) {
		t.Errorf("security violation: unauthenticated user passed ViewRule on app_pages")
	}
	if checkRule("Create", appPagesCol.CreateRule, reqUnauth, pageRec) {
		t.Errorf("security violation: unauthenticated user passed CreateRule on app_pages")
	}
	if checkRule("Update", appPagesCol.UpdateRule, reqUnauth, pageRec) {
		t.Errorf("security violation: unauthenticated user passed UpdateRule on app_pages")
	}
	if checkRule("Delete", appPagesCol.DeleteRule, reqUnauth, pageRec) {
		t.Errorf("security violation: unauthenticated user passed DeleteRule on app_pages")
	}

	// ==========================================
	// Part B: Hook-Level Enforcement on app_pages
	// ==========================================
	triggerCreatePage := func(auth *core.Record) error {
		dummy := core.NewRecord(appPagesCol)
		dummy.Set("page_id", "sample-page")
		dummy.Set("name", "Sample Page")
		dummy.Set("view_type", "table")
		dummy.Set("collection", "orders")
		dummy.Set("published", true)
		dummy.Set("config", map[string]any{"columns": []string{"id", "title"}})
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       dummy,
		}
		event.Collection = appPagesCol
		return app.OnRecordCreateRequest("app_pages").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	triggerUpdatePage := func(auth *core.Record) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       pageRec,
		}
		event.Collection = appPagesCol
		return app.OnRecordUpdateRequest("app_pages").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	triggerDeletePage := func(auth *core.Record) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       pageRec,
		}
		event.Collection = appPagesCol
		return app.OnRecordDeleteRequest("app_pages").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	// Allowed: Owner and Admin
	for _, user := range []*core.Record{owner, admin} {
		if err := triggerCreatePage(user); err != nil {
			t.Errorf("expected create page to succeed for %s, got: %v", user.GetString("role"), err)
		}
		if err := triggerUpdatePage(user); err != nil {
			t.Errorf("expected update page to succeed for %s, got: %v", user.GetString("role"), err)
		}
		if err := triggerDeletePage(user); err != nil {
			t.Errorf("expected delete page to succeed for %s, got: %v", user.GetString("role"), err)
		}
	}

	// Denied: Member (403 Forbidden)
	if err := triggerCreatePage(member); err == nil {
		t.Errorf("security violation: member was allowed to create page via hook")
	}
	if err := triggerUpdatePage(member); err == nil {
		t.Errorf("security violation: member was allowed to update page via hook")
	}
	if err := triggerDeletePage(member); err == nil {
		t.Errorf("security violation: member was allowed to delete page via hook")
	}

	// Denied: Disabled user (401 Unauthorized)
	if err := triggerCreatePage(disabledMember); err == nil {
		t.Errorf("security violation: disabled member was allowed to create page via hook")
	}
	if err := triggerUpdatePage(disabledMember); err == nil {
		t.Errorf("security violation: disabled member was allowed to update page via hook")
	}
	if err := triggerDeletePage(disabledMember); err == nil {
		t.Errorf("security violation: disabled member was allowed to delete page via hook")
	}

	// Denied: Unauthenticated (401 Unauthorized)
	if err := triggerCreatePage(nil); err == nil {
		t.Errorf("security violation: unauthenticated was allowed to create page via hook")
	}
	if err := triggerUpdatePage(nil); err == nil {
		t.Errorf("security violation: unauthenticated was allowed to update page via hook")
	}
	if err := triggerDeletePage(nil); err == nil {
		t.Errorf("security violation: unauthenticated was allowed to delete page via hook")
	}

	// Content validation checks for app_pages:
	// 1. Invalid view_type must be rejected
	invalidViewRec := core.NewRecord(appPagesCol)
	invalidViewRec.Set("page_id", "bad-view")
	invalidViewRec.Set("name", "Bad View")
	invalidViewRec.Set("view_type", "unsupported_view")
	invalidViewRec.Set("collection", "orders")
	invalidViewRec.Set("published", true)
	invalidViewRec.Set("config", map[string]any{})
	evInvalidView := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       invalidViewRec,
	}
	evInvalidView.Collection = appPagesCol
	if err := app.OnRecordCreateRequest("app_pages").Trigger(evInvalidView, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for unsupported view_type, but got nil")
	}

	// 2. Nonexistent collection must be rejected
	nonexistentColRec := core.NewRecord(appPagesCol)
	nonexistentColRec.Set("page_id", "bad-col")
	nonexistentColRec.Set("name", "Bad Col")
	nonexistentColRec.Set("view_type", "table")
	nonexistentColRec.Set("collection", "nonexistent_table")
	nonexistentColRec.Set("published", true)
	nonexistentColRec.Set("config", map[string]any{})
	evNonexistentCol := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       nonexistentColRec,
	}
	evNonexistentCol.Collection = appPagesCol
	if err := app.OnRecordCreateRequest("app_pages").Trigger(evNonexistentCol, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for nonexistent collection, but got nil")
	}

	// 3. Invalid dashboard widget bounds must be rejected
	invalidDashRec := core.NewRecord(dashboardsCol)
	invalidDashRec.Set("name", "bad-dash")
	invalidDashRec.Set("layout", map[string]any{
		"id":   "bad-dash",
		"name": "bad-dash",
		"layout": []map[string]any{
			{
				"id":         "w1",
				"type":       "kpi",
				"collection": "orders",
				"x":          -1, // invalid negative x
				"y":          0,
				"w":          15, // invalid width > 12
				"h":          2,
			},
		},
	})
	evInvalidDash := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       invalidDashRec,
	}
	evInvalidDash.Collection = dashboardsCol
	if err := app.OnRecordCreateRequest("dashboards").Trigger(evInvalidDash, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for invalid dashboard widget bounds, but got nil")
	}

	// 3b. Dashboard layout missing 'layout' array must be rejected (no silent substitution)
	missingLayoutDashRec := core.NewRecord(dashboardsCol)
	missingLayoutDashRec.Set("name", "missing-layout-dash")
	missingLayoutDashRec.Set("layout", map[string]any{
		"id":   "missing-layout-dash",
		"name": "Missing Layout Dash",
	})
	evMissingLayout := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       missingLayoutDashRec,
	}
	evMissingLayout.Collection = dashboardsCol
	if err := app.OnRecordCreateRequest("dashboards").Trigger(evMissingLayout, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for dashboard layout object lacking 'layout' array, but got nil")
	}

	// 3c. Valid dashboard layout object is normalized and persisted
	validDashRec := core.NewRecord(dashboardsCol)
	validDashRec.Set("name", "valid-dash")
	validDashRec.Set("layout", map[string]any{
		"id":     "valid-dash",
		"name":   "Valid Dash",
		"layout": []any{},
	})
	evValidDash := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       validDashRec,
	}
	evValidDash.Collection = dashboardsCol
	if err := app.OnRecordCreateRequest("dashboards").Trigger(evValidDash, func(e *core.RecordRequestEvent) error { return nil }); err != nil {
		t.Errorf("expected valid dashboard layout to pass, got: %v", err)
	}
	if !strings.Contains(validDashRec.GetString("layout"), `"layout":[]`) {
		t.Errorf("expected normalized layout to be persisted on record, got: %s", validDashRec.GetString("layout"))
	}

	// 3d. Master-detail page validation against child collection relation target
	mdParentCol := core.NewBaseCollection("md_parent")
	mdParentCol.Fields.Add(&core.TextField{Name: "name"})
	if err := app.Save(mdParentCol); err != nil {
		t.Fatal(err)
	}
	mdChildCol := core.NewBaseCollection("md_child")
	mdChildCol.Fields.Add(&core.TextField{Name: "title"})
	mdChildCol.Fields.Add(&core.RelationField{Name: "parent_rel", CollectionId: mdParentCol.Id})
	mdChildCol.Fields.Add(&core.RelationField{Name: "orders_rel", CollectionId: ordersCol.Id})
	mdChildCol.Fields.Add(&core.TextField{Name: "not_a_rel"})
	if err := app.Save(mdChildCol); err != nil {
		t.Fatal(err)
	}

	// Master-detail: valid configuration pointing child relation to parent collection -> PASS
	validMdRec := core.NewRecord(appPagesCol)
	validMdRec.Set("page_id", "valid-md")
	validMdRec.Set("name", "Valid Master Detail")
	validMdRec.Set("view_type", "master_detail")
	validMdRec.Set("collection", "md_parent")
	validMdRec.Set("published", true)
	validMdRec.Set("config", map[string]any{
		"detailCollection": "md_child",
		"relationField":    "parent_rel",
	})
	evValidMd := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       validMdRec,
	}
	evValidMd.Collection = appPagesCol
	if err := app.OnRecordCreateRequest("app_pages").Trigger(evValidMd, func(e *core.RecordRequestEvent) error { return nil }); err != nil {
		t.Errorf("expected valid master-detail configuration to pass, got: %v", err)
	}

	// Master-detail: invalid child relation pointing to wrong collection (orders instead of md_parent) -> REJECT
	wrongTargetMdRec := core.NewRecord(appPagesCol)
	wrongTargetMdRec.Set("page_id", "wrong-target-md")
	wrongTargetMdRec.Set("name", "Wrong Target MD")
	wrongTargetMdRec.Set("view_type", "master_detail")
	wrongTargetMdRec.Set("collection", "md_parent")
	wrongTargetMdRec.Set("published", true)
	wrongTargetMdRec.Set("config", map[string]any{
		"detailCollection": "md_child",
		"relationField":    "orders_rel",
	})
	evWrongTargetMd := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       wrongTargetMdRec,
	}
	evWrongTargetMd.Collection = appPagesCol
	if err := app.OnRecordCreateRequest("app_pages").Trigger(evWrongTargetMd, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for master-detail relation pointing to wrong collection, but got nil")
	}

	// Master-detail: child field is not a relation field -> REJECT
	notRelMdRec := core.NewRecord(appPagesCol)
	notRelMdRec.Set("page_id", "not-rel-md")
	notRelMdRec.Set("name", "Not Rel MD")
	notRelMdRec.Set("view_type", "master_detail")
	notRelMdRec.Set("collection", "md_parent")
	notRelMdRec.Set("published", true)
	notRelMdRec.Set("config", map[string]any{
		"detailCollection": "md_child",
		"relationField":    "not_a_rel",
	})
	evNotRelMd := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       notRelMdRec,
	}
	evNotRelMd.Collection = appPagesCol
	if err := app.OnRecordCreateRequest("app_pages").Trigger(evNotRelMd, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected rejection for master-detail relation field that is not a relation type, but got nil")
	}

	// 3e. Direct workspace_modules mutation protection
	wsModCol, err := app.FindCollectionByNameOrId("workspace_modules")
	if err == nil && wsModCol != nil {
		// Attempt direct creation of managed module customer_job_tracking -> MUST BE BLOCKED
		managedModRec := core.NewRecord(wsModCol)
		managedModRec.Set("module_id", "customer_job_tracking")
		managedModRec.Set("enabled", true)
		managedModRec.Set("version", "1.0.0")
		managedModRec.Set("mapping", map[string]any{})
		evManagedModCreate := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: owner},
			Record:       managedModRec,
		}
		evManagedModCreate.Collection = wsModCol
		if err := app.OnRecordCreateRequest("workspace_modules").Trigger(evManagedModCreate, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
			t.Errorf("security violation: direct creation of managed module 'customer_job_tracking' was allowed via records API")
		}

		// Direct creation of unmanaged custom module by owner -> ALLOWED
		unmanagedModRec := core.NewRecord(wsModCol)
		unmanagedModRec.Set("module_id", "custom_module_xyz")
		unmanagedModRec.Set("enabled", true)
		unmanagedModRec.Set("version", "1.0.0")
		unmanagedModRec.Set("mapping", map[string]any{})
		evUnmanagedModCreate := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: owner},
			Record:       unmanagedModRec,
		}
		evUnmanagedModCreate.Collection = wsModCol
		if err := app.OnRecordCreateRequest("workspace_modules").Trigger(evUnmanagedModCreate, func(e *core.RecordRequestEvent) error { return nil }); err != nil {
			t.Errorf("expected direct creation of unmanaged module by owner to succeed, got: %v", err)
		}

		// Direct creation of unmanaged custom module by regular member -> BLOCKED (403)
		evMemberModCreate := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: member},
			Record:       unmanagedModRec,
		}
		evMemberModCreate.Collection = wsModCol
		if err := app.OnRecordCreateRequest("workspace_modules").Trigger(evMemberModCreate, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
			t.Errorf("security violation: regular member was allowed to create workspace_modules record")
		}

		// 3f. Rename / Update protection on managed modules in workspace_modules
		// Seed an installed customer_job_tracking record in the database
		installedManaged := core.NewRecord(wsModCol)
		installedManaged.Set("module_id", "customer_job_tracking")
		installedManaged.Set("enabled", true)
		installedManaged.Set("version", "1.0.0")
		installedManaged.Set("mapping", map[string]any{"customers": "customers"})
		if err := app.Save(installedManaged); err != nil {
			t.Fatal(err)
		}

		// Attempt updating installed managed module by renaming module_id to unmanaged -> MUST BE REJECTED
		renameAttempt := core.NewRecord(wsModCol)
		renameAttempt.Id = installedManaged.Id
		renameAttempt.Set("module_id", "unmanaged_renamed_id")
		renameAttempt.Set("enabled", false)
		renameAttempt.Set("version", "1.0.0")
		renameAttempt.Set("mapping", map[string]any{"customers": "customers"})
		evRename := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: owner},
			Record:       renameAttempt,
		}
		evRename.Collection = wsModCol
		if err := app.OnRecordUpdateRequest("workspace_modules").Trigger(evRename, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
			t.Errorf("security violation: renaming managed module to bypass guards was allowed")
		}

		// Attempt updating other fields on installed managed module directly -> MUST BE REJECTED
		directUpdateAttempt := core.NewRecord(wsModCol)
		directUpdateAttempt.Id = installedManaged.Id
		directUpdateAttempt.Set("module_id", "customer_job_tracking")
		directUpdateAttempt.Set("enabled", false)
		directUpdateAttempt.Set("version", "1.0.0")
		directUpdateAttempt.Set("mapping", map[string]any{"customers": "customers"})
		evDirectUpdate := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: owner},
			Record:       directUpdateAttempt,
		}
		evDirectUpdate.Collection = wsModCol
		if err := app.OnRecordUpdateRequest("workspace_modules").Trigger(evDirectUpdate, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
			t.Errorf("security violation: direct update of managed module was allowed")
		}

		// Attempt direct deletion of installed managed module -> MUST BE REJECTED
		evDeleteManaged := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: owner},
			Record:       installedManaged,
		}
		evDeleteManaged.Collection = wsModCol
		if err := app.OnRecordDeleteRequest("workspace_modules").Trigger(evDeleteManaged, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
			t.Errorf("security violation: direct deletion of managed module was allowed")
		}
	}

	// 3g. File download enforcement (Lattice dataset permissions and assigned-record scoping)
	contractsCol := core.NewBaseCollection("contracts")
	contractsCol.Fields.Add(&core.TextField{Name: "title"})
	contractsCol.Fields.Add(&core.TextField{Name: "owner_user"})
	contractsCol.Fields.Add(&core.FileField{Name: "pdf", Protected: true})
	// Simulate an imported collection that had a public ViewRule
	broadRule := "@request.auth.id != ''"
	contractsCol.ViewRule = &broadRule
	if err := app.Save(contractsCol); err != nil {
		t.Fatal(err)
	}

	// Register schema definition for contracts with assignee_field = "owner_user"
	schemaDefRec := core.NewRecord(schemaDefsCol)
	schemaDefRec.Set("schema_id", "contracts")
	schemaDefRec.Set("name", "Contracts")
	schemaDefRec.Set("assignee_field", "owner_user")
	schemaDefRec.Set("fields", []any{
		map[string]any{"name": "title", "type": "text"},
		map[string]any{"name": "pdf", "type": "file"},
	})
	if err := app.Save(schemaDefRec); err != nil {
		t.Fatal(err)
	}

	// Create member User A and User B
	userA := core.NewRecord(usersCol)
	userA.Set("email", "usera_files@example.com")
	userA.Set("role", authz.RoleMember)
	userA.Set("permissions", map[string]any{
		"contracts": map[string]any{"read": true, "scope": "assigned"},
	})
	userA.SetPassword("Password123!")
	if err := app.Save(userA); err != nil {
		t.Fatal(err)
	}

	userB := core.NewRecord(usersCol)
	userB.Set("email", "userb_files@example.com")
	userB.Set("role", authz.RoleMember)
	userB.Set("permissions", map[string]any{
		"contracts": map[string]any{"read": true, "scope": "assigned"},
	})
	userB.SetPassword("Password123!")
	if err := app.Save(userB); err != nil {
		t.Fatal(err)
	}

	// Seed record 1 (assigned to User A) and record 2 (assigned to User B)
	contractRec1 := core.NewRecord(contractsCol)
	contractRec1.Set("title", "Contract 1")
	contractRec1.Set("owner_user", userA.Id)
	contractRec1.Set("pdf", "doc1.pdf")
	if err := app.SaveNoValidate(contractRec1); err != nil {
		t.Fatal(err)
	}

	contractRec2 := core.NewRecord(contractsCol)
	contractRec2.Set("title", "Contract 2")
	contractRec2.Set("owner_user", userB.Id)
	contractRec2.Set("pdf", "doc2.pdf")
	if err := app.SaveNoValidate(contractRec2); err != nil {
		t.Fatal(err)
	}

	triggerFileDownload := func(authRec *core.Record, rec *core.Record) error {
		req := &core.RequestEvent{
			App:  app,
			Auth: authRec,
		}
		ev := &core.FileDownloadRequestEvent{
			RequestEvent: req,
			Collection:   contractsCol,
			Record:       rec,
			FileField:    contractsCol.Fields.GetByName("pdf").(*core.FileField),
		}
		return app.OnFileDownloadRequest().Trigger(ev, func(e *core.FileDownloadRequestEvent) error {
			return nil
		})
	}

	// 1. Unauthenticated download: MUST BE DENIED
	if err := triggerFileDownload(nil, contractRec1); err == nil {
		t.Errorf("security violation: unauthenticated file download was allowed on business dataset")
	}

	// 2. User A downloads their own assigned record: MUST BE ALLOWED
	if err := triggerFileDownload(userA, contractRec1); err != nil {
		t.Errorf("expected User A to be allowed to download their assigned file, got: %v", err)
	}

	// 3. User A downloads User B's record (assigned scope): MUST BE DENIED
	if err := triggerFileDownload(userA, contractRec2); err == nil {
		t.Errorf("security violation: User A was allowed to download User B's file with assigned scope")
	}

	// 4. User without read permission: MUST BE DENIED
	userNoRead := core.NewRecord(usersCol)
	userNoRead.Set("email", "noread_files@example.com")
	userNoRead.Set("role", authz.RoleMember)
	userNoRead.Set("permissions", map[string]any{
		"contracts": map[string]any{"read": false, "scope": "all"},
	})
	userNoRead.SetPassword("Password123!")
	if err := app.Save(userNoRead); err != nil {
		t.Fatal(err)
	}
	if err := triggerFileDownload(userNoRead, contractRec1); err == nil {
		t.Errorf("security violation: user without read permission was allowed to download file")
	}

	// 5. Admin downloads any record: MUST BE ALLOWED
	if err := triggerFileDownload(admin, contractRec1); err != nil {
		t.Errorf("expected admin to download file, got: %v", err)
	}
	if err := triggerFileDownload(admin, contractRec2); err != nil {
		t.Errorf("expected admin to download file, got: %v", err)
	}

	// 6. Fail-closed: Assigned-scope download when schema metadata is MISSING
	reportsCol := core.NewBaseCollection("reports")
	reportsCol.Fields.Add(&core.TextField{Name: "title"})
	reportsCol.Fields.Add(&core.FileField{Name: "pdf", Protected: true})
	reportsCol.ViewRule = &broadRule
	if err := app.Save(reportsCol); err != nil {
		t.Fatal(err)
	}

	reportRec := core.NewRecord(reportsCol)
	reportRec.Set("title", "Report 1")
	reportRec.Set("pdf", "report1.pdf")
	if err := app.SaveNoValidate(reportRec); err != nil {
		t.Fatal(err)
	}

	userAssignedReports := core.NewRecord(usersCol)
	userAssignedReports.Set("email", "assigned_reports@example.com")
	userAssignedReports.Set("role", authz.RoleMember)
	userAssignedReports.Set("permissions", map[string]any{
		"reports": map[string]any{"read": true, "scope": "assigned"},
	})
	userAssignedReports.SetPassword("Password123!")
	if err := app.Save(userAssignedReports); err != nil {
		t.Fatal(err)
	}

	triggerReportDownload := func(authRec *core.Record, rec *core.Record) error {
		req := &core.RequestEvent{App: app, Auth: authRec}
		var ff *core.FileField
		if reportsCol.Fields.GetByName("pdf") != nil {
			ff = reportsCol.Fields.GetByName("pdf").(*core.FileField)
		}
		ev := &core.FileDownloadRequestEvent{
			RequestEvent: req,
			Collection:   reportsCol,
			Record:       rec,
			FileField:    ff,
		}
		return app.OnFileDownloadRequest().Trigger(ev, func(e *core.FileDownloadRequestEvent) error { return nil })
	}

	// Missing metadata: MUST FAIL CLOSED (404 / error)
	if err := triggerReportDownload(userAssignedReports, reportRec); err == nil {
		t.Errorf("security violation: assigned scope member was allowed to download file when schema metadata is missing")
	}

	// 7. Fail-closed: Assigned-scope download when schema metadata has empty assignee_field
	invoicesCol := core.NewBaseCollection("invoices")
	invoicesCol.Fields.Add(&core.TextField{Name: "title"})
	invoicesCol.Fields.Add(&core.FileField{Name: "pdf", Protected: true})
	invoicesCol.ViewRule = &broadRule
	if err := app.Save(invoicesCol); err != nil {
		t.Fatal(err)
	}

	invoiceRec := core.NewRecord(invoicesCol)
	invoiceRec.Set("title", "Invoice 1")
	invoiceRec.Set("pdf", "inv1.pdf")
	if err := app.SaveNoValidate(invoiceRec); err != nil {
		t.Fatal(err)
	}

	schemaDefInvoice := core.NewRecord(schemaDefsCol)
	schemaDefInvoice.Set("schema_id", "invoices")
	schemaDefInvoice.Set("name", "Invoices")
	schemaDefInvoice.Set("assignee_field", "") // EMPTY assignee_field
	schemaDefInvoice.Set("fields", []any{map[string]any{"name": "title", "type": "text"}})
	if err := app.Save(schemaDefInvoice); err != nil {
		t.Fatal(err)
	}

	userAssignedInvoices := core.NewRecord(usersCol)
	userAssignedInvoices.Set("email", "assigned_invoices@example.com")
	userAssignedInvoices.Set("role", authz.RoleMember)
	userAssignedInvoices.Set("permissions", map[string]any{
		"invoices": map[string]any{"read": true, "scope": "assigned"},
	})
	userAssignedInvoices.SetPassword("Password123!")
	if err := app.Save(userAssignedInvoices); err != nil {
		t.Fatal(err)
	}

	triggerInvoiceDownload := func(authRec *core.Record, rec *core.Record) error {
		req := &core.RequestEvent{App: app, Auth: authRec}
		var ff *core.FileField
		if invoicesCol.Fields.GetByName("pdf") != nil {
			ff = invoicesCol.Fields.GetByName("pdf").(*core.FileField)
		}
		ev := &core.FileDownloadRequestEvent{
			RequestEvent: req,
			Collection:   invoicesCol,
			Record:       rec,
			FileField:    ff,
		}
		return app.OnFileDownloadRequest().Trigger(ev, func(e *core.FileDownloadRequestEvent) error { return nil })
	}

	// Empty assignee_field in metadata: MUST FAIL CLOSED (404 / error)
	if err := triggerInvoiceDownload(userAssignedInvoices, invoiceRec); err == nil {
		t.Errorf("security violation: assigned scope member was allowed to download file when assignee_field is empty")
	}

	// 8. Fail-closed: nil record passed
	if err := triggerFileDownload(userA, nil); err == nil {
		t.Errorf("security violation: assigned scope download succeeded with nil record")
	}

	// 4. Dataset-aware visibility on app_pages:
	// Member has no read permission on orders. List and view must hide page.
	memberNoPerm := core.NewRecord(usersCol)
	memberNoPerm.Set("email", "noperm@example.com")
	memberNoPerm.Set("role", authz.RoleMember)
	memberNoPerm.Set("permissions", map[string]any{
		"orders": map[string]any{"read": false, "scope": "all"},
	})
	memberNoPerm.SetPassword("Password123!")
	if err := app.Save(memberNoPerm); err != nil {
		t.Fatal(err)
	}

	evList := &core.RecordsListRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberNoPerm},
		Collection:   appPagesCol,
		Records:      []*core.Record{pageRec},
	}
	if err := app.OnRecordsListRequest("app_pages").Trigger(evList, func(e *core.RecordsListRequestEvent) error {
		if len(e.Records) != 0 {
			t.Errorf("security violation: member with read:false on orders saw page in list")
		}
		return nil
	}); err != nil {
		t.Fatalf("unexpected error on list trigger: %v", err)
	}

	evView := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: memberNoPerm},
		Record:       pageRec,
	}
	evView.Collection = appPagesCol
	if err := app.OnRecordViewRequest("app_pages").Trigger(evView, func(e *core.RecordRequestEvent) error {
		return nil
	}); err == nil {
		t.Errorf("security violation: member with read:false on orders was allowed to view page")
	}

	evEnrich := &core.RecordEnrichEvent{
		App:         app,
		Record:      pageRec,
		RequestInfo: &core.RequestInfo{Auth: memberNoPerm},
	}
	if err := app.OnRecordEnrich("app_pages").Trigger(evEnrich, func(e *core.RecordEnrichEvent) error {
		return nil
	}); err == nil {
		t.Errorf("security violation: enrich succeeded for member without dataset permission (would leak over realtime)")
	}

	// ==========================================
	// Part C: Hook-Level Enforcement on schema_definitions
	// ==========================================
	schemaRec := core.NewRecord(schemaDefsCol)
	schemaRec.Set("schema_id", "test_schema")
	schemaRec.Set("name", "Test Schema")
	schemaRec.Set("fields", []any{})

	triggerCreateSchemaDef := func(auth *core.Record, superuser bool) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       schemaRec,
		}
		event.Collection = schemaDefsCol
		if superuser {
			superuserCol, _ := app.FindCollectionByNameOrId("_superusers")
			suRec := core.NewRecord(superuserCol)
			event.RequestEvent.Auth = suRec
		}
		return app.OnRecordCreateRequest("schema_definitions").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	triggerUpdateSchemaDef := func(auth *core.Record, superuser bool) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       schemaRec,
		}
		event.Collection = schemaDefsCol
		if superuser {
			superuserCol, _ := app.FindCollectionByNameOrId("_superusers")
			suRec := core.NewRecord(superuserCol)
			event.RequestEvent.Auth = suRec
		}
		return app.OnRecordUpdateRequest("schema_definitions").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	triggerDeleteSchemaDef := func(auth *core.Record, superuser bool) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       schemaRec,
		}
		event.Collection = schemaDefsCol
		if superuser {
			superuserCol, _ := app.FindCollectionByNameOrId("_superusers")
			suRec := core.NewRecord(superuserCol)
			event.RequestEvent.Auth = suRec
		}
		return app.OnRecordDeleteRequest("schema_definitions").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	// Owner, Admin, Member, Disabled: ALL denied direct mutation of schema_definitions
	for _, user := range []*core.Record{owner, admin, member, disabledOwner} {
		if err := triggerCreateSchemaDef(user, false); err == nil {
			t.Errorf("security violation: direct creation of schema_definitions was allowed for %s", user.GetString("role"))
		}
		if err := triggerUpdateSchemaDef(user, false); err == nil {
			t.Errorf("security violation: direct update of schema_definitions was allowed for %s", user.GetString("role"))
		}
		if err := triggerDeleteSchemaDef(user, false); err == nil {
			t.Errorf("security violation: direct delete of schema_definitions was allowed for %s", user.GetString("role"))
		}
	}

	// Superuser bypass: allowed
	if err := triggerCreateSchemaDef(nil, true); err != nil {
		t.Errorf("expected superuser to be allowed on schema_definitions create hook, got: %v", err)
	}
	if err := triggerUpdateSchemaDef(nil, true); err != nil {
		t.Errorf("expected superuser to be allowed on schema_definitions update hook, got: %v", err)
	}
	if err := triggerDeleteSchemaDef(nil, true); err != nil {
		t.Errorf("expected superuser to be allowed on schema_definitions delete hook, got: %v", err)
	}

	// ==========================================
	// Part D: Hook-Level Enforcement on dashboards
	// ==========================================
	dashRec := core.NewRecord(dashboardsCol)
	dashRec.Set("name", "Test Dashboard")
	dashRec.Set("layout", []any{})

	triggerCreateDash := func(auth *core.Record) error {
		event := &core.RecordRequestEvent{
			RequestEvent: &core.RequestEvent{App: app, Auth: auth},
			Record:       dashRec,
		}
		event.Collection = dashboardsCol
		return app.OnRecordCreateRequest("dashboards").Trigger(event, func(e *core.RecordRequestEvent) error {
			return nil
		})
	}

	// Owner and admin allowed
	if err := triggerCreateDash(owner); err != nil {
		t.Errorf("expected owner to be allowed to create dashboard, got: %v", err)
	}
	if err := triggerCreateDash(admin); err != nil {
		t.Errorf("expected admin to be allowed to create dashboard, got: %v", err)
	}
	// Member denied (403)
	if err := triggerCreateDash(member); err == nil {
		t.Errorf("security violation: member was allowed to create dashboard")
	}
	// Disabled denied (401)
	if err := triggerCreateDash(disabledOwner); err == nil {
		t.Errorf("security violation: disabled owner was allowed to create dashboard")
	}

	// Verify revision starts at 1 on creation
	if dashRec.GetInt("revision") != 1 {
		t.Errorf("expected new dashboard to have revision 1, got %d", dashRec.GetInt("revision"))
	}
	if err := app.Save(dashRec); err != nil {
		t.Fatalf("failed to save test dashboard record: %v", err)
	}

	// Concurrency control on dashboard updates:
	// 1. Missing expected_revision -> 400 Bad Request
	evNoRev := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       dashRec,
	}
	evNoRev.Collection = dashboardsCol
	if err := app.OnRecordUpdateRequest("dashboards").Trigger(evNoRev, func(e *core.RecordRequestEvent) error { return nil }); err == nil {
		t.Errorf("expected update without expected_revision to fail")
	}

	// 2. Mismatched expected_revision -> 409 Conflict
	evMismatch := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       dashRec,
	}
	evMismatch.Collection = dashboardsCol
	evMismatch.Set("expected_revision", 99)
	err = app.OnRecordUpdateRequest("dashboards").Trigger(evMismatch, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Errorf("expected mismatched expected_revision to fail with conflict")
	} else {
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) && apiErr.Status != 409 {
			t.Errorf("expected HTTP 409 Conflict, got status %d", apiErr.Status)
		}
	}

	// 3. Matching expected_revision (1) -> succeeds and revision advances to 2
	evMatching := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: owner},
		Record:       dashRec,
	}
	evMatching.Collection = dashboardsCol
	evMatching.Set("expected_revision", 1)
	if err := app.OnRecordUpdateRequest("dashboards").Trigger(evMatching, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	}); err != nil {
		t.Fatalf("expected update with matching expected_revision=1 to succeed, got: %v", err)
	}
	if dashRec.GetInt("revision") != 2 {
		t.Errorf("expected revision to advance to 2, got %d", dashRec.GetInt("revision"))
	}

	// 4. Concurrent write with stale revision (1) -> fails with 409 Conflict
	evStale := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: admin},
		Record:       dashRec,
	}
	evStale.Collection = dashboardsCol
	evStale.Set("expected_revision", 1)
	err = app.OnRecordUpdateRequest("dashboards").Trigger(evStale, func(e *core.RecordRequestEvent) error { return nil })
	if err == nil {
		t.Errorf("expected concurrent update with stale revision to fail with 409 Conflict")
	} else {
		var apiErr *router.ApiError
		if errors.As(err, &apiErr) && apiErr.Status != 409 {
			t.Errorf("expected HTTP 409 Conflict, got status %d", apiErr.Status)
		}
	}
}

func TestValidateAssignedScopePermissions_MalformedPermissions(t *testing.T) {
	app := newTestApp(t)

	badInputs := []any{
		"not-json-string",
		12345,
		true,
		[]string{"scope", "assigned"},
		[]any{map[string]any{"scope": "assigned"}},
		map[string]any{"jobs": "assigned"},
		map[string]any{"jobs": 123},
		map[string]any{"jobs": []string{"assigned"}},
	}

	for _, bad := range badInputs {
		err := authz.ValidateAssignedScopePermissions(app, bad)
		if err == nil {
			t.Errorf("expected error for malformed permissions input %v, got nil", bad)
		}
	}

	if err := authz.ValidateAssignedScopePermissions(app, nil); err != nil {
		t.Errorf("expected nil permissions to pass, got: %v", err)
	}
	if err := authz.ValidateAssignedScopePermissions(app, map[string]any{}); err != nil {
		t.Errorf("expected empty permissions map to pass, got: %v", err)
	}
}

func TestValidateAssignedScopePermissions_FullContractValidation(t *testing.T) {
	app := newTestApp(t)

	// 1. String in boolean field 'read'
	badRead := map[string]any{
		"jobs": map[string]any{"read": "true", "scope": "all"},
	}
	if err := authz.ValidateAssignedScopePermissions(app, badRead); err == nil {
		t.Error("expected error for string in 'read', got nil")
	}

	// 2. Unsupported scope value
	badScope := map[string]any{
		"jobs": map[string]any{"read": true, "scope": "manager"},
	}
	if err := authz.ValidateAssignedScopePermissions(app, badScope); err == nil {
		t.Error("expected error for unsupported scope 'manager', got nil")
	}

	// 3. Unknown property on permission entry
	unknownProp := map[string]any{
		"jobs": map[string]any{"read": true, "scope": "all", "unknown_field": "val"},
	}
	if err := authz.ValidateAssignedScopePermissions(app, unknownProp); err == nil {
		t.Error("expected error for unknown property 'unknown_field', got nil")
	}

	// 4. Valid permission contract
	valid := map[string]any{
		"jobs": map[string]any{"read": true, "create": true, "update": false, "delete": false, "scope": "all"},
	}
	if err := authz.ValidateAssignedScopePermissions(app, valid); err != nil {
		t.Errorf("expected valid permission entry to pass, got: %v", err)
	}
}

func TestAcceptInvitation_RevokedDuringRace(t *testing.T) {
	app := newTestApp(t)
	usersCol, _ := app.FindCollectionByNameOrId("users")

	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner_race@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.SetPassword("Password123!")
	_ = app.Save(owner)

	inv, err := authz.CreateInvitation(app, owner, "invitee_race@example.com", authz.RoleMember, nil)
	if err != nil {
		t.Fatalf("failed to create invitation: %v", err)
	}
	token := inv.GetString("token")

	// Revoke the invitation inside a transaction (simulating a concurrent revocation)
	_ = app.RunInTransaction(func(txApp core.App) error {
		freshInv, _ := txApp.FindRecordById("invitations", inv.Id)
		freshInv.Set("revoked", true)
		return txApp.Save(freshInv)
	})

	// Attempt to accept with the token -> must fail with ErrInvalidInvitation because it rechecks inside the transaction
	_, err = authz.AcceptInvitation(app, token, "Invitee Race", "Password12345!")
	if err == nil {
		t.Fatal("expected error accepting revoked invitation, got nil")
	}

	// Verify no user was created
	foundUser, _ := app.FindFirstRecordByFilter("users", "email = {:email}", map[string]any{"email": "invitee_race@example.com"})
	if foundUser != nil {
		t.Fatal("expected no user account to be created for revoked invitation")
	}
}

// TestDashboardRevisionHook_SuperuserWriteAdvancesRevision verifies that
// RegisterDashboardRevisionHook enforces revision advancement at the model layer,
// closing the superuser bypass path in OnRecordUpdateRequest.
//
// Scenario:
//  1. Admin creates a dashboard (revision=1).
//  2. A superuser directly saves the record (bypassing OnRecordUpdateRequest).
//     The revision must advance to 2 via the OnRecordUpdate hook.
//  3. An admin who held the stale expected_revision=1 now submits an update via
//     OnRecordUpdateRequest.  It must be rejected with a 409 Conflict because the
//     server revision is now 2.
//  4. An admin who submits with the correct expected_revision=2 succeeds; revision
//     advances to 3.
func TestDashboardRevisionHook_SuperuserWriteAdvancesRevision(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer app.Cleanup()

	authz.RegisterAuthnHooks(app)
	authz.RegisterDashboardRevisionHook(app)

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	dashboardsCol, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil {
		t.Fatal(err)
	}

	// --- Seed an admin user ---
	admin := core.NewRecord(usersCol)
	admin.Set("email", "sutest_admin@example.com")
	admin.Set("role", authz.RoleAdmin)
	admin.Set("disabled", false)
	admin.SetPassword("Password123!")
	if err := app.Save(admin); err != nil {
		t.Fatal(err)
	}

	// --- Step 1: Create dashboard (revision must start at 1) ---
	dashRec := core.NewRecord(dashboardsCol)
	dashRec.Set("name", "superuser-test-dash")
	dashRec.Set("layout", map[string]any{
		"id":     "superuser-test-dash",
		"name":   "Superuser Test",
		"layout": []any{},
	})

	evCreate := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: admin},
		Record:       dashRec,
	}
	evCreate.Collection = dashboardsCol
	if err := app.OnRecordCreateRequest("dashboards").Trigger(evCreate, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	}); err != nil {
		t.Fatalf("failed to create dashboard: %v", err)
	}
	if dashRec.GetInt("revision") != 1 {
		t.Fatalf("expected revision=1 after create, got %d", dashRec.GetInt("revision"))
	}
	// Persist to DB for findById lookups in hooks
	savedDash, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil || savedDash == nil {
		t.Fatalf("dashboard not found in DB after create: %v", err)
	}

	// --- Step 2: Superuser directly saves the record (no HTTP hook) ---
	// Simulate: load from DB, mutate, save directly (no OnRecordUpdateRequest).
	superuserCopy, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil {
		t.Fatalf("failed to reload dashboard for superuser save: %v", err)
	}
	superuserCopy.Set("layout", map[string]any{
		"id":     "superuser-test-dash",
		"name":   "Superuser Edit",
		"layout": []any{},
	})
	// Save directly — bypasses OnRecordUpdateRequest, hits OnRecordUpdate hook.
	if err := app.Save(superuserCopy); err != nil {
		t.Fatalf("superuser direct save failed: %v", err)
	}

	// The OnRecordUpdate hook must have incremented revision from 1 → 2.
	afterSuperuser, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil {
		t.Fatal(err)
	}
	if afterSuperuser.GetInt("revision") != 2 {
		t.Errorf("expected revision=2 after superuser direct save, got %d", afterSuperuser.GetInt("revision"))
	}

	// --- Step 3: Admin with stale expected_revision=1 must be rejected (409) ---
	staleAdminCopy, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil {
		t.Fatal(err)
	}
	staleAdminCopy.Set("layout", map[string]any{
		"id":     "superuser-test-dash",
		"name":   "Admin Stale Draft",
		"layout": []any{},
	})
	evStaleUpdate := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: admin},
		Record:       staleAdminCopy,
	}
	// Inject expected_revision=1 (stale) into request body via app.RequestInfo mock
	evStaleUpdate.Collection = dashboardsCol
	// We set the expected_revision field directly on the record to simulate what
	// extractExpectedRevision reads from the request body.
	staleAdminCopy.Set("expected_revision", 1)

	var staleUpdateErr error
	triggerErr := app.OnRecordUpdateRequest("dashboards").Trigger(evStaleUpdate, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	})
	staleUpdateErr = triggerErr

	if staleUpdateErr == nil {
		t.Error("expected stale admin update (expected_revision=1 vs server=2) to be rejected with 409, but it succeeded")
	} else {
		apiErr, ok := staleUpdateErr.(*apis.ApiError)
		if !ok || apiErr.Status != 409 {
			t.Errorf("expected 409 Conflict for stale revision, got: %v", staleUpdateErr)
		}
	}

	// --- Step 4: Admin with correct expected_revision=2 must succeed ---
	freshAdminCopy, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil {
		t.Fatal(err)
	}
	freshAdminCopy.Set("layout", map[string]any{
		"id":     "superuser-test-dash",
		"name":   "Admin Fresh Edit",
		"layout": []any{},
	})
	freshAdminCopy.Set("expected_revision", 2)

	evFreshUpdate := &core.RecordRequestEvent{
		RequestEvent: &core.RequestEvent{App: app, Auth: admin},
		Record:       freshAdminCopy,
	}
	evFreshUpdate.Collection = dashboardsCol

	if err := app.OnRecordUpdateRequest("dashboards").Trigger(evFreshUpdate, func(e *core.RecordRequestEvent) error {
		return app.Save(e.Record)
	}); err != nil {
		t.Fatalf("expected admin update with correct expected_revision=2 to succeed, got: %v", err)
	}

	finalRec, err := app.FindRecordById("dashboards", dashRec.Id)
	if err != nil {
		t.Fatal(err)
	}
	if finalRec.GetInt("revision") != 3 {
		t.Errorf("expected revision=3 after successful admin update, got %d", finalRec.GetInt("revision"))
	}
}

func TestIsLastOwner_FailsClosedOnError(t *testing.T) {
	// 1. Unbootstrapped or nil app returns error
	isLast, err := authz.IsLastOwner(nil, "some_id")
	if err == nil {
		t.Fatal("expected error when app is nil, got nil")
	}
	if isLast {
		t.Fatal("expected isLast to be false on error")
	}

	// 2. Empty owners table fails closed (count cannot be verified)
	emptyApp := newTestApp(t)
	isLast, err = authz.IsLastOwner(emptyApp, "nonexistent_owner")
	if err == nil {
		t.Fatal("expected error when no active owners exist, got nil")
	}
	if isLast {
		t.Fatal("expected isLast=false when no active owners exist")
	}

	// 3. Closed test app returns query error
	app := newTestApp(t)
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	owner := core.NewRecord(usersCol)
	owner.Set("email", "owner_closed@example.com")
	owner.Set("role", authz.RoleOwner)
	owner.Set("disabled", false)
	owner.SetPassword("Password123456!")
	if err := app.Save(owner); err != nil {
		t.Fatal(err)
	}

	// Verify valid app works
	isLast, err = authz.IsLastOwner(app, owner.Id)
	if err != nil || !isLast {
		t.Fatalf("expected isLast=true, err=nil, got isLast=%v, err=%v", isLast, err)
	}

	// Close / cleanup DB to induce query error
	app.Cleanup()
	isLast, err = authz.IsLastOwner(app, owner.Id)
	if err == nil {
		t.Fatal("expected query error after DB cleanup, got nil")
	}
	if isLast {
		t.Fatal("expected isLast=false when query fails")
	}
}
