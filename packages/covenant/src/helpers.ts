/**
 * Low-level helpers shared across covenant operations.
 * Adapted from @kaspacom/covenant-sdk.
 */

import {
  Address,
  addressFromScriptPublicKey,
  createInputSignature,
  createTransactions,
  Encoding,
  payToAddressScript,
  payToScriptHashScript,
  PrivateKey,
  RpcClient,
  ScriptBuilder,
  SighashType,
  Transaction,
  XOnlyPublicKey,
  type ITransactionInput,
  type ITransactionOutput,
  type UtxoEntryReference,
} from "kaspa-wasm";
import type { CompiledContract, CovenantOutpoint, SpendOutput } from "@x402/kaspa-types";

export const SUBNETWORK_ID_NATIVE = "0000000000000000000000000000000000000000";

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().replace(/^0x/i, "");
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: "${hex}"`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function toScriptBytes(compiled: CompiledContract): Uint8Array {
  return Uint8Array.from(compiled.script);
}

export function connectRpc(rpcUrl: string, network: string): RpcClient {
  return new RpcClient({
    url: rpcUrl,
    encoding: Encoding.Borsh,
    networkId: network,
  });
}

export async function getAddressUtxos(rpc: RpcClient, address: string): Promise<UtxoEntryReference[]> {
  const utxos = await rpc.getUtxosByAddresses([address]);
  return utxos.entries;
}

export function getCovenantAddress(compiled: CompiledContract, network: string): string {
  const scriptPublicKey = payToScriptHashScript(toScriptBytes(compiled));
  const addr = addressFromScriptPublicKey(scriptPublicKey, network);
  if (!addr) {
    throw new Error(`Failed to derive covenant address for ${compiled.contract_name}`);
  }
  return addr.toString();
}

export function getAbiEntry(compiled: CompiledContract, functionName: string) {
  const entry = compiled.abi.find((c) => c.name === functionName);
  if (!entry) {
    throw new Error(`Function "${functionName}" not found in compiled ABI`);
  }
  return entry;
}

export function getFunctionSelector(compiled: CompiledContract, functionName: string): bigint | undefined {
  if (compiled.without_selector) return undefined;
  const idx = compiled.abi.findIndex((c) => c.name === functionName);
  if (idx === -1) throw new Error(`Function "${functionName}" not found in compiled ABI`);
  return BigInt(idx);
}

/**
 * Build a sigscript from function arguments and selector.
 * Arguments are pushed in ABI order, then the function selector.
 */
export function buildSigScript(
  compiled: CompiledContract,
  functionName: string,
  functionArgs: Uint8Array[],
): string {
  const abiEntry = getAbiEntry(compiled, functionName);
  if (abiEntry.inputs.length !== functionArgs.length) {
    throw new Error(`Function "${functionName}" expects ${abiEntry.inputs.length} arguments, got ${functionArgs.length}`);
  }

  const builder = new ScriptBuilder();

  for (let i = 0; i < abiEntry.inputs.length; i++) {
    const input = abiEntry.inputs[i];
    const arg = functionArgs[i];

    if (input.type_name === "sig") {
      if (arg.length !== 65) throw new Error(`Expected sig "${input.name}" to be 65 bytes, got ${arg.length}`);
      builder.addData(arg);
    } else if (input.type_name === "pubkey") {
      if (arg.length !== 32) throw new Error(`Expected pubkey "${input.name}" to be 32 bytes, got ${arg.length}`);
      builder.addData(arg);
    } else {
      throw new Error(`Unsupported ABI argument type "${input.type_name}" for "${functionName}"`);
    }
  }

  const selector = getFunctionSelector(compiled, functionName);
  if (selector !== undefined) {
    builder.addI64(selector);
  }

  return builder.drain();
}

/**
 * Build an unsigned transaction that spends a covenant UTXO.
 */
export function buildUnsignedCovenantTx(
  entry: UtxoEntryReference,
  outputs: SpendOutput[],
  sigOpCount: number = 2,
): Transaction {
  const txInputs: ITransactionInput[] = [
    {
      previousOutpoint: entry.outpoint,
      utxo: entry,
      sequence: 0n,
      sigOpCount,
    },
  ];

  const txOutputs: ITransactionOutput[] = outputs.map((o) => ({
    scriptPublicKey: payToAddressScript(o.address),
    value: o.amount,
  }));

  return new Transaction({
    version: 0,
    lockTime: 0n,
    inputs: txInputs,
    outputs: txOutputs,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: "",
  });
}

/**
 * Sign a transaction input with a private key, returning the 65-byte signature.
 */
export function signInput(
  tx: Transaction,
  inputIndex: number,
  privateKey: PrivateKey,
): Uint8Array {
  const sigHex = createInputSignature(tx, inputIndex, privateKey, SighashType.All);
  return hexToBytes(sigHex);
}

/**
 * Attach the complete P2SH sigscript to a transaction input.
 */
export function attachSigScript(
  tx: Transaction,
  inputIndex: number,
  compiled: CompiledContract,
  sigPrefix: string,
): void {
  tx.inputs[inputIndex].signatureScript = ScriptBuilder.fromScript(
    toScriptBytes(compiled),
  ).encodePayToScriptHashSignatureScript(sigPrefix);
}

// Re-export kaspa-wasm types we use
export {
  Address,
  addressFromScriptPublicKey,
  createInputSignature,
  createTransactions,
  Encoding,
  payToAddressScript,
  payToScriptHashScript,
  PrivateKey,
  RpcClient,
  ScriptBuilder,
  SighashType,
  Transaction,
  XOnlyPublicKey,
};
export type { ITransactionInput, ITransactionOutput, UtxoEntryReference };
