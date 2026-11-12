import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative } from "node:path";
import { parseArgs } from "node:util";

import { createTheme, type Theme } from "../cli/theme.js";
import { findLink } from "./rivet-account.js";

// The hosted Rivet MCP server. It gives a coding agent Rivet's tools and docs.
export const rivetMcpUrl = "https://mcp.rivet.dev/mcp";

// The coding agents that `orange mcp` knows. `cli` is the command it looks for on PATH. It never
// runs that command.
export type AgentId = "claude-code" | "codex" | "cursor" | "vscode";

interface Agent {
	id: AgentId;
	name: string;
	cli: string;
	// Files or folders that show the agent is used in a project, relative to a project folder.
	projectMarkers: readonly string[];
	// Files or folders that show the agent is used on this machine.
	homeMarkers(home: string): string[];
}

const claudeConfigDirectory = (home: string): string => process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
const codexHome = (home: string): string => process.env.CODEX_HOME || join(home, ".codex");

// In the order `orange mcp` suggests them when nothing tells them apart.
const agents: readonly Agent[] = [
	{
		cli: "claude",
		homeMarkers: (home) => [claudeConfigDirectory(home)],
		id: "claude-code",
		name: "Claude Code",
		projectMarkers: [".claude", ".mcp.json", "CLAUDE.md"],
	},
	{ cli: "codex", homeMarkers: (home) => [codexHome(home)], id: "codex", name: "Codex", projectMarkers: [".codex"] },
	{ cli: "cursor", homeMarkers: (home) => [join(home, ".cursor")], id: "cursor", name: "Cursor", projectMarkers: [".cursor"] },
	// A `.vscode` folder or a VS Code install says nothing about its agent, so only an MCP file counts.
	{
		cli: "code",
		homeMarkers: (home) => [vsCodeUserMcpPath(home)],
		id: "vscode",
		name: "VS Code",
		projectMarkers: [join(".vscode", "mcp.json")],
	},
];

// As `orange deploy` picks its cluster: the flag, then RIVET_CLUSTER, then the linked cluster.
function resolveCluster(flag: string | undefined): string | undefined {
	if (flag !== undefined && flag.length > 0) return flag;
	const fromEnvironment = process.env.RIVET_CLUSTER?.trim();
	if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
	try {
		return findLink()?.cluster;
	} catch {
		// A broken link file is `orange deploy`'s error to report, not a hint's.
		return undefined;
	}
}

// One server entry of an agent configuration.
interface McpServerEntry {
	name: string;
	// The `url`, and the `args` of a command such as `npx mcp-remote <url>`.
	urls: string[];
	disabled: boolean;
}

const rivetMcpHost = "mcp.rivet.dev";

// The Rivet MCP URL of `entry`. Undefined when the entry is disabled or names another server.
function rivetMcpEntryUrl(entry: McpServerEntry, disabledNames: ReadonlySet<string> = new Set()): URL | undefined {
	if (entry.disabled || disabledNames.has(entry.name)) return undefined;
	for (const url of entry.urls) {
		try {
			const parsed = new URL(url);
			if (parsed.hostname === rivetMcpHost) return parsed;
		} catch {
			// Not a URL, such as the `-y` of `npx -y mcp-remote <url>`.
		}
	}
	return undefined;
}

function readText(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

// JSON with `//` and `/* */` comments and trailing commas, as VS Code and Cursor accept it.
// Undefined when the text is not valid.
function parseJsonc(text: string): unknown {
	let json = "";
	for (let index = 0; index < text.length; ) {
		const char = text[index] ?? "";
		if (char === '"') {
			let end = index + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			json += text.slice(index, end + 1);
			index = end + 1;
		} else if (text.startsWith("//", index)) {
			const end = text.indexOf("\n", index);
			index = end === -1 ? text.length : end;
		} else if (text.startsWith("/*", index)) {
			const end = text.indexOf("*/", index + 2);
			index = end === -1 ? text.length : end + 2;
		} else {
			json += char;
			index += 1;
		}
	}
	try {
		return JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// The entries of an `mcpServers` (Claude Code, Cursor) or `servers` (VS Code) object.
function jsonServers(servers: unknown): McpServerEntry[] {
	if (!isRecord(servers)) return [];
	return Object.entries(servers).flatMap(([name, entry]): McpServerEntry[] =>
		isRecord(entry)
			? [
					{
						disabled: entry.disabled === true || entry.enabled === false,
						name,
						urls: [...strings([entry.url, entry.serverUrl]), ...strings(entry.args)],
					},
				]
			: [],
	);
}

function jsonFileServers(path: string): McpServerEntry[] {
	const text = readText(path);
	const config = text === undefined ? undefined : parseJsonc(text);
	return isRecord(config) ? [...jsonServers(config.mcpServers), ...jsonServers(config.servers)] : [];
}

// The quoted strings of a TOML value, such as `"https://..."` or `["mcp-remote", "https://..."]`.
function tomlStrings(value: string): string[] {
	return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2] ?? "");
}

// A TOML line without its `#` comment. A `#` inside a string stays.
function withoutTomlComment(line: string): string {
	let quote: string | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index];
		if (quote === undefined && char === "#") return line.slice(0, index);
		if (char === '"' || char === "'") quote = quote === char ? undefined : (quote ?? char);
	}
	return line;
}

// The `[mcp_servers.<name>]` tables of a Codex `config.toml`, and the inline tables under
// `[mcp_servers]`. It reads only `url`, `args`, and `enabled`.
function codexServers(path: string): McpServerEntry[] {
	const text = readText(path);
	if (text === undefined) return [];
	const servers: McpServerEntry[] = [];
	let current: McpServerEntry | undefined;
	let inServersTable = false;
	for (const raw of text.split("\n")) {
		const line = withoutTomlComment(raw).trim();
		if (line.startsWith("[")) {
			const table = /^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]$/.exec(line);
			const name = table?.[1] ?? table?.[2] ?? table?.[3];
			current = name === undefined ? undefined : { disabled: false, name, urls: [] };
			if (current !== undefined) servers.push(current);
			inServersTable = /^\[\s*mcp_servers\s*\]$/.test(line);
			continue;
		}
		const pair = /^("[^"]+"|'[^']+'|[\w-]+)\s*=\s*(.*)$/.exec(line);
		if (pair === null) continue;
		const key = (pair[1] ?? "").replace(/^["']|["']$/g, "");
		const value = pair[2] ?? "";
		if (current !== undefined) {
			if (key === "url" || key === "args") current.urls.push(...tomlStrings(value));
			if (key === "enabled") current.disabled = value.trim() === "false";
		} else if (inServersTable && value.trim().startsWith("{")) {
			servers.push({
				disabled: /\benabled\s*=\s*false\b/.test(value),
				name: key,
				urls: [...value.matchAll(/\b(?:url|args)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/g)].flatMap((match) => tomlStrings(match[1] ?? "")),
			});
		}
	}
	return servers;
}

// What Claude Code keeps in `.claude.json`, under CLAUDE_CONFIG_DIR or in the home directory: the
// user servers, and the local servers and disabled server names of each project. Only the projects
// at `directories` count.
interface ClaudeUserConfig {
	servers: McpServerEntry[];
	// Names that `/mcp` disabled. They apply to every server of the project.
	disabled: Set<string>;
	// Names of `.mcp.json` servers that the user rejected.
	rejectedProjectServers: Set<string>;
}

function readClaudeUserConfig(path: string, directories: readonly string[]): ClaudeUserConfig {
	const text = readText(path);
	let config: unknown;
	try {
		config = text === undefined ? undefined : JSON.parse(text);
	} catch {
		config = undefined;
	}
	const root = isRecord(config) ? config : {};
	const projects = isRecord(root.projects) ? root.projects : {};
	const entries = directories.flatMap((directory) => {
		const project = projects[directory];
		return isRecord(project) ? [project] : [];
	});
	return {
		disabled: new Set(entries.flatMap((project) => strings(project.disabledMcpServers))),
		rejectedProjectServers: new Set(entries.flatMap((project) => strings(project.disabledMcpjsonServers))),
		servers: [...jsonServers(root.mcpServers), ...entries.flatMap((project) => jsonServers(project.mcpServers))],
	};
}

// The VS Code user `mcp.json`. VS Code keeps its user data in the platform's application data folder.
function vsCodeUserMcpPath(home: string): string {
	if (process.platform === "darwin") return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
	if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "mcp.json");
	return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Code", "User", "mcp.json");
}


// `directory` and each of its parent folders.
function withParents(directory: string): string[] {
	const directories: string[] = [];
	for (let current = directory; current !== parse(current).root; current = dirname(current)) directories.push(current);
	return directories;
}

// An agent configuration file that names the Rivet MCP.
export interface RivetMcpConfiguration {
	agent: AgentId;
	// The file, with the home directory shown as `~`.
	path: string;
	// The cluster that the server URL pins. Undefined when it pins none.
	cluster?: string;
}

/**
 * Finds each agent configuration that names the Rivet MCP for `projectRoot`: the project files of
 * Claude Code, Cursor, VS Code, and Codex in it and its parent folders, as Claude Code reads
 * `.mcp.json`, then each agent's user file. A server counts only when its URL host is
 * `mcp.rivet.dev` and it is not disabled. It only reads files. It never runs an agent CLI and never
 * prints what a file contains.
 */
export function findRivetMcpConfigurations(projectRoot: string): RivetMcpConfiguration[] {
	const home = homedir();
	const directories = withParents(projectRoot);
	const shown = (path: string): string => (path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path);
	const claudePath = join(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json");
	const claude = readClaudeUserConfig(claudePath, directories);
	const notProjectServer = new Set([...claude.disabled, ...claude.rejectedProjectServers]);
	const found: RivetMcpConfiguration[] = [];
	const add = (agent: AgentId, path: string, servers: McpServerEntry[], disabled?: ReadonlySet<string>): void => {
		// A project folder can be the home directory, so a user file can come up twice.
		if (found.some((configuration) => configuration.path === shown(path))) return;
		const url = servers.map((entry) => rivetMcpEntryUrl(entry, disabled)).find((entryUrl) => entryUrl !== undefined);
		if (url === undefined) return;
		const cluster = url.searchParams.get("cluster") ?? "";
		found.push({ agent, path: shown(path), ...(cluster === "" ? {} : { cluster }) });
	};
	for (const directory of directories) {
		const file = (...parts: string[]): string => join(directory, ...parts);
		add("claude-code", file(".mcp.json"), jsonFileServers(file(".mcp.json")), notProjectServer);
		add("cursor", file(".cursor", "mcp.json"), jsonFileServers(file(".cursor", "mcp.json")));
		add("vscode", file(".vscode", "mcp.json"), jsonFileServers(file(".vscode", "mcp.json")));
		add("codex", file(".codex", "config.toml"), codexServers(file(".codex", "config.toml")));
	}
	add("claude-code", claudePath, claude.servers, claude.disabled);
	const cursor = join(home, ".cursor", "mcp.json");
	const vsCode = vsCodeUserMcpPath(home);
	const codex = join(codexHome(home), "config.toml");
	add("cursor", cursor, jsonFileServers(cursor));
	add("vscode", vsCode, jsonFileServers(vsCode));
	add("codex", codex, codexServers(codex));
	return found;
}

export function isRivetMcpConfigured(projectRoot: string): boolean {
	return findRivetMcpConfigurations(projectRoot).length > 0;
}

// The server URL, pinned to `cluster` when one is known.
function pinnedUrl(cluster: string | undefined): string {
	return cluster === undefined ? rivetMcpUrl : `${rivetMcpUrl}?cluster=${encodeURIComponent(cluster)}`;
}

// What `orange doctor` and `orange dev` report.
export interface RivetMcpStatus {
	url: string;
	cluster?: string;
	// Whether an agent configuration names the Rivet MCP.
	configured: boolean;
}

export function rivetMcpStatus(projectRoot: string, cluster?: string): RivetMcpStatus {
	const pinned = resolveCluster(cluster);
	return { ...(pinned === undefined ? {} : { cluster: pinned }), configured: isRivetMcpConfigured(projectRoot), url: pinnedUrl(pinned) };
}

// The path of `command` in a PATH folder. Undefined when no folder has it as an executable file.
function findOnPath(command: string): string | undefined {
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory === "") continue;
		for (const extension of extensions) {
			const path = join(directory, `${command}${extension}`);
			try {
				if (!statSync(path).isFile()) continue;
				if (process.platform !== "win32") accessSync(path, constants.X_OK);
				return path;
			} catch {
				// Not there, or not executable.
			}
		}
	}
	return undefined;
}

// Whether `child` is `parent` or inside it.
function isWithin(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export interface RivetMcpAgentStatus {
	id: AgentId;
	name: string;
	configuredIn: Omit<RivetMcpConfiguration, "agent">[];
	// The agent CLI on PATH.
	cli?: string;
	// Whether its folder is in this project or a parent folder below the home directory.
	usedInProject: boolean;
	// Whether its CLI is on PATH, or its folder is in this project or the home directory.
	detected: boolean;
}

// What `orange mcp` prints.
export interface RivetMcpReport {
	url: string;
	cluster?: string;
	agents: RivetMcpAgentStatus[];
}

export function rivetMcpReport(projectRoot: string, cluster?: string): RivetMcpReport {
	const home = homedir();
	const pinned = resolveCluster(cluster);
	const configurations = findRivetMcpConfigurations(projectRoot);
	// The home directory says which agents the machine has, not which one this project uses.
	const projectDirectories = withParents(projectRoot).filter((directory) => !isWithin(directory, home));
	return {
		...(pinned === undefined ? {} : { cluster: pinned }),
		agents: agents.map((agent): RivetMcpAgentStatus => {
			const cli = findOnPath(agent.cli);
			const usedInProject = projectDirectories.some((directory) =>
				agent.projectMarkers.some((marker) => existsSync(join(directory, marker))),
			);
			return {
				...(cli === undefined ? {} : { cli }),
				configuredIn: configurations.flatMap(({ agent: id, ...configuration }) => (id === agent.id ? [configuration] : [])),
				detected: usedInProject || cli !== undefined || agent.homeMarkers(home).some((marker) => existsSync(marker)),
				id: agent.id,
				name: agent.name,
				usedInProject,
			};
		}),
		url: pinnedUrl(pinned),
	};
}

// How to add the server to an agent: a command, or a file and the configuration to add to it. A
// command quotes the URL, because a shell expands the `?` of a pinned URL.
type Install = { command: string } | { file: string; config: unknown };

// Every client that the Rivet MCP supports, with its own setup steps.
const rivetMcpDocsUrl = "https://rivet.dev/docs/mcp/";

const installs: Record<AgentId, (url: string) => Install> = {
	"claude-code": (url) => ({ command: `claude mcp add --transport http rivet "${url}"` }),
	codex: (url) => ({ command: `codex mcp add rivet --url "${url}"` }),
	cursor: (url) => ({ file: ".cursor/mcp.json", config: { mcpServers: { rivet: { url } } } }),
	vscode: (url) => ({ command: `code --add-mcp '${JSON.stringify({ name: "rivet", type: "http", url })}'` }),
};

function reportJson(report: RivetMcpReport): Record<string, unknown> {
	return {
		type: "mcp",
		url: report.url,
		...(report.cluster === undefined ? {} : { cluster: report.cluster }),
		configured: report.agents.some((agent) => agent.configuredIn.length > 0),
		agents: report.agents.map((agent) => ({
			id: agent.id,
			name: agent.name,
			configured: agent.configuredIn.length > 0,
			configuredIn: agent.configuredIn,
			detected: agent.detected,
			...(agent.cli === undefined ? {} : { cli: agent.cli }),
			install: installs[agent.id](report.url),
		})),
	};
}

// The human output fits a terminal this wide.
const outputWidth = 100;

// `command` split at the spaces outside quotes into lines that fit `width`, each but the last
// ending in ` \`, so that a shell still reads one command. A long quoted word stays whole.
function commandLines(command: string, width: number): string[] {
	if (command.length <= width) return [command];
	const lines: string[] = [];
	let current = "";
	for (const word of command.match(/(?:'[^']*'|"[^"]*"|\S)+/g) ?? [command]) {
		// Room for the ` \` and the indent of the next lines.
		if (current !== "" && current.length + word.length + 3 > width - (lines.length === 0 ? 0 : 2)) {
			lines.push(current);
			current = word;
		} else {
			current = current === "" ? word : `${current} ${word}`;
		}
	}
	return [...lines, current].map((line, index, all) => `${index === 0 ? "" : "  "}${line}${index < all.length - 1 ? " \\" : ""}`);
}

// What to run, or what to add, to connect `agent`. A command is alone on its lines, so it copies
// cleanly.
function installLines(theme: Theme, agent: RivetMcpAgentStatus, url: string): string[] {
	const install = installs[agent.id](url);
	const indent = "  ";
	const strong = (text: string): string => `${indent}${theme.bold(theme.fg("white", text))}`;
	if ("command" in install) return commandLines(install.command, outputWidth - indent.length).map(strong);
	return [`${indent}${theme.fg("muted", `Add a server named rivet with this URL to ${install.file}:`)}`, strong(url)];
}

function listNames(names: readonly string[]): string {
	return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

// The agent to suggest when no agent has the server: one used in this project, then one whose CLI
// is on PATH, then one with a folder in the home directory, then Claude Code.
function likelyAgent(report: RivetMcpReport): RivetMcpAgentStatus {
	const rank = (agent: RivetMcpAgentStatus): number => (agent.usedInProject ? 3 : agent.cli !== undefined ? 2 : agent.detected ? 1 : 0);
	const [first, ...rest] = report.agents;
	if (first === undefined) throw new Error("orange mcp knows no coding agent");
	return rest.reduce((best, agent) => (rank(agent) > rank(best) ? agent : best), first);
}

export function renderMcpReport(theme: Theme, report: RivetMcpReport): string {
	const done = theme.fg("green", "✓");
	const todo = theme.fg("yellow", "!");
	const headline = (text: string): string => theme.bold(theme.fg("white", text));
	const configured = report.agents.filter((agent) => agent.configuredIn.length > 0);
	if (configured.length === 0) {
		const agent = likelyAgent(report);
		const others = `${agent.detected ? "" : "No coding agent found. "}Other agents: orange mcp --json ·`;
		return [
			`${todo} ${headline(`Rivet MCP is not set up. Connect ${agent.name}:`)}`,
			...installLines(theme, agent, report.url),
			"",
			`  ${theme.fg("subtle", others)} ${theme.hyperlink("docs ↗", rivetMcpDocsUrl)}`,
		].join("\n");
	}
	const clusters = [...new Set(configured.flatMap((agent) => agent.configuredIn.flatMap((file) => file.cluster ?? [])))];
	const pin = clusters.length === 0 ? "" : theme.fg("subtle", ` · cluster ${clusters.join(", ")}`);
	const lines = [`${done} ${headline(`Rivet MCP is set up for ${listNames(configured.map((agent) => agent.name))}`)}${pin}`];
	for (const agent of report.agents.filter((candidate) => candidate.detected && candidate.configuredIn.length === 0)) {
		lines.push(`${todo} ${theme.fg("white", `Not set up for ${agent.name}:`)}`, ...installLines(theme, agent, report.url));
	}
	return lines.join("\n");
}

export function renderMcpHelp(theme: Theme): string {
	const option = (flags: string, description: string): string => `  ${theme.fg("orange", flags.padEnd(24))}${description}`;
	const note = (text: string): string => theme.dim(`  ${text}`);
	return [
		theme.bold("open-orange mcp"),
		"",
		"Show whether your coding agent has the Rivet MCP, which gives the agent Rivet's tools and docs.",
		"If it does not, print the command that connects it. Orange does not change your agent's",
		"configuration and does not run your agent.",
		`\n${theme.bold("Options")}`,
		option("--cluster <name>", "Pin the tools to this cluster"),
		option("--json", "Print one JSON object with each agent's status and install command"),
		`\n${theme.bold("Cluster")}`,
		note("The install command pins the tools to one cluster: --cluster, then RIVET_CLUSTER, then the"),
		note("cluster that orange link saved. With none of these, the URL pins no cluster."),
		`\n${theme.bold("Agents")}`,
		note("Claude Code, Codex, Cursor, and VS Code. Orange reads their MCP files in this project, its"),
		note("parent folders, and your home directory. An agent is detected when its CLI (claude, codex,"),
		note("cursor, code) is on PATH or its folder is in this project or your home directory."),
		note("When no agent has the Rivet MCP, Orange prints the command for one agent: the one this"),
		note("project uses, else one on PATH. Otherwise it prints one for each detected agent that lacks it."),
		note("--json has the command for every agent."),
		`\n${theme.bold("JSON")}`,
		note('{"type":"mcp","url":"https://mcp.rivet.dev/mcp?cluster=prod","cluster":"prod",'),
		note(' "configured":true,"agents":[{"id":"claude-code","name":"Claude Code","configured":true,'),
		note('  "configuredIn":[{"path":"~/.claude.json","cluster":"prod"}],"detected":true,'),
		note('  "cli":"/usr/local/bin/claude","install":{"command":"claude mcp add ..."}}, ...]}'),
		note("agents has each agent above. configuredIn lists the files that name the Rivet MCP. cli is the"),
		note("agent CLI on PATH, when there is one. install is a command, or a file and the config to add."),
		note('{"type":"failure","message":"...","hint":"..."}  for invalid arguments only'),
		`\n${theme.bold("Exit codes")}`,
		note("0 printed · 2 invalid arguments"),
	].join("\n");
}

export interface McpCommandIo {
	error(message: string): void;
	log(message: string): void;
}

export function runMcpCommand(args: readonly string[], io: McpCommandIo): number {
	const json = args.includes("--json");
	let values: { cluster?: string; json?: boolean };
	try {
		({ values } = parseArgs({
			args: [...args],
			options: { cluster: { type: "string" }, json: { type: "boolean" } },
			strict: true,
		}));
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) io.log(JSON.stringify({ hint: "Run orange mcp --help.", message, type: "failure" }));
		else io.error(`${message}. Run \`orange mcp --help\`.`);
		return 2;
	}
	const report = rivetMcpReport(process.cwd(), values.cluster);
	io.log(json ? JSON.stringify(reportJson(report)) : renderMcpReport(createTheme(process.stdout), report));
	return 0;
}
