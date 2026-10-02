// Package tenant loads the per-tenant configuration that the control plane
// provisions for this instance.
//
// IMPORTANT: Config is served publicly at GET /v1/config, so it must only
// contain fields that are safe to expose to clients. Never add secrets here.
package tenant

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
)

// Config mirrors contracts/schemas/app-config.json.
type Config struct {
	Version          int      `json:"version"`
	TenantID         string   `json:"tenant_id"`
	BackendURL       string   `json:"backend_url"`
	RealtimeURL      string   `json:"realtime_url"`
	AppKey           string   `json:"app_key"`
	SchemaVersion    string   `json:"schema_version"`
	MinClientVersion string   `json:"min_client_version"`
	Features         []string `json:"features"`
	Collections      []string `json:"collections"`
}

// Load reads and validates the tenant config file at path.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid %s: %w", path, err)
	}

	// Always serialize arrays as [] instead of null.
	if cfg.Features == nil {
		cfg.Features = []string{}
	}
	if cfg.Collections == nil {
		cfg.Collections = []string{}
	}

	return &cfg, nil
}

// Validate checks required fields and URL shapes.
func (c *Config) Validate() error {
	if c.Version < 1 {
		return errors.New("version must be >= 1")
	}

	required := map[string]string{
		"tenant_id":      c.TenantID,
		"app_key":        c.AppKey,
		"schema_version": c.SchemaVersion,
	}
	for name, value := range required {
		if value == "" {
			return fmt.Errorf("%s is required", name)
		}
	}

	for name, value := range map[string]string{
		"backend_url":  c.BackendURL,
		"realtime_url": c.RealtimeURL,
	} {
		if err := checkURL(value); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}

	return nil
}

func checkURL(raw string) error {
	if raw == "" {
		return errors.New("is required")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("must be an absolute http(s) URL")
	}
	return nil
}
