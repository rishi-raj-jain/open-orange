interface HyperdriveFields {
	connectionString: string;
	database: string;
	host: string;
	password: string;
	port: number;
	user: string;
}

function fields(binding: HyperdriveFields): HyperdriveFields {
	const { connectionString, database, host, password, port, user } = binding;
	return { connectionString, database, host, password, port, user };
}

export default {
	fetch(request: Request, env: Record<string, HyperdriveFields>): Response {
		const name = new URL(request.url).searchParams.get("binding") ?? "HYPERDRIVE";
		return Response.json(fields(env[name]!));
	},
};
