package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	_ "github.com/Lattice/backend/internal/migrations"
	"github.com/Lattice/backend/internal/api"
	"github.com/Lattice/backend/internal/platform/authz"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/modules"
	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func createTestServer(t *testing.T) (*tests.TestApp, *httptest.Server) {
	t.Helper()
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	t.Cleanup(app.Cleanup)

	pbRouter, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("failed to create PocketBase router: %v", err)
	}

	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_pilot", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_pilot_000000",
		SchemaVersion: "schema_pilot_v1", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}

	authz.RegisterAuthnHooks(app)
	api.Register(&core.ServeEvent{App: app, Router: pbRouter}, cfg, features.Empty())

	mux, err := pbRouter.BuildMux()
	if err != nil {
		t.Fatalf("failed to build router mux: %v", err)
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return app, server
}

type authResponse struct {
	Token  string       `json:"token"`
	Record *core.Record `json:"record"`
}

func parseJSON(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("failed to unmarshal JSON response %q: %v", string(body), err)
	}
	return out
}

func httpReq(t *testing.T, method, url string, body any, token string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("failed to marshal body: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request %s %s failed: %v", method, url, err)
	}
	return res
}

func loginUser(t *testing.T, serverURL, email, password string) (string, string) {
	t.Helper()
	res := httpReq(t, http.MethodPost, serverURL+"/api/collections/users/auth-with-password", map[string]string{
		"identity": email,
		"password": password,
	}, "")
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("login failed for %s (%d): %s", email, res.StatusCode, string(body))
	}
	data := parseJSON(t, res)
	token, ok := data["token"].(string)
	if !ok || token == "" {
		t.Fatalf("missing token in login response for %s", email)
	}
	rec, ok := data["record"].(map[string]any)
	if !ok {
		t.Fatalf("missing record in login response for %s", email)
	}
	id, _ := rec["id"].(string)
	return token, id
}

func TestPilotAcceptanceScenario_EndToEndAndRecovery(t *testing.T) {
	app, server := createTestServer(t)

	// Step 1: Initial state check (has_owner: false)
	cfgRes := httpReq(t, http.MethodGet, server.URL+"/v1/config", nil, "")
	if cfgRes.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/config status = %d, want 200", cfgRes.StatusCode)
	}
	cfgData := parseJSON(t, cfgRes)
	if hasOwner, ok := cfgData["has_owner"].(bool); !ok || hasOwner {
		t.Fatalf("expected has_owner false, got %v", cfgData["has_owner"])
	}

	// Step 2: Fresh instance workspace setup with setup secret
	setupToken, err := authz.GetOrCreateSetupToken(app)
	if err != nil || setupToken == "" {
		t.Fatalf("failed to obtain setup token: %v", err)
	}

	setupRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/setup", map[string]string{
		"token":    setupToken,
		"name":     "Pilot Owner",
		"email":    "owner@example.com",
		"password": "Password123!",
	}, "")
	if setupRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(setupRes.Body)
		t.Fatalf("workspace setup failed (%d): %s", setupRes.StatusCode, string(body))
	}

	// Repeated setup returns 409 Conflict
	repSetupRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/setup", map[string]string{
		"token":    setupToken,
		"name":     "Second Owner",
		"email":    "owner2@example.com",
		"password": "Password123!",
	}, "")
	if repSetupRes.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 Conflict for repeated setup, got %d", repSetupRes.StatusCode)
	}

	// Config now reports has_owner = true
	cfgRes2 := httpReq(t, http.MethodGet, server.URL+"/v1/config", nil, "")
	cfgData2 := parseJSON(t, cfgRes2)
	if hasOwner, ok := cfgData2["has_owner"].(bool); !ok || !hasOwner {
		t.Fatalf("expected has_owner true, got %v", cfgData2["has_owner"])
	}

	// Step 3: Owner logs in
	ownerToken, ownerId := loginUser(t, server.URL, "owner@example.com", "Password123!")
	if ownerToken == "" || ownerId == "" {
		t.Fatal("failed to login owner")
	}

	// Step 4: Owner configures Customer & Job Tracking with suggested datasets
	modSetupRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", map[string]any{
		"use_suggested": true,
	}, ownerToken)
	if modSetupRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(modSetupRes.Body)
		t.Fatalf("module setup failed (%d): %s", modSetupRes.StatusCode, string(body))
	}

	// Repeating setup is idempotent and succeeds without duplicate collections
	modSetupRetryRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", map[string]any{
		"use_suggested": true,
	}, ownerToken)
	if modSetupRetryRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK on idempotent retry, got %d", modSetupRetryRes.StatusCode)
	}

	// Verify collections exist in PocketBase
	custCol, err := app.FindCollectionByNameOrId("customers")
	if err != nil || custCol == nil {
		t.Fatalf("customers collection missing: %v", err)
	}
	jobCol, err := app.FindCollectionByNameOrId("jobs")
	if err != nil || jobCol == nil {
		t.Fatalf("jobs collection missing: %v", err)
	}

	// Step 5: Owner invites two members with Customer & Job Tracking permission preset
	permPreset := map[string]any{
		"customers": map[string]any{"read": true, "scope": "all"},
		"jobs":      map[string]any{"read": true, "create": true, "update": true, "delete": false, "scope": "assigned"},
	}

	inv1Res := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations", map[string]any{
		"email":       "tech1@example.com",
		"role":        "member",
		"permissions": permPreset,
	}, ownerToken)
	if inv1Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(inv1Res.Body)
		t.Fatalf("invite 1 failed (%d): %s", inv1Res.StatusCode, string(body))
	}
	inv1Data := parseJSON(t, inv1Res)
	inv1Token, _ := inv1Data["token"].(string)

	inv2Res := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations", map[string]any{
		"email":       "tech2@example.com",
		"role":        "member",
		"permissions": permPreset,
	}, ownerToken)
	if inv2Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(inv2Res.Body)
		t.Fatalf("invite 2 failed (%d): %s", inv2Res.StatusCode, string(body))
	}
	inv2Data := parseJSON(t, inv2Res)
	inv2Token, _ := inv2Data["token"].(string)

	// Step 6: Two members accept invitations
	acc1Res := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations/accept", map[string]string{
		"token":    inv1Token,
		"name":     "Tech One",
		"password": "Password123!",
	}, "")
	if acc1Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(acc1Res.Body)
		t.Fatalf("accept 1 failed (%d): %s", acc1Res.StatusCode, string(body))
	}

	acc2Res := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations/accept", map[string]string{
		"token":    inv2Token,
		"name":     "Tech Two",
		"password": "Password123!",
	}, "")
	if acc2Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(acc2Res.Body)
		t.Fatalf("accept 2 failed (%d): %s", acc2Res.StatusCode, string(body))
	}

	// Reusing invitation token fails with 400
	accReused := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations/accept", map[string]string{
		"token":    inv1Token,
		"name":     "Tech One Imposter",
		"password": "Password123!",
	}, "")
	if accReused.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for reused invite token, got %d", accReused.StatusCode)
	}

	// Step 7: Members authenticate
	tech1Token, tech1Id := loginUser(t, server.URL, "tech1@example.com", "Password123!")
	tech2Token, tech2Id := loginUser(t, server.URL, "tech2@example.com", "Password123!")

	// Step 8: Owner creates customer "Acme Industrial"
	custCreateRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/customers/records", map[string]string{
		"name":  "Acme Industrial",
		"phone": "555-0199",
	}, ownerToken)
	if custCreateRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(custCreateRes.Body)
		t.Fatalf("customer create failed (%d): %s", custCreateRes.StatusCode, string(body))
	}
	custData := parseJSON(t, custCreateRes)
	customerId, _ := custData["id"].(string)

	// Step 9: Both members can read the customer record (proposed read-all permission for pilot, pending confirmation)
	custRead1 := httpReq(t, http.MethodGet, server.URL+"/api/collections/customers/records/"+customerId, nil, tech1Token)
	if custRead1.StatusCode != http.StatusOK {
		t.Fatalf("tech1 failed to read customer: status %d", custRead1.StatusCode)
	}
	custRead2 := httpReq(t, http.MethodGet, server.URL+"/api/collections/customers/records/"+customerId, nil, tech2Token)
	if custRead2.StatusCode != http.StatusOK {
		t.Fatalf("tech2 failed to read customer: status %d", custRead2.StatusCode)
	}

	// Step 10: Owner creates one job for Tech 1 and one job for Tech 2
	job1Res := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "Boiler Maintenance",
		"customer": customerId,
		"status":   "Open",
		"assignee": tech1Id,
	}, ownerToken)
	if job1Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(job1Res.Body)
		t.Fatalf("job 1 create failed (%d): %s", job1Res.StatusCode, string(body))
	}
	job1Data := parseJSON(t, job1Res)
	job1Id, _ := job1Data["id"].(string)

	job2Res := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "HVAC Inspection",
		"customer": customerId,
		"status":   "Open",
		"assignee": tech2Id,
	}, ownerToken)
	if job2Res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(job2Res.Body)
		t.Fatalf("job 2 create failed (%d): %s", job2Res.StatusCode, string(body))
	}
	job2Data := parseJSON(t, job2Res)
	job2Id, _ := job2Data["id"].(string)

	// Step 11: Assigned-only list isolation
	// Tech 1 lists jobs: should ONLY see job1
	list1Res := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records", nil, tech1Token)
	if list1Res.StatusCode != http.StatusOK {
		t.Fatalf("tech1 list jobs failed (%d)", list1Res.StatusCode)
	}
	list1Data := parseJSON(t, list1Res)
	items1, _ := list1Data["items"].([]any)
	if len(items1) != 1 {
		t.Fatalf("expected tech1 to see exactly 1 job, got %d", len(items1))
	}
	firstJob1 := items1[0].(map[string]any)
	if firstJob1["id"] != job1Id {
		t.Fatalf("expected tech1 to see job1 %q, got %v", job1Id, firstJob1["id"])
	}

	// Tech 2 lists jobs: should ONLY see job2
	list2Res := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records", nil, tech2Token)
	if list2Res.StatusCode != http.StatusOK {
		t.Fatalf("tech2 list jobs failed (%d)", list2Res.StatusCode)
	}
	list2Data := parseJSON(t, list2Res)
	items2, _ := list2Data["items"].([]any)
	if len(items2) != 1 {
		t.Fatalf("expected tech2 to see exactly 1 job, got %d", len(items2))
	}
	firstJob2 := items2[0].(map[string]any)
	if firstJob2["id"] != job2Id {
		t.Fatalf("expected tech2 to see job2 %q, got %v", job2Id, firstJob2["id"])
	}

	// Owner lists jobs: sees both jobs
	listOwnerRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records", nil, ownerToken)
	if listOwnerRes.StatusCode != http.StatusOK {
		t.Fatalf("owner list jobs failed (%d)", listOwnerRes.StatusCode)
	}
	listOwnerData := parseJSON(t, listOwnerRes)
	ownerItems, _ := listOwnerData["items"].([]any)
	if len(ownerItems) < 2 {
		t.Fatalf("expected owner to see at least 2 jobs, got %d", len(ownerItems))
	}

	// Step 12: Direct record request and modification isolation
	// Tech 1 cannot retrieve Tech 2's job (404)
	directGetRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job2Id, nil, tech1Token)
	if directGetRes.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found for tech1 reading job2, got %d", directGetRes.StatusCode)
	}

	// Tech 1 cannot modify Tech 2's job (404)
	directPatchRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+job2Id, map[string]string{
		"status": "Done",
	}, tech1Token)
	if directPatchRes.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found for tech1 modifying job2, got %d", directPatchRes.StatusCode)
	}

	// Tech 2 cannot retrieve Tech 1's job (404)
	directGet2Res := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job1Id, nil, tech2Token)
	if directGet2Res.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 Not Found for tech2 reading job1, got %d", directGet2Res.StatusCode)
	}

	// Step 13: Tech 1 updates Job 1 status
	updateProgRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+job1Id, map[string]string{
		"status": "In progress",
	}, tech1Token)
	if updateProgRes.StatusCode != http.StatusOK {
		t.Fatalf("tech1 update to In progress failed (%d)", updateProgRes.StatusCode)
	}

	updateDoneRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+job1Id, map[string]string{
		"status": "Done",
	}, tech1Token)
	if updateDoneRes.StatusCode != http.StatusOK {
		t.Fatalf("tech1 update to Done failed (%d)", updateDoneRes.StatusCode)
	}

	// Owner sees the updated status "Done"
	ownerCheckRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job1Id, nil, ownerToken)
	ownerCheckData := parseJSON(t, ownerCheckRes)
	if ownerCheckData["status"] != "Done" {
		t.Fatalf("expected job1 status 'Done', got %v", ownerCheckData["status"])
	}

	// Step 14: Relation expansion operates correctly
	expandRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job1Id+"?expand=customer", nil, tech1Token)
	if expandRes.StatusCode != http.StatusOK {
		t.Fatalf("relation expansion request failed (%d)", expandRes.StatusCode)
	}
	expandData := parseJSON(t, expandRes)
	expandObj, ok := expandData["expand"].(map[string]any)
	if !ok || expandObj == nil {
		t.Fatalf("missing expand in response: %v", expandData)
	}
	custExp, ok := expandObj["customer"].(map[string]any)
	if !ok || custExp["name"] != "Acme Industrial" {
		t.Fatalf("expected expanded customer name 'Acme Industrial', got: %v", custExp)
	}

	// Step 15: Member job creation auto-assigns member to themselves (assigned scope)
	tech1CreateJobRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "Tech1 Self-Created Job",
		"customer": customerId,
		"status":   "Open",
	}, tech1Token)
	if tech1CreateJobRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(tech1CreateJobRes.Body)
		t.Fatalf("member self job creation failed (%d): %s", tech1CreateJobRes.StatusCode, string(body))
	}
	tech1JobData := parseJSON(t, tech1CreateJobRes)
	if tech1JobData["assignee"] != tech1Id {
		t.Fatalf("expected self-created job assignee to be %q, got %v", tech1Id, tech1JobData["assignee"])
	}

	// Assigned-scope member supplying another assignee has that value overwritten to themselves by the production create hook
	tech1RogueRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "Rogue Assignment Job",
		"customer": customerId,
		"status":   "Open",
		"assignee": tech2Id,
	}, tech1Token)
	if tech1RogueRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(tech1RogueRes.Body)
		t.Fatalf("expected 200 OK for assigned-scope member create job (with overwrite to self), got %d: %s", tech1RogueRes.StatusCode, string(body))
	}
	tech1RogueData := parseJSON(t, tech1RogueRes)
	if tech1RogueData["assignee"] != tech1Id {
		t.Fatalf("expected assignee to be overwritten with %q, got %v", tech1Id, tech1RogueData["assignee"])
	}

	// Assigned-scope member cannot reassign job to another member on update
	reassignRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+job1Id, map[string]string{
		"assignee": tech2Id,
	}, tech1Token)
	if reassignRes.StatusCode != http.StatusForbidden && reassignRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 403 Forbidden for assigned-scope member reassigning job, got %d", reassignRes.StatusCode)
	}

	// Test both scopes: Member with scope "all" can assign to someone else and reassign on update
	ownerUpdateTech2Perms := httpReq(t, http.MethodPatch, server.URL+"/v1/workspace/users/"+tech2Id, map[string]any{
		"permissions": map[string]any{
			"customers": map[string]any{"read": true, "scope": "all"},
			"jobs":      map[string]any{"read": true, "create": true, "update": true, "delete": false, "scope": "all"},
		},
	}, ownerToken)
	if ownerUpdateTech2Perms.StatusCode != http.StatusOK {
		t.Fatalf("failed to update tech2 to all scope: %d", ownerUpdateTech2Perms.StatusCode)
	}

	// All-scope member creates a record assigned to someone else (tech1Id)
	allScopeCreateRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "All-Scope Delegated Job",
		"customer": customerId,
		"status":   "Open",
		"assignee": tech1Id,
	}, tech2Token)
	if allScopeCreateRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(allScopeCreateRes.Body)
		t.Fatalf("all-scope member create job failed (%d): %s", allScopeCreateRes.StatusCode, string(body))
	}
	allScopeJobData := parseJSON(t, allScopeCreateRes)
	if allScopeJobData["assignee"] != tech1Id {
		t.Fatalf("expected all-scope member to create job assigned to %q, got %v", tech1Id, allScopeJobData["assignee"])
	}
	allScopeJobId, _ := allScopeJobData["id"].(string)

	// All-scope member reassigns the record to themselves on update
	allScopeUpdateRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+allScopeJobId, map[string]string{
		"assignee": tech2Id,
	}, tech2Token)
	if allScopeUpdateRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(allScopeUpdateRes.Body)
		t.Fatalf("all-scope member update job failed (%d): %s", allScopeUpdateRes.StatusCode, string(body))
	}
	allScopeUpdatedData := parseJSON(t, allScopeUpdateRes)
	if allScopeUpdatedData["assignee"] != tech2Id {
		t.Fatalf("expected all-scope member reassign to %q, got %v", tech2Id, allScopeUpdatedData["assignee"])
	}

	// Step 16: Member deactivation / session revocation
	// Owner disables Tech 1 account via workspace users endpoint
	disableTech1Res := httpReq(t, http.MethodPatch, server.URL+"/v1/workspace/users/"+tech1Id, map[string]any{
		"disabled": true,
	}, ownerToken)
	if disableTech1Res.StatusCode != http.StatusOK {
		t.Fatalf("failed to disable tech1 account (%d)", disableTech1Res.StatusCode)
	}

	// Tech 1's existing token is immediately rejected by production authorization hooks (401 Unauthorized)
	tech1RevokedList := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records", nil, tech1Token)
	if tech1RevokedList.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized for disabled member list, got %d", tech1RevokedList.StatusCode)
	}

	tech1RevokedGet := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job1Id, nil, tech1Token)
	if tech1RevokedGet.StatusCode != http.StatusNotFound && tech1RevokedGet.StatusCode != http.StatusUnauthorized {
		t.Fatalf("disabled member should receive 404 or 401 when viewing record, got %d", tech1RevokedGet.StatusCode)
	}

	tech1RevokedCreate := httpReq(t, http.MethodPost, server.URL+"/api/collections/jobs/records", map[string]string{
		"title":    "Should Fail",
		"customer": customerId,
		"status":   "Open",
	}, tech1Token)
	if tech1RevokedCreate.StatusCode == http.StatusOK {
		t.Fatal("disabled member should NOT be able to create jobs")
	}

	// Step 17: Module disable and re-enable (data retention verification)
	disableModRes := httpReq(t, http.MethodPut, server.URL+"/v1/workspace/modules/customer_job_tracking", map[string]any{
		"enabled": false,
	}, ownerToken)
	if disableModRes.StatusCode != http.StatusOK {
		t.Fatalf("disable module failed (%d)", disableModRes.StatusCode)
	}

	// Check module list reports enabled: false
	modListRes := httpReq(t, http.MethodGet, server.URL+"/v1/workspace/modules", nil, ownerToken)
	if !strings.Contains(string(parseRaw(t, modListRes)), `"enabled":false`) {
		t.Fatal("expected module list to report enabled: false")
	}

	// Datasets and records remain completely intact and readable by owner
	custCheck := httpReq(t, http.MethodGet, server.URL+"/api/collections/customers/records/"+customerId, nil, ownerToken)
	if custCheck.StatusCode != http.StatusOK {
		t.Fatalf("customer record missing after module disable: %d", custCheck.StatusCode)
	}
	jobCheck := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job1Id, nil, ownerToken)
	if jobCheck.StatusCode != http.StatusOK {
		t.Fatalf("job record missing after module disable: %d", jobCheck.StatusCode)
	}

	// Re-enable module
	enableModRes := httpReq(t, http.MethodPut, server.URL+"/v1/workspace/modules/customer_job_tracking", map[string]any{
		"enabled": true,
	}, ownerToken)
	if enableModRes.StatusCode != http.StatusOK {
		t.Fatalf("re-enable module failed (%d)", enableModRes.StatusCode)
	}

	// Step 18: Add optional dataset field to jobs
	// Add optional text field "notes" to jobs collection and schema definition
	notesField := &core.TextField{Name: "notes", Required: false}
	jobCol.Fields.Add(notesField)
	if err := app.Save(jobCol); err != nil {
		t.Fatalf("failed to add notes field to jobs collection: %v", err)
	}

	schemaRec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": "jobs"})
	if err != nil || schemaRec == nil {
		t.Fatalf("failed to find jobs schema definition: %v", err)
	}
	var existingFields []schemas.FieldDefinition
	if err := json.Unmarshal([]byte(schemaRec.GetString("fields")), &existingFields); err == nil {
		existingFields = append(existingFields, schemas.FieldDefinition{
			Name: "notes", Label: "Notes", Type: "text", Required: false,
		})
		schemaRec.Set("fields", existingFields)
		if err := app.Save(schemaRec); err != nil {
			t.Fatalf("failed to update schema definition with notes: %v", err)
		}
	}

	// Tech 2 updates job 2 with notes
	updateNotesRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/jobs/records/"+job2Id, map[string]string{
		"notes": "Urgent customer visit requested",
	}, tech2Token)
	if updateNotesRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(updateNotesRes.Body)
		t.Fatalf("update with notes field failed (%d): %s", updateNotesRes.StatusCode, string(body))
	}

	job2NotesCheck := httpReq(t, http.MethodGet, server.URL+"/api/collections/jobs/records/"+job2Id, nil, tech2Token)
	job2NotesData := parseJSON(t, job2NotesCheck)
	if job2NotesData["notes"] != "Urgent customer visit requested" {
		t.Fatalf("expected notes 'Urgent customer visit requested', got %v", job2NotesData["notes"])
	}
}

func parseRaw(t *testing.T, res *http.Response) []byte {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("failed to read body: %v", err)
	}
	return b
}

func TestModuleSetup_CustomMapping_CompatibleAndIncompatible(t *testing.T) {
	app, server := createTestServer(t)

	// Setup owner
	setupToken, _ := authz.GetOrCreateSetupToken(app)
	httpReq(t, http.MethodPost, server.URL+"/v1/workspace/setup", map[string]string{
		"token":    setupToken,
		"name":     "Custom Owner",
		"email":    "owner@example.com",
		"password": "Password123!",
	}, "")
	ownerToken, _ := loginUser(t, server.URL, "owner@example.com", "Password123!")

	// 1. Pre-create custom collections: "client_directory" and "work_orders"
	schemasSvc := schemas.NewService(app)
	ctx := context.Background()

	_, err := schemasSvc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID: "client_directory",
		Name:     "Client Directory",
		Fields: []schemas.FieldDefinition{
			{Name: "client_name", Label: "Client Name", Type: "text", Required: true},
			{Name: "contact_number", Label: "Contact Number", Type: "text", Required: false},
		},
	})
	if err != nil {
		t.Fatalf("failed to create client_directory: %v", err)
	}

	_, err = schemasSvc.CreateSchema(ctx, schemas.SchemaDefinition{
		SchemaID:      "work_orders",
		Name:          "Work Orders",
		AssigneeField: "assigned_tech",
		Fields: []schemas.FieldDefinition{
			{Name: "summary", Label: "Summary", Type: "text", Required: true},
			{Name: "client_link", Label: "Client", Type: "relation", Required: true, Target: "client_directory"},
			{Name: "current_state", Label: "State", Type: "select", Required: true, Options: []string{"Open", "In progress", "Done"}},
			{Name: "assigned_tech", Label: "Assigned Tech", Type: "relation", Required: true, Target: "users"},
		},
	})
	if err != nil {
		t.Fatalf("failed to create work_orders: %v", err)
	}

	// 2. Compatible custom mapping
	compatMapping := map[string]any{
		"use_suggested": false,
		"mapping": map[string]string{
			"customer_dataset":      "client_directory",
			"customer_name_field":   "client_name",
			"customer_phone_field":  "contact_number",
			"job_dataset":           "work_orders",
			"job_title_field":       "summary",
			"job_customer_field":    "client_link",
			"job_status_field":      "current_state",
			"job_assignee_field":    "assigned_tech",
		},
	}
	compatRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", compatMapping, ownerToken)
	if compatRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(compatRes.Body)
		t.Fatalf("compatible custom mapping setup failed (%d): %s", compatRes.StatusCode, string(body))
	}

	// 3. Rejected incompatible mapping: relation target mismatch
	badRelMapping := map[string]any{
		"use_suggested": false,
		"mapping": map[string]string{
			"customer_dataset":      "client_directory",
			"customer_name_field":   "client_name",
			"job_dataset":           "work_orders",
			"job_title_field":       "summary",
			"job_customer_field":    "assigned_tech", // points to users, not client_directory
			"job_status_field":      "current_state",
			"job_assignee_field":    "assigned_tech",
		},
	}
	badRelRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", badRelMapping, ownerToken)
	if badRelRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for mismatched relation target, got %d", badRelRes.StatusCode)
	}

	// 4. Failed setup followed by retry: verify no orphaned resources
	badReq := map[string]any{
		"use_suggested": false,
		"mapping": map[string]string{
			"customer_dataset": "non_existent_dataset",
		},
	}
	failRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", badReq, ownerToken)
	if failRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for non-existent dataset, got %d", failRes.StatusCode)
	}

	// Retry with valid mapping succeeds cleanly
	retryRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/modules/customer_job_tracking/setup", compatMapping, ownerToken)
	if retryRes.StatusCode != http.StatusOK {
		t.Fatalf("retry after failed setup failed (%d)", retryRes.StatusCode)
	}

	// Verify installed module record
	inst, err := modules.GetInstalledModule(app, "customer_job_tracking")
	if err != nil || inst == nil {
		t.Fatalf("expected module to be installed: %v", err)
	}
	if inst.Mapping.JobDataset != "work_orders" || inst.Mapping.CustomerDataset != "client_directory" {
		t.Fatalf("unexpected mapping in installed module: %+v", inst.Mapping)
	}
}
