import { useState } from "react";
import type { ProductClient } from "@lattice/sdk";

export interface AcceptInviteFormProps {
  client: ProductClient;
  initialToken?: string;
  onAccepted?: () => void;
  onCancel?: () => void;
  onChangeWorkspace?: () => void;
}

export function AcceptInviteForm({
  client,
  initialToken = "",
  onAccepted,
  onCancel,
  onChangeWorkspace,
}: AcceptInviteFormProps) {
  const [token, setToken] = useState(initialToken);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setError("Invitation token is required");
      return;
    }
    if (!name.trim()) {
      setError("Full name is required");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      const user = await client.acceptInvitation({
        token: trimmedToken,
        name: name.trim(),
        password,
      });

      // Automatically authenticate with accepted credentials
      await client.login(user.email, password);
      onAccepted?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-card">
      <h1>Accept Invitation</h1>
      <p className="yp-muted">
        Join workspace <strong>{client.config.tenant_id}</strong> using your invitation token.
      </p>

      {error && (
        <div className="lattice-alert-error" role="alert" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="lattice-form-group">
          <label htmlFor="invite-token-input">Invitation Token</label>
          <input
            id="invite-token-input"
            type="text"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="e.g. inv_tok_abc123"
            disabled={submitting}
          />
        </div>

        <div className="lattice-form-group">
          <label htmlFor="invite-name-input">Your Full Name</label>
          <input
            id="invite-name-input"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex Taylor"
            disabled={submitting}
          />
        </div>

        <div className="lattice-form-group">
          <label htmlFor="invite-password-input">Password (min 8 chars)</label>
          <input
            id="invite-password-input"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        <div className="lattice-form-group">
          <label htmlFor="invite-confirm-password-input">Confirm Password</label>
          <input
            id="invite-confirm-password-input"
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="lattice-btn-primary"
          style={{ width: "100%", marginTop: "1rem" }}
        >
          {submitting ? "Joining Workspace…" : "Accept & Sign In"}
        </button>
      </form>

      <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", fontSize: "0.875rem" }}>
        {onCancel && (
          <button type="button" className="app-link" onClick={onCancel}>
            ← Back to Sign In
          </button>
        )}
        {onChangeWorkspace && (
          <button type="button" className="app-link" onClick={onChangeWorkspace}>
            Change workspace
          </button>
        )}
      </div>
    </div>
  );
}
