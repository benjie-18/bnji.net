/**
 * BNJI.NET — service registry (placeholder content).
 *
 * The registry is what the "network" panel renders, and it is the only place
 * that needs updating when a service goes live.
 *
 * Content policy: neutral placeholder entries only. Never list real private
 * hostnames, internal IPs or personal infrastructure here.
 */

export type ServiceVisibility = 'live' | 'soon' | 'private';

export const SERVICE_VISIBILITY_LABEL: Record<ServiceVisibility, string> = {
	live: 'live',
	soon: 'soon',
	private: 'access only',
};

export type ServiceEndpoint = {
	/** Hostname, rendered in mono type. */
	host: string;
	label: string;
	description: string;
	visibility: ServiceVisibility;
	/** Only set for public, live services. */
	href?: string;
};

export const SERVICES: ServiceEndpoint[] = [
	{
		host: 'bnji.net',
		label: 'This site',
		description: 'Astro prerendered and served by a Cloudflare Worker.',
		visibility: 'live',
		href: 'https://bnji.net/',
	},
	{
		host: 'lorem.bnji.net',
		label: 'Lorem service',
		description: 'Ipsum dolor sit amet, consectetur adipiscing elit sed do.',
		visibility: 'soon',
	},
	{
		host: 'ipsum.bnji.net',
		label: 'Ipsum service',
		description: 'Eiusmod tempor incididunt ut labore et dolore magna aliqua.',
		visibility: 'soon',
	},
	{
		host: 'dolor.internal',
		label: 'Placeholder private',
		description: 'Sit amet consectetur adipiscing elit — listed, never linked.',
		visibility: 'private',
	},
];
