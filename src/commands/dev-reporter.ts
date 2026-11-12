import { startSpinner, type Spinner } from "../cli/spinner.js";
import type { Theme } from "../cli/theme.js";
import type { ResolvedWranglerConfiguration } from "../config/load-wrangler.js";
import type { RuntimeRequestMessage } from "../../packages/runtime-node/src/process-protocol.js";
import {
	cronTriggerUrl,
	describeBindings,
	type ReadyDetails,
	renderDevHeader,
	renderError,
	renderFailure,
	renderHotkeys,
	renderReady,
	renderRequest,
	renderStopping,
	renderWarning,
} from "./dev-output.js";

export interface DevCommandIo {
	log(message: string): void;
	error(message: string): void;
}

// Everything `open-orange dev` tells its caller. The terminal reporter draws
// for people; the JSON reporter writes one event per line for scripts and agents.
export interface DevReporter {
	header(config: ResolvedWranglerConfiguration): void;
	phase(text: string): void;
	warning(message: string): void;
	ready(details: ReadyDetails, hotkeys: boolean): void;
	request(request: RuntimeRequestMessage): void;
	error(message: string, stack?: string): void;
	output(chunk: Buffer, stream: "stderr" | "stdout"): void;
	stopping(): void;
	stopped(exitCode: number): void;
	failure(message: string, hint?: string): void;
	// Clears the terminal and prints the ready block again.
	redraw(): void;
	dispose(): void;
}

export function createTerminalReporter(io: DevCommandIo, theme: Theme): DevReporter {
	let spinner: Spinner | undefined;
	let readyBlock: string | undefined;
	let headerShown = false;
	// Lines printed while the spinner runs clear it first, so they never tear.
	const around = (write: () => void): void => {
		if (spinner === undefined) write();
		else spinner.interrupt(write);
	};
	const stopSpinner = (): void => {
		spinner?.stop();
		spinner = undefined;
	};
	return {
		dispose: stopSpinner,
		error: (message, stack) => around(() => io.error(renderError(theme, message, stack))),
		failure(message, hint): void {
			stopSpinner();
			io.error(renderFailure(theme, message, hint));
		},
		header(config): void {
			io.log(renderDevHeader(theme, config, !headerShown));
			io.log("");
			headerShown = true;
		},
		output(chunk, stream): void {
			const target = stream === "stdout" ? process.stdout : process.stderr;
			around(() => target.write(chunk));
		},
		phase(text): void {
			if (spinner === undefined) spinner = startSpinner(process.stdout, theme, text);
			else spinner.update(text);
		},
		ready(details, hotkeys): void {
			stopSpinner();
			readyBlock = renderReady(theme, details);
			if (hotkeys) readyBlock += `\n${renderHotkeys(theme)}`;
			// Scripts and agents read this output from a pipe. Point them at the stable format.
			if (!process.stdout.isTTY) readyBlock += "\n  Pass --json for JSON Lines events.";
			io.log(`${readyBlock}\n`);
		},
		redraw(): void {
			process.stdout.write("\u001B[2J\u001B[3J\u001B[H");
			if (readyBlock !== undefined) io.log(`${readyBlock}\n`);
		},
		request: (request) => around(() => io.log(renderRequest(theme, request))),
		stopped: () => {},
		stopping(): void {
			stopSpinner();
			io.log(renderStopping(theme));
		},
		warning: (message) => around(() => io.error(renderWarning(theme, message))),
	};
}

// JSON Lines on standard output. The Worker's own output becomes `log` events,
// so standard output never carries anything but JSON.
export function createJsonReporter(io: DevCommandIo): DevReporter {
	const emit = (event: Record<string, unknown>): void => io.log(JSON.stringify(event));
	return {
		dispose: () => {},
		error: (message, stack) => emit({ message, ...(stack === undefined ? {} : { stack }), type: "error" }),
		failure: (message, hint) => emit({ ...(hint === undefined ? {} : { hint }), message, type: "failure" }),
		header(config): void {
			emit({
				bindings: describeBindings(config).map((binding) => ({
					...(binding.alternative === undefined ? {} : { alternative: binding.alternative }),
					...(binding.className === undefined ? {} : { className: binding.className }),
					name: binding.binding,
					status: binding.status,
					type: binding.type,
				})),
				compatibilityDate: config.compatibilityDate,
				...(config.configPath === undefined ? {} : { configPath: config.configPath }),
				type: "config",
				...(config.workerName === undefined ? {} : { worker: config.workerName }),
			});
		},
		output: (chunk, stream) => emit({ stream, text: chunk.toString("utf8"), type: "log" }),
		phase: () => {},
		ready: (details) =>
			emit({
				...(details.cronNextRuns === undefined
					? {}
					: {
							crons: details.cronNextRuns.map((run) => ({
								cron: run.cron,
								nextRunAt: new Date(run.nextRunAt).toISOString(),
								triggerUrl: cronTriggerUrl(details.origin, run.cron),
							})),
						}),
				elapsedMs: Math.round(details.elapsedMs),
				...(details.mcp === undefined ? {} : { mcp: details.mcp }),
				type: "ready",
				url: details.origin,
			}),
		redraw: () => {},
		request: (request) =>
			emit({
				durationMs: Math.round(request.durationMs * 10) / 10,
				method: request.method,
				path: request.path,
				status: request.status,
				type: "request",
			}),
		stopped: (exitCode) => emit({ exitCode, type: "stopped" }),
		stopping: () => emit({ type: "stopping" }),
		warning: (message) => emit({ message, type: "warning" }),
	};
}
