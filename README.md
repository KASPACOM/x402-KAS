# x402-kaspa

HTTP 402 payment protocol for Kaspa L1 using SilverScript covenants.

> **Status:** All core flows tested and passing on Kaspa Testnet 12 (TN12). Pure WASM -- no external binary dependencies.
>
> **Explorer:** [tn12.kaspa.stream](https://tn12.kaspa.stream) — verify all TXs on-chain

## What Is This?

x402-kaspa lets any HTTP API accept Kaspa payments per-request. When someone calls a paid endpoint, they get a standard `402 Payment Required` response. Their app automatically pays and retries. Settlement happens on-chain via a 2-of-2 covenant smart contract.

**Use cases:** paid APIs, AI agent micropayments, metered access, pay-per-call services, content paywalls.

---

## Who Is Who? (The 3 Roles)

### API Developer (sells access)

You have an API and want to charge per request. You install the `@x402/kaspa-server` middleware and set a price. That's it.

- Installs: `@x402/kaspa-server` npm package
- Configures: price per endpoint, their Kaspa address to receive payments, facilitator URL
- Gets: KAS deposited to their address for every paid request

### App Developer / Consumer (buys access)

You want to call a paid API. You install the `@x402/kaspa` client SDK. The SDK handles channel opening, payment signing, and retries automatically.

- Installs: `@x402/kaspa` npm package
- Configures: their private key, Kaspa RPC URL
- Funds: their Kaspa wallet with KAS (the SDK deploys a channel on first use)

### Facilitator (KaspaCom -- the payment rail)

The facilitator is the service that co-signs every settlement transaction. It validates that the covenant exists, the amounts are correct, then completes the 2-of-2 signature and broadcasts to the Kaspa network.

- Runs: `@x402/kaspa-facilitator` server (hosted by KaspaCom)
- Earns: accumulated fees swept periodically to a cold wallet
- Provides: the trust layer -- neither client nor server can cheat
- **Locked:** The facilitator pubkey is hardcoded in the covenant bytecode. Only KaspaCom can operate as facilitator.

```
APP (consumer)                    API SERVER (seller)                FACILITATOR (KaspaCom)
     |                                  |                                  |
     |--- GET /weather ---------------->|                                  |
     |<-- 402: pay 0.01 KAS -----------|                                  |
     |                                  |                                  |
     | [SDK: open channel if needed]    |                                  |
     | [SDK: sign partial settle TX]    |                                  |
     |                                  |                                  |
     |--- GET /weather + payment ------>|                                  |
     |                                  |--- POST /settle + payment ------>|
     |                                  |                                  | verify covenant UTXO
     |                                  |                                  | co-sign TX
     |                                  |                                  | broadcast to Kaspa
     |                                  |<-- { txid, success } ------------|
     |<-- 200: weather data ------------|                                  |
```

---

## How Pricing Works

### API Developer Sets The Price

In your API server, you set the price per endpoint:

```typescript
// examples/paid-api/server.ts
const PRICE_SOMPI = "1000000"; // 0.01 KAS per request

// In your route handler:
const paymentRequired = buildPaymentRequired(url, {
  amount: PRICE_SOMPI,         // <-- you set this
  payTo: "kaspa:qz...",        // <-- your wallet address
  network: "kaspa:testnet-12",
  facilitatorUrl: "http://facilitator.kaspacom.com:4020",
  facilitatorPubkey: "abc123...",
});
```

Pricing reference (1 KAS = 100,000,000 sompi):

| Price | Sompi | Use Case |
|-------|-------|----------|
| 0.001 KAS | 100,000 | Cheap API call |
| 0.01 KAS | 1,000,000 | Standard API call |
| 0.1 KAS | 10,000,000 | Premium data |
| 1 KAS | 100,000,000 | Heavy compute |

### Payment & Fee Model

The facilitator receives the **full payment** in the on-chain settle TX, then **forwards the full amount to the merchant** as a separate standard wallet TX. Fees accumulate naturally at the facilitator address (miner fee change dust) and are **swept separately** to a cold wallet.

**Two separate flows:**

**1. Payment flow (per-settlement):**
| Step | Recipient | Amount | Description |
|------|-----------|--------|-------------|
| Settle TX (covenant) | Facilitator | payment | Full payment from covenant |
| Settle TX (covenant) | Covenant | remaining | Change back with nonce+1 |
| Forward TX (wallet) | Merchant | payment | Facilitator forwards to merchant |

**2. Fee sweep (periodic, separate):**
| Step | Recipient | Amount | Description |
|------|-----------|--------|-------------|
| Sweep TX (wallet) | Cold Wallet | balance | Accumulated fees → cold wallet |

Sweep is triggered via `POST /sweep` on the facilitator server, or programmatically via `facilitator.sweepFees()`.

**Why this model?** Kaspa's KIP-9 storage mass formula penalizes small outputs relative to inputs. Splitting a covenant output into 3+ destinations (merchant + fee + change) exceeds the storage mass limit for typical payment amounts. The 2-output model (facilitator + change) works reliably. Fees are swept when the accumulated balance is large enough to bypass KIP-9.

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@x402/kaspa-types` | `packages/types/` | Shared types and constants |
| `@x402/kaspa-covenant` | `packages/covenant/` | Core covenant: deploy, settle, refund |
| `@x402/kaspa-facilitator` | `packages/facilitator/` | Facilitator HTTP server |
| `@x402/kaspa` | `packages/client/` | Client SDK: channels, payments, 402 auto-retry |
| `@x402/kaspa-server` | `packages/server/` | API server middleware (Express, etc.) |
| `kaspa-wasm` | `packages/kaspa-wasm/` | Kaspa WASM SDK (TN12 build) |

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **Kaspa Testnet 12** node access (default: `tn12-node.kaspa.com`)

No Rust, no external binaries. Everything is pure JavaScript/WASM.

---

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
FACILITATOR_FEE=100000 \
  node packages/facilitator/dist/server.js
```

| Variable | Default | Description |
|----------|---------|-------------|
| `FACILITATOR_PRIVATE_KEY` | *required* | 64-char hex private key |
| `FACILITATOR_FEE` | `0` | Fee per settlement in sompi |
| `FACILITATOR_FEE_ADDRESS` | signing address | Cold wallet for fee accumulation |
| `KASPA_RPC` | `ws://tn12-node.kaspa.com:17210` | wRPC URL |
| `KASPA_NETWORK` | `kaspa:testnet-12` | CAIP-2 network |
| `PORT` | `4020` | Listen port |

### 3. Start Your Paid API

```bash
FACILITATOR_URL=http://localhost:4020 \
FACILITATOR_PUBKEY=<from-health-endpoint> \
PAY_TO=<your-kaspa-address> \
PRICE_SOMPI=1000000 \
  npx tsx examples/paid-api/server.ts
```

### 4. Run the Client

```bash
CLIENT_PRIVATE_KEY=<64-char-hex> \
  npx tsx examples/paid-api/client.ts
```

---

## Tutorial: End-to-End Payment on Testnet

### Step 1: Install & Build

```bash
git clone https://github.com/KASPACOM/x402-KAS.git
cd x402-KAS
pnpm install
pnpm build
```

### Step 2: Generate Keys

```bash
# Facilitator key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Client key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3: Fund the Client Wallet

Get the client's Kaspa address:

```bash
node --input-type=module -e "
import { PrivateKey } from './packages/kaspa-wasm/kaspa.js';
const pk = new PrivateKey('<your-client-key>');
console.log('Address:', pk.toAddress('testnet-12').toString());
"
```

Fund it with at least 10 KAS on TN12 (faucet or another wallet).

### Step 4: Start the Facilitator

```bash
FACILITATOR_PRIVATE_KEY=<your-facilitator-key> \
  node packages/facilitator/dist/server.js
```

Output:
```
[x402-facilitator] Listening on :4020
[x402-facilitator] Network: kaspa:testnet-12
[x402-facilitator] Pubkey:  <hex>
[x402-facilitator] Address: kaspatest:qz...
[x402-facilitator] Fee:     0 sompi
```

### Step 5: Start the Paid API

```bash
FACILITATOR_URL=http://localhost:4020 \
FACILITATOR_PUBKEY=<pubkey-from-step-4> \
PAY_TO=<any-kaspa-address> \
  npx tsx examples/paid-api/server.ts
```

### Step 6: Make a Payment

```bash
CLIENT_PRIVATE_KEY=<your-client-key> \
  npx tsx examples/paid-api/client.ts
```

The client will:
1. Request `/weather` -- gets `402 Payment Required`
2. Deploy a covenant channel (~5s, first time only)
3. Sign a payment and retry
4. Print the weather data and TX ID

### Step 7: Verify on Explorer

```
https://tn12.kaspa.stream/transactions/<your-txid>
```

---

## Running Tests

E2E tests run on TN12 and require a funded wallet at `/root/.x402-testnet-key.json`:

```bash
npx tsx test/e2e-deploy.ts            # Deploy a covenant
npx tsx test/e2e-settle.ts            # Deploy + settle (with change)
npx tsx test/e2e-settle-nochange.ts   # Settle full drain
npx tsx test/e2e-chained-settle.ts    # Chained settle (nonce 0->1->2)
npx tsx test/e2e-full-flow.ts         # Full payment flow with facilitator fee model
```

## Test Results (TN12)

| Test | Status | On-Chain Proof |
|------|--------|----------------|
| Deploy covenant (WASM) | Pass | — |
| Settle with change (nonce 0→1) | Pass | — |
| Settle no change (full drain) | Pass | — |
| Chained settle (nonce 0→1→2) | Pass | — |
| Full E2E (deploy + settle + verify) | Pass | [Deploy TX](https://tn12.kaspa.stream/transactions/5201b38ed218ca4cf392a71ce446d75fd667b954e2efdebec1acf83e48892e2a) · [Settle TX](https://tn12.kaspa.stream/transactions/3e40cd1ce8affc1bf3a7d9a01227153a729249435c7beab3435c840865afae53) |
| All 6 packages build | Pass | — |

---

## Covenant Contract

**Production contract:** `contracts/silverscript/x402-channel-v4-locked.sil`

```
Constructor: (pubkey client, int timeout, int nonce)
Entrypoint:  settle(sig clientSig, sig facilitatorSig)
```

Single-entrypoint (190 bytes). The facilitator pubkey is **hardcoded in the bytecode** (not a constructor parameter). The covenant validates:
- Both client and facilitator signed (2-of-2 Schnorr)
- Payment amount > 0
- Payment + miner fee <= input value
- If change exists: output goes to same contract with nonce + 1

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Miner fee | 5,000 sompi | Hardcoded in covenant |
| 1 KAS | 100,000,000 sompi | Conversion rate |

---

## WASM

Self-compiled from `tn12` branch of [kaspanet/rusty-kaspa](https://github.com/kaspanet/rusty-kaspa).

To rebuild from source:

```bash
git clone --depth=1 --branch tn12 https://github.com/kaspanet/rusty-kaspa.git
cd rusty-kaspa/wasm
export RUSTFLAGS=-Ctarget-cpu=mvp
wasm-pack build --weak-refs --target web --out-name kaspa --out-dir web/kaspa --features wasm32-sdk
```

## License

MIT
