import { useCallback, useEffect, useState } from "react";
import type { DatasetPermission, SchemaDefinition, WorkspaceInvitation, WorkspaceUser } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

export interface WorkspaceMembersModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ProductClient;
  schemas: SchemaDefinition[];
}

export function WorkspaceMembersModal({ isOpen, onClose, client, schemas }: WorkspaceMembersModalProps) {
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invite state
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [invitePermissions, setInvitePermissions] = useState<Record<string, DatasetPermission>>({});
  const [invitePending, setInvitePending] = useState(false);
  const [generatedInviteToken, setGeneratedInviteToken] = useState<string | null>(null);

  // Editing state
  const [editingUser, setEditingUser] = useState<WorkspaceUser | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<Record<string, DatasetPermission>>({});

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [userList, invList] = await Promise.all([
        client.getWorkspaceUsers(),
        client.getWorkspaceInvitations().catch(() => []),
      ]);
      setUsers(userList);
      setPendingInvitations(invList);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load team data");
    } finally {
      setLoading(false);
    }
  }, [client]);

  function resetInviteDraft() {
    setInviteEmail("");
    setInviteRole("member");
    setInvitePermissions({});
    setError(null);
  }

  useEffect(() => {
    if (isOpen) {
      loadUsers();
      setShowInviteForm(false);
      setGeneratedInviteToken(null);
      setEditingUser(null);
      resetInviteDraft();
    }
  }, [isOpen, loadUsers]);

  if (!isOpen) return null;

  function handleInvitePermChange(schemaId: string, action: "read" | "create" | "update" | "delete", value: boolean) {
    setInvitePermissions((prev) => {
      const current = prev[schemaId] || { read: false, create: false, update: false, delete: false, scope: "all" };
      return {
        ...prev,
        [schemaId]: { ...current, [action]: value },
      };
    });
  }

  function handleInviteScopeChange(schemaId: string, scope: "all" | "assigned") {
    setInvitePermissions((prev) => {
      const current = prev[schemaId] || { read: false, create: false, update: false, delete: false, scope: "all" };
      return {
        ...prev,
        [schemaId]: { ...current, scope },
      };
    });
  }

  function handleEditPermChange(schemaId: string, action: "read" | "create" | "update" | "delete", value: boolean) {
    setEditingPermissions((prev) => {
      const current = prev[schemaId] || { read: false, create: false, update: false, delete: false, scope: "all" };
      return {
        ...prev,
        [schemaId]: { ...current, [action]: value },
      };
    });
  }

  function handleEditScopeChange(schemaId: string, scope: "all" | "assigned") {
    setEditingPermissions((prev) => {
      const current = prev[schemaId] || { read: false, create: false, update: false, delete: false, scope: "all" };
      return {
        ...prev,
        [schemaId]: { ...current, scope },
      };
    });
  }

  async function handleRevokeInvitation(id: string) {
    try {
      await client.revokeInvitation(id);
      await loadUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke invitation");
    }
  }

  async function handleReissueInvitation(id: string) {
    try {
      const res = await client.reissueInvitation(id);
      setGeneratedInviteToken(res.token || "Reissued");
      await loadUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reissue invitation token");
    }
  }

  async function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    setInvitePending(true);
    setError(null);
    try {
      const inv = await client.createInvitation({
        email: inviteEmail.trim(),
        role: inviteRole,
        permissions: invitePermissions as unknown as Record<string, unknown>,
      });
      setGeneratedInviteToken(inv.token || "Created");
      resetInviteDraft();
      setShowInviteForm(false);
      await loadUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create invitation");
    } finally {
      setInvitePending(false);
    }
  }

  async function handleToggleDisabled(user: WorkspaceUser) {
    try {
      await client.updateWorkspaceUser(user.id, { disabled: !user.disabled });
      await loadUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update user status");
    }
  }

  function openEditPermissions(user: WorkspaceUser) {
    setEditingUser(user);
    setEditingPermissions((user.permissions as Record<string, DatasetPermission>) || {});
  }

  async function handleSaveEditedPermissions() {
    if (!editingUser) return;
    try {
      await client.updateWorkspaceUser(editingUser.id, {
        permissions: editingPermissions,
      });
      setEditingUser(null);
      await loadUsers();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save permissions");
    }
  }

  const isCurrentOwner = client.isOwner;

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="members-modal-title">
      <div className="lattice-modal lattice-modal--large" role="document">
        <div className="lattice-modal-header">
          <h2 id="members-modal-title">Workspace Team & Access Control</h2>
          <button type="button" className="lattice-modal-close" onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className="lattice-modal-body">
          {error && (
            <div className="lattice-alert-error" role="alert" style={{ marginBottom: "1rem" }}>
              {error}
            </div>
          )}

          {generatedInviteToken && (
            <div className="lattice-card" style={{ background: "#f0fdf4", border: "1px solid #86efac", marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <h3 style={{ margin: "0 0 0.5rem 0", color: "#166534" }}>Invitation Token Ready</h3>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  style={{ padding: "0.2rem 0.4rem", fontSize: "0.75rem" }}
                  onClick={() => setGeneratedInviteToken(null)}
                >
                  Dismiss
                </button>
              </div>
              <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.875rem" }}>
                Copy and share this single-use token with your team member. <strong>For security, this token will not be displayed again.</strong>
              </p>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <code style={{ background: "#dcfce7", padding: "0.25rem 0.5rem", borderRadius: "4px", fontSize: "1rem", flex: 1 }}>
                  {generatedInviteToken}
                </code>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={() => navigator.clipboard.writeText(generatedInviteToken)}
                >
                  Copy Token
                </button>
              </div>
            </div>
          )}

          {!showInviteForm && !editingUser && (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <p className="yp-muted" style={{ margin: 0 }}>
                  Manage workspace members, assign roles, and configure dataset-level access permissions.
                </p>
                <button
                  type="button"
                  className="lattice-btn-primary"
                  onClick={() => {
                    resetInviteDraft();
                    setShowInviteForm(true);
                  }}
                >
                  + Invite Member
                </button>
              </div>

              {loading && <p className="yp-muted">Loading team members…</p>}

              {!loading && (
                <div className="lattice-table-container">
                  <table className="lattice-table">
                    <thead>
                      <tr>
                        <th>User</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Permissions Summary</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id}>
                          <td>
                            <strong>{u.name || "Unnamed"}</strong>
                            <div className="yp-muted" style={{ fontSize: "0.75rem" }}>{u.email}</div>
                          </td>
                          <td>
                            <span className={`lattice-role-chip lattice-role-chip--${u.role}`}>
                              {u.role.toUpperCase()}
                            </span>
                          </td>
                          <td>
                            <span className={u.disabled ? "yp-error" : "yp-success"}>
                              {u.disabled ? "Disabled" : "Active"}
                            </span>
                          </td>
                          <td>
                            {u.role === "owner" || u.role === "admin" ? (
                              <span className="yp-muted">Full Access</span>
                            ) : (
                              <div style={{ fontSize: "0.75rem" }}>
                                {Object.entries((u.permissions as Record<string, DatasetPermission>) || {}).map(([ds, p]) => (
                                  <div key={ds}>
                                    <strong>{ds}:</strong> {p.read ? "R" : ""}{p.create ? "C" : ""}{p.update ? "U" : ""}{p.delete ? "D" : ""} ({p.scope || "all"})
                                  </div>
                                ))}
                                {(!u.permissions || Object.keys(u.permissions).length === 0) && (
                                  <span className="yp-error">No Datasets Permitted</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td>
                            {u.role !== "owner" && (
                              <div style={{ display: "flex", gap: "0.5rem" }}>
                                <button
                                  type="button"
                                  className="lattice-btn-secondary"
                                  style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                                  onClick={() => openEditPermissions(u)}
                                >
                                  Permissions
                                </button>
                                <button
                                  type="button"
                                  className="lattice-btn-secondary"
                                  style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
                                  onClick={() => handleToggleDisabled(u)}
                                >
                                  {u.disabled ? "Enable" : "Disable"}
                                </button>
                              </div>
                            )}
                            {u.role === "owner" && (
                              <span className="yp-muted" style={{ fontSize: "0.75rem" }}>Protected</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!loading && pendingInvitations.length > 0 && (
                <div style={{ marginTop: "1.5rem" }}>
                  <h4 style={{ margin: "0 0 0.5rem 0" }}>Pending Invitations</h4>
                  <div className="lattice-table-container">
                    <table className="lattice-table">
                      <thead>
                        <tr>
                          <th>Invitee Email</th>
                          <th>Role</th>
                          <th>Expires</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingInvitations.map((inv) => (
                          <tr key={inv.id || inv.email}>
                            <td>{inv.email}</td>
                            <td>
                              <span className={`lattice-role-chip lattice-role-chip--${inv.role}`}>
                                {inv.role.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ fontSize: "0.75rem" }}>
                              {inv.expires_at ? new Date(inv.expires_at).toLocaleDateString() : "—"}
                            </td>
                            <td>
                              <div style={{ display: "flex", gap: "0.5rem" }}>
                                {inv.id && (
                                  <button
                                    type="button"
                                    className="lattice-btn-secondary"
                                    style={{ padding: "0.2rem 0.4rem", fontSize: "0.75rem" }}
                                    onClick={() => handleReissueInvitation(inv.id!)}
                                  >
                                    Reissue
                                  </button>
                                )}
                                {inv.id && (
                                  <button
                                    type="button"
                                    className="lattice-btn-secondary"
                                    style={{ padding: "0.2rem 0.4rem", fontSize: "0.75rem", color: "#dc2626" }}
                                    onClick={() => handleRevokeInvitation(inv.id!)}
                                  >
                                    Revoke
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          {showInviteForm && (
            <form onSubmit={handleSendInvite}>
              <h3>Invite New Member or Admin</h3>
              <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="invite-email">Member Email</label>
                  <input
                    id="invite-email"
                    type="email"
                    required
                    placeholder="teammate@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                </div>
                <div style={{ width: "160px" }}>
                  <label htmlFor="invite-role">Role</label>
                  <select
                    id="invite-role"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}
                  >
                    <option value="member">Member</option>
                    {isCurrentOwner && <option value="admin">Admin</option>}
                  </select>
                </div>
              </div>

              {inviteRole === "member" && (
                <>
                  <h4>Dataset Permissions Matrix (Deny by default)</h4>
                  <div className="lattice-table-container" style={{ marginBottom: "1rem" }}>
                    <table className="lattice-table">
                      <thead>
                        <tr>
                          <th>Dataset</th>
                          <th>Read</th>
                          <th>Create</th>
                          <th>Edit</th>
                          <th>Delete</th>
                          <th>Scope</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schemas.map((s) => {
                          const p = invitePermissions[s.schema_id] || { read: false, create: false, update: false, delete: false, scope: "all" };
                          const hasAssignee = Boolean(s.assignee_field);
                          return (
                            <tr key={s.schema_id}>
                              <td>
                                <strong>{s.name}</strong> ({s.schema_id})
                                {hasAssignee && <span className="app-chip" style={{ marginLeft: "0.5rem" }}>Assignee: {s.assignee_field}</span>}
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.read)}
                                  onChange={(e) => handleInvitePermChange(s.schema_id, "read", e.target.checked)}
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.create)}
                                  onChange={(e) => handleInvitePermChange(s.schema_id, "create", e.target.checked)}
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.update)}
                                  onChange={(e) => handleInvitePermChange(s.schema_id, "update", e.target.checked)}
                                />
                              </td>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={Boolean(p.delete)}
                                  onChange={(e) => handleInvitePermChange(s.schema_id, "delete", e.target.checked)}
                                />
                              </td>
                              <td>
                                {hasAssignee ? (
                                  <select
                                    value={p.scope || "all"}
                                    onChange={(e) => handleInviteScopeChange(s.schema_id, e.target.value as "all" | "assigned")}
                                  >
                                    <option value="all">All Records</option>
                                    <option value="assigned">Assigned Only</option>
                                  </select>
                                ) : (
                                  <span className="yp-muted" style={{ fontSize: "0.75rem" }}>All Records</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="lattice-modal-footer">
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={() => {
                    resetInviteDraft();
                    setShowInviteForm(false);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="lattice-btn-primary" disabled={invitePending}>
                  {invitePending ? "Creating…" : "Send Invitation"}
                </button>
              </div>
            </form>
          )}

          {editingUser && (
            <div>
              <h3>Edit Permissions for {editingUser.name || editingUser.email}</h3>
              <div className="lattice-table-container" style={{ marginBottom: "1rem" }}>
                <table className="lattice-table">
                  <thead>
                    <tr>
                      <th>Dataset</th>
                      <th>Read</th>
                      <th>Create</th>
                      <th>Edit</th>
                      <th>Delete</th>
                      <th>Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schemas.map((s) => {
                      const p = editingPermissions[s.schema_id] || { read: false, create: false, update: false, delete: false, scope: "all" };
                      const hasAssignee = Boolean(s.assignee_field);
                      return (
                        <tr key={s.schema_id}>
                          <td>
                            <strong>{s.name}</strong> ({s.schema_id})
                            {hasAssignee && <span className="app-chip" style={{ marginLeft: "0.5rem" }}>Assignee: {s.assignee_field}</span>}
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(p.read)}
                              onChange={(e) => handleEditPermChange(s.schema_id, "read", e.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(p.create)}
                              onChange={(e) => handleEditPermChange(s.schema_id, "create", e.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(p.update)}
                              onChange={(e) => handleEditPermChange(s.schema_id, "update", e.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={Boolean(p.delete)}
                              onChange={(e) => handleEditPermChange(s.schema_id, "delete", e.target.checked)}
                            />
                          </td>
                          <td>
                            {hasAssignee ? (
                              <select
                                value={p.scope || "all"}
                                onChange={(e) => handleEditScopeChange(s.schema_id, e.target.value as "all" | "assigned")}
                              >
                                <option value="all">All Records</option>
                                <option value="assigned">Assigned Only</option>
                              </select>
                            ) : (
                              <span className="yp-muted" style={{ fontSize: "0.75rem" }}>All Records</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="lattice-modal-footer">
                <button type="button" className="lattice-btn-secondary" onClick={() => setEditingUser(null)}>
                  Cancel
                </button>
                <button type="button" className="lattice-btn-primary" onClick={handleSaveEditedPermissions}>
                  Save Permissions
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
