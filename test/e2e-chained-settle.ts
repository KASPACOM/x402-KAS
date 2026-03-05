/**
 * E2E Test: Chained settle on TN12
 *
 * 1. Deploy covenant via WASM (lock 1 KAS, nonce=0)
 * 2. Settle #1: pay 0.1 KAS, change → nonce=1
 * 3. Settle #2: pay 0.1 KAS from nonce=1 UTXO, change → nonce=2
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  patchChannelContract,
  deployContract,
  connectRpc,
  getAddressUtxos,
  getCovenantAddress,
  buildUnsignedCovenantTx,
  buildSigScript,
  attachSigScript,
  signInput,
  bytesToHex,
  extractPatchDescriptor,
} from "../packages/covenant/dist/index.js";
import { PrivateKey } from "../packages/kaspa-wasm/kaspa.js";
import { STANDARD_FEE } from "../packages/types/dist/index.js";
import type { ChannelConfig, ChannelParams } from "../packages/covenant/dist/index.js";
import type { CompiledContract, SpendOutput } from "../packages/types/dist/index.js";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const DEPLOY_AMOUNT = 100_000_000n; // 1 KAS
const PAYMENT_AMOUNT = 10_000_000n; // 0.1 KAS per settle

async function waitForUtxo(rpc: any, address: string, txid: string, vout: number, maxWait = 60) {
  for (let i = 0; i < maxWait / 2; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const utxos = await getAddressUtxos(rpc, address);
    const entry = utxos.find(
      (u: any) => u.outpoint.transactionId === txid && u.outpoint.index === vout,
    );
    if (entry) return entry;
    process.stdout.write(".");
  }
  throw new Error(`UTXO ${txid}:${vout} not found at ${address} after ${maxWait}s`);
}

async function settle(
  rpc: any,
  channelConfig: ChannelConfig,
  params: ChannelParams,
  entry: any,
  payTo: string,
  clientPk: any,
  facilitatorPk: any,
): Promise<{ txid: string; changeAmount: bigint; nextAddress: string }> {
  const patched = patchChannelContract(channelConfig, params);
  const fee = STANDARD_FEE;
  const inputAmount = entry.amount;
  const remainder = inputAmount - PAYMENT_AMOUNT - fee;

  const outputs: SpendOutput[] = [{ address: payTo, amount: PAYMENT_AMOUNT }];

  let nextAddress = "";
  if (remainder > fee) {
    const nextParams = { ...params, nonce: params.nonce + 1 };
    const nextPatched = patchChannelContract(channelConfig, nextParams);
    nextAddress = getCovenantAddress(nextPatched, NETWORK);
    outputs.push({ address: nextAddress, amount: remainder });
  }

  const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 2);
  const clientSig = signInput(unsignedTx, 0, clientPk);
  const facilitatorSig = signInput(unsignedTx, 0, facilitatorPk);
  const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
  attachSigScript(unsignedTx, 0, patched, sigPrefix);

  const result = await rpc.submitTransaction({ transaction: unsignedTx, allowOrphan: false });
  return { txid: result.transactionId, changeAmount: remainder, nextAddress };
}

async function main() {
  console.log("=== E2E: Chained Settle (nonce 0→1→2) on TN12 ===\n");

  const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));
  const clientPrivateKey = wallet.privateKey;
  const clientPk = new PrivateKey(clientPrivateKey);
  const clientPubkey = clientPk.toPublicKey().toXOnlyPublicKey().toString();

  const facilitatorPrivateKey = randomBytes(32).toString("hex");
  const facilitatorPk = new PrivateKey(facilitatorPrivateKey);
  const facilitatorPubkey = facilitatorPk.toPublicKey().toXOnlyPublicKey().toString();
  const facilitatorAddress = facilitatorPk.toAddress(NETWORK).toString();

  console.log(`Client pubkey:      ${clientPubkey}`);
  console.log(`Facilitator pubkey: ${facilitatorPubkey}`);
  console.log(`Facilitator addr:   ${facilitatorAddress}\n`);

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

  const timeout = Math.floor(Date.now() / 1000) + 86400;

  // ── Step 1: Deploy (nonce=0) ──────────────────
  console.log("1. Deploy covenant (1 KAS)...");
  const params0: ChannelParams = { clientPubkey, facilitatorPubkey, timeout, nonce: 0 };
  const patched0 = patchChannelContract(channelConfig, params0);
  const addr0 = getCovenantAddress(patched0, NETWORK);

  const deployResult = await deployContract(patched0, DEPLOY_AMOUNT, RPC_URL, clientPrivateKey, NETWORK);
  console.log(`   TX: ${deployResult.txid}`);
  console.log(`   Address: ${addr0}`);

  const rpc = connectRpc(RPC_URL, NETWORK);
  await rpc.connect();

  console.log("   Waiting for UTXO...");
  const entry0 = await waitForUtxo(rpc, addr0, deployResult.txid, deployResult.outpoint.vout);
  console.log(`\n   UTXO: ${entry0.amount} sompi\n`);

  // ── Step 2: Settle #1 (nonce 0→1) ──────────────
  console.log("2. Settle #1 (nonce 0→1, pay 0.1 KAS)...");
  const result1 = await settle(rpc, channelConfig, params0, entry0, facilitatorAddress, clientPk, facilitatorPk);
  console.log(`   TX: ${result1.txid}`);
  console.log(`   Change: ${result1.changeAmount} sompi → ${result1.nextAddress}`);
  console.log(`   Explorer: https://tn12.kaspa.stream/transactions/${result1.txid}`);

  // ── Step 3: Wait for nonce=1 UTXO ──────────────
  console.log("\n   Waiting for nonce=1 UTXO...");
  // The change output is at index 1
  const entry1 = await waitForUtxo(rpc, result1.nextAddress, result1.txid, 1);
  console.log(`\n   UTXO: ${entry1.amount} sompi\n`);

  // ── Step 4: Settle #2 (nonce 1→2) ──────────────
  console.log("3. Settle #2 (nonce 1→2, pay 0.1 KAS)...");
  const params1: ChannelParams = { clientPubkey, facilitatorPubkey, timeout, nonce: 1 };
  const result2 = await settle(rpc, channelConfig, params1, entry1, facilitatorAddress, clientPk, facilitatorPk);
  console.log(`   TX: ${result2.txid}`);
  console.log(`   Change: ${result2.changeAmount} sompi → ${result2.nextAddress}`);
  console.log(`   Explorer: https://tn12.kaspa.stream/transactions/${result2.txid}`);

  console.log("\n============================================");
  console.log("  CHAINED SETTLE SUCCESSFUL! (nonce 0→1→2)");
  console.log("============================================\n");

  await rpc.disconnect();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
