package tenant

import "testing"

func validConfig() Config {
	return Config{
		Version:       1,
		TenantID:      "tenant_abc123",
		BackendURL:    "https://acme.app.example.com",
		RealtimeURL:   "https://acme.app.example.com/api/realtime",
		AppKey:        "pk_live_abc123",
		SchemaVersion: "20260101_01",
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
		"bad version":     func(c *Config) { c.Version = 0 },
		"missing tenant":  func(c *Config) { c.TenantID = "" },
		"missing app key": func(c *Config) { c.AppKey = "" },
		"missing schema":  func(c *Config) { c.SchemaVersion = "" },
		"relative url":    func(c *Config) { c.BackendURL = "/api" },
		"ftp url":         func(c *Config) { c.RealtimeURL = "ftp://example.com" },
		"empty backend":   func(c *Config) { c.BackendURL = "" },
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
