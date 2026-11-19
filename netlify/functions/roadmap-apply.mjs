import { randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import funnel from '../../src/_data/funnel.json' with { type: 'json' };
import { validate, eligible } from '../lib/leads-validation.mjs';
import { read, hashPayload, hashIP, increment, transition } from '../lib/leads-store.mjs';
import { challenge, deliver } from '../lib/leads-delivery.mjs';
import { deadline, boundedStore, storageFetch } from '../lib/leads-deadline.mjs';

export const config = { path: '/api/roadmap-apply' };
const json = (code, data) => new Response(JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const failure = (code, error, extra = {}) => json(code, { accepted: false, error, ...extra });
const inList = (email, list = '') => list.split(/[,;\s]+/).some(item => item.toLowerCase() === email);
const receipt = record => record.rejected ? failure(429, 'rate_limited') : record.admission === 'pending' ? failure(503, 'server') : json(200, {
  accepted: true, application_id: record.id, eligible: record.eligible,
  status: record.status === 'test' ? 'test' : ({ n8n_ack: 'delivered', backup_sent: 'backup_sent', pending: 'pending' }[record.delivery_status] || 'delivery_failed'),
  ...(record.test || record.status === 'test' || record.delivery_mode === 'test_delivery' ? { test: true } : {})
});

async function body(request, budget) {
  if (Number(request.headers.get('content-length')) > 4096) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await budget.run(() => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > 4096) throw new RangeError();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createHandler({ store, env = process.env, fetcher = fetch, now = Date.now, clock, revenueFloor = funnel.revenue_floor, timeouts } = {}) {
  return async (request, context = {}) => {
    const budget = deadline(timeouts?.total, clock);
    if (request.method !== 'POST') return failure(405, 'validation', { fields: { form: 'Use POST.' } });
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return failure(400, 'validation', { fields: { form: 'Send JSON.' } });
    let input;
    try { input = validate(await body(request, budget)); }
    catch (error) { return error.name === 'TimeoutError' ? failure(503, 'server') : failure(400, 'validation', { fields: { form: 'Send valid JSON no larger than 4 KB.' } }); }
    if (input.silent) return json(200, { accepted: false });
    if (Object.keys(input.errors).length) return failure(400, 'validation', { fields: input.errors });
    if (!env.LEADS_IP_SALT) return failure(500, 'server');
    const ip = context.ip || request.headers.get('x-nf-client-connection-ip') || null;
    const knownIP = ip && ip !== 'unknown';
    let captured;
    try {
      const db = boundedStore(store || getStore({ name: 'freeland-leads', consistency: 'strong', fetch: storageFetch(fetcher, budget) }), budget);
      const key = input.id;
      const payload_hash = hashPayload({ form_type: input.type, fields: input.fields });
      const admit = async record => {
        captured = record;
        const owns = current => current.admission === 'pending' && current.admission_owner === record.admission_owner;
        const save = patch => transition(db, key, patch, owns);
        if (record.test_record_only ?? inList(record.fields.email, env.TEST_EMAILS)) {
          return receipt(await save({ admission: 'accepted', status: 'test', delivery_status: 'test', test: true }) || record);
        }
        const hour = Math.floor(new Date(record.created_at).getTime() / 3600000);
        const bucket = record.rate_bucket || `rl/ip/${knownIP ? hashIP(ip, env.LEADS_IP_SALT) : 'unknown'}/${hour}`;
        const ipLimit = await increment(db, bucket, record.ip_limit || (knownIP ? 5 : 2), key);
        if (!ipLimit.allowed && !ipLimit.contention) {
          const rejected = await save({ rejected: true, admission: 'rejected', status: 'rate_limited' });
          return receipt(rejected || record);
        }
        const siteLimit = await increment(db, `rl/site/${hour}`, 60, key);
        const ready = await save({ admission: 'accepted', auto_reply_paused: ipLimit.contention || !siteLimit.allowed });
        if (!ready) return receipt(record);
        captured = ready;
        const outcome = await deliver(ready, env, fetcher, timeouts, budget);
        const saved = await transition(db, key, { ...outcome, delivery_completed_at: new Date(now()).toISOString() }, current => current.admission_owner === ready.admission_owner && current.delivery_status === 'pending');
        return receipt(saved || ready);
      };
      const replay = async snapshot => {
        if (snapshot.data.payload_hash !== payload_hash) return failure(409, 'conflict');
        for (let attempt = 0; ; attempt++) {
          const record = snapshot.data;
          captured = record;
          // Only admission can be reclaimed: an accepted delivery may have sent
          // even if its acknowledgement was lost. Never resend that state.
          if (record.admission === 'pending' && now() - Date.parse(record.admission_claimed_at || record.created_at) >= 30000) {
            if (!snapshot.etag) throw new Error('Missing capture ETag');
            const claimed = { ...record, admission_owner: randomUUID(), admission_claimed_at: new Date(now()).toISOString() };
            if ((await db.set(key, JSON.stringify(claimed), { onlyIfMatch: snapshot.etag })).modified) return await admit(claimed);
          }
          if (attempt >= 10 || (record.admission !== 'pending' && record.delivery_status !== 'pending') || record.rejected) return receipt(record);
          await budget.run(() => new Promise(resolve => setTimeout(resolve, 20)));
          snapshot = await read(db, key);
          if (!snapshot) throw new Error('Missing capture');
        }
      };
      const previous = await read(db, key);
      if (previous) return await replay(previous); // Captcha tokens are single-use.
      if (!(await challenge(input.token, ip, env, fetcher, timeouts?.challenge, budget))) {
        const raced = await read(db, key);
        return raced ? await replay(raced) : failure(403, 'challenge_failed');
      }
      const test = inList(input.fields.email, env.TEST_EMAILS);
      const testDelivery = inList(input.fields.email, env.TEST_DELIVERY_EMAILS);
      const hour = Math.floor(now() / 3600000);
      const record = { id: key, created_at: new Date(now()).toISOString(), form_type: input.type, fields: input.fields, attribution: input.attribution, payload_hash, eligible: eligible(input.type, input.fields, revenueFloor), status: 'captured', admission: 'pending', admission_owner: randomUUID(), admission_claimed_at: new Date(now()).toISOString(), delivery_status: 'pending', delivery_mode: testDelivery ? 'test_delivery' : 'live', test: test || testDelivery, test_record_only: test, rate_bucket: `rl/ip/${knownIP ? hashIP(ip, env.LEADS_IP_SALT) : 'unknown'}/${hour}`, ip_limit: knownIP ? 5 : 2, auto_reply_paused: false };
      if (!(await db.set(key, JSON.stringify(record), { onlyIfNew: true })).modified) return await replay(await read(db, key));
      return await admit(record);
    } catch (error) {
      // Never log error messages, stack traces, request fields or credentials.
      const name = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'TimeoutError', 'AbortError'].includes(error?.name) ? error.name : 'Error';
      console.error({ name, application_id: input.id });
      return captured ? receipt(captured) : failure(500, 'server');
    }
  };
}

export default createHandler();
