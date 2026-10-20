package migrations

import (
	"github.com/pocketbase/pocketbase/core"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("schema_definitions")

		// Superuser and backend service layer only. No public API rules are set.
		collection.Fields.Add(
			&core.TextField{Name: "schema_id", Required: true},
			&core.TextField{Name: "name", Required: true},
			&core.TextField{Name: "description"},
			&core.TextField{Name: "icon"},
			&core.JSONField{Name: "fields", Required: true, MaxSize: 1 << 20},
			&core.TextField{Name: "collection_id"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)

		collection.AddIndex("idx_schema_definitions_schema_id", true, "schema_id", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("schema_definitions")
		if err != nil {
			return nil // already deleted
		}
		return app.Delete(collection)
	}, "1793000000_create_schema_definitions.go")
}
