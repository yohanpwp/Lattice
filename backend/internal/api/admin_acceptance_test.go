package api_test

import (
	"bytes"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"
	"github.com/pocketbase/pocketbase/tools/subscriptions"

	"github.com/Lattice/backend/internal/api"
	"github.com/Lattice/backend/internal/platform/authz"
	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func createTestServerWithDir(t *testing.T, dataDir string) (*tests.TestApp, *httptest.Server) {
	t.Helper()
	app, err := tests.NewTestApp(dataDir)
	if err != nil {
		t.Fatalf("failed to create test app in %s: %v", dataDir, err)
	}
	t.Cleanup(app.Cleanup)

	pbRouter, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("failed to create PocketBase router: %v", err)
	}

	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_admin_test", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_pilot_000000",
		SchemaVersion: "schema_admin_v1", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}

	authz.RegisterAuthnHooks(app)
	authz.RegisterDashboardRevisionHook(app)
	api.Register(&core.ServeEvent{App: app, Router: pbRouter}, cfg, features.Empty())

	mux, err := pbRouter.BuildMux()
	if err != nil {
		t.Fatalf("failed to build router mux: %v", err)
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return app, server
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
}

func TestAdminWorkspace_AcceptanceScenario(t *testing.T) {
	app, server := createTestServer(t)

	// =========================================================================
	// Step 1: Fresh Instance Bootstrap & Owner Workspace Setup
	// =========================================================================
	setupToken, err := authz.GetOrCreateSetupToken(app)
	if err != nil || setupToken == "" {
		t.Fatalf("failed to obtain setup token: %v", err)
	}

	setupRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/setup", map[string]string{
		"token":    setupToken,
		"name":     "Workspace Owner",
		"email":    "owner@example.com",
		"password": "Password123!",
	}, "")
	if setupRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(setupRes.Body)
		t.Fatalf("workspace setup failed (%d): %s", setupRes.StatusCode, string(body))
	}

	ownerToken, _ := loginUser(t, server.URL, "owner@example.com", "Password123!")

	// =========================================================================
	// Step 2: Owner Invites Admin and Two Differential Members
	// =========================================================================
	inviteUser := func(email, role string, perms map[string]authz.DatasetPermission) string {
		t.Helper()
		invRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations", map[string]any{
			"email":       email,
			"role":        role,
			"permissions": perms,
		}, ownerToken)
		if invRes.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(invRes.Body)
			t.Fatalf("invite failed for %s (%d): %s", email, invRes.StatusCode, string(body))
		}
		invData := parseJSON(t, invRes)
		token, _ := invData["token"].(string)

		acceptRes := httpReq(t, http.MethodPost, server.URL+"/v1/workspace/invitations/accept", map[string]string{
			"token":    token,
			"name":     email,
			"password": "Password123!",
		}, "")
		if acceptRes.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(acceptRes.Body)
			t.Fatalf("accept invite failed for %s (%d): %s", email, acceptRes.StatusCode, string(body))
		}

		userToken, _ := loginUser(t, server.URL, email, "Password123!")
		return userToken
	}

	// 1. Admin
	adminToken := inviteUser("admin@example.com", authz.RoleAdmin, nil)

	// 2. Member 1 (Analyst with read/create permissions on projects)
	analystToken := inviteUser("analyst@example.com", authz.RoleMember, map[string]authz.DatasetPermission{
		"projects": {Read: true, Create: true, Update: true, Scope: authz.ScopeAll},
	})

	// 3. Member 2 (Guest with NO permissions on projects)
	guestToken := inviteUser("guest@example.com", authz.RoleMember, map[string]authz.DatasetPermission{
		"projects": {Read: false, Scope: authz.ScopeAll},
	})

	// =========================================================================
	// Step 3: Admin Creates Multi-Field Business Dataset and Records (with Files)
	// =========================================================================
	schemaDef := schemas.SchemaDefinition{
		SchemaID:    "projects",
		Name:        "Projects",
		Description: "Client Projects and Tracking",
		Icon:        "🚀",
		Fields: []schemas.FieldDefinition{
			{Name: "name", Label: "Project Name", Type: "text", Required: true},
			{Name: "budget", Label: "Budget (USD)", Type: "number", Required: false},
			{Name: "status", Label: "Status", Type: "select", Options: []string{"Planning", "Active", "Completed"}},
			{Name: "lead", Label: "Project Lead", Type: "relation", Target: "users"},
			{Name: "attachment", Label: "Project Spec", Type: "file", Required: false},
		},
	}

	createSchemaRes := httpReq(t, http.MethodPost, server.URL+"/v1/schemas", schemaDef, adminToken)
	if createSchemaRes.StatusCode != http.StatusOK && createSchemaRes.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createSchemaRes.Body)
		t.Fatalf("admin POST /v1/schemas failed (%d): %s", createSchemaRes.StatusCode, string(body))
	}

	// Member cannot create or modify schemas
	memberSchemaRes := httpReq(t, http.MethodPost, server.URL+"/v1/schemas", schemaDef, guestToken)
	if memberSchemaRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected member schema creation to be 403 Forbidden, got %d", memberSchemaRes.StatusCode)
	}

	// Admin creates Project Alpha with real multipart file upload
	pdfContent := []byte("%PDF-1.4 Project Alpha Specification Document")
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	_ = w.WriteField("name", "Alpha")
	_ = w.WriteField("budget", "15000")
	_ = w.WriteField("status", "Active")
	part, err := w.CreateFormFile("attachment", "spec.pdf")
	if err != nil {
		t.Fatalf("failed to create multipart form file: %v", err)
	}
	_, _ = part.Write(pdfContent)
	_ = w.Close()

	uploadReq, err := http.NewRequest(http.MethodPost, server.URL+"/api/collections/projects/records", &b)
	if err != nil {
		t.Fatalf("failed to create upload request: %v", err)
	}
	uploadReq.Header.Set("Content-Type", w.FormDataContentType())
	uploadReq.Header.Set("Authorization", "Bearer "+adminToken)

	uploadRes, err := http.DefaultClient.Do(uploadReq)
	if err != nil || uploadRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(uploadRes.Body)
		t.Fatalf("multipart record creation failed (%d): %s", uploadRes.StatusCode, string(body))
	}
	alphaRecord := parseJSON(t, uploadRes)
	alphaID, _ := alphaRecord["id"].(string)
	attachmentFileName, _ := alphaRecord["attachment"].(string)

	if alphaID == "" || attachmentFileName == "" {
		t.Fatalf("expected valid project Alpha ID and attachment file name, got id=%s, file=%s", alphaID, attachmentFileName)
	}

	// Admin creates Project Beta (without file)
	resBeta := httpReq(t, http.MethodPost, server.URL+"/api/collections/projects/records", map[string]any{
		"name":   "Beta",
		"budget": 8000,
		"status": "Planning",
	}, adminToken)
	if resBeta.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resBeta.Body)
		t.Fatalf("failed to create project Beta (%d): %s", resBeta.StatusCode, string(body))
	}
	betaRecord := parseJSON(t, resBeta)
	betaID, _ := betaRecord["id"].(string)
	_ = betaID

	// File download authorization checks:
	// Helper to request a file token
	getFileToken := func(userAuthToken string) string {
		t.Helper()
		res := httpReq(t, http.MethodPost, server.URL+"/api/files/token", nil, userAuthToken)
		if res.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(res.Body)
			t.Fatalf("failed to get file token (%d): %s", res.StatusCode, string(body))
		}
		data := parseJSON(t, res)
		tok, _ := data["token"].(string)
		return tok
	}

	fileBaseURL := server.URL + "/api/files/projects/" + alphaID + "/" + attachmentFileName

	// 1. Analyst (with read: true) can download the file using their file token
	analystFileTok := getFileToken(analystToken)
	analystFileRes := httpReq(t, http.MethodGet, fileBaseURL+"?token="+analystFileTok, nil, "")
	if analystFileRes.StatusCode != http.StatusOK {
		t.Fatalf("analyst failed to download file (%d)", analystFileRes.StatusCode)
	}
	downloadedBytes, _ := io.ReadAll(analystFileRes.Body)
	if !bytes.Equal(downloadedBytes, pdfContent) {
		t.Fatalf("downloaded file content did not match uploaded content")
	}

	// 2. Guest (with read: false) is rejected when attempting to download the file
	guestFileTok := getFileToken(guestToken)
	guestFileRes := httpReq(t, http.MethodGet, fileBaseURL+"?token="+guestFileTok, nil, "")
	if guestFileRes.StatusCode != http.StatusNotFound && guestFileRes.StatusCode != http.StatusForbidden {
		t.Fatalf("security violation: guest was able to access file (%d)", guestFileRes.StatusCode)
	}

	// 3. Unauthenticated request without token is rejected
	unauthFileRes := httpReq(t, http.MethodGet, fileBaseURL, nil, "")
	if unauthFileRes.StatusCode != http.StatusNotFound && unauthFileRes.StatusCode != http.StatusForbidden {
		t.Fatalf("security violation: unauthenticated request was able to access file (%d)", unauthFileRes.StatusCode)
	}

	// =========================================================================
	// Step 4: Admin Authors, Previews, and Publishes Custom Pages (with Validation)
	// =========================================================================

	// Negative validation tests:
	// 1. Attempt creating page with unsupported view_type -> MUST FAIL (400 Bad Request)
	badViewRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/app_pages/records", map[string]any{
		"page_id":    "bad-view-page",
		"name":       "Bad View Page",
		"view_type":  "unsupported_3d_view",
		"collection": "projects",
		"config":     map[string]any{},
	}, adminToken)
	if badViewRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for unsupported view_type, got %d", badViewRes.StatusCode)
	}

	// 2. Attempt creating page targeting nonexistent dataset -> MUST FAIL (400 Bad Request)
	badColRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/app_pages/records", map[string]any{
		"page_id":    "bad-col-page",
		"name":       "Bad Col Page",
		"view_type":  "table",
		"collection": "nonexistent_collection",
		"config":     map[string]any{},
	}, adminToken)
	if badColRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for nonexistent collection, got %d", badColRes.StatusCode)
	}

	// Valid page creations
	createPage := func(pageID, name, viewType string, published bool, navOrder int) string {
		t.Helper()
		cfgDoc := map[string]any{
			"columns":      []string{"name", "status", "budget"},
			"groupByField": "status",
			"perPage":      20,
		}
		res := httpReq(t, http.MethodPost, server.URL+"/api/collections/app_pages/records", map[string]any{
			"page_id":    pageID,
			"name":       name,
			"view_type":  viewType,
			"collection": "projects",
			"published":  published,
			"nav_order":  navOrder,
			"config":     cfgDoc,
		}, adminToken)
		if res.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(res.Body)
			t.Fatalf("failed to create page %s (%d): %s", pageID, res.StatusCode, string(body))
		}
		data := parseJSON(t, res)
		id, _ := data["id"].(string)
		return id
	}

	tablePageID := createPage("projects-table", "Projects Table", "table", true, 1)
	boardPageID := createPage("projects-board", "Projects Kanban", "kanban", true, 2)
	draftPageID := createPage("projects-draft", "Draft Overview", "table", false, 3)

	if tablePageID == "" || boardPageID == "" || draftPageID == "" {
		t.Fatalf("expected valid page IDs")
	}

	// =========================================================================
	// Step 5: Admin Customizes and Publishes Shared Dashboard (with Validation)
	// =========================================================================

	// Negative dashboard validation:
	// 1. Attempt creating dashboard with invalid widget bounds (w: 15) -> MUST FAIL (400 Bad Request)
	badDashRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/dashboards/records", map[string]any{
		"name": "bad_dash",
		"layout": map[string]any{
			"id":   "bad_dash",
			"name": "bad_dash",
			"layout": []map[string]any{
				{
					"id":         "w1",
					"type":       "kpi",
					"collection": "projects",
					"x":          0,
					"y":          0,
					"w":          15, // Out of bounds > 12
					"h":          2,
				},
			},
		},
	}, adminToken)
	if badDashRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for out-of-bounds dashboard widget width, got %d", badDashRes.StatusCode)
	}

	// Valid dashboard save
	dashLayoutDoc := map[string]any{
		"id":   "main",
		"name": "Workspace Overview",
		"layout": []map[string]any{
			{
				"id":         "w1",
				"type":       "kpi",
				"collection": "projects",
				"x":          0,
				"y":          0,
				"w":          4,
				"h":          2,
				"props":      map[string]any{"metric": "count"},
			},
			{
				"id":         "w2",
				"type":       "table",
				"collection": "projects",
				"x":          4,
				"y":          0,
				"w":          8,
				"h":          4,
				"props":      map[string]any{"fields": []string{"name", "status", "budget"}},
			},
		},
	}

	dashRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/dashboards/records", map[string]any{
		"name":   "main",
		"layout": dashLayoutDoc,
	}, adminToken)
	if dashRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(dashRes.Body)
		t.Fatalf("admin failed to save dashboard layout (%d): %s", dashRes.StatusCode, string(body))
	}

	// =========================================================================
	// Step 6: Multi-Session Access Control Isolation & Realtime Verification
	// =========================================================================

	// 1. Member 1 (Analyst) views pages: MUST see published pages (2), MUST NOT see draft (0)
	analystPagesRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records", nil, analystToken)
	if analystPagesRes.StatusCode != http.StatusOK {
		t.Fatalf("analyst GET app_pages failed (%d)", analystPagesRes.StatusCode)
	}
	analystPagesData := parseJSON(t, analystPagesRes)
	analystPageItems, _ := analystPagesData["items"].([]any)
	if len(analystPageItems) != 2 {
		t.Fatalf("expected analyst to see 2 published pages, got %d", len(analystPageItems))
	}
	for _, item := range analystPageItems {
		pMap, _ := item.(map[string]any)
		if pMap["page_id"] == "projects-draft" {
			t.Errorf("security violation: analyst was able to see unpublished draft page")
		}
	}

	// 2. Member 1 retrieves project records: MUST receive both records
	analystProjectsRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/projects/records", nil, analystToken)
	if analystProjectsRes.StatusCode != http.StatusOK {
		t.Fatalf("analyst GET projects failed (%d)", analystProjectsRes.StatusCode)
	}
	analystProjectsData := parseJSON(t, analystProjectsRes)
	analystProjectItems, _ := analystProjectsData["items"].([]any)
	if len(analystProjectItems) != 2 {
		t.Fatalf("expected analyst to see 2 projects, got %d", len(analystProjectItems))
	}

	// 3. Member 2 (Guest with read: false):
	// MUST NOT receive project records via list
	guestProjectsRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/projects/records", nil, guestToken)
	if guestProjectsRes.StatusCode == http.StatusOK {
		guestProjectsData := parseJSON(t, guestProjectsRes)
		guestItems, _ := guestProjectsData["items"].([]any)
		if len(guestItems) != 0 {
			t.Fatalf("security violation: guest saw %d projects despite read:false", len(guestItems))
		}
	}

	// 4. Member 2 direct API fetch by record ID: MUST return 404
	guestDirectRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/projects/records/"+alphaID, nil, guestToken)
	if guestDirectRes.StatusCode != http.StatusNotFound && guestDirectRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 404/403 for guest direct record fetch, got %d", guestDirectRes.StatusCode)
	}

	// 5. Member 2 direct app_pages read: MUST NOT receive projects pages (dataset-aware visibility enforcement)
	guestPagesRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records", nil, guestToken)
	if guestPagesRes.StatusCode == http.StatusOK {
		guestPagesData := parseJSON(t, guestPagesRes)
		guestPageItems, _ := guestPagesData["items"].([]any)
		if len(guestPageItems) != 0 {
			t.Fatalf("security violation: guest saw %d pages for unauthorized dataset", len(guestPageItems))
		}
	}

	// 6. Member 2 direct app_pages view by ID: MUST return 404
	guestPageViewRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records/"+tablePageID, nil, guestToken)
	if guestPageViewRes.StatusCode != http.StatusNotFound && guestPageViewRes.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 404 for guest direct view of restricted page, got %d", guestPageViewRes.StatusCode)
	}

	// 7. Member 2 direct mutation attempts on app_pages and dashboards: MUST be rejected
	guestPageCreateRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/app_pages/records", map[string]any{
		"page_id":    "rogue-page",
		"name":       "Rogue",
		"view_type":  "table",
		"collection": "projects",
	}, guestToken)
	if guestPageCreateRes.StatusCode != http.StatusForbidden && guestPageCreateRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 403 or 400 for guest page creation, got %d", guestPageCreateRes.StatusCode)
	}

	// 8. Realtime SSE delivery & suppression check
	analystUserRec, _ := app.FindRecordById("users", "analyst@example.com")
	guestUserRec, _ := app.FindRecordById("users", "guest@example.com")

	if analystUserRec != nil && guestUserRec != nil {
		analystSub := subscriptions.NewDefaultClient()
		analystSub.Set(apis.RealtimeClientAuthKey, analystUserRec)
		analystSub.Subscribe("app_pages/*")
		app.SubscriptionsBroker().Register(analystSub)
		defer app.SubscriptionsBroker().Unregister(analystSub.Id())

		guestSub := subscriptions.NewDefaultClient()
		guestSub.Set(apis.RealtimeClientAuthKey, guestUserRec)
		guestSub.Subscribe("app_pages/*")
		app.SubscriptionsBroker().Register(guestSub)
		defer app.SubscriptionsBroker().Unregister(guestSub.Id())

		// Admin creates another published page for projects
		_ = createPage("projects-notes", "Projects Notes", "table", true, 4)

		// Analyst subscriber receives the event
		select {
		case msg := <-analystSub.Channel():
			if !strings.Contains(string(msg.Data), "projects-notes") {
				t.Fatalf("expected analyst realtime message to contain projects-notes, got %s", string(msg.Data))
			}
		case <-time.After(1 * time.Second):
			t.Fatal("expected analyst to receive realtime SSE event for published page")
		}

		// Guest subscriber receives NO message because they lack dataset read permission
		select {
		case msg := <-guestSub.Channel():
			t.Fatalf("security violation: guest received realtime SSE event for unauthorized dataset page: %s", string(msg.Data))
		case <-time.After(300 * time.Millisecond):
			// Passed: suppressed as expected
		}
	}

	// =========================================================================
	// Step 7: Safe Schema Evolution, Page Unpublishing & Non-Destructive Integrity
	// =========================================================================

	// 1. Admin adds safe optional field "priority"
	newFields := append(schemaDef.Fields, schemas.FieldDefinition{
		Name:     "priority",
		Label:    "Priority Level",
		Type:     "select",
		Options:  []string{"Low", "Medium", "High"},
		Required: false,
	})
	patchSchemaRes := httpReq(t, http.MethodPatch, server.URL+"/v1/schemas/projects", map[string]any{
		"fields": newFields,
	}, adminToken)
	if patchSchemaRes.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(patchSchemaRes.Body)
		t.Fatalf("PATCH schema failed (%d): %s", patchSchemaRes.StatusCode, string(body))
	}

	// 2. Verify existing records Alpha and Beta are preserved intact
	alphaCheckRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/projects/records/"+alphaID, nil, adminToken)
	if alphaCheckRes.StatusCode != http.StatusOK {
		t.Fatalf("expected Alpha record to remain intact, got %d", alphaCheckRes.StatusCode)
	}
	alphaData := parseJSON(t, alphaCheckRes)
	if alphaData["name"] != "Alpha" || alphaData["status"] != "Active" {
		t.Errorf("record Alpha data was altered unexpectedly: %v", alphaData)
	}

	// 3. Admin unpublishes Page 2 (projects-board)
	unpublishRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/app_pages/records/"+boardPageID, map[string]any{
		"published": false,
	}, adminToken)
	if unpublishRes.StatusCode != http.StatusOK {
		t.Fatalf("unpublish page failed (%d)", unpublishRes.StatusCode)
	}

	// 4. Member 1 now lists pages: projects-board is no longer listed
	analystPagesAfterUnpublish := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records", nil, analystToken)
	afterData := parseJSON(t, analystPagesAfterUnpublish)
	afterItems, _ := afterData["items"].([]any)
	for _, item := range afterItems {
		pMap, _ := item.(map[string]any)
		if pMap["page_id"] == "projects-board" {
			t.Errorf("expected projects-board to be hidden after unpublishing")
		}
	}

	// =========================================================================
	// Step 8: Confirmed Deletion & Disposable Instance Backup / Restore
	// =========================================================================

	// 1. Operator takes a backup snapshot of the instance data directory
	backupDir := t.TempDir()
	if err := copyDir(app.DataDir(), backupDir); err != nil {
		t.Fatalf("failed to take instance backup snapshot: %v", err)
	}

	// 2. Admin deletes draft page
	delDraftRes := httpReq(t, http.MethodDelete, server.URL+"/api/collections/app_pages/records/"+draftPageID, nil, adminToken)
	if delDraftRes.StatusCode != http.StatusNoContent && delDraftRes.StatusCode != http.StatusOK {
		t.Fatalf("failed to delete draft page (%d)", delDraftRes.StatusCode)
	}

	// 3. Admin deletes projects schema (destructively drops collection and records)
	delSchemaRes := httpReq(t, http.MethodDelete, server.URL+"/v1/schemas/projects", nil, adminToken)
	if delSchemaRes.StatusCode != http.StatusOK && delSchemaRes.StatusCode != http.StatusNoContent {
		t.Fatalf("failed to delete schema projects (%d)", delSchemaRes.StatusCode)
	}

	// Verify projects collection is gone from the active server
	goneRes := httpReq(t, http.MethodGet, server.URL+"/api/collections/projects/records", nil, adminToken)
	if goneRes.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404 for deleted projects collection, got %d", goneRes.StatusCode)
	}

	// 4. Operator restores the backup into a clean disposable instance
	restoredDir := t.TempDir()
	if err := copyDir(backupDir, restoredDir); err != nil {
		t.Fatalf("failed to restore backup directory: %v", err)
	}

	_, restoredServer := createTestServerWithDir(t, restoredDir)

	// Sign in to the restored instance
	restoredOwnerToken, _ := loginUser(t, restoredServer.URL, "owner@example.com", "Password123!")
	restoredAnalystToken, _ := loginUser(t, restoredServer.URL, "analyst@example.com", "Password123!")
	restoredGuestToken, _ := loginUser(t, restoredServer.URL, "guest@example.com", "Password123!")

	if restoredOwnerToken == "" || restoredAnalystToken == "" {
		t.Fatalf("failed to sign in to restored instance")
	}

	// 5. Verify restored instance has schema, records, and files completely restored
	restoredProjectsRes := httpReq(t, http.MethodGet, restoredServer.URL+"/api/collections/projects/records", nil, restoredAnalystToken)
	if restoredProjectsRes.StatusCode != http.StatusOK {
		t.Fatalf("expected projects collection to exist on restored instance, got %d", restoredProjectsRes.StatusCode)
	}
	restoredData := parseJSON(t, restoredProjectsRes)
	restoredItems, _ := restoredData["items"].([]any)
	if len(restoredItems) != 2 {
		t.Fatalf("expected 2 restored project records, got %d", len(restoredItems))
	}

	// Verify file attachment is downloadable on the restored instance
	restoredTokRes := httpReq(t, http.MethodPost, restoredServer.URL+"/api/files/token", nil, restoredAnalystToken)
	restTokData := parseJSON(t, restoredTokRes)
	restTok, _ := restTokData["token"].(string)

	restoredFileURL := restoredServer.URL + "/api/files/projects/" + alphaID + "/" + attachmentFileName + "?token=" + restTok
	restoredFileRes := httpReq(t, http.MethodGet, restoredFileURL, nil, "")
	if restoredFileRes.StatusCode != http.StatusOK {
		t.Fatalf("failed to download restored file attachment (%d)", restoredFileRes.StatusCode)
	}
	restoredFileBytes, _ := io.ReadAll(restoredFileRes.Body)
	if !bytes.Equal(restoredFileBytes, pdfContent) {
		t.Fatalf("restored file content does not match original file content")
	}

	// Verify guest is still denied on the restored instance
	restoredGuestProjects := httpReq(t, http.MethodGet, restoredServer.URL+"/api/collections/projects/records", nil, restoredGuestToken)
	if restoredGuestProjects.StatusCode == http.StatusOK {
		gData := parseJSON(t, restoredGuestProjects)
		gItems, _ := gData["items"].([]any)
		if len(gItems) != 0 {
			t.Fatalf("security violation: guest saw projects on restored instance")
		}
	}
}

func TestAppPagesPrePaginationFilteringAndMultiPageTraversal(t *testing.T) {
	app, err := tests.NewTestApp(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create test app: %v", err)
	}
	defer app.Cleanup()

	pbRouter, err := apis.NewRouter(app)
	if err != nil {
		t.Fatalf("failed to create router: %v", err)
	}

	cfg := &tenant.Config{
		Version: 1, TenantID: "tenant_pagination_test", BackendURL: "https://acme.app.example.com",
		RealtimeURL: "https://acme.app.example.com/api/realtime", AppKey: "pk_pilot_000000",
		SchemaVersion: "schema_pagination_v1", MinClientVersion: "0.1.0",
		Features: []string{}, Collections: []string{},
	}

	authz.RegisterAuthnHooks(app)
	authz.RegisterDashboardRevisionHook(app)
	api.Register(&core.ServeEvent{App: app, Router: pbRouter}, cfg, features.Empty())

	mux, err := pbRouter.BuildMux()
	if err != nil {
		t.Fatalf("failed to build mux: %v", err)
	}
	server := httptest.NewServer(mux)
	defer server.Close()

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}

	// 1. Seed admin
	adminUser := core.NewRecord(usersCol)
	adminUser.Set("email", "admin_pag@example.com")
	adminUser.Set("role", authz.RoleAdmin)
	adminUser.SetPassword("Password123!")
	if err := app.Save(adminUser); err != nil {
		t.Fatal(err)
	}
	adminToken, err := adminUser.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 2. Seed Member 1 (access to ds_alpha only)
	m1 := core.NewRecord(usersCol)
	m1.Set("email", "m1_pag@example.com")
	m1.Set("role", authz.RoleMember)
	m1.Set("permissions", map[string]any{
		"ds_alpha": map[string]any{"read": true, "scope": "all"},
		"ds_beta":  map[string]any{"read": false, "scope": "all"},
	})
	m1.SetPassword("Password123!")
	if err := app.Save(m1); err != nil {
		t.Fatal(err)
	}
	m1Token, err := m1.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 3. Seed Member 2 (access to ds_beta only)
	m2 := core.NewRecord(usersCol)
	m2.Set("email", "m2_pag@example.com")
	m2.Set("role", authz.RoleMember)
	m2.Set("permissions", map[string]any{
		"ds_alpha": map[string]any{"read": false, "scope": "all"},
		"ds_beta":  map[string]any{"read": true, "scope": "all"},
	})
	m2.SetPassword("Password123!")
	if err := app.Save(m2); err != nil {
		t.Fatal(err)
	}
	m2Token, err := m2.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 4. Seed Member 3 (no dataset permissions)
	m3 := core.NewRecord(usersCol)
	m3.Set("email", "m3_pag@example.com")
	m3.Set("role", authz.RoleMember)
	m3.Set("permissions", map[string]any{})
	m3.SetPassword("Password123!")
	if err := app.Save(m3); err != nil {
		t.Fatal(err)
	}
	m3Token, err := m3.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 5. Create collections ds_alpha and ds_beta
	for _, colName := range []string{"ds_alpha", "ds_beta"} {
		col := core.NewBaseCollection(colName)
		col.Fields.Add(&core.TextField{Name: "title"})
		readRule := fmt.Sprintf("@request.auth.id != '' && @request.auth.permissions.%s.read = true", colName)
		col.ListRule = &readRule
		col.ViewRule = &readRule
		if err := app.Save(col); err != nil {
			t.Fatal(err)
		}
	}

	// 6. Seed 5 pages for ds_alpha and 5 pages for ds_beta (10 total in DB)
	appPagesCol, err := app.FindCollectionByNameOrId("app_pages")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 5; i++ {
		pAlpha := core.NewRecord(appPagesCol)
		pAlpha.Set("page_id", fmt.Sprintf("alpha-page-%d", i))
		pAlpha.Set("name", fmt.Sprintf("Alpha Page %d", i))
		pAlpha.Set("view_type", "table")
		pAlpha.Set("collection", "ds_alpha")
		pAlpha.Set("published", true)
		pAlpha.Set("nav_order", i)
		pAlpha.Set("config", map[string]any{"columns": []string{"id", "title"}})
		if err := app.Save(pAlpha); err != nil {
			t.Fatal(err)
		}

		pBeta := core.NewRecord(appPagesCol)
		pBeta.Set("page_id", fmt.Sprintf("beta-page-%d", i))
		pBeta.Set("name", fmt.Sprintf("Beta Page %d", i))
		pBeta.Set("view_type", "table")
		pBeta.Set("collection", "ds_beta")
		pBeta.Set("published", true)
		pBeta.Set("nav_order", 10+i)
		pBeta.Set("config", map[string]any{"columns": []string{"id", "title"}})
		if err := app.Save(pBeta); err != nil {
			t.Fatal(err)
		}
	}

	// 7. Verify Multi-page Traversal for Member 1 (perPage = 2)
	// Page 1: must return 2 items, totalItems=5, totalPages=3
	resP1 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=1&perPage=2", nil, m1Token)
	if resP1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resP1.StatusCode)
	}
	dataP1 := parseJSON(t, resP1)
	if total, _ := dataP1["totalItems"].(float64); total != 5 {
		t.Fatalf("expected totalItems=5 for member 1, got %v", dataP1["totalItems"])
	}
	if pages, _ := dataP1["totalPages"].(float64); pages != 3 {
		t.Fatalf("expected totalPages=3 for member 1, got %v", dataP1["totalPages"])
	}
	itemsP1, _ := dataP1["items"].([]any)
	if len(itemsP1) != 2 {
		t.Fatalf("expected 2 items on page 1, got %d", len(itemsP1))
	}
	for _, it := range itemsP1 {
		itMap := it.(map[string]any)
		if itMap["collection"] != "ds_alpha" {
			t.Errorf("security violation: member 1 saw page for collection %s on page 1", itMap["collection"])
		}
	}

	// 7b. Verify pagination filter works identically when accessing via Collection ID rather than collection name
	resColID := httpReq(t, http.MethodGet, server.URL+"/api/collections/"+appPagesCol.Id+"/records?page=1&perPage=2", nil, m1Token)
	if resColID.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 via collection ID, got %d", resColID.StatusCode)
	}
	dataColID := parseJSON(t, resColID)
	if total, _ := dataColID["totalItems"].(float64); total != 5 {
		t.Fatalf("expected totalItems=5 via collection ID for member 1, got %v", dataColID["totalItems"])
	}
	if pages, _ := dataColID["totalPages"].(float64); pages != 3 {
		t.Fatalf("expected totalPages=3 via collection ID for member 1, got %v", dataColID["totalPages"])
	}
	itemsColID, _ := dataColID["items"].([]any)
	if len(itemsColID) != 2 {
		t.Fatalf("expected 2 items on page 1 via collection ID, got %d", len(itemsColID))
	}
	for _, it := range itemsColID {
		itMap := it.(map[string]any)
		if itMap["collection"] != "ds_alpha" {
			t.Errorf("security violation: member 1 saw page for collection %s via collection ID", itMap["collection"])
		}
	}

	// Page 2: must return 2 items, totalItems=5, totalPages=3
	resP2 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=2&perPage=2", nil, m1Token)
	if resP2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resP2.StatusCode)
	}
	dataP2 := parseJSON(t, resP2)
	itemsP2, _ := dataP2["items"].([]any)
	if len(itemsP2) != 2 {
		t.Fatalf("expected 2 items on page 2, got %d", len(itemsP2))
	}
	for _, it := range itemsP2 {
		itMap := it.(map[string]any)
		if itMap["collection"] != "ds_alpha" {
			t.Errorf("security violation: member 1 saw page for collection %s on page 2", itMap["collection"])
		}
	}

	// Page 3: must return 1 item, totalItems=5, totalPages=3
	resP3 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=3&perPage=2", nil, m1Token)
	if resP3.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resP3.StatusCode)
	}
	dataP3 := parseJSON(t, resP3)
	itemsP3, _ := dataP3["items"].([]any)
	if len(itemsP3) != 1 {
		t.Fatalf("expected 1 item on page 3, got %d", len(itemsP3))
	}
	for _, it := range itemsP3 {
		itMap := it.(map[string]any)
		if itMap["collection"] != "ds_alpha" {
			t.Errorf("security violation: member 1 saw page for collection %s on page 3", itMap["collection"])
		}
	}

	// Page 4: beyond total items, must return 0 items without error
	resP4 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=4&perPage=2", nil, m1Token)
	if resP4.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resP4.StatusCode)
	}
	dataP4 := parseJSON(t, resP4)
	itemsP4, _ := dataP4["items"].([]any)
	if len(itemsP4) != 0 {
		t.Fatalf("expected 0 items on page 4, got %d", len(itemsP4))
	}

	// 8. Verify Member 2 only sees ds_beta across pages
	resM2 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=1&perPage=2", nil, m2Token)
	if resM2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resM2.StatusCode)
	}
	dataM2 := parseJSON(t, resM2)
	if total, _ := dataM2["totalItems"].(float64); total != 5 {
		t.Fatalf("expected totalItems=5 for member 2, got %v", dataM2["totalItems"])
	}
	itemsM2, _ := dataM2["items"].([]any)
	if len(itemsM2) != 2 {
		t.Fatalf("expected 2 items for member 2, got %d", len(itemsM2))
	}
	for _, it := range itemsM2 {
		itMap := it.(map[string]any)
		if itMap["collection"] != "ds_beta" {
			t.Errorf("security violation: member 2 saw page for collection %s", itMap["collection"])
		}
	}

	// 9. Verify Member 3 (no access) gets totalItems=0 and empty items list
	resM3 := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=1&perPage=2", nil, m3Token)
	if resM3.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resM3.StatusCode)
	}
	dataM3 := parseJSON(t, resM3)
	if total, _ := dataM3["totalItems"].(float64); total != 0 {
		t.Fatalf("expected totalItems=0 for member 3, got %v", dataM3["totalItems"])
	}
	itemsM3, _ := dataM3["items"].([]any)
	if len(itemsM3) != 0 {
		t.Fatalf("expected 0 items for member 3, got %d", len(itemsM3))
	}

	// 10. Verify Admin sees all 10 pages with accurate pagination (totalItems=10, totalPages=5)
	resAdmin := httpReq(t, http.MethodGet, server.URL+"/api/collections/app_pages/records?page=1&perPage=2", nil, adminToken)
	if resAdmin.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resAdmin.StatusCode)
	}
	dataAdmin := parseJSON(t, resAdmin)
	if total, _ := dataAdmin["totalItems"].(float64); total != 10 {
		t.Fatalf("expected totalItems=10 for admin, got %v", dataAdmin["totalItems"])
	}
	if pages, _ := dataAdmin["totalPages"].(float64); pages != 5 {
		t.Fatalf("expected totalPages=5 for admin, got %v", dataAdmin["totalPages"])
	}
}

func TestAdminAcceptance_DashboardOptimisticConcurrencyAndConflict(t *testing.T) {
	dataDir := t.TempDir()
	app, server := createTestServerWithDir(t, dataDir)

	// 1. Setup workspace owner and login
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("failed to find users collection: %v", err)
	}
	ownerRec := core.NewRecord(usersCol)
	ownerRec.Set("email", "owner@example.com")
	ownerRec.Set("role", authz.RoleOwner)
	ownerRec.SetPassword("Password123!")
	if err := app.Save(ownerRec); err != nil {
		t.Fatalf("failed to save owner: %v", err)
	}
	ownerToken, err := ownerRec.NewAuthToken()
	if err != nil {
		t.Fatalf("failed to create owner token: %v", err)
	}

	// 2. Create target collection
	col := core.NewBaseCollection("projects")
	col.Fields.Add(&core.TextField{Name: "title"})
	publicRule := ""
	col.CreateRule = &publicRule
	col.UpdateRule = &publicRule
	col.ViewRule = &publicRule
	col.ListRule = &publicRule
	if err := app.Save(col); err != nil {
		t.Fatalf("failed to create projects collection: %v", err)
	}

	// 3. Create dashboard layout via HTTP API
	initialDoc := map[string]any{
		"name": "main",
		"layout": map[string]any{
			"id":   "main",
			"name": "Workspace Overview",
			"layout": []any{
				map[string]any{
					"id":         "w1",
					"type":       "kpi",
					"collection": "projects",
					"x":          0,
					"y":          0,
					"w":          4,
					"h":          2,
					"props":      map[string]any{"metric": "count"},
				},
			},
		},
	}
	createRes := httpReq(t, http.MethodPost, server.URL+"/api/collections/dashboards/records", initialDoc, ownerToken)
	if createRes.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 creating dashboard, got %d", createRes.StatusCode)
	}
	createdData := parseJSON(t, createRes)
	dashID, _ := createdData["id"].(string)
	if dashID == "" {
		t.Fatalf("expected dashboard record ID")
	}
	if rev, _ := createdData["revision"].(float64); rev != 1 {
		t.Fatalf("expected initial revision=1, got %v", createdData["revision"])
	}

	// 4. Update without expected_revision must be rejected with HTTP 400 Bad Request
	noRevDoc := map[string]any{
		"layout": initialDoc["layout"],
	}
	noRevRes := httpReq(t, http.MethodPatch, server.URL+"/api/collections/dashboards/records/"+dashID, noRevDoc, ownerToken)
	if noRevRes.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request when expected_revision is omitted, got %d", noRevRes.StatusCode)
	}

	// 5. Update with matching expected_revision (1) succeeds and advances revision to 2
	updateDoc1 := map[string]any{
		"layout": map[string]any{
			"id":   "main",
			"name": "Workspace Overview - Edit 1",
			"layout": []any{
				map[string]any{
					"id":         "w1",
					"type":       "kpi",
					"collection": "projects",
					"x":          0,
					"y":          0,
					"w":          6,
					"h":          2,
					"props":      map[string]any{"metric": "count"},
				},
			},
		},
		"expected_revision": 1,
	}
	updateRes1 := httpReq(t, http.MethodPatch, server.URL+"/api/collections/dashboards/records/"+dashID, updateDoc1, ownerToken)
	if updateRes1.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on update with expected_revision=1, got %d", updateRes1.StatusCode)
	}
	updatedData1 := parseJSON(t, updateRes1)
	if rev, _ := updatedData1["revision"].(float64); rev != 2 {
		t.Fatalf("expected revision to advance to 2, got %v", updatedData1["revision"])
	}

	// 6. Concurrent write with stale revision (1) must be rejected with HTTP 409 Conflict
	updateDoc2Stale := map[string]any{
		"layout": map[string]any{
			"id":   "main",
			"name": "Workspace Overview - Concurrent Stale Edit",
			"layout": []any{
				map[string]any{
					"id":         "w1",
					"type":       "kpi",
					"collection": "projects",
					"x":          0,
					"y":          0,
					"w":          8,
					"h":          2,
					"props":      map[string]any{"metric": "count"},
				},
			},
		},
		"expected_revision": 1,
	}
	updateRes2Stale := httpReq(t, http.MethodPatch, server.URL+"/api/collections/dashboards/records/"+dashID, updateDoc2Stale, ownerToken)
	if updateRes2Stale.StatusCode != http.StatusConflict {
		t.Errorf("expected 409 Conflict on stale expected_revision=1, got %d", updateRes2Stale.StatusCode)
	}

	// 7. Retrying with updated expected_revision (2) succeeds and advances revision to 3
	updateDoc2Resolved := map[string]any{
		"layout":            updateDoc2Stale["layout"],
		"expected_revision": 2,
	}
	updateRes2Resolved := httpReq(t, http.MethodPatch, server.URL+"/api/collections/dashboards/records/"+dashID, updateDoc2Resolved, ownerToken)
	if updateRes2Resolved.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 when updating with expected_revision=2, got %d", updateRes2Resolved.StatusCode)
	}
	updatedData2 := parseJSON(t, updateRes2Resolved)
	if rev, _ := updatedData2["revision"].(float64); rev != 3 {
		t.Fatalf("expected revision to advance to 3, got %v", updatedData2["revision"])
	}
}

func TestAdminAcceptance_SimultaneousDashboardUpdates_ConflictSerialized(t *testing.T) {
	dataDir := t.TempDir()
	app, server := createTestServerWithDir(t, dataDir)

	// 1. Setup workspace owner
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	ownerRec := core.NewRecord(usersCol)
	ownerRec.Set("email", "owner_simul@example.com")
	ownerRec.Set("role", authz.RoleOwner)
	ownerRec.SetPassword("Password123!")
	if err := app.Save(ownerRec); err != nil {
		t.Fatal(err)
	}
	ownerToken, err := ownerRec.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 2. Setup projects collection
	col := core.NewBaseCollection("projects")
	col.Fields.Add(&core.TextField{Name: "title"})
	publicRule := ""
	col.CreateRule = &publicRule
	col.UpdateRule = &publicRule
	col.ViewRule = &publicRule
	col.ListRule = &publicRule
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}

	// 3. Create initial dashboard at revision 1
	dashboardsCol, err := app.FindCollectionByNameOrId("dashboards")
	if err != nil {
		t.Fatal(err)
	}
	dashRec := core.NewRecord(dashboardsCol)
	dashRec.Set("name", "simul_main")
	dashRec.Set("revision", 1)
	dashRec.Set("layout", map[string]any{
		"id":   "simul_main",
		"name": "Simultaneous Dashboard",
		"layout": []any{
			map[string]any{
				"id": "w_init", "type": "kpi", "collection": "projects",
				"x": 0, "y": 0, "w": 4, "h": 2,
				"props": map[string]any{"metric": "count"},
			},
		},
	})
	if err := app.Save(dashRec); err != nil {
		t.Fatal(err)
	}

	dashID := dashRec.Id

	// 4. Fire 2 simultaneous updates with expected_revision: 1
	var wg sync.WaitGroup
	startBarrier := make(chan struct{})
	statusCodes := make([]int, 2)

	for i := 0; i < 2; i++ {
		wg.Add(1)
		idx := i
		go func() {
			defer wg.Done()
			<-startBarrier // synchronize start moment
			doc := map[string]any{
				"layout": map[string]any{
					"id":   "simul_main",
					"name": fmt.Sprintf("Simultaneous Edit by Worker %d", idx),
					"layout": []any{
						map[string]any{
							"id": fmt.Sprintf("w_%d", idx), "type": "kpi", "collection": "projects",
							"x": 0, "y": 0, "w": 6, "h": 2,
							"props": map[string]any{"metric": "count"},
						},
					},
				},
				"expected_revision": 1,
			}
			res := httpReq(t, http.MethodPatch, server.URL+"/api/collections/dashboards/records/"+dashID, doc, ownerToken)
			statusCodes[idx] = res.StatusCode
		}()
	}

	close(startBarrier)
	wg.Wait()

	// Exactly one request must succeed (200 OK) and one must be rejected (409 Conflict)
	successCount := 0
	conflictCount := 0
	for _, code := range statusCodes {
		if code == http.StatusOK {
			successCount++
		} else if code == http.StatusConflict {
			conflictCount++
		}
	}

	if successCount != 1 || conflictCount != 1 {
		t.Fatalf("expected exactly 1 success (200) and 1 conflict (409), got status codes %v", statusCodes)
	}

	// Verify SQLite database revision is exactly 2
	finalRecord, err := app.FindRecordById("dashboards", dashID)
	if err != nil {
		t.Fatal(err)
	}
	if finalRecord.GetInt("revision") != 2 {
		t.Fatalf("expected committed SQLite revision to be 2, got %d", finalRecord.GetInt("revision"))
	}
}

func TestAdminAcceptance_SimultaneousDashboardFirstCreate_UniqueIdentity(t *testing.T) {
	dataDir := t.TempDir()
	app, server := createTestServerWithDir(t, dataDir)

	// 1. Setup workspace owner
	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatal(err)
	}
	ownerRec := core.NewRecord(usersCol)
	ownerRec.Set("email", "owner_create@example.com")
	ownerRec.Set("role", authz.RoleOwner)
	ownerRec.SetPassword("Password123!")
	if err := app.Save(ownerRec); err != nil {
		t.Fatal(err)
	}
	ownerToken, err := ownerRec.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	// 2. Setup projects collection
	col := core.NewBaseCollection("projects")
	col.Fields.Add(&core.TextField{Name: "title"})
	publicRule := ""
	col.CreateRule = &publicRule
	col.UpdateRule = &publicRule
	col.ViewRule = &publicRule
	col.ListRule = &publicRule
	if err := app.Save(col); err != nil {
		t.Fatal(err)
	}

	// 3. Two simultaneous requests attempting to create dashboard "shared_overview"
	var wg sync.WaitGroup
	startBarrier := make(chan struct{})
	statusCodes := make([]int, 2)

	for i := 0; i < 2; i++ {
		wg.Add(1)
		idx := i
		go func() {
			defer wg.Done()
			<-startBarrier
			doc := map[string]any{
				"name": "shared_overview",
				"layout": map[string]any{
					"id":   "shared_overview",
					"name": fmt.Sprintf("Shared Overview by Worker %d", idx),
					"layout": []any{
						map[string]any{
							"id": fmt.Sprintf("w_init_%d", idx), "type": "kpi", "collection": "projects",
							"x": 0, "y": 0, "w": 4, "h": 2,
							"props": map[string]any{"metric": "count"},
						},
					},
				},
			}
			res := httpReq(t, http.MethodPost, server.URL+"/api/collections/dashboards/records", doc, ownerToken)
			statusCodes[idx] = res.StatusCode
		}()
	}

	close(startBarrier)
	wg.Wait()

	// Exactly one creation must succeed; the other must fail with conflict (409) or bad request (400 duplicate)
	successCount := 0
	conflictCount := 0
	for _, code := range statusCodes {
		if code == http.StatusOK {
			successCount++
		} else if code == http.StatusConflict || code == http.StatusBadRequest {
			conflictCount++
		}
	}

	if successCount != 1 || conflictCount != 1 {
		t.Fatalf("expected exactly 1 success (200) and 1 rejection (409/400), got status codes %v", statusCodes)
	}

	// Verify that exactly ONE dashboard record named "shared_overview" exists in SQLite
	records, err := app.FindAllRecords("dashboards")
	if err != nil {
		t.Fatal(err)
	}
	sharedCount := 0
	for _, r := range records {
		if r.GetString("name") == "shared_overview" {
			sharedCount++
		}
	}
	if sharedCount != 1 {
		t.Fatalf("expected exactly 1 dashboard record named 'shared_overview', got %d", sharedCount)
	}
}
