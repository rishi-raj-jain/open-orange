import { connect, type Socket } from "../modules/cloudflare-sockets/socket.js";

// `env.HYPERDRIVE`. Orange has no Hyperdrive service, so the binding names the
// database itself, like `wrangler dev`. There is no pooling or query cache.
export class Hyperdrive {
	readonly connectionString: string;
	readonly database: string;
	readonly host: string;
	readonly password: string;
	readonly port: number;
	readonly user: string;

	constructor(connectionString: string) {
		const fields = parseHyperdriveConnectionString(connectionString);
		this.connectionString = fields.connectionString;
		this.database = fields.database;
		this.host = fields.host;
		this.password = fields.password;
		this.port = fields.port;
		this.user = fields.user;
	}

	connect(): Socket {
		return connect({ hostname: this.host, port: this.port });
	}
}

export interface HyperdriveConnectionFields {
	connectionString: string;
	database: string;
	host: string;
	password: string;
	port: number;
	user: string;
}

function isPostgres(url: URL): boolean {
	return url.protocol === "postgresql:" || url.protocol === "postgres:";
}

// Miniflare's checks and field rules for a local Hyperdrive connection string.
// https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/plugins/hyperdrive/index.ts
export function parseHyperdriveConnectionString(
	connectionString: string,
): HyperdriveConnectionFields {
	let url: URL;
	try {
		url = new URL(connectionString);
	} catch {
		throw new TypeError("Invalid url");
	}
	const issues: string[] = [];
	if (!isPostgres(url) && url.protocol !== "mysql:") {
		issues.push("Only PostgreSQL-compatible or MySQL-compatible databases are currently supported.");
	}
	if (url.host === "") {
		issues.push(
			"You must provide a hostname or IP address in your connection string - e.g. 'user:password@database-hostname.example.com:5432/databasename",
		);
	}
	if (url.pathname === "") {
		issues.push("You must provide a database name as the path component - e.g. /postgres");
	}
	if (url.username === "") {
		issues.push(
			"You must provide a username - e.g. 'user:password@database.example.com:port/databasename'",
		);
	}
	if (url.password === "") {
		issues.push(
			"You must provide a password - e.g. 'user:password@database.example.com:port/databasename'",
		);
	}
	if (issues.length > 0) throw new TypeError(issues.join(" "));
	const defaultPort = isPostgres(url) ? 5432 : 3306;
	return {
		connectionString: url.href,
		database: decodeURIComponent(url.pathname.replace("/", "")),
		host: url.hostname,
		password: decodeURIComponent(url.password),
		port: url.port === "" ? defaultPort : Number.parseInt(url.port, 10),
		user: decodeURIComponent(url.username),
	};
}
