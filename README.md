# x402-kaspa

HTTP 402 payment protocol for Kaspa L1 using SilverScript covenants.

> **Status:** All core flows tested and passing on Kaspa Testnet 12 (TN12) -- deploy, settle, chained settle (nonce 0->1->2).

## Architecture

```
+--------------+        +-------------------+        +---------------+
|   Client     |--402-->|  Your API Server  |------->|  Facilitator  |
|  (browser/   |<-pay---|  + x402 middleware |<-------|    Server     |
|   SDK)       |        +-------------------+        +-------+-------+
+------+-------+                                             |
       |                                                     |
       | open channel (kascov)                               | co-sign + broadcast
       v                                                     v
+-------------------------------------------------------------+
|              Kaspa Network (TN12 -> Mainnet)                 |
+-------------------------------------------------------------+
```

### How It Works

1. **Client opens a channel** -- deploys an `X402Channel` SilverScript covenant, locking KAS in a 2-of-2 escrow
2. **Client requests a resource** -- gets back `402 Payment Required` with price and facilitator info
3. **Client builds payment** -- creates a partial TX spending the covenant, signs client half
4. **Facilitator verifies** -- checks covenant UTXO exists, validates TX structure
5. **Facilitator settles** -- co-signs (completing 2-of-2 Schnorr), broadcasts to Kaspa blockDAG
6. **Channel persists** -- change returns to covenant with incremented nonce (supports sequential payments)

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@x402/kaspa-types` | `packages/types/` | Shared type definitions, constants, covenant ABI |
| `@x402/kaspa-covenant` | `packages/covenant/` | Core covenant ops: deploy, settle, refund, template patching, kascov CLI wrapper |
| `@x402/kaspa-facilitator` | `packages/facilitator/` | HTTP server: `/verify`, `/settle`, `/supported`, `/health` |
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

## Tutorial: End-to-End Payment on Testnet

This walkthrough takes you from zero to a working micropayment in ~10 minutes.

### Step 1: Install & Build

```bash
git clone https://github.com/KASPACOM/x402-KAS.git
cd x402-KAS
pnpm install
pnpm build
```

Make sure the `kascov` binary is available. Set its path if it's not in the default location:

```bash
export KASCOV_BIN=/path/to/kascov
```

### Step 2: Generate Keys

Generate a facilitator key and a client key (any 64-char hex string from 32 random bytes):

```bash
# Facilitator key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Client key (run again for a different key)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3: Fund the Client Wallet

Start the client script once to see its Kaspa address, then fund it with TN12 testnet KAS:

```bash
CLIENT_PRIVATE_KEY=<your-client-key> npx tsx examples/paid-api/client.ts
# It will print: "Client address: kaspatest:qz..."
# Fund this address with at least 10 KAS on TN12
```

You can get testnet KAS from the Kaspa TN12 faucet or another funded wallet.

### Step 4: Start the Facilitator

```bash
FACILITATOR_PRIVATE_KEY=<your-facilitator-key> \
  node packages/facilitator/dist/server.js
```

You'll see output like:

```
[x402-facilitator] Listening on :4020
[x402-facilitator] Network: kaspa:testnet-12
[x402-facilitator] Pubkey:  <facilitator-pubkey-hex>
```

Copy the pubkey -- you'll need it for the API server.

### Step 5: Start the Paid API Server

In a new terminal:

```bash
FACILITATOR_URL=http://localhost:4020 \
FACILITATOR_PUBKEY=<pubkey-from-step-4> \
PAY_TO=<any-kaspa-address-to-receive-payments> \
  npx tsx examples/paid-api/server.ts
```

### Step 6: Make a Payment

In another terminal:

```bash
CLIENT_PRIVATE_KEY=<your-client-key> \
  npx tsx examples/paid-api/client.ts
```

The client will:
1. Request `/weather` and get a `402 Payment Required`
2. Deploy a covenant channel (first time only, takes ~10s)
3. Build a payment and retry the request
4. Print the weather data and a TX ID

### Step 7: Verify on Explorer

Check your transaction on the TN12 block explorer:

```
https://tn12.kaspa.stream/txs/<your-txid>
```

Subsequent payments reuse the same channel -- the covenant nonce increments with each settle.

## Covenant Contract

**Production contract:** `contracts/silverscript/x402-channel-v2.sil` (single-entrypoint, v2)

```
Constructor: (pubkey client, pubkey facilitator, int timeout, int nonce)
Entrypoint:  settle(sig clientSig, sig facilitatorSig) -- 2-of-2 co-signed payment
```

The v2 contract uses a single `settle` entrypoint. This was adopted because the SilverScript compiler has a multi-entrypoint dispatch bug: in P2SH execution, state fields are pushed on top of the selector, so dispatch checks the wrong stack value. The single-entrypoint design (198 bytes) eliminates dispatch entirely and is more compact than v1 (259 bytes).

Pre-compiled output: `contracts/compiled/x402-channel.json`

The v1 multi-entrypoint contract (`x402-channel.sil`) with separate settle/refund is preserved for reference but is **not used in production**.

### Settlement Details

- **Miner fee:** 5,000 sompi (hardcoded in covenant)
- **Nonce tracking:** Each settle increments the nonce in the change output's covenant state
- **Chained payments:** Supported -- settle nonce 0->1, then 1->2, etc., on the same channel
- **Change output:** If `remainder > minerFee`, change goes to a new covenant instance with `nonce + 1`

## Technical Notes

### WASM vs kascov

The vendored `kaspa-wasm` SDK has a known issue: `createTransactions()` crashes with `RuntimeError: unreachable` on TN12. However, the low-level APIs work fine:
- `new Transaction(...)` -- works
- `createInputSignature()` -- works
- `ScriptBuilder` -- works
- `RpcClient` -- works

**Deployment** uses the `kascov` Rust CLI (handles input selection internally). **Settlement** uses WASM low-level APIs directly (single covenant input, deterministic outputs).

See `docs/wasm-vs-rust-strategy.md` for the full technical analysis.

### Payment Protocol

The x402 Kaspa scheme uses `exact` payments:
- Payment amount specified in **sompi** (1 KAS = 100,000,000 sompi)
- Standard miner fee: 5,000 sompi
- Payment header: `PAYMENT-SIGNATURE` or `X-PAYMENT` (base64 JSON)
- Network IDs follow CAIP-2: `kaspa:mainnet`, `kaspa:testnet-11`, `kaspa:testnet-12`

See `specs/scheme_exact_kaspa.md` for the full protocol specification.

## Test Results (TN12)

| Test | Status |
|------|--------|
| Covenant deployment (kascov) | Pass |
| Settle with change (nonce 0->1) | Pass |
| Chained settle (nonce 0->1->2) | Pass |
| Facilitator server startup | Pass |
| All 6 packages build | Pass |

E2E test scripts are in `test/e2e-*.ts`. Run them with:

```bash
npx tsx test/e2e-deploy.ts        # Test covenant deployment
npx tsx test/e2e-settle.ts        # Test full settle flow
```

## Deployment

A VPS setup script is provided at `deploy/setup.sh`. It installs Node.js, pnpm, Rust, builds kascov, and clones the repo:

```bash
bash deploy/setup.sh
```

## License

MIT
