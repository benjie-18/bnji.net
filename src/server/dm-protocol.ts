/**
 * BNJI.NET — chat plan Phase D: the DM live-frame vocabulary (plan §7.3).
 *
 * Deliberately tiny: the DO only ever carries live frames, never history
 * (D1 `dm_messages` is the durable record; history is pulled over REST).
 * Every payload is data-only JSON rendered with `textContent` by the client —
 * no markup, no HTML, no markdown, exactly like room chat (§12.1).
 *
 * Sides: a conversation's members are canonically `lo < hi`; each client
 * learns its own side from the conversation list and derives `me` / `them`
 * from `senderSide`, so player IDs never leave the server (§12.3).
 */
export const DM_PROTOCOL_VERSION = 1;

export type DmSide = 'lo' | 'hi';
export const DM_SIDE_BIT: Record<DmSide, number> = { lo: 1, hi: 2 };

/** Sent by the DO right after a socket is accepted (connection status UX). */
export type DmReadyFrame = { t: 'dm_ready'; v: typeof DM_PROTOCOL_VERSION };

/** A message was appended to D1 — broadcast to both participants. */
export type DmNewFrame = {
	t: 'dm_new';
	v: typeof DM_PROTOCOL_VERSION;
	m: { n: number; senderSide: DmSide; body: string; imageId: string | null; at: number };
};

/** Delete-for-me (plan D12): `bit` is DM_SIDE_BIT of the viewer it hides for. */
export type DmHideFrame = { t: 'dm_hide'; v: typeof DM_PROTOCOL_VERSION; n: number; bit: number };

/** Read-watermark advance (plan §7.1): the OTHER side has read up to `seq`. */
export type DmReadFrame = { t: 'dm_read'; v: typeof DM_PROTOCOL_VERSION; side: DmSide; seq: number };

export type DmServerFrame = DmReadyFrame | DmNewFrame | DmHideFrame | DmReadFrame;

/** Client→server frames: none by design (sends, reads and hides are REST POSTs). */
export type DmClientFrame = { t: 'ping' };
