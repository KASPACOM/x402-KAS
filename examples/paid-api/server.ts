/**
 * Example: Paid API Server
 *
 * An Express-like HTTP server with one paid endpoint gated behind x402 micropayments.
 * The /weather endpoint costs 0.01 KAS per request.
 *
 * Usage:
 *   FACILITATOR_URL=http://localhost:4020 \
 *   FACILITATOR_PUBKEY=<hex> \
 *   PAY_TO=<kaspa-address> \
 *   npx tsx examples/paid-api/server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  buildPaymentRequired,
  parsePaymentHeader,
  processPayment,
  HttpFacilitatorClient,
} from "../../packages/server/dist/index.js";
import type { KaspaNetwork } from "../../packages/types/dist/index.js";

const PORT = parseInt(process.env.API_PORT ?? "3000", 10);
const NETWORK = (process.env.KASPA_NETWORK ?? "kaspa:testnet-12") as KaspaNetwork;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4020";
const FACILITATOR_PUBKEY = process.env.FACILITATOR_PUBKEY ?? "";
const PAY_TO = process.env.PAY_TO ?? "";

if (!FACILITATOR_PUBKEY || !PAY_TO) {
  console.error("Required env vars: FACILITATOR_PUBKEY, PAY_TO");
  console.error("  FACILITATOR_PUBKEY — facilitator's x-only public key (hex)");
  console.error("  PAY_TO             — Kaspa address to receive payments");
  process.exit(1);
}

const PRICE_SOMPI = process.env.PRICE_SOMPI ?? "1000000"; // 0.01 KAS

// Fetch facilitator info (fee, fee address) on startup
let FACILITATOR_FEE: string | undefined;
let FACILITATOR_FEE_ADDRESS: string | undefined;
let FACILITATOR_SIGNING_ADDRESS: string | undefined;

(async () => {
  try {
    const healthRes = await fetch(`${FACILITATOR_URL}/health`);
    if (healthRes.ok) {
      const health = await healthRes.json() as { feeSompi?: string; feeAddress?: string; signingAddress?: string };
      FACILITATOR_FEE = health.feeSompi && health.feeSompi !== "0" ? health.feeSompi : undefined;
      FACILITATOR_FEE_ADDRESS = health.feeAddress;
      FACILITATOR_SIGNING_ADDRESS = health.signingAddress;
      console.log(`[paid-api] Facilitator signing: ${FACILITATOR_SIGNING_ADDRESS ?? "N/A"}`);
      console.log(`[paid-api] Facilitator fee: ${FACILITATOR_FEE ?? "0"} sompi`);
      console.log(`[paid-api] Facilitator fee address: ${FACILITATOR_FEE_ADDRESS ?? "N/A"}`);
    }
  } catch {
    console.warn(`[paid-api] Could not fetch facilitator health from ${FACILITATOR_URL}/health`);
  }
})();

const facilitatorClient = new HttpFacilitatorClient();

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-PAYMENT, PAYMENT-SIGNATURE",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Free endpoint
  if (url.pathname === "/" || url.pathname === "/health") {
    json(res, 200, { status: "ok", message: "x402 Paid API Example" });
    return;
  }

  // Paid endpoint: GET /weather
  if (url.pathname === "/weather") {
    const paymentHeader =
      (req.headers["x-payment"] as string) ??
      (req.headers["payment-signature"] as string);

    if (!paymentHeader) {
      // Return 402 with payment requirements
      const paymentRequired = buildPaymentRequired(
        `http://${req.headers.host}${req.url}`,
        {
          amount: PRICE_SOMPI,
          payTo: PAY_TO,
          network: NETWORK,
          facilitatorUrl: FACILITATOR_URL,
          facilitatorPubkey: FACILITATOR_PUBKEY,
          facilitatorSigningAddress: FACILITATOR_SIGNING_ADDRESS,
          facilitatorFee: FACILITATOR_FEE,
          facilitatorFeeAddress: FACILITATOR_FEE_ADDRESS,
          description: "Current weather data",
          mimeType: "application/json",
        },
      );
      json(res, 402, paymentRequired);
      return;
    }

    // Parse and process payment
    const payload = parsePaymentHeader(paymentHeader);
    if (!payload) {
      // Try raw JSON (from PAYMENT-SIGNATURE header)
      try {
        const parsed = JSON.parse(paymentHeader);
        const requirements = buildPaymentRequired("", {
          amount: PRICE_SOMPI,
          payTo: PAY_TO,
          network: NETWORK,
          facilitatorUrl: FACILITATOR_URL,
          facilitatorPubkey: FACILITATOR_PUBKEY,
          facilitatorSigningAddress: FACILITATOR_SIGNING_ADDRESS,
          facilitatorFee: FACILITATOR_FEE,
          facilitatorFeeAddress: FACILITATOR_FEE_ADDRESS,
        }).accepts[0];

        const result = await processPayment(parsed, requirements, facilitatorClient);
        if (!result.success) {
          json(res, 402, { error: "Payment failed", reason: result.error });
          return;
        }

        // Payment succeeded — return the paid content
        json(res, 200, {
          weather: "sunny",
          temperature: 28,
          unit: "celsius",
          location: "Tel Aviv",
          txid: result.settlement?.transaction,
          paid: `${PRICE_SOMPI} sompi`,
        });
        return;
      } catch {
        json(res, 400, { error: "Invalid payment header" });
        return;
      }
    }

    // Process base64-encoded payment
    const requirements = buildPaymentRequired("", {
      amount: PRICE_SOMPI,
      payTo: PAY_TO,
      network: NETWORK,
      facilitatorUrl: FACILITATOR_URL,
      facilitatorPubkey: FACILITATOR_PUBKEY,
      facilitatorSigningAddress: FACILITATOR_SIGNING_ADDRESS,
    }).accepts[0];

    const result = await processPayment(payload, requirements, facilitatorClient);
    if (!result.success) {
      json(res, 402, { error: "Payment failed", reason: result.error });
      return;
    }

    json(res, 200, {
      weather: "sunny",
      temperature: 28,
      unit: "celsius",
      location: "Tel Aviv",
      txid: result.settlement?.transaction,
      paid: `${PRICE_SOMPI} sompi`,
    });
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[paid-api] Listening on :${PORT}`);
  console.log(`[paid-api] Free:  GET /health`);
  console.log(`[paid-api] Paid:  GET /weather (${PRICE_SOMPI} sompi)`);
  console.log(`[paid-api] PayTo: ${PAY_TO}`);
});
