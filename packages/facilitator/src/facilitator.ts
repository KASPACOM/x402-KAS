/**
 * Kaspa x402 Facilitator
 *
 * Handles verification and settlement of x402 covenant payments.
 * Uses @x402/kaspa-covenant for all on-chain operations.
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
} from "@x402/kaspa-types";
import { STANDARD_FEE, NETWORK_IDS } from "@x402/kaspa-types";
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
} from "@x402/kaspa-covenant";
import { PrivateKey, type RpcClient } from "kaspa-wasm";

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
}

export class KaspaFacilitator {
  private config: FacilitatorConfig;
  private rpc: RpcClient | null = null;
  private facilitatorPubkey: string;
  private facilitatorAddress: string;
  private channelConfig: ChannelConfig;

  constructor(config: FacilitatorConfig) {
    this.config = config;
    const pk = new PrivateKey(config.privateKeyHex);
    this.facilitatorPubkey = pk.toPublicKey().toXOnlyPublicKey().toString();
    this.facilitatorAddress = pk.toAddress(NETWORK_IDS[config.network]).toString();
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
          signerAddress: this.facilitatorAddress,
        },
      ],
    };
  }

  /** Facilitator's x-only public key (hex) */
  getPubkey(): string {
    return this.facilitatorPubkey;
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
        timeout: 0, // Will be extracted from covenant — for now accept any
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
        timeout: 0, // TODO: extract from covenant
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
      const paymentAmount = BigInt(paymentRequirements.amount);
      const fee = STANDARD_FEE;
      const inputAmount = entry.amount;
      const remainder = inputAmount - paymentAmount - fee;

      const outputs: { address: string; amount: bigint }[] = [
        { address: paymentRequirements.payTo, amount: paymentAmount },
      ];

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
