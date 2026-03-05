# @x402/kaspa-covenant

Low-level covenant utilities for the x402 Kaspa payment protocol. Used internally by `@x402/kaspa`.

## Install

```bash
npm install @x402/kaspa-covenant
```

> **Note:** This is an internal package. Most users should use `@x402/kaspa` (client SDK) or `@x402/kaspa-server` (server middleware) instead.

## What's Included

- `patchChannelContract()` — patch covenant bytecode with channel parameters
- `deployContract()` — deploy a covenant to Kaspa network
- `buildUnsignedCovenantTx()` — build settlement transactions
- `signInput()` — sign covenant inputs (Schnorr)
- `buildSigScript()` / `attachSigScript()` — construct covenant sigscripts
- `getCovenantAddress()` / `getChannelAddress()` — derive P2SH addresses
- `connectRpc()` / `getAddressUtxos()` — Kaspa RPC helpers

## Links

- [x402-KAS repo](https://github.com/KASPACOM/x402-KAS)
- [KaspaCom](https://kaspacom.com)
