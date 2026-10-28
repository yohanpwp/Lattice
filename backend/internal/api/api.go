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

	"github.com/Lattice/backend/internal/platform/authz"
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
		hasOwner, _ := authz.HasOwner(e.App)
		res.HasOwner = &hasOwner
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

	// Create a new business schema (requires auth + owner/admin)
	se.Router.POST("/v1/schemas", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can create schemas",
			})
		}
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

	// Delete a business schema (requires auth + owner/admin)
	se.Router.DELETE("/v1/schemas/{id}", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can delete schemas",
			})
		}
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

	// Workspace one-time setup (requires operator token)
	se.Router.POST("/v1/workspace/setup", func(e *core.RequestEvent) error {
		var req struct {
			Token    string `json:"token"`
			Name     string `json:"name"`
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := e.BindBody(&req); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": err.Error()})
		}
		if req.Token == "" || req.Email == "" || len(req.Password) < 8 {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": "token, email, and password (min 8 chars) are required",
			})
		}

		owner, err := authz.CreateOwnerWithSetupToken(se.App, req.Token, req.Email, req.Name, req.Password)
		if err != nil {
			if errors.Is(err, authz.ErrSetupAlreadyCompleted) {
				return e.JSON(http.StatusConflict, map[string]string{
					"error":   "conflict",
					"message": "Workspace is already initialized with an owner",
				})
			}
			if errors.Is(err, authz.ErrInvalidSetupToken) {
				return e.JSON(http.StatusUnauthorized, map[string]string{
					"error":   "unauthorized",
					"message": "Invalid or expired setup token",
				})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "save_failed", "message": err.Error()})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"id":       owner.Id,
			"email":    owner.GetString("email"),
			"name":     owner.GetString("name"),
			"role":     owner.GetString("role"),
			"disabled": false,
		})
	})

	// List all workspace users (requires owner or admin)
	se.Router.GET("/v1/workspace/users", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can view team members",
			})
		}

		records, err := se.App.FindRecordsByFilter("users", "", "created", 200, 0)
		if err != nil {
			return e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal_error", "message": err.Error()})
		}

		var usersList []map[string]any
		for _, u := range records {
			usersList = append(usersList, map[string]any{
				"id":          u.Id,
				"email":       u.GetString("email"),
				"name":        u.GetString("name"),
				"role":        u.GetString("role"),
				"disabled":    u.GetBool("disabled"),
				"permissions": authz.GetUserPermissions(u),
				"created":     u.GetDateTime("created").String(),
				"updated":     u.GetDateTime("updated").String(),
			})
		}
		if usersList == nil {
			usersList = []map[string]any{}
		}

		return e.JSON(http.StatusOK, usersList)
	}).Bind(apis.RequireAuth())

	// Update user role, status, or permissions (requires owner or admin)
	se.Router.PATCH("/v1/workspace/users/{id}", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can update team members",
			})
		}

		targetID := e.Request.PathValue("id")
		target, err := se.App.FindRecordById("users", targetID)
		if err != nil || target == nil {
			return e.JSON(http.StatusNotFound, map[string]string{"error": "not_found", "message": "User not found"})
		}

		var body struct {
			Role        *string         `json:"role"`
			Disabled    *bool           `json:"disabled"`
			Permissions *map[string]any `json:"permissions"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": err.Error()})
		}

		// Admin authority limits: only owners can appoint or modify owners and admins
		if authz.IsAdmin(e.Auth) && !authz.IsOwner(e.Auth) && !e.HasSuperuserAuth() {
			if target.GetString("role") == authz.RoleOwner || target.GetString("role") == authz.RoleAdmin {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": "Admins cannot modify owner or admin accounts"})
			}
			if body.Role != nil && (*body.Role == authz.RoleOwner || *body.Role == authz.RoleAdmin) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": "Only workspace owners can appoint admins or owners"})
			}
		}

		// Last owner protection
		if target.GetString("role") == authz.RoleOwner {
			if (body.Role != nil && *body.Role != authz.RoleOwner) || (body.Disabled != nil && *body.Disabled) {
				if authz.IsLastOwner(se.App, target.Id) {
					return e.JSON(http.StatusForbidden, map[string]string{
						"error":   "forbidden",
						"message": "Cannot demote or disable the last active workspace owner",
					})
				}
			}
		}

		if body.Role != nil {
			target.Set("role", *body.Role)
		}
		if body.Disabled != nil {
			target.Set("disabled", *body.Disabled)
		}
		if body.Permissions != nil {
			target.Set("permissions", *body.Permissions)
		}

		if err := se.App.Save(target); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "update_failed", "message": err.Error()})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"id":          target.Id,
			"email":       target.GetString("email"),
			"name":        target.GetString("name"),
			"role":        target.GetString("role"),
			"disabled":    target.GetBool("disabled"),
			"permissions": authz.GetUserPermissions(target),
			"updated":     target.GetDateTime("updated").String(),
		})
	}).Bind(apis.RequireAuth())

	// List pending invitations (requires owner or admin)
	se.Router.GET("/v1/workspace/invitations", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can view invitations",
			})
		}

		filter := "revoked != true && accepted_at = ''"
		// If caller is an admin (not owner or superuser), restrict to member invitations
		if !authz.IsOwner(e.Auth) && !e.HasSuperuserAuth() {
			filter += " && role = 'member'"
		}

		records, err := se.App.FindRecordsByFilter("invitations", filter, "-created", 100, 0)
		if err != nil {
			return e.JSON(http.StatusInternalServerError, map[string]string{"error": "internal_error", "message": err.Error()})
		}

		var list []map[string]any
		for _, inv := range records {
			list = append(list, map[string]any{
				"id":          inv.Id,
				"email":       inv.GetString("email"),
				"role":        inv.GetString("role"),
				"expires_at":  inv.GetString("expires_at"),
				"revoked":     inv.GetBool("revoked"),
				"permissions": inv.Get("permissions"),
				"created":     inv.GetDateTime("created").String(),
			})
		}
		if list == nil {
			list = []map[string]any{}
		}
		return e.JSON(http.StatusOK, list)
	}).Bind(apis.RequireAuth())

	// Create an invitation (requires owner or admin)
	se.Router.POST("/v1/workspace/invitations", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners and admins can invite members",
			})
		}

		var req struct {
			Email       string         `json:"email"`
			Role        string         `json:"role"`
			Permissions map[string]any `json:"permissions"`
		}
		if err := e.BindBody(&req); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": err.Error()})
		}
		if req.Email == "" || (req.Role != authz.RoleAdmin && req.Role != authz.RoleMember) {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "invalid_request",
				"message": "valid email and role (admin or member) are required",
			})
		}

		if req.Role == authz.RoleAdmin && !authz.IsOwner(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{
				"error":   "forbidden",
				"message": "Only workspace owners can invite admins",
			})
		}

		inv, err := authz.CreateInvitation(se.App, e.Auth, req.Email, req.Role, req.Permissions)
		if err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invitation_failed", "message": err.Error()})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"id":          inv.Id,
			"email":       inv.GetString("email"),
			"role":        inv.GetString("role"),
			"token":       inv.GetString("token"),
			"expires_at":  inv.GetString("expires_at"),
			"revoked":     inv.GetBool("revoked"),
			"permissions": inv.Get("permissions"),
		})
	}).Bind(apis.RequireAuth())

	// Accept an invitation (public with token)
	se.Router.POST("/v1/workspace/invitations/accept", func(e *core.RequestEvent) error {
		var req struct {
			Token    string `json:"token"`
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if err := e.BindBody(&req); err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "invalid_request", "message": err.Error()})
		}

		user, err := authz.AcceptInvitation(se.App, req.Token, req.Name, req.Password)
		if err != nil {
			return e.JSON(http.StatusBadRequest, map[string]string{
				"error":   "acceptance_failed",
				"message": err.Error(),
			})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"id":          user.Id,
			"email":       user.GetString("email"),
			"name":        user.GetString("name"),
			"role":        user.GetString("role"),
			"disabled":    user.GetBool("disabled"),
			"permissions": authz.GetUserPermissions(user),
		})
	})

	// Revoke an invitation (requires owner or admin)
	se.Router.DELETE("/v1/workspace/invitations/{id}", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": "Only owners and admins can revoke invitations"})
		}

		id := e.Request.PathValue("id")
		inv, err := se.App.FindRecordById("invitations", id)
		if err != nil || inv == nil {
			return e.JSON(http.StatusNotFound, map[string]string{"error": "not_found", "message": "Invitation not found"})
		}

		// Only owners can revoke admin invitations
		if inv.GetString("role") == authz.RoleAdmin && !authz.IsOwner(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": "Only workspace owners can revoke admin invitations"})
		}

		inv.Set("revoked", true)
		if err := se.App.Save(inv); err != nil {
			return e.JSON(http.StatusInternalServerError, map[string]string{"error": "revoke_failed", "message": err.Error()})
		}

		return e.JSON(http.StatusOK, map[string]string{"status": "revoked"})
	}).Bind(apis.RequireAuth())

	// Reissue an invitation token (requires owner or admin)
	se.Router.POST("/v1/workspace/invitations/{id}/reissue", func(e *core.RequestEvent) error {
		if !authz.IsOwnerOrAdmin(e.Auth) && !e.HasSuperuserAuth() {
			return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": "Only workspace owners and admins can reissue invitations"})
		}

		id := e.Request.PathValue("id")
		newToken, inv, err := authz.ReissueInvitation(se.App, e.Auth, id)
		if err != nil {
			if errors.Is(err, authz.ErrAdminCannotEscalate) || errors.Is(err, authz.ErrPermissionDenied) {
				return e.JSON(http.StatusForbidden, map[string]string{"error": "forbidden", "message": err.Error()})
			}
			return e.JSON(http.StatusBadRequest, map[string]string{"error": "reissue_failed", "message": err.Error()})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"id":         inv.Id,
			"email":      inv.GetString("email"),
			"role":       inv.GetString("role"),
			"token":      newToken,
			"expires_at": inv.GetString("expires_at"),
		})
	}).Bind(apis.RequireAuth())

	// Get current user's effective permissions and role
	se.Router.GET("/v1/workspace/permissions", func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.JSON(http.StatusUnauthorized, map[string]string{"error": "unauthorized", "message": "Authentication required"})
		}

		return e.JSON(http.StatusOK, map[string]any{
			"user_id":     e.Auth.Id,
			"role":        e.Auth.GetString("role"),
			"permissions": authz.GetUserPermissions(e.Auth),
		})
	}).Bind(apis.RequireAuth())
}
