/**
 * Kaspa x402 Facilitator HTTP Server
 * Exposes /verify, /settle, /supported, /health endpoints.
 *
 * Run standalone:
 *   FACILITATOR_PRIVATE_KEY=<hex> node dist/server.js
 *
 * Env vars:
 *   FACILITATOR_PRIVATE_KEY  — 64-char hex private key (required)
 *   KASPA_RPC                — wRPC URL (default: ws://tn12-node.kaspa.com:17210)
 *   KASPA_NETWORK            — CAIP-2 network (default: kaspa:testnet-12)
 *   PORT                     — Listen port (default: 4020)
 *   COMPILED_CONTRACT_PATH   — Path to compiled covenant JSON
 *   MIN_CONFIRMATIONS        — DAA score confirmations (default: 10)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { KaspaFacilitator, type FacilitatorConfig } from "./facilitator.js";
import { extractPatchDescriptor } from "@x402/kaspa-covenant";
import type { VerifyRequest, SettleRequest, KaspaNetwork, CompiledContract } from "@x402/kaspa-types";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function createFacilitatorServer(config: FacilitatorConfig) {
  const facilitator = new KaspaFacilitator(config);

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      // GET /supported
      if (req.method === "GET" && url.pathname === "/supported") {
        json(res, 200, facilitator.getSupported());
        return;
      }

      // GET /health
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          status: "ok",
          network: config.network,
          pubkey: facilitator.getPubkey(),
        });
        return;
      }

      // POST /verify
      if (req.method === "POST" && url.pathname === "/verify") {
        const body = await readBody(req);
        const request: VerifyRequest = JSON.parse(body);
        const result = await facilitator.verify(request);
        json(res, 200, result);
        return;
      }

      // POST /settle
      if (req.method === "POST" && url.pathname === "/settle") {
        const body = await readBody(req);
        const request: SettleRequest = JSON.parse(body);
        const result = await facilitator.settle(request);
        json(res, 200, result);
        return;
      }

      // 404
      json(res, 404, { error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[x402-facilitator] ${req.method} ${url.pathname}: ${message}`);
      json(res, 500, { error: message });
    }
  });

  return { server, facilitator };
}

// ----------------------------------------------------------
// Standalone startup
// ----------------------------------------------------------

const isMain = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");

if (isMain) {
  const privateKeyHex = process.env.FACILITATOR_PRIVATE_KEY;
  if (!privateKeyHex) {
    console.error("Error: FACILITATOR_PRIVATE_KEY env var is required (64-char hex)");
    process.exit(1);
  }

  const rpcUrl = process.env.KASPA_RPC ?? "ws://tn12-node.kaspa.com:17210";
  const network = (process.env.KASPA_NETWORK ?? "kaspa:testnet-12") as KaspaNetwork;
  const port = parseInt(process.env.PORT ?? "4020", 10);
  const minConfirmations = parseInt(process.env.MIN_CONFIRMATIONS ?? "10", 10);

  // Load compiled covenant template
  const contractPath = process.env.COMPILED_CONTRACT_PATH
    ?? new URL("../../../../contracts/compiled/x402-channel.json", import.meta.url).pathname;
  let compiledTemplate: CompiledContract;
  try {
    compiledTemplate = JSON.parse(readFileSync(contractPath, "utf-8"));
  } catch (err) {
    console.error(`Error: Cannot load compiled contract from ${contractPath}`);
    console.error("Set COMPILED_CONTRACT_PATH env var to the correct path");
    process.exit(1);
  }

  // Load constructor args template for patch descriptor
  const ctorPath = process.env.CTOR_ARGS_PATH
    ?? new URL("../../../../contracts/silverscript/x402-channel-ctor.json", import.meta.url).pathname;
  let ctorArgs: unknown;
  try {
    ctorArgs = JSON.parse(readFileSync(ctorPath, "utf-8"));
  } catch (err) {
    console.error(`Error: Cannot load constructor args from ${ctorPath}`);
    console.error("Set CTOR_ARGS_PATH env var to the correct path");
    process.exit(1);
  }

  const patchDescriptor = extractPatchDescriptor(compiledTemplate, ctorArgs as any);

  const config: FacilitatorConfig = {
    privateKeyHex,
    rpcUrl,
    network,
    compiledTemplate,
    patchDescriptor,
    minConfirmations,
  };

  const { server, facilitator } = createFacilitatorServer(config);

  // Graceful shutdown
  function shutdown() {
    console.log("\n[x402-facilitator] Shutting down...");
    server.close(() => {
      facilitator.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, () => {
    console.log(`[x402-facilitator] Listening on :${port}`);
    console.log(`[x402-facilitator] Network: ${network}`);
    console.log(`[x402-facilitator] Pubkey:  ${facilitator.getPubkey()}`);
    console.log(`[x402-facilitator] Health:  http://localhost:${port}/health`);
  });
}
