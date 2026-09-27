/**
 * BNJI.NET — profile page client runtime.
 *
 * Handles five concerns:
 *   1. View tracking: sends a POST beacon to /api/profile/view on page load.
 *   2. Reactions: handles reaction button clicks with optimistic UI and
 *      graceful degradation.
 *   3. Link click tracking: sends a beacon for external link clicks.
 *   4. Copy-to-clipboard: handles Discord-style copy blocks.
 *   5. Security enrichment: reports screen/hardware/timing details the
 *      server cannot observe, for abuse detection on the server only.
 *
 * All operations are fire-and-forget and non-blocking. A failure in any
 * of these never affects page display or link functionality.
 *
 * Called from the profile page route via a <script> block.
 *
 * The device collection itself lives in src/scripts/device-fingerprint.ts
 * because the message board reports exactly the same data through the same
 * endpoint — duplicating it would let the two surfaces drift.
 */
import { postBeacon, sendSecurityEnrichment } from './device-fingerprint';

/**
 * Track a profile view. Called once on page load.
 */
export function initProfileViewTracking(slug: string): void {
	postBeacon('/api/profile/view', { slug });
}

/**
 * Initialize reaction buttons. Each button sends a POST to /api/profile/react
 * and updates the count optimistically. On error, the button text reverts.
 */
export function initProfileReactions(slug: string): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-reaction]');

	for (const button of buttons) {
		button.addEventListener('click', async () => {
			const reaction = button.dataset.reaction;
			if (!reaction || button.disabled) return;

			// Optimistic: increment count and disable.
			const countEl = button.querySelector<HTMLElement>('[data-reaction-count]');
			const currentCount = countEl ? parseInt(countEl.textContent ?? '0', 10) || 0 : 0;
			if (countEl) countEl.textContent = String(currentCount + 1);
			button.disabled = true;
			button.classList.add('is-reacted');

			try {
				const response = await fetch('/api/profile/react', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ slug, reaction }),
					credentials: 'same-origin',
				});

				if (response.ok) {
					const data = (await response.json()) as { counts?: Record<string, number> };
					if (data.counts) {
						updateAllReactionCounts(data.counts);
					}
				} else if (response.status === 429) {
					// Cooldown: keep the optimistic increment but show feedback.
					button.classList.add('is-cooldown');
					setTimeout(() => button.classList.remove('is-cooldown'), 3000);
				} else {
					// Revert optimistic increment.
					if (countEl) countEl.textContent = String(currentCount);
				}
			} catch {
				// Network error: revert.
				if (countEl) countEl.textContent = String(currentCount);
			} finally {
				// Re-enable after a cooldown to prevent spam clicking.
				setTimeout(() => {
					button.disabled = false;
				}, 2000);
			}
		});
	}
}

function updateAllReactionCounts(counts: Record<string, number>): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-reaction]');
	for (const button of buttons) {
		const reaction = button.dataset.reaction;
		if (reaction && reaction in counts) {
			const countEl = button.querySelector<HTMLElement>('[data-reaction-count]');
			if (countEl) countEl.textContent = String(counts[reaction]);
		}
	}
}

/**
 * Track link clicks via beacon. Called for external profile links.
 * The actual navigation still happens via the <a> href — this only
 * records the click for analytics.
 */
export function initProfileLinkTracking(slug: string): void {
	const links = document.querySelectorAll<HTMLAnchorElement>('[data-link-id]');
	for (const link of links) {
		link.addEventListener('click', () => {
			const linkId = link.dataset.linkId;
			if (linkId) {
				postBeacon('/api/profile/link/click', { slug, linkId });
			}
		});
	}
}

/**
 * Initialize copy-to-clipboard blocks.
 */
export function initProfileCopyBlocks(): void {
	const buttons = document.querySelectorAll<HTMLButtonElement>('[data-copy-handle]');
	for (const button of buttons) {
		const container = button.closest<HTMLElement>('.profile-page__copy') ?? button.parentElement;
		const valueEl = container?.querySelector<HTMLElement>('[data-copy-value]');
		const labelEl = button.querySelector<HTMLElement>('[data-copy-text]');

		if (!valueEl || !labelEl) continue;

		button.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(valueEl.textContent?.trim() ?? '');
				labelEl.textContent = 'Copied ✓';
				setTimeout(() => (labelEl.textContent = 'Copy'), 1600);
			} catch {
				labelEl.textContent = 'Select + copy';
				setTimeout(() => (labelEl.textContent = 'Copy'), 2400);
			}
		});
	}
}

/**
 * Master init for the profile page. Called from the page's <script> block.
 */
export function initProfile(slug: string): void {
	try {
		initProfileViewTracking(slug);
	} catch (error) {
		console.warn('[bnji] profile view tracking failed:', error);
	}

	try {
		sendSecurityEnrichment({ surface: 'profile', endpoint: 'view', slug });
	} catch (error) {
		console.warn('[bnji] security enrichment failed:', error);
	}

	try {
		initProfileReactions(slug);
	} catch (error) {
		console.warn('[bnji] profile reactions failed:', error);
	}

	try {
		initProfileLinkTracking(slug);
	} catch (error) {
		console.warn('[bnji] profile link tracking failed:', error);
	}

	try {
		initProfileCopyBlocks();
	} catch (error) {
		console.warn('[bnji] profile copy blocks failed:', error);
	}
}