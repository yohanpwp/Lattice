package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("app_pages")

		// API rules: Authenticated users can list and view app_pages; owners and admins can modify.
		authRule := "@request.auth.id != '' && @request.auth.disabled != true"
		ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"
		collection.ListRule = types.Pointer(authRule)
		collection.ViewRule = types.Pointer(authRule)
		collection.CreateRule = types.Pointer(ownerAdminRule)
		collection.UpdateRule = types.Pointer(ownerAdminRule)
		collection.DeleteRule = types.Pointer(ownerAdminRule)

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
