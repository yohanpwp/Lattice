import { useEffect, useMemo, useState } from "react";
import {
  ClientTooOldError,
  ProductClient,
  createWebStorage,
  type StorageAdapter,
} from "@lattice/sdk";
import { ContractError } from "@lattice/types";
import pkg from "./package.json";
import { DashboardPage } from "./DashboardPage";
import { LoginForm } from "./LoginForm";
import { WorkspaceForm } from "./WorkspaceForm";
import { forgetWorkspace, loadSavedWorkspace, normalizeWorkspaceUrl, saveWorkspace } from "./workspace";

export interface AppProps {
  /** Where the session and saved workspace are stored. Defaults to browser storage. */
  storage?: StorageAdapter;
  /** Fixed backend address (web deployments). If unset, the app asks for a workspace. */
  backendUrl?: string;
  clientVersion?: string;
}

type Phase =
  | { name: "connecting" }
  | { name: "workspace"; message?: string }
  | { name: "failed"; message: string; canChangeWorkspace: boolean }
  | { name: "ready"; client: ProductClient };

export function App({
  storage: storageProp,
  backendUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_URL,
  clientVersion = pkg.version,
}: AppProps) {
  const storage = useMemo(() => storageProp ?? createWebStorage(), [storageProp]);
  const fixedBackend = Boolean(backendUrl);
  const [phase, setPhase] = useState<Phase>({ name: "connecting" });

  async function connect(url: string, remember: boolean): Promise<Phase> {
    try {
      const client = await ProductClient.connect({
        backendUrl: url,
        clientVersion,
        platform: { storage },
      });
      await client.sessionRestored;
      await client.refreshSession();
      if (remember) await saveWorkspace(storage, url);
      return { name: "ready", client };
    } catch (err) {
      return failure(err, !fixedBackend);
    }
  }

  useEffect(() => {
    let ignore = false;

    async function start() {
      if (backendUrl) {
        const result = normalizeWorkspaceUrl(backendUrl);
        if (!result.ok) {
          return { name: "failed", message: `Invalid backend address: ${result.error}`, canChangeWorkspace: false } as Phase;
        }
        return connect(result.url, false);
      }

      const saved = await loadSavedWorkspace(storage);
      if (!saved) return { name: "workspace" } as Phase;
      return connect(saved, false);
    }

    start().then((next) => {
      if (!ignore) setPhase(next);
    });

    return () => {
      ignore = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendUrl, storage]);

  async function handleWorkspace(address: string) {
    const result = normalizeWorkspaceUrl(address);
    if (!result.ok) {
      setPhase({ name: "workspace", message: result.error });
      return;
    }

    setPhase({ name: "connecting" });
    const next = await connect(result.url, true);
    setPhase(next.name === "failed" ? { name: "workspace", message: next.message } : next);
  }

  async function changeWorkspace() {
    await forgetWorkspace(storage);
    setPhase({ name: "workspace" });
  }

  switch (phase.name) {
    case "connecting":
      return <p className="app-center yp-muted">Connecting…</p>;

    case "workspace":
      return <WorkspaceForm message={phase.message} onSubmit={handleWorkspace} />;

    case "failed":
      return (
        <div className="app-card" role="alert">
          <h1>Cannot continue</h1>
          <p>{phase.message}</p>
          {phase.canChangeWorkspace && (
            <button type="button" onClick={changeWorkspace}>
              Change workspace
            </button>
          )}
        </div>
      );

    case "ready":
      return (
        <Session
          client={phase.client}
          onChangeWorkspace={fixedBackend ? undefined : changeWorkspace}
        />
      );
  }
}

function failure(err: unknown, canChangeWorkspace: boolean): Phase {
  if (err instanceof ClientTooOldError) {
    return { name: "failed", message: err.message, canChangeWorkspace: false };
  }
  if (err instanceof ContractError) {
    return {
      name: "failed",
      message: "The server sent a response this app does not understand. Please update the app.",
      canChangeWorkspace,
    };
  }
  return {
    name: "failed",
    message: "Could not reach the workspace. Check the address and your connection.",
    canChangeWorkspace,
  };
}

function Session({ client, onChangeWorkspace }: { client: ProductClient; onChangeWorkspace?: () => void }) {
  const signedIn = useSignedIn(client);

  if (!signedIn) {
    return (
      <LoginForm
        onSubmit={async (email, password) => void (await client.login(email, password))}
        onChangeWorkspace={onChangeWorkspace}
      />
    );
  }

  return <DashboardPage client={client} onSignOut={() => client.logout()} onChangeWorkspace={onChangeWorkspace} />;
}

/** Re-renders whenever the auth store changes (sign in, sign out, expiry, refresh). */
function useSignedIn(client: ProductClient): boolean {
  const [signedIn, setSignedIn] = useState(client.isAuthenticated);

  useEffect(
    () => client.pb.authStore.onChange(() => setSignedIn(client.pb.authStore.isValid), true),
    [client],
  );

  return signedIn;
}
