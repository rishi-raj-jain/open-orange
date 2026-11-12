// Where OpenOrange runs, as shown under the home page title, on the Open
// Graph card, and at the top of the Deploy docs (DeployClouds.astro). Raw SVG
// markup from src/assets/migrator; each consumer sizes and colors it.
import aws from '@/assets/migrator/aws.svg?raw';
import gcp from '@/assets/migrator/gcp.svg?raw';
import azure from '@/assets/migrator/azure.svg?raw';
import rivet from '@/assets/migrator/rivet-white.svg?raw';
import server from '@/assets/migrator/server.svg?raw';

export type Cloud = {
	name: string;
	svg: string;
	/** Show the name next to the logo. */
	label: boolean;
	/** The color in the SVG that follows the text color, if any. */
	ink?: string;
};

export const CLOUDS: Cloud[] = [
	{ name: 'AWS', svg: aws, label: true, ink: '#252F3E' },
	{ name: 'Google Cloud', svg: gcp, label: true },
	{ name: 'Azure', svg: azure, label: true },
	{ name: 'Rivet Cloud', svg: rivet, label: true },
	{ name: 'Your servers', svg: server, label: true, ink: 'currentColor' },
];

/**
 * A cloud's logo as inline SVG markup that CSS sizes by height, with its ink
 * color following the text color, as in the home page hero.
 */
export function inlineLogo(cloud: Cloud): string {
	const svg = cloud.ink ? cloud.svg.replaceAll(cloud.ink, 'currentColor') : cloud.svg;
	return svg.replace(/<!--.*?-->/gs, '').replace(/<svg([^>]*)>/, (_, attrs: string) => {
		const size = (name: string) => attrs.match(new RegExp(`\\s${name}="([\\d.]+)"`))?.[1];
		const viewBox = /viewBox=/.test(attrs) ? '' : ` viewBox="0 0 ${size('width')} ${size('height')}"`;
		return `<svg${attrs.replace(/\s(width|height|class)="[^"]*"/g, '')}${viewBox} class="h-full w-auto" aria-hidden="true">`;
	});
}
