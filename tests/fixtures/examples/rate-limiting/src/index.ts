interface Env {
	// 10 requests per 10 seconds for each client IP address.
	IP_LIMITER: RateLimit;
	// 5 requests per 60 seconds for each user. Callers on the pro plan get more.
	USER_LIMITER: RateLimit;
	// 3 attempts per 60 seconds for each account. LOGIN_LIMITER and RESET_LIMITER
	// use the same namespace_id, so they share one counter for the same key.
	LOGIN_LIMITER: RateLimit;
	RESET_LIMITER: RateLimit;
}

// Cloudflare also reads `limit` and `period` per call. Its public types only
// list `key`, so this type adds the overrides.
type LimitOptions = { key: string; limit?: number; period?: number };

function limit(binding: RateLimit, options: LimitOptions): Promise<RateLimitOutcome> {
	return binding.limit(options as RateLimitOptions);
}

const proPlanLimit = 20;
const passwords: Readonly<Record<string, string>> = { ada: "hunter2", bob: "correct-horse" };

// Windows start on wall-clock multiples of the period, so the current window
// ends at the next multiple. Cloudflare does not promise this alignment, so
// treat the value as a hint.
function tooManyRequests(message: string, period: number): Response {
	const retryAfter = period - (Math.floor(Date.now() / 1000) % period);
	return Response.json(
		{ error: message, retryAfter },
		{ headers: { "retry-after": String(retryAfter) }, status: 429 },
	);
}

function clientIp(request: Request): string {
	// Cloudflare sets this header. Locally, send it yourself to act as another client.
	return request.headers.get("cf-connecting-ip") ?? "127.0.0.1";
}

async function readUsername(request: Request): Promise<string | undefined> {
	const body: unknown = await request.json().catch(() => undefined);
	const username = typeof body === "object" && body !== null ? Reflect.get(body, "username") : undefined;
	return typeof username === "string" && username !== "" ? username : undefined;
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
	const user = url.searchParams.get("user");
	if (user === null) {
		return Response.json({ error: "Add ?user=<name>" }, { status: 400 });
	}
	// The per-call override: pro users get a higher limit from the same binding.
	const plan = url.searchParams.get("plan") === "pro" ? "pro" : "free";
	const options: LimitOptions = plan === "pro" ? { key: `user:${user}`, limit: proPlanLimit } : { key: `user:${user}` };
	if (!(await limit(env.USER_LIMITER, options)).success) {
		return tooManyRequests(`Too many requests for user ${user}`, 60);
	}
	return Response.json({ plan, user });
}

async function login(request: Request, env: Env): Promise<Response> {
	const body: unknown = await request.json().catch(() => undefined);
	const username = typeof body === "object" && body !== null ? Reflect.get(body, "username") : undefined;
	const password = typeof body === "object" && body !== null ? Reflect.get(body, "password") : undefined;
	if (typeof username !== "string" || typeof password !== "string") {
		return Response.json({ error: 'Send JSON like {"username":"ada","password":"..."}' }, { status: 400 });
	}
	// Count every attempt, right or wrong, so a guesser cannot learn which one
	// was right after the limit.
	if (!(await limit(env.LOGIN_LIMITER, { key: `account:${username}` })).success) {
		return tooManyRequests(`Too many attempts for ${username}`, 60);
	}
	if (passwords[username] !== password) {
		return Response.json({ error: "Wrong username or password" }, { status: 401 });
	}
	return Response.json({ loggedIn: username });
}

async function passwordReset(request: Request, env: Env): Promise<Response> {
	const username = await readUsername(request);
	if (username === undefined) {
		return Response.json({ error: 'Send JSON like {"username":"ada"}' }, { status: 400 });
	}
	// Same namespace_id and key as LOGIN_LIMITER: resets use the login budget.
	if (!(await limit(env.RESET_LIMITER, { key: `account:${username}` })).success) {
		return tooManyRequests(`Too many attempts for ${username}`, 60);
	}
	return Response.json({ resetSent: username }, { status: 202 });
}

// Calls a binding with any key, limit, and period. Invalid options throw, as
// on Cloudflare: only 10 and 60 second periods exist.
async function probe(env: Env, url: URL): Promise<Response> {
	const options: LimitOptions = { key: url.searchParams.get("key") ?? "probe" };
	const limitParam = url.searchParams.get("limit");
	const periodParam = url.searchParams.get("period");
	if (limitParam !== null) options.limit = Number(limitParam);
	if (periodParam !== null) options.period = Number(periodParam);
	try {
		return Response.json(await limit(env.USER_LIMITER, options));
	} catch (error: unknown) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		// Every route first passes the per-IP limit, a short 10 second window.
		const ip = clientIp(request);
		if (!(await limit(env.IP_LIMITER, { key: ip })).success) {
			return tooManyRequests(`Too many requests from ${ip}`, 10);
		}

		if (request.method === "GET" && url.pathname === "/api/me") return await api(request, env, url);
		if (request.method === "POST" && url.pathname === "/login") return await login(request, env);
		if (request.method === "POST" && url.pathname === "/password-reset") {
			return await passwordReset(request, env);
		}
		if (request.method === "GET" && url.pathname === "/probe") return await probe(env, url);
		return Response.json(
			{ error: "Try GET /api/me, POST /login, POST /password-reset, or GET /probe" },
			{ status: 404 },
		);
	},
} satisfies ExportedHandler<Env>;
