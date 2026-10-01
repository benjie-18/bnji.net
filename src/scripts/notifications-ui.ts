/**
 * BNJI.NET — chat plan Phase E: in-app notification badge (plan §8.3).
 *
 * Polls GET /api/notifications (~60 s while a page is visible) and fills the
 * header badge [data-notif-badge]: unread DMs + pending friend requests, one
 * number, in-app only — push/email are deferred by the plan. Guests and
 * failures simply keep the badge hidden; nothing here ever claims a
 * capability the API did not report.
 */
import { FRIENDS_CONFIG } from '../config/friends.config';

let started = false;

export function initNotificationsBadge(): void {
	if (started) return;
	const badge = document.querySelector<HTMLAnchorElement>('[data-notif-badge]');
	if (!badge) return;
	started = true;

	const poll = async (): Promise<void> => {
		if (document.hidden) return;
		try {
			const response = await fetch('/api/notifications', {
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			});
			if (!response.ok) { badge.hidden = true; return; }
			const data = await response.json() as { unreadMessages?: unknown; pendingFriendRequests?: unknown };
			const unread = Number(data.unreadMessages ?? 0) || 0;
			const pending = Number(data.pendingFriendRequests ?? 0) || 0;
			const total = unread + pending;
			badge.hidden = total <= 0;
			if (total > 0) {
				const count = badge.querySelector<HTMLElement>('[data-notif-count]');
				if (count) count.textContent = total > 99 ? '99+' : String(total);
				badge.href = pending > 0 ? '/friends/' : '/messages/';
				const parts: string[] = [];
				if (unread > 0) parts.push(`${unread} unread message${unread === 1 ? '' : 's'}`);
				if (pending > 0) parts.push(`${pending} pending friend request${pending === 1 ? '' : 's'}`);
				badge.setAttribute('aria-label', `Notifications: ${parts.join(', ')}`);
			}
		} catch {
			badge.hidden = true;
		}
	};

	void poll();
	window.setInterval(() => { void poll(); }, FRIENDS_CONFIG.notificationsPollMs);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
}
