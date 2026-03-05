/**
 * E2E Test: Settle with change output + CovenantBinding
 * Tests whether CovenantBinding is required for validateOutputState to work.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  patchChannelContract,
  getCovenantAddress,
  deployContract,
  connectRpc,
  getAddressUtxos,
  buildSigScript,
  signInput,
  bytesToHex,
  extractPatchDescriptor,
} from "../packages/covenant/dist/index.js";
import {
  PrivateKey,
  Transaction,
  TransactionOutput,
  ScriptBuilder,
  payToAddressScript,
  payToScriptHashScript,
  CovenantBinding,
  Hash,
  type ITransactionInput,
  type ITransactionOutput,
} from "../packages/kaspa-wasm/kaspa.js";
import { STANDARD_FEE, SUBNETWORK_ID_NATIVE } from "../packages/types/dist/index.js";
import type { ChannelConfig, ChannelParams } from "../packages/covenant/dist/index.js";
import type { CompiledContract, SpendOutput } from "../packages/types/dist/index.js";
import { blake2b } from "@noble/hashes/blake2b";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const DEPLOY_AMOUNT = 100_000_000n; // 1 KAS

// ─── Helpers ───────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function toScriptBytes(compiled: CompiledContract): Uint8Array {
  return Uint8Array.from(compiled.script);
}

function writeU16LE(v: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff;
  return b;
}
function writeU32LE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff;
  return b;
}
function writeU64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(i * 8)) & 0xffn);
  return b;
}

const COVENANT_ID_KEY = new TextEncoder().encode("CovenantID");

function computeCovenantId(
  outpointTxId: string,
  outpointIndex: number,
  authOutputs: Array<{ index: number; value: bigint; scriptVersion: number; scriptBytes: Uint8Array }>,
): string {
  const parts: Uint8Array[] = [];
  parts.push(hexToBytes(outpointTxId));
  parts.push(writeU32LE(outpointIndex));
  parts.push(writeU64LE(BigInt(authOutputs.length)));
  for (const out of authOutputs) {
    parts.push(writeU32LE(out.index));
    parts.push(writeU64LE(out.value));
    parts.push(writeU16LE(out.scriptVersion));
    parts.push(writeU64LE(BigInt(out.scriptBytes.length)));
    parts.push(out.scriptBytes);
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const preimage = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { preimage.set(p, offset); offset += p.length; }
  const hash = blake2b(preimage, { key: COVENANT_ID_KEY, dkLen: 32 });
  return Array.from(hash).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Main ──────────────────────────────────────────────

async function main() {
  console.log("=== E2E: Settle with CovenantBinding ===\n");

  const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));
  const clientPrivateKey = wallet.privateKey;
  const clientPk = new PrivateKey(clientPrivateKey);
  const clientPubkey = clientPk.toPublicKey().toXOnlyPublicKey().toString();
  const clientAddress = clientPk.toAddress(NETWORK).toString();

  const facilitatorPrivateKey = randomBytes(32).toString("hex");
  const facilitatorPk = new PrivateKey(facilitatorPrivateKey);
  const facilitatorPubkey = facilitatorPk.toPublicKey().toXOnlyPublicKey().toString();
  const facilitatorAddress = facilitatorPk.toAddress(NETWORK).toString();

  console.log(`Client:      ${clientPubkey}`);
  console.log(`Facilitator: ${facilitatorPubkey}`);

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
  const nonce = 0;
  const params: ChannelParams = { clientPubkey, facilitatorPubkey, timeout, nonce };

  // ── Deploy ──────────────────────────────────────────
  console.log("\n1. Deploy covenant (1 KAS)...");
  const patched = patchChannelContract(channelConfig, params);
  const channelAddress = getCovenantAddress(patched, NETWORK);
  console.log(`   Address: ${channelAddress}`);

  const deployResult = await deployContract(patched, DEPLOY_AMOUNT, RPC_URL, clientPrivateKey, NETWORK);
  console.log(`   TX: ${deployResult.txid}`);

  // ── Wait for UTXO ──────────────────────────────────
  const rpc = connectRpc(RPC_URL, NETWORK);
  await rpc.connect();
  let entry;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const utxos = await getAddressUtxos(rpc, channelAddress);
    entry = utxos.find(
      u => u.outpoint.transactionId === deployResult.txid && u.outpoint.index === deployResult.outpoint.vout,
    );
    if (entry) break;
    process.stdout.write(".");
  }
  console.log();
  if (!entry) { console.error("UTXO not found"); process.exit(1); }
  console.log(`   UTXO: ${entry.amount} sompi`);

  // ── Build settle TX with change ─────────────────────
  console.log("\n2. Build settle TX (0.1 KAS payment + change)...");
  const paymentAmount = 10_000_000n;
  const fee = STANDARD_FEE;
  const inputAmount = entry.amount;
  const remainder = inputAmount - paymentAmount - fee;

  console.log(`   Payment: ${paymentAmount} → ${facilitatorAddress}`);
  console.log(`   Fee:     ${fee}`);
  console.log(`   Change:  ${remainder}`);

  // Compute nonce+1 change address
  const nextParams = { ...params, nonce: params.nonce + 1 };
  const nextPatched = patchChannelContract(channelConfig, nextParams);
  const nextAddress = getCovenantAddress(nextPatched, NETWORK);
  console.log(`   Change addr: ${nextAddress} (nonce=${nextParams.nonce})`);

  // Build outputs
  const paymentSpk = payToAddressScript(facilitatorAddress);
  const changeSpk = payToScriptHashScript(toScriptBytes(nextPatched));

  // Compute genesis covenant ID from the SPEND TX's perspective
  // Since deploy was via WASM (no CovenantBinding yet), this spend IS the genesis.
  // The covenant ID is computed from: input[0] outpoint + authorized outputs
  // Authorized output = the change output (index 1) that goes back to covenant
  const changeSpkScript = typeof changeSpk.script === 'string' ? hexToBytes(changeSpk.script) : changeSpk.script;
  const covenantId = computeCovenantId(
    entry.outpoint.transactionId,
    entry.outpoint.index,
    [{ index: 1, value: remainder, scriptVersion: changeSpk.version, scriptBytes: changeSpkScript }],
  );
  console.log(`   Covenant ID: ${covenantId}`);

  // Create CovenantBinding for the change output (continuation)
  const hashObj = new Hash(covenantId);
  const changeBinding = new CovenantBinding(0, hashObj); // authorizing_input = 0
  console.log(`   CovenantBinding attached to change output`);

  // Build TX with CovenantBinding on change output
  const txInputs: ITransactionInput[] = [{
    previousOutpoint: entry.outpoint,
    utxo: entry,
    sequence: 0n,
    sigOpCount: 2,
  }];

  // Output 0: payment (no binding)
  // Output 1: change to covenant (with CovenantBinding)
  const txOutputs: any[] = [
    { scriptPublicKey: paymentSpk, value: paymentAmount },
  ];

  // Create TransactionOutput with CovenantBinding
  try {
    const changeOutput = new TransactionOutput(remainder, changeSpk, changeBinding);
    txOutputs.push(changeOutput);
    console.log(`   Change output has covenant binding: ${changeOutput.covenant !== undefined}`);
  } catch (err) {
    console.warn(`   CovenantBinding on output failed, falling back:`, err);
    txOutputs.push({ scriptPublicKey: changeSpk, value: remainder });
  }

  const unsignedTx = new Transaction({
    version: 1,  // Version 1 required for CovenantBinding
    lockTime: 0n,
    inputs: txInputs,
    outputs: txOutputs,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: "",
  });

  console.log(`   TX: ${unsignedTx.inputs.length} input, ${unsignedTx.outputs.length} outputs`);

  // ── Sign ────────────────────────────────────────────
  console.log("\n3. Sign (client + facilitator)...");
  const clientSig = signInput(unsignedTx, 0, clientPk);
  console.log(`   Client sig: ${bytesToHex(clientSig).substring(0, 30)}... (${clientSig.length}b)`);

  const facilitatorSig = signInput(unsignedTx, 0, facilitatorPk);
  console.log(`   Fac sig:    ${bytesToHex(facilitatorSig).substring(0, 30)}... (${facilitatorSig.length}b)`);

  // Attach sigscript
  const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
  unsignedTx.inputs[0].signatureScript = ScriptBuilder.fromScript(
    toScriptBytes(patched),
  ).encodePayToScriptHashSignatureScript(sigPrefix);

  // ── Broadcast ───────────────────────────────────────
  console.log("\n4. Broadcasting...");
  try {
    const result = await rpc.submitTransaction({ transaction: unsignedTx, allowOrphan: false });
    console.log(`\n=== SUCCESS === TX: ${result.transactionId}`);
    console.log(`Explorer: https://tn12.kaspa.stream/transactions/${result.transactionId}`);
    console.log(`Payment:  ${paymentAmount} sompi → ${facilitatorAddress}`);
    console.log(`Change:   ${remainder} sompi → ${nextAddress} (nonce=1)`);
  } catch (err) {
    console.error(`\n=== FAILED ===`);
    console.error(err instanceof Error ? err.message : err);

    // Fall back: try WITHOUT CovenantBinding to confirm it's the issue
    console.log("\n--- Retrying without CovenantBinding for comparison ---");
    const txOutputs2: ITransactionOutput[] = [
      { scriptPublicKey: paymentSpk, value: paymentAmount },
      { scriptPublicKey: changeSpk, value: remainder },
    ];
    const tx2 = new Transaction({
      version: 0, lockTime: 0n, inputs: txInputs, outputs: txOutputs2,
      subnetworkId: SUBNETWORK_ID_NATIVE, gas: 0n, payload: "",
    });
    const cSig2 = signInput(tx2, 0, clientPk);
    const fSig2 = signInput(tx2, 0, facilitatorPk);
    const sigPfx2 = buildSigScript(patched, "settle", [cSig2, fSig2]);
    tx2.inputs[0].signatureScript = ScriptBuilder.fromScript(
      toScriptBytes(patched),
    ).encodePayToScriptHashSignatureScript(sigPfx2);
    try {
      const r2 = await rpc.submitTransaction({ transaction: tx2, allowOrphan: false });
      console.log(`Without binding: SUCCESS TX: ${r2.transactionId}`);
    } catch (err2) {
      console.error(`Without binding: ALSO FAILED:`, err2 instanceof Error ? err2.message : err2);
    }
  }

  await rpc.disconnect();
}

main().catch(console.error);
