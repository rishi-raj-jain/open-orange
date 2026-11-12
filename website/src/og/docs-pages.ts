// Every docs page that gets its own Open Graph card: all sidebar links, so a
// new doc gets a card without changes here.
import { docsNav, flattenNav, TITLES } from '@/components/docs/nav';
import { DOCS_PAGES } from '@/data/docs-pages';

export type DocsPage = { path: string; title: string; description: string; section: string };

export async function docsPages(): Promise<DocsPage[]> {
	const { groups, entries } = await docsNav();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return flattenNav(groups).map((link) => {
		const entry = link.id ? byId.get(link.id) : undefined;
		const meta = entry ? { title: TITLES[entry.id] ?? entry.data.title, description: entry.data.description } : DOCS_PAGES[link.href];
		if (!meta) throw new Error(`No title and description for the docs page ${link.href}: add it to DOCS_PAGES in src/data/docs-pages.ts`);
		return { path: link.href, title: meta.title, description: meta.description, section: link.group };
	});
}
