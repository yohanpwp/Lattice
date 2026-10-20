// Package api registers our custom /v1/* routes on top of PocketBase's router.
// PocketBase's own /api/* endpoints are left untouched.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/features"
	"github.com/Lattice/backend/internal/platform/schemas"
	"github.com/Lattice/backend/internal/platform/tenant"
	"github.com/Lattice/backend/internal/plugins/payments"
)

// Register adds the /v1 routes. Call it from the app.OnServe() hook.
func Register(se *core.ServeEvent, cfg *tenant.Config, flags *features.Flags) {
	if flags == nil {
		flags = features.Empty()
	}

	tenantID := ""
	if cfg != nil {
		tenantID = cfg.TenantID
	}

	paySvc := payments.InitService(se.App)

	se.Router.GET("/v1/health", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	// Public, non-secret configuration for clients (web, desktop, mobile).
	se.Router.GET("/v1/config", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "public, max-age=60")
		if cfg == nil {
			return e.JSON(http.StatusOK, cfg)
		}
		res := *cfg
		res.Collections = tenant.DiscoveredCollections(e.App, cfg.Collections)
		return e.JSON(http.StatusOK, &res)
	})

	// Per-tenant feature flags and their non-secret options.
	// Requires a signed-in user.
	se.Router.GET("/v1/features", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, flags)
	}).Bind(apis.RequireAuth())

	schemaSvc := schemas.NewService(se.App)

	// List all business schemas with fields (requires auth)
	se.Router.GET("/v1/schemas", func(e *core.RequestEvent) error {
		list, err := schemaSvc.ListSchemas(e.Request.Context())
		if err != nil {
			return e.JSON(http.StatusInternalServerError, map[string]string{
				"error":   "internal_error",
				"message": err.Error(),
			})
		}
		return e.JSON(http.StatusOK, list)
	}).Bind(apis.RequireAuth())

	// Get a specific business schema by ID (requires auth)
	se.Router.GET("/v1/schemas/{id}", func(e *core.RequestEvent) error {
		id := e.Request.PathValue("id")
		item, err := schemaSvc.GetSchema(e.Request.Context(), id)
		if err != nil {
			if errors.Is(err, schemas.ErrSchemaNotFound) {
				return e.JSON(http.StatusNotFound, map[string]string{
					"error":   "not_found",
					"message": fmt.Sprintf("schema %q not found", id),
				})
			}
			return e.JSON(http.StatusInternalServerError, map[string]string{
				"error":   "internal_error",
				"message": err.Error(),
			})
		}
		return e.JSON(http.StatusOK, item)
	}).Bind(apis.RequireAuth())

	// Create a new business schema (requires auth)
	se.Router.POST("/v1/schemas", func(e *core.RequestEvent) error {
		var rawDoc any
		if err := e.BindBody(&rawDoc); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		if err := tenant.ValidateContractDocument("SchemaDefinition", rawDoc); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		encoded, err := json.Marshal(rawDoc)
		if err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		var def schemas.SchemaDefinition
		if err := json.Unmarshal(encoded, &def); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		created, err := schemaSvc.CreateSchema(e.Request.Context(), def)
		if err != nil {
			if errors.Is(err, schemas.ErrSchemaAlreadyExists) {
				return e.JSON(http.StatusConflict, map[string]string{
					"error":   "conflict",
					"message": err.Error(),
				})
			}
			if errors.Is(err, schemas.ErrReservedSchemaID) || errors.Is(err, schemas.ErrInvalidSchemaID) || errors.Is(err, schemas.ErrInvalidFieldName) {
				return e.JSON(http.StatusBadRequest, map[string]string{
					"error":   "invalid_request",
					"message": err.Error(),
				})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "failed_to_create_schema",
				"message": err.Error(),
			})
		}

		return e.JSON(http.StatusOK, created)
	}).Bind(apis.RequireAuth())

	// Delete a business schema (requires auth)
	se.Router.DELETE("/v1/schemas/{id}", func(e *core.RequestEvent) error {
		id := e.Request.PathValue("id")
		if err := schemaSvc.DeleteSchema(e.Request.Context(), id); err != nil {
			if errors.Is(err, schemas.ErrSchemaNotFound) {
				return e.JSON(http.StatusNotFound, map[string]string{
					"error":   "not_found",
					"message": fmt.Sprintf("schema %q not found", id),
				})
			}
			if errors.Is(err, schemas.ErrReservedSchemaID) {
				return e.JSON(http.StatusForbidden, map[string]string{
					"error":   "forbidden",
					"message": err.Error(),
				})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "failed_to_delete_schema",
				"message": err.Error(),
			})
		}

		return e.JSON(http.StatusOK, map[string]string{"status": "deleted"})
	}).Bind(apis.RequireAuth())

	// Payment checkout route (requires auth and payments feature flag)
	se.Router.POST("/v1/payments/checkout", func(e *core.RequestEvent) error {
		if !flags.Enabled("payments") {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "payments_disabled",
				"message": "Payments feature is not enabled for this tenant",
			})
		}

		var rawDoc any
		if err := e.BindBody(&rawDoc); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		if err := tenant.ValidateContractDocument("CheckoutRequest", rawDoc); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		encoded, err := json.Marshal(rawDoc)
		if err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		var input payments.CheckoutInput
		if err := json.Unmarshal(encoded, &input); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": err.Error(),
			})
		}

		if e.Auth != nil {
			input.UserID = e.Auth.Id
		}

		record, err := paySvc.CreateCheckout(e.Request.Context(), tenantID, input)
		if err != nil {
			if errors.Is(err, payments.ErrIdempotencyConflict) {
				return e.JSON(http.StatusConflict, map[string]string{
					"error":   "idempotency_conflict",
					"message": err.Error(),
				})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "checkout_failed",
				"message": err.Error(),
			})
		}

		return e.JSON(http.StatusOK, record)
	}).Bind(apis.RequireAuth())

	// Payment status inspection (requires auth and payment ownership/superuser)
	se.Router.GET("/v1/payments/{id}", func(e *core.RequestEvent) error {
		if !flags.Enabled("payments") {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "payments_disabled",
				"message": "Payments feature is not enabled for this tenant",
			})
		}

		paymentID := e.Request.PathValue("id")
		if paymentID == "" {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_id",
				"message": "Payment ID is required",
			})
		}

		record, err := paySvc.GetPayment(e.Request.Context(), paymentID)
		if err != nil || record == nil {
			return e.JSON(http.StatusNotFound, map[string]string{
				"error":   "payment_not_found",
				"message": "Payment record not found",
			})
		}

		if !e.HasSuperuserAuth() && e.Auth != nil && record.UserID != "" && record.UserID != e.Auth.Id {
			return e.JSON(http.StatusNotFound, map[string]string{
				"error":   "payment_not_found",
				"message": "Payment record not found",
			})
		}

		return e.JSON(http.StatusOK, record)
	}).Bind(apis.RequireAuth())

	// Payment webhook endpoint (provider HMAC signed raw body)
	se.Router.POST("/v1/webhooks/payments/{provider}", func(e *core.RequestEvent) error {
		if !flags.Enabled("payments") {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "payments_disabled",
				"message": "Payments feature is not enabled for this tenant",
			})
		}

		provider := e.Request.PathValue("provider")
		if provider == "" {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_provider",
				"message": "Provider name is required",
			})
		}

		rawBody, err := io.ReadAll(http.MaxBytesReader(e.Response, e.Request.Body, 65536))
		if err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "read_body_failed",
				"message": err.Error(),
			})
		}

		_, err = paySvc.HandleWebhook(e.Request.Context(), tenantID, provider, rawBody, e.Request.Header)
		if err != nil {
			if errors.Is(err, payments.ErrProviderNotFound) {
				return e.JSON(http.StatusNotFound, map[string]string{
					"error":   "unknown_provider",
					"message": err.Error(),
				})
			}
			if errors.Is(err, payments.ErrPaymentNotFound) {
				return e.JSON(http.StatusOK, map[string]string{"status": "ignored", "reason": "payment_not_found"})
			}
			if errors.Is(err, payments.ErrInvalidStatusTransition) {
				return e.JSON(http.StatusBadRequest, map[string]string{
					"error":   "invalid_transition",
					"message": err.Error(),
				})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "webhook_error",
				"message": err.Error(),
			})
		}

		return e.JSON(http.StatusOK, map[string]string{"status": "accepted"})
	})
}
