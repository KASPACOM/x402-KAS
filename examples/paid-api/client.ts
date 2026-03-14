/**
 * Example: x402 Client
 *
 * Demonstrates the full payment flow:
 * 1. Request a paid resource → get 402
 * 2. Parse payment requirements
 * 3. Open a payment channel (deploy covenant via WASM)
 * 4. Build payment (partial-sign settle TX)
 * 5. Retry request with payment header → get content
 *
 * Usage:
 *   CLIENT_PRIVATE_KEY=<hex> \
 *   API_URL=http://localhost:3000 \
 *   npx tsx examples/paid-api/client.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { X402Client } from "../../packages/client/dist/index.js";
import { extractPatchDescriptor } from "../../packages/covenant/dist/index.js";
import type { KaspaNetwork, CompiledContract, PaymentRequired } from "../../packages/types/dist/index.js";
import { w3cwebsocket } from "websocket";
globalThis.WebSocket = w3cwebsocket as any;

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const NETWORK = (process.env.KASPA_NETWORK ?? "kaspa:testnet-12") as KaspaNetwork;
const RPC_URL = process.env.KASPA_RPC ?? "ws://tn12-node.kaspa.com:17210";
const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY ?? "";
const CHANNEL_FUNDING = BigInt(process.env.CHANNEL_FUNDING ?? "500000000"); // 5 KAS default

if (!PRIVATE_KEY) {
  console.error("Required: CLIENT_PRIVATE_KEY env var (64-char hex private key)");
  process.exit(1);
}

// Load compiled covenant template
const contractPath = process.env.COMPILED_CONTRACT_PATH
  ?? fileURLToPath(new URL("../../contracts/compiled/x402-channel-v4-locked.json", import.meta.url));
const ctorPath = process.env.CTOR_ARGS_PATH
  ?? fileURLToPath(new URL("../../contracts/silverscript/x402-channel-v4-locked-ctor.json", import.meta.url));

const compiledTemplate: CompiledContract = JSON.parse(readFileSync(contractPath, "utf-8"));
const ctorArgs = JSON.parse(readFileSync(ctorPath, "utf-8"));
const patchDescriptor = extractPatchDescriptor(compiledTemplate, ctorArgs);

async function main() {
  console.log("=== x402 Client Demo ===\n");

  // 1. Create client
  const client = new X402Client({
    privateKeyHex: PRIVATE_KEY,
    network: NETWORK,
    rpcUrl: RPC_URL,
    compiledTemplate,
    patchDescriptor,
    defaultFunding: CHANNEL_FUNDING,
  });

  console.log(`Client address: ${client.getAddress()}`);
  console.log(`Client pubkey:  ${client.getPubkey()}`);
  console.log();

  // 2. Request the paid resource (expect 402)
  console.log(`GET ${API_URL}/weather`);
  const res1 = await fetch(`${API_URL}/weather`);
  console.log(`Status: ${res1.status}`);

  if (res1.status !== 402) {
    console.log("Expected 402, got:", res1.status);
    console.log(await res1.text());
    return;
  }

  const paymentRequired: PaymentRequired = await res1.json();
  console.log("Payment required:");
  console.log(`  Amount: ${paymentRequired.accepts[0].amount} sompi`);
  console.log(`  PayTo:  ${paymentRequired.accepts[0].payTo}`);
  console.log(`  Facilitator: ${paymentRequired.accepts[0].extra.facilitatorPubkey.substring(0, 16)}...`);
  console.log();

  // 3. Find matching payment option
  const requirements = paymentRequired.accepts.find(
    (a) => a.network === NETWORK && a.scheme === "exact",
  );
  if (!requirements) {
    console.error("No compatible payment option found");
    return;
  }

  // 4. Build payment (opens channel if needed)
  console.log("Building payment (this will deploy a covenant if no channel exists)...");
  const paymentPayload = await client.buildPayment(requirements, paymentRequired.resource);
  console.log("Payment built!");
  console.log(`  Channel outpoint: ${paymentPayload.payload.channelOutpoint.txid.substring(0, 16)}...`);
  console.log(`  Nonce: ${paymentPayload.payload.currentNonce}`);
  console.log();

  // 5. Retry with payment
  console.log(`GET ${API_URL}/weather (with payment)`);
  const res2 = await fetch(`${API_URL}/weather`, {
    headers: {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload),
    },
  });
  console.log(`Status: ${res2.status}`);
  const data = await res2.json();
  console.log("Response:", JSON.stringify(data, null, 2));
  console.log();

  if (res2.status === 200) {
    console.log("=== Payment successful! ===");
    if (data.txid) {
      console.log(`TX: https://tn12.kaspa.stream/transactions/${data.txid}`);
    }
  } else {
    console.log("=== Payment failed ===");
  }
}

main().catch(console.error);
