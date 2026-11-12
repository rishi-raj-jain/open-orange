import type { Theme } from "./theme.js";

// An orange turning in place.
const frames = ["◐", "◓", "◑", "◒"];
const frameIntervalMs = 90;

export interface Spinner {
	// Changes the phase text, such as `Bundling Worker…`.
	update(text: string): void;
	// Runs `write` with the spinner line cleared, then draws the spinner again.
	interrupt(write: () => void): void;
	stop(): void;
}

// Draws on interactive terminals only. Elsewhere, phases print nothing, so logs
// and CI output stay free of cursor control codes.
export function startSpinner(
	stream: NodeJS.WriteStream,
	theme: Theme,
	text: string,
): Spinner {
	if (!stream.isTTY) {
		return { interrupt: (write) => write(), stop: () => {}, update: () => {} };
	}
	let current = text;
	let frame = 0;
	let drawn = false;
	const clear = (): void => {
		if (!drawn) return;
		stream.write("\r\u001B[2K");
		drawn = false;
	};
	const draw = (): void => {
		stream.write(
			`\r\u001B[2K${theme.fg("orange", frames[frame % frames.length] ?? "")} ${theme.dim(current)}`,
		);
		drawn = true;
	};
	const showCursor = (): void => {
		stream.write("\u001B[?25h");
	};
	// A crash must not leave the terminal without a cursor.
	process.once("exit", showCursor);
	stream.write("\u001B[?25l");
	draw();
	const timer = setInterval(() => {
		frame += 1;
		draw();
	}, frameIntervalMs);
	timer.unref();
	let stopped = false;
	return {
		interrupt(write): void {
			if (stopped) {
				write();
				return;
			}
			clear();
			write();
			draw();
		},
		stop(): void {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			clear();
			showCursor();
			process.off("exit", showCursor);
		},
		update(next): void {
			current = next;
			if (!stopped) draw();
		},
	};
}
