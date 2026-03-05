/**
 * x402 HTTP helpers — encode/decode payment headers.
 */

import type {
  PaymentRequired,
  PaymentPayload,
  PaymentRequirements,
  SettlementResponse,
} from "@kaspacom/x402-types";

/** Parse a PAYMENT-REQUIRED header (base64 JSON). */
export function parsePaymentRequired(headerValue: string): PaymentRequired {
  const json = atob(headerValue);
  return JSON.parse(json) as PaymentRequired;
}

/** Build the PAYMENT-SIGNATURE header value (base64 JSON). */
export function buildPaymentHeader(payload: PaymentPayload): string {
  return btoa(JSON.stringify(payload));
}

/** Parse a PAYMENT-RESPONSE header. */
export function parsePaymentResponse(headerValue: string): SettlementResponse {
  const json = atob(headerValue);
  return JSON.parse(json) as SettlementResponse;
}

/** Find a Kaspa payment option from the accepts list. */
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
