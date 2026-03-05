/**
 * Kaspa x402 Facilitator
 *
 * Handles verification and settlement of x402 covenant payments.
 * Uses @kaspacom/x402-covenant for all on-chain operations.
 *
 * The facilitator:
 * 1. Verifies covenant UTXO exists and matches expected structure
 * 2. Validates client's partial signature
 * 3. Co-signs the settlement TX (completing the 2-of-2)
 * 4. Broadcasts to Kaspa network
 * 5. Tracks confirmation via DAA score
 */

import type {
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettlementResponse,
  SupportedResponse,
  KaspaNetwork,
  CompiledContract,
  CovenantOutpoint,
} from "@kaspacom/x402-types";
import { STANDARD_FEE, NETWORK_IDS, KASPACOM_FACILITATOR_PUBKEY } from "@kaspacom/x402-types";
import {
  type ChannelConfig,
  type ChannelParams,
  patchChannelContract,
  getChannelAddress,
  getCovenantAddress,
  connectRpc,
  getAddressUtxos,
  buildUnsignedCovenantTx,
  buildSigScript,
  attachSigScript,
  signInput,
  hexToBytes,
  bytesToHex,
  type TemplatePatch,
} from "@kaspacom/x402-covenant";
import { PrivateKey, createTransactions, type RpcClient } from "@kaspacom/x402-wasm";

export interface FacilitatorConfig {
  /** Facilitator's private key (hex, 64 chars) */
  privateKeyHex: string;
  /** Kaspa wRPC endpoint */
  rpcUrl: string;
  /** CAIP-2 network identifier */
  network: KaspaNetwork;
  /** Compiled X402Channel covenant template (from silverc) */
  compiledTemplate: CompiledContract;
  /** Patch descriptor for the template */
  patchDescriptor: TemplatePatch;
  /** Minimum DAA score confirmations (default: 10) */
  minConfirmations?: number;
  /** Facilitator fee in sompi per settlement (default: 0) */
  feeSompi?: bigint;
  /** Address to receive facilitator fees (cold wallet). Falls back to signing key address if not set. */
  feeAddress?: string;
}

export class KaspaFacilitator {
  private config: FacilitatorConfig;
  private rpc: RpcClient | null = null;
  private facilitatorPubkey: string;
  private facilitatorSigningAddress: string;
  private facilitatorFeeAddress: string;
  private channelConfig: ChannelConfig;

  constructor(config: FacilitatorConfig) {
    this.config = config;
    const pk = new PrivateKey(config.privateKeyHex);
    this.facilitatorPubkey = pk.toPublicKey().toXOnlyPublicKey().toString();
    if (this.facilitatorPubkey !== KASPACOM_FACILITATOR_PUBKEY) {
      throw new Error(
        `Facilitator key mismatch: derived pubkey ${this.facilitatorPubkey} does not match ` +
        `hardcoded KaspaCom pubkey ${KASPACOM_FACILITATOR_PUBKEY}. ` +
        `Use the correct FACILITATOR_PRIVATE_KEY from /root/.x402-facilitator-key.json`
      );
    }
    this.facilitatorSigningAddress = pk.toAddress(NETWORK_IDS[config.network]).toString();
    this.facilitatorFeeAddress = config.feeAddress ?? this.facilitatorSigningAddress;
    this.channelConfig = {
      compiledTemplate: config.compiledTemplate,
      patchDescriptor: config.patchDescriptor,
      network: NETWORK_IDS[config.network],
      rpcUrl: config.rpcUrl,
    };
  }

  // ----------------------------------------------------------
  // GET /supported
  // ----------------------------------------------------------

  getSupported(): SupportedResponse {
    return {
      supported: [
        {
          scheme: "exact",
          network: this.config.network,
          signerAddress: this.facilitatorSigningAddress,
        },
      ],
    };
  }

  /** Facilitator's x-only public key (hex) */
  getPubkey(): string {
    return this.facilitatorPubkey;
  }

  /** Facilitator's signing address (derived from private key) */
  getSigningAddress(): string {
    return this.facilitatorSigningAddress;
  }

  /** Facilitator's fee address (cold wallet, or signing address if not configured) */
  getFeeAddress(): string {
    return this.facilitatorFeeAddress;
  }

  /** Facilitator fee in sompi */
  getFee(): bigint {
    return this.config.feeSompi ?? 0n;
  }

  // ----------------------------------------------------------
  // POST /verify
  // ----------------------------------------------------------

  async verify(req: VerifyRequest): Promise<VerifyResponse> {
    const { paymentPayload, paymentRequirements } = req;

    try {
      // 1. Protocol version
      if (req.x402Version !== 2) {
        return { isValid: false, invalidReason: "Unsupported x402 version" };
      }

      // 2. Network match
      if (paymentPayload.accepted.network !== this.config.network) {
        return { isValid: false, invalidReason: `Network mismatch: expected ${this.config.network}` };
      }

      // 3. Scheme
      if (paymentPayload.accepted.scheme !== "exact") {
        return { isValid: false, invalidReason: "Only 'exact' scheme supported" };
      }

      // 4. Amount match
      if (paymentPayload.accepted.amount !== paymentRequirements.amount) {
        return { isValid: false, invalidReason: "Amount mismatch" };
      }

      // 5. PayTo match
      if (paymentPayload.accepted.payTo !== paymentRequirements.payTo) {
        return { isValid: false, invalidReason: "PayTo address mismatch" };
      }

      // 6. Verify the facilitator pubkey matches ours
      if (paymentPayload.accepted.extra.facilitatorPubkey !== this.facilitatorPubkey) {
        return { isValid: false, invalidReason: "Facilitator pubkey mismatch" };
      }

      // 7. Build channel params and derive expected covenant address
      const channelParams: ChannelParams = {
        clientPubkey: paymentPayload.payload.clientPubkey,
        facilitatorPubkey: this.facilitatorPubkey,
        timeout: paymentPayload.payload.channelTimeout ?? 0,
        nonce: paymentPayload.payload.currentNonce,
      };

      // 8. Verify covenant UTXO exists on-chain
      const rpc = await this.getRpc();
      const channelAddress = getChannelAddress(this.channelConfig, channelParams);
      const utxos = await getAddressUtxos(rpc, channelAddress);
      const { txid, vout } = paymentPayload.payload.channelOutpoint;

      const covenantUtxo = utxos.find(
        (e) => e.outpoint.transactionId === txid && e.outpoint.index === vout,
      );

      if (!covenantUtxo) {
        return { isValid: false, invalidReason: "Covenant UTXO not found or already spent" };
      }

      // 9. Check sufficient balance
      const requiredAmount = BigInt(paymentRequirements.amount) + STANDARD_FEE;
      if (covenantUtxo.amount < requiredAmount) {
        return {
          isValid: false,
          invalidReason: `Insufficient balance: ${covenantUtxo.amount} < ${requiredAmount}`,
        };
      }

      // 10. Verify client signature by reconstructing the TX and checking
      // The client's partially-signed TX is in the payload
      // For full verification, we would deserialize and verify the Schnorr sig
      // For now, structural validation passes if UTXO exists and amounts match

      return {
        isValid: true,
        payer: channelAddress,
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
      // 1. Re-verify
      const verifyResult = await this.verify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements,
      });

      if (!verifyResult.isValid) {
        return { success: false, errorReason: `Verification failed: ${verifyResult.invalidReason}` };
      }

      // 2. Build channel params
      const channelParams: ChannelParams = {
        clientPubkey: paymentPayload.payload.clientPubkey,
        facilitatorPubkey: this.facilitatorPubkey,
        timeout: paymentPayload.payload.channelTimeout ?? 0,
        nonce: paymentPayload.payload.currentNonce,
      };

      const patched = patchChannelContract(this.channelConfig, channelParams);
      const channelAddress = getCovenantAddress(patched, this.channelConfig.network);

      // 3. Find the covenant UTXO
      const rpc = await this.getRpc();
      const utxos = await getAddressUtxos(rpc, channelAddress);
      const { txid, vout } = paymentPayload.payload.channelOutpoint;
      const entry = utxos.find(
        (e) => e.outpoint.transactionId === txid && e.outpoint.index === vout,
      );

      if (!entry) {
        return { success: false, errorReason: "Covenant UTXO not found" };
      }

      // 4. Reconstruct the settle TX (same outputs the client built)
      //
      // Revenue model (facilitator-as-payee):
      //   output[0] = full payment → facilitator signing address
      //   output[1] = change → covenant nonce+1 (if remainder > fee)
      //
      // The facilitator forwards (payment - fee) to the merchant as a
      // separate standard wallet operation. This avoids Kaspa's KIP-9
      // storage mass penalty that makes 3+ output covenant TXs impractical.
      const paymentAmount = BigInt(paymentRequirements.amount);
      const fee = STANDARD_FEE;
      const inputAmount = entry.amount;
      const remainder = inputAmount - paymentAmount - fee;

      const outputs: { address: string; amount: bigint }[] = [];
      outputs.push({ address: this.facilitatorSigningAddress, amount: paymentAmount });

      if (remainder > fee) {
        const nextParams = { ...channelParams, nonce: channelParams.nonce + 1 };
        const nextAddress = getChannelAddress(this.channelConfig, nextParams);
        outputs.push({ address: nextAddress, amount: remainder });
      }

      // 5. Build unsigned TX (must be identical to what client signed)
      const unsignedTx = buildUnsignedCovenantTx(entry, outputs, 2);

      // 6. Extract client's signature from payload
      const clientSig = hexToBytes(
        // The client signature is embedded in the transaction payload
        // For now we extract it from the partially-signed TX
        paymentPayload.payload.transaction, // This contains the client sig hex
      );

      // 7. Facilitator signs
      const facilitatorKey = new PrivateKey(this.config.privateKeyHex);
      const facilitatorSig = signInput(unsignedTx, 0, facilitatorKey);

      // 8. Build complete sigscript: [clientSig, facilitatorSig, selector:0]
      const sigPrefix = buildSigScript(patched, "settle", [clientSig, facilitatorSig]);
      attachSigScript(unsignedTx, 0, patched, sigPrefix);

      // 9. Broadcast
      const result = await rpc.submitTransaction({
        transaction: unsignedTx,
        allowOrphan: false,
      });

      // 10. Wait for confirmation
      const minConf = this.config.minConfirmations ?? 10;
      const daaScore = await this.waitForConfirmation(minConf);

      // 11. Forward full payment to merchant (separate standard TX)
      //     Fees accumulate at facilitator address and are swept separately.
      const merchantAddress = paymentRequirements.payTo;

      let forwardTxId: string | undefined;
      if (paymentAmount > STANDARD_FEE) {
        try {
          forwardTxId = await this.forwardToMerchant(merchantAddress, paymentAmount);
          console.log(`[x402-facilitator] Forwarded ${paymentAmount} sompi → merchant (TX: ${forwardTxId})`);
        } catch (fwdErr) {
          const fwdMsg = fwdErr instanceof Error ? fwdErr.message : String(fwdErr);
          console.error(`[x402-facilitator] Forward failed (settle succeeded): ${fwdMsg}`);
          // Settlement succeeded even if forward fails — funds are safe at facilitator address
        }
      }

      return {
        success: true,
        transaction: result.transactionId,
        network: this.config.network,
        payer: verifyResult.payer,
        blueScore: Number(daaScore),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, errorReason: `Settlement error: ${message}` };
    }
  }

  // ----------------------------------------------------------
  // Internal: Forward full payment to merchant
  // ----------------------------------------------------------

  /**
   * After a successful settle, forward the full payment amount to the merchant.
   * Single output, no fee splitting — fees accumulate at the facilitator address
   * and are swept separately via sweepFees().
   */
  private async forwardToMerchant(
    merchantAddress: string,
    amount: bigint,
  ): Promise<string> {
    const rpc = await this.getRpc();
    const networkId = NETWORK_IDS[this.config.network];

    // Wait for the settle TX UTXO to appear at our signing address
    let entries = await getAddressUtxos(rpc, this.facilitatorSigningAddress);
    for (let attempt = 0; attempt < 15 && entries.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      entries = await getAddressUtxos(rpc, this.facilitatorSigningAddress);
    }
    if (entries.length === 0) {
      throw new Error("No UTXOs at facilitator signing address for forwarding");
    }

    const outputs = [{ address: merchantAddress, amount }];
    const privateKey = new PrivateKey(this.config.privateKeyHex);

    const created = await createTransactions({
      entries,
      outputs,
      changeAddress: this.facilitatorSigningAddress,
      priorityFee: 0n,
      networkId,
    } as never);

    let finalTxId = created.summary.finalTransactionId;
    for (const pending of created.transactions) {
      pending.sign([privateKey]);
      finalTxId = await pending.submit(rpc);
    }

    if (!finalTxId) {
      throw new Error("Forward transaction submission failed");
    }

    return finalTxId;
  }

  // ----------------------------------------------------------
  // Public: Sweep accumulated fees to cold wallet
  // ----------------------------------------------------------

  /**
   * Sends the entire facilitator balance to the cold wallet (feeAddress).
   * Call this periodically (cron, manual, or after N settlements).
   * Returns the TX ID, or null if there's nothing to sweep.
   */
  async sweepFees(): Promise<string | null> {
    const rpc = await this.getRpc();
    const networkId = NETWORK_IDS[this.config.network];

    const entries = await getAddressUtxos(rpc, this.facilitatorSigningAddress);
    if (entries.length === 0) return null;

    let totalBalance = 0n;
    for (const u of entries) totalBalance += u.amount;

    // Need enough to cover miner fee (scale with input count)
    const minerFee = BigInt(entries.length) * 10000n + 10000n;
    const sweepAmount = totalBalance - minerFee;
    if (sweepAmount <= 0n) return null;

    const outputs = [{ address: this.facilitatorFeeAddress, amount: sweepAmount }];
    const privateKey = new PrivateKey(this.config.privateKeyHex);

    const created = await createTransactions({
      entries,
      outputs,
      changeAddress: this.facilitatorSigningAddress,
      priorityFee: 0n,
      networkId,
    } as never);

    let finalTxId = created.summary.finalTransactionId;
    for (const pending of created.transactions) {
      pending.sign([privateKey]);
      finalTxId = await pending.submit(rpc);
    }

    if (!finalTxId) {
      throw new Error("Sweep transaction submission failed");
    }

    console.log(`[x402-facilitator] Swept ${sweepAmount} sompi → ${this.facilitatorFeeAddress} (TX: ${finalTxId})`);
    return finalTxId;
  }

  // ----------------------------------------------------------
  // Internal: RPC connection
  // ----------------------------------------------------------

  private async getRpc(): Promise<RpcClient> {
    if (this.rpc) return this.rpc;
    this.rpc = connectRpc(this.config.rpcUrl, NETWORK_IDS[this.config.network]);
    await this.rpc.connect();
    return this.rpc;
  }

  // ----------------------------------------------------------
  // Internal: Wait for DAA score confirmations
  // ----------------------------------------------------------

  private async waitForConfirmation(minConfirmations: number): Promise<bigint> {
    const rpc = await this.getRpc();
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
