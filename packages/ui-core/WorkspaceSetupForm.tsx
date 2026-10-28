import { useState, type FormEvent } from "react";
import type { ProductClient } from "@lattice/sdk";

export interface WorkspaceSetupFormProps {
  client: ProductClient;
  onChangeWorkspace?: () => void;
  onSetupComplete?: () => void;
}

export function WorkspaceSetupForm({ client, onChangeWorkspace, onSetupComplete }: WorkspaceSetupFormProps) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    setPending(true);
    setError(null);

    try {
      await client.setupWorkspace({
        token: token.trim(),
        name: name.trim(),
        email: email.trim(),
        password,
      });

      // Automatically sign in the new owner
      await client.login(email.trim(), password);
      onSetupComplete?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to initialize workspace owner";
      setError(msg);
      setPending(false);
    }
  }

  return (
    <form className="app-card" onSubmit={handleSubmit} aria-labelledby="setup-title">
      <h1 id="setup-title">Setup your workspace</h1>
      <p className="yp-muted">
        Welcome to your new Lattice workspace (<strong>{client.config.tenant_id}</strong>). Enter the setup secret provided by the operator to create your owner account.
      </p>

      <label htmlFor="setup-token">Operator setup secret</label>
      <input
        id="setup-token"
        type="text"
        required
        placeholder="lattice_setup_..."
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />

      <label htmlFor="setup-name">Your name</label>
      <input
        id="setup-name"
        type="text"
        required
        placeholder="Jane Doe"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <label htmlFor="setup-email">Owner email</label>
      <input
        id="setup-email"
        type="email"
        autoComplete="email"
        required
        placeholder="owner@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label htmlFor="setup-password">Password</label>
      <input
        id="setup-password"
        type="password"
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <label htmlFor="setup-confirm-password">Confirm password</label>
      <input
        id="setup-confirm-password"
        type="password"
        autoComplete="new-password"
        required
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
      />

      {error && (
        <p className="yp-error" role="alert">
          {error}
        </p>
      )}

      <div className="app-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Initializing…" : "Complete setup"}
        </button>
        {onChangeWorkspace && (
          <button type="button" className="app-link" onClick={onChangeWorkspace}>
            Change workspace
          </button>
        )}
      </div>
    </form>
  );
}
