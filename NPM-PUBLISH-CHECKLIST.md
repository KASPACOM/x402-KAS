# x402-KAS — NPM Publish Checklist

> Goal: Publish `@x402/kaspa`, `@x402/kaspa-server`, and `@x402/kaspa-types` to npm.
> The facilitator package stays private (KaspaCom runs it as a hosted service).

## Packages to Publish

| Package | npm Name | Who Uses It |
|---------|----------|-------------|
| `packages/types/` | `@x402/kaspa-types` | Everyone (auto-installed) |
| `packages/covenant/` | `@x402/kaspa-covenant` | Internal dep of @x402/kaspa |
| `packages/client/` | `@x402/kaspa` | App developers (buyers) |
| `packages/server/` | `@x402/kaspa-server` | API developers (sellers) |
| `packages/kaspa-wasm/` | `kaspa-wasm` | Internal dep (WASM runtime) |

## Packages NOT Published (Private)

| Package | Why |
|---------|-----|
| `packages/facilitator/` | KaspaCom-only hosted service |

---

## BLOCKING — Must Do Before Publish

### 1. Convert `workspace:*` to semver versions
All package.json files use `"workspace:*"` which only works in monorepo dev.
Replace with real versions before `npm publish`.

**Files to update:**
- `packages/types/package.json` — no deps (ok)
- `packages/covenant/package.json` — `@x402/kaspa-types` → `^0.1.0`, `kaspa-wasm` → `^1.1.0`
- `packages/client/package.json` — `@x402/kaspa-types` → `^0.1.0`, `@x402/kaspa-covenant` → `^0.1.0`, `kaspa-wasm` → `^1.1.0`
- `packages/server/package.json` — `@x402/kaspa-types` → `^0.1.0`
- `packages/facilitator/package.json` — not published, but fix anyway

### 2. Add `"files"` field to each package.json
Without this, source code and build artifacts get published.

```json
"files": ["dist", "README.md", "LICENSE"]
```

**Add to:** types, covenant, client, server, kaspa-wasm (already has it)

### 3. Publish kaspa-wasm to npm
The WASM package is self-compiled from rusty-kaspa TN12 branch.
Must be published as `kaspa-wasm` (or `@x402/kaspa-wasm`) so other packages can depend on it.

**Size warning:** ~12MB WASM binary. This is normal for Kaspa WASM builds.

### 4. Decide kaspa-wasm package name
Currently vendored at `packages/kaspa-wasm/`. Choose one:
- `kaspa-wasm` — generic (may conflict with upstream)
- `@x402/kaspa-wasm` — scoped under x402 (safer)
- `@kaspacom/kaspa-wasm` — scoped under KaspaCom org

Update all imports across packages to match.

### 5. Publish order (dependencies first)
```
1. kaspa-wasm (or @x402/kaspa-wasm)
2. @x402/kaspa-types
3. @x402/kaspa-covenant
4. @x402/kaspa
5. @x402/kaspa-server
```

---

## REQUIRED — Do Before Publish

### 6. Create LICENSE file
MIT license. Copy to root + each package directory.

### 7. Create README.md for each public package

**@x402/kaspa-types README:**
- What types are exported
- Link to main repo

**@x402/kaspa README (client SDK):**
- `npm install @x402/kaspa`
- Quick start: `new X402Client(config)` → `client.fetch(url)`
- Configuration options
- How channels work
- Link to main repo

**@x402/kaspa-server README (middleware):**
- `npm install @x402/kaspa-server`
- Quick start: `app.use(paywall({ ... }))`
- Configuration options (price, payTo, facilitatorUrl)
- Express example
- Link to main repo

**@x402/kaspa-covenant README:**
- Internal package used by @x402/kaspa
- Not meant for direct use
- API reference for advanced users

### 8. Add repository field to each package.json
```json
"repository": {
  "type": "git",
  "url": "https://github.com/KASPACOM/x402-KAS.git",
  "directory": "packages/client"
}
```

### 9. Add author and keywords
```json
"author": "KaspaCom",
"keywords": ["kaspa", "x402", "micropayments", "http-402", "payment-channel"]
```

---

## NICE TO HAVE — Post-Publish

### 10. Set up npm org
Create `@x402` npm org (or use `@kaspacom`) and add team members.

### 11. CI/CD for publishing
GitHub Action that publishes on version tag push.

### 12. Host facilitator service
- Domain: `https://x402.kaspacom.com` (or similar)
- Deploy facilitator server with production key
- Health endpoint publicly accessible
- HTTPS with proper certs

### 13. Mainnet support
- Generate mainnet facilitator keypair (see memory/x402-kaspa-details.md "How to Rotate")
- Recompile v4-locked contract with mainnet pubkey
- Update `KASPACOM_FACILITATOR_PUBKEY` constant
- Add mainnet RPC defaults
- Test full flow on mainnet

### 14. Landing page / docs site
- How it works (3-role diagram)
- Getting started guides for API devs and app devs
- Pricing / fee structure
- API reference

---

## Key Files Reference

| What | Where |
|------|-------|
| Facilitator private key | `/root/.x402-facilitator-key.json` (chmod 600) |
| Facilitator pubkey constant | `packages/types/src/index.ts` → `KASPACOM_FACILITATOR_PUBKEY` |
| Locked covenant source | `contracts/silverscript/x402-channel-v4-locked.sil` |
| Locked covenant compiled | `contracts/compiled/x402-channel-v4-locked.json` |
| Locked covenant ctor args | `contracts/silverscript/x402-channel-v4-locked-ctor.json` |
| Cold wallet (fee dest) | env var `FACILITATOR_FEE_ADDRESS` (not hardcoded) |
| Key rotation procedure | `/root/.claude/projects/-root/memory/x402-kaspa-details.md` |

## Fee Flow (Production)

```
Payment flow (per-settlement):
  Covenant → settle TX → facilitator → forward TX → merchant (full amount)

Fee sweep (periodic, separate):
  Facilitator balance → POST /sweep → cold wallet
                        kaspatest:qqjaqusqvk3wa04mshalkmvd4w2jlf7ret7mpaskd9fmph7fhkxuxxh8gy49h
```

To change cold wallet: set `FACILITATOR_FEE_ADDRESS` env var, restart facilitator.
