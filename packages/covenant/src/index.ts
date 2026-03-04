export {
  deployChannel,
  buildPartialSettle,
  completeSettle,
  refundChannel,
  patchChannelContract,
  getChannelAddress,
  type ChannelConfig,
  type ChannelParams,
  type PartiallySignedSettle,
  type SettleResult,
  type DeployChannelResult,
} from "./channel.js";

export { deployContract, type DeployResult } from "./deploy.js";

export {
  extractPatchDescriptor,
  applyPatch,
  byteArrayArg,
  intArg,
  kaspaAddressToPubkeyBytes,
  type CtorArg,
  type TemplatePatch,
} from "./template-patcher.js";

export {
  getCovenantAddress,
  connectRpc,
  getAddressUtxos,
  buildUnsignedCovenantTx,
  buildSigScript,
  attachSigScript,
  signInput,
  hexToBytes,
  bytesToHex,
} from "./helpers.js";
