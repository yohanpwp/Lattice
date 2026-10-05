package tenant

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validConfig() Config {
	return Config{
		Version:          1,
		TenantID:         "tenant_abc123",
		BackendURL:       "https://acme.app.example.com",
		RealtimeURL:      "https://acme.app.example.com/api/realtime",
		AppKey:           "pk_live_abc123",
		SchemaVersion:    "20260101_01",
		MinClientVersion: "0.1.0",
		Features:         []string{},
		Collections:      []string{},
	}
}

func TestValidate_OK(t *testing.T) {
	cfg := validConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid config, got: %v", err)
	}
}

func TestValidate_Failures(t *testing.T) {
	cases := map[string]func(*Config){
		"bad version":       func(c *Config) { c.Version = 0 },
		"missing tenant":    func(c *Config) { c.TenantID = "" },
		"missing app key":   func(c *Config) { c.AppKey = "" },
		"missing schema":    func(c *Config) { c.SchemaVersion = "" },
		"relative url":      func(c *Config) { c.BackendURL = "/api" },
		"ftp url":           func(c *Config) { c.RealtimeURL = "ftp://example.com" },
		"empty backend":     func(c *Config) { c.BackendURL = "" },
		"bad min version":   func(c *Config) { c.MinClientVersion = "1.0" },
		"duplicate feature": func(c *Config) { c.Features = []string{"orders", "orders"} },
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := validConfig()
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("expected validation error, got nil")
			}
		})
	}
}

func TestSharedContractFixtures(t *testing.T) {
	for _, name := range []string{"app-config", "features", "dashboard-layout", "plugin-manifest", "event-envelope"} {
		t.Run(name, func(t *testing.T) {
			for _, kind := range []string{"valid", "invalid"} {
				fixtureDir := filepath.Join("../../../../fixtures/contracts", kind)
				entries, err := os.ReadDir(fixtureDir)
				if err != nil {
					t.Fatal(err)
				}
				for _, entry := range entries {
					if entry.IsDir() || (entry.Name() != name+".json" && !strings.HasPrefix(entry.Name(), name+"-")) {
						continue
					}
					t.Run(kind+"/"+entry.Name(), func(t *testing.T) {
						data, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
						if err != nil {
							t.Fatal(err)
						}
						var value any
						if err := json.Unmarshal(data, &value); err != nil {
							t.Fatal(err)
						}
						err = validateContract(map[string]string{
							"app-config": "AppConfig", "features": "Features", "dashboard-layout": "DashboardLayout",
							"plugin-manifest": "PluginManifest", "event-envelope": "EventEnvelope",
						}[name], value)
						if kind == "valid" && err != nil {
							t.Fatalf("valid fixture rejected: %v", err)
						}
						if kind == "invalid" && err == nil {
							t.Fatal("invalid fixture accepted")
						}
					})
				}
			}
		})
	}
}

func TestLoadRejectsMissingAndUnknownFields(t *testing.T) {
	valid, err := json.Marshal(validConfig())
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(valid, &object); err != nil {
		t.Fatal(err)
	}

	for name, mutate := range map[string]func(map[string]any){
		"missing required array": func(value map[string]any) { delete(value, "features") },
		"unknown field":          func(value map[string]any) { value["secret"] = "no" },
	} {
		t.Run(name, func(t *testing.T) {
			copy := map[string]any{}
			for key, value := range object {
				copy[key] = value
			}
			mutate(copy)
			data, err := json.Marshal(copy)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "tenant.json")
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("expected schema validation error")
			}
		})
	}
}
