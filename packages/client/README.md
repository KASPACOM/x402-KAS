# @x402/kaspa

Client SDK for the x402 Kaspa payment protocol. Automatically handles HTTP 402 payments on Kaspa L1.

## Install

```bash
npm install @x402/kaspa
```

## Quick Start

```typescript
import { X402Client } from "@x402/kaspa";

const client = new X402Client({
  privateKeyHex: "<your-64-char-hex-key>",
  rpcUrl: "ws://tn12-node.kaspa.com:17210",
  network: "kaspa:testnet-12",
});

// Fetch a paid endpoint — payment happens automatically
const response = await client.fetch("https://api.example.com/weather");
const data = await response.json();
```

## How It Works

1. Client calls a paid API endpoint
2. Server returns `402 Payment Required` with payment details
3. SDK automatically deploys a payment channel (first time only)
4. SDK signs a settle TX and retries the request with payment proof
5. Facilitator (KaspaCom) co-signs and broadcasts on-chain
6. Server returns the requested data

## Configuration

```typescript
const client = new X402Client({
  privateKeyHex: "...",           // Required: your Kaspa private key
  rpcUrl: "ws://...",             // Required: Kaspa wRPC node
  network: "kaspa:testnet-12",    // Required: CAIP-2 network
  defaultFunding: 1_000_000_000n, // Optional: channel funding (default 10 KAS)
  defaultTimeout: 86400,          // Optional: channel timeout seconds (default 24h)
});
```

## Payment Channels

The SDK manages payment channels automatically:
- Opens a channel on first payment (deploys a 2-of-2 covenant)
- Reuses the channel for subsequent payments (incrementing nonce)
- Each payment is a settle TX that pays the merchant directly

## Links

- [x402-KAS repo](https://github.com/KASPACOM/x402-KAS)
- [KaspaCom](https://kaspacom.com)
