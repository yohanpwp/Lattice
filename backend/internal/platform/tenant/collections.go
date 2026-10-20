package tenant

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
)

// PlatformCollections contains internal system and infrastructure collections
// reserved by Lattice. These are excluded from the public business collections
// exposed to client applications.
var PlatformCollections = map[string]bool{
	"outbox":             true,
	"payment_ledger":     true,
	"dashboards":         true,
	"schema_definitions": true,
	"app_pages":          true,
}

// DiscoveredCollections returns all business collections in the PocketBase
// application, omitting internal system collections (System == true or starting with '_')
// and platform infrastructure collections. Explicit collections from the tenant
// configuration are included first.
func DiscoveredCollections(app core.App, explicit []string) []string {
	cleanExplicit := func() []string {
		if explicit == nil {
			return []string{}
		}
		var res []string
		seen := make(map[string]bool)
		for _, name := range explicit {
			name = strings.TrimSpace(name)
			if name != "" && !seen[name] {
				seen[name] = true
				res = append(res, name)
			}
		}
		if res == nil {
			return []string{}
		}
		return res
	}

	if app == nil || !app.IsBootstrapped() || app.DB() == nil {
		return cleanExplicit()
	}

	var all []*core.Collection
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				all = nil
				err = nil
			}
		}()
		all, err = app.FindAllCollections()
	}()

	if err != nil || all == nil {
		return cleanExplicit()
	}

	seen := make(map[string]bool)
	var result []string

	// 1. Preserve any explicitly configured collections first
	for _, name := range explicit {
		name = strings.TrimSpace(name)
		if name != "" && !seen[name] {
			seen[name] = true
			result = append(result, name)
		}
	}

	// 2. Discover business collections from PocketBase
	for _, col := range all {
		if col == nil || col.System || strings.HasPrefix(col.Name, "_") {
			continue
		}
		if PlatformCollections[col.Name] {
			continue
		}
		if !seen[col.Name] {
			seen[col.Name] = true
			result = append(result, col.Name)
		}
	}

	if result == nil {
		return []string{}
	}
	return result
}
