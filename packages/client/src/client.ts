/**
 * x402 Kaspa Client SDK
 *
 * Manages payment channels and handles x402 payment flows:
 * 1. Open a channel (deploy covenant, lock KAS)
 * 2. Make payments (build partial-sign settle TX)
 * 3. Auto-retry HTTP requests on 402 responses
 * 4. Refund channels after timeout
 */

import type {
  PaymentRequired,
  PaymentRequirements,
  PaymentPayload,
  KaspaPayload,
  KaspaNetwork,
  CovenantOutpoint,
  ChannelInfo,
  CompiledContract,
} from "@x402/kaspa-types";
import { STANDARD_FEE, NETWORK_IDS } from "@x402/kaspa-types";
import {
  type ChannelConfig,
  type ChannelParams,
  type TemplatePatch,
  buildPartialSettle,
  refundChannel,
  getChannelAddress,
  patchChannelContract,
  kascovDeploy,
  connectRpc,
  getAddressUtxos,
} from "@x402/kaspa-covenant";
import { PrivateKey, type RpcClient } from "kaspa-wasm";

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

export interface X402ClientConfig {
  /** Client's private key (hex) */
  privateKeyHex: string;
  /** CAIP-2 network identifier */
  network: KaspaNetwork;
  /** Kaspa wRPC URL (for WASM RPC calls) */
  rpcUrl: string;
  /** Kaspa gRPC endpoint for kascov CLI (e.g. "tn12-node.kaspa.com:16210") */
  kascovRpcUrl?: string;
  /** Compiled X402Channel covenant template */
  compiledTemplate: CompiledContract;
  /** Patch descriptor for template */
  patchDescriptor: TemplatePatch;
  /** Default channel timeout in seconds (default: 86400 = 24h) */
  defaultTimeout?: number;
  /** Default channel funding amount in sompi (default: 10 KAS) */
  defaultFunding?: bigint;
}

// ────────────────────────────────────────────────────────────────
// Client
// ────────────────────────────────────────────────────────────────

export class X402Client {
  private config: X402ClientConfig;
  private clientPubkey: string;
  private clientAddress: string;
  private channelConfig: ChannelConfig;
  private channels: Map<string, ChannelInfo> = new Map();

  constructor(config: X402ClientConfig) {
    this.config = config;
    const pk = new PrivateKey(config.privateKeyHex);
    const networkId = NETWORK_IDS[config.network];
    this.clientPubkey = pk.toPublicKey().toXOnlyPublicKey().toString();
    this.clientAddress = pk.toAddress(networkId).toString();
    this.channelConfig = {
      compiledTemplate: config.compiledTemplate,
      patchDescriptor: config.patchDescriptor,
      network: networkId,
      rpcUrl: config.rpcUrl,
    };
  }

  getPubkey(): string {
    return this.clientPubkey;
  }

  getAddress(): string {
    return this.clientAddress;
  }

  // ----------------------------------------------------------
  // Channel Management
  // ----------------------------------------------------------

  /**
   * Open a payment channel with a facilitator.
   * Uses kascov CLI for deployment (bypasses broken WASM createTransactions).
   */
  async openChannel(
    facilitatorPubkey: string,
    amountSompi?: bigint,
    timeoutSeconds?: number,
  ): Promise<ChannelInfo> {
    const amount = amountSompi ?? this.config.defaultFunding ?? 1_000_000_000n;
    const timeout = Math.floor(Date.now() / 1000) + (timeoutSeconds ?? this.config.defaultTimeout ?? 86400);

    const params: ChannelParams = {
      clientPubkey: this.clientPubkey,
      facilitatorPubkey,
      timeout,
      nonce: 0,
    };

    // Patch the covenant template with real args
    const patched = patchChannelContract(this.channelConfig, params);

    // Deploy via kascov CLI (works around WASM createTransactions crash)
    const result = await kascovDeploy(
      patched,
      amount,
      this.config.privateKeyHex,
      this.config.kascovRpcUrl,
    );

    const channel: ChannelInfo = {
      address: result.contractAddress,
      outpoint: result.outpoint,
      clientPubkey: this.clientPubkey,
      facilitatorPubkey,
      timeout,
      nonce: 0,
      balance: amount,
    };

    this.channels.set(facilitatorPubkey, channel);
    return channel;
  }

  getChannel(facilitatorPubkey: string): ChannelInfo | null {
    return this.channels.get(facilitatorPubkey) ?? null;
  }

  listChannels(): ChannelInfo[] {
    return Array.from(this.channels.values());
  }

  async refreshChannel(facilitatorPubkey: string): Promise<ChannelInfo | null> {
    const channel = this.channels.get(facilitatorPubkey);
    if (!channel) return null;

    const rpc = connectRpc(this.config.rpcUrl, NETWORK_IDS[this.config.network]);
    try {
      await rpc.connect();
      const utxos = await getAddressUtxos(rpc, channel.address);
      const entry = utxos.find(
        (u) => u.outpoint.transactionId === channel.outpoint.txid && u.outpoint.index === channel.outpoint.vout,
      );

      if (entry) {
        channel.balance = entry.amount;
        return channel;
      }

      this.channels.delete(facilitatorPubkey);
      return null;
    } finally {
      await rpc.disconnect().catch(() => {});
    }
  }

  // ----------------------------------------------------------
  // Payment Construction
  // ----------------------------------------------------------

  /**
   * Build a payment for an x402 resource.
   * Returns a PaymentPayload to send as PAYMENT-SIGNATURE header.
   */
  async buildPayment(
    requirements: PaymentRequirements,
    resource: { url: string; description: string; mimeType: string },
  ): Promise<PaymentPayload> {
    const facilitatorPubkey = requirements.extra.facilitatorPubkey;

    let channel = this.channels.get(facilitatorPubkey);
    if (!channel) {
      channel = await this.openChannel(facilitatorPubkey);
    }

    const paymentAmount = BigInt(requirements.amount);
    if (channel.balance < paymentAmount + STANDARD_FEE) {
      throw new Error(`Insufficient channel balance: ${channel.balance} < ${paymentAmount + STANDARD_FEE}`);
    }

    const params: ChannelParams = {
      clientPubkey: channel.clientPubkey,
      facilitatorPubkey: channel.facilitatorPubkey,
      timeout: channel.timeout,
      nonce: channel.nonce,
    };

    const partial = await buildPartialSettle(
      this.channelConfig,
      params,
      channel.outpoint,
      channel.balance,
      requirements.payTo,
      paymentAmount,
      this.config.privateKeyHex,
    );

    const payload: KaspaPayload = {
      transaction: partial.clientSignatureHex,
      channelOutpoint: channel.outpoint,
      clientPubkey: this.clientPubkey,
      currentNonce: channel.nonce,
      channelTimeout: channel.timeout,
    };

    return {
      x402Version: 2,
      resource,
      accepted: requirements,
      payload,
    };
  }

  /**
   * Update local channel state after a successful settlement.
   */
  updateChannelAfterSettle(
    facilitatorPubkey: string,
    newOutpoint: CovenantOutpoint,
    newBalance: bigint,
  ): void {
    const channel = this.channels.get(facilitatorPubkey);
    if (!channel) return;

    channel.outpoint = newOutpoint;
    channel.nonce += 1;
    channel.balance = newBalance;

    const params: ChannelParams = {
      clientPubkey: channel.clientPubkey,
      facilitatorPubkey: channel.facilitatorPubkey,
      timeout: channel.timeout,
      nonce: channel.nonce,
    };
    channel.address = getChannelAddress(this.channelConfig, params);
  }

  // ----------------------------------------------------------
  // Refund
  // ----------------------------------------------------------

  /**
   * Refund a channel after timeout.
   */
  async refund(facilitatorPubkey: string): Promise<{ txid: string }> {
    const channel = this.channels.get(facilitatorPubkey);
    if (!channel) throw new Error("No channel found for this facilitator");

    const now = Math.floor(Date.now() / 1000);
    if (now < channel.timeout) {
      throw new Error(`Timeout not reached: ${channel.timeout - now}s remaining`);
    }

    const params: ChannelParams = {
      clientPubkey: channel.clientPubkey,
      facilitatorPubkey: channel.facilitatorPubkey,
      timeout: channel.timeout,
      nonce: channel.nonce,
    };

    const result = await refundChannel(
      this.channelConfig,
      params,
      channel.outpoint,
      channel.balance,
      this.clientAddress,
      this.config.privateKeyHex,
    );

    this.channels.delete(facilitatorPubkey);
    return result;
  }

  // ----------------------------------------------------------
  // HTTP Fetch with 402 Auto-Retry
  // ----------------------------------------------------------

  /**
   * Fetch a resource, automatically handling 402 Payment Required.
   */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await globalThis.fetch(url, init);

    if (response.status !== 402) return response;

    const paymentRequired: PaymentRequired = await response.json();
    if (paymentRequired.x402Version !== 2) {
      throw new Error(`Unsupported x402 version: ${paymentRequired.x402Version}`);
    }

    const kaspaOption = paymentRequired.accepts.find(
      (a) => a.network === this.config.network && a.scheme === "exact",
    );
    if (!kaspaOption) {
      throw new Error(`No compatible payment option for ${this.config.network}`);
    }

    const paymentPayload = await this.buildPayment(kaspaOption, paymentRequired.resource);

    const headers = new Headers(init?.headers);
    headers.set("PAYMENT-SIGNATURE", JSON.stringify(paymentPayload));

    return globalThis.fetch(url, { ...init, headers });
  }
}
