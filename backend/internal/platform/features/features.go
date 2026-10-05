// Package features loads the per-tenant feature flags provisioned by the
// control plane. The shape mirrors contracts/schemas/features.json.
package features

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,48}$`)

// secretHints are substrings that must never appear in an option key.
// Options are served to authenticated clients, so they must not hold secrets.
var secretHints = []string{
	"secret", "password", "passwd", "token", "api_key", "apikey",
	"private_key", "credential",
}

// Feature is one feature flag with optional non-secret options.
type Feature struct {
	Enabled bool           `json:"enabled"`
	Options map[string]any `json:"options,omitempty"`
}

// Flags is the full set of flags for one tenant.
type Flags struct {
	Features map[string]Feature `json:"features"`
}

// Empty returns flags with nothing enabled.
func Empty() *Flags {
	return &Flags{Features: map[string]Feature{}}
}

// Load reads and validates the features file at path.
// Unknown fields are rejected, matching the contract (additionalProperties: false).
func Load(path string) (*Flags, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()

	var flags Flags
	if err := dec.Decode(&flags); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if flags.Features == nil {
		flags.Features = map[string]Feature{}
	}

	if err := flags.Validate(); err != nil {
		return nil, fmt.Errorf("invalid %s: %w", path, err)
	}
	return &flags, nil
}

// Validate checks feature names and rejects option keys that look like secrets.
func (f *Flags) Validate() error {
	var errs []error
	for name, feature := range f.Features {
		if !namePattern.MatchString(name) {
			errs = append(errs, fmt.Errorf("feature name %q is invalid", name))
		}
		if key, ok := findSecretKey(feature.Options); ok {
			errs = append(errs, fmt.Errorf("feature %q: option %q looks like a secret; secrets belong in the secret store", name, key))
		}
	}
	return errors.Join(errs...)
}

func findSecretKey(v any) (string, bool) {
	switch value := v.(type) {
	case map[string]any:
		for key, nested := range value {
			lower := strings.ToLower(key)
			for _, hint := range secretHints {
				if strings.Contains(lower, hint) {
					return key, true
				}
			}
			if found, ok := findSecretKey(nested); ok {
				return found, true
			}
		}
	case []any:
		for _, item := range value {
			if found, ok := findSecretKey(item); ok {
				return found, true
			}
		}
	}
	return "", false
}

// Enabled reports whether the named feature is switched on. Safe on a nil receiver.
func (f *Flags) Enabled(name string) bool {
	if f == nil {
		return false
	}
	return f.Features[name].Enabled
}

// Options returns the non-secret options of the named feature (may be nil).
func (f *Flags) Options(name string) map[string]any {
	if f == nil {
		return nil
	}
	return f.Features[name].Options
}

// EnabledNames returns the enabled feature names, sorted.
func (f *Flags) EnabledNames() []string {
	names := []string{}
	if f == nil {
		return names
	}
	for name, feature := range f.Features {
		if feature.Enabled {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}
