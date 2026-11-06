package authz

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/Lattice/backend/internal/platform/tenant"
)

const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleMember = "member"

	ScopeAll      = "all"
	ScopeAssigned = "assigned"
)

var (
	ErrSetupAlreadyCompleted = errors.New("workspace is already initialized")
	ErrInvalidSetupToken     = errors.New("invalid or expired setup token")
	ErrLastOwnerProtection   = errors.New("cannot delete, disable, or demote the last active workspace owner")
	ErrAdminCannotEscalate   = errors.New("admins cannot promote accounts to owner or modify owner accounts")
	ErrPermissionDenied      = errors.New("permission denied")
	ErrInvalidInvitation     = errors.New("invitation is invalid, expired, or already accepted")
)

var (
	managedModulesMu sync.RWMutex
	managedModules   = map[string]bool{
		"customer_job_tracking": true,
	}

	dashboardSyncMu sync.Mutex
)

// RegisterManagedModule registers a module identifier that cannot be directly modified via the generic records API.
func RegisterManagedModule(id string) {
	managedModulesMu.Lock()
	defer managedModulesMu.Unlock()
	managedModules[id] = true
}

// IsManagedModule returns whether the specified module ID is a protected managed module.
func IsManagedModule(id string) bool {
	managedModulesMu.RLock()
	defer managedModulesMu.RUnlock()
	return managedModules[id]
}

type DatasetPermission struct {
	Read   bool   `json:"read"`
	Create bool   `json:"create"`
	Update bool   `json:"update"`
	Delete bool   `json:"delete"`
	Scope  string `json:"scope"` // "all" or "assigned"
}

type PermissionsMap map[string]DatasetPermission

type SetupMeta struct {
	TokenHash string    `json:"token_hash"`
	PlainToken string   `json:"plain_token,omitempty"`
	ExpiresAt time.Time `json:"expires_at"`
	Completed bool      `json:"completed"`
}

// IsOwner returns true if auth record is an active owner.
func IsOwner(auth *core.Record) bool {
	if auth == nil || auth.Collection().Name != "users" {
		return false
	}
	return auth.GetString("role") == RoleOwner && !auth.GetBool("disabled")
}

// IsAdmin returns true if auth record is an active admin.
func IsAdmin(auth *core.Record) bool {
	if auth == nil || auth.Collection().Name != "users" {
		return false
	}
	return auth.GetString("role") == RoleAdmin && !auth.GetBool("disabled")
}

// IsOwnerOrAdmin returns true if auth record is an active owner or admin.
func IsOwnerOrAdmin(auth *core.Record) bool {
	if auth == nil || auth.Collection().Name != "users" {
		return false
	}
	role := auth.GetString("role")
	return (role == RoleOwner || role == RoleAdmin) && !auth.GetBool("disabled")
}

// HasOwner checks if at least one active owner exists in the workspace.
func HasOwner(app core.App) (bool, error) {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return false, nil
	}
	rec, err := app.FindFirstRecordByFilter("users", "role = {:role} && disabled != true", map[string]any{
		"role": RoleOwner,
	})
	if err == nil && rec != nil {
		return true, nil
	}
	return false, nil
}

// IsLastOwner checks if the specified user is the only active owner in the workspace.
// Returns (true, nil) if userID is the single active owner, (false, nil) if other active owners exist,
// or (false, err) if active owner status cannot be verified.
func IsLastOwner(app core.App, userID string) (bool, error) {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return false, errors.New("database not available")
	}
	owners, err := app.FindRecordsByFilter("users", "role = {:role} && disabled != true", "", 5, 0, map[string]any{
		"role": RoleOwner,
	})
	if err != nil {
		return false, fmt.Errorf("failed to query active owners: %w", err)
	}
	if len(owners) == 0 {
		return false, errors.New("cannot verify active owners count: no active owners found")
	}
	if len(owners) == 1 && owners[0].Id == userID {
		return true, nil
	}
	return false, nil
}

// GetUserPermissions safely extracts and parses dataset permissions from a user record.
func GetUserPermissions(auth *core.Record) PermissionsMap {
	result := make(PermissionsMap)
	if auth == nil {
		return result
	}
	raw := auth.Get("permissions")
	if raw == nil {
		return result
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return result
	}
	_ = json.Unmarshal(data, &result)
	return result
}

// CheckDatasetAction checks if an authenticated user is permitted to perform the specified action.
func CheckDatasetAction(auth *core.Record, dataset string, action string) bool {
	if auth == nil || auth.GetBool("disabled") {
		return false
	}
	role := auth.GetString("role")
	if role == RoleOwner || role == RoleAdmin {
		return true
	}
	if role != RoleMember {
		return false
	}

	perms := GetUserPermissions(auth)
	p, ok := perms[dataset]
	if !ok {
		return false // Deny by default
	}

	switch strings.ToLower(action) {
	case "read", "list", "view":
		return p.Read
	case "create":
		return p.Create
	case "update":
		return p.Update
	case "delete":
		return p.Delete
	default:
		return false
	}
}

// Setup secret file path helper
func setupFilePath(app core.App) string {
	dataDir := "."
	if app != nil && app.DataDir() != "" {
		dataDir = app.DataDir()
	}
	return filepath.Join(dataDir, "workspace_setup.json")
}

var setupMu sync.Mutex

// GetOrCreateSetupToken retrieves an existing valid setup token or generates a new 24h token.
func GetOrCreateSetupToken(app core.App) (string, error) {
	setupMu.Lock()
	defer setupMu.Unlock()

	hasOwner, err := HasOwner(app)
	if err != nil {
		return "", err
	}
	if hasOwner {
		return "", ErrSetupAlreadyCompleted
	}

	// 1. Check workspace_setup collection in DB first
	setupCol, _ := app.FindCollectionByNameOrId("workspace_setup")
	if setupCol != nil {
		records, _ := app.FindRecordsByFilter("workspace_setup", "", "-created", 1, 0)
		if len(records) > 0 {
			rec := records[0]
			if rec.GetBool("completed") {
				return "", ErrSetupAlreadyCompleted
			}
			plain := rec.GetString("plain_token")
			expiresAt := rec.GetDateTime("expires_at").Time()
			if plain != "" && time.Now().Before(expiresAt) {
				return plain, nil
			}
		}
	}

	// 2. Fallback check file
	path := setupFilePath(app)
	if data, err := os.ReadFile(path); err == nil {
		var meta SetupMeta
		if jsonErr := json.Unmarshal(data, &meta); jsonErr == nil {
			if meta.Completed {
				return "", ErrSetupAlreadyCompleted
			}
			if time.Now().Before(meta.ExpiresAt) && meta.PlainToken != "" {
				return meta.PlainToken, nil
			}
		}
	}

	// 3. Generate fresh 32-byte hex token
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	plainToken := "lattice_setup_" + hex.EncodeToString(bytes)
	hash := sha256Hex(plainToken)

	// Save to DB collection if available
	if setupCol != nil {
		rec := core.NewRecord(setupCol)
		rec.Set("token_hash", hash)
		rec.Set("plain_token", plainToken)
		rec.Set("expires_at", time.Now().Add(24*time.Hour))
		rec.Set("completed", false)
		_ = app.Save(rec)
	}

	// Persist to file for operator convenience
	meta := SetupMeta{
		TokenHash:  hash,
		PlainToken: plainToken,
		ExpiresAt:  time.Now().Add(24 * time.Hour),
		Completed:  false,
	}

	encoded, _ := json.MarshalIndent(meta, "", "  ")
	_ = os.WriteFile(path, encoded, 0600)

	return plainToken, nil
}

// CreateOwnerWithSetupToken transactionally verifies the setup token, creates the owner account,
// and marks setup complete within a single database transaction. Concurrent setup attempts are
// serialized and fail with ErrSetupAlreadyCompleted if ownership has already been claimed.
func CreateOwnerWithSetupToken(app core.App, token, email, name, password string) (*core.Record, error) {
	setupMu.Lock()
	defer setupMu.Unlock()

	var owner *core.Record
	txErr := app.RunInTransaction(func(txApp core.App) error {
		hasOwner, err := HasOwner(txApp)
		if err != nil {
			return err
		}
		if hasOwner {
			return ErrSetupAlreadyCompleted
		}

		// 1. Verify token against workspace_setup collection
		var setupRec *core.Record
		setupCol, _ := txApp.FindCollectionByNameOrId("workspace_setup")
		if setupCol != nil {
			records, _ := txApp.FindRecordsByFilter("workspace_setup", "", "-created", 1, 0)
			if len(records) > 0 {
				setupRec = records[0]
				if setupRec.GetBool("completed") {
					return ErrSetupAlreadyCompleted
				}

				hash := sha256Hex(token)
				matchHash := hash == setupRec.GetString("token_hash")
				matchPlain := setupRec.GetString("plain_token") == token
				envToken := os.Getenv("WORKSPACE_SETUP_TOKEN")
				matchEnv := envToken != "" && envToken == token

				if !matchHash && !matchPlain && !matchEnv {
					return ErrInvalidSetupToken
				}
				expiresAt := setupRec.GetDateTime("expires_at").Time()
				if !expiresAt.IsZero() && time.Now().After(expiresAt) && !matchEnv {
					return ErrInvalidSetupToken
				}
			}
		}

		if setupRec == nil {
			// Fallback check against file
			if err := validateSetupTokenAgainstFile(txApp, token); err != nil {
				return err
			}
		}

		// 2. Create owner user
		usersCol, err := txApp.FindCollectionByNameOrId("users")
		if err != nil || usersCol == nil {
			return errors.New("users collection not found")
		}

		owner = core.NewRecord(usersCol)
		owner.Set("email", email)
		owner.Set("name", name)
		owner.Set("role", RoleOwner)
		owner.Set("disabled", false)
		owner.SetPassword(password)

		if err := txApp.Save(owner); err != nil {
			return fmt.Errorf("failed to save owner: %w", err)
		}

		// 3. Mark setup as completed transactionally in DB
		if setupRec != nil {
			setupRec.Set("completed", true)
			setupRec.Set("plain_token", "")
			if err := txApp.Save(setupRec); err != nil {
				return fmt.Errorf("failed to mark setup complete in DB: %w", err)
			}
		} else if setupCol != nil {
			newRec := core.NewRecord(setupCol)
			newRec.Set("token_hash", sha256Hex(token))
			newRec.Set("plain_token", "")
			newRec.Set("completed", true)
			newRec.Set("expires_at", types.NowDateTime())
			if err := txApp.Save(newRec); err != nil {
				return fmt.Errorf("failed to save setup record: %w", err)
			}
		}

		// 4. Mark setup file complete
		markSetupFileCompleted(txApp)

		return nil
	})

	if txErr != nil {
		return nil, txErr
	}

	return owner, nil
}

// ValidateAndConsumeSetupToken validates the setup secret and marks bootstrap as complete.
// Preserved for backward compatibility; prefer CreateOwnerWithSetupToken.
func ValidateAndConsumeSetupToken(app core.App, token string) error {
	hasOwner, _ := HasOwner(app)
	if hasOwner {
		return ErrSetupAlreadyCompleted
	}
	return validateSetupTokenAgainstFile(app, token)
}

func validateSetupTokenAgainstFile(app core.App, token string) error {
	path := setupFilePath(app)
	data, err := os.ReadFile(path)
	if err != nil {
		envToken := os.Getenv("WORKSPACE_SETUP_TOKEN")
		if envToken != "" && envToken == token {
			return nil
		}
		return ErrInvalidSetupToken
	}

	var meta SetupMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return ErrInvalidSetupToken
	}

	if meta.Completed {
		return ErrSetupAlreadyCompleted
	}
	if time.Now().After(meta.ExpiresAt) {
		return ErrInvalidSetupToken
	}

	hash := sha256Hex(token)
	if hash != meta.TokenHash && meta.PlainToken != token {
		return ErrInvalidSetupToken
	}

	return nil
}

func markSetupFileCompleted(app core.App) {
	path := setupFilePath(app)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var meta SetupMeta
	if err := json.Unmarshal(data, &meta); err == nil {
		meta.Completed = true
		meta.PlainToken = ""
		updated, _ := json.MarshalIndent(meta, "", "  ")
		_ = os.WriteFile(path, updated, 0600)
	}
}

func sha256Hex(input string) string {
	h := sha256.Sum256([]byte(input))
	return hex.EncodeToString(h[:])
}

// RecoverOwner allows operator CLI to create or promote an owner account directly.
func RecoverOwner(app core.App, email string, password string) (*core.Record, error) {
	if _, err := mail.ParseAddress(email); err != nil {
		return nil, fmt.Errorf("invalid email address: %w", err)
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		return nil, errors.New("users collection not found")
	}

	existing, _ := app.FindFirstRecordByFilter("users", "email = {:email}", map[string]any{"email": email})
	if existing != nil {
		existing.Set("role", RoleOwner)
		existing.Set("disabled", false)
		if password != "" {
			existing.SetPassword(password)
		}
		if err := app.Save(existing); err != nil {
			return nil, err
		}
		return existing, nil
	}

	rec := core.NewRecord(usersCol)
	rec.Set("email", email)
	rec.Set("role", RoleOwner)
	rec.Set("disabled", false)
	rec.SetPassword(password)
	if err := app.Save(rec); err != nil {
		return nil, err
	}
	return rec, nil
}

type StrictDatasetPermission struct {
	Read   *bool   `json:"read,omitempty"`
	Create *bool   `json:"create,omitempty"`
	Update *bool   `json:"update,omitempty"`
	Delete *bool   `json:"delete,omitempty"`
	Scope  *string `json:"scope,omitempty"`
}

// ValidateAssignedScopePermissions checks that every entry in perms adheres strictly to the DatasetPermission contract
// (valid types, no unknown properties, valid scope) and that any dataset with ScopeAssigned has a valid SchemaDefinition with a non-empty AssigneeField.
func ValidateAssignedScopePermissions(app core.App, perms any) error {
	if perms == nil || app == nil {
		return nil
	}
	var data []byte
	switch v := perms.(type) {
	case []byte:
		data = v
	case string:
		data = []byte(v)
	default:
		var err error
		data, err = json.Marshal(perms)
		if err != nil {
			return fmt.Errorf("invalid permissions payload: %w", err)
		}
	}

	data = bytes.TrimSpace(data)
	if len(data) == 0 || string(data) == "null" {
		return nil
	}

	// Must be a valid JSON object mapping dataset names to permission objects
	var rawEntries map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&rawEntries); err != nil {
		return fmt.Errorf("invalid permissions format: must be a JSON object: %w", err)
	}

	// Validate against the shared WorkspaceUser JSON schema contract
	var docMap map[string]any
	if err := json.Unmarshal(data, &docMap); err == nil {
		mockUser := map[string]any{
			"id":          "usr_contract_chk",
			"email":       "chk@example.com",
			"role":        RoleMember,
			"permissions": docMap,
		}
		if err := tenant.ValidateContractDocument("WorkspaceUser", mockUser); err != nil {
			return fmt.Errorf("permissions violate workspace-user contract: %w", err)
		}
	}

	for schemaID, rawVal := range rawEntries {
		var strictPerm StrictDatasetPermission
		entryDec := json.NewDecoder(bytes.NewReader(rawVal))
		entryDec.DisallowUnknownFields()
		if err := entryDec.Decode(&strictPerm); err != nil {
			return fmt.Errorf("invalid permission entry for %q: %w", schemaID, err)
		}

		if strictPerm.Scope != nil && *strictPerm.Scope != "" {
			scope := *strictPerm.Scope
			if scope != ScopeAll && scope != ScopeAssigned {
				return fmt.Errorf("unsupported permission scope %q for %q: must be 'all' or 'assigned'", scope, schemaID)
			}
			if scope == ScopeAssigned {
				schemaDef, err := findSchemaDefinition(app, schemaID)
				if err != nil || schemaDef == nil || schemaDef.AssigneeField == "" {
					return fmt.Errorf("cannot grant 'assigned' scope on dataset %q: dataset does not have an assignee_field configured", schemaID)
				}
			}
		}
	}

	return nil
}

// CreateInvitation generates an invitation for a member or admin.
func CreateInvitation(app core.App, inviter *core.Record, email string, role string, perms map[string]any) (*core.Record, error) {
	if role != RoleAdmin && role != RoleMember {
		return nil, errors.New("invalid invitation role: must be admin or member")
	}
	if role == RoleAdmin && !IsOwner(inviter) {
		return nil, ErrAdminCannotEscalate
	}

	invCol, err := app.FindCollectionByNameOrId("invitations")
	if err != nil || invCol == nil {
		return nil, errors.New("invitations collection not found")
	}

	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(bytes)

	rec := core.NewRecord(invCol)
	rec.Set("email", email)
	rec.Set("role", role)
	rec.Set("permissions", perms)
	rec.Set("token", token)
	rec.Set("expires_at", types.NowDateTime().AddDate(0, 0, 7)) // 7 days TTL
	rec.Set("revoked", false)
	if inviter != nil {
		rec.Set("invited_by", inviter.Id)
	}

	var savedRec *core.Record
	txErr := app.RunInTransaction(func(txApp core.App) error {
		if err := ValidateAssignedScopePermissions(txApp, perms); err != nil {
			return err
		}
		if err := txApp.Save(rec); err != nil {
			return err
		}
		savedRec = rec
		return nil
	})
	if txErr != nil {
		return nil, txErr
	}
	return savedRec, nil
}

// AcceptInvitation consumes a single-use invitation and creates the user account.
func AcceptInvitation(app core.App, token string, name string, password string) (*core.Record, error) {
	if token == "" || len(password) < 8 {
		return nil, errors.New("token and password (min 8 chars) are required")
	}

	var user *core.Record
	txErr := app.RunInTransaction(func(txApp core.App) error {
		invCol, err := txApp.FindCollectionByNameOrId("invitations")
		if err != nil || invCol == nil {
			return errors.New("invitations collection not found")
		}

		usersCol, err := txApp.FindCollectionByNameOrId("users")
		if err != nil || usersCol == nil {
			return errors.New("users collection not found")
		}

		// Reload the invitation fresh inside the transaction
		rec, err := txApp.FindFirstRecordByFilter("invitations", "token = {:token}", map[string]any{
			"token": token,
		})
		if err != nil || rec == nil {
			return ErrInvalidInvitation
		}

		// Verify revocation state inside transaction
		if rec.GetBool("revoked") {
			return ErrInvalidInvitation
		}

		// Verify single-use acceptance state inside transaction
		if rec.GetString("accepted_at") != "" {
			return ErrInvalidInvitation
		}

		// Verify token expiry inside transaction
		expiresAt := rec.GetDateTime("expires_at").Time()
		if time.Now().After(expiresAt) {
			return ErrInvalidInvitation
		}

		email := rec.GetString("email")
		existingUser, _ := txApp.FindFirstRecordByFilter("users", "email = {:email}", map[string]any{"email": email})
		if existingUser != nil {
			return errors.New("a user with this email address already exists")
		}

		if err := ValidateAssignedScopePermissions(txApp, rec.Get("permissions")); err != nil {
			return fmt.Errorf("cannot accept invitation: %w", err)
		}

		user = core.NewRecord(usersCol)
		user.Set("email", email)
		user.Set("name", name)
		user.Set("role", rec.GetString("role"))
		user.Set("permissions", rec.Get("permissions"))
		user.Set("disabled", false)
		user.SetPassword(password)

		if err := txApp.Save(user); err != nil {
			return err
		}

		// Mark invitation accepted
		rec.Set("accepted_at", types.NowDateTime())
		return txApp.Save(rec)
	})
	if txErr != nil {
		return nil, txErr
	}

	return user, nil
}

// ReissueInvitation generates a fresh token and extends expiration for an unaccepted invitation.
func ReissueInvitation(app core.App, caller *core.Record, id string) (string, *core.Record, error) {
	if !IsOwnerOrAdmin(caller) {
		return "", nil, ErrPermissionDenied
	}
	inv, err := app.FindRecordById("invitations", id)
	if err != nil || inv == nil || inv.GetBool("revoked") || inv.GetString("accepted_at") != "" {
		return "", nil, ErrInvalidInvitation
	}
	if inv.GetString("role") == RoleAdmin && !IsOwner(caller) {
		return "", nil, ErrAdminCannotEscalate
	}

	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", nil, err
	}
	newToken := hex.EncodeToString(bytes)

	inv.Set("token", newToken)
	inv.Set("expires_at", types.NowDateTime().AddDate(0, 0, 7))
	if err := app.Save(inv); err != nil {
		return "", nil, err
	}

	return newToken, inv, nil
}

// CheckActiveAccount returns an unauthorized error if the authenticated user account is disabled.
func CheckActiveAccount(auth *core.Record) error {
	if auth != nil && auth.GetBool("disabled") {
		return apis.NewUnauthorizedError("Your account has been disabled.", nil)
	}
	return nil
}

// RegisterDashboardRevisionHook registers an OnRecordUpdate hook that atomically advances
// the revision counter on every dashboard update, regardless of the caller (admin, owner,
// or PocketBase superuser).  Keeping this at the persistence boundary means no write
// path can bypass it.  The HTTP-layer OCC check in OnRecordUpdateRequest remains
// responsible for validating expected_revision before the write reaches this hook.
func RegisterDashboardRevisionHook(app core.App) {
	app.OnRecordUpdate("dashboards").BindFunc(func(e *core.RecordEvent) error {
		// Revision advancement: if the HTTP OCC hook already set a higher revision,
		// use that value.  Otherwise (superuser / internal path that bypassed the HTTP
		// hook), read the original value from the before-save snapshot and increment.
		orig := e.Record.Original()
		origRevision := 0
		if orig != nil {
			origRevision = orig.GetInt("revision")
		}
		if origRevision <= 0 {
			origRevision = 1
		}
		currentRevision := e.Record.GetInt("revision")
		if currentRevision <= origRevision {
			// Not yet incremented — superuser or internal write; advance now.
			e.Record.Set("revision", origRevision+1)
		}
		return e.Next()
	})
}

// RegisterAuthnHooks registers server-side hooks enforcing RBAC, active account checks, and assigned record scoping.
func RegisterAuthnHooks(app core.App) {
	// 1. Reject disabled accounts on password login
	app.OnRecordAuthWithPasswordRequest().BindFunc(func(e *core.RecordAuthWithPasswordRequestEvent) error {
		if e.Record != nil && e.Record.GetBool("disabled") {
			return apis.NewUnauthorizedError("Your account has been disabled.", nil)
		}
		return e.Next()
	})

	// 2. Reject disabled accounts on auth refresh
	app.OnRecordAuthRefreshRequest().BindFunc(func(e *core.RecordAuthRefreshRequestEvent) error {
		if e.Record != nil && e.Record.GetBool("disabled") {
			return apis.NewUnauthorizedError("Your account has been disabled.", nil)
		}
		return e.Next()
	})

	// 3. Reject disabled accounts on realtime SSE connections and invalidate active connections on disable
	app.OnRealtimeConnectRequest().BindFunc(func(e *core.RealtimeConnectRequestEvent) error {
		if e.Auth != nil && e.Auth.GetBool("disabled") {
			return apis.NewUnauthorizedError("Your account has been disabled.", nil)
		}
		return e.Next()
	})

	app.OnModelAfterUpdateSuccess("users").BindFunc(func(e *core.ModelEvent) error {
		rec, ok := e.Model.(*core.Record)
		if ok && rec.GetBool("disabled") && app.SubscriptionsBroker() != nil {
			for _, chunk := range app.SubscriptionsBroker().ChunkedClients(100) {
				for _, client := range chunk {
					if clientAuth, ok := client.Get(apis.RealtimeClientAuthKey).(*core.Record); ok && clientAuth != nil && clientAuth.Id == rec.Id {
						client.Unset(apis.RealtimeClientAuthKey)
					}
				}
			}
		}
		return e.Next()
	})

	checkActiveAccount := CheckActiveAccount

	// 4. Protect users collection mutations
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		// Superuser / internal bypass
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		// If unauthenticated: public registration is blocked
		if e.Auth == nil {
			return apis.NewForbiddenError("Public self-registration is disabled for this workspace.", nil)
		}
		// Only owner or admin can create users directly
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only owners and admins can create users.", nil)
		}
		// Only owners can create admin or owner accounts
		if IsAdmin(e.Auth) && !IsOwner(e.Auth) {
			if e.Record.GetString("role") == RoleOwner || e.Record.GetString("role") == RoleAdmin {
				return apis.NewForbiddenError("Only workspace owners can appoint admins or owners.", nil)
			}
		}
		return e.Next()
	})

	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		target := e.Record
		isSelf := e.Auth.Id == target.Id

		// Load original record. Fail closed if it cannot be loaded.
		origRecord, err := app.FindRecordById("users", target.Id)
		if err != nil || origRecord == nil {
			return apis.NewForbiddenError("Unable to verify user record permissions.", nil)
		}

		// Member updating self: cannot change role, disabled, or permissions
		if !IsOwnerOrAdmin(e.Auth) {
			if !isSelf {
				return apis.NewForbiddenError("You cannot modify other users.", nil)
			}
			if target.GetString("role") != origRecord.GetString("role") ||
				target.GetBool("disabled") != origRecord.GetBool("disabled") {
				return apis.NewForbiddenError("You cannot modify your own role or account status.", nil)
			}
			origPerms := GetUserPermissions(origRecord)
			targetPerms := GetUserPermissions(target)
			if !reflect.DeepEqual(origPerms, targetPerms) {
				return apis.NewForbiddenError("You cannot modify your own dataset permissions.", nil)
			}
			return e.Next()
		}

		// Admin updating users: cannot modify owners/admins and cannot promote anyone to owner or admin
		if IsAdmin(e.Auth) && !IsOwner(e.Auth) {
			if origRecord.GetString("role") == RoleOwner || origRecord.GetString("role") == RoleAdmin {
				return apis.NewForbiddenError("Admins cannot modify owner or admin accounts.", nil)
			}
			if target.GetString("role") == RoleOwner || target.GetString("role") == RoleAdmin {
				return apis.NewForbiddenError("Only workspace owners can appoint admins or owners.", nil)
			}
		}

		// Owner protection: cannot disable or demote the last active owner
		if origRecord.GetString("role") == RoleOwner {
			if target.GetString("role") != RoleOwner || target.GetBool("disabled") {
				isLast, err := IsLastOwner(app, target.Id)
				if err != nil {
					return apis.NewForbiddenError("Cannot demote or disable owner: active owners count could not be verified.", err)
				}
				if isLast {
					return apis.NewForbiddenError("Cannot demote or disable the last active workspace owner.", nil)
				}
			}
		}

		// Self-demoting guard: if an owner demotes themselves, ensure another owner exists
		if isSelf && origRecord.GetString("role") == RoleOwner && target.GetString("role") != RoleOwner {
			isLast, err := IsLastOwner(app, target.Id)
			if err != nil {
				return apis.NewForbiddenError("Cannot demote yourself: active owners count could not be verified.", err)
			}
			if isLast {
				return apis.NewForbiddenError("Cannot demote yourself: at least one active owner must remain.", nil)
			}
		}

		return e.Next()
	})

	app.OnRecordDeleteRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil || !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only owners and admins can delete users.", nil)
		}

		target := e.Record
		if target.GetString("role") == RoleOwner || target.GetString("role") == RoleAdmin {
			if IsAdmin(e.Auth) && !IsOwner(e.Auth) {
				return apis.NewForbiddenError("Admins cannot delete owner or admin accounts.", nil)
			}
			if target.GetString("role") == RoleOwner {
				isLast, err := IsLastOwner(app, target.Id)
				if err != nil {
					return apis.NewForbiddenError("Cannot delete owner: active owners count could not be verified.", err)
				}
				if isLast {
					return apis.NewForbiddenError("Cannot delete the last active workspace owner.", nil)
				}
			}
		}

		return e.Next()
	})

	// 5. Page and dashboard administration: owner and admin write only, active accounts only,
	// with strict contract and reference validation
	app.OnRecordCreateRequest("app_pages", "dashboards").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure pages and dashboards.", nil)
		}

		if e.Record.Collection().Name == "app_pages" {
			if err := validatePageRecord(app, e.Record); err != nil {
				return apis.NewBadRequestError("Invalid page definition: "+err.Error(), err)
			}
		} else if e.Record.Collection().Name == "dashboards" {
			dashboardSyncMu.Lock()
			defer dashboardSyncMu.Unlock()

			if err := validateDashboardRecord(app, e.Record); err != nil {
				return apis.NewBadRequestError("Invalid dashboard layout: "+err.Error(), err)
			}

			// Atomic first-create check: ensure a dashboard with this name does not already exist
			existing, err := app.FindFirstRecordByFilter("dashboards", "name = {:name}", map[string]any{
				"name": e.Record.GetString("name"),
			})
			if err == nil && existing != nil {
				return apis.NewApiError(
					http.StatusConflict,
					fmt.Sprintf("Dashboard %q already exists. Use update with expected_revision to modify it.", e.Record.GetString("name")),
					nil,
				)
			}

			if e.Record.GetInt("revision") <= 0 {
				e.Record.Set("revision", 1)
			}
			return e.Next()
		}

		return e.Next()
	})

	app.OnRecordUpdateRequest("app_pages", "dashboards").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure pages and dashboards.", nil)
		}

		if e.Record.Collection().Name == "app_pages" {
			if err := validatePageRecord(app, e.Record); err != nil {
				return apis.NewBadRequestError("Invalid page definition: "+err.Error(), err)
			}
		} else if e.Record.Collection().Name == "dashboards" {
			dashboardSyncMu.Lock()
			defer dashboardSyncMu.Unlock()

			if err := validateDashboardRecord(app, e.Record); err != nil {
				return apis.NewBadRequestError("Invalid dashboard layout: "+err.Error(), err)
			}

			// Atomic optimistic concurrency control for dashboards:
			// Fetch original record from SQLite within the serialized section.
			// NOTE: Revision advancement itself happens in RegisterDashboardRevisionHook
			// (OnRecordSave), which fires for all write paths including superuser.
			// This hook's responsibility is solely OCC validation for HTTP callers.
			origRecord, err := app.FindRecordById("dashboards", e.Record.Id)
			if err != nil || origRecord == nil {
				return apis.NewNotFoundError("Dashboard record not found.", err)
			}

			origRevision := origRecord.GetInt("revision")
			if origRevision <= 0 {
				origRevision = 1
			}

			expectedRev, found := extractExpectedRevision(e)
			if !found {
				return apis.NewBadRequestError("expected_revision is required for dashboard updates to prevent silent write loss.", nil)
			}

			if expectedRev != int64(origRevision) {
				return apis.NewApiError(
					http.StatusConflict,
					fmt.Sprintf("Dashboard layout conflict: current server revision is %d, but expected revision was %d.", origRevision, expectedRev),
					nil,
				)
			}
			// Revision advancement is delegated to RegisterDashboardRevisionHook.
			return e.Next()
		}

		return e.Next()
	})

	// 5b. app_pages read paths: Dataset-aware visibility for authenticated members.
	// Members only list/view published pages for datasets where they hold 'read' permission.
	app.OnRecordsListRequest("app_pages").BindFunc(func(e *core.RecordsListRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if IsOwnerOrAdmin(e.Auth) {
			return e.Next()
		}

		filtered := make([]*core.Record, 0, len(e.Records))
		filteredItems := make([]any, 0, len(e.Records))
		for _, rec := range e.Records {
			if !rec.GetBool("published") {
				continue
			}
			targetCol := rec.GetString("collection")
			if targetCol != "" && !CheckDatasetAction(e.Auth, targetCol, "read") {
				continue
			}
			filtered = append(filtered, rec)
			filteredItems = append(filteredItems, rec)
		}
		originalCount := len(e.Records)
		e.Records = filtered
		if e.Result != nil {
			e.Result.Items = filteredItems
			if len(filtered) < originalCount {
				e.Result.TotalItems -= (originalCount - len(filtered))
				if e.Result.TotalItems < 0 {
					e.Result.TotalItems = 0
				}
			}
		}
		return e.Next()
	})

	app.OnRecordViewRequest("app_pages").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if IsOwnerOrAdmin(e.Auth) {
			return e.Next()
		}

		if !e.Record.GetBool("published") {
			return apis.NewNotFoundError("Page not found.", nil)
		}
		targetCol := e.Record.GetString("collection")
		if targetCol != "" && !CheckDatasetAction(e.Auth, targetCol, "read") {
			return apis.NewNotFoundError("Page not found.", nil)
		}
		return e.Next()
	})

	app.OnRecordEnrich("app_pages").BindFunc(func(e *core.RecordEnrichEvent) error {
		if e.RequestInfo == nil || e.RequestInfo.Auth == nil {
			return e.Next()
		}
		if e.RequestInfo.HasSuperuserAuth() || IsOwnerOrAdmin(e.RequestInfo.Auth) {
			return e.Next()
		}
		if !e.Record.GetBool("published") {
			return apis.NewNotFoundError("Page not found.", nil)
		}
		targetCol := e.Record.GetString("collection")
		if targetCol != "" && !CheckDatasetAction(e.RequestInfo.Auth, targetCol, "read") {
			return apis.NewNotFoundError("Page not found.", nil)
		}
		return e.Next()
	})

	app.OnRecordDeleteRequest("app_pages", "dashboards").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure pages and dashboards.", nil)
		}
		return e.Next()
	})

	// 5c. workspace_modules protection: managed modules cannot be created, updated, or deleted directly via records API
	validateWorkspaceModuleMutation := func(rec *core.Record) error {
		if rec == nil {
			return nil
		}
		modID := rec.GetString("module_id")
		if modID == "" {
			return apis.NewBadRequestError("module_id is required", nil)
		}
		if IsManagedModule(modID) {
			return apis.NewBadRequestError(fmt.Sprintf("Managed module %q cannot be modified directly via the records API. Use /v1/workspace/modules.", modID), nil)
		}
		return nil
	}

	app.OnRecordCreateRequest("workspace_modules").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure modules.", nil)
		}
		if err := validateWorkspaceModuleMutation(e.Record); err != nil {
			return err
		}
		return e.Next()
	})

	app.OnRecordUpdateRequest("workspace_modules").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure modules.", nil)
		}

		// Look up existing record in database before update
		origRecord, err := app.FindRecordById("workspace_modules", e.Record.Id)
		if err != nil || origRecord == nil {
			return apis.NewNotFoundError("Module installation not found.", nil)
		}

		origModID := origRecord.GetString("module_id")
		newModID := e.Record.GetString("module_id")

		// 1. module_id is immutable on update to prevent renaming managed modules to bypass guards
		if newModID != "" && newModID != origModID {
			return apis.NewBadRequestError("module_id cannot be changed", nil)
		}

		// 2. Validate that neither original nor requested module_id targets a managed module
		if IsManagedModule(origModID) || IsManagedModule(newModID) {
			return apis.NewBadRequestError(fmt.Sprintf("Managed module %q cannot be modified directly via the records API. Use /v1/workspace/modules.", origModID), nil)
		}

		if err := validateWorkspaceModuleMutation(e.Record); err != nil {
			return err
		}
		return e.Next()
	})

	app.OnRecordDeleteRequest("workspace_modules").BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}
		if !IsOwnerOrAdmin(e.Auth) {
			return apis.NewForbiddenError("Only workspace owners and admins can configure modules.", nil)
		}

		origRecord, err := app.FindRecordById("workspace_modules", e.Record.Id)
		if err == nil && origRecord != nil {
			origModID := origRecord.GetString("module_id")
			if IsManagedModule(origModID) {
				return apis.NewBadRequestError(fmt.Sprintf("Managed module %q cannot be deleted directly via the records API. Use /v1/workspace/modules.", origModID), nil)
			}
		}

		if err := validateWorkspaceModuleMutation(e.Record); err != nil {
			return err
		}
		return e.Next()
	})

	// 5d. File download protection: enforce Lattice permissions and assigned scope on all file requests
	app.OnFileDownloadRequest().BindFunc(func(e *core.FileDownloadRequestEvent) error {
		col := e.Collection
		if col == nil && e.Record != nil {
			col = e.Record.Collection()
		}
		if col == nil || col.System || strings.HasPrefix(col.Name, "_") || tenant.PlatformCollections[col.Name] {
			return e.Next()
		}

		// Resolve the authenticating user (via ?token= file token, e.Auth, or Authorization header)
		var auth *core.Record
		if e.Request != nil && e.Request.URL != nil {
			token := e.Request.URL.Query().Get("token")
			if token != "" {
				auth, _ = e.App.FindAuthRecordByToken(token, core.TokenTypeFile)
			}
		}
		if auth == nil && e.Auth != nil {
			auth = e.Auth
		}
		if auth == nil && e.Request != nil && e.Request.Header != nil {
			if authHeader := e.Request.Header.Get("Authorization"); authHeader != "" {
				authHeader = strings.TrimPrefix(authHeader, "Bearer ")
				auth, _ = e.App.FindAuthRecordByToken(authHeader, core.TokenTypeFile)
				if auth == nil {
					auth, _ = e.App.FindAuthRecordByToken(authHeader, core.TokenTypeAuth)
				}
			}
		}

		// Unauthenticated access to business dataset files is strictly denied
		if auth == nil {
			return apis.NewNotFoundError("File not found.", nil)
		}

		if err := checkActiveAccount(auth); err != nil {
			return apis.NewNotFoundError("File not found.", nil)
		}

		if auth.IsSuperuser() || IsOwnerOrAdmin(auth) {
			return e.Next()
		}

		if auth.GetString("role") != RoleMember {
			return apis.NewNotFoundError("File not found.", nil)
		}

		// Member must hold read permission on the dataset
		if !CheckDatasetAction(auth, col.Name, "read") {
			return apis.NewNotFoundError("File not found.", nil)
		}

		// Enforce assigned scope if configured (strictly fails closed if metadata or assignment is unavailable)
		perms := GetUserPermissions(auth)
		p, hasP := perms[col.Name]
		if hasP && p.Scope == ScopeAssigned {
			if e.Record == nil {
				return apis.NewNotFoundError("File not found.", nil)
			}
			schemaDef, err := findSchemaDefinition(e.App, col.Name)
			if err != nil || schemaDef == nil || schemaDef.AssigneeField == "" {
				return apis.NewNotFoundError("File not found.", nil)
			}
			if e.Record.GetString(schemaDef.AssigneeField) != auth.Id {
				return apis.NewNotFoundError("File not found.", nil)
			}
		}

		return e.Next()
	})

	// 6. Direct mutation of schema_definitions is prohibited (use /v1/schemas API)
	app.OnRecordCreateRequest("schema_definitions").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation of schema_definitions is prohibited. Use /v1/schemas API.", nil)
	})

	app.OnRecordUpdateRequest("schema_definitions").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation of schema_definitions is prohibited. Use /v1/schemas API.", nil)
	})

	app.OnRecordDeleteRequest("schema_definitions").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation of schema_definitions is prohibited. Use /v1/schemas API.", nil)
	})

	// 7. Direct mutation of invitations and workspace_setup is prohibited
	app.OnRecordCreateRequest("invitations", "workspace_setup").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation is prohibited. Use workspace management APIs.", nil)
	})

	app.OnRecordUpdateRequest("invitations", "workspace_setup").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation is prohibited. Use workspace management APIs.", nil)
	})

	app.OnRecordDeleteRequest("invitations", "workspace_setup").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		return apis.NewForbiddenError("Direct mutation is prohibited. Use workspace management APIs.", nil)
	})

	// 8. Business collections: Enforce active account, dataset permissions & assigned record scoping
	app.OnRecordsListRequest().BindFunc(func(e *core.RecordsListRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() || e.Collection == nil || e.Collection.System || strings.HasPrefix(e.Collection.Name, "_") {
			return e.Next()
		}
		if tenant.PlatformCollections[e.Collection.Name] || e.Collection.Name == "users" {
			return e.Next()
		}

		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		// If member has no read permission, return empty list
		if !CheckDatasetAction(e.Auth, e.Collection.Name, "read") {
			e.Records = []*core.Record{}
			e.Result = &search.Result{
				Items:      []any{},
				Page:       1,
				PerPage:    20,
				TotalItems: 0,
				TotalPages: 1,
			}
			return e.Next()
		}

		// Assigned scope filtering in list hook (enforces assigned scoping on broad or unmigrated rules, fails closed)
		if !IsOwnerOrAdmin(e.Auth) {
			perms := GetUserPermissions(e.Auth)
			p, hasP := perms[e.Collection.Name]
			if hasP && p.Scope == ScopeAssigned {
				schemaDef, _ := findSchemaDefinition(app, e.Collection.Name)
				filteredRecords := make([]*core.Record, 0, len(e.Records))
				filteredItems := make([]any, 0, len(e.Records))
				if schemaDef != nil && schemaDef.AssigneeField != "" {
					for _, rec := range e.Records {
						if rec.GetString(schemaDef.AssigneeField) == e.Auth.Id {
							filteredRecords = append(filteredRecords, rec)
							filteredItems = append(filteredItems, rec)
						}
					}
				}
				e.Records = filteredRecords
				if e.Result != nil {
					e.Result.Items = filteredItems
					e.Result.TotalItems = len(filteredRecords)
				}
			}
		}

		return e.Next()
	})

	app.OnRecordViewRequest().BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() || e.Record == nil || e.Record.Collection().System || strings.HasPrefix(e.Record.Collection().Name, "_") {
			return e.Next()
		}
		colName := e.Record.Collection().Name
		if tenant.PlatformCollections[colName] || colName == "users" {
			return e.Next()
		}

		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		if !CheckDatasetAction(e.Auth, colName, "read") {
			return apis.NewNotFoundError("Record not found.", nil)
		}

		// Assigned scope check for view (strictly fails closed)
		if !IsOwnerOrAdmin(e.Auth) {
			perms := GetUserPermissions(e.Auth)
			p, hasP := perms[colName]
			if hasP && p.Scope == ScopeAssigned {
				schemaDef, err := findSchemaDefinition(app, colName)
				if err != nil || schemaDef == nil || schemaDef.AssigneeField == "" || e.Record.GetString(schemaDef.AssigneeField) != e.Auth.Id {
					return apis.NewNotFoundError("Record not found.", nil)
				}
			}
		}

		return e.Next()
	})

	app.OnRecordCreateRequest().BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() || e.Record == nil || e.Record.Collection().System || strings.HasPrefix(e.Record.Collection().Name, "_") {
			return e.Next()
		}
		colName := e.Record.Collection().Name
		if tenant.PlatformCollections[colName] || colName == "users" {
			return e.Next()
		}

		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		if !CheckDatasetAction(e.Auth, colName, "create") {
			return apis.NewForbiddenError("Create operation not permitted for this dataset.", nil)
		}

		// Auto-assign creating user ONLY when member has ScopeAssigned
		schemaDef, _ := findSchemaDefinition(app, colName)
		if schemaDef != nil && schemaDef.AssigneeField != "" {
			perms := GetUserPermissions(e.Auth)
			p, hasP := perms[colName]
			if hasP && p.Scope == ScopeAssigned {
				e.Record.Set(schemaDef.AssigneeField, e.Auth.Id)
			}
		}

		return e.Next()
	})

	app.OnRecordUpdateRequest().BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() || e.Record == nil || e.Record.Collection().System || strings.HasPrefix(e.Record.Collection().Name, "_") {
			return e.Next()
		}
		colName := e.Record.Collection().Name
		if tenant.PlatformCollections[colName] || colName == "users" {
			return e.Next()
		}

		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		if !CheckDatasetAction(e.Auth, colName, "update") {
			return apis.NewNotFoundError("Record not found.", nil)
		}

		// Check original record assignment before authorizing update
		if !IsOwnerOrAdmin(e.Auth) {
			origRecord, err := app.FindRecordById(colName, e.Record.Id)
			if err != nil || origRecord == nil {
				return apis.NewNotFoundError("Record not found.", nil)
			}

			perms := GetUserPermissions(e.Auth)
			p, hasP := perms[colName]
			if hasP && p.Scope == ScopeAssigned {
				schemaDef, err := findSchemaDefinition(app, colName)
				if err != nil || schemaDef == nil || schemaDef.AssigneeField == "" {
					return apis.NewNotFoundError("Record not found.", nil)
				}
				// 1. Original record MUST be assigned to the caller
				if origRecord.GetString(schemaDef.AssigneeField) != e.Auth.Id {
					return apis.NewNotFoundError("Record not found.", nil)
				}
				// 2. Member cannot reassign to someone else; preserve assignment if omitted or empty
				if e.Record.GetString(schemaDef.AssigneeField) == "" {
					e.Record.Set(schemaDef.AssigneeField, e.Auth.Id)
				} else if e.Record.GetString(schemaDef.AssigneeField) != e.Auth.Id {
					return apis.NewForbiddenError("You cannot change the assignment of this record.", nil)
				}
			}
		}

		return e.Next()
	})

	app.OnRecordDeleteRequest().BindFunc(func(e *core.RecordRequestEvent) error {
		if err := checkActiveAccount(e.Auth); err != nil {
			return err
		}
		if e.HasSuperuserAuth() || e.Record == nil || e.Record.Collection().System || strings.HasPrefix(e.Record.Collection().Name, "_") {
			return e.Next()
		}
		colName := e.Record.Collection().Name
		if tenant.PlatformCollections[colName] || colName == "users" {
			return e.Next()
		}

		if e.Auth == nil {
			return apis.NewUnauthorizedError("Authentication required.", nil)
		}

		if !CheckDatasetAction(e.Auth, colName, "delete") {
			return apis.NewNotFoundError("Record not found.", nil)
		}

		// Check original record assignment before authorizing delete
		if !IsOwnerOrAdmin(e.Auth) {
			origRecord, err := app.FindRecordById(colName, e.Record.Id)
			if err != nil || origRecord == nil {
				return apis.NewNotFoundError("Record not found.", nil)
			}

			perms := GetUserPermissions(e.Auth)
			p, hasP := perms[colName]
			if hasP && p.Scope == ScopeAssigned {
				schemaDef, err := findSchemaDefinition(app, colName)
				if err != nil || schemaDef == nil || schemaDef.AssigneeField == "" {
					return apis.NewNotFoundError("Record not found.", nil)
				}
				if origRecord.GetString(schemaDef.AssigneeField) != e.Auth.Id {
					return apis.NewNotFoundError("Record not found.", nil)
				}
			}
		}

		return e.Next()
	})
}

func findSchemaDefinition(app core.App, schemaID string) (*struct{ AssigneeField string }, error) {
	rec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": schemaID})
	if err == nil && rec != nil {
		return &struct{ AssigneeField string }{
			AssigneeField: rec.GetString("assignee_field"),
		}, nil
	}

	// Fallback for existing or legacy collections: inspect the collection's relation fields in PocketBase
	col, colErr := app.FindCollectionByNameOrId(schemaID)
	if colErr == nil && col != nil {
		usersCol, _ := app.FindCollectionByNameOrId("users")
		usersId := ""
		if usersCol != nil {
			usersId = usersCol.Id
		}
		for _, f := range col.Fields {
			if rf, ok := f.(*core.RelationField); ok {
				if rf.CollectionId == "users" || (usersId != "" && rf.CollectionId == usersId) || rf.Name == "assignee" {
					return &struct{ AssigneeField string }{
						AssigneeField: rf.Name,
					}, nil
				}
			}
		}
	}

	return nil, errors.New("not found")
}

func parseJSONValue(val any) (any, error) {
	if val == nil {
		return map[string]any{}, nil
	}
	switch v := val.(type) {
	case string:
		if strings.TrimSpace(v) == "" {
			return map[string]any{}, nil
		}
		var res any
		if err := json.Unmarshal([]byte(v), &res); err != nil {
			return nil, err
		}
		return res, nil
	case []byte:
		if len(v) == 0 {
			return map[string]any{}, nil
		}
		var res any
		if err := json.Unmarshal(v, &res); err != nil {
			return nil, err
		}
		return res, nil
	case types.JSONRaw:
		if len(v) == 0 {
			return map[string]any{}, nil
		}
		var res any
		if err := json.Unmarshal([]byte(v), &res); err != nil {
			return nil, err
		}
		return res, nil
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		var res any
		if err := json.Unmarshal(data, &res); err != nil {
			return nil, err
		}
		return res, nil
	}
}

func validatePageRecord(app core.App, rec *core.Record) error {
	parsedCfg, err := parseJSONValue(rec.Get("config"))
	if err != nil {
		return fmt.Errorf("invalid config JSON: %w", err)
	}

	doc := map[string]any{
		"page_id":    rec.GetString("page_id"),
		"name":       rec.GetString("name"),
		"view_type":  rec.GetString("view_type"),
		"collection": rec.GetString("collection"),
		"published":  rec.GetBool("published"),
		"nav_order":  rec.GetInt("nav_order"),
		"config":     parsedCfg,
	}
	if rec.Id != "" {
		doc["id"] = rec.Id
	}
	if desc := rec.GetString("description"); desc != "" {
		doc["description"] = desc
	}
	if icon := rec.GetString("icon"); icon != "" {
		doc["icon"] = icon
	}

	if err := tenant.ValidateContractDocument("PageDefinition", doc); err != nil {
		return fmt.Errorf("contract validation failed: %w", err)
	}

	targetColName := rec.GetString("collection")
	if tenant.PlatformCollections[targetColName] || strings.HasPrefix(targetColName, "_") {
		return fmt.Errorf("cannot target reserved system collection %q", targetColName)
	}
	targetCol, err := app.FindCollectionByNameOrId(targetColName)
	if err != nil || targetCol == nil {
		return fmt.Errorf("referenced collection %q does not exist", targetColName)
	}

	cfgMap, _ := parsedCfg.(map[string]any)
	viewType := rec.GetString("view_type")

	switch viewType {
	case "kanban":
		groupByField, _ := cfgMap["groupByField"].(string)
		if groupByField == "" {
			return errors.New("kanban view requires 'groupByField' in config")
		}
		if targetCol.Fields.GetByName(groupByField) == nil {
			return fmt.Errorf("groupByField %q does not exist in collection %q", groupByField, targetColName)
		}
		if cardFields, ok := cfgMap["cardFields"].([]any); ok {
			for _, cf := range cardFields {
				if cfStr, ok := cf.(string); ok && cfStr != "" {
					if targetCol.Fields.GetByName(cfStr) == nil {
						return fmt.Errorf("cardField %q does not exist in collection %q", cfStr, targetColName)
					}
				}
			}
		}
	case "table":
		if cols, ok := cfgMap["columns"].([]any); ok {
			for _, c := range cols {
				if cStr, ok := c.(string); ok && cStr != "" {
					if targetCol.Fields.GetByName(cStr) == nil {
						return fmt.Errorf("column %q does not exist in collection %q", cStr, targetColName)
					}
				}
			}
		}
	case "master_detail":
		detailColStr, _ := cfgMap["detailCollection"].(string)
		if detailColStr == "" {
			return errors.New("master_detail view requires 'detailCollection' in config")
		}
		if tenant.PlatformCollections[detailColStr] || strings.HasPrefix(detailColStr, "_") {
			return fmt.Errorf("detailCollection cannot target reserved system collection %q", detailColStr)
		}
		detailCol, err := app.FindCollectionByNameOrId(detailColStr)
		if err != nil || detailCol == nil {
			return fmt.Errorf("detailCollection %q does not exist", detailColStr)
		}

		relFieldStr, _ := cfgMap["relationField"].(string)
		if relFieldStr == "" {
			return errors.New("master_detail view requires 'relationField' in config")
		}
		field := detailCol.Fields.GetByName(relFieldStr)
		if field == nil {
			return fmt.Errorf("relationField %q does not exist in child collection %q", relFieldStr, detailColStr)
		}
		relField, ok := field.(*core.RelationField)
		if !ok {
			return fmt.Errorf("relationField %q in child collection %q must be a relation field", relFieldStr, detailColStr)
		}
		if relField.CollectionId != targetCol.Id && relField.CollectionId != targetCol.Name {
			return fmt.Errorf("relationField %q in child collection %q targets %q, expected parent collection %q", relFieldStr, detailColStr, relField.CollectionId, targetCol.Name)
		}
	}
	return nil
}

func validateDashboardRecord(app core.App, rec *core.Record) error {
	parsedLayout, err := parseJSONValue(rec.Get("layout"))
	if err != nil {
		return fmt.Errorf("invalid layout JSON: %w", err)
	}

	var fullDoc map[string]any
	if lMap, ok := parsedLayout.(map[string]any); ok {
		rawWidgets, hasLayout := lMap["layout"]
		if !hasLayout || rawWidgets == nil {
			return errors.New("dashboard layout object must contain a 'layout' array of widgets")
		}
		if _, isArr := rawWidgets.([]any); !isArr {
			return errors.New("'layout' property must be an array of widgets")
		}
		fullDoc = lMap
	} else if lArr, ok := parsedLayout.([]any); ok {
		idVal := rec.Id
		if idVal == "" {
			idVal = rec.GetString("name")
		}
		fullDoc = map[string]any{
			"id":     idVal,
			"name":   rec.GetString("name"),
			"layout": lArr,
		}
	} else {
		return errors.New("layout must be a JSON object or array of widgets")
	}

	if fullDoc["id"] == "" || fullDoc["id"] == nil {
		fullDoc["id"] = rec.GetString("name")
		if fullDoc["id"] == "" {
			fullDoc["id"] = "main"
		}
	}
	if fullDoc["name"] == "" || fullDoc["name"] == nil {
		fullDoc["name"] = rec.GetString("name")
		if fullDoc["name"] == "" {
			fullDoc["name"] = "main"
		}
	}

	if err := tenant.ValidateContractDocument("DashboardLayout", fullDoc); err != nil {
		return fmt.Errorf("contract validation failed: %w", err)
	}

	widgets, _ := fullDoc["layout"].([]any)
	for i, w := range widgets {
		wMap, ok := w.(map[string]any)
		if !ok {
			return fmt.Errorf("widget[%d] must be an object", i)
		}
		colName, _ := wMap["collection"].(string)
		if colName == "" {
			return fmt.Errorf("widget[%d] requires collection", i)
		}
		if tenant.PlatformCollections[colName] || strings.HasPrefix(colName, "_") {
			return fmt.Errorf("widget[%d] cannot target reserved collection %q", i, colName)
		}
		targetCol, err := app.FindCollectionByNameOrId(colName)
		if err != nil || targetCol == nil {
			return fmt.Errorf("widget[%d] references nonexistent collection %q", i, colName)
		}

		// Validate coordinates and dimensions
		var x, y, width, height float64
		if xv, ok := wMap["x"].(float64); ok { x = xv }
		if yv, ok := wMap["y"].(float64); ok { y = yv }
		if wv, ok := wMap["w"].(float64); ok { width = wv }
		if hv, ok := wMap["h"].(float64); ok { height = hv }
		if x < 0 || y < 0 || width < 1 || width > 12 || height < 1 {
			return fmt.Errorf("widget[%d] has invalid grid bounds (x=%v, y=%v, w=%v, h=%v)", i, x, y, width, height)
		}

		// Validate props
		if props, ok := wMap["props"].(map[string]any); ok {
			if fields, ok := props["fields"].([]any); ok {
				for _, f := range fields {
					if fStr, ok := f.(string); ok && fStr != "" {
						if targetCol.Fields.GetByName(fStr) == nil {
							return fmt.Errorf("widget[%d] references field %q not present in collection %q", i, fStr, colName)
						}
					}
				}
			}
			if groupBy, ok := props["groupBy"].(string); ok && groupBy != "" {
				baseField := strings.Split(groupBy, ":")[0]
				if targetCol.Fields.GetByName(baseField) == nil {
					return fmt.Errorf("widget[%d] groupBy field %q not present in collection %q", i, baseField, colName)
				}
			}
			if metric, ok := props["metric"].(string); ok && metric != "" && metric != "count" {
				parts := strings.Split(metric, ":")
				if len(parts) == 2 {
					if targetCol.Fields.GetByName(parts[1]) == nil {
						return fmt.Errorf("widget[%d] metric field %q not present in collection %q", i, parts[1], colName)
					}
				}
			}
		}
	}

	// Persist the normalized and validated document into the record so what is saved matches what was validated.
	normalizedBytes, err := json.Marshal(fullDoc)
	if err != nil {
		return fmt.Errorf("failed to serialize normalized dashboard layout: %w", err)
	}
	rec.Set("layout", string(normalizedBytes))
	return nil
}

func extractExpectedRevision(e *core.RecordRequestEvent) (int64, bool) {
	if e == nil {
		return 0, false
	}

	// 1. Check router.Event's custom store (used in tests or handlers)
	if v := e.Get("expected_revision"); v != nil {
		switch val := v.(type) {
		case int64:
			return val, true
		case int:
			return int64(val), true
		case float64:
			return int64(val), true
		case string:
			if n, err := strconv.ParseInt(strings.Trim(val, `"`), 10, 64); err == nil {
				return n, true
			}
		}
	}

	// 2. Safely inspect RequestInfo if an HTTP request is attached
	if e.RequestEvent != nil && e.RequestEvent.Request != nil {
		reqInfo, err := e.RequestInfo()
		if err == nil && reqInfo != nil {
			// Check Body
			if reqInfo.Body != nil {
				for _, key := range []string{"expected_revision", "expectedRevision"} {
					if v, ok := reqInfo.Body[key]; ok && v != nil {
						switch val := v.(type) {
						case float64:
							return int64(val), true
						case int:
							return int64(val), true
						case int64:
							return val, true
						case string:
							if n, err := strconv.ParseInt(strings.Trim(val, `"`), 10, 64); err == nil {
								return n, true
							}
						}
					}
				}
			}
			// Check Query
			if reqInfo.Query != nil {
				for _, key := range []string{"expected_revision", "expectedRevision"} {
					if s, ok := reqInfo.Query[key]; ok && s != "" {
						if n, err := strconv.ParseInt(strings.Trim(s, `"`), 10, 64); err == nil {
							return n, true
						}
					}
				}
			}
			// Check Headers
			if reqInfo.Headers != nil {
				if ifMatch := reqInfo.Headers["if-match"]; ifMatch != "" {
					trimmed := strings.Trim(strings.TrimSpace(ifMatch), `"`)
					if n, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
						return n, true
					}
				}
			}
		}
	}

	return 0, false
}
