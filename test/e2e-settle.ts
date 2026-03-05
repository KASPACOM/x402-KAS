/**
 * E2E Test: Full settle flow on TN12
 *
 * 1. Deploy covenant via WASM (lock 1 KAS)
 * 2. Client builds partial settle TX (signs client half)
 * 3. Facilitator co-signs + broadcasts
 * 4. Verify TX on chain
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  patchChannelContract,
  getChannelAddress,
  buildPartialSettle,
  deployContract,
  connectRpc,
  getAddressUtxos,
  getCovenantAddress,
  buildUnsignedCovenantTx,
  buildSigScript,
  attachSigScript,
  signInput,
  hexToBytes,
  bytesToHex,
  extractPatchDescriptor,
} from "../packages/covenant/dist/index.js";
import { PrivateKey, type RpcClient } from "../packages/kaspa-wasm/kaspa.js";
import { STANDARD_FEE } from "../packages/types/dist/index.js";
import type { ChannelConfig, ChannelParams } from "../packages/covenant/dist/index.js";
import type { CompiledContract, SpendOutput } from "../packages/types/dist/index.js";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const DEPLOY_AMOUNT = 100_000_000n; // 1 KAS

async function main() {
  console.log("=== E2E: Full Settle Test on TN12 ===\n");

  // ── Load keys ──────────────────────────────────────────
  const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));
  const clientPrivateKey = wallet.privateKey;
  const clientPk = new PrivateKey(clientPrivateKey);
  const clientPubkey = clientPk.toPublicKey().toXOnlyPublicKey().toString();
  const clientAddress = clientPk.toAddress(NETWORK).toString();

  // Generate a fresh facilitator key for this test
  const facilitatorPrivateKey = randomBytes(32).toString("hex");
  const facilitatorPk = new PrivateKey(facilitatorPrivateKey);
  const facilitatorPubkey = facilitatorPk.toPublicKey().toXOnlyPublicKey().toString();
  const facilitatorAddress = facilitatorPk.toAddress(NETWORK).toString();

  console.log("Client:");
  console.log(`  Address: ${clientAddress}`);
  console.log(`  Pubkey:  ${clientPubkey}`);
  console.log("Facilitator:");
  console.log(`  Address: ${facilitatorAddress}`);
  console.log(`  Pubkey:  ${facilitatorPubkey}`);
  console.log();

  // ── Load compiled covenant ─────────────────────────────
  const compiled: CompiledContract = JSON.parse(
    readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"),
  );
  const ctorArgs = JSON.parse(
    readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"),
  );
  const patchDescriptor = extractPatchDescriptor(compiled, ctorArgs);

  const channelConfig: ChannelConfig = {
    compiledTemplate: compiled,
    patchDescriptor,
    network: NETWORK,
    rpcUrl: RPC_URL,
  };

  const timeout = Math.floor(Date.now() / 1000) + 86400; // 24h from now
  const nonce = 0;

  const params: ChannelParams = {
    clientPubkey,
    facilitatorPubkey,
    timeout,
    nonce,
  };

  // ── Step 1: Deploy covenant via WASM ──────────────────
  console.log("Step 1: Deploy covenant (1 KAS via WASM)...");
  const patched = patchChannelContract(channelConfig, params);
  const channelAddress = getCovenantAddress(patched, NETWORK);
  console.log(`  Channel address: ${channelAddress}`);

  let deployResult;
  try {
    deployResult = await deployContract(patched, DEPLOY_AMOUNT, RPC_URL, clientPrivateKey, NETWORK);
  } catch (err) {
    console.error("  Deploy failed:", err);
    process.exit(1);
  }
  console.log(`  TX:      ${deployResult.txid}`);
  console.log(`  Outpoint: ${deployResult.txid}:${deployResult.outpoint.vout}`);
  console.log(`  Explorer: https://tn12.kaspa.stream/transactions/${deployResult.txid}`);
  console.log();

  // Wait for UTXO to appear
  console.log("  Waiting for UTXO to be visible...");
  const rpc = connectRpc(RPC_URL, NETWORK);
  await rpc.connect();

  let utxos;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    utxos = await getAddressUtxos(rpc, channelAddress);
    if (utxos.length > 0) break;
    process.stdout.write(".");
  }
  console.log();

  if (!utxos || utxos.length === 0) {
    console.error("  UTXO never appeared after 60s. Check explorer.");
    await rpc.disconnect();
    process.exit(1);
  }

  const entry = utxos.find(
    (u) =>
      u.outpoint.transactionId === deployResult.txid &&
      u.outpoint.index === deployResult.outpoint.vout,
  );
  if (!entry) {
    console.error("  Deployed UTXO not found at expected outpoint");
    console.error("  Available UTXOs:", utxos.map((u) => `${u.outpoint.transactionId}:${u.outpoint.index}`));
    await rpc.disconnect();
    process.exit(1);
  }
  console.log(`  UTXO confirmed: ${entry.amount} sompi`);
  console.log();

  // ── Step 2: Client builds partial settle ────────────────
  console.log("Step 2: Client builds partial settle TX...");

  // Payment: send 0.1 KAS to facilitator address (as the merchant receiving payment)
  const paymentAmount = 10_000_000n; // 0.1 KAS
  const payTo = facilitatorAddress; // facilitator is the "merchant" in this test
  const fee = STANDARD_FEE;
  const inputAmount = entry.amount;
  const remainder = inputAmount - paymentAmount - fee;

  console.log(`  Input:     ${inputAmount} sompi`);
  console.log(`  Payment:   ${paymentAmount} sompi → ${payTo}`);
  console.log(`  Fee:       ${fee} sompi`);
  console.log(`  Remainder: ${remainder} sompi`);

  const outputs: SpendOutput[] = [{ address: payTo, amount: paymentAmount }];

  if (remainder > fee) {
    // Change goes back to covenant with nonce+1
    const nextParams = { ...params, nonce: params.nonce + 1 };
    const nextPatched = patchChannelContract(channelConfig, nextParams);
    const nextAddress = getCovenantAddress(nextPatched, NETWORK);
    outputs.push({ address: nextAddress, amount: remainder });
    console.log(`  Change:    ${remainder} sompi → ${nextAddress} (nonce=${nextParams.nonce})`);
  }

  // Build unsigned TX (sigOpCount = 2 for 2x checkSig)
  const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 2);
  console.log(`  TX built: ${unsignedTx.inputs.length} input, ${unsignedTx.outputs.length} outputs`);

  // Client signs
  const clientSig = signInput(unsignedTx, 0, clientPk);
  console.log(`  Client signature: ${bytesToHex(clientSig).substring(0, 40)}... (${clientSig.length} bytes)`);
  console.log();

  // ── Step 3: Facilitator co-signs ────────────────────────
  console.log("Step 3: Facilitator co-signs...");

  // Use the SAME unsigned TX for facilitator signing (eliminates TX construction diffs)
  const facilitatorSig = signInput(unsignedTx, 0, facilitatorPk);
  console.log(`  Facilitator signature: ${bytesToHex(facilitatorSig).substring(0, 40)}... (${facilitatorSig.length} bytes)`);

  // Build complete sigscript: [clientSig, facilitatorSig, selector:0]
  const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
  attachSigScript(unsignedTx, 0, patched, sigPrefix);
  console.log(`  Sigscript attached`);
  console.log(`  TX inputs: ${unsignedTx.inputs.length}, outputs: ${unsignedTx.outputs.length}`);
  console.log();

  // ── Step 4: Broadcast ───────────────────────────────────
  console.log("Step 4: Broadcasting settle TX...");
  try {
    const result = await rpc.submitTransaction({
      transaction: unsignedTx,
      allowOrphan: false,
    });
    const settleTxid = result.transactionId;
    console.log();
    console.log("============================================");
    console.log("  SETTLE SUCCESSFUL!");
    console.log("============================================");
    console.log(`  TX:       ${settleTxid}`);
    console.log(`  Explorer: https://tn12.kaspa.stream/transactions/${settleTxid}`);
    console.log(`  Payment:  ${paymentAmount} sompi → ${payTo}`);
    if (remainder > fee) {
      console.log(`  Change:   ${remainder} sompi → covenant (nonce=1)`);
    }
    console.log();
  } catch (err) {
    console.error();
    console.error("============================================");
    console.error("  SETTLE FAILED");
    console.error("============================================");
    console.error("  Error:", err);
    console.error();
    console.error("  This likely means:");
    console.error("  - Signature mismatch (sighash differs between client/facilitator TX)");
    console.error("  - Covenant script validation failed");
    console.error("  - UTXO was already spent");
  }

  await rpc.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
