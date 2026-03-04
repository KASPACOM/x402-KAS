/**
 * E2E: Manual transaction building (bypass createTransactions)
 * Build the TX by hand using Transaction constructor + sign
 */

import {
  RpcClient, Encoding, PrivateKey, Transaction,
  payToScriptHashScript, payToAddressScript, addressFromScriptPublicKey,
  createInputSignature, SighashType, ScriptBuilder,
} from "../packages/kaspa-wasm/kaspa.js";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const SUBNETWORK_ID = "0000000000000000000000000000000000000000";

const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));

async function main() {
  console.log("=== E2E: Manual TX Build ===\n");

  // 1. Connect
  const rpc = new RpcClient({ url: RPC_URL, encoding: Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  console.log("Connected to RPC");

  // 2. Get UTXOs
  const utxos = await rpc.getUtxosByAddresses([wallet.address]);
  console.log(`UTXOs: ${utxos.entries.length}`);
  const entry = utxos.entries[0];
  console.log(`  Input: ${entry.outpoint.transactionId}:${entry.outpoint.index} = ${entry.amount} sompi`);

  // 3. Prepare covenant address
  const { extractPatchDescriptor, applyPatch, byteArrayArg, intArg } = await import("../packages/covenant/dist/template-patcher.js");
  const { getCovenantAddress } = await import("../packages/covenant/dist/helpers.js");

  const compiled = JSON.parse(readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"));
  const templateArgs = JSON.parse(readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"));
  const patchDescriptor = extractPatchDescriptor(compiled, templateArgs);

  const facPriv = randomBytes(32).toString("hex");
  const facKey = new PrivateKey(facPriv);
  const facPubkey = facKey.toPublicKey().toXOnlyPublicKey().toString();
  const timeoutSeconds = Math.floor(Date.now() / 1000) + 3600;

  function hexToBytes(hex: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }

  const newArgs = [
    byteArrayArg(hexToBytes(wallet.pubkey)),
    byteArrayArg(hexToBytes(facPubkey)),
    intArg(timeoutSeconds),
    intArg(100),
  ];
  const patched = applyPatch(compiled, patchDescriptor, newArgs);
  const channelAddress = getCovenantAddress(patched, NETWORK);
  console.log(`Channel: ${channelAddress}`);

  // 4. Build TX manually
  const AMOUNT = 500_000_000n; // 5 KAS
  const FEE = 10_000n;
  const change = entry.amount - AMOUNT - FEE;

  console.log(`\nBuilding TX:`);
  console.log(`  Output 0: ${channelAddress} = ${AMOUNT} sompi (5 KAS)`);
  console.log(`  Output 1: ${wallet.address} = ${change} sompi (change)`);
  console.log(`  Fee: ${FEE} sompi`);

  const tx = new Transaction({
    version: 0,
    inputs: [{
      previousOutpoint: entry.outpoint,
      signatureScript: "",
      sequence: 0n,
      sigOpCount: 1,
    }],
    outputs: [
      {
        value: AMOUNT,
        scriptPublicKey: payToAddressScript(channelAddress),
      },
      {
        value: change,
        scriptPublicKey: payToAddressScript(wallet.address),
      },
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID,
    gas: 0n,
    payload: "",
  });

  console.log(`TX built (${tx.inputs.length} inputs, ${tx.outputs.length} outputs)`);

  // 5. Sign
  console.log("Signing...");
  const pk = new PrivateKey(wallet.privateKey);

  // Create signature
  const sig = createInputSignature(tx, 0, pk, SighashType.All);
  console.log(`  Signature: ${sig.substring(0, 20)}...`);

  // Build signature script (P2PK: push sig + push pubkey)
  const sigBytes = Uint8Array.from(sig.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));
  const pubkeyHex = pk.toPublicKey().toString();
  const pubkeyBytes = Uint8Array.from(pubkeyHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)));

  // For P2PK-schnorr, sigscript is just the signature
  const sigScript = new ScriptBuilder();
  sigScript.addData(sigBytes);
  sigScript.addData(pubkeyBytes);
  tx.inputs[0].signatureScript = sigScript.drain();

  console.log("Signed.");

  // 6. Submit
  console.log("Submitting...");
  try {
    const result = await rpc.submitTransaction({
      transaction: tx,
      allowOrphan: false,
    });
    const txid = result.transactionId;

    console.log(`\n=== DEPLOYMENT SUCCESSFUL ===`);
    console.log(`TX:      ${txid}`);
    console.log(`Channel: ${channelAddress}`);
    console.log(`Explorer: https://tn12.kaspa.stream/txs/${txid}`);

    // Find output index
    let vout = 0;
    for (let i = 0; i < tx.outputs.length; i++) {
      const outAddr = addressFromScriptPublicKey(tx.outputs[i].scriptPublicKey, NETWORK);
      if (outAddr?.toString() === channelAddress) { vout = i; break; }
    }

    writeFileSync("/root/x402-kaspa/test/deployment.json", JSON.stringify({
      txid,
      channelAddress,
      outpoint: { txid, vout },
      clientPubkey: wallet.pubkey,
      clientPrivateKey: wallet.privateKey,
      facilitatorPubkey: facPubkey,
      facilitatorPrivateKey: facPriv,
      timeout: timeoutSeconds,
      nonce: 100,
      amount: AMOUNT.toString(),
      network: NETWORK,
      rpcUrl: RPC_URL,
    }, null, 2));
    console.log("Saved: test/deployment.json");
  } catch (e) {
    console.error("Submit failed:", e);
  }

  await rpc.disconnect();
}

main().catch(console.error);
