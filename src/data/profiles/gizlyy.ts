/**
 * BNJI.NET — gizlyy profile data.
 *
 * Content migrated from https://ayo.so/gizlyy (the owner's Ayo profile).
 * This file is the single source of truth for the gizlyy profile page.
 * To modify the page, edit the values here — no component changes needed.
 *
 * The view pill on this page is live — see the `viewCount` note further down
 * for why the old Ayo counter value is no longer stored here.
 */
import type { ProfileData } from './types';

export const gizlyyProfile: ProfileData = {
	slug: 'gizlyy',
	displayName: 'gizlyy',
	avatar: '/profiles/gizlyy/avatar.webp',
	avatarAlt: 'gizlyy avatar',
	bio: 'haii i play games and stuff :3',
	lovesLabel: 'Love :',
	loves: [
		'Cyberpunk',
		'Titanfall 2',
		'Hytale',
		'Elden ring',
		'RDR 2',
		'Splitgate: Arena Reloaded',
		'No Man\'s Sky',
		'Celeste',
		'The Finals',
		'Slime Rancher',
	],

	// The old `counter: { emoji: '🔥', value: 1950, note: 'from Ayo' }` block
	// was a hand-maintained copy of a number carried over from Ayo. It could
	// not update, and the figure it showed was never this site's count. The
	// pill in ProfilePage.astro now renders the live view total from the
	// profile store, so there is nothing left here to keep in sync.
	//
	// A profile without a `counter` field simply renders no pill, so adding
	// one back is a data edit and needs no component change.

	extras: [
		'I LOVE MUSICCC',
		'like uh R&B and stuff',
		'guitarist (never)',
	],

	identities: [
		'18',
		'FR/EN (qc)',
		'love you <3',
	],

	links: [
		{
			id: 'reddit',
			label: 'Reddit',
			href: 'https://reddit.com/u/gizlyyy',
			icon: 'reddit',
			handle: 'u/gizlyyy',
			external: true,
		},
		{
			id: 'steam',
			label: 'Steam',
			href: 'https://steamcommunity.com/id/gizlyy',
			icon: 'steam',
			handle: 'gizlyy',
			external: true,
		},
		{
			id: 'twitch',
			label: 'Twitch',
			href: 'https://twitch.tv/gizlyy',
			icon: 'twitch',
			handle: 'gizlyy',
			external: true,
		},
		{
			id: 'github',
			label: 'GitHub',
			href: 'https://github.com/Gizly',
			icon: 'github',
			handle: 'Gizly',
			external: true,
		},
	],

	copyBlocks: [
		{
			label: 'Discord',
			value: 'gizlyy',
			subLabel: 'bnji · gizlyy#0001',
		},
	],

	pageTitle: 'gizlyy',
	pageDescription: 'gizlyy — haii i play games and stuff :3',
};