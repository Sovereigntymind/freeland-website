import { deadline } from './leads-deadline.mjs';
const deliveries = ['pending', 'n8n_ack', 'backup_sent', 'delivery_failed', 'test'];
const string = value => {
  if (typeof value !== 'string') throw new Error('Invalid lead field');
  return value;
};

// Read-only projection: never return the stored object or spread its raw fields.
export async function exportRecords(store, { days, now, budget = deadline() }) {
  const cutoff = now - days * 86400000;
  const records = [];
  // Next step: date-prefixed keys or cursor pagination to avoid lifetime scans.
  // Until then, bound every page and read; never return a successful partial export.
  const pages = store.list({ paginate: true })[Symbol.asyncIterator]();
  try {
    for (;;) {
      const { value: page, done } = await budget.run(() => pages.next());
      if (done) break;
      for (const { key } of page.blobs) {
        if (key.startsWith('rl/')) continue;
        const snapshot = await budget.run(() => store.getWithMetadata(key, { type: 'json', consistency: 'strong' }));
        const record = snapshot?.data;
        if (!record || record.rejected || record.admission === 'rejected') continue;
        if (!['accepted', 'pending'].includes(record.admission)) continue;
        const created = Date.parse(string(record.created_at));
        if (!Number.isFinite(created)) throw new Error('Invalid lead date');
        if (created < cutoff || created > now) continue;
        if (!['roadmap', 'partner'].includes(record.form_type) || typeof record.eligible !== 'boolean' || !deliveries.includes(record.delivery_status)) {
          throw new Error('Invalid lead state');
        }
        const completed = record.delivery_completed_at;
        if (completed != null && (typeof completed !== 'string' || !Number.isFinite(Date.parse(completed)))) throw new Error('Invalid delivery date');
        records.push({
          id: string(record.id),
          createdAt: record.created_at,
          formType: record.form_type,
          email: string(record.fields?.email),
          label: string(record.form_type === 'roadmap' ? record.fields?.store_url : record.fields?.agency_name),
          eligible: record.eligible,
          admission: record.admission,
          delivery: record.delivery_status,
          deliveredAt: completed ?? null,
          test: record.test === true || record.test_record_only === true || record.status === 'test' || record.delivery_status === 'test' || record.delivery_mode === 'test_delivery'
        });
      }
    }
  } finally {
    // A stuck iterator must not hold the 503 response open during cleanup.
    if (pages.return) void Promise.resolve(pages.return()).catch(() => {});
  }
  return records;
}
