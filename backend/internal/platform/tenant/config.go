// Package tenant loads the per-tenant configuration that the control plane
// provisions for this instance.
//
// IMPORTANT: Config is served publicly at GET /v1/config, so it must only
// contain fields that are safe to expose to clients. Never add secrets here.
package tenant

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
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

var (
	validatorsOnce sync.Once
	validators     map[string]*jsonschema.Schema
	validatorsErr  error
)

func contractValidators() (map[string]*jsonschema.Schema, error) {
	validatorsOnce.Do(func() {
		compiler := jsonschema.NewCompiler()
		compiler.AssertFormat()
		validators = make(map[string]*jsonschema.Schema, len(schemaDocuments))
		for name, source := range schemaDocuments {
			var document any
			if err := json.Unmarshal([]byte(source), &document); err != nil {
				validatorsErr = fmt.Errorf("decode embedded %s schema: %w", name, err)
				return
			}
			var metadata struct {
				ID string `json:"$id"`
			}
			if err := json.Unmarshal([]byte(source), &metadata); err != nil {
				validatorsErr = fmt.Errorf("read embedded %s schema id: %w", name, err)
				return
			}
			if err := compiler.AddResource(metadata.ID, document); err != nil {
				validatorsErr = fmt.Errorf("register embedded %s schema: %w", name, err)
				return
			}
			compiled, err := compiler.Compile(metadata.ID)
			if err != nil {
				validatorsErr = fmt.Errorf("compile embedded %s schema: %w", name, err)
				return
			}
			validators[name] = compiled
		}
	})
	return validators, validatorsErr
}

func validateContract(name string, value any) error {
	compiled, err := contractValidators()
	if err != nil {
		return err
	}
	validator, ok := compiled[name]
	if !ok {
		return fmt.Errorf("unknown contract schema %q", name)
	}
	if err := validator.Validate(value); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}

// ValidateContractDocument validates an arbitrary decoded JSON document with
// one of the schemas shared by the SDKs and backend.
func ValidateContractDocument(name string, value any) error {
	return validateContract(name, value)
}

// Load reads the tenant JSON, validates the original document against the
// shared schema (including required and unknown fields), then decodes Config.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := validateContract("AppConfig", document); err != nil {
		return nil, fmt.Errorf("invalid %s: %w", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid %s: %w", path, err)
	}
	return &cfg, nil
}

// Validate checks this Config with the same schema used by TypeScript clients.
func (c *Config) Validate() error {
	encoded, err := json.Marshal(c)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	var document any
	if err := json.Unmarshal(encoded, &document); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}
	if err := validateContract("AppConfig", document); err != nil {
		return err
	}
	for _, value := range []struct{ field, raw string }{{"backend_url", c.BackendURL}, {"realtime_url", c.RealtimeURL}} {
		if err := checkURL(value.raw); err != nil {
			return fmt.Errorf("%s: %w", value.field, err)
		}
	}
	return nil
}

func checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("must be an absolute http(s) URL")
	}
	return nil
}
