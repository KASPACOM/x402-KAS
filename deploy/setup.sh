#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# x402-KAS Deploy Script
# Sets up a fresh Ubuntu/Debian VPS to run the x402 facilitator
# and optionally a paid API server.
#
# Usage:
#   curl -sSL <raw-url> | bash
#   # or
#   bash deploy/setup.sh
#
# Prerequisites: Ubuntu 22.04+ or Debian 12+ with root access
# ============================================================

echo "=== x402-KAS Setup ==="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }

# -----------------------------------------------------------
# 1. System packages
# -----------------------------------------------------------
info "Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential ca-certificates gnupg >/dev/null 2>&1

# -----------------------------------------------------------
# 2. Node.js 22 (via NodeSource)
# -----------------------------------------------------------
if command -v node &>/dev/null && [[ "$(node -v)" == v2[0-9]* ]]; then
  info "Node.js $(node -v) already installed"
else
  info "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null 2>&1
  info "Node.js $(node -v) installed"
fi

# -----------------------------------------------------------
# 3. pnpm
# -----------------------------------------------------------
if command -v pnpm &>/dev/null; then
  info "pnpm $(pnpm -v) already installed"
else
  info "Installing pnpm..."
  npm install -g pnpm >/dev/null 2>&1
  info "pnpm $(pnpm -v) installed"
fi

# -----------------------------------------------------------
# 4. Rust toolchain (for kascov)
# -----------------------------------------------------------
if command -v cargo &>/dev/null; then
  info "Rust $(rustc --version | awk '{print $2}') already installed"
else
  info "Installing Rust toolchain (for kascov build)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y >/dev/null 2>&1
  source "$HOME/.cargo/env"
  info "Rust $(rustc --version | awk '{print $2}') installed"
fi
# Ensure cargo is in PATH for this script
export PATH="$HOME/.cargo/bin:$PATH"

# -----------------------------------------------------------
# 5. Clone and build kascov
# -----------------------------------------------------------
KASCOV_DIR="/opt/kascov"
KASCOV_BIN="/usr/local/bin/kascov"

if [[ -f "$KASCOV_BIN" ]]; then
  info "kascov binary already at $KASCOV_BIN"
else
  info "Building kascov from source..."
  if [[ -d "$KASCOV_DIR" ]]; then
    cd "$KASCOV_DIR" && git pull -q
  else
    git clone --depth 1 https://github.com/aspect-build/kascov.git "$KASCOV_DIR" 2>/dev/null
  fi
  cd "$KASCOV_DIR"
  cargo build --release >/dev/null 2>&1
  cp target/release/kascov "$KASCOV_BIN"
  chmod +x "$KASCOV_BIN"
  info "kascov built and installed at $KASCOV_BIN"
fi

# -----------------------------------------------------------
# 6. Clone x402-KAS repo
# -----------------------------------------------------------
X402_DIR="/opt/x402-kaspa"

if [[ -d "$X402_DIR" ]]; then
  info "x402-kaspa already at $X402_DIR, pulling latest..."
  cd "$X402_DIR" && git pull -q
else
  info "Cloning x402-KAS..."
  git clone https://github.com/KASPACOM/x402-KAS.git "$X402_DIR" 2>/dev/null
fi

cd "$X402_DIR"

# -----------------------------------------------------------
# 7. Install dependencies and build
# -----------------------------------------------------------
info "Installing dependencies..."
pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null 2>&1

info "Building all packages..."
pnpm build >/dev/null 2>&1
info "All packages built successfully"

# -----------------------------------------------------------
# 8. Create env file template
# -----------------------------------------------------------
ENV_FILE="/opt/x402-kaspa/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# x402-KAS Configuration
# Fill in the values below and restart the services

# Facilitator (required)
FACILITATOR_PRIVATE_KEY=

# Network
KASPA_RPC=ws://tn12-node.kaspa.com:17210
KASPA_NETWORK=kaspa:testnet-12
PORT=4020
MIN_CONFIRMATIONS=10
KASCOV_BIN=/usr/local/bin/kascov

# Paid API (optional — for the example server)
API_PORT=3000
FACILITATOR_URL=http://localhost:4020
FACILITATOR_PUBKEY=
PAY_TO=
PRICE_SOMPI=1000000
ENVEOF
  warn "Created $ENV_FILE — edit it with your keys before starting!"
else
  info "Env file exists at $ENV_FILE"
fi

# -----------------------------------------------------------
# 9. Create systemd services
# -----------------------------------------------------------
info "Creating systemd service files..."

cat > /etc/systemd/system/x402-facilitator.service << 'SVCEOF'
[Unit]
Description=x402 Kaspa Facilitator Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/x402-kaspa
EnvironmentFile=/opt/x402-kaspa/.env
ExecStart=/usr/bin/node packages/facilitator/dist/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

cat > /etc/systemd/system/x402-api.service << 'SVCEOF'
[Unit]
Description=x402 Paid API Example Server
After=x402-facilitator.service

[Service]
Type=simple
WorkingDirectory=/opt/x402-kaspa
EnvironmentFile=/opt/x402-kaspa/.env
ExecStart=/usr/bin/npx tsx examples/paid-api/server.ts
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload

# -----------------------------------------------------------
# 10. Summary
# -----------------------------------------------------------
echo ""
echo "========================================="
echo "  x402-KAS Setup Complete"
echo "========================================="
echo ""
echo "Installed at: $X402_DIR"
echo "kascov:       $KASCOV_BIN"
echo "Config:       $ENV_FILE"
echo ""
echo "Next steps:"
echo ""
echo "  1. Generate a facilitator key:"
echo "     node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
echo ""
echo "  2. Edit the env file:"
echo "     nano /opt/x402-kaspa/.env"
echo "     (set FACILITATOR_PRIVATE_KEY, PAY_TO, etc.)"
echo ""
echo "  3. Start the facilitator:"
echo "     systemctl start x402-facilitator"
echo "     systemctl enable x402-facilitator"
echo ""
echo "  4. Get the facilitator pubkey:"
echo "     curl http://localhost:4020/health"
echo "     (copy the pubkey into .env as FACILITATOR_PUBKEY)"
echo ""
echo "  5. Start the example API (optional):"
echo "     systemctl start x402-api"
echo "     systemctl enable x402-api"
echo ""
echo "  6. Check logs:"
echo "     journalctl -u x402-facilitator -f"
echo "     journalctl -u x402-api -f"
echo ""
echo "  7. Test:"
echo "     curl http://localhost:4020/health"
echo "     curl http://localhost:3000/weather"
echo ""
