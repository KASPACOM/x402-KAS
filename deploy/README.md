# Deploying the x402 Facilitator

## Option 1: systemd (bare metal / VPS)

```bash
# 1. Clone and build
git clone git@github.com:KASPACOM/x402-KAS.git /root/x402-kaspa
cd /root/x402-kaspa
pnpm install && pnpm build

# 2. Create env file
cp deploy/facilitator.env.example /root/.x402-facilitator.env
# Edit /root/.x402-facilitator.env — set FACILITATOR_PRIVATE_KEY
chmod 600 /root/.x402-facilitator.env

# 3. Install service
sudo cp deploy/facilitator.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now facilitator

# 4. Check
sudo systemctl status facilitator
curl http://localhost:4020/health
```

## Option 2: Docker

```bash
cd deploy
cp facilitator.env.example facilitator.env
# Edit facilitator.env — set FACILITATOR_PRIVATE_KEY

docker compose up -d
curl http://localhost:4020/health
```

## Sweep fees

```bash
# Manual sweep to cold wallet
curl -X POST http://localhost:4020/sweep
```

## Health check

```
GET /health → { status, network, pubkey, signingAddress, feeAddress }
```

## Env vars

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FACILITATOR_PRIVATE_KEY` | yes | — | 64-char hex private key (any key works with v3 contract) |
| `FACILITATOR_FEE_ADDRESS` | no | signing address | Cold wallet for fee sweeps |
| `COMPILED_CONTRACT_PATH` | no | v3 contract | Path to compiled covenant JSON |
| `CTOR_ARGS_PATH` | no | v3 ctor | Path to constructor args JSON |
| `KASPA_RPC` | no | `ws://tn12-node.kaspa.com:17210` | Kaspa wRPC node |
| `KASPA_NETWORK` | no | `kaspa:testnet-12` | CAIP-2 network ID |
| `PORT` | no | `4020` | Listen port |
| `MIN_CONFIRMATIONS` | no | `10` | DAA score confirmations |

For KaspaCom production (v4-locked contract), set:
```bash
COMPILED_CONTRACT_PATH=./contracts/compiled/x402-channel-v4-locked.json
CTOR_ARGS_PATH=./contracts/silverscript/x402-channel-v4-locked-ctor.json
```
