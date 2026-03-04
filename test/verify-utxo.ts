import { RpcClient, Encoding } from "../packages/kaspa-wasm/kaspa.js";

async function main() {
  const rpc = new RpcClient({ url: "ws://tn12-node.kaspa.com:17210", encoding: Encoding.Borsh, networkId: "testnet-12" });
  await rpc.connect();
  const utxos = await rpc.getUtxosByAddresses(["kaspatest:ppk08c5de6lf6dmpde8nh3x9ydtcxch94ulmk83h3wkp5xs5kqae5sjypxx78"]);
  console.log(`UTXOs at covenant: ${utxos.entries.length}`);
  for (const e of utxos.entries) {
    console.log(`  ${e.outpoint.transactionId}:${e.outpoint.index} = ${e.amount} sompi (${Number(e.amount) / 1e8} KAS)`);
  }
  await rpc.disconnect();
}
main().catch(console.error);
