package migrations

import (
	"github.com/pocketbase/pocketbase/core"
)

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		collection := core.NewBaseCollection("payment_ledger")

		// No API rules are set, so only the service layer and superusers can access this collection.
		collection.Fields.Add(
			&core.TextField{Name: "order_id", Required: true},
			&core.TextField{Name: "user_id"},
			&core.SelectField{
				Name:      "status",
				Required:  true,
				Values:    []string{"pending", "succeeded", "failed", "refunded", "partially_refunded"},
				MaxSelect: 1,
			},
			&core.NumberField{Name: "amount", Required: true, OnlyInt: true},
			&core.TextField{Name: "currency", Required: true},
			&core.TextField{Name: "provider", Required: true},
			&core.TextField{Name: "provider_charge_id"},
			&core.TextField{Name: "idempotency_key", Required: true},
			&core.TextField{Name: "payment_url", Max: 2048},
			&core.JSONField{Name: "metadata", MaxSize: 1 << 20},
		)

		collection.AddIndex("idx_payment_ledger_provider_charge", true, "provider_charge_id", "provider_charge_id != ''")
		collection.AddIndex("idx_payment_ledger_idempotency", true, "idempotency_key", "")
		collection.AddIndex("idx_payment_ledger_order", false, "order_id", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("payment_ledger")
		if err != nil {
			return nil // already deleted
		}
		return app.Delete(collection)
	}, "1791000000_create_payment_ledger.go")
}
