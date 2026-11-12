// The cloudflare:sockets module. The implementation lives in socket.ts, which
// also exports runtime internals that Workers must not see.
import { connect } from "./socket.js";

export { connect, Socket } from "./socket.js";
export type { SocketAddress, SocketInfo, SocketOptions, TlsOptions } from "./socket.js";

export default { connect };
