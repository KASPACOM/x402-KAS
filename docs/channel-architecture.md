# x402-KAS Channel Architecture

## Overview

An x402 payment channel is a **prepaid covenant UTXO** on Kaspa that enables repeated micropayments without deploying a new contract each time. The KaspaCom facilitator acts as a payment processor — like Stripe — sitting between clients (consumers) and servers (API merchants).

```
┌──────────┐         ┌──────────────┐         ┌──────────────┐
│  Client   │ ──402── │  Server A    │         │  Server B    │
│ (consumer)│ ◄─────  │  (weather)   │         │  (AI API)    │
│           │         │  payTo: 0xA  │         │  payTo: 0xB  │
└─────┬─────┘         └──────────────┘         └──────────────┘
      │                       ▲                        ▲
      │ settle (co-sign)      │ forward - fee          │ forward - fee
      ▼                       │                        │
┌─────────────┐               │                        │
│ Facilitator │───────────────┴────────────────────────┘
│ (KaspaCom)  │
│ pubkey: K   │
└─────────────┘
```

## One Channel, Many Merchants

**A single channel works for all servers that use the same facilitator.**

The channel is parameterized by `(clientPubkey, facilitatorPubkey, timeout, nonce)`. The merchant/server address (`payTo`) is NOT part of the channel — it's specified per-payment in the server's `PaymentRequirements`.

This means:
- Client opens **one channel** with KaspaCom facilitator (locks e.g. 10 KAS)
- Client pays **any server** that uses the KaspaCom facilitator through that same channel
- Each payment increments the nonce, reducing the channel balance
- The facilitator forwards `(payment - fee)` to whichever merchant the server specified

### Example Flow: One Client, Two Servers

```
1. CLIENT opens channel (one-time):
   deploy covenant(clientPubkey=C, facilitatorPubkey=K, timeout=24h, nonce=0)
   → locks 10 KAS at covenant address

2. CLIENT calls Server A (weather API, price: 0.5 KAS):
   GET https://weather-api.example.com/forecast
   ← 402 Payment Required:
     { payTo: "kaspa:qz_weather_merchant...", amount: "50000000",
       extra: { facilitatorPubkey: K, facilitatorUrl: "https://x402-dev.kaspa.com" } }

3. CLIENT builds payment from channel (nonce=0):
   → partial-signs settle TX: 0.5 KAS → facilitator, 9.495 KAS → covenant(nonce=1)
   → sends signature + outpoint to server in X-PAYMENT header

4. SERVER A forwards to facilitator → facilitator co-signs + broadcasts
   → facilitator forwards (0.5 KAS - fee) to weather merchant
   → channel: nonce=1, balance=9.495 KAS

5. CLIENT calls Server B (AI API, price: 1 KAS):
   GET https://ai-api.example.com/generate
   ← 402 Payment Required:
     { payTo: "kaspa:qz_ai_merchant...", amount: "100000000",
       extra: { facilitatorPubkey: K, facilitatorUrl: "https://x402-dev.kaspa.com" } }

6. CLIENT builds payment from SAME channel (nonce=1):
   → partial-signs settle TX: 1 KAS → facilitator, 8.49 KAS → covenant(nonce=2)
   → sends signature to server

7. SERVER B forwards to facilitator → settles → forwards (1 KAS - fee) to AI merchant
   → channel: nonce=2, balance=8.49 KAS
```

The client never opens a second channel. The facilitator handles routing payments to the correct merchant based on each server's `payTo` address.

## Why Not One Channel Per Server?

| | One Channel (current) | Channel Per Server |
|--|----------------------|-------------------|
| On-chain deploy TXs | 1 | N (one per server) |
| KAS locked up | Once | Split across N channels |
| Client complexity | Simple — one balance | Track N balances, N refunds |
| Refund management | One timeout | N timeouts |
| UX | "Top up once, pay anywhere" | "Deposit per service" |

One channel is strictly better for the client. It's the same model as: one credit card → many merchants, or one Stripe customer → many vendors.

## Channel Lifecycle

```
OPEN (deploy covenant)
  │
  ├── PAYMENT #1 → settle(nonce=0), change → nonce=1
  ├── PAYMENT #2 → settle(nonce=1), change → nonce=2
  ├── ...
  ├── PAYMENT #N → settle(nonce=N-1), change → nonce=N
  │
  ├── TOP-UP: deploy new channel when balance runs low
  │           (old channel still usable until empty or timed out)
  │
  └── REFUND: after timeout, client reclaims remaining balance
              (single-sig, no facilitator needed)
```

### Nonce Mechanics

Each payment creates a new covenant UTXO at `nonce+1` with a different P2SH address (because the nonce is baked into the covenant script). This prevents replay attacks — a settle TX for nonce=0 can't be replayed against nonce=1 because the addresses differ.

```
nonce=0: kaspa:prh3x...  (initial deploy)
  → settle: 0.5 KAS to facilitator
nonce=1: kaspa:pqw7k...  (change output from settle #1)
  → settle: 1 KAS to facilitator
nonce=2: kaspa:pm4jr...  (change output from settle #2)
  → ...
```

## Server Integration (API Developer)

A server (API merchant) does NOT manage channels. It only:

1. **Configures a paywall** with its own `payTo` address and the KaspaCom facilitator URL
2. **Returns 402** when a client hits a gated route (middleware handles this)
3. **Receives forwarded payment** from the facilitator (standard wallet TX, minus fee)

```typescript
import { paywall } from "@kaspacom/x402-server";

app.use(paywall({
  routes: [{
    path: "/api/premium",
    config: {
      amount: "100000000",                    // 1 KAS per call
      payTo: "kaspa:qz_my_merchant_address",  // YOUR address
      network: "kaspa:testnet-12",
      facilitatorUrl: "https://x402-dev.kaspa.com",
      facilitatorPubkey: "25d0720065a2eebebb85fbfb6d8dab952fa7c3cafdb0f6166953b0dfc9bd8dc3",
    }
  }]
}));
```

The server never sees the channel, never co-signs anything, and never touches the covenant. It just gets paid.

## Facilitator Fee Model

```
Settle TX (on-chain, covenant):
  input:  covenant UTXO (nonce=N)
  output[0]: full payment → facilitator signing address
  output[1]: change → covenant (nonce=N+1)

Forward TX (off-chain from covenant, standard wallet TX):
  facilitator → (payment - facilitatorFee) → merchant payTo address

Sweep TX (periodic, standard wallet TX):
  facilitator signing address → accumulated fees → cold wallet
```

- **`FACILITATOR_FEE`** (env var, sompi): deducted per-settlement before forwarding to merchant
- **`FACILITATOR_FEE_ADDRESS`** (env var): cold wallet for fee sweeps
- **`POST /sweep`**: sends accumulated fee balance to cold wallet

## Multi-Facilitator (Future)

Currently, the SDK enforces `KASPACOM_FACILITATOR_PUBKEY` as the only allowed facilitator. In a future multi-facilitator model:

- Each facilitator would have its own keypair and signing address
- Clients would open separate channels per facilitator (different pubkey = different covenant)
- Servers would specify which facilitator they use in their `PaymentRequirements`
- The client SDK would auto-manage one channel per facilitator

This is analogous to supporting multiple payment processors (Stripe + PayPal), where each processor requires its own account/channel but merchants can choose which to accept.

## Key Invariants

1. **Channel identity** = `hash(clientPubkey, facilitatorPubkey, timeout, nonce)` → deterministic P2SH address
2. **Merchant is NOT part of channel** — specified per-payment via `payTo` in `PaymentRequirements`
3. **Settle TX always sends full payment to facilitator** — fee deduction + merchant forwarding is a separate wallet operation
4. **Nonce only goes forward** — each settle increments nonce, preventing replay
5. **Refund is client-only** — after timeout, client can reclaim without facilitator cooperation
6. **One facilitator key = one channel per client** — regardless of how many servers
