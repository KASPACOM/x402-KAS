/**
 * E2E Test: Deploy via covenant-sdk (with CovenantBinding) + settle with change
 * Uses the covenant-sdk's deployContract() which properly attaches CovenantBinding,
 * then tests if validateOutputState works with proper covenant continuation.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  patchChannelContract,
  getCovenantAddress,
  extractPatchDescriptor,
  buildSigScript,
  signInput,
  bytesToHex,
  connectRpc,
  getAddressUtxos,
} from "../packages/covenant/dist/index.js";
import {
  PrivateKey,
  Transaction,
  TransactionOutput,
  ScriptBuilder,
  CovenantBinding,
  Hash,
  payToAddressScript,
  payToScriptHashScript,
  createTransactions,
  addressFromScriptPublicKey,
  type ITransactionInput,
  Encoding,
  RpcClient,
} from "../packages/kaspa-wasm/kaspa.js";
import { STANDARD_FEE, SUBNETWORK_ID_NATIVE } from "../packages/types/dist/index.js";
import type { ChannelConfig, ChannelParams } from "../packages/covenant/dist/index.js";
import type { CompiledContract } from "../packages/types/dist/index.js";
import { blake2b } from "@noble/hashes/blake2b";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const DEPLOY_AMOUNT = 100_000_000n; // 1 KAS

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}
function toScriptBytes(c: CompiledContract): Uint8Array { return Uint8Array.from(c.script); }
function writeU16LE(v: number) { const b = new Uint8Array(2); b[0]=v&0xff; b[1]=(v>>>8)&0xff; return b; }
function writeU32LE(v: number) { const b = new Uint8Array(4); b[0]=v&0xff; b[1]=(v>>>8)&0xff; b[2]=(v>>>16)&0xff; b[3]=(v>>>24)&0xff; return b; }
function writeU64LE(v: bigint) { const b = new Uint8Array(8); for(let i=0;i<8;i++) b[i]=Number((v>>BigInt(i*8))&0xffn); return b; }

const COV_KEY = new TextEncoder().encode("CovenantID");
function computeCovenantId(txid: string, idx: number, outs: {index:number;value:bigint;ver:number;script:Uint8Array}[]): string {
  const parts: Uint8Array[] = [hexToBytes(txid), writeU32LE(idx), writeU64LE(BigInt(outs.length))];
  for (const o of outs) { parts.push(writeU32LE(o.index), writeU64LE(o.value), writeU16LE(o.ver), writeU64LE(BigInt(o.script.length)), o.script); }
  const total = parts.reduce((s,p) => s+p.length, 0);
  const pre = new Uint8Array(total); let off=0;
  for (const p of parts) { pre.set(p, off); off += p.length; }
  return Array.from(blake2b(pre, { key: COV_KEY, dkLen: 32 })).map(b => b.toString(16).padStart(2,"0")).join("");
}

function findOutputIndex(tx: Transaction, address: string): number {
  return tx.outputs.findIndex((o: any) => {
    const a = addressFromScriptPublicKey(o.scriptPublicKey, NETWORK);
    return a?.toString() === address;
  });
}

async function main() {
  console.log("=== E2E: Deploy via WASM + Settle with CovenantBinding ===\n");

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
  const channelConfig: ChannelConfig = { compiledTemplate: compiled, patchDescriptor, network: NETWORK, rpcUrl: RPC_URL };

  const timeout = Math.floor(Date.now() / 1000) + 86400;
  const params: ChannelParams = { clientPubkey, facilitatorPubkey, timeout, nonce: 0 };

  const patched = patchChannelContract(channelConfig, params);
  const channelAddress = getCovenantAddress(patched, NETWORK);
  const contractSpk = payToScriptHashScript(toScriptBytes(patched));

  // ── Step 1: Deploy via WASM createTransactions (with CovenantBinding) ──
  console.log("\n1. Deploy via WASM createTransactions...");
  console.log(`   Channel: ${channelAddress}`);

  const rpc = connectRpc(RPC_URL, NETWORK);
  await rpc.connect();

  const senderUtxos = await getAddressUtxos(rpc, clientAddress);
  console.log(`   Sender UTXOs: ${senderUtxos.length}`);

  const created = await createTransactions({
    entries: senderUtxos,
    outputs: [{ address: channelAddress, amount: DEPLOY_AMOUNT }],
    changeAddress: clientAddress,
    priorityFee: 0n,
    networkId: NETWORK,
  } as never);

  console.log(`   TX count: ${created.transactions.length}`);

  let deployTxId: string = "";
  let deployTx: Transaction | undefined;
  let genesisCovenantId: string = "";

  for (let i = 0; i < created.transactions.length; i++) {
    const pending = created.transactions[i];
    const isLast = i === created.transactions.length - 1;

    if (isLast) {
      // Attach CovenantBinding to the covenant output
      const covOutputIdx = findOutputIndex(pending.transaction, channelAddress);
      if (covOutputIdx !== -1) {
        const authInput = pending.transaction.inputs[0];
        const spkScript = typeof contractSpk.script === 'string' ? hexToBytes(contractSpk.script) : contractSpk.script;

        const covenantId = computeCovenantId(
          authInput.previousOutpoint.transactionId,
          authInput.previousOutpoint.index,
          [{ index: covOutputIdx, value: DEPLOY_AMOUNT, ver: contractSpk.version, script: spkScript }],
        );
        console.log(`   Genesis covenant ID: ${covenantId}`);
        genesisCovenantId = covenantId;

        try {
          const hashObj = new Hash(covenantId);
          const binding = new CovenantBinding(covOutputIdx, hashObj);
          const existingOutput = pending.transaction.outputs[covOutputIdx];
          pending.transaction.outputs[covOutputIdx] = new TransactionOutput(
            existingOutput.value, existingOutput.scriptPublicKey, binding,
          );
          // Version 1 required for CovenantBinding
          (pending.transaction as any).version = 1;
          console.log(`   CovenantBinding attached to output ${covOutputIdx}, version set to 1`);
        } catch (err) {
          console.warn(`   CovenantBinding failed:`, err);
        }
      }
    }

    pending.sign([clientPk]);
    deployTxId = await pending.submit(rpc);
    deployTx = pending.transaction;
    console.log(`   Submitted tx ${i+1}: ${deployTxId}`);
  }

  const deployOutIdx = findOutputIndex(deployTx!, channelAddress);
  console.log(`   Deploy outpoint: ${deployTxId}:${deployOutIdx}`);

  // ── Wait for UTXO ──
  console.log("\n   Waiting for UTXO...");
  let entry;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const utxos = await getAddressUtxos(rpc, channelAddress);
    entry = utxos.find(u => u.outpoint.transactionId === deployTxId && u.outpoint.index === deployOutIdx);
    if (entry) break;
    process.stdout.write(".");
  }
  console.log();
  if (!entry) { console.error("UTXO not found"); process.exit(1); }
  console.log(`   UTXO: ${entry.amount} sompi`);

  // Check if UTXO has covenantId
  try {
    const covId = (entry as any).covenantId;
    console.log(`   UTXO covenantId: ${covId?.toString() || 'none'}`);
  } catch { console.log(`   UTXO covenantId: not available`); }

  // ── Step 2: Settle with change + CovenantBinding ──
  console.log("\n2. Build settle TX (0.1 KAS + change)...");

  const paymentAmount = 10_000_000n;
  const fee = STANDARD_FEE;
  const remainder = entry.amount - paymentAmount - fee;
  console.log(`   Payment: ${paymentAmount}, Fee: ${fee}, Change: ${remainder}`);

  // Nonce+1 change address
  const nextParams = { ...params, nonce: 1 };
  const nextPatched = patchChannelContract(channelConfig, nextParams);
  const nextAddress = getCovenantAddress(nextPatched, NETWORK);
  const nextSpk = payToScriptHashScript(toScriptBytes(nextPatched));
  console.log(`   Change: ${nextAddress} (nonce=1)`);

  // Get covenant ID from the UTXO or re-derive
  let utxoCovenantId: string | undefined;
  try {
    const cid = (entry as any).covenantId;
    if (cid) utxoCovenantId = cid.toString();
  } catch {}

  if (!utxoCovenantId) {
    // No covenant ID on UTXO — compute genesis covenant ID for THIS spend TX
    // Genesis = input[0] outpoint + authorized outputs
    const nextSpkScript = typeof nextSpk.script === 'string' ? hexToBytes(nextSpk.script) : nextSpk.script;
    utxoCovenantId = computeCovenantId(
      entry.outpoint.transactionId,
      entry.outpoint.index,
      [{ index: 1, value: remainder, ver: nextSpk.version, script: nextSpkScript }],
    );
    console.log(`   Computed genesis covenant ID for settle TX: ${utxoCovenantId}`);
  }

  // Build TX inputs
  const txInputs: ITransactionInput[] = [{
    previousOutpoint: entry.outpoint,
    utxo: entry,
    sequence: 0n,
    sigOpCount: 2,
  }];

  // Build outputs
  const paymentOutput = { scriptPublicKey: payToAddressScript(facilitatorAddress), value: paymentAmount };

  // Try with CovenantBinding on change output if we have covenant ID
  let txVersion = 0;
  let changeOutput: any;

  if (utxoCovenantId) {
    txVersion = 1;
    try {
      const hashObj = new Hash(utxoCovenantId);
      const binding = new CovenantBinding(0, hashObj); // authorizing_input = 0
      changeOutput = new TransactionOutput(remainder, nextSpk, binding);
      console.log(`   Continuation CovenantBinding attached`);
    } catch (err) {
      console.warn(`   CovenantBinding failed:`, err);
      changeOutput = { scriptPublicKey: nextSpk, value: remainder };
    }
  } else {
    changeOutput = { scriptPublicKey: nextSpk, value: remainder };
  }

  const unsignedTx = new Transaction({
    version: txVersion,
    lockTime: 0n,
    inputs: txInputs,
    outputs: [paymentOutput, changeOutput],
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: "",
  });

  console.log(`   TX: version=${txVersion}, ${unsignedTx.inputs.length} in, ${unsignedTx.outputs.length} out`);

  // ── Sign ──
  console.log("\n3. Sign...");
  const clientSig = signInput(unsignedTx, 0, clientPk);
  const facilitatorSig = signInput(unsignedTx, 0, facilitatorPk);
  console.log(`   Client: ${bytesToHex(clientSig).substring(0, 20)}... Fac: ${bytesToHex(facilitatorSig).substring(0, 20)}...`);

  const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
  unsignedTx.inputs[0].signatureScript = ScriptBuilder.fromScript(
    toScriptBytes(patched),
  ).encodePayToScriptHashSignatureScript(sigPrefix);

  // ── Broadcast ──
  console.log("\n4. Broadcasting...");
  try {
    const result = await rpc.submitTransaction({ transaction: unsignedTx, allowOrphan: false });
    console.log(`\n========================================`);
    console.log(`  SETTLE SUCCESS!`);
    console.log(`========================================`);
    console.log(`TX:      ${result.transactionId}`);
    console.log(`Explorer: https://tn12.kaspa.stream/transactions/${result.transactionId}`);
    console.log(`Payment: ${paymentAmount} → ${facilitatorAddress}`);
    console.log(`Change:  ${remainder} → ${nextAddress} (nonce=1)`);
  } catch (err) {
    console.error(`\n=== FAILED ===`);
    console.error(err instanceof Error ? err.message : err);
  }

  await rpc.disconnect();
}

main().catch(console.error);
