# @kaspacom/x402-types

Shared TypeScript type definitions and constants for the x402 Kaspa payment protocol.

## Install

```bash
npm install @kaspacom/x402-types
```

## What's Included

- `PaymentPayload`, `PaymentRequirements` — x402 protocol types
- `VerifyRequest`, `VerifyResponse`, `SettleRequest`, `SettlementResponse` — facilitator API types
- `CompiledContract`, `SpendOutput`, `CovenantOutpoint` — covenant types
- `STANDARD_FEE`, `SOMPI_PER_KAS` — constants
- `KASPACOM_FACILITATOR_PUBKEY` — hardcoded facilitator public key
- `KaspaNetwork`, `NETWORK_IDS` — network identifiers

## Usage

```typescript
import { STANDARD_FEE, KASPACOM_FACILITATOR_PUBKEY } from "@kaspacom/x402-types";
import type { PaymentPayload, PaymentRequirements } from "@kaspacom/x402-types";
```

## Links

- [x402-KAS repo](https://github.com/KASPACOM/x402-KAS)
- [KaspaCom](https://kaspacom.com)
