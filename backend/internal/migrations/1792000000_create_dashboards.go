package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("dashboards")

		// API rules: Authenticated users can list and view dashboards; owners and admins can modify.
		authRule := "@request.auth.id != '' && @request.auth.disabled != true"
		ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"
		collection.ListRule = types.Pointer(authRule)
		collection.ViewRule = types.Pointer(authRule)
		collection.CreateRule = types.Pointer(ownerAdminRule)
		collection.UpdateRule = types.Pointer(ownerAdminRule)
		collection.DeleteRule = types.Pointer(ownerAdminRule)

		collection.Fields.Add(
			&core.TextField{Name: "name", Required: true},
			&core.JSONField{Name: "layout", Required: true, MaxSize: 1 << 20},
		)

		usersCol, err := app.FindCollectionByNameOrId("users")
		if err == nil && usersCol != nil {
			collection.Fields.Add(&core.RelationField{
				Name:          "user",
				CollectionId:  usersCol.Id,
				MaxSelect:     1,
				CascadeDelete: false,
			})
		} else {
			collection.Fields.Add(&core.TextField{Name: "user_id"})
		}

		collection.AddIndex("idx_dashboards_name", false, "name", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("dashboards")
		if err != nil {
			return nil // already deleted
		}
		return app.Delete(collection)
	}, "1792000000_create_dashboards.go")
}
