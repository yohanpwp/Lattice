package schemas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/Lattice/backend/internal/platform/authz"
	"github.com/Lattice/backend/internal/platform/tenant"
)

var (
	schemaIDPattern  = regexp.MustCompile(`^[a-z][a-z0-9_]{1,40}$`)
	fieldNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,40}$`)

	ErrSchemaNotFound     = errors.New("schema not found")
	ErrSchemaAlreadyExists = errors.New("schema already exists")
	ErrReservedSchemaID   = errors.New("cannot create or modify reserved system/platform schema")
	ErrInvalidSchemaID    = errors.New("invalid schema_id: must match ^[a-z][a-z0-9_]{1,40}$")
	ErrInvalidFieldName   = errors.New("invalid field name: must match ^[a-z][a-z0-9_]{0,40}$")
)

type FieldDefinition struct {
	Name     string   `json:"name"`
	Label    string   `json:"label,omitempty"`
	Type     string   `json:"type"` // text, number, bool, email, url, date, select, relation, json, file
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
	Target   string   `json:"target,omitempty"`
	System   bool     `json:"system,omitempty"`
}

type SchemaDefinition struct {
	SchemaID      string            `json:"schema_id"`
	Name          string            `json:"name"`
	Description   string            `json:"description,omitempty"`
	Icon          string            `json:"icon,omitempty"`
	AssigneeField string            `json:"assignee_field,omitempty"`
	Fields        []FieldDefinition `json:"fields"`
	CanCreate     bool              `json:"can_create"`
	CanUpdate     bool              `json:"can_update"`
	CanDelete     bool              `json:"can_delete"`
	Created       string            `json:"created,omitempty"`
	Updated       string            `json:"updated,omitempty"`
}

type Service struct {
	app core.App
	mu  sync.Mutex
}

func NewService(app core.App) *Service {
	return &Service{app: app}
}

func IsReserved(schemaID string) bool {
	if strings.HasPrefix(schemaID, "_") {
		return true
	}
	if schemaID == "users" {
		return true
	}
	return tenant.PlatformCollections[schemaID]
}

// ListSchemas returns all business schemas stored in schema_definitions,
// falling back to inspecting active PocketBase collections for unrecorded ones.
func (s *Service) ListSchemas(ctx context.Context) ([]SchemaDefinition, error) {
	if s.app == nil || !s.app.IsBootstrapped() || s.app.DB() == nil {
		return []SchemaDefinition{}, nil
	}

	records, err := s.app.FindRecordsByFilter("schema_definitions", "", "@rowid", 500, 0)
	recordedMap := make(map[string]bool)
	var result []SchemaDefinition

	if err == nil {
		for _, rec := range records {
			var def SchemaDefinition
			def.SchemaID = rec.GetString("schema_id")
			def.Name = rec.GetString("name")
			def.Description = rec.GetString("description")
			def.Icon = rec.GetString("icon")
			def.AssigneeField = rec.GetString("assignee_field")
			def.Created = rec.GetDateTime("created").String()
			def.Updated = rec.GetDateTime("updated").String()

			rawFields := rec.Get("fields")
			if rawFields != nil {
				data, mErr := json.Marshal(rawFields)
				if mErr == nil {
					_ = json.Unmarshal(data, &def.Fields)
				}
			}

			if col, _ := s.app.FindCollectionByNameOrId(def.SchemaID); col != nil {
				def.CanCreate = col.CreateRule != nil
				def.CanUpdate = col.UpdateRule != nil
				def.CanDelete = col.DeleteRule != nil
			}

			recordedMap[def.SchemaID] = true
			result = append(result, def)
		}
	}

	// Discover any business collections not yet recorded in schema_definitions (e.g. users)
	allCols, err := s.app.FindAllCollections()
	if err == nil {
		for _, col := range allCols {
			if col == nil || col.System || strings.HasPrefix(col.Name, "_") {
				continue
			}
			if tenant.PlatformCollections[col.Name] {
				continue
			}
			if !recordedMap[col.Name] {
				def := CollectionToSchemaDefinition(col)
				result = append(result, def)
				recordedMap[col.Name] = true
			}
		}
	}

	if result == nil {
		return []SchemaDefinition{}, nil
	}
	return result, nil
}

// GetSchema returns the SchemaDefinition for the given schemaID.
func (s *Service) GetSchema(ctx context.Context, schemaID string) (*SchemaDefinition, error) {
	if s.app == nil || !s.app.IsBootstrapped() || s.app.DB() == nil {
		return nil, ErrSchemaNotFound
	}

	// 1. Try finding in schema_definitions table
	rec, err := s.app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": schemaID})
	if err == nil && rec != nil {
		var def SchemaDefinition
		def.SchemaID = rec.GetString("schema_id")
		def.Name = rec.GetString("name")
		def.Description = rec.GetString("description")
		def.Icon = rec.GetString("icon")
		def.AssigneeField = rec.GetString("assignee_field")
		def.Created = rec.GetDateTime("created").String()
		def.Updated = rec.GetDateTime("updated").String()

		rawFields := rec.Get("fields")
		if rawFields != nil {
			data, mErr := json.Marshal(rawFields)
			if mErr == nil {
				_ = json.Unmarshal(data, &def.Fields)
			}
		}

		if col, _ := s.app.FindCollectionByNameOrId(def.SchemaID); col != nil {
			def.CanCreate = col.CreateRule != nil
			def.CanUpdate = col.UpdateRule != nil
			def.CanDelete = col.DeleteRule != nil
		}

		return &def, nil
	}

	// 2. Fall back to finding matching collection in PocketBase
	col, colErr := s.app.FindCollectionByNameOrId(schemaID)
	if colErr == nil && col != nil {
		if col.System || strings.HasPrefix(col.Name, "_") || tenant.PlatformCollections[col.Name] {
			return nil, ErrSchemaNotFound
		}
		def := CollectionToSchemaDefinition(col)
		return &def, nil
	}

	return nil, ErrSchemaNotFound
}

// CreateSchema creates a new PocketBase collection and persists its rich metadata
// in the schema_definitions catalog table.
func (s *Service) CreateSchema(ctx context.Context, def SchemaDefinition) (*SchemaDefinition, error) {
	if !schemaIDPattern.MatchString(def.SchemaID) {
		return nil, ErrInvalidSchemaID
	}
	if IsReserved(def.SchemaID) {
		return nil, ErrReservedSchemaID
	}
	if len(def.Fields) == 0 {
		return nil, errors.New("schema must contain at least one field")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if def.AssigneeField != "" {
		var targetField *FieldDefinition
		for i := range def.Fields {
			if def.Fields[i].Name == def.AssigneeField {
				targetField = &def.Fields[i]
				break
			}
		}
		if targetField == nil {
			return nil, fmt.Errorf("assignee_field %q does not match any defined field", def.AssigneeField)
		}
		if targetField.Type != "relation" {
			return nil, fmt.Errorf("assignee_field %q must be a relation field (got %s)", def.AssigneeField, targetField.Type)
		}
		usersCol, _ := s.app.FindCollectionByNameOrId("users")
		validTarget := targetField.Target == "users" || (usersCol != nil && targetField.Target == usersCol.Id)
		if !validTarget {
			return nil, fmt.Errorf("assignee_field %q must be a relation targeting 'users' collection", def.AssigneeField)
		}
	}

	existing, _ := s.app.FindCollectionByNameOrId(def.SchemaID)
	if existing != nil {
		return nil, ErrSchemaAlreadyExists
	}
	existingRec, _ := s.app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": def.SchemaID})
	if existingRec != nil {
		return nil, ErrSchemaAlreadyExists
	}

	// Validate all fields upfront and pre-build PocketBase field objects before DB operations
	seenFields := make(map[string]bool)
	var pbFields []core.Field
	for _, f := range def.Fields {
		if !fieldNamePattern.MatchString(f.Name) {
			return nil, fmt.Errorf("%w: %s", ErrInvalidFieldName, f.Name)
		}
		if seenFields[f.Name] {
			return nil, fmt.Errorf("duplicate field name %q", f.Name)
		}
		seenFields[f.Name] = true

		if f.Name == "id" || f.Name == "created" || f.Name == "updated" {
			continue
		}

		field, err := createPocketBaseField(s.app, f)
		if err != nil {
			return nil, err
		}
		pbFields = append(pbFields, field)
	}

	schemaDefsCol, err := s.app.FindCollectionByNameOrId("schema_definitions")
	if err != nil || schemaDefsCol == nil {
		return nil, errors.New("schema_definitions catalog collection not found")
	}

	var schemaRec *core.Record
	var col *core.Collection

	txErr := s.app.RunInTransaction(func(txApp core.App) error {
		// 1. Save rich metadata in schema_definitions first
		schemaRec = core.NewRecord(schemaDefsCol)
		schemaRec.Set("schema_id", def.SchemaID)
		name := def.Name
		if name == "" {
			name = def.SchemaID
		}
		schemaRec.Set("name", name)
		schemaRec.Set("description", def.Description)
		schemaRec.Set("icon", def.Icon)
		schemaRec.Set("assignee_field", def.AssigneeField)
		schemaRec.Set("fields", def.Fields)
		if err := txApp.Save(schemaRec); err != nil {
			return fmt.Errorf("failed to save schema definition record: %w", err)
		}

		// 2. Build and save PocketBase Collection
		col = core.NewBaseCollection(def.SchemaID)
		col.ListRule, col.ViewRule, col.CreateRule, col.UpdateRule, col.DeleteRule = BuildCollectionRules(def.SchemaID, def.AssigneeField)

		// Explicitly add autodate fields so created and updated timestamps exist
		col.Fields.Add(
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)

		for _, field := range pbFields {
			col.Fields.Add(field)
		}

		if err := txApp.Save(col); err != nil {
			return fmt.Errorf("failed to save collection: %w", err)
		}

		// 3. Update collection_id on schema_definitions record
		schemaRec.Set("collection_id", col.Id)
		if err := txApp.Save(schemaRec); err != nil {
			return fmt.Errorf("failed to save collection_id to schema definition: %w", err)
		}

		return nil
	})

	if txErr != nil {
		if strings.Contains(txErr.Error(), "UNIQUE constraint failed") ||
			strings.Contains(txErr.Error(), "already exists") {
			return nil, ErrSchemaAlreadyExists
		}
		return nil, txErr
	}

	def.Created = schemaRec.GetDateTime("created").String()
	def.Updated = schemaRec.GetDateTime("updated").String()
	if def.Name == "" {
		def.Name = def.SchemaID
	}
	if def.Created == "" {
		def.Created = time.Now().UTC().Format(time.RFC3339)
		def.Updated = def.Created
	}
	def.CanCreate = true
	def.CanUpdate = true
	def.CanDelete = true

	return &def, nil
}

// SchemaUpdateInput represents partial updates to a schema definition.
// Pointers indicate whether a field was explicitly supplied (non-nil) or omitted (nil).
type SchemaUpdateInput struct {
	Name          *string            `json:"name,omitempty"`
	Description   *string            `json:"description,omitempty"`
	Icon          *string            `json:"icon,omitempty"`
	AssigneeField *string            `json:"assignee_field,omitempty"`
	Fields        *[]FieldDefinition `json:"fields,omitempty"`
}

// HasAssignedScopeMembers checks if any workspace members (active or disabled) or pending invitations have assigned-scope permissions on this dataset.
func (s *Service) HasAssignedScopeMembers(schemaID string) (bool, error) {
	if s.app == nil || !s.app.IsBootstrapped() || s.app.DB() == nil {
		return false, nil
	}
	return s.hasAssignedScopeMembersWithApp(s.app, schemaID)
}

func (s *Service) hasAssignedScopeMembersWithApp(app core.App, schemaID string) (bool, error) {
	if app == nil {
		return false, nil
	}

	// 1. Check all users (including disabled accounts) across all pages
	pageSize := 200
	offset := 0
	for {
		userRecs, err := app.FindRecordsByFilter("users", "", "", pageSize, offset)
		if err != nil {
			return false, err
		}
		for _, u := range userRecs {
			perms := authz.GetUserPermissions(u)
			if p, ok := perms[schemaID]; ok && p.Scope == authz.ScopeAssigned {
				return true, nil
			}
		}
		if len(userRecs) < pageSize {
			break
		}
		offset += pageSize
	}

	// 2. Check all pending invitations (unrevoked, unaccepted) across all pages
	offset = 0
	for {
		invRecs, err := app.FindRecordsByFilter("invitations", "revoked != true && accepted_at = ''", "", pageSize, offset)
		if err != nil {
			// invitations collection might not exist in uninitialized test apps
			break
		}
		for _, inv := range invRecs {
			raw := inv.Get("permissions")
			if raw == nil {
				continue
			}
			data, err := json.Marshal(raw)
			if err != nil {
				continue
			}
			var pMap map[string]struct {
				Scope string `json:"scope"`
			}
			if err := json.Unmarshal(data, &pMap); err != nil {
				continue
			}
			if p, ok := pMap[schemaID]; ok && p.Scope == authz.ScopeAssigned {
				return true, nil
			}
		}
		if len(invRecs) < pageSize {
			break
		}
		offset += pageSize
	}

	return false, nil
}

func (s *Service) countEmptyRecordsWithApp(app core.App, schemaID string, fieldName string) (int, error) {
	if app == nil {
		return 0, nil
	}
	filter := fmt.Sprintf("%s = '' || %s = null", fieldName, fieldName)
	records, err := app.FindRecordsByFilter(schemaID, filter, "", 1, 0)
	if err != nil {
		return 0, err
	}
	return len(records), nil
}

// UpdateSchema safely modifies an existing schema definition and collection.
// Supported safe operations include updating name, description, icon, assignee_field,
// and adding new optional fields or updating existing field options/required status.
// Destructive changes (deleting fields or changing existing field types/targets)
// and unverified removal of assignee fields protecting assigned-scope members are rejected.
func (s *Service) UpdateSchema(ctx context.Context, schemaID string, input any) (*SchemaDefinition, error) {
	if s.app == nil || !s.app.IsBootstrapped() || s.app.DB() == nil {
		return nil, errors.New("app service not ready")
	}

	if IsReserved(schemaID) {
		return nil, ErrReservedSchemaID
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var update SchemaUpdateInput
	switch v := input.(type) {
	case SchemaUpdateInput:
		update = v
	case *SchemaUpdateInput:
		if v != nil {
			update = *v
		}
	case SchemaDefinition:
		update = SchemaUpdateInput{
			Name:          &v.Name,
			Description:   &v.Description,
			Icon:          &v.Icon,
			AssigneeField: &v.AssigneeField,
			Fields:        &v.Fields,
		}
	case *SchemaDefinition:
		if v != nil {
			update = SchemaUpdateInput{
				Name:          &v.Name,
				Description:   &v.Description,
				Icon:          &v.Icon,
				AssigneeField: &v.AssigneeField,
				Fields:        &v.Fields,
			}
		}
	case []byte:
		if err := json.Unmarshal(v, &update); err != nil {
			return nil, fmt.Errorf("invalid json update payload: %w", err)
		}
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return nil, fmt.Errorf("invalid update input: %w", err)
		}
		if err := json.Unmarshal(data, &update); err != nil {
			return nil, fmt.Errorf("invalid update input: %w", err)
		}
	}

	txErr := s.app.RunInTransaction(func(txApp core.App) error {
		col, err := txApp.FindCollectionByNameOrId(schemaID)
		if err != nil || col == nil {
			return ErrSchemaNotFound
		}

		schemaRec, err := txApp.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": schemaID})
		if err != nil || schemaRec == nil {
			return ErrSchemaNotFound
		}

		// 1. Parse existing fields from metadata record loaded inside transaction
		var existingFields []FieldDefinition
		rawFields := schemaRec.Get("fields")
		if rawFields != nil {
			data, mErr := json.Marshal(rawFields)
			if mErr == nil {
				_ = json.Unmarshal(data, &existingFields)
			}
		}
		existingMap := make(map[string]FieldDefinition)
		for _, f := range existingFields {
			existingMap[f.Name] = f
		}

		// 2. Validate and prepare fields if provided in update
		var finalFields []FieldDefinition
		var newPBFields []core.Field
		type existingFieldUpdate struct {
			name     string
			required bool
			options  []string
		}
		var existingFieldUpdates []existingFieldUpdate

		if update.Fields != nil {
			updateMap := make(map[string]FieldDefinition)
			for _, f := range *update.Fields {
				if !fieldNamePattern.MatchString(f.Name) {
					return fmt.Errorf("%w: %s", ErrInvalidFieldName, f.Name)
				}
				if _, seen := updateMap[f.Name]; seen {
					return fmt.Errorf("duplicate field name %q in update", f.Name)
				}
				updateMap[f.Name] = f
			}

			// Check that no existing user-defined fields were deleted or had type/target changed
			for _, oldF := range existingFields {
				if oldF.Name == "id" || oldF.Name == "created" || oldF.Name == "updated" || oldF.System {
					continue
				}
				newF, exists := updateMap[oldF.Name]
				if !exists {
					return fmt.Errorf("destructive operation rejected: field %q cannot be deleted from schema", oldF.Name)
				}
				if newF.Type != oldF.Type {
					return fmt.Errorf("destructive operation rejected: changing field %q type from %q to %q is not permitted", oldF.Name, oldF.Type, newF.Type)
				}
				if oldF.Type == "relation" {
					// If target is omitted in the update, preserve oldF.Target
					if newF.Target == "" {
						newF.Target = oldF.Target
						updateMap[oldF.Name] = newF
					} else if newF.Target != oldF.Target {
						return fmt.Errorf("destructive operation rejected: changing relation target of field %q from %q to %q is not permitted", oldF.Name, oldF.Target, newF.Target)
					}
				}
				if oldF.Type == "select" {
					// Preserve existing options if omitted in update
					if len(newF.Options) == 0 {
						newF.Options = oldF.Options
						updateMap[oldF.Name] = newF
					}
				}
				if !oldF.Required && newF.Required {
					emptyCount, err := s.countEmptyRecordsWithApp(txApp, schemaID, oldF.Name)
					if err != nil {
						return fmt.Errorf("failed to verify field records: %w", err)
					}
					if emptyCount > 0 {
						return fmt.Errorf("cannot make field %q required: existing records have empty values", oldF.Name)
					}
				}

				// Track property updates to synchronize underlying PocketBase field
				existingFieldUpdates = append(existingFieldUpdates, existingFieldUpdate{
					name:     oldF.Name,
					required: newF.Required,
					options:  newF.Options,
				})
			}

			// Check any newly added fields: they must be optional to preserve existing records
			for _, f := range *update.Fields {
				if f.Name == "id" || f.Name == "created" || f.Name == "updated" || f.System {
					continue
				}
				if _, exists := existingMap[f.Name]; !exists {
					if f.Required {
						return fmt.Errorf("new field %q must be optional to preserve existing dataset records", f.Name)
					}
					pbField, err := createPocketBaseField(txApp, f)
					if err != nil {
						return fmt.Errorf("invalid new field %q: %w", f.Name, err)
					}
					newPBFields = append(newPBFields, pbField)
				}
			}

			// Build finalFields ensuring preserved relation targets and select options are stored
			finalFields = make([]FieldDefinition, 0, len(*update.Fields))
			for _, f := range *update.Fields {
				if oldF, exists := existingMap[f.Name]; exists {
					if oldF.Type == "relation" && f.Target == "" {
						f.Target = oldF.Target
					}
					if oldF.Type == "select" && len(f.Options) == 0 {
						f.Options = oldF.Options
					}
				}
				finalFields = append(finalFields, f)
			}
		} else {
			finalFields = existingFields
		}

		// 3. Validate AssigneeField handling (preserve omitted, protect assigned scope on removal)
		currentAssignee := schemaRec.GetString("assignee_field")
		finalAssignee := currentAssignee

		if update.AssigneeField != nil {
			requestedAssignee := *update.AssigneeField
			if requestedAssignee != currentAssignee {
				if requestedAssignee == "" {
					// Check if any active/disabled members or pending invitations have assigned scope
					hasAssigned, err := s.hasAssignedScopeMembersWithApp(txApp, schemaID)
					if err != nil {
						return fmt.Errorf("failed to check assigned permissions: %w", err)
					}
					if hasAssigned {
						return fmt.Errorf("cannot remove assignee_field: workspace members or invitations have 'assigned' scoping on dataset %q", schemaID)
					}
					finalAssignee = ""
				} else {
					var targetField *FieldDefinition
					for i := range finalFields {
						if finalFields[i].Name == requestedAssignee {
							targetField = &finalFields[i]
							break
						}
					}
					if targetField == nil {
						return fmt.Errorf("assignee_field %q does not match any defined field", requestedAssignee)
					}
					if targetField.Type != "relation" {
						return fmt.Errorf("assignee_field %q must be a relation field (got %s)", requestedAssignee, targetField.Type)
					}
					usersCol, _ := txApp.FindCollectionByNameOrId("users")
					validTarget := targetField.Target == "users" || (usersCol != nil && targetField.Target == usersCol.Id)
					if !validTarget {
						return fmt.Errorf("assignee_field %q must be a relation targeting 'users' collection", requestedAssignee)
					}
					finalAssignee = requestedAssignee
				}
			}
		}

		// 4. Synchronize properties of existing PocketBase fields
		for _, efu := range existingFieldUpdates {
			pbField := col.Fields.GetByName(efu.name)
			if pbField != nil {
				switch concrete := pbField.(type) {
				case *core.TextField:
					concrete.Required = efu.required
				case *core.NumberField:
					concrete.Required = efu.required
				case *core.BoolField:
					concrete.Required = efu.required
				case *core.DateField:
					concrete.Required = efu.required
				case *core.EmailField:
					concrete.Required = efu.required
				case *core.URLField:
					concrete.Required = efu.required
				case *core.JSONField:
					concrete.Required = efu.required
				case *core.SelectField:
					concrete.Required = efu.required
					if len(efu.options) > 0 {
						concrete.Values = efu.options
					}
				case *core.RelationField:
					concrete.Required = efu.required
				}
			}
		}

		// Add new fields to collection
		for _, pf := range newPBFields {
			col.Fields.Add(pf)
		}

		// Update rules if assignee field changed
		if finalAssignee != currentAssignee {
			col.ListRule, col.ViewRule, col.CreateRule, col.UpdateRule, col.DeleteRule = BuildCollectionRules(schemaID, finalAssignee)
		}

		if err := txApp.Save(col); err != nil {
			return fmt.Errorf("failed to save collection updates: %w", err)
		}

		if update.Name != nil && *update.Name != "" {
			schemaRec.Set("name", *update.Name)
		}
		if update.Description != nil {
			schemaRec.Set("description", *update.Description)
		}
		if update.Icon != nil && *update.Icon != "" {
			schemaRec.Set("icon", *update.Icon)
		}
		schemaRec.Set("assignee_field", finalAssignee)
		schemaRec.Set("fields", finalFields)

		if err := txApp.Save(schemaRec); err != nil {
			return fmt.Errorf("failed to save schema definition record updates: %w", err)
		}

		return nil
	})

	if txErr != nil {
		return nil, txErr
	}

	return s.GetSchema(ctx, schemaID)
}

// DeleteSchema drops the PocketBase collection and removes its entry from schema_definitions.
func (s *Service) DeleteSchema(ctx context.Context, schemaID string) error {
	if IsReserved(schemaID) {
		return ErrReservedSchemaID
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	col, err := s.app.FindCollectionByNameOrId(schemaID)
	if err != nil || col == nil {
		return ErrSchemaNotFound
	}

	if err := s.app.Delete(col); err != nil {
		return fmt.Errorf("failed to delete collection: %w", err)
	}

	rec, _ := s.app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": schemaID})
	if rec != nil {
		_ = s.app.Delete(rec)
	}

	return nil
}

// RegisterSyncHooks binds PocketBase collection lifecycle hooks to keep schema_definitions
// automatically updated when collections are added, modified, or deleted externally.
func RegisterSyncHooks(app core.App) {
	app.OnCollectionCreate().BindFunc(func(e *core.CollectionEvent) error {
		if e.Collection == nil || e.Collection.System || strings.HasPrefix(e.Collection.Name, "_") {
			return e.Next()
		}
		if tenant.PlatformCollections[e.Collection.Name] {
			return e.Next()
		}

		schemaDefsCol, err := e.App.FindCollectionByNameOrId("schema_definitions")
		if err != nil || schemaDefsCol == nil {
			return e.Next()
		}

		existing, _ := e.App.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": e.Collection.Name})
		if existing == nil {
			def := CollectionToSchemaDefinition(e.Collection)
			rec := core.NewRecord(schemaDefsCol)
			rec.Set("schema_id", def.SchemaID)
			rec.Set("name", def.Name)
			rec.Set("description", def.Description)
			rec.Set("icon", def.Icon)
			rec.Set("fields", def.Fields)
			rec.Set("collection_id", e.Collection.Id)
			_ = e.App.Save(rec)
		}
		return e.Next()
	})

	app.OnCollectionDelete().BindFunc(func(e *core.CollectionEvent) error {
		if e.Collection == nil || e.Collection.System || strings.HasPrefix(e.Collection.Name, "_") {
			return e.Next()
		}
		if tenant.PlatformCollections[e.Collection.Name] {
			return e.Next()
		}

		rec, _ := e.App.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": e.Collection.Name})
		if rec != nil {
			_ = e.App.Delete(rec)
		}
		return e.Next()
	})
}

// BuildCollectionRules generates the permission-aware and scope-aware PocketBase collection rules.
func BuildCollectionRules(schemaID string, assigneeField string) (*string, *string, *string, *string, *string) {
	if assigneeField != "" {
		readRule := fmt.Sprintf(
			"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.read = true && (@request.auth.permissions.%s.scope = 'all' || %s = @request.auth.id)))",
			schemaID, schemaID, assigneeField,
		)
		cRule := fmt.Sprintf(
			"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.create = true))",
			schemaID,
		)
		uRule := fmt.Sprintf(
			"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.update = true && (@request.auth.permissions.%s.scope = 'all' || %s = @request.auth.id)))",
			schemaID, schemaID, assigneeField,
		)
		dRule := fmt.Sprintf(
			"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.delete = true && (@request.auth.permissions.%s.scope = 'all' || %s = @request.auth.id)))",
			schemaID, schemaID, assigneeField,
		)
		return types.Pointer(readRule), types.Pointer(readRule), types.Pointer(cRule), types.Pointer(uRule), types.Pointer(dRule)
	}

	readRule := fmt.Sprintf(
		"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.read = true))",
		schemaID,
	)
	cRule := fmt.Sprintf(
		"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.create = true))",
		schemaID,
	)
	uRule := fmt.Sprintf(
		"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.update = true))",
		schemaID,
	)
	dRule := fmt.Sprintf(
		"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.delete = true))",
		schemaID,
	)
	return types.Pointer(readRule), types.Pointer(readRule), types.Pointer(cRule), types.Pointer(uRule), types.Pointer(dRule)
}

// CollectionToSchemaDefinition converts a PocketBase Collection model into a clean SchemaDefinition.
func CollectionToSchemaDefinition(col *core.Collection) SchemaDefinition {
	def := SchemaDefinition{
		SchemaID:  col.Name,
		Name:      col.Name,
		CanCreate: col.CreateRule != nil,
		CanUpdate: col.UpdateRule != nil,
		CanDelete: col.DeleteRule != nil,
		Created:   col.Created.String(),
		Updated:   col.Updated.String(),
	}

	for _, f := range col.Fields {
		fDef := FieldDefinition{
			Name:   f.GetName(),
			Type:   f.Type(),
			System: f.GetSystem(),
		}

		switch concrete := f.(type) {
		case *core.TextField:
			fDef.Required = concrete.Required
		case *core.NumberField:
			fDef.Required = concrete.Required
		case *core.SelectField:
			fDef.Required = concrete.Required
			fDef.Options = concrete.Values
		case *core.BoolField:
			fDef.Required = concrete.Required
		case *core.DateField:
			fDef.Required = concrete.Required
		case *core.JSONField:
			fDef.Required = concrete.Required
		case *core.FileField:
			fDef.Required = concrete.Required
		case *core.RelationField:
			fDef.Required = concrete.Required
			fDef.Target = concrete.CollectionId
		}

		def.Fields = append(def.Fields, fDef)
	}

	return def
}

func createPocketBaseField(app core.App, f FieldDefinition) (core.Field, error) {
	switch f.Type {
	case "text":
		return &core.TextField{Name: f.Name, Required: f.Required}, nil
	case "number":
		return &core.NumberField{Name: f.Name, Required: f.Required}, nil
	case "bool":
		return &core.BoolField{Name: f.Name, Required: f.Required}, nil
	case "email":
		return &core.EmailField{Name: f.Name, Required: f.Required}, nil
	case "url":
		return &core.URLField{Name: f.Name, Required: f.Required}, nil
	case "date":
		return &core.DateField{Name: f.Name, Required: f.Required}, nil
	case "select":
		return &core.SelectField{Name: f.Name, Required: f.Required, Values: f.Options, MaxSelect: 1}, nil
	case "json":
		return &core.JSONField{Name: f.Name, Required: f.Required}, nil
	case "file":
		return &core.FileField{Name: f.Name, Required: f.Required}, nil
	case "relation":
		rf := &core.RelationField{Name: f.Name, Required: f.Required, MaxSelect: 1}
		if f.Target != "" {
			targetCol, err := app.FindCollectionByNameOrId(f.Target)
			if err == nil && targetCol != nil {
				rf.CollectionId = targetCol.Id
			}
		}
		return rf, nil
	default:
		return &core.TextField{Name: f.Name, Required: f.Required}, nil
	}
}
