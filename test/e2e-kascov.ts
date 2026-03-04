/**
 * E2E Test via kascov CLI wrapper
 *
 * 1. Compile X402Channel with real pubkeys via template patcher
 * 2. Deploy to TN12 via kascov
 * 3. Verify UTXO on-chain
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  extractPatchDescriptor,
  applyPatch,
  byteArrayArg,
  intArg,
  getCovenantAddress,
  kascovDeploy,
  kascovBalance,
} from "../packages/covenant/dist/index.js";
import { PrivateKey } from "../packages/kaspa-wasm/kaspa.js";

const NETWORK = "testnet-12";
const RPC = "tn12-node.kaspa.com:16210";

const wallet = JSON.parse(readFileSync("/root/.x402-testnet-key.json", "utf-8"));

async function main() {
  console.log("=== E2E: kascov CLI Wrapper Test ===\n");

  // 1. Load compiled template and extract patch descriptor
  const compiled = JSON.parse(readFileSync("/root/x402-kaspa/contracts/compiled/x402-channel.json", "utf-8"));
  const templateArgs = JSON.parse(readFileSync("/root/x402-kaspa/contracts/silverscript/x402-channel-ctor.json", "utf-8"));
  const patchDescriptor = extractPatchDescriptor(compiled, templateArgs);

  // 2. Generate facilitator key
  const facPriv = randomBytes(32).toString("hex");
  const facKey = new PrivateKey(facPriv);
  const facPubkey = facKey.toPublicKey().toXOnlyPublicKey().toString();

  // 3. Patch with real args
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

  console.log(`Client:      ${wallet.pubkey}`);
  console.log(`Facilitator: ${facPubkey}`);
  console.log(`Timeout:     ${timeoutSeconds} (${new Date(timeoutSeconds * 1000).toISOString()})`);
  console.log(`Channel:     ${channelAddress}`);
  console.log();

  // 4. Deploy via kascov
  const AMOUNT = 500_000_000n; // 5 KAS
  console.log(`Deploying ${Number(AMOUNT) / 1e8} KAS...`);

  try {
    const result = await kascovDeploy(patched, AMOUNT, wallet.privateKey, RPC);

    console.log(`\n=== DEPLOYMENT SUCCESSFUL ===`);
    console.log(`TX:      ${result.txid}`);
    console.log(`Address: ${result.contractAddress}`);
    console.log(`Outpoint: ${result.outpoint.txid}:${result.outpoint.vout}`);
    console.log(`Fee:     ${result.feeSompi} sompi`);
    console.log(`Explorer: https://tn12.kaspa.stream/txs/${result.txid}`);

    // Save for settle test
    const deployInfo = {
      txid: result.txid,
      channelAddress: result.contractAddress,
      outpoint: result.outpoint,
      clientPubkey: wallet.pubkey,
      clientPrivateKey: wallet.privateKey,
      facilitatorPubkey: facPubkey,
      facilitatorPrivateKey: facPriv,
      timeout: timeoutSeconds,
      nonce: 100,
      amount: AMOUNT.toString(),
      network: NETWORK,
      rpcGrpc: RPC,
    };
    writeFileSync("/root/x402-kaspa/test/deployment-real.json", JSON.stringify(deployInfo, null, 2));
    console.log(`\nSaved: test/deployment-real.json`);

    // 5. Verify balance
    console.log(`\nVerifying covenant balance...`);
    // Give it a moment to propagate
    await new Promise(r => setTimeout(r, 2000));
    const balance = await kascovBalance(result.contractAddress, RPC);
    console.log(`Covenant balance: ${balance} sompi (${Number(balance) / 1e8} KAS)`);

  } catch (e) {
    console.error("FAILED:", e);
  }
}

main().catch(console.error);
