// Package registry holds the plugins compiled into the binary and starts the
// ones a tenant has enabled.
//
// Plugins register themselves from init() (MustRegister). Nothing starts until
// Activate is called with the tenant's feature flags, so a plugin that is
// compiled in but not enabled costs nothing at runtime.
//
// This package has no PocketBase dependency. Plugins currently receive an
// event bus and their options; access to routes and collections is added to
// Host when the first plugin (payments, M4) needs it.
package registry

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/Lattice/backend/internal/platform/outbox"
	"github.com/Lattice/backend/internal/platform/secrets"
)

// EventBus is what plugins use to talk to each other without direct calls.
type EventBus interface {
	Emit(ctx context.Context, eventType string, version int, data map[string]any) error
	Subscribe(eventType string, h outbox.Handler)
}

// Host is handed to a plugin when it starts.
type Host struct {
	Events EventBus
	Secrets secrets.Store
	// Options are the plugin's non-secret options from the tenant's feature flags.
	Options map[string]any
}

// Plugin is implemented by every plugin.
type Plugin interface {
	Manifest() Manifest
	// Start is called once, after dependencies have started. Return an error to
	// abort platform startup.
	Start(ctx context.Context, host Host) error
}

// FlagReader is satisfied by *features.Flags.
type FlagReader interface {
	Enabled(name string) bool
	Options(name string) map[string]any
}

// Report says what Activate did.
type Report struct {
	Started []string // in start order
	Skipped []string // registered but not enabled, sorted
}

// Registry stores registered plugins.
type Registry struct {
	mu           sync.Mutex
	capabilities map[string]bool
	plugins      map[string]Plugin
}

// New creates a registry. capabilities are the platform services a plugin may
// list in its manifest "requires" (for example "outbox").
func New(capabilities ...string) *Registry {
	caps := make(map[string]bool, len(capabilities))
	for _, c := range capabilities {
		caps[c] = true
	}
	return &Registry{capabilities: caps, plugins: map[string]Plugin{}}
}

// Default is the registry plugins register into from init().
var Default = New("outbox")

// Register validates and stores a plugin.
func (r *Registry) Register(p Plugin) error {
	m := p.Manifest()
	if err := m.Validate(); err != nil {
		return fmt.Errorf("plugin %q: invalid manifest: %w", m.Name, err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.plugins[m.Name]; exists {
		return fmt.Errorf("plugin %q is already registered", m.Name)
	}
	r.plugins[m.Name] = p
	return nil
}

// MustRegister registers into Default and panics on error, so a broken plugin
// fails at startup instead of at runtime. Call it from the plugin's init().
func MustRegister(p Plugin) {
	if err := Default.Register(p); err != nil {
		panic(err)
	}
}

// Manifests returns every registered manifest, sorted by name.
func (r *Registry) Manifests() []Manifest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Manifest, 0, len(r.plugins))
	for _, p := range r.plugins {
		out = append(out, p.Manifest())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Activate starts the plugins that flags enable, in dependency order.
// It fails before starting anything if an enabled plugin targets another
// interface version, requires something that is unavailable, or has a cycle.
func (r *Registry) Activate(ctx context.Context, flags FlagReader, bus EventBus) (Report, error) {
	return r.ActivateWithSecrets(ctx, flags, bus, secrets.EmptyStore{})
}

// ActivateWithSecrets activates enabled plugins with the configured private
// secret provider. The provider is exposed only to plugin startup code.
func (r *Registry) ActivateWithSecrets(ctx context.Context, flags FlagReader, bus EventBus, secretStore secrets.Store) (Report, error) {
	if secretStore == nil {
		secretStore = secrets.EmptyStore{}
	}
	r.mu.Lock()
	enabled := map[string]Plugin{}
	var skipped []string
	for name, p := range r.plugins {
		if flags != nil && flags.Enabled(name) {
			enabled[name] = p
		} else {
			skipped = append(skipped, name)
		}
	}
	r.mu.Unlock()
	sort.Strings(skipped)

	for _, name := range sortedKeys(enabled) {
		m := enabled[name].Manifest()
		if m.InterfaceVersion != SupportedInterfaceVersion {
			return Report{}, fmt.Errorf("plugin %q targets interface version %d, platform supports %d", name, m.InterfaceVersion, SupportedInterfaceVersion)
		}
		for _, req := range m.Requires {
			if !r.capabilities[req] && enabled[req] == nil {
				return Report{}, fmt.Errorf("plugin %q requires %q, which is neither a platform capability nor an enabled plugin", name, req)
			}
		}
	}

	order, err := startOrder(enabled, r.capabilities)
	if err != nil {
		return Report{}, err
	}

	report := Report{Skipped: skipped}
	for _, name := range order {
		host := Host{Events: bus, Secrets: secretStore}
		if flags != nil {
			host.Options = flags.Options(name)
		}
		if err := enabled[name].Start(ctx, host); err != nil {
			return report, fmt.Errorf("start plugin %q: %w", name, err)
		}
		report.Started = append(report.Started, name)
	}
	return report, nil
}

// startOrder sorts plugins so every plugin starts after the plugins it requires.
// Ties are broken alphabetically so startup is deterministic.
func startOrder(enabled map[string]Plugin, capabilities map[string]bool) ([]string, error) {
	const (
		visiting = 1
		done     = 2
	)
	state := map[string]int{}
	var order []string

	var visit func(name string, path []string) error
	visit = func(name string, path []string) error {
		switch state[name] {
		case done:
			return nil
		case visiting:
			return fmt.Errorf("plugin dependency cycle: %v -> %s", path, name)
		}
		state[name] = visiting
		for _, req := range enabled[name].Manifest().Requires {
			if capabilities[req] {
				continue
			}
			if err := visit(req, append(path, name)); err != nil {
				return err
			}
		}
		state[name] = done
		order = append(order, name)
		return nil
	}

	for _, name := range sortedKeys(enabled) {
		if err := visit(name, nil); err != nil {
			return nil, err
		}
	}
	return order, nil
}

func sortedKeys(m map[string]Plugin) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
