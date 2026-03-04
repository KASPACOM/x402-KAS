# Scheme: `exact` on Kaspa (`kaspa`)

## Summary

The `exact` scheme on Kaspa uses a **covenant-based payment channel** to enable gasless, double-spend-protected micropayments for HTTP 402 resources.

Unlike account-model chains (EVM, Solana) where clients sign authorizations or partial transactions per-request, Kaspa's UTXO model requires a different approach:

1. **Channel Open:** Client deploys a SilverScript covenant locking KAS into a 2-of-2 escrow (client + facilitator pubkeys)
2. **Per-Payment:** Client builds a settlement TX from the covenant, signs their half, sends it as the payment payload
3. **Settlement:** Facilitator verifies the TX structure, co-signs, and broadcasts
4. **Refund:** Client can unilaterally reclaim funds after a timeout if no settlement occurs

This model provides:
- **Double-spend protection** — funds are locked in the covenant, can't be spent without facilitator co-signature
- **Multi-payment channels** — one channel deployment supports multiple sequential payments via state transitions
- **Native replay protection** — UTXO consumption prevents replay (plus nonce tracking in covenant state)
- **No approval attack surface** — no ERC-20 `approve()` equivalent; funds are covenant-locked

---

## Network Identifier

Following CAIP-2 conventions:

| Network | Identifier |
|---------|------------|
| Kaspa Mainnet | `kaspa:mainnet` |
| Kaspa Testnet 11 | `kaspa:testnet-11` |
| Kaspa Testnet 12 (Covenants) | `kaspa:testnet-12` |

**Note:** SilverScript covenants are currently available only on Testnet 12. Mainnet activation depends on the Kaspa consensus upgrade roadmap.

---

## Protocol Flow

### Phase 0: Channel Setup (One-Time)

Before making x402 payments, the client must open a payment channel:

1. **Client** obtains the **Facilitator's** public key from `GET /supported`
2. **Client** deploys the `X402Channel` covenant with constructor args:
   - `client`: Client's x-only public key (32 bytes)
   - `facilitator`: Facilitator's x-only public key (32 bytes)
   - `timeout`: Absolute timestamp for refund eligibility (e.g., now + 24h)
   - `nonce`: `0` (initial)
3. **Client** locks KAS into the covenant (deployment TX)
4. The covenant address and UTXO outpoint are the "channel"

### Phase 1: Payment Request

1. **Client** makes a request to a **Resource Server**
2. **Resource Server** responds with `402 Payment Required`:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/data",
    "description": "Premium API access",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "kaspa:testnet-12",
      "amount": "100000000",
      "asset": "KAS",
      "payTo": "kaspa:qz...",
      "maxTimeoutSeconds": 60,
      "extra": {
        "facilitatorUrl": "https://facilitator.example.com",
        "facilitatorPubkey": "ab12...ef90"
      }
    }
  ]
}
```

### Phase 2: Payment Construction

1. **Client** finds their open channel covenant UTXO for this facilitator
2. **Client** builds a Kaspa transaction that spends the covenant via `settle`:
   - **Input[0]:** The covenant UTXO (channel)
   - **Output[0]:** Payment to `payTo` address for `amount` sompi
   - **Output[1]:** Change back to same covenant with `nonce + 1` (if funds remain)
3. **Client** signs their half of the settlement (Schnorr signature over sighash)
4. **Client** serializes the partially-signed TX as base64

### Phase 3: Payment Submission

**Client** re-sends the request with the `PAYMENT-SIGNATURE` header containing:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/data",
    "description": "Premium API access",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "kaspa:testnet-12",
    "amount": "100000000",
    "asset": "KAS",
    "payTo": "kaspa:qz...",
    "maxTimeoutSeconds": 60,
    "extra": {
      "facilitatorUrl": "https://facilitator.example.com",
      "facilitatorPubkey": "ab12...ef90"
    }
  },
  "payload": {
    "transaction": "<base64 partially-signed Kaspa TX>",
    "channelOutpoint": {
      "txid": "abcd1234...",
      "vout": 0
    },
    "clientPubkey": "1234...abcd",
    "currentNonce": 0
  }
}
```

### Phase 4: Verification

**Resource Server** forwards the payload to **Facilitator** `POST /verify`:

1. Deserialize and decode the partially-signed Kaspa transaction
2. Verify the covenant UTXO exists and is unspent (Kaspa RPC `getUtxosByAddresses`)
3. Verify the UTXO belongs to a valid `X402Channel` covenant with the facilitator's pubkey
4. Verify the transaction structure:
   - Input[0] spends the covenant UTXO
   - Output[0] pays `payTo` for exactly `amount` sompi
   - Output[1] (if present) returns change to same covenant with nonce+1
   - No unexpected additional outputs
5. Verify the client's Schnorr signature is valid for Input[0]
6. Verify the nonce matches the covenant's current state
7. Verify the channel timeout has not passed (funds could be refunded)
8. Return `{isValid: true, payer: "<client address>"}`

### Phase 5: Settlement

**Resource Server** serves the content, then forwards to **Facilitator** `POST /settle`:

1. Facilitator adds its co-signature to the transaction (completing the 2-of-2)
2. Facilitator builds the full sigscript: `<clientSig> <facilitatorSig> <selector:0>`
3. Facilitator wraps with `encodePayToScriptHashSignatureScript` using the covenant bytecode
4. Facilitator broadcasts via Kaspa RPC `submitTransaction`
5. Facilitator waits for confirmation (blue score increase)
6. Returns settlement response:

```json
{
  "success": true,
  "transaction": "abcdef123456...",
  "network": "kaspa:testnet-12",
  "payer": "kaspa:qr...",
  "blueScore": 12345678
}
```

---

## `PaymentRequirements` for `exact` on Kaspa

| Field | Type | Description |
|-------|------|-------------|
| `scheme` | string | `"exact"` |
| `network` | string | CAIP-2 Kaspa network ID |
| `amount` | string | Amount in sompi (1 KAS = 100,000,000 sompi) |
| `asset` | string | `"KAS"` for native KAS |
| `payTo` | string | Kaspa address (bech32 format: `kaspa:qz...`) |
| `maxTimeoutSeconds` | number | Max time between verify and settle |
| `extra.facilitatorUrl` | string | Facilitator's base URL |
| `extra.facilitatorPubkey` | string | Facilitator's x-only public key (hex) |

---

## PaymentPayload `payload` Field

| Field | Type | Description |
|-------|------|-------------|
| `transaction` | string | Base64-encoded partially-signed Kaspa TX |
| `channelOutpoint` | object | `{txid, vout}` of the covenant UTXO being spent |
| `clientPubkey` | string | Client's x-only public key (hex, 64 chars) |
| `currentNonce` | number | Current nonce value in the covenant state |

---

## `SettlementResponse`

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether settlement succeeded |
| `transaction` | string | Transaction ID on Kaspa |
| `network` | string | CAIP-2 network ID |
| `payer` | string | Client's Kaspa address |
| `blueScore` | number | Blue score at confirmation |

---

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme Kaspa payment MUST enforce ALL of the following:

### 1. Covenant Validity
- The input UTXO MUST be a P2SH output matching a known `X402Channel` covenant
- The covenant MUST contain the facilitator's own public key as the `facilitator` param
- The covenant `timeout` MUST be in the future (channel not expired)

### 2. Transaction Structure
- The transaction MUST have exactly 1 input (the covenant UTXO)
- Output[0] MUST pay to the `payTo` address from PaymentRequirements
- Output[0] value MUST equal the required `amount` exactly
- If Output[1] exists, it MUST be a P2SH to the same covenant script with nonce+1
- Output[1] value MUST equal `inputValue - amount - fee`
- No additional outputs beyond [0] and optionally [1]

### 3. Signature Validity
- The client's Schnorr signature MUST be valid for the transaction's sighash
- The signature MUST correspond to the `client` pubkey embedded in the covenant

### 4. State Consistency
- The `currentNonce` in the payload MUST match the nonce in the covenant's constructor args
- The UTXO MUST exist and be unspent at verification time

### 5. Timing
- The covenant `timeout` MUST be at least `maxTimeoutSeconds` in the future
- This ensures the facilitator has time to settle before the client could refund

---

## Covenant Contract

See `contracts/silverscript/x402-channel.sil` for the full SilverScript source.

### Constructor Parameters

| Param | Type | Description |
|-------|------|-------------|
| `client` | pubkey | Client's x-only public key (32 bytes) |
| `facilitator` | pubkey | Facilitator's x-only public key (32 bytes) |
| `timeout` | int | Absolute timestamp for refund eligibility |
| `nonce` | int | Payment counter (starts at 0, increments each settle) |

### Entrypoints

| Function | Args | Description |
|----------|------|-------------|
| `settle` | `(sig clientSig, sig facilitatorSig)` | 2-of-2 settlement. Pays server, returns change to covenant with nonce+1 |
| `refund` | `(sig clientSig)` | Client-only reclaim after timeout |

---

## Comparison with Other x402 Chains

| Feature | EVM (EIP-3009) | Solana (SPL) | Kaspa (Covenant) |
|---------|---------------|--------------|-------------------|
| Payment model | Signed authorization | Partially-signed TX | 2-of-2 covenant settle |
| Double-spend protection | Contract nonce | None (race risk) | Funds locked in covenant |
| Gas sponsorship | Facilitator pays ETH gas | Facilitator = feePayer | Fee from covenant balance |
| Replay protection | EIP-3009 nonce on-chain | UTXO consumed | UTXO consumed + nonce state |
| Approval risk | ERC-20 approve() | None | None (covenant-locked) |
| Multi-payment | Per-TX each time | Per-TX each time | One channel, many payments |
| Settlement finality | ~2s (L2) | ~0.4s | ~1s (blockDAG) |
| Auth model | Single sig (payer) | Single sig (payer) | 2-of-2 (payer + facilitator) |

---

## Open Questions

1. **KRC-20 Token Support:** KRC-20 uses an inscription/indexer model, not script-level enforcement. The covenant cannot directly enforce KRC-20 transfers. May need a wrapper approach or wait for native token scripting.

2. **Concurrent Payments:** A single covenant UTXO supports only sequential payments. For high-frequency use, clients could open multiple channels or use a queuing system at the facilitator.

3. **Channel Top-Up:** Adding funds to an existing channel requires spending and re-creating the covenant. Could be optimized with a `topUp` entrypoint if SilverScript supports adding inputs.

4. **Facilitator Griefing:** The facilitator could refuse to settle (denial of service). The refund path protects client funds, but the server already served the resource. This is inherent to x402 across all chains.

5. **Confirmation Depth:** What blue score delta should the facilitator wait for? Suggested: 10 confirmations (~10 seconds on Kaspa's 1 BPS).

---

## Appendix: CAIP-2 Registration

Kaspa should register a CAIP-2 namespace. Proposed format:

```
kaspa:<network>
```

Where `<network>` is one of: `mainnet`, `testnet-11`, `testnet-12`, `simnet`, `devnet`.

Example: `kaspa:testnet-12`
