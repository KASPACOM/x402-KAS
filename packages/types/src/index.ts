// ============================================================
// x402 Kaspa Protocol Types
// ============================================================
// Follows x402 v2 specification adapted for Kaspa UTXO model.
// See: specs/scheme_exact_kaspa.md

// ------------------------------------------------------------
// Core x402 Types
// ------------------------------------------------------------

export interface ResourceInfo {
  url: string;
  description: string;
  mimeType: string;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: KaspaNetwork;
  /** Amount in sompi (1 KAS = 100_000_000 sompi) */
  amount: string;
  /** "KAS" for native KAS */
  asset: "KAS";
  /** Kaspa bech32 address (kaspa:qz...) */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: KaspaExtra;
}

export interface KaspaExtra {
  facilitatorUrl: string;
  /** Facilitator's x-only public key (hex, 64 chars) */
  facilitatorPubkey: string;
}

export interface PaymentRequired {
  x402Version: 2;
  error: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface KaspaPayload {
  /** Base64-encoded partially-signed Kaspa TX */
  transaction: string;
  /** Covenant UTXO being spent */
  channelOutpoint: CovenantOutpoint;
  /** Client's x-only public key (hex) */
  clientPubkey: string;
  /** Current nonce in the covenant state */
  currentNonce: number;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: ResourceInfo;
  accepted: PaymentRequirements;
  payload: KaspaPayload;
  extensions?: Record<string, unknown>;
}

// ------------------------------------------------------------
// Facilitator Types
// ------------------------------------------------------------

export interface VerifyRequest {
  x402Version: 2;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface SettleRequest {
  x402Version: 2;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface SettlementResponse {
  success: boolean;
  transaction?: string;
  network?: KaspaNetwork;
  payer?: string;
  blueScore?: number;
  errorReason?: string;
}

export interface SupportedEntry {
  scheme: "exact";
  network: KaspaNetwork;
  signerAddress: string;
}

export interface SupportedResponse {
  supported: SupportedEntry[];
}

// ------------------------------------------------------------
// Compiled Contract Types (from SilverScript compiler)
// ------------------------------------------------------------

export interface CompiledContractAstTypeRef {
  base: string;
  array_dims?: { value: number }[];
}

export interface CompiledContractAstParam {
  type_ref: CompiledContractAstTypeRef;
  name: string;
}

export interface CompiledContractAstNode {
  kind: string;
  data: unknown;
}

export interface CompiledContractFunction {
  name: string;
  params: CompiledContractAstParam[];
  entrypoint: boolean;
  return_types: CompiledContractAstTypeRef[];
  body: CompiledContractAstNode[];
}

export interface CompiledContractAst {
  name: string;
  params: CompiledContractAstParam[];
  constants: Record<string, unknown>;
  functions: CompiledContractFunction[];
  fields?: any[];
}

export interface CompiledContractAbiInput {
  name: string;
  type_name: string;
}

export interface CompiledContractAbiEntry {
  name: string;
  inputs: CompiledContractAbiInput[];
}

export interface CompiledContract {
  contract_name: string;
  script: number[];
  ast: CompiledContractAst;
  abi: CompiledContractAbiEntry[];
  without_selector: boolean;
}

export interface SpendOutput {
  address: string;
  amount: bigint;
}

// ------------------------------------------------------------
// Kaspa-Specific Types
// ------------------------------------------------------------

export interface CovenantOutpoint {
  txid: string;
  vout: number;
}

export interface ChannelInfo {
  /** Covenant P2SH address */
  address: string;
  /** Current UTXO outpoint */
  outpoint: CovenantOutpoint;
  /** Client's x-only public key (hex) */
  clientPubkey: string;
  /** Facilitator's x-only public key (hex) */
  facilitatorPubkey: string;
  /** Refund timeout (absolute timestamp) */
  timeout: number;
  /** Current nonce (increments each payment) */
  nonce: number;
  /** Current balance in sompi */
  balance: bigint;
}

export interface DeployChannelResult {
  txid: string;
  channelAddress: string;
  outpoint: CovenantOutpoint;
}

export interface SettleChannelResult {
  txid: string;
  newOutpoint?: CovenantOutpoint;
  newBalance?: bigint;
  newNonce?: number;
}

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

/** 1 KAS = 100,000,000 sompi */
export const SOMPI_PER_KAS = 100_000_000n;

/** Standard miner fee in sompi */
export const STANDARD_FEE = 1000n;

/** Kaspa CAIP-2 network identifiers */
export type KaspaNetwork = "kaspa:mainnet" | "kaspa:testnet-11" | "kaspa:testnet-12";

/** Map CAIP-2 identifiers to Kaspa SDK network IDs */
export const NETWORK_IDS: Record<KaspaNetwork, string> = {
  "kaspa:mainnet": "mainnet",
  "kaspa:testnet-11": "testnet-11",
  "kaspa:testnet-12": "testnet-12",
};

/** Native subnetwork ID */
export const SUBNETWORK_ID_NATIVE = "0000000000000000000000000000000000000000";

// ------------------------------------------------------------
// X402Channel Covenant ABI
// ------------------------------------------------------------

export const X402_CHANNEL_ABI = {
  contractName: "X402Channel",
  constructorParams: [
    { name: "client", type: "pubkey" },
    { name: "facilitator", type: "pubkey" },
    { name: "timeout", type: "int" },
    { name: "nonce", type: "int" },
  ],
  entrypoints: [
    {
      name: "settle",
      selector: 0,
      inputs: [
        { name: "clientSig", type: "sig" },
        { name: "facilitatorSig", type: "sig" },
      ],
      sigOpCount: 2,
    },
    {
      name: "refund",
      selector: 1,
      inputs: [
        { name: "clientSig", type: "sig" },
      ],
      sigOpCount: 1,
    },
  ],
} as const;
