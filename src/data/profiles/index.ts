/**
 * BNJI.NET — profile registry.
 *
 * All profiles live here. To add a new profile, create a data file in
 * src/data/profiles/<slug>.ts following the ProfileData type, then import
 * it and add it to the PROFILES array below. The rendering component,
 * API endpoints and route are fully generic — only this file needs
 * updating.
 */
import type { ProfileData } from './types';
import { gizlyyProfile } from './gizlyy';

export type { ProfileData, ProfileLink, ProfileCopyBlock, ProfileBadge, ProfileCounter } from './types';

/** Every profile registered on the site. */
export const PROFILES: ProfileData[] = [
	gizlyyProfile,
];

/** Look up a profile by slug (URL path). */
export function getProfileBySlug(slug: string): ProfileData | undefined {
	return PROFILES.find((p) => p.slug === slug);
}

/** All profile slugs, for sitemap generation and route validation. */
export function allProfileSlugs(): string[] {
	return PROFILES.map((p) => p.slug);
}