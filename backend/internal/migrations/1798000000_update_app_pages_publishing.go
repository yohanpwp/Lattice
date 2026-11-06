package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		col, err := app.FindCollectionByNameOrId("app_pages")
		if err != nil || col == nil {
			return nil
		}

		if col.Fields.GetByName("published") == nil {
			col.Fields.Add(&core.BoolField{Name: "published"})
		}
		if col.Fields.GetByName("nav_order") == nil {
			col.Fields.Add(&core.NumberField{Name: "nav_order"})
		}

		// Owner and admin can view all pages (published and unpublished drafts);
		// authenticated members can only list and view pages that have published == true.
		viewRule := "@request.auth.id != '' && @request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || published = true)"
		ownerAdminRule := "@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin')"

		col.ListRule = types.Pointer(viewRule)
		col.ViewRule = types.Pointer(viewRule)
		col.CreateRule = types.Pointer(ownerAdminRule)
		col.UpdateRule = types.Pointer(ownerAdminRule)
		col.DeleteRule = types.Pointer(ownerAdminRule)

		if err := app.Save(col); err != nil {
			return err
		}

		// Ensure all existing pages have published = true and nav_order = 0 by default.
		// PocketBase BoolField creates SQLite columns with DEFAULT FALSE NOT NULL, so existing rows
		// get 0 (false) immediately upon adding the column. Update all records to published = true
		// so an upgrade does not hide existing pages into drafts.
		if _, err := app.DB().NewQuery("UPDATE app_pages SET published = 1 WHERE published = 0 OR published IS NULL").Execute(); err != nil {
			return err
		}
		if _, err := app.DB().NewQuery("UPDATE app_pages SET nav_order = 0 WHERE nav_order IS NULL").Execute(); err != nil {
			return err
		}

		return nil
	}, func(app core.App) error {
		return nil
	}, "1798000000_update_app_pages_publishing.go")
}
