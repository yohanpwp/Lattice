package migrations

import (
	"fmt"
	"strings"

	"github.com/ganigeorgiev/fexpr"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"

	"github.com/Lattice/backend/internal/platform/tenant"
)

func stripRedundantOuterParens(s string) string {
	s = strings.TrimSpace(s)
	for strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		depth := 0
		matchesEnd := true
		for i := 0; i < len(s)-1; i++ {
			if s[i] == '(' {
				depth++
			} else if s[i] == ')' {
				depth--
				if depth == 0 {
					matchesEnd = false
					break
				}
			}
		}
		if matchesEnd && depth == 1 {
			s = strings.TrimSpace(s[1 : len(s)-1])
		} else {
			break
		}
	}
	return s
}

// ruleEnforcesLatticePolicy structurally verifies whether an existing collection rule
// enforces the required Lattice read policy as a mandatory top-level conjunct.
// A rule that merely references permissions as an alternative (e.g. `public = true || permissions...`),
// contains a top-level OR branch (e.g. `(required_policy) && status = 'active' || public = true`),
// or targets another dataset will return false and must be conjoined.
func ruleEnforcesLatticePolicy(existingRule, requiredRule string) bool {
	cleanExisting := stripRedundantOuterParens(existingRule)
	cleanRequired := stripRedundantOuterParens(requiredRule)
	if cleanExisting == "" || cleanRequired == "" {
		return false
	}
	if cleanExisting == cleanRequired {
		return true
	}

	// 1. AST check via fexpr: If any top-level group is joined by OR ("||"),
	// the rule contains a permissive alternate branch and cannot guarantee mandatory Lattice gating.
	if groups, err := fexpr.Parse(cleanExisting); err == nil {
		for _, g := range groups {
			if g.Join == fexpr.JoinOr {
				return false
			}
		}
	}

	// 2. Character scanner: Check for top-level '||' outside quotes and split top-level '&&' conjuncts
	depth := 0
	inQuote := false
	var quoteChar byte
	start := 0
	hasTopLevelOr := false
	var conjuncts []string

	for i := 0; i < len(cleanExisting); i++ {
		ch := cleanExisting[i]
		if inQuote {
			if ch == quoteChar {
				if i > 0 && cleanExisting[i-1] == '\\' {
					// escaped quote
				} else {
					inQuote = false
				}
			}
			continue
		}

		if ch == '\'' || ch == '"' {
			inQuote = true
			quoteChar = ch
			continue
		}

		if ch == '(' {
			depth++
		} else if ch == ')' {
			if depth > 0 {
				depth--
			}
		} else if depth == 0 {
			if ch == '|' && i+1 < len(cleanExisting) && cleanExisting[i+1] == '|' {
				hasTopLevelOr = true
				break
			}
			if ch == '&' && i+1 < len(cleanExisting) && cleanExisting[i+1] == '&' {
				conjuncts = append(conjuncts, cleanExisting[start:i])
				start = i + 2
				i++ // skip second &
			}
		}
	}

	if hasTopLevelOr {
		return false
	}

	if start < len(cleanExisting) {
		conjuncts = append(conjuncts, cleanExisting[start:])
	}

	for _, conjunct := range conjuncts {
		cleanConjunct := stripRedundantOuterParens(conjunct)
		if cleanConjunct == cleanRequired {
			return true
		}
	}

	return false
}

func init() {
	core.AppMigrations.Register(func(app core.App) error {
		cols, err := app.FindAllCollections()
		if err != nil || cols == nil {
			return err
		}

		for _, col := range cols {
			if col == nil || col.System || strings.HasPrefix(col.Name, "_") {
				continue
			}
			if tenant.PlatformCollections[col.Name] {
				continue
			}

			changed := false
			hasFileField := false
			for _, f := range col.Fields {
				if ff, ok := f.(*core.FileField); ok {
					hasFileField = true
					if !ff.Protected {
						ff.Protected = true
						changed = true
					}
				}
			}

			// If the collection contains file fields, ensure its ViewRule and ListRule
			// enforce Lattice dataset read permissions and assigned-record scope while
			// strictly preserving locked (nil) operations and custom restrictive constraints.
			if hasFileField {
				assigneeField := ""
				schemaRec, err := app.FindFirstRecordByFilter("schema_definitions", "schema_id = {:id}", map[string]any{"id": col.Name})
				if err == nil && schemaRec != nil {
					assigneeField = schemaRec.GetString("assignee_field")
				}

				var readRule string
				if assigneeField != "" {
					readRule = fmt.Sprintf(
						"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.read = true && (@request.auth.permissions.%s.scope = 'all' || %s = @request.auth.id)))",
						col.Name, col.Name, assigneeField,
					)
				} else {
					readRule = fmt.Sprintf(
						"@request.auth.disabled != true && (@request.auth.role = 'owner' || @request.auth.role = 'admin' || (@request.auth.role = 'member' && @request.auth.permissions.%s.read = true))",
						col.Name,
					)
				}

				// Reconcile ViewRule:
				// - If ViewRule is nil, it is locked to superusers; preserve nil to avoid broadening access.
				// - If ViewRule is "" (public), replace with Lattice readRule.
				// - If ViewRule is non-empty and does not structurally enforce readRule, combine existing rule with readRule.
				if col.ViewRule != nil {
					if *col.ViewRule == "" {
						col.ViewRule = types.Pointer(readRule)
						changed = true
					} else if !ruleEnforcesLatticePolicy(*col.ViewRule, readRule) {
						combined := fmt.Sprintf("(%s) && (%s)", *col.ViewRule, readRule)
						col.ViewRule = types.Pointer(combined)
						changed = true
					}
				}

				// Reconcile ListRule:
				// - If ListRule is nil, it is locked to superusers; preserve nil to avoid broadening access.
				// - If ListRule is "" (public), replace with Lattice readRule.
				// - If ListRule is non-empty and does not structurally enforce readRule, combine existing rule with readRule.
				if col.ListRule != nil {
					if *col.ListRule == "" {
						col.ListRule = types.Pointer(readRule)
						changed = true
					} else if !ruleEnforcesLatticePolicy(*col.ListRule, readRule) {
						combined := fmt.Sprintf("(%s) && (%s)", *col.ListRule, readRule)
						col.ListRule = types.Pointer(combined)
						changed = true
					}
				}
			}

			if changed {
				if err := app.Save(col); err != nil {
					return err
				}
			}
		}

		// Ensure dashboards collection has revision field and unique name index.
		// IMPORTANT: deduplicate by name first so that the subsequent unique index
		// creation cannot fail on databases that contain legacy duplicate-named records
		// (the previous index was non-unique).  For each group of duplicates, the record
		// with the highest revision (or most-recently created when revisions are equal)
		// is designated authoritative; every other duplicate is renamed to
		// "<name>_dup_<id>" so no layout is silently discarded.
		dashboardsCol, _ := app.FindCollectionByNameOrId("dashboards")
		if dashboardsCol != nil {
			dashboardsChanged := false
			if dashboardsCol.Fields.GetByName("revision") == nil {
				dashboardsCol.Fields.Add(&core.NumberField{Name: "revision"})
				dashboardsChanged = true
			}

			// Reconcile duplicate names before adding the unique constraint.
			allDashboards, err := app.FindAllRecords("dashboards")
			if err == nil && len(allDashboards) > 0 {
				// Group records by name.
				byName := make(map[string][]*core.Record)
				for _, rec := range allDashboards {
					n := rec.GetString("name")
					byName[n] = append(byName[n], rec)
				}
				for name, group := range byName {
					if len(group) <= 1 {
						continue
					}
					// Pick the authoritative record: highest revision, then most recent
					// created timestamp as a tiebreaker.
					authoritative := group[0]
					for _, rec := range group[1:] {
						authRev := authoritative.GetInt("revision")
						recRev := rec.GetInt("revision")
						if recRev > authRev {
							authoritative = rec
						} else if recRev == authRev && rec.GetDateTime("created").Time().After(authoritative.GetDateTime("created").Time()) {
							authoritative = rec
						}
					}
					// Rename every non-authoritative duplicate so the unique index can be applied.
					for _, rec := range group {
						if rec.Id == authoritative.Id {
							continue
						}
						newName := fmt.Sprintf("%s_dup_%s", name, rec.Id)
						rec.Set("name", newName)
						if saveErr := app.Save(rec); saveErr != nil {
							return fmt.Errorf("migration 1799: failed to rename duplicate dashboard %q (id=%s) to %q: %w", name, rec.Id, newName, saveErr)
						}
					}
				}
			}

			// Enforce unique shared-dashboard identity
			dashboardsCol.AddIndex("idx_dashboards_name", true, "name", "")
			dashboardsChanged = true
			if dashboardsChanged {
				if err := app.Save(dashboardsCol); err != nil {
					return err
				}
			}
		}

		return nil
	}, func(app core.App) error {
		return nil
	}, "1799000000_ensure_protected_file_fields.go")
}
