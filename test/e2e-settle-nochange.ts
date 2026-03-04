/**
 * E2E Test: Settle with NO change output (skip validateOutputState)
 * This isolates whether the issue is checkSig or validateOutputState.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  patchChannelContract,
  getCovenantAddress,
  kascovDeploy,
  connectRpc,
  getAddressUtxos,
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
const KASCOV_RPC = "tn12-node.kaspa.com:16210";
const NETWORK = "testnet-12";
const DEPLOY_AMOUNT = 100_000_000n; // 1 KAS

async function main() {
  console.log("=== E2E: Settle (no change output) ===\n");

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

  const params: ChannelParams = {
    clientPubkey,
    facilitatorPubkey,
    timeout: Math.floor(Date.now() / 1000) + 86400,
    nonce: 0,
  };

  // Deploy
  console.log("\nDeploying covenant (1 KAS)...");
  const patched = patchChannelContract(channelConfig, params);
  const channelAddress = getCovenantAddress(patched, NETWORK);

  const deployResult = await kascovDeploy(patched, DEPLOY_AMOUNT, clientPrivateKey, KASCOV_RPC);
  console.log(`TX: ${deployResult.txid}`);

  // Wait for UTXO
  const rpc = connectRpc(RPC_URL, NETWORK);
  await rpc.connect();
  let entry;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const utxos = await getAddressUtxos(rpc, channelAddress);
    entry = utxos.find(
      (u) => u.outpoint.transactionId === deployResult.txid && u.outpoint.index === deployResult.outpoint.vout,
    );
    if (entry) break;
    process.stdout.write(".");
  }
  console.log();
  if (!entry) { console.error("UTXO not found"); process.exit(1); }
  console.log(`UTXO: ${entry.amount} sompi`);

  // Build settle TX: payment = inputValue - fee (no change output)
  // Covenant hardcodes minerFee=5000. For no-change: payment = input - 5000
  // so remainder = 0, skipping validateOutputState
  const paymentAmount = entry.amount - 5000n;
  const outputs: SpendOutput[] = [{ address: facilitatorAddress, amount: paymentAmount }];

  console.log(`\nPayment: ${paymentAmount} sompi (all-in, no change)`);
  console.log(`Fee: 5000 sompi`);

  const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 2);

  // Client signs
  const clientSig = signInput(unsignedTx, 0, clientPk);
  console.log(`Client sig: ${bytesToHex(clientSig).substring(0, 30)}... (${clientSig.length}b)`);

  // Facilitator signs (same TX object)
  const facilitatorSig = signInput(unsignedTx, 0, facilitatorPk);
  console.log(`Fac sig:    ${bytesToHex(facilitatorSig).substring(0, 30)}... (${facilitatorSig.length}b)`);

  // Assemble sigscript
  const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
  attachSigScript(unsignedTx, 0, patched, sigPrefix);

  // Broadcast
  console.log("\nBroadcasting...");
  try {
    const result = await rpc.submitTransaction({ transaction: unsignedTx, allowOrphan: false });
    console.log(`\n=== SUCCESS === TX: ${result.transactionId}`);
    console.log(`Explorer: https://tn12.kaspa.stream/txs/${result.transactionId}`);
  } catch (err) {
    console.error(`\n=== FAILED ===`);
    console.error(err instanceof Error ? err.message : err);
  }

  await rpc.disconnect();
}

main().catch(console.error);
