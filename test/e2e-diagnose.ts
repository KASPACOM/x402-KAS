/**
 * Diagnostic: test WASM RPC connection and basic operations step by step
 */

import { RpcClient, Encoding, PrivateKey, createTransactions, payToScriptHashScript, addressFromScriptPublicKey } from "../packages/kaspa-wasm/kaspa.js";
import { readFileSync } from "node:fs";

const RPC_URL = "ws://tn12-node.kaspa.com:17210";
const NETWORK = "testnet-12";

const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));

async function main() {
  console.log("Step 1: Create RpcClient...");
  let rpc: any;
  try {
    rpc = new RpcClient({
      url: RPC_URL,
      encoding: Encoding.Borsh,
      networkId: NETWORK,
    });
    console.log("  OK: RpcClient created");
  } catch (e) {
    console.error("  FAIL:", e);
    return;
  }

  console.log("Step 2: Connect to RPC...");
  try {
    await rpc.connect();
    console.log("  OK: Connected");
  } catch (e) {
    console.error("  FAIL:", e);
    return;
  }

  console.log("Step 3: Get block DAG info...");
  try {
    const info = await rpc.getBlockDagInfo();
    console.log(`  OK: DAA score=${info.virtualDaaScore}, network=${info.networkName}`);
  } catch (e) {
    console.error("  FAIL:", e);
  }

  console.log("Step 4: Get UTXOs for our address...");
  try {
    const utxos = await rpc.getUtxosByAddresses([wallet.address]);
    console.log(`  OK: Found ${utxos.entries.length} UTXOs`);
    for (const e of utxos.entries) {
      console.log(`    - ${e.outpoint.transactionId}:${e.outpoint.index} = ${e.amount} sompi`);
    }
  } catch (e) {
    console.error("  FAIL:", e);
  }

  console.log("Step 5: Create PrivateKey...");
  try {
    const pk = new PrivateKey(wallet.privateKey);
    const addr = pk.toAddress(NETWORK).toString();
    console.log(`  OK: Address=${addr}`);
    console.log(`  Match wallet: ${addr === wallet.address}`);
  } catch (e) {
    console.error("  FAIL:", e);
  }

  console.log("Step 6: Test P2SH address derivation...");
  try {
    // Use a dummy script to test P2SH derivation
    const dummyScript = Uint8Array.from([0x51, 0x51, 0x87]); // OP_1 OP_1 OP_EQUAL
    const scriptPubKey = payToScriptHashScript(dummyScript);
    const addr = addressFromScriptPublicKey(scriptPubKey, NETWORK);
    console.log(`  OK: P2SH address=${addr?.toString()}`);
  } catch (e) {
    console.error("  FAIL:", e);
  }

  console.log("Step 7: Test createTransactions...");
  try {
    const utxos = await rpc.getUtxosByAddresses([wallet.address]);
    if (utxos.entries.length === 0) {
      console.log("  SKIP: No UTXOs");
    } else {
      // Create a small self-transfer to test TX building
      const dummyScript = Uint8Array.from([0x51, 0x51, 0x87]);
      const scriptPubKey = payToScriptHashScript(dummyScript);
      const p2shAddr = addressFromScriptPublicKey(scriptPubKey, NETWORK);

      console.log(`  Sending 5 KAS to P2SH: ${p2shAddr?.toString()}`);
      console.log(`  Entries: ${utxos.entries.length}, first amount: ${utxos.entries[0].amount}`);

      const created = await createTransactions({
        entries: utxos.entries,
        outputs: [{ address: p2shAddr!.toString(), amount: 500_000_000n }],
        changeAddress: wallet.address,
        priorityFee: 0n,
        networkId: NETWORK,
      });

      console.log(`  OK: Created ${created.transactions.length} transactions`);
      console.log(`  Final TX ID: ${created.summary.finalTransactionId}`);

      // DON'T broadcast - just test building
      console.log("  (NOT broadcasting - just testing TX creation)");
    }
  } catch (e) {
    console.error("  FAIL:", e);
  }

  console.log("\nStep 8: Test createTransactions + sign + submit to P2SH...");
  try {
    const utxos = await rpc.getUtxosByAddresses([wallet.address]);
    if (utxos.entries.length === 0) {
      console.log("  SKIP: No UTXOs");
    } else {
      // Load the compiled covenant
      const compiled = JSON.parse(readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"));
      const { extractPatchDescriptor, applyPatch, byteArrayArg, intArg } = await import("../packages/covenant/dist/template-patcher.js");
      const { getCovenantAddress } = await import("../packages/covenant/dist/helpers.js");

      const templateArgs = JSON.parse(readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"));
      const patchDescriptor = extractPatchDescriptor(compiled, templateArgs);

      // Use a second key as facilitator
      const { randomBytes } = await import("node:crypto");
      const facPriv = randomBytes(32).toString("hex");
      const facKey = new PrivateKey(facPriv);
      const facPubkey = facKey.toPublicKey().toXOnlyPublicKey().toString();

      const timeoutSeconds = Math.floor(Date.now() / 1000) + 3600;

      function hexToBytes(hex: string): number[] {
        const out: number[] = [];
        for (let i = 0; i < hex.length; i += 2) {
          out.push(parseInt(hex.slice(i, i + 2), 16));
        }
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
      console.log(`  Channel P2SH: ${channelAddress}`);

      const pk = new PrivateKey(wallet.privateKey);

      const created = await createTransactions({
        entries: utxos.entries,
        outputs: [{ address: channelAddress, amount: 500_000_000n }],
        changeAddress: wallet.address,
        priorityFee: 0n,
        networkId: NETWORK,
      });

      console.log(`  TX created: ${created.transactions.length} transactions`);

      // Sign and submit
      let finalTxId: string = "";
      for (const pending of created.transactions) {
        pending.sign([pk]);
        finalTxId = await pending.submit(rpc);
        console.log(`  Submitted: ${finalTxId}`);
      }

      console.log(`\n  === DEPLOYMENT SUCCESSFUL ===`);
      console.log(`  TX: ${finalTxId}`);
      console.log(`  Channel: ${channelAddress}`);
      console.log(`  Explorer: https://tn12.kaspa.stream/txs/${finalTxId}`);

      // Find the output index
      const lastTx = created.transactions[created.transactions.length - 1].transaction;
      let vout = 0;
      for (let i = 0; i < lastTx.outputs.length; i++) {
        const outAddr = addressFromScriptPublicKey(lastTx.outputs[i].scriptPublicKey, NETWORK);
        if (outAddr?.toString() === channelAddress) {
          vout = i;
          break;
        }
      }

      // Save deployment info
      const deployInfo = {
        txid: finalTxId,
        channelAddress,
        outpoint: { txid: finalTxId, vout },
        clientPubkey: wallet.pubkey,
        clientPrivateKey: wallet.privateKey,
        facilitatorPubkey: facPubkey,
        facilitatorPrivateKey: facPriv,
        timeout: timeoutSeconds,
        nonce: 100,
        amount: "500000000",
        network: NETWORK,
        rpcUrl: RPC_URL,
      };

      const { writeFileSync } = await import("node:fs");
      writeFileSync("/root/x402-kaspa/test/deployment.json", JSON.stringify(deployInfo, null, 2));
      console.log(`  Saved: test/deployment.json`);
    }
  } catch (e) {
    console.error("  FAIL:", e);
  }

  await rpc.disconnect();
  console.log("\nDone.");
}

main().catch(console.error);
