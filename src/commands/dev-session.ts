import { spawn } from "node:child_process";

import { onOutputClosed } from "../cli/closed-output.js";

export type StopReason = "SIGINT" | "SIGTERM" | "key";

export interface StopRequests {
	// Resolves on the first Ctrl-C, SIGTERM, or `x`.
	readonly first: Promise<StopReason>;
	// Resolves on the second, which forces the stop.
	readonly second: Promise<StopReason>;
	request(reason: StopReason): void;
	requested(): boolean;
	dispose(): void;
}

export function listenForStopRequests(): StopRequests {
	const first = Promise.withResolvers<StopReason>();
	const second = Promise.withResolvers<StopReason>();
	let count = 0;
	const request = (reason: StopReason): void => {
		count += 1;
		if (count === 1) first.resolve(reason);
		if (count === 2) second.resolve(reason);
	};
	const onSigint = (): void => request("SIGINT");
	const onSigterm = (): void => request("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	// Nobody reads the output any more, as after `orange dev --json | head`.
	const stopOnClosedOutput = onOutputClosed(() => request("SIGTERM"));
	return {
		dispose(): void {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			stopOnClosedOutput();
		},
		first: first.promise,
		request,
		requested: () => count > 0,
		second: second.promise,
	};
}

export interface Hotkeys {
	dispose(): void;
}

export interface HotkeyActions {
	clear(): void;
	open(): void;
	stop(): void;
}

// Single-key shortcuts while `open-orange dev` runs in a terminal. Raw mode
// turns Ctrl-C into a key press, so it maps to stop like `x`.
export function listenForHotkeys(actions: HotkeyActions): Hotkeys | undefined {
	const stdin = process.stdin;
	if (!stdin.isTTY || !process.stdout.isTTY || process.env.CI !== undefined) {
		return undefined;
	}
	// Keys typed quickly, or pasted, arrive together in one chunk.
	const onData = (data: Buffer): void => {
		for (const key of data.toString("utf8")) {
			if (key === "\u0003" || key === "x" || key === "q") actions.stop();
			else if (key === "b") actions.open();
			else if (key === "c") actions.clear();
		}
	};
	const restore = (): void => {
		if (stdin.isRaw) stdin.setRawMode(false);
	};
	stdin.setRawMode(true);
	stdin.on("data", onData);
	stdin.resume();
	// A crash must not leave the terminal in raw mode.
	process.once("exit", restore);
	return {
		dispose(): void {
			stdin.off("data", onData);
			restore();
			stdin.pause();
			process.off("exit", restore);
		},
	};
}

// Opens a URL in the default browser. Resolves false when no opener exists.
export function openInBrowser(url: string): Promise<boolean> {
	const [command, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	return new Promise((resolveOpen) => {
		const child = spawn(command, args, { detached: true, stdio: "ignore" });
		child.once("error", () => resolveOpen(false));
		child.once("spawn", () => {
			child.unref();
			resolveOpen(true);
		});
	});
}
