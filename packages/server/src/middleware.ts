/**
 * x402 Kaspa Resource Server Middleware
 *
 * Framework-agnostic middleware that gates HTTP resources behind x402 payments.
 * Works with Express, Hono, or any framework via adapter functions.
 *
 * Flow:
 * 1. Request arrives at a gated route
 * 2. If no payment header → respond 402 with PaymentRequired body
 * 3. If payment header present → verify + settle via facilitator
 * 4. On success → pass request through to handler
 */

import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  VerifyResponse,
  SettlementResponse,
  ResourceInfo,
  KaspaNetwork,
} from "@x402/kaspa-types";

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

export interface PaywallConfig {
  /** Amount in sompi (string) */
  amount: string;
  /** Kaspa address to receive payment */
  payTo: string;
  /** CAIP-2 network identifier */
  network: KaspaNetwork;
  /** Facilitator HTTP base URL (e.g. "http://localhost:4020") */
  facilitatorUrl: string;
  /** Facilitator's x-only public key (hex) */
  facilitatorPubkey: string;
  /** Max timeout seconds for payment channels (default: 3600) */
  maxTimeoutSeconds?: number;
  /** Resource description shown in 402 response */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
}

export interface GatedRoute {
  /** URL path pattern (exact match or regex) */
  path: string | RegExp;
  /** HTTP methods to gate (default: all) */
  methods?: string[];
  /** Paywall config for this route */
  config: PaywallConfig;
}

export interface MiddlewareConfig {
  /** Routes to gate behind x402 payments */
  routes: GatedRoute[];
  /** Custom facilitator client (for testing/mocking) */
  facilitatorClient?: FacilitatorClient;
}

// ------------------------------------------------------------
// Facilitator Client
// ------------------------------------------------------------

export interface FacilitatorClient {
  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse>;
}

/** Default facilitator client that calls the facilitator HTTP API */
export class HttpFacilitatorClient implements FacilitatorClient {
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const url = requirements.extra.facilitatorUrl;
    const res = await fetch(`${url}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      throw new Error(`Facilitator verify failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<VerifyResponse>;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettlementResponse> {
    const url = requirements.extra.facilitatorUrl;
    const res = await fetch(`${url}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
    });
    if (!res.ok) {
      throw new Error(`Facilitator settle failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<SettlementResponse>;
  }
}

// ------------------------------------------------------------
// Core Logic (framework-agnostic)
// ------------------------------------------------------------

/** Build the PaymentRequired 402 response body */
export function buildPaymentRequired(
  requestUrl: string,
  config: PaywallConfig,
): PaymentRequired {
  const resource: ResourceInfo = {
    url: requestUrl,
    description: config.description ?? "Paid resource",
    mimeType: config.mimeType ?? "application/json",
  };

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: config.network,
    amount: config.amount,
    asset: "KAS",
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 3600,
    extra: {
      facilitatorUrl: config.facilitatorUrl,
      facilitatorPubkey: config.facilitatorPubkey,
    },
  };

  return {
    x402Version: 2,
    error: "X-PAYMENT-REQUIRED",
    resource,
    accepts: [requirements],
  };
}

/** Parse payment from X-PAYMENT header (base64 JSON) */
export function parsePaymentHeader(header: string): PaymentPayload | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    return JSON.parse(decoded) as PaymentPayload;
  } catch {
    return null;
  }
}

/** Find matching gated route for a request */
export function findGatedRoute(
  path: string,
  method: string,
  routes: GatedRoute[],
): GatedRoute | undefined {
  return routes.find((route) => {
    // Check method
    if (route.methods && !route.methods.includes(method.toUpperCase())) {
      return false;
    }
    // Check path
    if (typeof route.path === "string") {
      return path === route.path || path.startsWith(route.path + "/");
    }
    return route.path.test(path);
  });
}

/** Process a payment: verify then settle */
export async function processPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  client: FacilitatorClient,
): Promise<{
  success: boolean;
  settlement?: SettlementResponse;
  error?: string;
}> {
  // 1. Verify
  const verifyResult = await client.verify(payload, requirements);
  if (!verifyResult.isValid) {
    return { success: false, error: verifyResult.invalidReason ?? "Payment verification failed" };
  }

  // 2. Settle
  const settlement = await client.settle(payload, requirements);
  if (!settlement.success) {
    return { success: false, error: settlement.errorReason ?? "Settlement failed" };
  }

  return { success: true, settlement };
}

// ------------------------------------------------------------
// Express Middleware
// ------------------------------------------------------------

/**
 * Express-compatible middleware that gates routes behind x402 payments.
 *
 * Usage:
 * ```ts
 * import { paywall } from "@x402/kaspa-server";
 *
 * app.use(paywall({
 *   routes: [{
 *     path: "/api/premium",
 *     config: {
 *       amount: "100000000", // 1 KAS
 *       payTo: "kaspa:qz...",
 *       network: "kaspa:mainnet",
 *       facilitatorUrl: "http://localhost:4020",
 *       facilitatorPubkey: "abc123...",
 *     }
 *   }]
 * }));
 * ```
 */
export function paywall(config: MiddlewareConfig) {
  const client = config.facilitatorClient ?? new HttpFacilitatorClient();

  return async (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => {
    const route = findGatedRoute(req.path ?? req.url ?? "/", req.method ?? "GET", config.routes);

    // Not a gated route — pass through
    if (!route) {
      next();
      return;
    }

    const paymentHeader = req.headers?.["x-payment"] as string | undefined;

    // No payment header → 402
    if (!paymentHeader) {
      const requestUrl = `${req.protocol ?? "https"}://${req.headers?.host ?? "localhost"}${req.url ?? "/"}`;
      const body = buildPaymentRequired(requestUrl, route.config);
      res.status(402).json(body);
      return;
    }

    // Parse payment
    const payload = parsePaymentHeader(paymentHeader);
    if (!payload) {
      res.status(400).json({ error: "Invalid X-PAYMENT header" });
      return;
    }

    // Process payment
    try {
      const requirements = buildPaymentRequired("", route.config).accepts[0];
      const result = await processPayment(payload, requirements, client);

      if (!result.success) {
        res.status(402).json({
          error: "Payment failed",
          reason: result.error,
        });
        return;
      }

      // Attach settlement info to request for downstream handlers
      (req as any).x402 = {
        settlement: result.settlement,
        payer: result.settlement?.payer,
        txid: result.settlement?.transaction,
      };

      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Payment processing error: ${message}` });
    }
  };
}

// ------------------------------------------------------------
// Minimal Express-like type definitions (no dependency needed)
// ------------------------------------------------------------

interface ExpressRequest {
  method?: string;
  url?: string;
  path?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
}

type ExpressNext = (err?: unknown) => void;
