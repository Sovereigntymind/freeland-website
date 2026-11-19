export const isPreSend = error => ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code || error?.code);

// A race also bounds mocks and transports which ignore AbortSignal. All delivery is awaited.
export async function bounded(fetcher, url, options, ms, consume = response => response.ok, budget) {
  if (budget) return budget.run(signal => Promise.resolve(fetcher(url, { ...options, signal, redirect: 'error' })).then(consume), ms);
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetcher(url, { ...options, signal: controller.signal, redirect: 'error' })).then(consume),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Delivery timeout')); }, ms); })
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function challenge(token, ip, env, fetcher, timeout = 4000, budget) {
  // FL_TEST_MODE alone must never disable the production challenge.
  if (env.FL_TEST_MODE === '1' && (process.env.NODE_TEST_CONTEXT || process.execArgv.includes('--test'))) return true;
  if (!env.HCAPTCHA_SECRET || !token) return false;
  try {
    return await bounded(fetcher, 'https://api.hcaptcha.com/siteverify', {
      method: 'POST', body: new URLSearchParams({ secret: env.HCAPTCHA_SECRET, response: token, ...(ip && ip !== 'unknown' ? { remoteip: ip } : {}) })
    }, timeout, async r => r.ok && (await r.json()).success === true, budget);
  } catch { return false; }
}

export async function deliver(record, env, fetcher, overrides = {}, budget) {
  const timeouts = { primary: 8000, backup: 5000, ...overrides };
  // Leave a little of the shared budget for recording the outcome.
  const available = cap => budget ? Math.max(0, Math.min(cap, budget.remaining() - 100)) : cap;
  const payload = { application_id: record.id, form_type: record.form_type, fields: record.fields, attribution: record.attribution, eligible: record.eligible, delivery_mode: record.delivery_mode, auto_reply_paused: record.auto_reply_paused };
  if (!record.auto_reply_paused && env.N8N_ROADMAP_URL && env.N8N_ROADMAP_SECRET) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ok = await bounded(fetcher, env.N8N_ROADMAP_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-freeland-secret': env.N8N_ROADMAP_SECRET }, body: JSON.stringify(payload)
        }, available(timeouts.primary), undefined, budget);
        if (ok) return { status: 'delivered', delivery_status: 'n8n_ack' };
        break; // HTTP failure may already have delivered. Never retry it.
      } catch (error) { if (attempt !== 0 || !isPreSend(error)) break; }
    }
  }
  if (env.WEB3FORMS_KEY) {
    try {
      const ok = await bounded(fetcher, 'https://api.web3forms.com/submit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_key: env.WEB3FORMS_KEY, subject: `${record.delivery_mode === 'test_delivery' ? '[SITE TEST] ' : ''}Roadmap application ${record.id}${record.auto_reply_paused ? ' (auto-reply paused)' : ' (check delivery before resending)'}`, application_id: record.id, message: JSON.stringify(payload), from_name: 'Freeland application alert' })
      }, available(timeouts.backup), async r => r.ok && (await r.json()).success === true, budget);
      if (ok) return { status: 'delivered', delivery_status: 'backup_sent' };
    } catch { /* Capture remains available for reconciliation. */ }
  }
  return { status: 'captured', delivery_status: 'delivery_failed' };
}
