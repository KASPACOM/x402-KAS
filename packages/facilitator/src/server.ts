/**
 * Kaspa x402 Facilitator HTTP Server
 * Exposes /verify, /settle, /supported, /health endpoints.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { KaspaFacilitator, type FacilitatorConfig } from "./facilitator.js";
import type { VerifyRequest, SettleRequest } from "@x402/kaspa-types";

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

  return server;
}
