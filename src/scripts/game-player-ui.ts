import { applyLegacyLocalProgress, captureLegacyLocalProgress, chooseCloudVersion, chooseLocalVersion, listLocalSaves, setSaveAccountAvailable, syncPlayerSaves, type GameSave } from './game-saves';
import { NAMES_CONFIG } from '../config/names.config';

const GAME_TITLES: Record<string, string> = {
	'bnji.glass-minesweeper': 'Minesweeper', 'bnji.memory-pairs': 'Memory Pairs', 'bnji.bubble-pop': 'Bubble Pop',
	'bnji.reaction-timer': 'Reaction Timer', 'bnji.isometric-stack': 'Isometric Stack',
};

type AccountState = { authenticated: boolean; displayName?: string; saveCount?: number; handle?: string | null };

function $(selector: string, root: HTMLElement): HTMLElement | null { return root.querySelector<HTMLElement>(selector); }
function say(element: HTMLElement | null, message: string): void { if (element) element.textContent = message; }
function button(label: string, action: () => void | Promise<void>, className = 'player-tools__button'): HTMLButtonElement {
	const control = document.createElement('button');
	control.type = 'button';
	control.className = className;
	control.textContent = label;
	control.addEventListener('click', () => { void action(); });
	return control;
}
async function postAccount(body: Record<string, unknown>, method = 'POST'): Promise<{ response: Response; data: Record<string, unknown> }> {
	const response = await fetch('/api/games/account', {
		method, credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
	});
	let data: Record<string, unknown> = {};
	try { data = await response.json() as Record<string, unknown>; } catch { /* status message below */ }
	return { response, data };
}
function setBusy(form: HTMLFormElement, busy: boolean): void {
	for (const control of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) control.disabled = busy;
}

export async function mountPlayerTools(root: HTMLElement): Promise<void> {
	const live = $('[data-player-live]', root);
	const guestPanel = $('[data-player-guest]', root);
	const accountPanel = $('[data-player-account]', root);
	const codePanel = $('[data-recovery-panel]', root);
	const savesPanel = $('[data-player-saves]', root);
	const savesList = $('[data-save-list]', root);
	let account: AccountState = { authenticated: false };
	let recovering = false;

	async function renderSaves(): Promise<void> {
		if (!savesList) return;
		const saves = await listLocalSaves().catch(() => []);
		savesList.replaceChildren();
		if (!saves.length) {
			const empty = document.createElement('p');
			empty.className = 'player-tools__empty';
			empty.textContent = 'No local save snapshots yet. Your existing Lab bests are copied here when available; local progress stays on this device unless you sign in and sync.';
			savesList.appendChild(empty);
			return;
		}
		for (const save of saves) {
			const item = document.createElement('article');
			item.className = 'player-tools__save';
			const details = document.createElement('div');
			const title = document.createElement('strong');
			title.textContent = GAME_TITLES[save.gameId] ?? save.gameId;
			const meta = document.createElement('p');
			meta.textContent = `${save.slotId} · schema ${save.schemaVersion} · ${save.revision === null ? 'not synced' : `cloud revision ${save.revision}`}`;
			details.appendChild(title); details.appendChild(meta);
			const state = document.createElement('span');
			state.className = save.conflict ? 'player-tools__state player-tools__state--conflict' : save.dirty ? 'player-tools__state' : 'player-tools__state player-tools__state--saved';
			state.textContent = save.conflict ? 'Needs a choice' : save.dirty ? 'Local / pending' : 'Synced';
			item.appendChild(details); item.appendChild(state);
			if (save.conflict) {
				const choices = document.createElement('div');
				choices.className = 'player-tools__choices';
				choices.appendChild(button(save.conflict.deleted ? 'Accept cloud deletion' : 'Use cloud version', async () => {
					await chooseCloudVersion(save.gameId, save.slotId);
					await renderSaves();
					say(live, save.conflict?.deleted ? 'Cloud deletion accepted. The local snapshot was removed.' : 'Cloud version selected.');
				}, 'player-tools__button player-tools__button--small'));
				choices.appendChild(button(save.conflict.deleted ? 'Restore this device version' : 'Keep this device version', async () => {
					const result = await chooseLocalVersion(save.gameId, save.slotId);
					await renderSaves();
					say(live, result === 'saved' ? 'This device version was synced.' : result === 'conflict' ? 'The cloud changed again. Review the conflict and choose again.' : 'Could not sync this version; it remains on this device.');
				}, 'player-tools__button player-tools__button--small'));
				item.appendChild(choices);
			}
			savesList.appendChild(item);
		}
	}

	function showRecoveryCode(code: string): void {
		if (!codePanel) return;
		const output = $('[data-recovery-code]', codePanel);
		if (output) output.textContent = code;
		codePanel.hidden = false;
		recovering = true;
		const copy = $('[data-copy-recovery]', codePanel) as HTMLButtonElement | null;
		const download = $('[data-download-recovery]', codePanel) as HTMLButtonElement | null;
		copy?.addEventListener('click', async () => {
			try { await navigator.clipboard.writeText(code); say(live, 'Recovery code copied. Store it somewhere private.'); }
			catch { say(live, 'Copy was blocked. Select and copy the code manually.'); }
		}, { once: true });
		download?.addEventListener('click', () => {
			const blob = new Blob([`BNJI.NET game account recovery code\n\n${code}\n\nKeep this code private. Anyone with it can sign in. Rotate it from a signed-in device if it is exposed.\n`], { type: 'text/plain' });
			const href = URL.createObjectURL(blob);
			const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'bnji-game-recovery-code.txt'; anchor.click(); URL.revokeObjectURL(href);
		}, { once: true });
	}

	async function loadStatus(): Promise<void> {
		try {
			const response = await fetch('/api/games/account', { credentials: 'same-origin', cache: 'no-store' });
			if (!response.ok) throw new Error('status_unavailable');
			account = await response.json() as AccountState;
		} catch {
			account = { authenticated: false };
			say(live, 'Account status is unavailable. Guest play and local progress still work.');
		}
		if (guestPanel) guestPanel.hidden = account.authenticated;
		if (accountPanel) accountPanel.hidden = !account.authenticated;
		if (savesPanel) savesPanel.hidden = false;
		setSaveAccountAvailable(account.authenticated);
		const greeting = $('[data-player-greeting]', root);
		if (greeting) greeting.textContent = account.authenticated ? `Signed in as ${account.displayName ?? 'player'}. Save blobs are private to this account.` : 'You are playing as a guest. No account or network save is required.';
		const handleStatus = $('[data-handle-status]', root);
		if (handleStatus) handleStatus.textContent = account.authenticated
			? (account.handle ? `Current handle: @${account.handle}.` : 'No handle yet — claim one above.')
			: '';
	}

	const handleForm = $('[data-player-handle]', root) as HTMLFormElement | null;
	handleForm?.addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!account.authenticated || !handleForm) return;
		// Read the form before setBusy disables its controls (FormData skips disabled fields).
		const handle = String(new FormData(handleForm).get('handle') ?? '').trim().toLowerCase();
		const handleStatus = $('[data-handle-status]', root);
		setBusy(handleForm, true);
		try {
			const { response, data } = await postAccount({ action: 'set-handle', handle });
			if (!response.ok) {
				say(handleStatus, data.error === 'handle_taken' ? 'That handle is taken. Try another.'
					: data.error === 'handle_cooldown' ? `Handles change once every ${NAMES_CONFIG.handle.changeCooldownDays} days. Try again in ${Math.max(1, Math.ceil(Number(data.retryAfter ?? 0) / 86_400))} days.`
					: data.error === 'invalid_handle' ? `Handles are ${NAMES_CONFIG.handle.minLength}–${NAMES_CONFIG.handle.maxLength} characters: lowercase letters, numbers, and underscores.`
					: data.error === 'rate_limited' ? `Too many attempts. Try again in ${Math.ceil(Number(data.retryAfter ?? 60) / 60)} minutes.`
					: 'Could not save the handle. Try again when online.');
				return;
			}
			account.handle = typeof data.handle === 'string' ? data.handle : null;
			say(handleStatus, `Handle saved: @${String(account.handle ?? handle)}.`);
		} catch { say(handleStatus, 'Could not reach the account service. Try again when online.'); }
		finally { setBusy(handleForm, false); }
	});

	for (const selector of ['[data-player-create]', '[data-player-login]']) {
		const form = $(selector, root) as HTMLFormElement | null;
		form?.addEventListener('submit', async (event) => {
			event.preventDefault();
			if (recovering) return;
			// Read the form before setBusy disables its controls: disabled controls are
			// excluded from FormData, which previously sent displayName/recoveryCode as null.
			const formData = new FormData(form);
			const body = selector === '[data-player-create]'
				? { action: 'create', displayName: formData.get('displayName') }
				: { action: 'login', recoveryCode: formData.get('recoveryCode') };
			setBusy(form, true);
			try {
				await captureLegacyLocalProgress();
				const { response, data } = await postAccount(body);
				if (!response.ok) {
					say(live, data.error === 'login_locked' ? `Too many sign-in attempts. Wait ${data.retryAfter ?? 'a while'} seconds and try again.` : data.error === 'invalid_recovery_code' ? 'That recovery code is not valid. Check the code and try again.' : 'Could not update the account. Your local progress is still available.');
					return;
				}
				if (typeof data.recoveryCode === 'string') showRecoveryCode(data.recoveryCode);
				form.reset();
				await loadStatus();
				if (account.authenticated) {
					say(live, typeof data.recoveryCode === 'string' ? 'Account created. Save the one-time recovery code before closing this message.' : 'Signed in. Checking local and cloud save revisions.');
					const sync = await syncPlayerSaves();
					await renderSaves();
					if (!recovering) say(live, sync.error === 'sign_in_required' ? 'Sign-in expired. Local saves remain available.' : sync.conflicts ? `${sync.conflicts} save conflict needs your choice.` : sync.pending ? `${sync.pending} save(s) are still local and will retry when online.` : `${sync.uploaded} local save(s) synced. Cloud saves are now available on this device.`);
				}
			} catch {
				say(live, 'Could not reach the account service. Your progress remains on this device; try again when online.');
			} finally { setBusy(form, false); }
		});
	}

	$('[data-rotate-recovery]', root)?.addEventListener('click', async () => {
		if (!account.authenticated) return;
		if (!confirm('Create a new recovery code? The old code and every other device session will stop working.')) return;
		const { response, data } = await postAccount({ action: 'rotate-recovery-code' });
		if (!response.ok || typeof data.recoveryCode !== 'string') { say(live, 'Could not rotate the recovery code.'); return; }
		showRecoveryCode(data.recoveryCode);
		say(live, 'New recovery code created. The old code and other sessions are revoked.');
	});
	$('[data-player-signout]', root)?.addEventListener('click', async () => {
		const { response } = await postAccount({ action: 'sign-out' });
		if (!response.ok) { say(live, 'Could not sign out.'); return; }
		await loadStatus();
		say(live, 'Signed out. Local saves remain on this device.');
		await renderSaves();
	});
	$('[data-player-delete]', root)?.addEventListener('click', async () => {
		if (!confirm('Permanently delete this account, cloud saves, linked scores, and linked game-session records? Local browser saves will remain on this device. This cannot be undone.')) return;
		const { response, data } = await postAccount({ confirmation: 'DELETE' }, 'DELETE');
		if (!response.ok) { say(live, data.error === 'account_delete_failed' ? 'Deletion could not be completed. Please try again.' : 'Could not delete the account.'); return; }
		await loadStatus();
		say(live, 'Account and cloud data deleted. Local browser saves were kept.');
		await renderSaves();
	});
	$('[data-player-sync]', root)?.addEventListener('click', async () => {
		if (!account.authenticated) { say(live, 'Sign in to sync. Guest progress remains on this device.'); return; }
		say(live, 'Checking save revisions…');
		const result = await syncPlayerSaves();
		await renderSaves();
		if (result.conflicts) say(live, `${result.conflicts} save conflict${result.conflicts === 1 ? '' : 's'} found. Choose which version to keep; neither was overwritten.`);
		else if (result.error) say(live, 'Sync is temporarily unavailable. Pending saves remain local and will retry when online.');
		else say(live, result.pending ? `${result.pending} save(s) remain local; they will retry when online.` : `${result.uploaded} save(s) synced. This device is up to date.`);
	});
	$('[data-player-export]', root)?.addEventListener('click', async (event) => {
		event.preventDefault();
		try {
			const response = await fetch('/api/games/account/export', { credentials: 'same-origin', cache: 'no-store' });
			if (!response.ok) { say(live, 'Could not export account data.'); return; }
			const blob = await response.blob(); const href = URL.createObjectURL(blob); const anchor = document.createElement('a');
			anchor.href = href; anchor.download = 'bnji-game-account-export.json'; anchor.click(); URL.revokeObjectURL(href);
			say(live, 'Account profile, saves, and score records exported.');
		} catch { say(live, 'Export is unavailable while offline.'); }
	});
	$('[data-recovery-dismiss]', root)?.addEventListener('click', () => {
		if (codePanel) codePanel.hidden = true;
		recovering = false;
		say(live, 'Recovery code hidden. You can rotate it later while signed in.');
	});
	window.addEventListener('storage', (event) => {
		if (event.key === 'bnji-stack-best') {
			void captureLegacyLocalProgress().then(async () => {
				if (account.authenticated) await syncPlayerSaves();
				await renderSaves();
			});
		}
	});

	await captureLegacyLocalProgress();
	await loadStatus();
	await renderSaves();
}
