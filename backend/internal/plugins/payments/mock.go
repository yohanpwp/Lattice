package payments

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

const (
	MockProviderName      = "mock"
	DefaultWebhookSecret  = "mock_webhook_secret_key"
	SignatureHeader       = "X-Signature"
)

var (
	ErrInvalidSignature = errors.New("invalid webhook signature")
	ErrMissingSignature = errors.New("missing webhook signature header")
)

// MockProvider implements PaymentProvider for testing and local development.
type MockProvider struct {
	secret string
}

var _ PaymentProvider = (*MockProvider)(nil)

func NewMockProvider(secret string) *MockProvider {
	if secret == "" {
		secret = DefaultWebhookSecret
	}
	return &MockProvider{secret: secret}
}

func (p *MockProvider) Name() string {
	return MockProviderName
}

func (p *MockProvider) CreateCharge(_ context.Context, req ChargeRequest) (*ChargeResult, error) {
	if req.Amount <= 0 {
		return nil, errors.New("charge amount must be positive")
	}
	if req.Currency == "" {
		return nil, errors.New("currency is required")
	}

	chargeID := fmt.Sprintf("mock_ch_%s", req.IdempotencyKey)
	return &ChargeResult{
		ProviderChargeID: chargeID,
		Status:           "pending",
		PaymentURL:       fmt.Sprintf("https://checkout.example.com/pay/%s", chargeID),
	}, nil
}

func (p *MockProvider) Sign(payload []byte) string {
	mac := hmac.New(sha256.New, []byte(p.secret))
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func (p *MockProvider) VerifyWebhook(_ context.Context, rawBody []byte, headers http.Header) (*WebhookEvent, error) {
	sig := headers.Get(SignatureHeader)
	if sig == "" {
		sig = headers.Get("X-Mock-Signature")
	}
	if sig == "" {
		return nil, ErrMissingSignature
	}

	expectedSig := p.Sign(rawBody)
	if !hmac.Equal([]byte(sig), []byte(expectedSig)) {
		return nil, ErrInvalidSignature
	}

	var payload struct {
		ProviderChargeID string         `json:"provider_charge_id"`
		OrderID          string         `json:"order_id"`
		Status           string         `json:"status"`
		Amount           int64          `json:"amount"`
		Currency         string         `json:"currency"`
		EventType        string         `json:"event_type"`
		RawData          map[string]any `json:"raw_data"`
	}
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, fmt.Errorf("decode webhook payload: %w", err)
	}

	if payload.Status == "" {
		payload.Status = "succeeded"
	}
	if payload.EventType == "" {
		payload.EventType = "payment.succeeded"
	}

	return &WebhookEvent{
		ProviderChargeID: payload.ProviderChargeID,
		OrderID:          payload.OrderID,
		Status:           payload.Status,
		Amount:           payload.Amount,
		Currency:         payload.Currency,
		EventType:        payload.EventType,
		RawData:          payload.RawData,
	}, nil
}

func (p *MockProvider) Refund(_ context.Context, req RefundRequest) (*RefundResult, error) {
	if req.Amount <= 0 {
		return nil, errors.New("refund amount must be positive")
	}

	refundID := fmt.Sprintf("mock_ref_%s", req.IdempotencyKey)
	return &RefundResult{
		RefundID:         refundID,
		ProviderChargeID: req.ProviderChargeID,
		AmountRefunded:   req.Amount,
		Status:           "succeeded",
	}, nil
}
