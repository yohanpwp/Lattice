// Package migrations holds our schema migrations. They are applied
// automatically on `serve` together with PocketBase's own migrations.
// Import it for its side effects: _ "github.com/Lattice/backend/internal/migrations"
package migrations

import (
	"github.com/pocketbase/pocketbase/core"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("outbox")

		// No API rules are set, so only superusers can access this collection.
		collection.Fields.Add(
			&core.TextField{Name: "event_id", Required: true},
			&core.TextField{Name: "type", Required: true},
			&core.NumberField{Name: "version", Required: true, OnlyInt: true},
			&core.DateField{Name: "occurred_at", Required: true},
			&core.TextField{Name: "tenant_id", Required: true},
			&core.JSONField{Name: "data", MaxSize: 1 << 20},
			&core.SelectField{
				Name:      "status",
				Required:  true,
				Values:    []string{"pending", "delivered", "failed"},
				MaxSelect: 1,
			},
			// attempts is not Required: Required rejects zero, and a new event has 0 attempts.
			&core.NumberField{Name: "attempts", OnlyInt: true},
			&core.DateField{Name: "next_attempt_at"},
			&core.TextField{Name: "last_error", Max: 2000},
		)

		collection.AddIndex("idx_outbox_event_id", true, "event_id", "")
		collection.AddIndex("idx_outbox_due", false, "status, next_attempt_at", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("outbox")
		if err != nil {
			return nil // already gone
		}
		return app.Delete(collection)
	}, "1790000000_create_outbox.go")
}
