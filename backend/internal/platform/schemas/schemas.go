package schemas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

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
	SchemaID    string            `json:"schema_id"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Icon        string            `json:"icon,omitempty"`
	Fields      []FieldDefinition `json:"fields"`
	Created     string            `json:"created,omitempty"`
	Updated     string            `json:"updated,omitempty"`
}

type Service struct {
	app core.App
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
			def.Created = rec.GetDateTime("created").String()
			def.Updated = rec.GetDateTime("updated").String()

			rawFields := rec.Get("fields")
			if rawFields != nil {
				data, mErr := json.Marshal(rawFields)
				if mErr == nil {
					_ = json.Unmarshal(data, &def.Fields)
				}
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
		def.Created = rec.GetDateTime("created").String()
		def.Updated = rec.GetDateTime("updated").String()

		rawFields := rec.Get("fields")
		if rawFields != nil {
			data, mErr := json.Marshal(rawFields)
			if mErr == nil {
				_ = json.Unmarshal(data, &def.Fields)
			}
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

	existing, _ := s.app.FindCollectionByNameOrId(def.SchemaID)
	if existing != nil {
		return nil, ErrSchemaAlreadyExists
	}

	// 1. Save rich metadata in schema_definitions first
	schemaDefsCol, err := s.app.FindCollectionByNameOrId("schema_definitions")
	var schemaRec *core.Record
	if err == nil && schemaDefsCol != nil {
		schemaRec = core.NewRecord(schemaDefsCol)
		schemaRec.Set("schema_id", def.SchemaID)
		name := def.Name
		if name == "" {
			name = def.SchemaID
		}
		schemaRec.Set("name", name)
		schemaRec.Set("description", def.Description)
		schemaRec.Set("icon", def.Icon)
		schemaRec.Set("fields", def.Fields)
		if err := s.app.Save(schemaRec); err != nil {
			return nil, fmt.Errorf("failed to save schema definition record: %w", err)
		}
		def.Created = schemaRec.GetDateTime("created").String()
		def.Updated = schemaRec.GetDateTime("updated").String()
	}

	// 2. Build and save PocketBase Collection
	col := core.NewBaseCollection(def.SchemaID)
	authRule := "@request.auth.id != ''"
	col.ListRule = types.Pointer(authRule)
	col.ViewRule = types.Pointer(authRule)
	col.CreateRule = types.Pointer(authRule)
	col.UpdateRule = types.Pointer(authRule)
	col.DeleteRule = types.Pointer(authRule)

	for _, f := range def.Fields {
		if !fieldNamePattern.MatchString(f.Name) {
			if schemaRec != nil {
				_ = s.app.Delete(schemaRec)
			}
			return nil, fmt.Errorf("%w: %s", ErrInvalidFieldName, f.Name)
		}
		// id, created, updated are automatically added by PocketBase
		if f.Name == "id" || f.Name == "created" || f.Name == "updated" {
			continue
		}

		field, err := createPocketBaseField(s.app, f)
		if err != nil {
			if schemaRec != nil {
				_ = s.app.Delete(schemaRec)
			}
			return nil, err
		}
		col.Fields.Add(field)
	}

	if err := s.app.Save(col); err != nil {
		if schemaRec != nil {
			_ = s.app.Delete(schemaRec)
		}
		return nil, fmt.Errorf("failed to save collection: %w", err)
	}

	// Update collection_id on schema_definitions record
	if schemaRec != nil {
		schemaRec.Set("collection_id", col.Id)
		_ = s.app.Save(schemaRec)
	}

	if def.Name == "" {
		def.Name = def.SchemaID
	}
	if def.Created == "" {
		def.Created = time.Now().UTC().Format(time.RFC3339)
		def.Updated = def.Created
	}

	return &def, nil
}

// DeleteSchema drops the PocketBase collection and removes its entry from schema_definitions.
func (s *Service) DeleteSchema(ctx context.Context, schemaID string) error {
	if IsReserved(schemaID) {
		return ErrReservedSchemaID
	}

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

		schemaDefsCol, err := app.FindCollectionByNameOrId("schema_definitions")
		if err != nil || schemaDefsCol == nil {
			return e.Next()
		}

		existing, _ := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": e.Collection.Name})
		if existing == nil {
			def := CollectionToSchemaDefinition(e.Collection)
			rec := core.NewRecord(schemaDefsCol)
			rec.Set("schema_id", def.SchemaID)
			rec.Set("name", def.Name)
			rec.Set("description", def.Description)
			rec.Set("icon", def.Icon)
			rec.Set("fields", def.Fields)
			rec.Set("collection_id", e.Collection.Id)
			_ = app.Save(rec)
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

		rec, _ := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": e.Collection.Name})
		if rec != nil {
			_ = app.Delete(rec)
		}
		return e.Next()
	})
}

// CollectionToSchemaDefinition converts a PocketBase Collection model into a clean SchemaDefinition.
func CollectionToSchemaDefinition(col *core.Collection) SchemaDefinition {
	def := SchemaDefinition{
		SchemaID: col.Name,
		Name:     col.Name,
		Created:  col.Created.String(),
		Updated:  col.Updated.String(),
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
