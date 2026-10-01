/** Astro HTTP entrypoint plus the hourly free-plan retention sweep. */
import { handle } from '@astrojs/cloudflare/handler';
import { DMConversation } from './server/dm-conversation-do';
import { GameRoom } from './server/game-room-do';
import { Presence } from './server/presence-do';
import { runRetentionSweep } from './server/tracking-retention';

export { DMConversation, GameRoom, Presence };

export default {
	fetch: handle,
	scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
		context.waitUntil(runRetentionSweep(env as unknown as Record<string, unknown>));
	},
} satisfies ExportedHandler<Env>;
