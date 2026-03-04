# x402-kaspa

HTTP 402 payment protocol for Kaspa L1 using SilverScript covenants.

## Architecture

```
┌─────────────┐        ┌──────────────────┐        ┌──────────────┐
│   Client    │──402──>│  Your API Server  │──────>│  Facilitator │
│  (browser/  │<─pay──│  + x402 middleware │<──────│    Server    │
│   SDK)      │        └──────────────────┘        └──────┬───────┘
└──────┬──────┘                                           │
       │                                                  │
       │ open channel (kascov)                            │ co-sign + broadcast
       v                                                  v
┌──────────────────────────────────────────────────────────┐
│              Kaspa Network (TN12 -> Mainnet)             │
└──────────────────────────────────────────────────────────┘
```

### Flow

1. **Client opens a channel** -- deploys an `X402Channel` SilverScript covenant, locking KAS
2. **Client requests a resource** -- gets back `402 Payment Required` with price
3. **Client builds payment** -- creates a partial TX spending the covenant, signs client half
4. **Facilitator verifies** -- checks covenant UTXO exists, validates TX structure
5. **Facilitator settles** -- co-signs (completing 2-of-2), broadcasts to Kaspa blockDAG
6. **Channel persists** -- change returns to covenant with incremented nonce (supports sequential payments)

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@x402/kaspa-types` | `packages/types/` | Shared type definitions, constants, covenant ABI |
| `@x402/kaspa-covenant` | `packages/covenant/` | Core covenant ops: deploy, settle, refund, template patching, kascov CLI wrapper |
| `@x402/kaspa-facilitator` | `packages/facilitator/` | HTTP server: /verify, /settle, /supported, /health |
| `@x402/kaspa` | `packages/client/` | Client SDK: channel management, payment construction, 402 auto-retry |
| `@x402/kaspa-server` | `packages/server/` | Express middleware: paywall routes, 402 responses |
| `kaspa-wasm` | `packages/kaspa-wasm/` | Vendored Kaspa WASM SDK v1.1.0-rc.3 |

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **kascov binary** -- Rust CLI for Kaspa covenant transactions ([patched kascov](https://github.com/aspect-build/kascov))
- **Kaspa Testnet 12** node access (default: `tn12-node.kaspa.com`)
- **Testnet KAS** -- fund your client wallet on TN12

## Quick Start

### 1. Build

```bash
git clone https://github.com/KASPACOM/x402-KAS.git
cd x402-KAS
pnpm install
pnpm build
```

### 2. Start the Facilitator

```bash
FACILITATOR_PRIVATE_KEY=<64-char-hex> \
  node packages/facilitator/dist/server.js
```

The facilitator reads the compiled covenant from `contracts/compiled/x402-channel.json` automatically.

Env vars:
| Variable | Default | Description |
|----------|---------|-------------|
| `FACILITATOR_PRIVATE_KEY` | *required* | 64-char hex private key |
| `KASPA_RPC` | `ws://tn12-node.kaspa.com:17210` | wRPC URL |
| `KASPA_NETWORK` | `kaspa:testnet-12` | CAIP-2 network |
| `PORT` | `4020` | Listen port |
| `MIN_CONFIRMATIONS` | `10` | DAA score confirmations |

### 3. Start Your Paid API

```bash
FACILITATOR_URL=http://localhost:4020 \
FACILITATOR_PUBKEY=<from-facilitator-health-endpoint> \
PAY_TO=<your-kaspa-address> \
  npx tsx examples/paid-api/server.ts
```

### 4. Run the Client

```bash
CLIENT_PRIVATE_KEY=<64-char-hex> \
  npx tsx examples/paid-api/client.ts
```

## Covenant Contract

`contracts/silverscript/x402-channel.sil` -- SilverScript covenant with two entrypoints:

- **`settle(sig clientSig, sig facilitatorSig)`** -- 2-of-2 co-signed payment
- **`refund(sig clientSig)`** -- client reclaims after timeout

Constructor: `(pubkey client, pubkey facilitator, int timeout, int nonce)`

Pre-compiled output: `contracts/compiled/x402-channel.json`

## Technical Notes

### WASM vs kascov

The vendored `kaspa-wasm` SDK has a known issue: `createTransactions()` crashes with `RuntimeError: unreachable` on TN12. However, the low-level APIs work fine:
- `new Transaction(...)` -- works
- `createInputSignature()` -- works
- `ScriptBuilder` -- works
- `RpcClient` -- works

**Deployment** uses the `kascov` Rust CLI (which handles input selection internally). **Settle/refund** uses WASM low-level APIs directly (single covenant input, deterministic outputs).

### Payment Protocol

The x402 Kaspa scheme uses `exact` payments:
- Payment amount specified in **sompi** (1 KAS = 100,000,000 sompi)
- Standard miner fee: 1,000 sompi
- Payment header: `PAYMENT-SIGNATURE` or `X-PAYMENT` (base64 JSON)
- Network IDs follow CAIP-2: `kaspa:mainnet`, `kaspa:testnet-11`, `kaspa:testnet-12`

See `specs/scheme_exact_kaspa.md` for the full protocol specification.

## Status

- Covenant: compiled and deployed on TN12
- All 6 packages: built and type-checked
- Facilitator: HTTP server with env-based config and graceful shutdown
- Client: kascov-based deployment, WASM-based payment signing
- Middleware: Express-compatible paywall
- Example: paid API (server + client)
- **Pending:** End-to-end settle test on TN12 (2-of-2 co-signed spend)

## License

MIT
