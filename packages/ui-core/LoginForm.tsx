import { useState, type FormEvent } from "react";

interface LoginFormProps {
  onSubmit: (email: string, password: string) => Promise<void>;
  onChangeWorkspace?: () => void;
  onAcceptInvite?: () => void;
}

export function LoginForm({ onSubmit, onChangeWorkspace, onAcceptInvite }: LoginFormProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setError(null);
    try {
      await onSubmit(email.trim(), password);
    } catch {
      // Deliberately generic: do not reveal whether the email exists.
      setError("Sign-in failed. Check your email and password and try again.");
      setPending(false);
    }
  }

  return (
    <form className="app-card" onSubmit={handleSubmit} aria-labelledby="login-title">
      <h1 id="login-title">Sign in</h1>

      <label htmlFor="login-email">Email</label>
      <input
        id="login-email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label htmlFor="login-password">Password</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {error && (
        <p className="yp-error" role="alert">
          {error}
        </p>
      )}

      <div className="app-actions">
        <button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {onAcceptInvite && (
          <button type="button" className="app-link" onClick={onAcceptInvite}>
            Accept invite token
          </button>
        )}
        {onChangeWorkspace && (
          <button type="button" className="app-link" onClick={onChangeWorkspace}>
            Change workspace
          </button>
        )}
      </div>
    </form>
  );
}
