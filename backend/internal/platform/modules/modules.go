package modules

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/ganigeorgiev/fexpr"
	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

const (
	ModuleIDCustomerJobTracking = "customer_job_tracking"
	ModuleVersion               = "1.0.0"
	SupportedModuleMajorVersion = 1
)

var (
	ErrIncompatibleModuleVersion = errors.New("incompatible module version")
)

// IsSupportedModuleVersion checks whether a module version is compatible with the runtime.
// The supported version policy requires a valid semver string with major version 1.
func IsSupportedModuleVersion(version string) bool {
	var major, minor, patch int
	n, err := fmt.Sscanf(version, "%d.%d.%d", &major, &minor, &patch)
	if err != nil || n != 3 {
		return false
	}
	return major == SupportedModuleMajorVersion
}

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
	list := make([]ModuleContract, 0, len(Catalog))
	for _, m := range Catalog {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].ModuleID < list[j].ModuleID
	})
	return list
}

// ValidateModuleContract validates a ModuleContract against the shared JSON schema
// and verifies that the module version complies with the supported version policy.
func ValidateModuleContract(contract ModuleContract) error {
	data, err := json.Marshal(contract)
	if err != nil {
		return fmt.Errorf("failed to marshal module contract: %w", err)
	}
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("failed to unmarshal module contract: %w", err)
	}
	if err := tenant.ValidateContractDocument("ModuleContract", doc); err != nil {
		return err
	}
	if !IsSupportedModuleVersion(contract.Version) {
		return fmt.Errorf("%w: version %q is not supported (supported major version: %d)", ErrIncompatibleModuleVersion, contract.Version, SupportedModuleMajorVersion)
	}
	return nil
}

// RegisterCatalogModule validates and registers a module contract in the runtime catalog.
func RegisterCatalogModule(contract ModuleContract) error {
	if err := ValidateModuleContract(contract); err != nil {
		return fmt.Errorf("cannot register module contract %q: %w", contract.ModuleID, err)
	}
	Catalog[contract.ModuleID] = contract
	return nil
}

func init() {
	if err := ValidateModuleContract(CustomerJobTrackingContract); err != nil {
		panic(fmt.Sprintf("invalid built-in customer_job_tracking module contract: %v", err))
	}
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
	if _, ok := nameField.(*core.TextField); !ok {
		return fmt.Errorf("customer_name_field %q must be a text field on collection %q", mapping.CustomerNameField, mapping.CustomerDataset)
	}

	if mapping.CustomerPhoneField != "" {
		phoneField := custCol.Fields.GetByName(mapping.CustomerPhoneField)
		if phoneField == nil {
			return fmt.Errorf("customer_phone_field %q does not exist on collection %q", mapping.CustomerPhoneField, mapping.CustomerDataset)
		}
		if _, ok := phoneField.(*core.TextField); !ok {
			return fmt.Errorf("customer_phone_field %q must be a text field on collection %q", mapping.CustomerPhoneField, mapping.CustomerDataset)
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
	if _, ok := titleField.(*core.TextField); !ok {
		return fmt.Errorf("job_title_field %q must be a text field on collection %q", mapping.JobTitleField, mapping.JobDataset)
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
	if rel.MaxSelect != 1 {
		return fmt.Errorf("job_customer_field %q must be a single-value relation field (MaxSelect: 1)", mapping.JobCustomerField)
	}

	if strings.TrimSpace(mapping.JobStatusField) == "" {
		return errors.New("job_status_field is required")
	}
	statusField := jobCol.Fields.GetByName(mapping.JobStatusField)
	if statusField == nil {
		return fmt.Errorf("job_status_field %q does not exist on collection %q", mapping.JobStatusField, mapping.JobDataset)
	}
	statusSelect, ok := statusField.(*core.SelectField)
	if !ok {
		return fmt.Errorf("job_status_field %q must be a select field on collection %q", mapping.JobStatusField, mapping.JobDataset)
	}
	if statusSelect.MaxSelect != 1 {
		return fmt.Errorf("job_status_field %q must be a single-value select field (MaxSelect: 1) on collection %q", mapping.JobStatusField, mapping.JobDataset)
	}
	requiredStatuses := []string{"Open", "In progress", "Done"}
	valSet := make(map[string]bool)
	for _, v := range statusSelect.Values {
		valSet[v] = true
	}
	for _, reqVal := range requiredStatuses {
		if !valSet[reqVal] {
			return fmt.Errorf("job_status_field %q on collection %q is missing required status value %q (required values: %v)", mapping.JobStatusField, mapping.JobDataset, reqVal, requiredStatuses)
		}
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
	if assigneeRel.MaxSelect != 1 {
		return fmt.Errorf("job_assignee_field %q must be a single-value relation field (MaxSelect: 1)", mapping.JobAssigneeField)
	}

	// Verify that customer collection has no unmapped required fields that the create form cannot fill
	allowedCustFields := map[string]bool{
		"id":                      true,
		"created":                 true,
		"updated":                 true,
		mapping.CustomerNameField: true,
	}
	if mapping.CustomerPhoneField != "" {
		allowedCustFields[mapping.CustomerPhoneField] = true
	}
	for _, f := range custCol.Fields {
		if f.GetSystem() || allowedCustFields[f.GetName()] {
			continue
		}
		if isFieldRequired(f) {
			return fmt.Errorf("customer_dataset %q has unmapped required field %q which cannot be populated by the customer create form", mapping.CustomerDataset, f.GetName())
		}
	}

	// Verify that job collection has no unmapped required fields that the create form cannot fill
	allowedJobFields := map[string]bool{
		"id":                      true,
		"created":                 true,
		"updated":                 true,
		mapping.JobTitleField:    true,
		mapping.JobCustomerField: true,
		mapping.JobStatusField:   true,
		mapping.JobAssigneeField: true,
	}
	for _, f := range jobCol.Fields {
		if f.GetSystem() || allowedJobFields[f.GetName()] {
			continue
		}
		if isFieldRequired(f) {
			return fmt.Errorf("job_dataset %q has unmapped required field %q which cannot be populated by the job create form", mapping.JobDataset, f.GetName())
		}
	}

	return nil
}

func isFieldRequired(f core.Field) bool {
	if f == nil || f.GetSystem() {
		return false
	}
	switch concrete := f.(type) {
	case *core.TextField:
		return concrete.Required
	case *core.NumberField:
		return concrete.Required
	case *core.SelectField:
		return concrete.Required
	case *core.BoolField:
		return concrete.Required
	case *core.DateField:
		return concrete.Required
	case *core.EmailField:
		return concrete.Required
	case *core.URLField:
		return concrete.Required
	case *core.JSONField:
		return concrete.Required
	case *core.FileField:
		return concrete.Required
	case *core.RelationField:
		return concrete.Required
	default:
		return false
	}
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

// IncompatibleRulesError reports when a dataset has collection rules that
// block members from performing required module operations while preserving their restrictions.
type IncompatibleRulesError struct {
	Dataset    string   `json:"dataset"`
	BlockedOps []string `json:"blocked_operations"`
}

func (e *IncompatibleRulesError) Error() string {
	return fmt.Sprintf("dataset %q has incompatible rules that block members from performing module operations: %s; update collection rules to allow member access before enabling module", e.Dataset, strings.Join(e.BlockedOps, ", "))
}

// ValidateCustomerDatasetAccess verifies that the customer collection rules allow
// regular members to perform required module operations (list, view, create).
// If collection rules are locked (superuser only) or restricted to owners/admins,
// an IncompatibleRulesError is returned reporting the blocked operations.
func ValidateCustomerDatasetAccess(ctx context.Context, app core.App, customerDataset string) error {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return errors.New("app not ready")
	}

	col, err := app.FindCollectionByNameOrId(customerDataset)
	if err != nil || col == nil {
		return fmt.Errorf("customer dataset collection %q does not exist", customerDataset)
	}

	expList, expView, expCreate, _, _ := schemas.BuildCollectionRules(customerDataset, "")
	exactKnownRules := buildExactKnownGeneratedRules(customerDataset, "", "")

	var blockedOps []string
	if reason := existingRuleBlockReasonForMembers(col.ListRule, exactKnownRules["list"], expList, customerDataset, "list"); reason != "" {
		blockedOps = append(blockedOps, fmt.Sprintf("list (%s)", reason))
	}
	if reason := existingRuleBlockReasonForMembers(col.ViewRule, exactKnownRules["view"], expView, customerDataset, "view"); reason != "" {
		blockedOps = append(blockedOps, fmt.Sprintf("view (%s)", reason))
	}
	if reason := existingRuleBlockReasonForMembers(col.CreateRule, exactKnownRules["create"], expCreate, customerDataset, "create"); reason != "" {
		blockedOps = append(blockedOps, fmt.Sprintf("create (%s)", reason))
	}

	if len(blockedOps) > 0 {
		return &IncompatibleRulesError{
			Dataset:    customerDataset,
			BlockedOps: blockedOps,
		}
	}

	return nil
}

// EnsureJobDatasetAssigneeProtection ensures that the dataset's schema definition
// and row-level collection rules protect assigned-scope members without silently broadening
// existing restrictions or stripping custom business rules.
// All schema definition and collection rule changes are validated and saved atomically in one transaction.
func EnsureJobDatasetAssigneeProtection(ctx context.Context, app core.App, jobDataset string, assigneeField string) error {
	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return errors.New("app not ready")
	}

	return app.RunInTransaction(func(txApp core.App) error {
		col, err := txApp.FindCollectionByNameOrId(jobDataset)
		if err != nil || col == nil {
			return fmt.Errorf("job dataset collection %q does not exist", jobDataset)
		}

		schemaRec, err := txApp.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": jobDataset})
		if err != nil || schemaRec == nil {
			return fmt.Errorf("failed to load schema definition for job dataset %q: %w", jobDataset, err)
		}

		currentAssignee := schemaRec.GetString("assignee_field")

		// Build expected assigned-scope rules for target assigneeField
		expList, expView, expCreate, expUpdate, expDelete := schemas.BuildCollectionRules(jobDataset, assigneeField)

		// Build exact known generated rules to recognize unmodified generated rules:
		// 1. Rules generated with target assigneeField
		// 2. Rules generated with current schema assigneeField (if different)
		// 3. Rules generated with no assignee field ("")
		exactKnownRules := buildExactKnownGeneratedRules(jobDataset, assigneeField, currentAssignee)

		// Check for assignee remapping conflict:
		// When remapping the assignee field from currentAssignee to assigneeField,
		// if an existing custom rule contains the old assignee field/rule, reconciling it
		// would require members to match both assignee fields, blocking access.
		// Reject the remapping with a clear message unless the existing rule can be safely migrated.
		if currentAssignee != "" && currentAssignee != assigneeField {
			for _, check := range []struct {
				action string
				rule   *string
			}{
				{"list", col.ListRule},
				{"view", col.ViewRule},
				{"create", col.CreateRule},
				{"update", col.UpdateRule},
				{"delete", col.DeleteRule},
			} {
				if check.rule == nil {
					continue
				}
				cur := strings.TrimSpace(*check.rule)
				if cur == "" || isOwnerOrAdminOnlyRule(cur) {
					continue
				}
				// Exact known generated rules can be safely migrated to the new assignee rule
				if exactKnownRules[check.action][cur] {
					continue
				}
				// If a custom rule references the old assignee field, combining it with the new assignee
				// would require members to match both assignee fields, blocking access.
				if strings.Contains(cur, currentAssignee) {
					return fmt.Errorf("cannot remap assignee field from %q to %q: %s rule on collection %q contains custom restrictions referencing %q; update or reconcile the existing rule before remapping", currentAssignee, assigneeField, check.action, jobDataset, currentAssignee)
				}
			}
		}

		// Check if existing rules block members from performing required module operations BEFORE combining.
		// Owner-only, locked, or member-excluding rules are preserved on the collection, but setup must report
		// the incompatible rules so the owner is informed rather than falsely succeeding while members are blocked.
		var blockedOps []string
		if reason := existingRuleBlockReasonForMembers(col.ListRule, exactKnownRules["list"], expList, jobDataset, "list"); reason != "" {
			blockedOps = append(blockedOps, fmt.Sprintf("list (%s)", reason))
		}
		if reason := existingRuleBlockReasonForMembers(col.ViewRule, exactKnownRules["view"], expView, jobDataset, "view"); reason != "" {
			blockedOps = append(blockedOps, fmt.Sprintf("view (%s)", reason))
		}
		if reason := existingRuleBlockReasonForMembers(col.CreateRule, exactKnownRules["create"], expCreate, jobDataset, "create"); reason != "" {
			blockedOps = append(blockedOps, fmt.Sprintf("create (%s)", reason))
		}
		if reason := existingRuleBlockReasonForMembers(col.UpdateRule, exactKnownRules["update"], expUpdate, jobDataset, "update"); reason != "" {
			blockedOps = append(blockedOps, fmt.Sprintf("update (%s)", reason))
		}

		if len(blockedOps) > 0 {
			return &IncompatibleRulesError{
				Dataset:    jobDataset,
				BlockedOps: blockedOps,
			}
		}

		// Reconcile each collection rule
		targetList := reconcileCollectionRule(col.ListRule, expList, exactKnownRules["list"])
		targetView := reconcileCollectionRule(col.ViewRule, expView, exactKnownRules["view"])
		targetCreate := reconcileCollectionRule(col.CreateRule, expCreate, exactKnownRules["create"])
		targetUpdate := reconcileCollectionRule(col.UpdateRule, expUpdate, exactKnownRules["update"])
		targetDelete := reconcileCollectionRule(col.DeleteRule, expDelete, exactKnownRules["delete"])

		rulesChanged := !rulePtrEqual(col.ListRule, targetList) ||
			!rulePtrEqual(col.ViewRule, targetView) ||
			!rulePtrEqual(col.CreateRule, targetCreate) ||
			!rulePtrEqual(col.UpdateRule, targetUpdate) ||
			!rulePtrEqual(col.DeleteRule, targetDelete)

		if rulesChanged {
			col.ListRule = targetList
			col.ViewRule = targetView
			col.CreateRule = targetCreate
			col.UpdateRule = targetUpdate
			col.DeleteRule = targetDelete
			if err := txApp.Save(col); err != nil {
				return fmt.Errorf("failed to update collection rules on job dataset %q: %w", jobDataset, err)
			}
		}

		if currentAssignee != assigneeField {
			schemaRec.Set("assignee_field", assigneeField)
			if err := txApp.Save(schemaRec); err != nil {
				return fmt.Errorf("failed to update assignee_field on schema definition %q: %w", jobDataset, err)
			}
		}

		return nil
	})
}

// buildExactKnownGeneratedRules generates the exact known PocketBase rules produced
// by Lattice for a dataset across target, previous, and empty assignee configurations.
func buildExactKnownGeneratedRules(jobDataset string, newAssignee string, currentAssignee string) map[string]map[string]bool {
	known := map[string]map[string]bool{
		"list":   make(map[string]bool),
		"view":   make(map[string]bool),
		"create": make(map[string]bool),
		"update": make(map[string]bool),
		"delete": make(map[string]bool),
	}

	assignees := []string{newAssignee, currentAssignee, ""}
	for _, a := range assignees {
		l, v, c, u, d := schemas.BuildCollectionRules(jobDataset, a)
		if l != nil {
			known["list"][*l] = true
		}
		if v != nil {
			known["view"][*v] = true
		}
		if c != nil {
			known["create"][*c] = true
		}
		if u != nil {
			known["update"][*u] = true
		}
		if d != nil {
			known["delete"][*d] = true
		}
	}

	return known
}

// reconcileCollectionRule reconciles an existing collection rule with the expected
// Lattice assigned-scope rule.
// - nil rules (locked down / superuser-only) are preserved as nil.
// - Empty string or unconstrained authenticated access are replaced with exp.
// - Exact known unmodified generated rules are cleanly updated to the new exp.
// - Explicitly validated owner/admin-only restrictions are preserved as-is.
// - Any custom rule (including generated rules with appended conditions) has its FULL
//   expression preserved ((full_existing) && (exp)) without heuristic string slicing or guessing.
func reconcileCollectionRule(orig *string, exp *string, exactKnownRules map[string]bool) *string {
	if orig == nil {
		return nil
	}

	cur := strings.TrimSpace(*orig)

	// PocketBase empty string = public/unrestricted. Replace with expected assigned-scope rule.
	if cur == "" {
		return exp
	}

	// Standard unconstrained authenticated access. Replace with expected rule.
	if cur == "@request.auth.id != ''" || cur == "@request.auth.id != \"\"" ||
		cur == "@request.auth.id != null" || cur == "@request.auth.id > ''" ||
		cur == "@request.auth.id > \"\"" {
		return exp
	}

	// If already identical to expected rule, keep expected rule.
	if exp != nil && cur == *exp {
		return exp
	}

	// Recognize ONLY exact known generated rules. If the rule is an exact match for an
	// unmodified generated rule, update it cleanly to the new expected rule.
	if exactKnownRules != nil && exactKnownRules[cur] {
		return exp
	}

	// Explicitly validated owner/admin restrictions (no regular member access).
	if isOwnerOrAdminOnlyRule(cur) {
		return orig
	}

	// Check if this rule is already reconciled with the current expected rule.
	if exp != nil && isAlreadyReconciledWithExp(cur, *exp) {
		return orig
	}

	if exp == nil || *exp == "" {
		return orig
	}

	// Preserve the FULL existing rule by explicitly combining it with the expected rule.
	// Do not infer structure or slice substrings from custom rules.
	reconciled := fmt.Sprintf("(%s) && (%s)", cur, *exp)
	return &reconciled
}

func isAlreadyReconciledWithExp(cur string, exp string) bool {
	suffix := fmt.Sprintf(") && (%s)", exp)
	if !strings.HasSuffix(cur, suffix) {
		return false
	}
	prefix := cur[:len(cur)-len(suffix)+1]
	if !strings.HasPrefix(prefix, "(") || !strings.HasSuffix(prefix, ")") {
		return false
	}
	depth := 0
	for i, r := range prefix {
		if r == '(' {
			depth++
		} else if r == ')' {
			depth--
			if depth == 0 && i < len(prefix)-1 {
				return false
			}
		}
	}
	return depth == 0
}

// stripOuterParentheses removes matching balanced outer parentheses from an expression.
// For example: "(@request.auth.role = 'owner')" -> "@request.auth.role = 'owner'"
// and "((@request.auth.role = 'owner'))" -> "@request.auth.role = 'owner'"
// but "(a = 1) && (b = 2)" is preserved as "(a = 1) && (b = 2)".
func stripOuterParentheses(s string) string {
	s = strings.TrimSpace(s)
	for strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		depth := 0
		matchedEnd := false
		for i, r := range s {
			if r == '(' {
				depth++
			} else if r == ')' {
				depth--
				if depth == 0 {
					if i == len(s)-1 {
						matchedEnd = true
					}
					break
				}
			}
		}
		if matchedEnd {
			s = strings.TrimSpace(s[1 : len(s)-1])
		} else {
			break
		}
	}
	return s
}

func extractReconciledPrefix(cur string, exp string) string {
	suffix := fmt.Sprintf(") && (%s)", exp)
	if !strings.HasSuffix(cur, suffix) {
		return ""
	}
	prefix := cur[:len(cur)-len(suffix)+1]
	return stripOuterParentheses(prefix)
}

type ruleCompatStatus int

const (
	ruleCompatTrue ruleCompatStatus = iota
	ruleCompatFalse
	ruleCompatUnknown
)

type permConstraint struct {
	requiresTrue  bool
	requiresFalse bool
	scopeEqual    string
	scopeNotEqual map[string]bool
}

func (c *permConstraint) clone() *permConstraint {
	if c == nil {
		return nil
	}
	cp := *c
	if c.scopeNotEqual != nil {
		cp.scopeNotEqual = make(map[string]bool, len(c.scopeNotEqual))
		for k, v := range c.scopeNotEqual {
			cp.scopeNotEqual[k] = v
		}
	}
	return &cp
}

func (c *permConstraint) merge(other *permConstraint) bool {
	if other == nil {
		return true
	}
	if other.requiresTrue {
		c.requiresTrue = true
	}
	if other.requiresFalse {
		c.requiresFalse = true
	}
	if c.requiresTrue && c.requiresFalse {
		return false
	}

	if other.scopeEqual != "" {
		if c.scopeEqual != "" && c.scopeEqual != other.scopeEqual {
			return false
		}
		c.scopeEqual = other.scopeEqual
	}

	if len(other.scopeNotEqual) > 0 {
		if c.scopeNotEqual == nil {
			c.scopeNotEqual = make(map[string]bool, len(other.scopeNotEqual))
		}
		for val := range other.scopeNotEqual {
			c.scopeNotEqual[val] = true
		}
	}

	if c.scopeEqual != "" && c.scopeNotEqual != nil && c.scopeNotEqual[c.scopeEqual] {
		return false
	}

	return true
}

type branchResult struct {
	status      ruleCompatStatus
	reason      string
	constraints map[string]*permConstraint
}

type evalResult struct {
	status   ruleCompatStatus
	reason   string
	branches []branchResult
}

func (r evalResult) getBranches() []branchResult {
	if len(r.branches) > 0 {
		return r.branches
	}
	return []branchResult{{
		status: r.status,
		reason: r.reason,
	}}
}

func cloneConstraints(m map[string]*permConstraint) map[string]*permConstraint {
	if m == nil {
		return nil
	}
	res := make(map[string]*permConstraint, len(m))
	for k, v := range m {
		res[k] = v.clone()
	}
	return res
}

func combineBranches(a, b branchResult) branchResult {
	if a.status == ruleCompatFalse {
		return a
	}
	if b.status == ruleCompatFalse {
		return b
	}
	if a.status == ruleCompatUnknown {
		return a
	}
	if b.status == ruleCompatUnknown {
		return b
	}

	merged := cloneConstraints(a.constraints)
	if len(b.constraints) > 0 {
		if merged == nil {
			merged = cloneConstraints(b.constraints)
		} else {
			for k, c := range b.constraints {
				if existing, exists := merged[k]; exists {
					if !existing.merge(c) {
						return branchResult{
							status: ruleCompatFalse,
							reason: "conflicting permission condition",
						}
					}
				} else {
					merged[k] = c.clone()
				}
			}
		}
	}

	return branchResult{
		status:      ruleCompatTrue,
		constraints: merged,
	}
}

func pruneDeadBranches(branches []branchResult) []branchResult {
	hasNonFalse := false
	for _, b := range branches {
		if b.status != ruleCompatFalse {
			hasNonFalse = true
			break
		}
	}
	if !hasNonFalse {
		return branches
	}
	var survivors []branchResult
	for _, b := range branches {
		if b.status != ruleCompatFalse {
			survivors = append(survivors, b)
		}
	}
	return survivors
}

func overallStatus(branches []branchResult) (ruleCompatStatus, string) {
	hasAnyTrue := false
	hasAnyUnknown := false
	var firstUnknownReason string
	var firstFalseReason string

	for _, b := range branches {
		switch b.status {
		case ruleCompatTrue:
			hasAnyTrue = true
		case ruleCompatUnknown:
			hasAnyUnknown = true
			if firstUnknownReason == "" {
				firstUnknownReason = b.reason
			}
		case ruleCompatFalse:
			if firstFalseReason == "" {
				firstFalseReason = b.reason
			}
		}
	}

	if hasAnyTrue {
		return ruleCompatTrue, ""
	}
	if hasAnyUnknown {
		if firstUnknownReason == "" {
			firstUnknownReason = "unknown compatibility"
		}
		return ruleCompatUnknown, firstUnknownReason
	}
	if firstFalseReason == "" {
		firstFalseReason = "restricted to non-members"
	}
	return ruleCompatFalse, firstFalseReason
}

func makePermConstraint(permKey string, op string, rightNorm string, rightStr string, rightVal string) *permConstraint {
	if strings.HasSuffix(permKey, ".scope") {
		switch op {
		case "=", "?=":
			if rightNorm != "" {
				return &permConstraint{scopeEqual: rightNorm}
			}
		case "!=", "?!=":
			if rightNorm != "" {
				return &permConstraint{scopeNotEqual: map[string]bool{rightNorm: true}}
			}
		}
		return nil
	}

	// Boolean permission
	if rightStr == "" {
		return &permConstraint{requiresTrue: true}
	}
	switch op {
	case "=", "?=":
		if rightNorm == "true" || rightNorm == "1" {
			return &permConstraint{requiresTrue: true}
		}
		if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
			return &permConstraint{requiresFalse: true}
		}
	case "!=", "?!=":
		if rightNorm == "true" || rightNorm == "1" {
			return &permConstraint{requiresFalse: true}
		}
		if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
			return &permConstraint{requiresTrue: true}
		}
	}
	return nil
}

func permCompatTrue(permKey string, op string, rightNorm string, rightStr string, rightVal string) evalResult {
	pc := makePermConstraint(permKey, op, rightNorm, rightStr, rightVal)
	var constraints map[string]*permConstraint
	if pc != nil {
		constraints = map[string]*permConstraint{permKey: pc}
	}
	return evalResult{
		status: ruleCompatTrue,
		branches: []branchResult{{
			status:      ruleCompatTrue,
			constraints: constraints,
		}},
	}
}

func unquoteLiteral(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 {
		if (s[0] == '\'' && s[len(s)-1] == '\'') || (s[0] == '"' && s[len(s)-1] == '"') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

func requiredPermissionForOp(dataset string, operation string) (string, string) {
	d := strings.ToLower(strings.TrimSpace(dataset))
	op := strings.ToLower(strings.TrimSpace(operation))
	if d == "" || op == "" {
		return "", ""
	}
	var action string
	switch op {
	case "list", "view":
		action = "read"
	case "create":
		action = "create"
	case "update":
		action = "update"
	case "delete":
		action = "delete"
	default:
		action = op
	}
	return fmt.Sprintf("@request.auth.permissions.%s.%s", d, action), fmt.Sprintf("@request.auth.permissions.%s.scope", d)
}

func evalSingleExprForMember(e fexpr.Expr, dataset string, operation string) evalResult {
	leftStr := strings.TrimSpace(e.Left.Literal)
	rightStr := strings.TrimSpace(e.Right.Literal)
	op := string(e.Op)

	// If right is @request.auth and left is not, swap them if possible
	if !strings.HasPrefix(leftStr, "@request.auth.") && strings.HasPrefix(rightStr, "@request.auth.") {
		leftStr, rightStr = rightStr, leftStr
		switch op {
		case ">":
			op = "<"
		case "<":
			op = ">"
		case ">=":
			op = "<="
		case "<=":
			op = ">="
		}
	}

	leftNorm := strings.ToLower(leftStr)
	rightVal := unquoteLiteral(rightStr)
	rightNorm := strings.ToLower(rightVal)

	isBoolConst := func(s string) (bool, bool) {
		switch strings.ToLower(s) {
		case "true", "1":
			return true, true
		case "false", "0":
			return false, true
		default:
			return false, false
		}
	}

	leftBVal, leftIsBConst := isBoolConst(leftNorm)
	rightBVal, rightIsBConst := isBoolConst(rightNorm)

	// Constant evaluation applies ONLY when both operands are literals (or standalone single literal)
	if leftIsBConst && rightIsBConst {
		switch op {
		case "=", "?=":
			if leftBVal == rightBVal {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		case "!=", "?!=":
			if leftBVal != rightBVal {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		}
	}
	if leftIsBConst && rightStr == "" {
		if leftBVal {
			return evalResult{status: ruleCompatTrue}
		}
		return evalResult{status: ruleCompatFalse, reason: "locked"}
	}
	if e.Left.Type == fexpr.TokenText && e.Right.Type == fexpr.TokenText {
		switch op {
		case "=", "?=":
			if rightVal == unquoteLiteral(leftStr) {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		case "!=", "?!=":
			if rightVal != unquoteLiteral(leftStr) {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		}
	}
	if e.Left.Type == fexpr.TokenNumber && e.Right.Type == fexpr.TokenNumber {
		switch op {
		case "=", "?=":
			if leftNorm == rightNorm {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		case "!=", "?!=":
			if leftNorm != rightNorm {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "locked"}
		}
	}

	// @request.auth.role checks
	if leftNorm == "@request.auth.role" {
		isMember := (rightNorm == "member")
		isOwnerOrAdmin := (rightNorm == "owner" || rightNorm == "admin")

		switch op {
		case "=", "?=":
			if isMember {
				return evalResult{status: ruleCompatTrue}
			}
			if isOwnerOrAdmin {
				return evalResult{status: ruleCompatFalse, reason: "restricted to owners/admins"}
			}
			return evalResult{status: ruleCompatFalse, reason: "restricted to non-members"}

		case "!=", "?!=":
			if isMember {
				return evalResult{status: ruleCompatFalse, reason: "restricted to non-members"}
			}
			// For a regular member, role != 'owner' and role != 'admin' are TRUE!
			return evalResult{status: ruleCompatTrue}

		default:
			return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
		}
	}

	// @request.auth.id checks
	if leftNorm == "@request.auth.id" {
		isEmpty := (rightVal == "" || rightNorm == "null")
		switch op {
		case "!=", "?!=", ">", "?>":
			if isEmpty {
				return evalResult{status: ruleCompatTrue}
			}
		case "=", "?=":
			if isEmpty {
				return evalResult{status: ruleCompatFalse, reason: "requires unauthenticated"}
			}
		}
		// If comparing @request.auth.id with a relation or field: assignee = @request.auth.id
		// A record can have assignee = member.id, so it is satisfiable for members.
		return evalResult{status: ruleCompatTrue}
	}

	// @request.auth.disabled checks
	if leftNorm == "@request.auth.disabled" {
		switch op {
		case "!=", "?!=":
			if rightNorm == "true" || rightNorm == "1" {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "requires disabled user"}
		case "=", "?=":
			if rightNorm == "false" || rightNorm == "0" {
				return evalResult{status: ruleCompatTrue}
			}
			return evalResult{status: ruleCompatFalse, reason: "requires disabled user"}
		}
	}

	// @request.auth.permissions checks (e.g. @request.auth.permissions.jobs.read = true)
	if strings.HasPrefix(leftNorm, "@request.auth.permissions.") {
		if rightStr == "" {
			return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
		}

		reqPermPath, reqScopePath := requiredPermissionForOp(dataset, operation)

		isTargetPerm := (reqPermPath != "" && leftNorm == reqPermPath)
		isTargetScope := (reqScopePath != "" && leftNorm == reqScopePath)

		if isTargetPerm {
			// This check targets the required permission for the validated operation.
			// Reconciling with the generated rule requires this permission to be true,
			// so requiring it to be false/null/empty conflicts and blocks members.
			switch op {
			case "=", "?=":
				if rightNorm == "true" || rightNorm == "1" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			case "!=", "?!=":
				if rightNorm == "true" || rightNorm == "1" {
					return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
				}
				if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			default:
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
			}
		}

		if isTargetScope {
			switch op {
			case "=", "?=":
				if rightNorm == "all" || rightNorm == "assigned" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				if rightNorm == "none" || rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			case "!=", "?!=":
				if rightNorm == "none" || rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				if rightNorm == "all" || rightNorm == "assigned" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			default:
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
			}
		}

		if reqPermPath == "" {
			// Fallback conservative mode when dataset and operation context is absent
			switch op {
			case "=", "?=":
				if rightNorm == "true" || rightNorm == "1" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
				}
				if strings.HasSuffix(leftNorm, ".scope") {
					if rightNorm == "all" || rightNorm == "assigned" {
						return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
					}
					if rightNorm == "none" {
						return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
					}
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			case "!=", "?!=":
				if rightNorm == "true" || rightNorm == "1" {
					return evalResult{status: ruleCompatFalse, reason: "conflicting permission condition"}
				}
				if rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
					return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
				}
				if strings.HasSuffix(leftNorm, ".scope") {
					if rightNorm == "none" || rightNorm == "all" || rightNorm == "assigned" {
						return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
					}
				}
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

			default:
				return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
			}
		}

		// Unrelated operation or dataset permission check:
		// A member performing this operation can have an unrelated permission set to true or false
		// (e.g. a read-only member with jobs.read = true and jobs.update = false listing jobs).
		switch op {
		case "=", "?=":
			if rightNorm == "true" || rightNorm == "1" || rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
				return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
			}
			if strings.HasSuffix(leftNorm, ".scope") && (rightNorm == "all" || rightNorm == "assigned" || rightNorm == "none") {
				return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
			}
			return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

		case "!=", "?!=":
			if rightNorm == "true" || rightNorm == "1" || rightNorm == "false" || rightNorm == "0" || rightNorm == "null" || rightVal == "" {
				return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
			}
			if strings.HasSuffix(leftNorm, ".scope") && (rightNorm == "all" || rightNorm == "assigned" || rightNorm == "none") {
				return permCompatTrue(leftNorm, op, rightNorm, rightStr, rightVal)
			}
			return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}

		default:
			return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
		}
	}

	// Any other @request.auth.* attribute is a custom auth attribute we cannot verify
	if strings.HasPrefix(leftNorm, "@request.auth.") || strings.HasPrefix(rightNorm, "@request.auth.") {
		return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
	}

	// Non-auth field comparisons on record data (e.g. status = 'Open', title != '', archived = false)
	// These are row-level filters that can be satisfied by matching records, not role lockouts.
	return evalResult{status: ruleCompatTrue}
}

const maxCompatBranches = 64

func evalExprGroupsForMember(groups []fexpr.ExprGroup, dataset string, operation string) evalResult {
	if len(groups) == 0 {
		return evalResult{status: ruleCompatTrue}
	}

	type branch struct {
		terms []evalResult
	}

	var branches []branch
	var currentBranch branch

	for i, group := range groups {
		var termRes evalResult
		switch item := group.Item.(type) {
		case fexpr.Expr:
			termRes = evalSingleExprForMember(item, dataset, operation)
		case []fexpr.ExprGroup:
			termRes = evalExprGroupsForMember(item, dataset, operation)
		case fexpr.ExprGroup:
			termRes = evalExprGroupsForMember([]fexpr.ExprGroup{item}, dataset, operation)
		default:
			termRes = evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
		}

		if i > 0 && group.Join == fexpr.JoinOr {
			branches = append(branches, currentBranch)
			currentBranch = branch{terms: []evalResult{termRes}}
		} else {
			currentBranch.terms = append(currentBranch.terms, termRes)
		}
	}
	branches = append(branches, currentBranch)

	var allBranches []branchResult
	for _, b := range branches {
		bResults := []branchResult{{status: ruleCompatTrue}}
		for _, t := range b.terms {
			var nextResults []branchResult
			termBranches := t.getBranches()
			for _, cur := range bResults {
				for _, tb := range termBranches {
					combined := combineBranches(cur, tb)
					nextResults = append(nextResults, combined)
					if len(nextResults) > maxCompatBranches {
						return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
					}
				}
			}
			bResults = pruneDeadBranches(nextResults)
		}
		allBranches = append(allBranches, bResults...)
		if len(allBranches) > maxCompatBranches {
			return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
		}
	}

	allBranches = pruneDeadBranches(allBranches)
	status, reason := overallStatus(allBranches)
	return evalResult{
		status:   status,
		reason:   reason,
		branches: allBranches,
	}
}

func evalRuleForMember(rule string, dataset string, operation string) evalResult {
	rule = stripOuterParentheses(strings.TrimSpace(rule))
	if rule == "" {
		return evalResult{status: ruleCompatTrue}
	}
	rNorm := strings.ToLower(rule)
	if rNorm == "true" || rNorm == "1=1" || rNorm == "1 = 1" {
		return evalResult{status: ruleCompatTrue}
	}
	if rNorm == "false" || rNorm == "0=1" || rNorm == "0 = 1" || rNorm == "1=0" || rNorm == "1 = 0" {
		return evalResult{status: ruleCompatFalse, reason: "locked"}
	}

	groups, err := fexpr.Parse(rule)
	if err != nil {
		return evalResult{status: ruleCompatUnknown, reason: "unknown compatibility"}
	}

	return evalExprGroupsForMember(groups, dataset, operation)
}

func isOwnerOrAdminOnlyRule(rule string) bool {
	res := evalRuleForMember(rule, "", "")
	return res.status == ruleCompatFalse && res.reason == "restricted to owners/admins"
}

func existingRuleBlockReasonForMembers(orig *string, exactKnown map[string]bool, exp *string, dataset string, operation string) string {
	if orig == nil {
		return "locked (superuser only)"
	}
	cur := strings.TrimSpace(*orig)
	if cur == "" {
		return "" // empty = public/unrestricted, replaced cleanly by exp
	}
	// Exact known unmodified generated rules: cleanly updated to exp
	if exactKnown != nil && exactKnown[cur] {
		return ""
	}
	if exp != nil && cur == *exp {
		return ""
	}

	// Check if already reconciled with exp: extract and test the custom prefix
	if exp != nil && isAlreadyReconciledWithExp(cur, *exp) {
		prefix := extractReconciledPrefix(cur, *exp)
		res := evalRuleForMember(prefix, dataset, operation)
		if res.status != ruleCompatTrue {
			if res.reason != "" {
				return res.reason
			}
			return "unknown compatibility"
		}
		return ""
	}

	// Evaluate the existing rule for an authenticated member
	res := evalRuleForMember(cur, dataset, operation)
	if res.status != ruleCompatTrue {
		if res.reason != "" {
			return res.reason
		}
		return "unknown compatibility"
	}

	return ""
}

func ruleBlockReasonForMembers(rule *string) string {
	return existingRuleBlockReasonForMembers(rule, nil, nil, "", "")
}

func rulePtrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
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
