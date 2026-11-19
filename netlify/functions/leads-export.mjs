import { createHash, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { exportRecords } from '../lib/leads-ops.mjs';
import { deadline, storageFetch } from '../lib/leads-deadline.mjs';

export const config = { path: '/api/leads-export' };
const digest = value => createHash('sha256').update(value).digest();
const empty = (status, headers = {}) => new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });

export function createHandler({ store, env = process.env, now = Date.now, clock, timeouts, fetcher = fetch } = {}) {
  return async request => {
    const budget = deadline(timeouts?.total, clock);
    if (request.method !== 'GET') return empty(405, { allow: 'GET' });
    const key = request.headers.get('x-leads-key') || '';
    const expected = env.LEADS_EXPORT_KEY || '';
    // Fixed-size digests allow constant-time comparison even for unequal key lengths.
    const matches = timingSafeEqual(digest(key), digest(expected));
    if (!expected || !key || !matches) return empty(401);
    try {
      const rawDays = new URL(request.url).searchParams.get('days');
      const value = rawDays?.trim() ? Number(rawDays) : NaN;
      const days = Number.isFinite(value) ? Math.max(1, Math.min(90, Math.trunc(value))) : 30;
      const timestamp = now();
      const db = store || getStore({ name: 'freeland-leads', consistency: 'strong', fetch: storageFetch(fetcher, budget) });
      const records = await budget.run(() => exportRecords(db, { days, now: timestamp, budget }));
      return new Response(JSON.stringify({ generatedAt: new Date(timestamp).toISOString(), days, count: records.length, records }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
      });
    } catch {
      // Never return a successful partial export or expose store errors/lead data.
      return empty(503);
    }
  };
}

export default createHandler();
