import puppeteer from "@cloudflare/puppeteer";

// Drives the configured browser with @cloudflare/puppeteer. The browser loads /page from this
// same Worker, so the probe needs no other server. Errors come back as the response text.
export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "";
		if (url.pathname === "/page") {
			return new Response(`<!doctype html><title>page ${name}</title><h1>${name}</h1>`, { headers: { "content-type": "text/html" } });
		}
		try {
			if (url.pathname === "/read") {
				const browser = await puppeteer.launch(env.BROWSER);
				const page = await browser.newPage();
				await page.goto(`${url.origin}/page?name=${encodeURIComponent(name)}`);
				const heading = await page.$eval("h1", (element: any) => element.textContent);
				const title = await page.title();
				const png = (await page.screenshot()) as Uint8Array;
				await browser.close();
				const sessions = (await puppeteer.sessions(env.BROWSER)).length;
				return Response.json({ heading, title, pngSignature: [...png.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join(""), sessions });
			}
			if (url.pathname === "/join-busy") {
				const browser = await puppeteer.launch(env.BROWSER);
				try {
					await puppeteer.connect(env.BROWSER, browser.sessionId());
					return Response.json({ joined: true });
				} catch (error) {
					return Response.json({ joined: false, error: error instanceof Error ? error.message : String(error) });
				} finally {
					await browser.close();
				}
			}
		} catch (error) {
			return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
		}
		return new Response("not found", { status: 404 });
	},
};
