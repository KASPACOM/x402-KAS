/**
 * E2E Test: Deploy using UtxoProcessor + UtxoContext pattern
 * (matches how KASPACOM p2p-trade-service does it)
 */

import {
  RpcClient, Encoding, PrivateKey, UtxoProcessor, UtxoContext,
  createTransactions, payToScriptHashScript, addressFromScriptPublicKey,
} from "../packages/kaspa-wasm/kaspa.js";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";
const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== E2E Deploy with UtxoContext ===\n");

  // 1. Connect RPC
  console.log("1. Connecting RPC...");
  const rpc = new RpcClient({ url: RPC_URL, encoding: Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  console.log("   Connected.\n");

  // 2. Setup UtxoProcessor + UtxoContext
  console.log("2. Setting up UtxoProcessor...");
  const processor = new UtxoProcessor({ rpc, networkId: NETWORK });
  const context = new UtxoContext({ processor });

  // Listen for events
  processor.addEventListener("utxo-proc-start", () => {
    console.log("   Event: utxo-proc-start");
  });

  await processor.start();
  console.log("   Processor started.");

  // Track our address
  await context.clear();
  await context.trackAddresses([wallet.address]);
  console.log(`   Tracking: ${wallet.address}`);

  // Wait for UTXOs to settle
  console.log("   Waiting for UTXO sync...");
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const bal = context.balance;
    if (bal && bal.pending === 0n) {
      console.log(`   Balance: ${bal.mature} sompi (${Number(bal.mature) / 1e8} KAS)`);
      break;
    }
    if (i % 5 === 0) console.log(`   ... waiting (attempt ${i})`)
  }

  // 3. Prepare covenant
  console.log("\n3. Preparing covenant...");
  const { extractPatchDescriptor, applyPatch, byteArrayArg, intArg } = await import("../packages/covenant/dist/template-patcher.js");
  const { getCovenantAddress } = await import("../packages/covenant/dist/helpers.js");

  const compiled = JSON.parse(readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"));
  const templateArgs = JSON.parse(readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"));
  const patchDescriptor = extractPatchDescriptor(compiled, templateArgs);

  // Generate facilitator key
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
  console.log(`   Channel: ${channelAddress}`);
  console.log(`   Facilitator: ${facPubkey}`);

  // 4. Create transaction using UtxoContext
  console.log("\n4. Creating transaction...");
  const AMOUNT = 500_000_000n; // 5 KAS

  try {
    const created = await createTransactions({
      entries: context,
      outputs: [{ address: channelAddress, amount: AMOUNT }],
      changeAddress: wallet.address,
      priorityFee: 0n,
      networkId: NETWORK,
    });

    console.log(`   Created ${created.transactions.length} TX(s)`);
    console.log(`   Final TX ID: ${created.summary.finalTransactionId}`);

    // 5. Sign and submit
    console.log("\n5. Signing and submitting...");
    const pk = new PrivateKey(wallet.privateKey);
    let finalTxId = "";
    for (const pending of created.transactions) {
      pending.sign([pk]);
      finalTxId = await pending.submit(rpc);
      console.log(`   Submitted: ${finalTxId}`);
    }

    // Find output index
    const lastTx = created.transactions[created.transactions.length - 1].transaction;
    let vout = 0;
    for (let i = 0; i < lastTx.outputs.length; i++) {
      const outAddr = addressFromScriptPublicKey(lastTx.outputs[i].scriptPublicKey, NETWORK);
      if (outAddr?.toString() === channelAddress) { vout = i; break; }
    }

    console.log(`\n=== DEPLOYMENT SUCCESSFUL ===`);
    console.log(`TX:      ${finalTxId}`);
    console.log(`Channel: ${channelAddress}`);
    console.log(`Vout:    ${vout}`);
    console.log(`Explorer: https://tn12.kaspa.stream/txs/${finalTxId}`);

    // Save deployment info
    writeFileSync("/root/x402-kaspa/test/deployment.json", JSON.stringify({
      txid: finalTxId,
      channelAddress,
      outpoint: { txid: finalTxId, vout },
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
    console.log(`Saved: test/deployment.json`);

  } catch (e) {
    console.error("FAIL:", e);
  }

  // Cleanup
  await processor.stop();
  await rpc.disconnect();
  console.log("\nDone.");
}

main().catch(console.error);
