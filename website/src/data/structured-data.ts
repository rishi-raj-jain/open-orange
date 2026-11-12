// schema.org data for search engines, rendered as JSON-LD by src/layouts/Base.astro.
import { SITE } from './site';
import { SITE_OG_IMAGE } from '../og/paths';

const ORIGIN = `https://${SITE.domain}`;

export const ORGANIZATION = {
	'@type': 'Organization',
	'@id': `${SITE.rivet}/#organization`,
	name: 'Rivet',
	legalName: 'Rivet Gaming, Inc.',
	url: SITE.rivet,
	sameAs: ['https://github.com/rivet-dev'],
};

export const WEBSITE = {
	'@type': 'WebSite',
	'@id': `${ORIGIN}/#website`,
	name: SITE.name,
	url: `${ORIGIN}/`,
	publisher: { '@id': ORGANIZATION['@id'] },
};

export const SOFTWARE = {
	'@type': 'SoftwareApplication',
	'@id': `${ORIGIN}/#software`,
	name: SITE.name,
	description: SITE.description,
	url: `${ORIGIN}/`,
	image: `${ORIGIN}${SITE_OG_IMAGE}`,
	applicationCategory: 'DeveloperApplication',
	softwareRequirements: 'Node.js 22 or later',
	license: 'https://www.apache.org/licenses/LICENSE-2.0',
	isAccessibleForFree: true,
	offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
	publisher: { '@id': ORGANIZATION['@id'] },
	sameAs: [SITE.github],
};

/** A BreadcrumbList from the site root down to the current page, given as site paths. */
export const breadcrumbs = (trail: { name: string; path: string }[]) => ({
	'@type': 'BreadcrumbList',
	itemListElement: trail.map((crumb, i) => ({
		'@type': 'ListItem',
		position: i + 1,
		name: crumb.name,
		item: new URL(crumb.path, ORIGIN).href,
	})),
});
