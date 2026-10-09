package payments

import (
	"context"
	_ "embed"
	"fmt"
	"sync"

	"github.com/pocketbase/pocketbase/core"

	"github.com/Lattice/backend/internal/platform/registry"
)

//go:embed manifest.json
var rawManifest []byte

type startupConfig struct {
	secret          string
	defaultProvider string
}

var (
	parsedManifest registry.Manifest
	serviceMu      sync.RWMutex
	globalService  *Service
	savedConfig    *startupConfig
)

func init() {
	var err error
	parsedManifest, err = registry.ParseManifest(rawManifest)
	if err != nil {
		panic(fmt.Sprintf("invalid payments plugin manifest: %v", err))
	}
	registry.MustRegister(&Plugin{})
}

type Plugin struct{}

var _ registry.Plugin = (*Plugin)(nil)

func (p *Plugin) Manifest() registry.Manifest {
	return parsedManifest
}

func (p *Plugin) Start(ctx context.Context, host registry.Host) error {
	secret := DefaultWebhookSecret
	if host.Secrets != nil {
		if val, err := host.Secrets.Get(ctx, "PAYMENT_MOCK_SECRET"); err == nil && val != "" {
			secret = val
		} else if val, err := host.Secrets.Get(ctx, "PAYMENTS_WEBHOOK_SECRET"); err == nil && val != "" {
			secret = val
		}
	}

	defaultProvider := MockProviderName
	if def, ok := host.Options["default_provider"].(string); ok && def != "" {
		defaultProvider = def
	}

	serviceMu.Lock()
	defer serviceMu.Unlock()

	savedConfig = &startupConfig{
		secret:          secret,
		defaultProvider: defaultProvider,
	}

	if globalService != nil {
		mockProvider := NewMockProvider(secret)
		globalService.RegisterProvider(mockProvider)
		globalService.SetDefaultProvider(defaultProvider)
	}
	return nil
}

// InitService sets up the payments service for the given PocketBase application.
func InitService(app core.App) *Service {
	serviceMu.Lock()
	defer serviceMu.Unlock()
	if globalService == nil || globalService.app != app {
		globalService = NewService(app)
		secret := DefaultWebhookSecret
		defaultProvider := MockProviderName
		if savedConfig != nil {
			if savedConfig.secret != "" {
				secret = savedConfig.secret
			}
			if savedConfig.defaultProvider != "" {
				defaultProvider = savedConfig.defaultProvider
			}
		}
		mockProvider := NewMockProvider(secret)
		globalService.RegisterProvider(mockProvider)
		globalService.SetDefaultProvider(defaultProvider)
	}
	return globalService
}

func GetService() *Service {
	serviceMu.RLock()
	defer serviceMu.RUnlock()
	return globalService
}

// ResetService is used in tests to clear the global service state and saved startup configuration.
func ResetService() {
	serviceMu.Lock()
	defer serviceMu.Unlock()
	globalService = nil
	savedConfig = nil
}

