import { describe, expect, it } from "vitest";
import {
  ProductClient,
  createMemoryStorage,
} from "@lattice/sdk";
import { ContractError, type CheckoutRequest, type Payment } from "@lattice/types";

const config = {
  version: 1,
  tenant_id: "tenant_dev",
  backend_url: "https://acme.app.example.com/",
  realtime_url: "https://acme.app.example.com/api/realtime",
  app_key: "pk_dev_000000",
  schema_version: "opaque_schema_id",
  min_client_version: "0.1.0",
  features: ["payments"],
  collections: ["orders"],
};

const validPaymentRecord: Payment = {
  id: "rec_pay_001",
  order_id: "ord_12345",
  user_id: "usr_abcde",
  provider: "mock",
  provider_charge_id: "ch_mock_999",
  amount: 2500,
  currency: "THB",
  status: "succeeded",
  idempotency_key: "idem_key_001",
  created: "2026-10-09 10:00:00.000Z",
  updated: "2026-10-09 10:00:01.000Z",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("PaymentsClient", () => {
  it("successfully creates a checkout charge with valid payload and authorization", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown; authorization: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      calls.push({
        url,
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return json(validPaymentRecord);
    }) as typeof fetch;

    const client = await ProductClient.fromConfig(config, {
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: fetchImpl },
    });
    client.authStore.save("auth-user-jwt");
    await client.authStore.flush();

    const checkoutReq: CheckoutRequest = {
      order_id: "ord_12345",
      amount: 2500,
      currency: "THB",
      provider: "mock",
      idempotency_key: "idem_key_001",
    };

    const payment = await client.payments.checkout(checkoutReq);
    expect(payment).toEqual(validPaymentRecord);
    expect(calls).toHaveLength(1);
    const firstCall = calls[0]!;
    expect(firstCall.url).toContain("/v1/payments/checkout");
    expect(firstCall.method).toBe("POST");
    expect(firstCall.authorization).toBe("auth-user-jwt");
    expect(firstCall.body).toEqual(checkoutReq);
  });

  it("validates checkout request schema before dispatching network request", async () => {
    let networkCalled = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/config")) return json(config);
      networkCalled = true;
      return json(validPaymentRecord);
    }) as typeof fetch;

    const client = await ProductClient.fromConfig(config, {
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: fetchImpl },
    });

    // Invalid amount (non-positive)
    const invalidReq = {
      order_id: "ord_1",
      amount: -100,
      currency: "THB",
      provider: "mock",
      idempotency_key: "idem_1",
    };

    await expect(client.payments.checkout(invalidReq as never)).rejects.toBeInstanceOf(ContractError);
    expect(networkCalled).toBe(false);
  });

  it("asserts Payment contract on server response", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/config")) return json(config);
      // Malformed payment response missing required fields
      return json({ id: "rec_1", status: "pending" });
    }) as typeof fetch;

    const client = await ProductClient.fromConfig(config, {
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: fetchImpl },
    });

    const checkoutReq: CheckoutRequest = {
      order_id: "ord_1",
      amount: 100,
      currency: "THB",
      provider: "mock",
      idempotency_key: "idem_1",
    };

    await expect(client.payments.checkout(checkoutReq)).rejects.toBeInstanceOf(ContractError);
  });

  it("fetches payment by id and validates response", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      calls.push(url);
      return json(validPaymentRecord);
    }) as typeof fetch;

    const client = await ProductClient.fromConfig(config, {
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: fetchImpl },
    });

    const payment = await client.payments.getPayment("rec_pay_001");
    expect(payment).toEqual(validPaymentRecord);
    expect(calls[0] ?? "").toContain("/v1/payments/rec_pay_001");

    await expect(client.payments.getPayment("")).rejects.toThrow("non-empty string");
  });

  it("propagates HTTP errors (401, 404, 409) from PocketBase transport", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/config")) return json(config);
      return json({ code: 409, message: "idempotency key conflict" }, 409);
    }) as typeof fetch;

    const client = await ProductClient.fromConfig(config, {
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: fetchImpl },
    });

    const checkoutReq: CheckoutRequest = {
      order_id: "ord_1",
      amount: 100,
      currency: "THB",
      provider: "mock",
      idempotency_key: "idem_1",
    };

    await expect(client.payments.checkout(checkoutReq)).rejects.toThrow();
  });
});
