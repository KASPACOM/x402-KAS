// ============================================================
// Kaspa x402 Facilitator
// ============================================================
// Handles verification and settlement of x402 covenant payments.
//
// The facilitator:
// 1. Verifies covenant UTXO exists and matches expected structure
// 2. Validates client's partial signature
// 3. Co-signs the settlement TX (completing the 2-of-2)
// 4. Broadcasts to Kaspa network
// 5. Tracks confirmation via blue score

import type {
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettlementResponse,
  SupportedResponse,
  KaspaNetwork,
  CovenantOutpoint,
  PaymentPayload,
  PaymentRequirements,
} from "@x402/kaspa-types";
import {
  NETWORK_IDS,
  STANDARD_FEE,
  X402_CHANNEL_ABI,
} from "@x402/kaspa-types";

// NOTE: The kaspa WASM SDK imports will be resolved at runtime.
// For now we define the interface we need and defer the actual import
// to allow compilation without the WASM binary present.

interface KaspaRpc {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getUtxosByAddresses(addresses: string[]): Promise<{ entries: UtxoEntry[] }>;
  submitTransaction(params: { transaction: unknown; allowOrphan: boolean }): Promise<{ transactionId: string }>;
  getBlockDagInfo(): Promise<{ virtualDaaScore: bigint }>;
}

interface UtxoEntry {
  outpoint: { transactionId: string; index: number };
  amount: bigint;
  scriptPublicKey: { script: string };
}

export interface FacilitatorConfig {
  /** Facilitator's private key (hex, 64 chars) */
  privateKeyHex: string;
  /** Kaspa RPC endpoint (wRPC URL) */
  rpcUrl: string;
  /** Network identifier */
  network: KaspaNetwork;
  /** Compiled X402Channel covenant JSON (from silverc) */
  compiledCovenant: CompiledCovenant;
  /** Minimum confirmations before returning settled (default: 10) */
  minConfirmations?: number;
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

export class KaspaFacilitator {
  private config: FacilitatorConfig;
  private rpc: KaspaRpc | null = null;

  constructor(config: FacilitatorConfig) {
    this.config = config;
  }

  // ----------------------------------------------------------
  // GET /supported
  // ----------------------------------------------------------

  getSupported(): SupportedResponse {
    // Derive public key from private key
    // In production, this would use the Kaspa WASM SDK:
    // const pk = new PrivateKey(this.config.privateKeyHex);
    // const address = pk.toAddress(networkId).toString();
    // const pubkey = pk.toPublicKey().toXOnlyPublicKey().toString();

    return {
      supported: [
        {
          scheme: "exact",
          network: this.config.network,
          signerAddress: `facilitator-${this.config.network}`,
        },
      ],
    };
  }

  // ----------------------------------------------------------
  // POST /verify
  // ----------------------------------------------------------

  async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const { paymentPayload, paymentRequirements } = req;

    try {
      // 1. Validate protocol version
      if (req.x402Version !== 2) {
        return { isValid: false, invalidReason: "Unsupported x402 version" };
      }

      // 2. Validate network matches
      if (paymentPayload.accepted.network !== this.config.network) {
        return { isValid: false, invalidReason: `Network mismatch: expected ${this.config.network}` };
      }

      // 3. Validate scheme
      if (paymentPayload.accepted.scheme !== "exact") {
        return { isValid: false, invalidReason: "Only 'exact' scheme is supported" };
      }

      // 4. Validate amounts match
      if (paymentPayload.accepted.amount !== paymentRequirements.amount) {
        return { isValid: false, invalidReason: "Amount mismatch between payload and requirements" };
      }

      // 5. Validate payTo matches
      if (paymentPayload.accepted.payTo !== paymentRequirements.payTo) {
        return { isValid: false, invalidReason: "PayTo address mismatch" };
      }

      // 6. Decode the partially-signed transaction
      const txBytes = Buffer.from(paymentPayload.payload.transaction, "base64");

      // 7. Verify covenant UTXO exists
      const rpc = await this.getRpc();
      const covenantAddress = this.getCovenantAddress(
        paymentPayload.payload.clientPubkey,
        paymentPayload.payload.currentNonce,
      );
      const utxos = await rpc.getUtxosByAddresses([covenantAddress]);
      const { txid, vout } = paymentPayload.payload.channelOutpoint;

      const covenantUtxo = utxos.entries.find(
        (e) => e.outpoint.transactionId === txid && e.outpoint.index === vout,
      );

      if (!covenantUtxo) {
        return { isValid: false, invalidReason: "Covenant UTXO not found or already spent" };
      }

      // 8. Verify the UTXO has sufficient balance
      const requiredAmount = BigInt(paymentRequirements.amount) + STANDARD_FEE;
      if (covenantUtxo.amount < requiredAmount) {
        return { isValid: false, invalidReason: `Insufficient covenant balance: ${covenantUtxo.amount} < ${requiredAmount}` };
      }

      // 9. Verify the transaction structure
      //    In production, we would:
      //    a. Deserialize the TX
      //    b. Check Input[0] spends the covenant UTXO
      //    c. Check Output[0] pays to payTo for the exact amount
      //    d. Check Output[1] (if present) is change to same covenant with nonce+1
      //    e. Verify client's Schnorr signature
      //
      //    For now, we perform structural validation:
      const validationResult = await this.validateTransactionStructure(
        txBytes,
        paymentPayload,
        paymentRequirements,
        covenantUtxo,
      );

      if (!validationResult.valid) {
        return { isValid: false, invalidReason: validationResult.reason };
      }

      // 10. Check channel timeout has enough margin
      //     The covenant timeout must be > now + maxTimeoutSeconds
      //     (so facilitator has time to settle before client can refund)
      // TODO: decode timeout from covenant constructor args and validate

      return {
        isValid: true,
        payer: covenantAddress,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isValid: false, invalidReason: `Verification error: ${message}` };
    }
  }

  // ----------------------------------------------------------
  // POST /settle
  // ----------------------------------------------------------

  async settle(req: SettleRequest): Promise<SettlementResponse> {
    const { paymentPayload, paymentRequirements } = req;

    try {
      // 1. Re-verify (settlement should always re-check)
      const verifyResult = await this.verify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      });

      if (!verifyResult.isValid) {
        return {
          success: false,
          errorReason: `Verification failed: ${verifyResult.invalidReason}`,
        };
      }

      // 2. Decode the partially-signed TX
      const txBytes = Buffer.from(paymentPayload.payload.transaction, "base64");

      // 3. Add facilitator's co-signature
      //    In production with Kaspa WASM SDK:
      //    a. Deserialize TX from bytes
      //    b. Compute sighash for input 0
      //    c. Sign with facilitator's private key
      //    d. Build complete sigscript:
      //       <clientSig> <facilitatorSig> <selector:0> | <covenantScript>
      //    e. Set input[0].signatureScript
      const signedTx = await this.cosignTransaction(txBytes, paymentPayload);

      // 4. Broadcast
      const rpc = await this.getRpc();
      const result = await rpc.submitTransaction({
        transaction: signedTx,
        allowOrphan: false,
      });

      // 5. Wait for confirmation (blue score)
      const minConf = this.config.minConfirmations ?? 10;
      const blueScore = await this.waitForConfirmation(result.transactionId, minConf);

      return {
        success: true,
        transaction: result.transactionId,
        network: this.config.network,
        payer: verifyResult.payer,
        blueScore: Number(blueScore),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errorReason: `Settlement error: ${message}`,
      };
    }
  }

  // ----------------------------------------------------------
  // Internal: Get or create RPC connection
  // ----------------------------------------------------------

  private async getRpc(): Promise<KaspaRpc> {
    if (this.rpc) return this.rpc;

    // In production, this would be:
    // const { RpcClient, Encoding } = await import("kaspa-wasm");
    // this.rpc = new RpcClient({
    //   url: this.config.rpcUrl,
    //   encoding: Encoding.Borsh,
    //   networkId: NETWORK_IDS[this.config.network],
    // });
    // await this.rpc.connect();

    throw new Error(
      "Kaspa WASM SDK not yet integrated. " +
      "Install kaspa-wasm and uncomment the RPC initialization above.",
    );
  }

  // ----------------------------------------------------------
  // Internal: Get covenant P2SH address for given params
  // ----------------------------------------------------------

  private getCovenantAddress(clientPubkey: string, nonce: number): string {
    // In production with Kaspa WASM SDK:
    // 1. Take the compiled covenant bytecode
    // 2. Patch constructor args: client pubkey, facilitator pubkey, timeout, nonce
    // 3. payToScriptHashScript(patchedBytecode)
    // 4. addressFromScriptPublicKey(scriptPubKey, networkId)
    //
    // For now, return a placeholder
    // TODO: implement with actual WASM SDK
    return `kaspa:covenant-${clientPubkey.slice(0, 8)}-${nonce}`;
  }

  // ----------------------------------------------------------
  // Internal: Validate transaction structure
  // ----------------------------------------------------------

  private async validateTransactionStructure(
    txBytes: Buffer,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    covenantUtxo: UtxoEntry,
  ): Promise<{ valid: boolean; reason?: string }> {
    // In production with Kaspa WASM SDK:
    //
    // 1. Deserialize TX from bytes
    //    const tx = Transaction.deserialize(txBytes);
    //
    // 2. Check exactly 1 input
    //    if (tx.inputs.length !== 1) return { valid: false, reason: "Expected exactly 1 input" };
    //
    // 3. Check input[0] references the covenant UTXO
    //    const input = tx.inputs[0];
    //    if (input.previousOutpoint.transactionId !== payload.payload.channelOutpoint.txid ||
    //        input.previousOutpoint.index !== payload.payload.channelOutpoint.vout) {
    //      return { valid: false, reason: "Input does not reference the covenant UTXO" };
    //    }
    //
    // 4. Check output[0] pays to payTo for exact amount
    //    const payToScript = payToAddressScript(requirements.payTo);
    //    if (tx.outputs[0].scriptPublicKey.toString() !== payToScript.toString()) {
    //      return { valid: false, reason: "Output[0] does not pay to the required address" };
    //    }
    //    if (tx.outputs[0].value !== BigInt(requirements.amount)) {
    //      return { valid: false, reason: "Output[0] amount mismatch" };
    //    }
    //
    // 5. Check output[1] (if present) is change to same covenant with nonce+1
    //    if (tx.outputs.length === 2) {
    //      const expectedChangeAddr = this.getCovenantAddress(
    //        payload.payload.clientPubkey,
    //        payload.payload.currentNonce + 1,
    //      );
    //      // verify output[1].scriptPubKey matches
    //    }
    //
    // 6. No extra outputs
    //    if (tx.outputs.length > 2) return { valid: false, reason: "Unexpected extra outputs" };
    //
    // 7. Verify client's signature
    //    const sighash = calcSchnorrSignatureHash(tx, 0, ...);
    //    if (!verifySchnorr(sighash, payload.payload.clientPubkey, clientSig)) {
    //      return { valid: false, reason: "Invalid client signature" };
    //    }

    // TODO: implement with actual WASM SDK
    // For now, basic byte-level checks
    if (txBytes.length < 10) {
      return { valid: false, reason: "Transaction too short" };
    }

    return { valid: true };
  }

  // ----------------------------------------------------------
  // Internal: Co-sign transaction with facilitator key
  // ----------------------------------------------------------

  private async cosignTransaction(
    txBytes: Buffer,
    payload: PaymentPayload,
  ): Promise<unknown> {
    // In production with Kaspa WASM SDK:
    //
    // 1. Deserialize TX
    //    const tx = Transaction.deserialize(txBytes);
    //
    // 2. Extract client's signature from the partial sigscript
    //    const clientSig = extractClientSignature(tx.inputs[0].signatureScript);
    //
    // 3. Compute sighash for input 0
    //    const privateKey = new PrivateKey(this.config.privateKeyHex);
    //    const facilitatorSigHex = createInputSignature(tx, 0, privateKey, SighashType.All);
    //    const facilitatorSig = hexToBytes(facilitatorSigHex);
    //
    // 4. Build complete sigscript using ScriptBuilder:
    //    const builder = new ScriptBuilder();
    //    builder.addData(clientSig);        // arg 0: client signature (65 bytes)
    //    builder.addData(facilitatorSig);   // arg 1: facilitator signature (65 bytes)
    //    builder.addI64(0n);                // function selector: 0 = settle
    //    const sigPrefix = builder.drain();
    //
    // 5. Wrap with covenant script:
    //    const covenantBytes = Uint8Array.from(this.config.compiledCovenant.script);
    //    tx.inputs[0].signatureScript =
    //      ScriptBuilder.fromScript(covenantBytes)
    //        .encodePayToScriptHashSignatureScript(sigPrefix);
    //
    // 6. Return the fully-signed TX object

    // TODO: implement with actual WASM SDK
    throw new Error("WASM SDK not yet integrated for co-signing");
  }

  // ----------------------------------------------------------
  // Internal: Wait for confirmation by blue score
  // ----------------------------------------------------------

  private async waitForConfirmation(
    txid: string,
    minConfirmations: number,
  ): Promise<bigint> {
    const rpc = await this.getRpc();

    // Poll block DAG info for blue score advancement
    // Each block is ~1 second on Kaspa, so 10 confirmations ≈ 10 seconds
    const startInfo = await rpc.getBlockDagInfo();
    const targetScore = startInfo.virtualDaaScore + BigInt(minConfirmations);

    let currentScore = startInfo.virtualDaaScore;
    while (currentScore < targetScore) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const info = await rpc.getBlockDagInfo();
      currentScore = info.virtualDaaScore;
    }

    return currentScore;
  }

  // ----------------------------------------------------------
  // Cleanup
  // ----------------------------------------------------------

  async close(): Promise<void> {
    if (this.rpc) {
      await this.rpc.disconnect();
      this.rpc = null;
    }
  }
}
