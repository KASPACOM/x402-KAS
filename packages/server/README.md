# @x402/kaspa-server

Server middleware for the x402 Kaspa payment protocol. Gate any HTTP endpoint behind Kaspa micropayments.

## Install

```bash
npm install @x402/kaspa-server
```

## Quick Start

```typescript
import { paywall, buildPaymentRequired } from "@x402/kaspa-server";

// Express example
app.get("/weather", (req, res) => {
  // Check for valid payment in request headers
  // If no payment, return 402:
  const pr = buildPaymentRequired(req.url, {
    amount: "1000000",                    // 0.01 KAS
    payTo: "kaspa:qz...",                 // Your Kaspa address
    network: "kaspa:testnet-12",
    facilitatorUrl: "https://x402.kaspacom.com",
  });
  res.status(402).json(pr);
});
```

## Configuration

| Option | Description |
|--------|-------------|
| `amount` | Price in sompi (string). 1 KAS = 100,000,000 sompi |
| `payTo` | Your Kaspa address to receive payments |
| `network` | CAIP-2 network (`kaspa:mainnet`, `kaspa:testnet-12`) |
| `facilitatorUrl` | KaspaCom facilitator endpoint |

## Pricing Reference

| Price | Sompi | Use Case |
|-------|-------|----------|
| 0.001 KAS | 100,000 | Cheap API call |
| 0.01 KAS | 1,000,000 | Standard API call |
| 0.1 KAS | 10,000,000 | Premium data |
| 1 KAS | 100,000,000 | Heavy compute |

## Links

- [x402-KAS repo](https://github.com/KASPACOM/x402-KAS)
- [KaspaCom](https://kaspacom.com)
