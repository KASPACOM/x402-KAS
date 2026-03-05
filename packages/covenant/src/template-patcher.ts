/**
 * Template Patcher — post-compile argument patching for SilverScript covenants.
 * Adapted from @kaspacom/covenant-sdk/src/template-patcher.ts
 *
 * Instead of recompiling contracts with different arguments, this module finds
 * placeholder bytes in a pre-compiled contract script and replaces them in-place
 * with new values. This produces byte-identical output to a fresh compile.
 */

import { Address, XOnlyPublicKey } from "@x402/kaspa-wasm";
import type { CompiledContract } from "@x402/kaspa-types";

export type CtorArg =
  | { kind: "array"; data: { kind: "byte"; data: number }[] }
  | { kind: "int"; data: number };

export interface TemplateParam {
  name: string;
  paramType: "pubkey" | "byte[32]" | "int" | "int_field";
  positions: { offset: number; length: number }[];
  placeholderBytes: number[];
}

export interface TemplatePatch {
  contractName: string;
  params: TemplateParam[];
}

/** Encode an integer using Bitcoin's minimal push encoding. */
export function encodeScriptInt(value: number): number[] {
  if (!Number.isInteger(value)) throw new Error(`Expected integer, got ${value}`);
  if (value === 0 || value === -1 || (value >= 1 && value <= 16)) return [];

  const negative = value < 0;
  let absValue = Math.abs(value);
  const bytes: number[] = [];

  while (absValue > 0) {
    bytes.push(absValue & 0xff);
    absValue = Math.floor(absValue / 256);
  }

  if ((bytes[bytes.length - 1] & 0x80) !== 0) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[bytes.length - 1] |= 0x80;
  }

  return bytes;
}

/** Encode an integer as fixed-width LE bytes (for state fields). */
export function encodeFixedInt(value: number, size: number = 8): number[] {
  if (!Number.isInteger(value)) throw new Error(`Expected integer, got ${value}`);

  const bytes = new Array<number>(size).fill(0);
  const negative = value < 0;
  let absValue = Math.abs(value);

  for (let i = 0; i < size && absValue > 0; i++) {
    bytes[i] = absValue & 0xff;
    absValue = Math.floor(absValue / 256);
  }

  if (absValue > 0) throw new Error(`Value ${value} does not fit in ${size} bytes`);
  if (negative) bytes[size - 1] |= 0x80;

  return bytes;
}

/** Extract patch descriptor from compiled contract and placeholder args. */
export function extractPatchDescriptor(
  compiled: CompiledContract,
  templateArgs: CtorArg[],
): TemplatePatch {
  const script = assertNumberArray(compiled?.script, "compiled.script");
  const params = Array.isArray(compiled?.ast?.params) ? compiled.ast.params : [];
  const fieldInitParams = getFieldInitParams((compiled?.ast as any)?.fields, params);

  if (params.length !== templateArgs.length) {
    throw new Error(`Template args mismatch: expected ${params.length}, got ${templateArgs.length}`);
  }

  const descriptorParams: TemplateParam[] = params.map((param: any, i: number) => {
    const arg = templateArgs[i];
    const isFieldInit = fieldInitParams.has(param.name);
    const placeholderBytes = argToBytes(arg, isFieldInit);
    const positions = findAllOccurrences(script, placeholderBytes).map((offset) => ({
      offset,
      length: placeholderBytes.length,
    }));

    if (positions.length === 0) {
      if (arg.kind === "int" && placeholderBytes.length === 0) {
        throw new Error(`Param "${param.name}" uses a special opcode placeholder and cannot be patched`);
      }
      throw new Error(`Could not find bytes for param "${param.name}" in script`);
    }

    return {
      name: param.name,
      paramType: getParamType(param, arg, isFieldInit),
      positions,
      placeholderBytes,
    };
  });

  return { contractName: compiled?.contract_name || "Unnamed", params: descriptorParams };
}

/** Apply a patch descriptor to produce a new contract with real args. */
export function applyPatch(
  template: CompiledContract,
  descriptor: TemplatePatch,
  newArgs: CtorArg[],
): CompiledContract {
  const params = Array.isArray(template?.ast?.params) ? template.ast.params : [];
  const script = assertNumberArray(template?.script, "template.script").slice();

  if (params.length !== newArgs.length) {
    throw new Error(`Replacement args mismatch: expected ${params.length}, got ${newArgs.length}`);
  }

  for (const patch of descriptor.params) {
    const paramIndex = params.findIndex((p: any) => p.name === patch.name);
    if (paramIndex === -1) throw new Error(`Unknown template param "${patch.name}"`);

    const replacementBytes = argToBytes(newArgs[paramIndex], patch.paramType === "int_field");
    if (replacementBytes.length !== patch.placeholderBytes.length) {
      throw new Error(
        `Size mismatch for "${patch.name}": placeholder=${patch.placeholderBytes.length}B, replacement=${replacementBytes.length}B`,
      );
    }

    for (const pos of patch.positions) {
      for (let j = 0; j < pos.length; j++) {
        if (script[pos.offset + j] !== patch.placeholderBytes[j]) {
          throw new Error(`Script corruption at "${patch.name}" offset ${pos.offset + j}`);
        }
        script[pos.offset + j] = replacementBytes[j];
      }
    }
  }

  return { ...template, script };
}

/** Convert a Kaspa address to 32-byte x-only public key. */
export function kaspaAddressToPubkeyBytes(address: string): number[] {
  const parsed = new Address(address.trim());
  const xOnly = XOnlyPublicKey.fromAddress(parsed).toString();
  return hexToNumberArray(xOnly);
}

/** Helper: create a byte array CtorArg */
export function byteArrayArg(bytes: number[]): CtorArg {
  return { kind: "array", data: bytes.map((v) => ({ kind: "byte" as const, data: v })) };
}

/** Helper: create an integer CtorArg */
export function intArg(value: number): CtorArg {
  return { kind: "int", data: value };
}

// ── Internal ──

function getFieldInitParams(fields: any[] | undefined, params: any[]): Set<string> {
  const set = new Set<string>();
  for (const field of Array.isArray(fields) ? fields : []) {
    const id = field?.expr?.kind === "identifier" ? field.expr.data : null;
    if (id && params.some((p: any) => p.name === id)) set.add(id);
  }
  return set;
}

function getParamType(param: any, arg: CtorArg, isFieldInit: boolean): TemplateParam["paramType"] {
  if (arg.kind === "int") return isFieldInit ? "int_field" : "int";
  if (param?.type_ref?.base === "pubkey") return "pubkey";
  if (param?.type_ref?.base === "byte" && param?.type_ref?.array_dims?.[0]?.value === 32) return "byte[32]";
  throw new Error(`Unsupported template param "${param?.name || "unknown"}"`);
}

function argToBytes(arg: CtorArg, isFieldInit: boolean): number[] {
  if (arg.kind === "array") return arg.data.map((e) => e.data);
  return isFieldInit ? encodeFixedInt(arg.data, 8) : encodeScriptInt(arg.data);
}

function findAllOccurrences(haystack: number[], needle: number[]): number[] {
  if (needle.length === 0) return [];
  const positions: number[] = [];
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { matched = false; break; }
    }
    if (matched) positions.push(i);
  }
  return positions;
}

function hexToNumberArray(hex: string): number[] {
  const n = hex.trim().replace(/^0x/i, "").toLowerCase();
  if (n.length === 0 || n.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes: number[] = [];
  for (let i = 0; i < n.length; i += 2) bytes.push(Number.parseInt(n.slice(i, i + 2), 16));
  return bytes;
}

function assertNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((e) => !Number.isInteger(e))) throw new Error(`Invalid ${label}`);
  return value as number[];
}
