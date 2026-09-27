/**
 * BNJI.NET — profile data types.
 *
 * A profile is a public personal/social page at /<slug>/. Content lives
 * entirely in data — the rendering component never hardcodes usernames,
 * links or copy. Another profile can be added later by creating a new
 * data entry of type ProfileData without touching any component code.
 *
 * Every field that could reasonably vary between profiles is included here;
 * the rendering component reads from this type and ignores anything absent.
 */

/** A single link in the profile's link section. */
export type ProfileLink = {
	/** Stable identifier for analytics tracking (e.g. 'reddit', 'steam'). */
	id: string;
	/** Visible label on the link button. */
	label: string;
	/** Full destination URL. */
	href: string;
	/** Icon name from Icon.astro (must be registered there). */
	icon?: string;
	/** Optional trailing handle or note (e.g. '@gizlyyy'). */
	handle?: string;
	/** Whether this is an external link (adds noopener). */
	external?: boolean;
};

/** A copy-to-clipboard block (e.g. Discord, email). */
export type ProfileCopyBlock = {
	/** Section label (e.g. "Discord"). */
	label: string;
	/** The value to display and copy. */
	value: string;
	/** Optional sub-label or extra text. */
	subLabel?: string;
};

/** Badge chip displayed near the top of the profile. */
export type ProfileBadge = {
	emoji?: string;
	text: string;
};

/** A counter to display as historical/source information. */
export type ProfileCounter = {
	emoji: string;
	value: string | number;
	note?: string;
};

/** The complete data for one profile page. */
export type ProfileData = {
	/** URL slug (e.g. 'gizlyy'). Also the route path. */
	slug: string;
	/** Display name shown as the main heading. */
	displayName: string;
	/** Avatar image path (root-relative, e.g. '/profiles/gizlyy/avatar.png'). */
	avatar: string;
	/** Alt text for the avatar image. */
	avatarAlt: string;
	/** Short bio paragraph. */
	bio: string;
	/** "Loves" / interests list (displayed as chips). */
	loves: string[];
	/** Optional label above the loves list. */
	lovesLabel?: string;

	/** Badges shown below the display name. */
	badges?: ProfileBadge[];
	/** Historical counter (e.g. Ayo fire counter). */
	counter?: ProfileCounter;

	/** Additional identity/metadata lines (e.g. age, language). */
	identities?: string[];
	/** Free-form extra text lines. */
	extras?: string[];

	/** Social/link buttons. */
	links: ProfileLink[];
	/** Copy-to-clipboard blocks (e.g. Discord). */
	copyBlocks?: ProfileCopyBlock[];

	/** SEO page title. */
	pageTitle: string;
	/** SEO page description. */
	pageDescription: string;
};