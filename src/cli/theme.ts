// Rivet's palette from rivet.dev: Rivet orange (hsl 18.5 100% 50%) for the
// brand, links, and the one thing to look at, zinc grays for everything else,
// and the site's green, amber, and red for request and error states.
export type Color = "black" | "border" | "green" | "muted" | "orange" | "red" | "subtle" | "white" | "yellow";

const trueColors: Record<Color, string> = {
	black: "9;9;11",
	border: "63;63;70",
	green: "46;184;138",
	muted: "161;161;170",
	orange: "255;79;0",
	red: "239;68;68",
	subtle: "113;113;122",
	white: "250;250;250",
	yellow: "232;140;48",
};

const ansi256Colors: Record<Color, number> = {
	black: 232,
	border: 238,
	green: 36,
	muted: 248,
	orange: 202,
	red: 203,
	subtle: 243,
	white: 231,
	yellow: 172,
};

type ColorDepth = 0 | 256 | 16_777_216;

// hasColors() honors NO_COLOR, FORCE_COLOR, and TERM. Pipes and files get no color.
function colorDepth(stream: NodeJS.WriteStream): ColorDepth {
	if (!stream.isTTY) {
		// FORCE_COLOR opts a pipe in, such as a CI log that renders ANSI.
		const force = process.env.FORCE_COLOR;
		if (force === "3") return 16_777_216;
		if (force === "1" || force === "2" || force === "true") return 256;
		return 0;
	}
	if (stream.hasColors(16_777_216)) return 16_777_216;
	if (stream.hasColors(256)) return 256;
	return 0;
}

// OSC 8 hyperlinks need a terminal. A pipe, a dumb terminal, or NO_COLOR gets the plain URL,
// which a reader can still copy.
export function supportsHyperlinks(stream: NodeJS.WriteStream): boolean {
	if (!stream.isTTY) return false;
	if (process.env.TERM === "dumb") return false;
	return process.env.NO_COLOR === undefined || process.env.NO_COLOR === "";
}

// `label` as an OSC 8 hyperlink to `url`.
export function osc8(label: string, url: string): string {
	return `\u001B]8;;${url}\u001B\\${label}\u001B]8;;\u001B\\`;
}

export interface Theme {
	readonly enabled: boolean;
	// Whether `hyperlink` prints a link with a label. Otherwise it prints the full URL.
	readonly hyperlinks: boolean;
	// `label` linked to `url` in a terminal that supports it, and the full URL everywhere else.
	hyperlink(label: string, url: string): string;
	fg(color: Color, text: string): string;
	badge(text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	link(text: string): string;
}

export function createTheme(stream: NodeJS.WriteStream): Theme {
	const depth = colorDepth(stream);
	const wrap = (open: string, close: string, text: string): string =>
		depth === 0 ? text : `\u001B[${open}m${text}\u001B[${close}m`;
	const foreground = (color: Color): string =>
		depth === 256 ? `38;5;${ansi256Colors[color]}` : `38;2;${trueColors[color]}`;
	const background = (color: Color): string =>
		depth === 256 ? `48;5;${ansi256Colors[color]}` : `48;2;${trueColors[color]}`;
	const hyperlinks = supportsHyperlinks(stream);
	return {
		enabled: depth !== 0,
		hyperlinks,
		hyperlink: (label, url) => wrap(`4;${foreground("orange")}`, "24;39", hyperlinks ? osc8(label, url) : url),
		badge: (text) =>
			wrap(`1;${foreground("black")};${background("orange")}`, "0", ` ${text} `),
		bold: (text) => wrap("1", "22", text),
		dim: (text) => wrap(foreground("muted"), "39", text),
		fg: (color, text) => wrap(foreground(color), "39", text),
		link: (text) => wrap(`4;${foreground("orange")}`, "24;39", text),
	};
}

// The width a string takes in the terminal, without ANSI codes.
export function visibleLength(text: string): number {
	return text.replace(/\u001B\[[0-9;]*m/g, "").replace(/\u001B\]8;;[^\u001B]*\u001B\\/g, "").length;
}

export function padVisible(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}
