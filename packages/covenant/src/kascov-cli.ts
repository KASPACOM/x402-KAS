/**
 * kascov CLI wrapper — shells out to the patched kascov binary for
 * transaction building/signing/broadcasting.
 *
 * This bypasses the WASM SDK's createTransactions() which crashes,
 * using the battle-tested Rust implementation instead.
 */

import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CompiledContract, CovenantOutpoint, SpendOutput } from "@kaspacom/x402-types";
import { PrivateKey as PK } from "@kaspacom/x402-wasm";

const KASCOV_BIN = process.env.KASCOV_BIN ?? "/home/coder/projects/kaspa/kascov/target/release/kascov";
const DEFAULT_RPC = process.env.KASPA_RPC ?? "tn12-node.kaspa.com:16210";

interface KascovResult {
  stdout: string;
  stderr: string;
}

function runKascov(
  rpc: string,
  privateKey: string,
  commands: string,
  timeoutMs: number = 30_000,
): Promise<KascovResult> {
  return new Promise((resolve, reject) => {
    // Create temp dir with wallet
    const workDir = mkdtempSync(join(tmpdir(), "kascov-"));
    const walletPath = join(workDir, "wallets.json");

    // Derive address from private key for kascov wallet entry
    const pk = new PK(privateKey);
    const address = pk.toAddress("testnet-12").toString();

    writeFileSync(walletPath, JSON.stringify([{
      name: "x402-agent",
      private_key: privateKey,
      address,
      created_at_unix_ms: Date.now(),
    }]));

    // Pipe commands: "1\n<command>\nquit\n"
    const input = `1\n${commands}\nquit\n`;

    const child = execFile(
      KASCOV_BIN,
      ["--rpc", rpc],
      { cwd: workDir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Cleanup
        try { rmSync(workDir, { recursive: true, force: true }); } catch {}

        if (err && !stdout.includes("==")) {
          reject(new Error(`kascov failed: ${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** Parse key-value output from kascov (format: "    key: value") */
function parseKascovOutput(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s+(\S+):\s+(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// Deploy Covenant
// ────────────────────────────────────────────────────────────────

export interface KascovDeployResult {
  txid: string;
  contractAddress: string;
  outpoint: CovenantOutpoint;
  amountSompi: bigint;
  feeSompi: bigint;
}

/**
 * Deploy a compiled covenant via kascov CLI.
 */
export async function kascovDeploy(
  compiled: CompiledContract,
  amountSompi: bigint,
  privateKeyHex: string,
  rpc: string = DEFAULT_RPC,
): Promise<KascovDeployResult> {
  // Write compiled contract to temp file
  const workDir = mkdtempSync(join(tmpdir(), "kascov-deploy-"));
  const contractPath = join(workDir, "contract.json");

  // Fix constants format: silverc outputs [] but kascov expects {}
  const fixed = { ...compiled, ast: { ...compiled.ast, constants: {} } };
  writeFileSync(contractPath, JSON.stringify(fixed));

  try {
    const result = await runKascov(rpc, privateKeyHex, `deploy ${contractPath} ${amountSompi}`);
    const parsed = parseKascovOutput(result.stdout);

    if (!parsed.submitted_txid) {
      // Check for errors
      const errorMatch = result.stdout.match(/error:\s*(.+)/);
      throw new Error(errorMatch ? errorMatch[1] : `Deploy failed: ${result.stdout}`);
    }

    return {
      txid: parsed.submitted_txid,
      contractAddress: parsed.contract_address,
      outpoint: {
        txid: parsed.submitted_txid,
        vout: parseInt(parsed.contract_output_outpoint?.split(":")[1] ?? "0"),
      },
      amountSompi: BigInt(parsed.amount_sompi ?? amountSompi.toString()),
      feeSompi: BigInt(parsed.fee_sompi ?? "0"),
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────
// Spend Contract (signed — for settle and refund)
// ────────────────────────────────────────────────────────────────

export interface KascovSpendResult {
  txid: string;
  feeSompi: bigint;
}

/**
 * Spend a deployed covenant UTXO via kascov CLI.
 * This handles the Schnorr signing internally.
 */
export async function kascovSpendSigned(
  compiled: CompiledContract,
  outpoint: CovenantOutpoint,
  inputAmountSompi: bigint,
  functionName: string,
  functionArgs: Record<string, unknown>[],
  outputs: SpendOutput[],
  privateKeyHex: string,
  locktime?: number,
  rpc: string = DEFAULT_RPC,
): Promise<KascovSpendResult> {
  const workDir = mkdtempSync(join(tmpdir(), "kascov-spend-"));

  try {
    // Write contract JSON (fix constants)
    const contractPath = join(workDir, "contract.json");
    const fixed = { ...compiled, ast: { ...compiled.ast, constants: {} } };
    writeFileSync(contractPath, JSON.stringify(fixed));

    // Write function args JSON
    const argsPath = join(workDir, "args.json");
    writeFileSync(argsPath, JSON.stringify(functionArgs));

    // Write outputs JSON
    const outputsPath = join(workDir, "outputs.json");
    const outputsJson = outputs.map(o => ({
      address: o.address,
      amount: Number(o.amount),
    }));
    writeFileSync(outputsPath, JSON.stringify(outputsJson));

    const outpointStr = `${outpoint.txid}:${outpoint.vout}`;
    let cmd = `spend-contract-signed ${contractPath} ${outpointStr} ${inputAmountSompi} ${functionName} ${argsPath} ${outputsPath}`;
    if (locktime !== undefined) {
      cmd += ` ${locktime}`;
    }

    const result = await runKascov(rpc, privateKeyHex, cmd);
    const parsed = parseKascovOutput(result.stdout);

    if (!parsed.submitted_txid) {
      const errorMatch = result.stdout.match(/error:\s*(.+)/);
      throw new Error(errorMatch ? errorMatch[1] : `Spend failed: ${result.stdout}`);
    }

    return {
      txid: parsed.submitted_txid,
      feeSompi: BigInt(parsed.fee_sompi ?? "0"),
    };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────
// Balance Check
// ────────────────────────────────────────────────────────────────

export async function kascovBalance(
  address: string,
  rpc: string = DEFAULT_RPC,
): Promise<bigint> {
  // Use a dummy private key — balance doesn't need signing
  const result = await runKascov(
    rpc,
    "0000000000000000000000000000000000000000000000000000000000000001",
    `balance ${address}`,
  );

  const match = result.stdout.match(/balance_sompi:\s+(\d+)/);
  if (match) return BigInt(match[1]);

  // Try alternate format
  const match2 = result.stdout.match(/(\d+)\s*sompi/);
  if (match2) return BigInt(match2[1]);

  return 0n;
}
