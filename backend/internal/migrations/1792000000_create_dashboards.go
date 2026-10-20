package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("dashboards")

		// API rules: Authenticated users can list, view, create, update and delete dashboards.
		authRule := "@request.auth.id != ''"
		collection.ListRule = types.Pointer(authRule)
		collection.ViewRule = types.Pointer(authRule)
		collection.CreateRule = types.Pointer(authRule)
		collection.UpdateRule = types.Pointer(authRule)
		collection.DeleteRule = types.Pointer(authRule)

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
