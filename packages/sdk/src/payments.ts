import type PocketBase from "pocketbase";
import {
  assertCheckoutRequest,
  assertPayment,
  type CheckoutRequest,
  type Payment,
} from "@lattice/types";

export class PaymentsClient {
  constructor(private readonly pb: PocketBase) {}

  /**
   * Initiates a checkout charge via POST /v1/payments/checkout.
   * Validates the outgoing request against schema before transmission,
   * and asserts the returned record conforms to the Payment schema.
   */
  async checkout(request: CheckoutRequest): Promise<Payment> {
    assertCheckoutRequest(request);
    const data = await this.pb.send("/v1/payments/checkout", {
      method: "POST",
      body: request,
    });
    return assertPayment(data);
  }

  /**
   * Retrieves an existing payment ledger entry via GET /v1/payments/:id.
   * Validates the response against the Payment schema.
   */
  async getPayment(id: string): Promise<Payment> {
    if (!id || typeof id !== "string") {
      throw new Error("payment id must be a non-empty string");
    }
    const data = await this.pb.send(`/v1/payments/${encodeURIComponent(id)}`, {
      method: "GET",
    });
    return assertPayment(data);
  }
}
