/**
 * Deploy a covenant contract by locking KAS into its P2SH address.
 * Adapted from @kaspacom/covenant-sdk.
 */

import type { CompiledContract, CovenantOutpoint } from "@kaspacom/x402-types";
import {
  connectRpc,
  getAddressUtxos,
  getCovenantAddress,
  PrivateKey,
  createTransactions,
  addressFromScriptPublicKey,
  type RpcClient,
} from "./helpers.js";

export interface DeployResult {
  txid: string;
  contractAddress: string;
  outpoint: CovenantOutpoint;
}

/**
 * Deploy a covenant: send KAS to the P2SH address derived from the contract bytecode.
 */
export async function deployContract(
  compiled: CompiledContract,
  amountSompi: bigint,
  rpcUrl: string,
  privateKeyHex: string,
  network: string,
  existingRpc?: RpcClient,
): Promise<DeployResult> {
  const privateKey = new PrivateKey(privateKeyHex);
  const senderAddress = privateKey.toAddress(network).toString();
  const contractAddress = getCovenantAddress(compiled, network);

  const ownRpc = !existingRpc;
  const rpc = existingRpc || connectRpc(rpcUrl, network);

  try {
    if (ownRpc) await rpc.connect();

    const entries = await getAddressUtxos(rpc, senderAddress);
    if (entries.length === 0) {
      throw new Error(`No spendable UTXOs found for ${senderAddress}`);
    }

    const created = await createTransactions({
      entries,
      outputs: [{ address: contractAddress, amount: amountSompi }],
      changeAddress: senderAddress,
      priorityFee: 0n,
      networkId: network,
    } as never);

    let finalTxId = created.summary.finalTransactionId;
    let finalTransaction = created.transactions[created.transactions.length - 1]?.transaction;

    for (const pending of created.transactions) {
      pending.sign([privateKey]);
      finalTxId = await pending.submit(rpc);
      finalTransaction = pending.transaction;
    }

    if (!finalTxId || !finalTransaction) {
      throw new Error("Failed to submit deployment transaction");
    }

    const outputIndex = finalTransaction.outputs.findIndex((output: any) => {
      const resolved = addressFromScriptPublicKey(output.scriptPublicKey, network);
      return resolved?.toString() === contractAddress;
    });

    if (outputIndex === -1) {
      throw new Error("Deployment TX did not contain the covenant output");
    }

    return {
      txid: finalTxId,
      contractAddress,
      outpoint: { txid: finalTxId, vout: outputIndex },
    };
  } finally {
    if (ownRpc) await rpc.disconnect().catch(() => {});
  }
}
