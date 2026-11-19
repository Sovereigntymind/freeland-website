import { createHash, createHmac } from 'node:crypto';

export const read = (store, key) => store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
export const hashPayload = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export const hashIP = (ip, salt) => createHmac('sha256', salt).update(ip).digest('hex');

// Every mutation is conditional. Exhaustion leaves the durable capture for reconciliation.
export async function transition(store, key, patch, owns = () => true) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await read(store, key);
    if (!current) throw new Error('Missing capture');
    if (!current.etag) throw new Error('Missing capture ETag');
    if (!owns(current.data)) return null;
    const next = { ...current.data, ...patch };
    if ((await store.set(key, JSON.stringify(next), { onlyIfMatch: current.etag })).modified) return next;
  }
  return null;
}

export async function increment(store, key, limit, applicationId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await read(store, key);
    if (current && !current.etag) throw new Error('Missing counter ETag');
    // A recovered admission must not count the same capture twice after a crash.
    const members = current?.data.members || {};
    if (applicationId && members[applicationId]) return { allowed: true, count: members[applicationId], contention: false };
    if (applicationId && current?.data.count >= limit) return { allowed: false, count: current.data.count, contention: false };
    const count = (current?.data.count || 0) + 1;
    const condition = current ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
    const data = applicationId ? { count, members: { ...members, [applicationId]: count } } : { count };
    if ((await store.set(key, JSON.stringify(data), condition)).modified) {
      return { allowed: count <= limit, count, contention: false };
    }
  }
  return { allowed: false, contention: true };
}
