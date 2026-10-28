package authz

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"reflect"
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
func IsLastOwner(app core.App, userID string) bool {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return false
	}
	owners, err := app.FindRecordsByFilter("users", "role = {:role} && disabled != true", "", 5, 0, map[string]any{
		"role": RoleOwner,
	})
	if err != nil || len(owners) == 0 {
		return false
	}
	if len(owners) == 1 && owners[0].Id == userID {
		return true
	}
	return false
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

	if err := app.Save(rec); err != nil {
		return nil, err
	}
	return rec, nil
}

// AcceptInvitation consumes a single-use invitation and creates the user account.
func AcceptInvitation(app core.App, token string, name string, password string) (*core.Record, error) {
	if token == "" || len(password) < 8 {
		return nil, errors.New("token and password (min 8 chars) are required")
	}

	invCol, err := app.FindCollectionByNameOrId("invitations")
	if err != nil || invCol == nil {
		return nil, errors.New("invitations collection not found")
	}

	rec, err := app.FindFirstRecordByFilter("invitations", "token = {:token} && revoked != true", map[string]any{
		"token": token,
	})
	if err != nil || rec == nil {
		return nil, ErrInvalidInvitation
	}

	if rec.GetString("accepted_at") != "" {
		return nil, ErrInvalidInvitation
	}

	expiresAt := rec.GetDateTime("expires_at").Time()
	if time.Now().After(expiresAt) {
		return nil, ErrInvalidInvitation
	}

	usersCol, err := app.FindCollectionByNameOrId("users")
	if err != nil || usersCol == nil {
		return nil, errors.New("users collection not found")
	}

	email := rec.GetString("email")
	existingUser, _ := app.FindFirstRecordByFilter("users", "email = {:email}", map[string]any{"email": email})
	if existingUser != nil {
		return nil, errors.New("a user with this email address already exists")
	}

	user := core.NewRecord(usersCol)
	user.Set("email", email)
	user.Set("name", name)
	user.Set("role", rec.GetString("role"))
	user.Set("permissions", rec.Get("permissions"))
	user.Set("disabled", false)
	user.SetPassword(password)

	if err := app.Save(user); err != nil {
		return nil, err
	}

	// Mark invitation accepted
	rec.Set("accepted_at", types.NowDateTime())
	_ = app.Save(rec)

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

	checkActiveAccount := func(auth *core.Record) error {
		if auth != nil && auth.GetBool("disabled") {
			return apis.NewUnauthorizedError("Your account has been disabled.", nil)
		}
		return nil
	}

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
				if IsLastOwner(app, target.Id) {
					return apis.NewForbiddenError("Cannot demote or disable the last active workspace owner.", nil)
				}
			}
		}

		// Self-demoting guard: if an owner demotes themselves, ensure another owner exists
		if isSelf && origRecord.GetString("role") == RoleOwner && target.GetString("role") != RoleOwner {
			if IsLastOwner(app, target.Id) {
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
			if target.GetString("role") == RoleOwner && IsLastOwner(app, target.Id) {
				return apis.NewForbiddenError("Cannot delete the last active workspace owner.", nil)
			}
		}

		return e.Next()
	})

	// 5. Business collections: Enforce active account, dataset permissions & assigned record scoping
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

		// Assigned scope filtering in list hook (enforces assigned scoping on broad or unmigrated rules)
		if !IsOwnerOrAdmin(e.Auth) {
			schemaDef, _ := findSchemaDefinition(app, e.Collection.Name)
			if schemaDef != nil && schemaDef.AssigneeField != "" {
				perms := GetUserPermissions(e.Auth)
				p, hasP := perms[e.Collection.Name]
				if hasP && p.Scope == ScopeAssigned {
					filteredRecords := make([]*core.Record, 0, len(e.Records))
					filteredItems := make([]any, 0, len(e.Records))
					for _, rec := range e.Records {
						if rec.GetString(schemaDef.AssigneeField) == e.Auth.Id {
							filteredRecords = append(filteredRecords, rec)
							filteredItems = append(filteredItems, rec)
						}
					}
					e.Records = filteredRecords
					if e.Result != nil {
						e.Result.Items = filteredItems
						e.Result.TotalItems = len(filteredRecords)
					}
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

		// Assigned scope check for view
		if !IsOwnerOrAdmin(e.Auth) {
			schemaDef, _ := findSchemaDefinition(app, colName)
			if schemaDef != nil && schemaDef.AssigneeField != "" {
				perms := GetUserPermissions(e.Auth)
				p, hasP := perms[colName]
				if hasP && p.Scope == ScopeAssigned {
					if e.Record.GetString(schemaDef.AssigneeField) != e.Auth.Id {
						return apis.NewNotFoundError("Record not found.", nil)
					}
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

			schemaDef, _ := findSchemaDefinition(app, colName)
			if schemaDef != nil && schemaDef.AssigneeField != "" {
				perms := GetUserPermissions(e.Auth)
				p, hasP := perms[colName]
				if hasP && p.Scope == ScopeAssigned {
					// 1. Original record MUST be assigned to the caller
					if origRecord.GetString(schemaDef.AssigneeField) != e.Auth.Id {
						return apis.NewNotFoundError("Record not found.", nil)
					}
					// 2. Member cannot reassign to someone else
					if e.Record.GetString(schemaDef.AssigneeField) != e.Auth.Id {
						return apis.NewForbiddenError("You cannot change the assignment of this record.", nil)
					}
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

			schemaDef, _ := findSchemaDefinition(app, colName)
			if schemaDef != nil && schemaDef.AssigneeField != "" {
				perms := GetUserPermissions(e.Auth)
				p, hasP := perms[colName]
				if hasP && p.Scope == ScopeAssigned {
					if origRecord.GetString(schemaDef.AssigneeField) != e.Auth.Id {
						return apis.NewNotFoundError("Record not found.", nil)
					}
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
