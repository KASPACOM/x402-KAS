// ============================================================
// x402 Kaspa Client SDK
// ============================================================
// Provides the client-side operations for x402 payments:
// 1. Open a payment channel (deploy covenant)
// 2. Build payment authorizations (partial TX)
// 3. Check channel balance
// 4. Refund (reclaim after timeout)

import type {
  ChannelInfo,
  CovenantOutpoint,
  DeployChannelResult,
  KaspaNetwork,
  KaspaPayload,
  PaymentPayload,
  PaymentRequirements,
  ResourceInfo,
} from "@x402/kaspa-types";
import {
  NETWORK_IDS,
  STANDARD_FEE,
  X402_CHANNEL_ABI,
} from "@x402/kaspa-types";

// NOTE: Kaspa WASM SDK imports are deferred — see type stubs below.
// In production, install `kaspa-wasm` and import directly.

export interface ClientConfig {
  /** Client's private key (hex, 64 chars) */
  privateKeyHex: string;
  /** Kaspa RPC endpoint (wRPC URL) */
  rpcUrl: string;
  /** Network identifier */
  network: KaspaNetwork;
  /** Compiled X402Channel covenant JSON (from silverc) */
  compiledCovenant: CompiledCovenant;
}

interface CompiledCovenant {
  contract_name: string;
  script: number[];
  abi: Array<{
    name: string;
    inputs: Array<{ name: string; type_name: string }>;
  }>;
  without_selector: boolean;
}

export class X402KaspaClient {
  private config: ClientConfig;
  private channels: Map<string, ChannelInfo> = new Map();

  constructor(config: ClientConfig) {
    this.config = config;
  }

  // ----------------------------------------------------------
  // Open a payment channel
  // ----------------------------------------------------------
  // Deploys the X402Channel covenant, locking `amountSompi` KAS.
  //
  // The covenant is parameterized with:
  //   - client pubkey (derived from this.config.privateKeyHex)
  //   - facilitator pubkey (from PaymentRequirements.extra)
  //   - timeout (now + timeoutSeconds)
  //   - nonce = 0

  async openChannel(
    facilitatorPubkey: string,
    amountSompi: bigint,
    timeoutSeconds: number = 86400, // default 24h
  ): Promise<DeployChannelResult> {
    // In production with Kaspa WASM SDK:
    //
    // const { PrivateKey, RpcClient, Encoding, createTransactions,
    //         payToScriptHashScript, addressFromScriptPublicKey } = await import("kaspa-wasm");
    //
    // const privateKey = new PrivateKey(this.config.privateKeyHex);
    // const clientPubkey = privateKey.toPublicKey().toXOnlyPublicKey().toString();
    // const networkId = NETWORK_IDS[this.config.network];
    //
    // // 1. Compile covenant with constructor args
    // //    In practice, use silverscript-lang to patch constructor args into bytecode
    // //    OR use pre-compiled templates with arg patching (like the template-patcher pattern)
    // const timeout = Math.floor(Date.now() / 1000) + timeoutSeconds;
    // const covenantScript = patchCovenantArgs(this.config.compiledCovenant, {
    //   client: clientPubkey,
    //   facilitator: facilitatorPubkey,
    //   timeout,
    //   nonce: 0,
    // });
    //
    // // 2. Compute P2SH address
    // const scriptPubKey = payToScriptHashScript(covenantScript);
    // const covenantAddress = addressFromScriptPublicKey(scriptPubKey, networkId).toString();
    //
    // // 3. Build and sign deployment TX
    // const senderAddress = privateKey.toAddress(networkId).toString();
    // const rpc = new RpcClient({ url: this.config.rpcUrl, encoding: Encoding.Borsh, networkId });
    // await rpc.connect();
    //
    // const utxos = await rpc.getUtxosByAddresses([senderAddress]);
    // const created = await createTransactions({
    //   entries: utxos.entries,
    //   outputs: [{ address: covenantAddress, amount: amountSompi }],
    //   changeAddress: senderAddress,
    //   priorityFee: 0n,
    //   networkId,
    // });
    //
    // let txid = "";
    // for (const pending of created.transactions) {
    //   pending.sign([privateKey]);
    //   txid = await pending.submit(rpc);
    // }
    //
    // // 4. Find the covenant output
    // const lastTx = created.transactions[created.transactions.length - 1].transaction;
    // const vout = lastTx.outputs.findIndex(o =>
    //   addressFromScriptPublicKey(o.scriptPublicKey, networkId)?.toString() === covenantAddress
    // );
    //
    // await rpc.disconnect();
    //
    // // 5. Track channel
    // const channel: ChannelInfo = {
    //   address: covenantAddress,
    //   outpoint: { txid, vout },
    //   clientPubkey,
    //   facilitatorPubkey,
    //   timeout,
    //   nonce: 0,
    //   balance: amountSompi,
    // };
    // this.channels.set(covenantAddress, channel);
    //
    // return { txid, channelAddress: covenantAddress, outpoint: { txid, vout } };

    throw new Error("WASM SDK not yet integrated. See comments for implementation.");
  }

  // ----------------------------------------------------------
  // Build a payment authorization
  // ----------------------------------------------------------
  // Creates a partially-signed settlement TX for an x402 payment.
  // Returns the PaymentPayload to send in the PAYMENT-SIGNATURE header.

  async buildPayment(
    channelAddress: string,
    requirements: PaymentRequirements,
    resource: ResourceInfo,
  ): Promise<PaymentPayload> {
    const channel = this.channels.get(channelAddress);
    if (!channel) {
      throw new Error(`No channel found at ${channelAddress}. Open one first.`);
    }

    const amountSompi = BigInt(requirements.amount);
    if (amountSompi + STANDARD_FEE > channel.balance) {
      throw new Error(
        `Insufficient channel balance: ${channel.balance} sompi, ` +
        `need ${amountSompi + STANDARD_FEE} (amount + fee)`,
      );
    }

    // In production with Kaspa WASM SDK:
    //
    // const { PrivateKey, Transaction, ScriptBuilder, SighashType,
    //         createInputSignature, payToAddressScript, payToScriptHashScript,
    //         addressFromScriptPublicKey, RpcClient, Encoding } = await import("kaspa-wasm");
    //
    // const privateKey = new PrivateKey(this.config.privateKeyHex);
    // const networkId = NETWORK_IDS[this.config.network];
    //
    // // 1. Build transaction outputs
    // const payToScript = payToAddressScript(requirements.payTo);
    // const outputs = [{ scriptPublicKey: payToScript, value: amountSompi }];
    //
    // // 2. Calculate change
    // const remainder = channel.balance - amountSompi - STANDARD_FEE;
    // if (remainder > STANDARD_FEE) {
    //   // Change goes back to same covenant with nonce+1
    //   const nextCovenantScript = patchCovenantArgs(this.config.compiledCovenant, {
    //     client: channel.clientPubkey,
    //     facilitator: channel.facilitatorPubkey,
    //     timeout: channel.timeout,
    //     nonce: channel.nonce + 1,
    //   });
    //   const changeScriptPubKey = payToScriptHashScript(nextCovenantScript);
    //   outputs.push({ scriptPublicKey: changeScriptPubKey, value: remainder });
    // }
    //
    // // 3. Build unsigned transaction
    // const tx = new Transaction({
    //   version: 0,
    //   lockTime: 0n,
    //   inputs: [{
    //     previousOutpoint: { transactionId: channel.outpoint.txid, index: channel.outpoint.vout },
    //     sequence: 0n,
    //     sigOpCount: 2,  // settle requires 2 checkSig ops
    //   }],
    //   outputs,
    //   subnetworkId: SUBNETWORK_ID_NATIVE,
    //   gas: 0n,
    //   payload: "",
    // });
    //
    // // 4. Sign client's half (Schnorr over sighash)
    // const clientSigHex = createInputSignature(tx, 0, privateKey, SighashType.All);
    // const clientSig = hexToBytes(clientSigHex);
    //
    // // 5. Build partial sigscript (client sig only, facilitator will add theirs)
    // //    Format: <clientSig> (facilitator sig will be inserted by facilitator)
    // //    We serialize the partial TX with the client sig embedded
    // const builder = new ScriptBuilder();
    // builder.addData(clientSig);
    // tx.inputs[0].signatureScript = builder.drain();
    //
    // // 6. Serialize to base64
    // const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    // Placeholder for now
    const txBase64 = "";

    const payload: KaspaPayload = {
      transaction: txBase64,
      channelOutpoint: channel.outpoint,
      clientPubkey: channel.clientPubkey,
      currentNonce: channel.nonce,
    };

    return {
      x402Version: 2,
      resource,
      accepted: requirements,
      payload,
    };
  }

  // ----------------------------------------------------------
  // Get channel info
  // ----------------------------------------------------------

  getChannel(address: string): ChannelInfo | undefined {
    return this.channels.get(address);
  }

  // ----------------------------------------------------------
  // List all open channels
  // ----------------------------------------------------------

  listChannels(): ChannelInfo[] {
    return Array.from(this.channels.values());
  }

  // ----------------------------------------------------------
  // Refresh channel balance from chain
  // ----------------------------------------------------------

  async refreshChannel(address: string): Promise<ChannelInfo | null> {
    const channel = this.channels.get(address);
    if (!channel) return null;

    // In production:
    // const rpc = new RpcClient({ ... });
    // await rpc.connect();
    // const utxos = await rpc.getUtxosByAddresses([address]);
    // const utxo = utxos.entries.find(e =>
    //   e.outpoint.transactionId === channel.outpoint.txid &&
    //   e.outpoint.index === channel.outpoint.vout
    // );
    // if (utxo) {
    //   channel.balance = utxo.amount;
    // } else {
    //   // UTXO was spent — channel may have been settled or refunded
    //   // Try to find the new covenant UTXO (nonce+1)
    //   // ...
    // }
    // await rpc.disconnect();

    return channel;
  }

  // ----------------------------------------------------------
  // Refund: reclaim funds after timeout
  // ----------------------------------------------------------

  async refund(channelAddress: string): Promise<string> {
    const channel = this.channels.get(channelAddress);
    if (!channel) {
      throw new Error(`No channel found at ${channelAddress}`);
    }

    // In production with Kaspa WASM SDK:
    //
    // const now = Math.floor(Date.now() / 1000);
    // if (now < channel.timeout) {
    //   throw new Error(`Channel timeout not reached. Wait until ${new Date(channel.timeout * 1000).toISOString()}`);
    // }
    //
    // const privateKey = new PrivateKey(this.config.privateKeyHex);
    // const networkId = NETWORK_IDS[this.config.network];
    // const senderAddress = privateKey.toAddress(networkId).toString();
    //
    // // Build refund TX: spend covenant via "refund" entrypoint
    // const tx = new Transaction({
    //   version: 0,
    //   lockTime: BigInt(channel.timeout),  // must be >= timeout for CLTV
    //   inputs: [{
    //     previousOutpoint: { transactionId: channel.outpoint.txid, index: channel.outpoint.vout },
    //     sequence: 0n,
    //     sigOpCount: 1,  // refund has 1 checkSig
    //   }],
    //   outputs: [{
    //     scriptPublicKey: payToAddressScript(senderAddress),
    //     value: channel.balance - STANDARD_FEE,
    //   }],
    //   subnetworkId: SUBNETWORK_ID_NATIVE,
    //   gas: 0n,
    //   payload: "",
    // });
    //
    // // Sign with client key
    // const sigHex = createInputSignature(tx, 0, privateKey, SighashType.All);
    // const sig = hexToBytes(sigHex);
    //
    // // Build sigscript: <clientSig> <selector:1> | <covenantScript>
    // const builder = new ScriptBuilder();
    // builder.addData(sig);
    // builder.addI64(1n);  // selector 1 = refund
    // const sigPrefix = builder.drain();
    //
    // const covenantBytes = Uint8Array.from(this.config.compiledCovenant.script);
    // tx.inputs[0].signatureScript =
    //   ScriptBuilder.fromScript(covenantBytes)
    //     .encodePayToScriptHashSignatureScript(sigPrefix);
    //
    // // Broadcast
    // const rpc = new RpcClient({ ... });
    // await rpc.connect();
    // const result = await rpc.submitTransaction({ transaction: tx, allowOrphan: false });
    // await rpc.disconnect();
    //
    // // Remove channel from tracking
    // this.channels.delete(channelAddress);
    //
    // return result.transactionId;

    throw new Error("WASM SDK not yet integrated. See comments for implementation.");
  }

  // ----------------------------------------------------------
  // Update channel after successful settlement
  // ----------------------------------------------------------

  updateChannelAfterSettle(
    channelAddress: string,
    newOutpoint: CovenantOutpoint,
    newBalance: bigint,
  ): void {
    const channel = this.channels.get(channelAddress);
    if (!channel) return;

    // After a settle, the channel moves to a new UTXO with nonce+1
    channel.outpoint = newOutpoint;
    channel.nonce += 1;
    channel.balance = newBalance;

    // The covenant address changes because nonce is a constructor arg
    // In production, recalculate:
    // channel.address = getCovenantAddress(compiledCovenant, channel);
  }
}
