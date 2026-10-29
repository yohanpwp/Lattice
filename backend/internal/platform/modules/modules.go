package modules

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

const (
	ModuleIDCustomerJobTracking = "customer_job_tracking"
	ModuleVersion               = "1.0.0"
)

type ModulePermission struct {
	Read   bool   `json:"read"`
	Create bool   `json:"create"`
	Update bool   `json:"update"`
	Delete bool   `json:"delete"`
	Scope  string `json:"scope"`
}

type RequiredFieldSpec struct {
	FieldRole         string   `json:"field_role"`
	Name              string   `json:"name"`
	Label             string   `json:"label"`
	Type              string   `json:"type"`
	Required          bool     `json:"required"`
	TargetDatasetRole string   `json:"target_dataset_role,omitempty"`
	Options           []string `json:"options,omitempty"`
}

type RequiredDatasetSpec struct {
	DatasetRole       string              `json:"dataset_role"`
	Name              string              `json:"name"`
	Description       string              `json:"description,omitempty"`
	AssigneeFieldRole string              `json:"assignee_field_role,omitempty"`
	RequiredFields    []RequiredFieldSpec `json:"required_fields"`
}

type ModuleContract struct {
	ModuleID           string                      `json:"module_id"`
	Name               string                      `json:"name"`
	Version            string                      `json:"version"`
	Description        string                      `json:"description"`
	Icon               string                      `json:"icon"`
	SupportedPlatforms []string                    `json:"supported_platforms"`
	RequiredDatasets   []RequiredDatasetSpec       `json:"required_datasets"`
	Screens            []string                    `json:"screens"`
	Actions            []string                    `json:"actions"`
	Permissions        map[string]ModulePermission `json:"permissions"`
	Disabling          string                      `json:"disabling"`
}

type ModuleMapping struct {
	CustomerDataset    string `json:"customer_dataset"`
	CustomerNameField  string `json:"customer_name_field"`
	CustomerPhoneField string `json:"customer_phone_field,omitempty"`
	JobDataset         string `json:"job_dataset"`
	JobTitleField      string `json:"job_title_field"`
	JobCustomerField   string `json:"job_customer_field"`
	JobStatusField     string `json:"job_status_field"`
	JobAssigneeField   string `json:"job_assignee_field"`
}

type WorkspaceModuleInstallation struct {
	ID          string        `json:"id,omitempty"`
	ModuleID    string        `json:"module_id"`
	Version     string        `json:"version"`
	Enabled     bool          `json:"enabled"`
	Mapping     ModuleMapping `json:"mapping"`
	InstalledAt string        `json:"installed_at,omitempty"`
	UpdatedAt   string        `json:"updated_at,omitempty"`
}

type ModuleSetupRequest struct {
	UseSuggested bool           `json:"use_suggested"`
	Mapping      *ModuleMapping `json:"mapping,omitempty"`
}

var CustomerJobTrackingContract = ModuleContract{
	ModuleID:           ModuleIDCustomerJobTracking,
	Name:               "Customer & Job Tracking",
	Version:            ModuleVersion,
	Description:        "Track customer contacts and manage assigned jobs with status updates.",
	Icon:               "clipboard-check",
	SupportedPlatforms: []string{"web", "mobile"},
	RequiredDatasets: []RequiredDatasetSpec{
		{
			DatasetRole: "customers",
			Name:        "Customers",
			Description: "Customer contact directory for job tracking",
			RequiredFields: []RequiredFieldSpec{
				{
					FieldRole: "name",
					Name:      "name",
					Label:     "Customer Name",
					Type:      "text",
					Required:  true,
				},
				{
					FieldRole: "phone",
					Name:      "phone",
					Label:     "Phone Number",
					Type:      "text",
					Required:  false,
				},
			},
		},
		{
			DatasetRole:       "jobs",
			Name:              "Jobs",
			Description:       "Customer jobs and work order tracking",
			AssigneeFieldRole: "assignee",
			RequiredFields: []RequiredFieldSpec{
				{
					FieldRole: "title",
					Name:      "title",
					Label:     "Job Title",
					Type:      "text",
					Required:  true,
				},
				{
					FieldRole:         "customer",
					Name:              "customer",
					Label:             "Customer",
					Type:              "relation",
					Required:          true,
					TargetDatasetRole: "customers",
				},
				{
					FieldRole: "status",
					Name:      "status",
					Label:     "Status",
					Type:      "select",
					Required:  true,
					Options:   []string{"Open", "In progress", "Done"},
				},
				{
					FieldRole:         "assignee",
					Name:              "assignee",
					Label:             "Assignee",
					Type:              "relation",
					Required:          true,
					TargetDatasetRole: "users",
				},
			},
		},
	},
	Screens: []string{"job_list", "job_detail", "customer_list", "customer_detail"},
	Actions: []string{"create_job", "assign_job", "update_job_status"},
	Permissions: map[string]ModulePermission{
		"customers": {Read: true, Scope: "all"},
		"jobs":      {Read: true, Create: true, Update: true, Delete: false, Scope: "assigned"},
	},
	Disabling: "Disabling hides dedicated module screens and navigation while retaining all existing records and datasets.",
}

var Catalog = map[string]ModuleContract{
	ModuleIDCustomerJobTracking: CustomerJobTrackingContract,
}

func GetCatalogModule(moduleID string) (*ModuleContract, bool) {
	c, ok := Catalog[moduleID]
	if !ok {
		return nil, false
	}
	return &c, true
}

func ListCatalogModules() []ModuleContract {
	return []ModuleContract{CustomerJobTrackingContract}
}

// ValidateModuleMapping verifies that the mapped collections and fields exist,
// conform to the expected types, and satisfy relation target constraints.
func ValidateModuleMapping(app core.App, mapping ModuleMapping) error {
	if strings.TrimSpace(mapping.CustomerDataset) == "" {
		return errors.New("customer_dataset is required")
	}
	if tenant.PlatformCollections[mapping.CustomerDataset] || strings.HasPrefix(mapping.CustomerDataset, "_") || mapping.CustomerDataset == "users" {
		return fmt.Errorf("customer_dataset %q is a reserved system collection", mapping.CustomerDataset)
	}
	custCol, err := app.FindCollectionByNameOrId(mapping.CustomerDataset)
	if err != nil || custCol == nil {
		return fmt.Errorf("customer_dataset %q does not exist", mapping.CustomerDataset)
	}

	if strings.TrimSpace(mapping.CustomerNameField) == "" {
		return errors.New("customer_name_field is required")
	}
	nameField := custCol.Fields.GetByName(mapping.CustomerNameField)
	if nameField == nil {
		return fmt.Errorf("customer_name_field %q does not exist on collection %q", mapping.CustomerNameField, mapping.CustomerDataset)
	}

	if mapping.CustomerPhoneField != "" {
		phoneField := custCol.Fields.GetByName(mapping.CustomerPhoneField)
		if phoneField == nil {
			return fmt.Errorf("customer_phone_field %q does not exist on collection %q", mapping.CustomerPhoneField, mapping.CustomerDataset)
		}
	}

	if strings.TrimSpace(mapping.JobDataset) == "" {
		return errors.New("job_dataset is required")
	}
	if tenant.PlatformCollections[mapping.JobDataset] || strings.HasPrefix(mapping.JobDataset, "_") || mapping.JobDataset == "users" {
		return fmt.Errorf("job_dataset %q is a reserved system collection", mapping.JobDataset)
	}
	if mapping.JobDataset == mapping.CustomerDataset {
		return errors.New("job_dataset and customer_dataset must be different collections")
	}
	jobCol, err := app.FindCollectionByNameOrId(mapping.JobDataset)
	if err != nil || jobCol == nil {
		return fmt.Errorf("job_dataset %q does not exist", mapping.JobDataset)
	}

	if strings.TrimSpace(mapping.JobTitleField) == "" {
		return errors.New("job_title_field is required")
	}
	titleField := jobCol.Fields.GetByName(mapping.JobTitleField)
	if titleField == nil {
		return fmt.Errorf("job_title_field %q does not exist on collection %q", mapping.JobTitleField, mapping.JobDataset)
	}

	if strings.TrimSpace(mapping.JobCustomerField) == "" {
		return errors.New("job_customer_field is required")
	}
	custRelField := jobCol.Fields.GetByName(mapping.JobCustomerField)
	if custRelField == nil {
		return fmt.Errorf("job_customer_field %q does not exist on collection %q", mapping.JobCustomerField, mapping.JobDataset)
	}
	rel, ok := custRelField.(*core.RelationField)
	if !ok {
		return fmt.Errorf("job_customer_field %q must be a relation field", mapping.JobCustomerField)
	}
	if rel.CollectionId != custCol.Id && rel.CollectionId != custCol.Name {
		return fmt.Errorf("job_customer_field %q must target customer collection %q", mapping.JobCustomerField, mapping.CustomerDataset)
	}

	if strings.TrimSpace(mapping.JobStatusField) == "" {
		return errors.New("job_status_field is required")
	}
	statusField := jobCol.Fields.GetByName(mapping.JobStatusField)
	if statusField == nil {
		return fmt.Errorf("job_status_field %q does not exist on collection %q", mapping.JobStatusField, mapping.JobDataset)
	}

	if strings.TrimSpace(mapping.JobAssigneeField) == "" {
		return errors.New("job_assignee_field is required")
	}
	assigneeField := jobCol.Fields.GetByName(mapping.JobAssigneeField)
	if assigneeField == nil {
		return fmt.Errorf("job_assignee_field %q does not exist on collection %q", mapping.JobAssigneeField, mapping.JobDataset)
	}
	assigneeRel, ok := assigneeField.(*core.RelationField)
	if !ok {
		return fmt.Errorf("job_assignee_field %q must be a relation field", mapping.JobAssigneeField)
	}
	usersCol, _ := app.FindCollectionByNameOrId("users")
	if usersCol == nil || (assigneeRel.CollectionId != usersCol.Id && assigneeRel.CollectionId != "users") {
		return fmt.Errorf("job_assignee_field %q must target 'users' collection", mapping.JobAssigneeField)
	}

	return nil
}

// ProvisionSuggestedDatasets provisions the suggested "customers" and "jobs" collections
// and catalog metadata if they do not already exist. It is safe to call repeatedly.
func ProvisionSuggestedDatasets(ctx context.Context, app core.App) (ModuleMapping, error) {
	schemasSvc := schemas.NewService(app)

	// 1. Ensure "customers" dataset exists
	custCol, _ := app.FindCollectionByNameOrId("customers")
	if custCol == nil {
		custDef := schemas.SchemaDefinition{
			SchemaID:    "customers",
			Name:        "Customers",
			Description: "Customer contact directory for job tracking",
			Icon:        "users",
			Fields: []schemas.FieldDefinition{
				{
					Name:     "name",
					Label:    "Name",
					Type:     "text",
					Required: true,
				},
				{
					Name:     "phone",
					Label:    "Phone",
					Type:     "text",
					Required: false,
				},
			},
		}
		_, err := schemasSvc.CreateSchema(ctx, custDef)
		if err != nil && !errors.Is(err, schemas.ErrSchemaAlreadyExists) {
			return ModuleMapping{}, fmt.Errorf("failed to provision customers dataset: %w", err)
		}
	}

	// 2. Ensure "jobs" dataset exists
	jobCol, _ := app.FindCollectionByNameOrId("jobs")
	if jobCol == nil {
		jobDef := schemas.SchemaDefinition{
			SchemaID:      "jobs",
			Name:          "Jobs",
			Description:   "Customer jobs and work order tracking",
			Icon:          "briefcase",
			AssigneeField: "assignee",
			Fields: []schemas.FieldDefinition{
				{
					Name:     "title",
					Label:    "Title",
					Type:     "text",
					Required: true,
				},
				{
					Name:     "customer",
					Label:    "Customer",
					Type:     "relation",
					Required: true,
					Target:   "customers",
				},
				{
					Name:     "status",
					Label:    "Status",
					Type:     "select",
					Required: true,
					Options:  []string{"Open", "In progress", "Done"},
				},
				{
					Name:     "assignee",
					Label:    "Assignee",
					Type:     "relation",
					Required: true,
					Target:   "users",
				},
			},
		}
		_, err := schemasSvc.CreateSchema(ctx, jobDef)
		if err != nil && !errors.Is(err, schemas.ErrSchemaAlreadyExists) {
			return ModuleMapping{}, fmt.Errorf("failed to provision jobs dataset: %w", err)
		}
	}

	defaultMapping := ModuleMapping{
		CustomerDataset:    "customers",
		CustomerNameField:  "name",
		CustomerPhoneField: "phone",
		JobDataset:         "jobs",
		JobTitleField:      "title",
		JobCustomerField:   "customer",
		JobStatusField:     "status",
		JobAssigneeField:   "assignee",
	}

	return defaultMapping, nil
}

// EnsureJobDatasetAssigneeProtection ensures that the dataset's schema definition
// and row-level collection rules protect assigned-scope members.
func EnsureJobDatasetAssigneeProtection(ctx context.Context, app core.App, jobDataset string, assigneeField string) error {
	schemasSvc := schemas.NewService(app)
	def, err := schemasSvc.GetSchema(ctx, jobDataset)
	if err != nil {
		return nil
	}
	if def.AssigneeField != assigneeField {
		_, err := schemasSvc.UpdateSchema(ctx, jobDataset, map[string]any{
			"assignee_field": assigneeField,
		})
		if err != nil {
			return fmt.Errorf("failed to update assignee_field on job dataset %q: %w", jobDataset, err)
		}
	}
	return nil
}

func GetInstalledModule(app core.App, moduleID string) (*WorkspaceModuleInstallation, error) {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return nil, nil
	}
	rec, err := app.FindFirstRecordByFilter("workspace_modules", "module_id = {:id}", map[string]any{"id": moduleID})
	if err != nil || rec == nil {
		return nil, nil
	}
	return recordToInstallation(rec)
}

func ListInstalledModules(app core.App) ([]WorkspaceModuleInstallation, error) {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return []WorkspaceModuleInstallation{}, nil
	}
	recs, err := app.FindRecordsByFilter("workspace_modules", "", "module_id", 100, 0)
	if err != nil {
		return []WorkspaceModuleInstallation{}, err
	}
	var list []WorkspaceModuleInstallation
	for _, rec := range recs {
		inst, err := recordToInstallation(rec)
		if err == nil && inst != nil {
			list = append(list, *inst)
		}
	}
	return list, nil
}

func SaveModuleInstallation(app core.App, inst *WorkspaceModuleInstallation) (*WorkspaceModuleInstallation, error) {
	col, err := app.FindCollectionByNameOrId("workspace_modules")
	if err != nil || col == nil {
		return nil, errors.New("workspace_modules collection not found")
	}

	rec, _ := app.FindFirstRecordByFilter("workspace_modules", "module_id = {:id}", map[string]any{"id": inst.ModuleID})
	if rec == nil {
		rec = core.NewRecord(col)
		rec.Set("module_id", inst.ModuleID)
	}

	rec.Set("version", inst.Version)
	rec.Set("enabled", inst.Enabled)
	rec.Set("mapping", inst.Mapping)

	if err := app.Save(rec); err != nil {
		return nil, err
	}

	return recordToInstallation(rec)
}

func recordToInstallation(rec *core.Record) (*WorkspaceModuleInstallation, error) {
	var mapping ModuleMapping
	raw := rec.Get("mapping")
	if raw != nil {
		data, err := json.Marshal(raw)
		if err == nil {
			_ = json.Unmarshal(data, &mapping)
		}
	}
	return &WorkspaceModuleInstallation{
		ID:          rec.Id,
		ModuleID:    rec.GetString("module_id"),
		Version:     rec.GetString("version"),
		Enabled:     rec.GetBool("enabled"),
		Mapping:     mapping,
		InstalledAt: rec.GetDateTime("created").String(),
		UpdatedAt:   rec.GetDateTime("updated").String(),
	}, nil
}
