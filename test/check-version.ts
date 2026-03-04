import { version, NetworkId } from "../packages/kaspa-wasm/kaspa.js";
console.log("WASM version:", version());
try {
  const nid = new NetworkId("testnet-12");
  console.log("NetworkId testnet-12:", nid.toString(), "prefix:", nid.addressPrefix());
} catch(e) {
  console.error("NetworkId testnet-12 failed:", e);
}
try {
  const nid = new NetworkId("testnet-11");
  console.log("NetworkId testnet-11:", nid.toString(), "prefix:", nid.addressPrefix());
} catch(e) {
  console.error("NetworkId testnet-11 failed:", e);
}
