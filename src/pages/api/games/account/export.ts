import type { APIContext } from 'astro';
import { exportAccount } from '../account';

export const prerender = false;
export async function GET(context: APIContext): Promise<Response> {
	return exportAccount(context);
}
