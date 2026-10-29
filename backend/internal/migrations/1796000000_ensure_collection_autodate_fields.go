package migrations

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/tenant"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		cols, err := app.FindAllCollections()
		if err != nil || cols == nil {
			return nil
		}

		for _, col := range cols {
			if col == nil || col.System || strings.HasPrefix(col.Name, "_") {
				continue
			}
			if tenant.PlatformCollections[col.Name] {
				continue
			}

			changed := false
			if col.Fields.GetByName("created") == nil {
				col.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
				changed = true
			}
			if col.Fields.GetByName("updated") == nil {
				col.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
				changed = true
			}

			if changed {
				if err := app.Save(col); err != nil {
					return err
				}
			}
		}

		return nil
	}, func(app core.App) error {
		return nil
	}, "1796000000_ensure_collection_autodate_fields.go")
}
