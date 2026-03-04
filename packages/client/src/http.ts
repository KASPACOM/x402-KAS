// ============================================================
// x402 HTTP Helpers
// ============================================================
// Encode/decode the PAYMENT-REQUIRED and PAYMENT-SIGNATURE headers.

import type { PaymentRequired, PaymentPayload, PaymentRequirements, SettlementResponse } from "@x402/kaspa-types";

/**
 * Parse the PAYMENT-REQUIRED header from a 402 response.
 */
export function parsePaymentRequired(headerValue: string): PaymentRequired {
  const json = Buffer.from(headerValue, "base64").toString("utf-8");
  return JSON.parse(json) as PaymentRequired;
}

/**
 * Build the PAYMENT-SIGNATURE header value from a PaymentPayload.
 */
export function buildPaymentHeader(payload: PaymentPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Parse the PAYMENT-RESPONSE header from a successful response.
 */
export function parsePaymentResponse(headerValue: string): SettlementResponse {
  const json = Buffer.from(headerValue, "base64").toString("utf-8");
  return JSON.parse(json) as SettlementResponse;
}

/**
 * Find a Kaspa payment option from the PaymentRequired accepts list.
 */
export function findKaspaRequirement(
  paymentRequired: PaymentRequired,
  network?: string,
): PaymentRequirements | undefined {
  return paymentRequired.accepts.find(
    (req) =>
      req.asset === "KAS" &&
      req.scheme === "exact" &&
      (network ? req.network === network : req.network.startsWith("kaspa:")),
  );
}

/**
 * High-level: fetch a resource with x402 payment.
 *
 * 1. Makes initial request
 * 2. If 402, parses requirements, calls buildPayment
 * 3. Retries with PAYMENT-SIGNATURE header
 * 4. Returns the response
 */
export async function fetchWithPayment(
  url: string,
  buildPayment: (requirements: PaymentRequirements) => Promise<PaymentPayload>,
  options: RequestInit = {},
  preferredNetwork?: string,
): Promise<Response> {
  // 1. Initial request
  const initialResponse = await fetch(url, options);

  if (initialResponse.status !== 402) {
    return initialResponse;
  }

  // 2. Parse 402 response
  const paymentRequiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    throw new Error("402 response missing PAYMENT-REQUIRED header");
  }

  const paymentRequired = parsePaymentRequired(paymentRequiredHeader);
  const kaspaRequirement = findKaspaRequirement(paymentRequired, preferredNetwork);

  if (!kaspaRequirement) {
    throw new Error("No Kaspa payment option available in 402 response");
  }

  // 3. Build payment
  const paymentPayload = await buildPayment(kaspaRequirement);

  // 4. Retry with payment
  const headers = new Headers(options.headers);
  headers.set("PAYMENT-SIGNATURE", buildPaymentHeader(paymentPayload));

  const paidResponse = await fetch(url, {
    ...options,
    headers,
  });

  return paidResponse;
}
