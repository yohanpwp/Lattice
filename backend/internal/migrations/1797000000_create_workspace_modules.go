package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("workspace_modules")

		authRule := "@request.auth.id != '' && @request.auth.disabled != true"
		ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"

		collection.ListRule = types.Pointer(authRule)
		collection.ViewRule = types.Pointer(authRule)
		collection.CreateRule = types.Pointer(ownerAdminRule)
		collection.UpdateRule = types.Pointer(ownerAdminRule)
		collection.DeleteRule = types.Pointer(ownerAdminRule)

		collection.Fields.Add(
			&core.TextField{Name: "module_id", Required: true},
			&core.BoolField{Name: "enabled"},
			&core.TextField{Name: "version", Required: true},
			&core.JSONField{Name: "mapping", Required: true, MaxSize: 1 << 20},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)

		collection.AddIndex("idx_workspace_modules_module_id", true, "module_id", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("workspace_modules")
		if err != nil {
			return nil
		}
		return app.Delete(collection)
	}, "1797000000_create_workspace_modules.go")
}
