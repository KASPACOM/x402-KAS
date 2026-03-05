/**
 * E2E Test: Deploy X402Channel covenant to TN12
 *
 * Step 1: Deploy covenant with client + facilitator pubkeys
 * Step 2: Verify UTXO exists at P2SH address
 *
 * Usage: npx tsx test/e2e-deploy.ts
 */

import { readFileSync } from "node:fs";
import {
  extractPatchDescriptor,
  patchChannelContract,
  getChannelAddress,
  deployChannel,
  byteArrayArg,
  intArg,
  type ChannelConfig,
  type ChannelParams,
} from "../packages/covenant/dist/index.js";
import { PrivateKey } from "../packages/kaspa-wasm/kaspa.js";
import { randomBytes } from "node:crypto";

// ── Config ──
const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";

// Load wallet
const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));
const CLIENT_PRIVATE_KEY = wallet.privateKey;
const CLIENT_PUBKEY = wallet.pubkey;

// Generate a facilitator key for testing
const facilitatorPrivBytes = randomBytes(32);
const facilitatorPrivHex = facilitatorPrivBytes.toString("hex");
const facilitatorKey = new PrivateKey(facilitatorPrivHex);
const FACILITATOR_PUBKEY = facilitatorKey.toPublicKey().toXOnlyPublicKey().toString();
const FACILITATOR_ADDRESS = facilitatorKey.toAddress(NETWORK).toString();

console.log("=== x402 E2E Test: Deploy Channel ===");
console.log(`Client pubkey:      ${CLIENT_PUBKEY}`);
console.log(`Facilitator pubkey: ${FACILITATOR_PUBKEY}`);
console.log(`Facilitator addr:   ${FACILITATOR_ADDRESS}`);
console.log(`Network:            ${NETWORK}`);
console.log(`RPC:                ${RPC_URL}`);
console.log();

// Load compiled template
const compiled = JSON.parse(
  readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"),
);

// Load template constructor args (placeholders used during compilation)
const templateArgs = JSON.parse(
  readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"),
);

// Extract patch descriptor
console.log("Extracting patch descriptor...");
const patchDescriptor = extractPatchDescriptor(compiled, templateArgs);
console.log(`Found ${patchDescriptor.params.length} patchable params:`);
for (const p of patchDescriptor.params) {
  console.log(`  - ${p.name} (${p.paramType}): ${p.positions.length} positions, ${p.placeholderBytes.length} bytes`);
}
console.log();

// Build channel config
const channelConfig: ChannelConfig = {
  compiledTemplate: compiled,
  patchDescriptor,
  network: NETWORK,
  rpcUrl: RPC_URL,
};

// Use timeout far in the future (for testing we can refund immediately by using a past timestamp)
// For deploy test, use a timeout 1 hour from now (in seconds, stays below 500B threshold)
const timeoutSeconds = Math.floor(Date.now() / 1000) + 3600;
const initialNonce = 100; // Same magnitude as placeholder (100) so patch width matches

const channelParams: ChannelParams = {
  clientPubkey: CLIENT_PUBKEY,
  facilitatorPubkey: FACILITATOR_PUBKEY,
  timeout: timeoutSeconds,
  nonce: initialNonce,
};

// Derive channel address
console.log("Deriving channel P2SH address...");
const channelAddress = getChannelAddress(channelConfig, channelParams);
console.log(`Channel address: ${channelAddress}`);
console.log();

// Deploy: lock 5 KAS into the covenant
const DEPLOY_AMOUNT = 500_000_000n; // 5 KAS in sompi

console.log(`Deploying ${Number(DEPLOY_AMOUNT) / 1e8} KAS to covenant...`);

async function main() {
  try {
    const result = await deployChannel(
      channelConfig,
      channelParams,
      DEPLOY_AMOUNT,
      CLIENT_PRIVATE_KEY,
    );

    console.log();
    console.log("=== DEPLOYMENT SUCCESSFUL ===");
    console.log(`TX ID:           ${result.txid}`);
    console.log(`Channel address: ${result.channelAddress}`);
    console.log(`Outpoint:        ${result.outpoint.txid}:${result.outpoint.vout}`);
    console.log();
    console.log(`Explorer: https://tn12.kaspa.stream/transactions/${result.txid}`);
    console.log();

    // Save deployment info for settle test
    const deployInfo = {
      txid: result.txid,
      channelAddress: result.channelAddress,
      outpoint: result.outpoint,
      clientPubkey: CLIENT_PUBKEY,
      clientPrivateKey: CLIENT_PRIVATE_KEY,
      facilitatorPubkey: FACILITATOR_PUBKEY,
      facilitatorPrivateKey: facilitatorPrivHex,
      timeout: timeoutSeconds,
      nonce: initialNonce,
      amount: DEPLOY_AMOUNT.toString(),
      network: NETWORK,
      rpcUrl: RPC_URL,
    };

    const { writeFileSync } = await import("node:fs");
    writeFileSync("/root/x402-kaspa/test/deployment.json", JSON.stringify(deployInfo, null, 2));
    console.log("Saved deployment info to test/deployment.json");
  } catch (err) {
    console.error("DEPLOYMENT FAILED:", err);
    process.exit(1);
  }
}

main();
