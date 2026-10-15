import { describe, expect, it, vi, beforeEach } from "vitest";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import {
  bootstrapPlatform,
  setupMobileRealtime,
  registerRealtimeSubscriber,
  registerProductClient,
  handleAppResume,
} from "./bootstrap";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(),
  },
}));

describe("Client Bootstrap & Platform Precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns web storage adapter when not on native platform", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);

    const platform = await bootstrapPlatform();
    expect(platform.storage).toBeDefined();
    expect(platform.initializeRealtime).toBeUndefined();
  });

  it("returns mobile storage adapter and initializeRealtime when on native platform", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);

    const platform = await bootstrapPlatform();
    expect(platform.storage).toBeDefined();
    expect(typeof platform.initializeRealtime).toBe("function");
  });

  it("throws error when globalThis.EventSource is missing during mobile realtime setup", async () => {
    const originalEventSource = globalThis.EventSource;
    // @ts-expect-error simulating missing EventSource
    delete globalThis.EventSource;

    try {
      await expect(setupMobileRealtime()).rejects.toThrow("EventSource is not supported on this platform.");
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it("registers appStateChange listener on mobile and cleans up properly", async () => {
    const originalEventSource = globalThis.EventSource;
    // @ts-expect-error mock EventSource constructor
    globalThis.EventSource = class {};

    const removeSpy = vi.fn().mockResolvedValue(undefined);
    vi.mocked(CapApp.addListener).mockResolvedValue({ remove: removeSpy } as never);

    try {
      const cleanup = await setupMobileRealtime();
      expect(CapApp.addListener).toHaveBeenCalledWith("appStateChange", expect.any(Function));

      cleanup();
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it("handles rapid repeated resume events idempotently without duplicate streams", async () => {
    let callCount = 0;
    const subscriber = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const unregister = registerRealtimeSubscriber(subscriber);

    try {
      // Fire 3 resume events in rapid succession
      await Promise.all([
        handleAppResume(),
        handleAppResume(),
        handleAppResume(),
      ]);

      // Due to the resume lock, subscriber is only called once during the active cycle
      expect(callCount).toBe(1);
    } finally {
      unregister();
    }
  });

  it("reconnects active ProductClient realtime subscriptions on app resume", async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined);
    const mockClient = {
      pb: {
        realtime: {
          subscriptions: { orders: [() => {}] },
          clientId: "client-123",
          connect: connectSpy,
        },
      },
    };

    const unregister = registerProductClient(mockClient);

    try {
      await handleAppResume();
      expect(connectSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("invokes reconnectRealtime directly when provided by client instance", async () => {
    const reconnectSpy = vi.fn().mockResolvedValue(undefined);
    const mockClient = {
      reconnectRealtime: reconnectSpy,
    };

    const unregister = registerProductClient(mockClient);

    try {
      await handleAppResume();
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("cleans up previous client subscriber when switching clients or workspaces", async () => {
    const connectSpyA = vi.fn().mockResolvedValue(undefined);
    const clientA = {
      pb: {
        realtime: {
          subscriptions: { orders: [() => {}] },
          clientId: "client-A",
          connect: connectSpyA,
        },
      },
    };

    const connectSpyB = vi.fn().mockResolvedValue(undefined);
    const clientB = {
      pb: {
        realtime: {
          subscriptions: { items: [() => {}] },
          clientId: "client-B",
          connect: connectSpyB,
        },
      },
    };

    const unregisterA = registerProductClient(clientA);
    // Switch to client B (workspace switch)
    const unregisterB = registerProductClient(clientB);

    try {
      await handleAppResume();
      expect(connectSpyA).not.toHaveBeenCalled();
      expect(connectSpyB).toHaveBeenCalledTimes(1);
    } finally {
      unregisterB();
      unregisterA();
    }
  });
});
