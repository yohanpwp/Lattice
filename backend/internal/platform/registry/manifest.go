package registry

import (
	"errors"
	"fmt"
	"regexp"
)

// SupportedInterfaceVersion is the plugin interface version this platform
// implements. A plugin built for another version is refused at startup.
const SupportedInterfaceVersion = 1

var (
	namePattern       = regexp.MustCompile(`^[a-z][a-z0-9-]{1,48}$`)
	semverPattern     = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	permissionPattern = regexp.MustCompile(`^[a-z_]+:[a-z0-9_*]+$`)
)

// Manifest mirrors contracts/schemas/plugin-manifest.json.
type Manifest struct {
	Name             string   `json:"name"`
	Version          string   `json:"version"`
	InterfaceVersion int      `json:"interface_version"`
	License          string   `json:"license"`
	Requires         []string `json:"requires,omitempty"`
	Permissions      []string `json:"permissions,omitempty"`
}

// Validate checks the manifest against the contract.
func (m Manifest) Validate() error {
	var errs []error

	if !namePattern.MatchString(m.Name) {
		errs = append(errs, fmt.Errorf("name %q must match %s", m.Name, namePattern))
	}
	if !semverPattern.MatchString(m.Version) {
		errs = append(errs, fmt.Errorf("version %q must be MAJOR.MINOR.PATCH", m.Version))
	}
	if m.InterfaceVersion < 1 {
		errs = append(errs, errors.New("interface_version must be >= 1"))
	}
	if m.License == "" {
		errs = append(errs, errors.New("license is required"))
	}

	seen := map[string]bool{}
	for _, r := range m.Requires {
		switch {
		case r == "":
			errs = append(errs, errors.New("requires contains an empty entry"))
		case r == m.Name:
			errs = append(errs, errors.New("a plugin cannot require itself"))
		case seen[r]:
			errs = append(errs, fmt.Errorf("requires lists %q twice", r))
		}
		seen[r] = true
	}

	seen = map[string]bool{}
	for _, p := range m.Permissions {
		if !permissionPattern.MatchString(p) {
			errs = append(errs, fmt.Errorf("permission %q must match %s", p, permissionPattern))
		}
		if seen[p] {
			errs = append(errs, fmt.Errorf("permissions lists %q twice", p))
		}
		seen[p] = true
	}

	return errors.Join(errs...)
}
