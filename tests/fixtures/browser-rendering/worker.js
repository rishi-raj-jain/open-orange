import puppeteer from "@cloudflare/puppeteer";

// Opens the page in `?url=` with @cloudflare/puppeteer, reads it, and closes the browser.
// `?devtools` opens a session's DevTools WebSocket directly and returns what the binding answered.
export default {
	async fetch(request, env) {
		const requested = new URL(request.url);
		if (requested.searchParams.has("devtools")) {
			const { sessionId } = await (await env.BROWSER.fetch("https://browser/v1/devtools/browser", { method: "POST" })).json();
			const response = await env.BROWSER.fetch(`https://browser/v1/devtools/browser/${sessionId}`, { headers: { upgrade: "websocket" } });
			response.webSocket?.accept();
			response.webSocket?.close(1000, "done");
			return Response.json({ status: response.status, body: response.webSocket ? "" : await response.text() });
		}
		const target = requested.searchParams.get("url");
		try {
			const browser = await puppeteer.launch(env.BROWSER);
			const page = await browser.newPage();
			await page.goto(target);
			const result = { heading: await page.$eval("h1", (element) => element.textContent), title: await page.title() };
			await browser.close();
			result.sessionsAfterClose = (await puppeteer.sessions(env.BROWSER)).length;
			return Response.json(result);
		} catch (error) {
			return new Response(String(error?.message ?? error), { status: 500 });
		}
	},
};
