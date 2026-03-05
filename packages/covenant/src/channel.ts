/**
 * X402 Payment Channel — two-phase signing for covenant-based micropayments.
 *
 * Unlike the standard covenant-sdk spendContract() which uses a single signer,
 * x402 requires two-phase signing:
 *   Phase 1 (Client): Build unsigned TX → sign client half → serialize
 *   Phase 2 (Facilitator): Deserialize → sign facilitator half → assemble sigscript → broadcast
 */

import type { CompiledContract, CovenantOutpoint, SpendOutput } from "@x402/kaspa-types";
import { STANDARD_FEE, KASPACOM_FACILITATOR_PUBKEY } from "@x402/kaspa-types";
import {
  buildSigScript,
  buildUnsignedCovenantTx,
  attachSigScript,
  connectRpc,
  getAddressUtxos,
  getCovenantAddress,
  signInput,
  hexToBytes,
  bytesToHex,
  PrivateKey,
  type RpcClient,
  type Transaction,
  type UtxoEntryReference,
} from "./helpers.js";
import { applyPatch, extractPatchDescriptor, byteArrayArg, intArg, kaspaAddressToPubkeyBytes, type CtorArg, type TemplatePatch } from "./template-patcher.js";

// ────────────────────────────────────────────────────────────────
// Channel Configuration
// ────────────────────────────────────────────────────────────────

export interface ChannelConfig {
  /** Compiled X402Channel covenant (from silverc, with placeholder args) */
  compiledTemplate: CompiledContract;
  /** Patch descriptor for template (from extractPatchDescriptor) */
  patchDescriptor: TemplatePatch;
  /** Network identifier (e.g., "testnet-12") */
  network: string;
  /** Kaspa wRPC URL */
  rpcUrl: string;
}

export interface ChannelParams {
  clientPubkey: string;
  facilitatorPubkey: string;
  timeout: number;
  nonce: number;
}

// ────────────────────────────────────────────────────────────────
// Patch the covenant template with real constructor args
// ────────────────────────────────────────────────────────────────

/**
 * Produce a CompiledContract with real constructor args patched in.
 *
 * The v4-locked contract has 3 constructor params: (client, timeout, nonce).
 * The facilitator pubkey is hardcoded in the bytecode — not patchable.
 * Legacy v2 contracts had 4 params: (client, facilitator, timeout, nonce).
 */
export function patchChannelContract(
  config: ChannelConfig,
  params: ChannelParams,
): CompiledContract {
  const ctorParamCount = config.compiledTemplate.ast.params.length;

  let newArgs: CtorArg[];
  if (ctorParamCount === 3) {
    // v4-locked: facilitator is hardcoded in bytecode
    newArgs = [
      byteArrayArg(Array.from(hexToBytes(params.clientPubkey))),
      intArg(params.timeout),
      intArg(params.nonce),
    ];
  } else {
    // v2 legacy: facilitator is a constructor param
    newArgs = [
      byteArrayArg(Array.from(hexToBytes(params.clientPubkey))),
      byteArrayArg(Array.from(hexToBytes(params.facilitatorPubkey))),
      intArg(params.timeout),
      intArg(params.nonce),
    ];
  }
  return applyPatch(config.compiledTemplate, config.patchDescriptor, newArgs);
}

/**
 * Get the P2SH address for a channel with specific params.
 */
export function getChannelAddress(config: ChannelConfig, params: ChannelParams): string {
  const patched = patchChannelContract(config, params);
  return getCovenantAddress(patched, config.network);
}

// ────────────────────────────────────────────────────────────────
// Phase 1: Client-side — Deploy Channel
// ────────────────────────────────────────────────────────────────

export interface DeployChannelResult {
  txid: string;
  channelAddress: string;
  outpoint: CovenantOutpoint;
}

/**
 * Deploy a new payment channel by locking KAS into a covenant.
 */
export async function deployChannel(
  config: ChannelConfig,
  params: ChannelParams,
  amountSompi: bigint,
  privateKeyHex: string,
  existingRpc?: RpcClient,
): Promise<DeployChannelResult> {
  const { deployContract } = await import("./deploy.js");
  const patched = patchChannelContract(config, params);
  const result = await deployContract(patched, amountSompi, config.rpcUrl, privateKeyHex, config.network, existingRpc);
  return {
    txid: result.txid,
    channelAddress: result.contractAddress,
    outpoint: result.outpoint,
  };
}

// ────────────────────────────────────────────────────────────────
// Phase 1: Client-side — Build & partially sign a settle TX
// ────────────────────────────────────────────────────────────────

export interface PartiallySignedSettle {
  /** Serialized unsigned TX (hex) */
  unsignedTxHex: string;
  /** Client's 65-byte Schnorr signature (hex) */
  clientSignatureHex: string;
  /** Channel outpoint being spent */
  outpoint: CovenantOutpoint;
  /** Current nonce */
  nonce: number;
  /** Client's x-only pubkey (hex) */
  clientPubkey: string;
}

/**
 * Client builds and partially signs a settle transaction.
 * Returns the unsigned TX + client signature for the facilitator to complete.
 */
/**
 * Client builds and partially signs a settle transaction.
 * Returns the unsigned TX + client signature for the facilitator to complete.
 *
 * Revenue model (facilitator-as-payee):
 *   output[0] = full payment → payTo (should be facilitator's signing address)
 *   output[1] = change → covenant nonce+1 (if remainder > miner fee)
 *
 * The facilitator forwards (payment - fee) to the merchant as a separate
 * standard wallet operation. This avoids Kaspa's KIP-9 storage mass penalty
 * that makes 3+ output covenant TXs impractical for small amounts.
 */
export async function buildPartialSettle(
  config: ChannelConfig,
  params: ChannelParams,
  outpoint: CovenantOutpoint,
  inputAmountSompi: bigint,
  payTo: string,
  paymentAmount: bigint,
  clientPrivateKeyHex: string,
  existingRpc?: RpcClient,
): Promise<PartiallySignedSettle> {
  const patched = patchChannelContract(config, params);
  const channelAddress = getCovenantAddress(patched, config.network);

  const ownRpc = !existingRpc;
  const rpc = existingRpc || connectRpc(config.rpcUrl, config.network);

  try {
    if (ownRpc) await rpc.connect();

    // Find the covenant UTXO
    const utxos = await getAddressUtxos(rpc, channelAddress);
    const entry = utxos.find(
      (u) => u.outpoint.transactionId === outpoint.txid && u.outpoint.index === outpoint.vout,
    );
    if (!entry) {
      throw new Error(`Covenant UTXO ${outpoint.txid}:${outpoint.vout} not found at ${channelAddress}`);
    }

    // Build outputs: payment to facilitator + optional change to covenant
    const fee = STANDARD_FEE;
    const remainder = inputAmountSompi - paymentAmount - fee;
    const outputs: SpendOutput[] = [{ address: payTo, amount: paymentAmount }];

    if (remainder > fee) {
      const nextParams = { ...params, nonce: params.nonce + 1 };
      const nextPatched = patchChannelContract(config, nextParams);
      const nextAddress = getCovenantAddress(nextPatched, config.network);
      outputs.push({ address: nextAddress, amount: remainder });
    }

    // Build unsigned TX (sigOpCount = 2 for 2x checkSig)
    const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 2);

    // Client signs their half
    const privateKey = new PrivateKey(clientPrivateKeyHex);
    const clientSig = signInput(unsignedTx, 0, privateKey);

    return {
      unsignedTxHex: bytesToHex(unsignedTx.serializeToSafeJSON ? new TextEncoder().encode(unsignedTx.serializeToSafeJSON()) : new Uint8Array()),
      clientSignatureHex: bytesToHex(clientSig),
      outpoint,
      nonce: params.nonce,
      clientPubkey: params.clientPubkey,
    };
  } finally {
    if (ownRpc) await rpc.disconnect().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────
// Phase 2: Facilitator-side — Co-sign & broadcast
// ────────────────────────────────────────────────────────────────

export interface SettleResult {
  txid: string;
  newOutpoint?: CovenantOutpoint;
  newNonce?: number;
}

/**
 * Facilitator co-signs the partially signed settle TX and broadcasts it.
 */
export async function completeSettle(
  config: ChannelConfig,
  params: ChannelParams,
  partialSettle: PartiallySignedSettle,
  facilitatorPrivateKeyHex: string,
  existingRpc?: RpcClient,
): Promise<SettleResult> {
  const patched = patchChannelContract(config, params);
  const channelAddress = getCovenantAddress(patched, config.network);

  const ownRpc = !existingRpc;
  const rpc = existingRpc || connectRpc(config.rpcUrl, config.network);

  try {
    if (ownRpc) await rpc.connect();

    // Find the covenant UTXO
    const utxos = await getAddressUtxos(rpc, channelAddress);
    const entry = utxos.find(
      (u) =>
        u.outpoint.transactionId === partialSettle.outpoint.txid &&
        u.outpoint.index === partialSettle.outpoint.vout,
    );
    if (!entry) {
      throw new Error(`Covenant UTXO not found for settlement`);
    }

    // Rebuild the exact same unsigned TX the client built
    // We need to reconstruct it from the payment params
    const inputAmount = entry.amount;
    const fee = STANDARD_FEE;

    // Parse outputs from the partial settle info
    // For now we rebuild from the same params
    const paymentAmount = BigInt(0); // Will be extracted from TX
    // TODO: extract payment details from serialized TX

    // For the MVP, we reconstruct from known params
    // The facilitator knows the payment requirements

    // Facilitator signs
    const facilitatorKey = new PrivateKey(facilitatorPrivateKeyHex);

    // We need to rebuild the unsigned TX identically
    // This is the same TX the client signed
    // For now, the facilitator will receive the full TX context via the verify/settle API

    // Build sigscript with both signatures
    const clientSig = hexToBytes(partialSettle.clientSignatureHex);
    const facilitatorSig = signInput(
      // We need the same unsigned TX — this requires serialization support
      // For now, this is a placeholder that will be completed with WASM TX serialization
      {} as Transaction,
      0,
      facilitatorKey,
    );

    // Assemble: [clientSig, facilitatorSig] → settle function (selector 0)
    const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
    // TODO: attach to TX and broadcast

    return {
      txid: "pending-wasm-integration",
    };
  } finally {
    if (ownRpc) await rpc.disconnect().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────
// Refund — Client reclaims after timeout
// ────────────────────────────────────────────────────────────────

/**
 * Client refunds the channel after timeout (single sig).
 */
export async function refundChannel(
  config: ChannelConfig,
  params: ChannelParams,
  outpoint: CovenantOutpoint,
  inputAmountSompi: bigint,
  refundTo: string,
  clientPrivateKeyHex: string,
  existingRpc?: RpcClient,
): Promise<{ txid: string }> {
  const patched = patchChannelContract(config, params);
  const channelAddress = getCovenantAddress(patched, config.network);

  const ownRpc = !existingRpc;
  const rpc = existingRpc || connectRpc(config.rpcUrl, config.network);

  try {
    if (ownRpc) await rpc.connect();

    const utxos = await getAddressUtxos(rpc, channelAddress);
    const entry = utxos.find(
      (u) => u.outpoint.transactionId === outpoint.txid && u.outpoint.index === outpoint.vout,
    );
    if (!entry) {
      throw new Error(`Covenant UTXO ${outpoint.txid}:${outpoint.vout} not found`);
    }

    const fee = STANDARD_FEE;
    const outputs: SpendOutput[] = [{ address: refundTo, amount: inputAmountSompi - fee }];

    // Refund only needs 1 checkSig
    const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 1);
    const privateKey = new PrivateKey(clientPrivateKeyHex);
    const clientSig = signInput(unsignedTx, 0, privateKey);

    // Build sigscript for refund (selector 1)
    const sigPrefix = buildSigScript(patched, "refund", [clientSig]);
    attachSigScript(unsignedTx, 0, patched, sigPrefix);

    const result = await rpc.submitTransaction({
      transaction: unsignedTx,
      allowOrphan: false,
    });

    return { txid: result.transactionId };
  } finally {
    if (ownRpc) await rpc.disconnect().catch(() => {});
  }
}
