package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("app_pages")

		// API rules: Authenticated users can list, view, create, update, and delete app_pages.
		authRule := "@request.auth.id != ''"
		collection.ListRule = types.Pointer(authRule)
		collection.ViewRule = types.Pointer(authRule)
		collection.CreateRule = types.Pointer(authRule)
		collection.UpdateRule = types.Pointer(authRule)
		collection.DeleteRule = types.Pointer(authRule)

		collection.Fields.Add(
			&core.TextField{Name: "page_id", Required: true},
			&core.TextField{Name: "name", Required: true},
			&core.TextField{Name: "description"},
			&core.TextField{Name: "icon"},
			&core.TextField{Name: "view_type", Required: true},
			&core.TextField{Name: "collection", Required: true},
			&core.JSONField{Name: "config", Required: true, MaxSize: 1 << 20},
		)

		collection.AddIndex("idx_app_pages_page_id", true, "page_id", "")
		collection.AddIndex("idx_app_pages_view_type", false, "view_type", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("app_pages")
		if err != nil {
			return nil // already deleted
		}
		return app.Delete(collection)
	}, "1794000000_create_app_pages.go")
}
