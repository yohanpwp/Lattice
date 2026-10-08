import { useState, type FormEvent } from "react";

interface WorkspaceFormProps {
  message?: string;
  onSubmit: (address: string) => void;
}

/** Asks for the workspace address. Used by apps that are not served from a tenant's own host (desktop, mobile). */
export function WorkspaceForm({ message, onSubmit }: WorkspaceFormProps) {
  const [address, setAddress] = useState("");

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit(address);
  }

  return (
    <form className="app-card" onSubmit={handleSubmit} aria-labelledby="workspace-title">
      <h1 id="workspace-title">Find your workspace</h1>
      <p className="yp-muted">Enter the address your organization uses, for example acme.app.example.com.</p>

      <label htmlFor="workspace-address">Workspace address</label>
      <input
        id="workspace-address"
        type="text"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />

      {message && (
        <p className="yp-error" role="alert">
          {message}
        </p>
      )}

      <button type="submit">Continue</button>
    </form>
  );
}
