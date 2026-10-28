package migrations

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		// 1. Update users collection with role, disabled, permissions
		usersCol, err := app.FindCollectionByNameOrId("users")
		if err == nil && usersCol != nil {
			if usersCol.Fields.GetByName("role") == nil {
				usersCol.Fields.Add(&core.SelectField{
					Name:     "role",
					Required: true,
					Values:   []string{"owner", "admin", "member"},
				})
			}
			if usersCol.Fields.GetByName("disabled") == nil {
				usersCol.Fields.Add(&core.BoolField{
					Name: "disabled",
				})
			}
			if usersCol.Fields.GetByName("permissions") == nil {
				usersCol.Fields.Add(&core.JSONField{
					Name:    "permissions",
					MaxSize: 1 << 20,
				})
			}
			// Disable public self-registration. Only setup route or invitations can create users.
			usersCol.CreateRule = nil

			if err := app.Save(usersCol); err != nil {
				return err
			}

			// If existing users exist without a role, default their role to "member".
			// Do NOT automatically promote any existing user to owner.
			// Establishing workspace ownership requires explicit operator-controlled setup.
			existingUsers, err := app.FindRecordsByFilter("users", "", "@rowid", 500, 0)
			if err == nil {
				for _, u := range existingUsers {
					if u.GetString("role") == "" {
						u.Set("role", "member")
						_ = app.Save(u)
					}
				}
			}
		}

		// 2. Create invitations collection (superuser / service only)
		existingInv, _ := app.FindCollectionByNameOrId("invitations")
		if existingInv == nil {
			invCol := core.NewBaseCollection("invitations")
			invCol.Fields.Add(
				&core.EmailField{Name: "email", Required: true},
				&core.SelectField{Name: "role", Required: true, Values: []string{"admin", "member"}},
				&core.JSONField{Name: "permissions", MaxSize: 1 << 20},
				&core.TextField{Name: "token", Required: true},
				&core.DateField{Name: "expires_at", Required: true},
				&core.DateField{Name: "accepted_at"},
				&core.BoolField{Name: "revoked"},
				&core.TextField{Name: "invited_by"},
				&core.AutodateField{Name: "created", OnCreate: true},
				&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
			)
			invCol.AddIndex("idx_invitations_token", true, "token", "")
			if err := app.Save(invCol); err != nil {
				return err
			}
		}

		// 3. Secure app_pages collection: owner and admin write only; active accounts only
		appPagesCol, _ := app.FindCollectionByNameOrId("app_pages")
		if appPagesCol != nil {
			authRule := "@request.auth.id != '' && @request.auth.disabled != true"
			ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"
			appPagesCol.ListRule = types.Pointer(authRule)
			appPagesCol.ViewRule = types.Pointer(authRule)
			appPagesCol.CreateRule = types.Pointer(ownerAdminRule)
			appPagesCol.UpdateRule = types.Pointer(ownerAdminRule)
			appPagesCol.DeleteRule = types.Pointer(ownerAdminRule)
			if err := app.Save(appPagesCol); err != nil {
				return err
			}
		}

		// 4. Secure dashboards collection: owner and admin write only; active accounts only
		dashboardsCol, _ := app.FindCollectionByNameOrId("dashboards")
		if dashboardsCol != nil {
			authRule := "@request.auth.id != '' && @request.auth.disabled != true"
			ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"
			dashboardsCol.ListRule = types.Pointer(authRule)
			dashboardsCol.ViewRule = types.Pointer(authRule)
			dashboardsCol.CreateRule = types.Pointer(ownerAdminRule)
			dashboardsCol.UpdateRule = types.Pointer(ownerAdminRule)
			dashboardsCol.DeleteRule = types.Pointer(ownerAdminRule)
			if err := app.Save(dashboardsCol); err != nil {
				return err
			}
		}

		// 5. Create workspace_setup collection for transactional bootstrap token storage
		existingSetup, _ := app.FindCollectionByNameOrId("workspace_setup")
		if existingSetup == nil {
			setupCol := core.NewBaseCollection("workspace_setup")
			setupCol.Fields.Add(
				&core.TextField{Name: "token_hash", Required: true},
				&core.TextField{Name: "plain_token"},
				&core.DateField{Name: "expires_at", Required: true},
				&core.BoolField{Name: "completed"},
				&core.AutodateField{Name: "created", OnCreate: true},
				&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
			)
			// Locked completely to external API requests
			setupCol.ListRule = nil
			setupCol.ViewRule = nil
			setupCol.CreateRule = nil
			setupCol.UpdateRule = nil
			setupCol.DeleteRule = nil
			if err := app.Save(setupCol); err != nil {
				return err
			}
		}

		// 6. Ensure schema_definitions has assignee_field
		schemaDefsCol, _ := app.FindCollectionByNameOrId("schema_definitions")
		if schemaDefsCol != nil && schemaDefsCol.Fields.GetByName("assignee_field") == nil {
			schemaDefsCol.Fields.Add(&core.TextField{Name: "assignee_field"})
			if err := app.Save(schemaDefsCol); err != nil {
				return err
			}
		}

		// 7. Migrate existing business collections to secure permission-aware rules
		collections, err := app.FindAllCollections()
		if err == nil {
			for _, col := range collections {
				if col.System || strings.HasPrefix(col.Name, "_") || tenant.PlatformCollections[col.Name] ||
					col.Name == "users" || col.Name == "invitations" || col.Name == "workspace_setup" {
					continue
				}

				// Check if assignee field exists in schema_definitions or as a relation field pointing to users
				var assigneeField string
				schemaRec, _ := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": col.Name})
				if schemaRec != nil {
					assigneeField = schemaRec.GetString("assignee_field")
				}
				if assigneeField == "" {
					for _, f := range col.Fields {
						if rf, ok := f.(*core.RelationField); ok && rf.Name == "assignee" {
							assigneeField = "assignee"
							break
						}
					}
				}

				listRule, viewRule, createRule, updateRule, deleteRule := schemas.BuildCollectionRules(col.Name, assigneeField)
				col.ListRule = listRule
				col.ViewRule = viewRule
				col.CreateRule = createRule
				col.UpdateRule = updateRule
				col.DeleteRule = deleteRule
				_ = app.Save(col)
			}
		}

		return nil
	}, func(app core.App) error {
		// Down migration
		invCol, err := app.FindCollectionByNameOrId("invitations")
		if err == nil && invCol != nil {
			_ = app.Delete(invCol)
		}
		return nil
	}, "1795000000_workspace_authorization.go")
}
