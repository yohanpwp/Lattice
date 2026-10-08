package registry

import (
	"context"
	"os"
	"path/filepath"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/secrets"
)

func TestParseManifestUsesSharedContractFixtures(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "fixtures", "contracts")
	valid, err := os.ReadFile(filepath.Join(root, "valid", "plugin-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := ParseManifest(valid)
	if err != nil || manifest.Name != "orders" {
		t.Fatalf("valid shared fixture rejected: manifest=%+v err=%v", manifest, err)
	}

	invalid, err := os.ReadFile(filepath.Join(root, "invalid", "plugin-manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseManifest(invalid); err == nil {
		t.Fatal("invalid shared fixture was accepted")
	}
}

func TestParseManifestRejectsMissingUnknownAndTrailingJSON(t *testing.T) {
	for name, source := range map[string]string{
		"missing required field": `{"name":"inventory","version":"1.0.0","interface_version":1}`,
		"unknown field": `{"name":"inventory","version":"1.0.0","interface_version":1,"license":"MIT","extra":true}`,
		"trailing document": `{"name":"inventory","version":"1.0.0","interface_version":1,"license":"MIT"} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseManifest([]byte(source)); err == nil {
				t.Fatal("expected invalid manifest to be rejected")
			}
		})
	}
}

type fakeFlags map[string]map[string]any // name -> options; presence means enabled

func (f fakeFlags) Enabled(name string) bool           { _, ok := f[name]; return ok }
func (f fakeFlags) Options(name string) map[string]any { return f[name] }

type fakeBus struct{}

func (fakeBus) Emit(context.Context, string, int, map[string]any) error { return nil }
func (fakeBus) Subscribe(string, outbox.Handler)                        {}

type fakePlugin struct {
	manifest Manifest
	started  *[]string
	failWith error
	gotOpts  map[string]any
	gotSecrets secrets.Store
}

func (p *fakePlugin) Manifest() Manifest { return p.manifest }
func (p *fakePlugin) Start(_ context.Context, host Host) error {
	if p.failWith != nil {
		return p.failWith
	}
	p.gotOpts = host.Options
	p.gotSecrets = host.Secrets
	*p.started = append(*p.started, p.manifest.Name)
	return nil
}

func plugin(started *[]string, name string, requires ...string) *fakePlugin {
	return &fakePlugin{
		manifest: Manifest{Name: name, Version: "0.1.0", InterfaceVersion: 1, License: "Proprietary", Requires: requires},
		started:  started,
	}
}

func TestManifestValidate(t *testing.T) {
	good := Manifest{
		Name: "payments", Version: "0.1.0", InterfaceVersion: 1, License: "Proprietary",
		Requires: []string{"outbox"}, Permissions: []string{"collections:payment_ledger", "events:emit"},
	}
	if err := good.Validate(); err != nil {
		t.Fatalf("expected valid manifest: %v", err)
	}

	cases := map[string]func(*Manifest){
		"bad name":          func(m *Manifest) { m.Name = "Payments!" },
		"short name":        func(m *Manifest) { m.Name = "p" },
		"bad version":       func(m *Manifest) { m.Version = "1.0" },
		"zero interface":    func(m *Manifest) { m.InterfaceVersion = 0 },
		"no license":        func(m *Manifest) { m.License = "" },
		"self require":      func(m *Manifest) { m.Requires = []string{"payments"} },
		"duplicate require": func(m *Manifest) { m.Requires = []string{"outbox", "outbox"} },
		"bad permission":    func(m *Manifest) { m.Permissions = []string{"DROP TABLE"} },
		"dup permission":    func(m *Manifest) { m.Permissions = []string{"events:emit", "events:emit"} },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			m := good
			m.Requires = append([]string(nil), good.Requires...)
			m.Permissions = append([]string(nil), good.Permissions...)
			mutate(&m)
			if err := m.Validate(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestRegister_RejectsInvalidAndDuplicate(t *testing.T) {
	var started []string
	r := New("outbox")

	bad := plugin(&started, "Bad Name")
	if err := r.Register(bad); err == nil {
		t.Fatal("invalid manifest must be rejected")
	}

	if err := r.Register(plugin(&started, "payments")); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(plugin(&started, "payments")); err == nil {
		t.Fatal("duplicate name must be rejected")
	}
}

func TestActivate_StartsOnlyEnabledInDependencyOrder(t *testing.T) {
	var started []string
	r := New("outbox")
	_ = r.Register(plugin(&started, "shipping", "payments"))
	_ = r.Register(plugin(&started, "payments", "outbox"))
	_ = r.Register(plugin(&started, "inventory")) // not enabled

	flags := fakeFlags{"shipping": nil, "payments": {"default_provider": "omise"}}
	report, err := r.Activate(context.Background(), flags, fakeBus{})
	if err != nil {
		t.Fatal(err)
	}

	if want := []string{"payments", "shipping"}; !reflect.DeepEqual(report.Started, want) || !reflect.DeepEqual(started, want) {
		t.Fatalf("start order = %v / %v, want %v", report.Started, started, want)
	}
	if want := []string{"inventory"}; !reflect.DeepEqual(report.Skipped, want) {
		t.Fatalf("skipped = %v, want %v", report.Skipped, want)
	}
}

func TestActivate_PassesOptions(t *testing.T) {
	var started []string
	p := plugin(&started, "payments")
	r := New("outbox")
	_ = r.Register(p)

	if _, err := r.Activate(context.Background(), fakeFlags{"payments": {"default_provider": "omise"}}, fakeBus{}); err != nil {
		t.Fatal(err)
	}
	if p.gotOpts["default_provider"] != "omise" {
		t.Fatalf("options not passed: %v", p.gotOpts)
	}
}

func TestActivateWithSecretsInjectsPrivateStoreWithoutEagerReads(t *testing.T) {
	var started []string
	p := plugin(&started, "payments")
	r := New("outbox")
	if err := r.Register(p); err != nil {
		t.Fatal(err)
	}
	lookups := 0
	store := secrets.EnvStore{LookupEnv: func(key string) (string, bool) {
		lookups++
		if key == "LATTICE_SECRET_PAYMENT_API_KEY" {
			return "private-value", true
		}
		return "", false
	}}
	if _, err := r.ActivateWithSecrets(context.Background(), fakeFlags{"payments": nil}, fakeBus{}, store); err != nil {
		t.Fatal(err)
	}
	if lookups != 0 {
		t.Fatalf("activation eagerly loaded secret values: %d lookups", lookups)
	}
	if p.gotSecrets == nil {
		t.Fatal("plugin host did not receive configured secret store")
	}
	value, err := p.gotSecrets.Get(context.Background(), "PAYMENT_API_KEY")
	if err != nil || value != "private-value" || lookups != 1 {
		t.Fatalf("private lookup = %q, %v (lookups=%d)", value, err, lookups)
	}
}

func TestActivate_Failures(t *testing.T) {
	t.Run("missing requirement", func(t *testing.T) {
		var started []string
		r := New("outbox")
		_ = r.Register(plugin(&started, "shipping", "payments"))
		_, err := r.Activate(context.Background(), fakeFlags{"shipping": nil}, fakeBus{})
		if err == nil || !strings.Contains(err.Error(), "requires") {
			t.Fatalf("expected requirement error, got %v", err)
		}
		if len(started) != 0 {
			t.Fatal("nothing may start when validation fails")
		}
	})

	t.Run("requirement present but disabled", func(t *testing.T) {
		var started []string
		r := New("outbox")
		_ = r.Register(plugin(&started, "shipping", "payments"))
		_ = r.Register(plugin(&started, "payments"))
		if _, err := r.Activate(context.Background(), fakeFlags{"shipping": nil}, fakeBus{}); err == nil {
			t.Fatal("a disabled dependency must count as missing")
		}
	})

	t.Run("wrong interface version", func(t *testing.T) {
		var started []string
		p := plugin(&started, "payments")
		p.manifest.InterfaceVersion = 2
		r := New("outbox")
		_ = r.Register(p)
		if _, err := r.Activate(context.Background(), fakeFlags{"payments": nil}, fakeBus{}); err == nil {
			t.Fatal("unsupported interface version must be refused")
		}
	})

	t.Run("cycle", func(t *testing.T) {
		var started []string
		r := New("outbox")
		_ = r.Register(plugin(&started, "aaa-plugin", "bbb-plugin"))
		_ = r.Register(plugin(&started, "bbb-plugin", "aaa-plugin"))
		_, err := r.Activate(context.Background(), fakeFlags{"aaa-plugin": nil, "bbb-plugin": nil}, fakeBus{})
		if err == nil || !strings.Contains(err.Error(), "cycle") {
			t.Fatalf("expected cycle error, got %v", err)
		}
	})

	t.Run("start error aborts", func(t *testing.T) {
		var started []string
		boom := plugin(&started, "payments")
		boom.failWith = errors.New("boom")
		r := New("outbox")
		_ = r.Register(boom)
		_, err := r.Activate(context.Background(), fakeFlags{"payments": nil}, fakeBus{})
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("expected start error, got %v", err)
		}
	})
}

func TestActivate_NilFlagsStartsNothing(t *testing.T) {
	var started []string
	r := New("outbox")
	_ = r.Register(plugin(&started, "payments"))
	report, err := r.Activate(context.Background(), nil, fakeBus{})
	if err != nil || len(report.Started) != 0 || len(report.Skipped) != 1 {
		t.Fatalf("unexpected: %+v %v", report, err)
	}
}

func TestManifests_Sorted(t *testing.T) {
	var started []string
	r := New("outbox")
	_ = r.Register(plugin(&started, "zeta-plugin"))
	_ = r.Register(plugin(&started, "alpha-plugin"))
	got := r.Manifests()
	if len(got) != 2 || got[0].Name != "alpha-plugin" {
		t.Fatalf("manifests not sorted: %+v", got)
	}
}
