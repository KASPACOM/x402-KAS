# Kaspa WASM vs Rust Strategy — x402 & Web Wallet

**Date:** 2026-03-04
**Context:** Building x402 payment channels + covenant support in KaspaCom web wallet
**TL;DR:** WASM is broken for TN12 transactions. Use Rust (kascov) server-side, wait for WASM fixes for browser.

---

## The Problem

The Kaspa WASM SDK (`kaspa-wasm`) cannot build or sign transactions on **Testnet 12** (the covenant fork). Both v1.0.0 and v1.1.0-rc.3 crash with `RuntimeError: unreachable` when calling `createTransactions()`.

**What works in WASM:**
- RPC connection (connect, getUtxosByAddresses, getBlockDagInfo)
- Key management (PrivateKey, PublicKey, address derivation)
- P2SH address derivation (payToScriptHashScript, addressFromScriptPublicKey)
- Script building (ScriptBuilder, createInputSignature — if UTXO data is attached)

**What crashes in WASM:**
- `createTransactions()` — panics in Rust internals
- `UtxoProcessor` / `UtxoContext` — panics on `trackAddresses()`
- Manual `Transaction` constructor — "missing UTXO entry" (unclear how to attach in JS)

## What the Kaspa Dev Said

> "Most issues would be solved by using a self-compiled WASM on the `tn-12` branch. However, I personally recommend considering WASM 'early' — it's not well tested yet. Rust lib is more stable."
>
> "Prefer Rust native for now, or accept being on the edge."
>
> The npm `kaspa-wasm` package should NOT be used currently. Luke has started a conversation to bring it up to date. Follow: https://github.com/kaspanet/rusty-kaspa/tree/tn12/wasm

## Our Working Solution: kascov CLI as Backend

We patched the [kascov CLI](https://github.com/HocusLocusTee/kascov) (Rust) and use it as a backend for transaction operations. This works reliably.

**Architecture:**

```
┌─────────────────────────────────────────────────────────┐
│                    Web Wallet (Browser)                   │
│                                                           │
│  kaspa-wasm (v1.1.0-rc.3)     kascov REST API            │
│  ├── RPC queries        ───►  ├── deploy covenant         │
│  ├── Key management            ├── spend-contract-signed  │
│  ├── P2SH address derivation   ├── sign + broadcast       │
│  └── Balance checks            └── fee estimation         │
│                                      │                    │
│  Uses WASM for READ ops       Uses Rust for WRITE ops     │
└─────────────────────────────────────────────────────────┘
```

### How kascov Wrapper Works

Our `kascov-cli.ts` module:
1. Writes the compiled contract JSON + args to a temp directory
2. Creates a wallet file with the user's private key
3. Pipes commands to the kascov binary via stdin
4. Parses the output (txid, address, fee)
5. Cleans up temp files

```typescript
import { kascovDeploy, kascovSpendSigned } from "@x402/kaspa-covenant";

// Deploy a covenant
const result = await kascovDeploy(compiledContract, 500_000_000n, privateKeyHex);
// Returns: { txid, contractAddress, outpoint, feeSompi }

// Spend a covenant (settle, refund, etc.)
const spend = await kascovSpendSigned(
  compiledContract, outpoint, inputAmount,
  "settle", functionArgs, outputs, privateKeyHex
);
// Returns: { txid, feeSompi }
```

---

## Options for the Web Wallet

### Option A: Rust Backend Service (Recommended Now)

Run kascov (or a custom Rust service) as a backend API. The wallet frontend calls it for covenant operations.

**Pros:**
- Works today, battle-tested on TN12
- No WASM dependency for transactions
- Can share one kascov instance across users

**Cons:**
- Requires a server component (not fully client-side)
- Private key must be sent to the backend OR use a 2-step signing flow

**Implementation:**
1. Wrap kascov in a simple HTTP API (Express/Fastify)
2. Endpoints: `POST /deploy`, `POST /spend`, `GET /balance`
3. Wallet sends private key + contract params
4. Backend shells out to kascov, returns txid
5. OR: backend builds unsigned TX, returns to client for signing (preferred for security)

### Option B: Self-Compile WASM from tn-12 Branch

Build the WASM module from the `tn-12` branch of rusty-kaspa.

**Pros:**
- Fully client-side (no backend needed)
- Would fix `createTransactions()` for TN12

**Cons:**
- "Early" / not well tested (per Kaspa dev)
- Need to maintain custom WASM build
- May break with future Kaspa updates
- Build process is non-trivial (Rust + wasm-pack)

**How to build:**
```bash
git clone https://github.com/kaspanet/rusty-kaspa.git
cd rusty-kaspa
git checkout tn12
cd wasm
# Follow build instructions in the wasm/ directory
wasm-pack build --target nodejs  # for Node.js
wasm-pack build --target web     # for browser
```

### Option C: Wait for Official WASM Fix (Future)

The Kaspa team (smartgoo + others) is working on improving WASM to support latest features. Track progress:
- PR page: https://github.com/kaspanet/rusty-kaspa/pulls
- TN12 WASM branch: https://github.com/kaspanet/rusty-kaspa/tree/tn12/wasm
- npm update conversation initiated by Luke

**Timeline:** Unknown, but active development.

---

## Recommendation for KaspaCom

**Short term (now):** Use **Option A** — Rust backend via kascov. This is what x402 uses and it's proven.

**Medium term:** Try **Option B** — self-compile WASM from tn-12 branch. If it works, migrate covenant operations to client-side. Keep the Rust backend as fallback.

**Long term:** When official WASM is updated (Option C), switch to the npm package and drop the custom build/backend.

### For the x402 Protocol Specifically

The x402 facilitator already runs server-side (it's a payment processor). So using kascov as backend is natural — no architectural compromise. The client SDK can use WASM for everything except `createTransactions()`, which goes through the facilitator's kascov backend.

---

## Patches We Made to kascov

Our local fork at `/home/coder/projects/kaspa/kascov/` has these fixes:

1. **`spend-contract-signed` locktime param** — added support for passing locktime
2. **Sighash mismatch fix** — placeholder TX and final TX now use the same locktime
3. **Sequence = 0** — fixed from MAX to 0 (Kaspa finalization, opposite of Bitcoin)
4. **Fee estimation for P2SH** — increased `estimated_mass()` base to account for covenant script size in outputs

These patches should be upstreamed to HocusLocusTee/kascov when we get access.

---

## Key Links

| Resource | URL |
|----------|-----|
| x402-KAS repo | https://github.com/KASPACOM/x402-KAS |
| kascov (upstream) | https://github.com/HocusLocusTee/kascov |
| rusty-kaspa tn12 WASM | https://github.com/kaspanet/rusty-kaspa/tree/tn12/wasm |
| SilverScript tutorial | https://github.com/kaspanet/silverscript/blob/master/TUTORIAL.md |
| Covenant dev guide | `/root/.openclaw/workspace/docs/covenant-development-guide.md` |
