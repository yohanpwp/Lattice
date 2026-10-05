package features

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "features.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoad_OK(t *testing.T) {
	flags, err := Load(writeTemp(t, `{
		"features": {
			"payments": {"enabled": true, "options": {"default_provider": "omise"}},
			"inventory": {"enabled": false},
			"ai-search": {"enabled": true}
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}

	if !flags.Enabled("payments") || flags.Enabled("inventory") || flags.Enabled("missing") {
		t.Fatal("unexpected Enabled results")
	}
	if got := flags.Options("payments")["default_provider"]; got != "omise" {
		t.Fatalf("unexpected option: %v", got)
	}
	want := []string{"ai-search", "payments"}
	if got := flags.EnabledNames(); !reflect.DeepEqual(got, want) {
		t.Fatalf("EnabledNames = %v, want %v", got, want)
	}
}

func TestLoad_Rejects(t *testing.T) {
	cases := map[string]string{
		"unknown top-level field": `{"features": {}, "extra": 1}`,
		"unknown feature field":   `{"features": {"payments": {"enabled": true, "oops": 1}}}`,
		"bad feature name":        `{"features": {"Payments!": {"enabled": true}}}`,
		"secret option":           `{"features": {"payments": {"enabled": true, "options": {"omise_secret_key": "x"}}}}`,
		"nested secret option":    `{"features": {"payments": {"enabled": true, "options": {"a": {"api_key": "x"}}}}}`,
		"not json":                `nope`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(writeTemp(t, content)); err == nil {
				t.Fatal("expected error, got nil")
			}
		})
	}
}

func TestLoad_MissingFile(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "nope.json"))
	if err == nil || !strings.Contains(err.Error(), "read") {
		t.Fatalf("expected read error, got %v", err)
	}
}

func TestNilAndEmptyFlags(t *testing.T) {
	var nilFlags *Flags
	if nilFlags.Enabled("x") || nilFlags.Options("x") != nil || len(nilFlags.EnabledNames()) != 0 {
		t.Fatal("nil flags must behave as empty")
	}
	if len(Empty().EnabledNames()) != 0 {
		t.Fatal("empty flags must have nothing enabled")
	}
}
