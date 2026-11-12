// Rivet's own limits, which are Orange's only limits. Cloudflare's quotas are not copied.

// Rivet stores one SQLite commit of an actor in at most 32,768 changed 4 KiB pages. A single
// write at or over this size can never commit, so it fails at once with this error, before it
// reaches the actor's storage. A smaller write that still dirties too many pages fails at commit.
// https://github.com/rivet-dev/actors/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/rivet-sqlite-types/src/lib.rs#L50
export const rivetSqliteCommitBytes = 32_768 * 4_096;

export function assertFitsRivetCommit(what: string, bytes: number): void {
	if (bytes < rivetSqliteCommitBytes) return;
	throw new RangeError(
		`${what} is ${bytes} bytes. Rivet stores at most ${rivetSqliteCommitBytes} bytes (128 MiB) of changed SQLite pages in one actor commit, so one write must be smaller.`,
	);
}

// The Engine takes at most 32 MiB in one message from a runner. A Durable Object RPC call and a
// RivetKit action, such as a queue send, are each one message.
// https://github.com/rivet-dev/actors/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/pegboard-envoy/src/routes.rs#L186
export const rivetEnvoyMessageBytes = 32 * 1024 * 1024;
