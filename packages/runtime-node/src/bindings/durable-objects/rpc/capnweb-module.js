// A plain JS re-export lets bundlers resolve Cap'n Web statically while
// TypeScript reads `capnweb-module.d.ts` instead of Cap'n Web's own types,
// which need the DOM lib and fail this package's `skipLibCheck: false` check.
import * as capnweb from "capnweb";

export default capnweb;
