# x402-kaspa

HTTP 402 payment protocol for Kaspa L1 using SilverScript covenants.

## Architecture

```
Client                    Resource Server              Facilitator
  |                            |                           |
  |-- GET /resource ---------->|                           |
  |<- 402 + PAYMENT-REQUIRED --|                           |
  |                            |                           |
  | [build partial TX,         |                           |
  |  sign client half]         |                           |
  |                            |                           |
  |-- GET /resource ---------->|                           |
  |   + PAYMENT-SIGNATURE      |-- POST /verify ---------->|
  |                            |<- {isValid: true} --------|
  |                            |                           |
  |                            | [serve resource]          |
  |                            |                           |
  |                            |-- POST /settle ---------->|
  |                            |   [co-sign + broadcast]   |
  |<- 200 + resource ---------|<- {success, txid} --------|
```

## How It Works

1. **Client opens a channel** — deploys an `X402Channel` SilverScript covenant, locking KAS
2. **Client requests a resource** — gets back `402 Payment Required` with price
3. **Client builds payment** — creates a partial TX spending the covenant, signs their half
4. **Facilitator verifies** — checks covenant UTXO exists, validates TX structure and signature
5. **Facilitator settles** — co-signs (completing 2-of-2), broadcasts to Kaspa blockDAG
6. **Channel persists** — change returns to same covenant with incremented nonce

## Packages

| Package | Description |
|---------|-------------|
| `@x402/kaspa-types` | Shared type definitions |
| `@x402/kaspa-facilitator` | Facilitator HTTP service (/verify, /settle, /supported) |
| `@x402/kaspa` | Client SDK (channel management, payment building) |

## Covenant Contract

`contracts/silverscript/x402-channel.sil` — the SilverScript covenant with two entrypoints:

- **settle(clientSig, facilitatorSig)** — 2-of-2 payment to server, change back to covenant
- **refund(clientSig)** — client reclaims after timeout

## Status

**Phase 1: Covenant** — x402-channel.sil written, needs compilation and TN12 testing
**Phase 2: Facilitator** — HTTP server with verify/settle logic (WASM SDK integration pending)
**Phase 3: Client SDK** — Channel open/pay/refund helpers (WASM SDK integration pending)

## Requirements

- Kaspa Testnet 12 (covenants enabled)
- `silverc` compiler (from [kaspanet/silverscript](https://github.com/kaspanet/silverscript))
- `kaspa-wasm` SDK for transaction building

## Quick Start

```bash
# 1. Compile the covenant
silverc contracts/silverscript/x402-channel.sil -o contracts/compiled/x402-channel.json

# 2. Start the facilitator
FACILITATOR_PRIVATE_KEY=<hex> KASPA_RPC_URL=ws://tn12.kaspa.com:17210 \
  npx tsx packages/facilitator/src/server.ts

# 3. Use the client SDK
import { X402KaspaClient } from "@x402/kaspa";
const client = new X402KaspaClient({ privateKeyHex: "...", rpcUrl: "...", network: "kaspa:testnet-12", compiledCovenant });
await client.openChannel(facilitatorPubkey, 10_000_000n); // lock 0.1 KAS
```

## Spec

See `specs/scheme_exact_kaspa.md` for the full x402 Kaspa scheme specification.
