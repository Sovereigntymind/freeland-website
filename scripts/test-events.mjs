import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(new URL('../src/js/events.js', import.meta.url), 'utf8');
function page({ storage = new Map(), blocked = false, pathname = '/blog/email-marketing-small-business/', search = '?utm_source=newsletter', env = 'production' } = {}) {
  const calls = [], handlers = {};
  const window = { FL: { env, track: (name, params) => calls.push({ name, params }) } };
  vm.runInNewContext(code, { window, location: { pathname, search }, URLSearchParams, sessionStorage: { getItem: k => { if (blocked) throw Error(); return storage.get(k); }, setItem: (k, v) => { if (blocked) throw Error(); storage.set(k, v); } }, document: { addEventListener: (type, fn) => handlers[type] = fn } });
  return { calls, handlers, FL: window.FL, storage };
}
test('first-touch attribution persists across pages and nested CTA click is delegated', () => {
  const first = page(); assert.equal(first.FL.attribution().utm.source, 'newsletter');
  first.handlers.click({ target: { closest: () => ({ getAttribute: () => 'hero_roadmap' }) } });
  assert.deepEqual(JSON.parse(JSON.stringify(first.calls[0])), { name: 'cta_click', params: { cta_id: 'hero_roadmap', page_path: '/blog/email-marketing-small-business/' } });
  const next = page({ storage: first.storage, pathname: '/growth-roadmap/', search: '?utm_source=other' });
  assert.equal(next.FL.attribution().landing_path, '/blog/email-marketing-small-business/'); assert.equal(next.FL.attribution().utm.source, 'newsletter'); assert.equal(next.FL.attribution().last_cta_id, 'hero_roadmap');
  const copy = next.FL.attribution(); copy.utm.source = 'changed'; assert.equal(next.FL.attribution().utm.source, 'newsletter');
});
test('confirmed leads dedupe across reload, form events do not', () => {
  const first = page(); first.FL.formEvent('generate_lead', { application_id: 'id' }); first.FL.formEvent('generate_lead', { application_id: 'id' });
  assert.equal(first.calls.length, 1); const next = page({ storage: first.storage }); next.FL.formEvent('generate_lead', { application_id: 'id' }); assert.equal(next.calls.length, 0);
  next.FL.formEvent('form_start', {}); next.FL.formEvent('form_error', {}); assert.equal(next.calls.length, 2);
});
test('storage unavailable still supports events and page-local dedupe', () => {
  const p = page({ blocked: true }); p.FL.formEvent('generate_lead', { application_id: 'id' }); p.FL.formEvent('generate_lead', { application_id: 'id' }); assert.equal(p.calls.length, 1);
});
test('preview and test receipts mark internal; missing ID never fires a lead', () => {
  const p = page({ env: 'preview' }); p.FL.formEvent('generate_lead', {}); assert.equal(p.calls.length, 0); p.FL.formEvent('form_start', {}); assert.equal(p.calls[0].params.traffic_type, 'internal');
  const q = page(); q.FL.formEvent('generate_lead', { application_id: 'test', status: 'test' }); assert.equal(q.calls[0].params.traffic_type, 'internal');
});

test('test response marks the whole session internal without forwarding receipt fields', () => {
  const p = page();
  p.FL.formEvent('generate_lead', { application_id: 'id', form_id: 'roadmap_apply' }, { test: true, accepted: true, eligible: true });
  assert.equal(p.calls[0].params.traffic_type, 'internal'); assert.equal(p.calls[0].params.test, undefined);
  const next = page({ storage: p.storage }); next.FL.formEvent('form_start', { form_id: 'partner' });
  assert.equal(next.calls[0].params.traffic_type, 'internal');
  const q = page(); q.FL.markInternal(); q.FL.formEvent('form_error', { error_type: 'server' });
  assert.equal(q.calls[0].params.traffic_type, 'internal');
});

test('each event allows only its declared keys, never arbitrary fields or objects', () => {
  const p = page();
  const input = { form_id: 'roadmap', application_id: 'id', revenue_band: 'under-50k', main_channel: 'Meta', source_page: '/', cta_id: 'hero', error_type: 'server', email: 'private@example.com', store_url: 'https://private.example', fields: { email: 'private@example.com' }, arbitrary: 'secret', traffic_type: 'external' };
  p.FL.formEvent('form_start', input); p.FL.formEvent('form_error', input); p.FL.formEvent('generate_lead', input);
  assert.deepEqual(Object.keys(p.calls[0].params), ['form_id']);
  assert.deepEqual(Object.keys(p.calls[1].params), ['form_id', 'error_type']);
  assert.deepEqual(Object.keys(p.calls[2].params), ['form_id', 'application_id', 'revenue_band', 'main_channel', 'source_page', 'cta_id']);
  assert.ok(!JSON.stringify(p.calls).includes('private'));
  p.FL.formEvent('constructor', input); p.FL.formEvent('unknown', input); assert.equal(p.calls.length, 3);
  p.FL.formEvent('form_error', { form_id: { email: 'private@example.com' } }); assert.deepEqual(Object.keys(p.calls[3].params), []);
});

// Form deadlines and motion lifecycle share this existing browser-behavior suite.
import { clock, deferred, element, flush } from './browser-fixtures.mjs';
const applyCode = fs.readFileSync(new URL('../src/js/apply.js', import.meta.url), 'utf8');
const auditCode = fs.readFileSync(new URL('../src/free-business-audit/index.njk', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function formPage({ formType = 'roadmap', audit = false, captcha = false, fetcher = async () => ({ status: 200, json: async () => ({ accepted: true, emailQueued: true }) }), abort = true, storage = new Map(), fast = false, initFails = false, booking = '', attr = {}, now = 100000 } = {}) {
  let booted = false;
  const time = clock(), form = element(), button = element('Send'), status = element(), slot = element();
  const calls = [], events = [], widgets = [], resets = [], removals = [], scripts = [];
  const fields = { store_url: 'brand.com', revenue_band: 'under-50k', main_channel: 'Meta', role: 'founder', email: 'you@example.com', contact_check: '', hp_company_url: '', company_url: '', agency_name: 'Agency', agency_website: 'agency.com', client_count: '1-5', services: 'SEO', business_name: 'Brand', website: 'https://brand.com', city: '', industry: '', phone: '' };
  button.disabled = true;
  const errors = Object.fromEntries(Object.keys(fields).map(name => [name, element()]));
  form.elements = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { ...element(), value }]));
  Object.assign(form.attrs, { 'data-booking-url': booking, 'data-form-type': formType, 'data-endpoint': '/api/roadmap-apply', 'data-hcaptcha-sitekey': captcha ? 'key' : '' });
  form.querySelector = selector => selector === 'button[type="submit"]' ? button : selector === '[data-form-status]' ? status : selector === '#hcaptcha-slot' ? slot : errors[selector.match(/data-error-for="(.*?)"/)?.[1]] || form.elements[selector.match(/name="(.*?)"/)?.[1]] || null;
  const window = { FL: { attribution: () => attr, formEvent: (name, data) => events.push({ name, data }), track: (name, data) => events.push({ name, data }) }, crypto: { randomUUID: () => { if (initFails) throw Error('Crypto unavailable'); return 'application-id'; } }, location: {}, hcaptcha: {
    render(_slot, options) { const work = deferred(); widgets.push({ options, ...work }); return widgets.length - 1; },
    execute(id) { return widgets[id].promise; }, reset(id) { resets.push(id); }, remove(id) { removals.push(id); }
  } };
  if (abort) window.AbortController = AbortController;
  const document = { readyState: 'complete', addEventListener() {}, createElement: () => element(), head: { appendChild: s => scripts.push(s) }, querySelectorAll: () => [form], getElementById: id => ({ 'gbp-audit-form': form, 'gbp-submit-btn': button, 'gbp-audit-error': status })[id] };
  vm.runInNewContext(audit ? auditCode : applyCode, { window, document, crypto: window.crypto, sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) }, Date: class extends Date { static now() { return now + time.now() + (booted && !fast ? 3000 : 0); } }, URL, location: { pathname: '/growth-roadmap/' }, AbortController, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, fetch: (...args) => { calls.push(args); return fetcher(...args); } });
  booted = true;
  return { errors, storage, time, form, button, status, calls, events, widgets, resets, removals, scripts, window, submit: async () => { form.handlers.submit({ preventDefault() {} }); await flush(); }, load: async () => { window.flHcaptchaReady(); await flush(); } };
}

for (const formType of ['roadmap', 'partner']) test(`429 retry waits for reset, rotates only the rejected ID and keeps ${formType} answers`, async () => {
  let attempt = 0;
  const p = formPage({ formType, fetcher: async () => ++attempt === 1
    ? { status: 429, json: async () => ({ accepted: false, error: 'rate_limited', retry_at: new Date(104000).toISOString() }) }
    : { status: 200, json: async () => ({ accepted: true }) } });
  p.window.crypto.randomUUID = () => 'retry-id';
  await p.submit();
  assert.equal(p.storage.get('fl_app_' + formType), 'retry-id');
  assert.equal(p.storage.has('fl_app_' + formType + '_receipt'), false);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 0);
  assert.match(p.status.textContent, /Try again after/);
  await p.submit(); assert.equal(p.calls.length, 1);
  await p.time.advance(1000); await p.submit();
  assert.equal(p.calls.length, 2);
  const [first, retry] = p.calls.map(c => JSON.parse(c[1].body));
  assert.equal(first.application_id, 'application-id'); assert.equal(retry.application_id, 'retry-id');
  assert.deepEqual(retry.fields, first.fields);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 1);
});

for (const formType of ['roadmap', 'partner']) test(`silent ${formType} rejection clears autofilled trap again immediately before retry`, async () => {
  const p = formPage({ formType, fetcher: async (_url, init) => ({ status: 200, json: async () => ({ accepted: !JSON.parse(init.body).contact_check }) }) });
  p.form.elements.contact_check.value = 'autofilled';
  await p.submit();
  assert.equal(JSON.parse(p.calls[0][1].body).contact_check, 'autofilled');
  assert.equal(p.form.elements.contact_check.value, '');
  assert.equal(p.form.replacement, undefined);
  p.form.elements.contact_check.value = 'autofilled again';
  p.form.elements.hp_company_url.value = 'legacy autofill';
  await p.submit();
  const retry = JSON.parse(p.calls[1][1].body);
  assert.equal(retry.contact_check, ''); assert.equal(retry.hp_company_url, undefined);
  assert.equal(p.form.elements.hp_company_url.value, '');
  assert.equal(retry.application_id, JSON.parse(p.calls[0][1].body).application_id);
  assert.deepEqual(retry.fields, JSON.parse(p.calls[0][1].body).fields);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 1);
});

for (const formType of ['roadmap', 'partner']) test(`client checks normalized ${formType} URL length and offers homepage recovery`, async () => {
  const p = formPage({ formType }), key = formType === 'roadmap' ? 'store_url' : 'agency_website';
  for (const url of ['https://example.com/' + '界'.repeat(54), 'https://example.com/' + 'a'.repeat(481)]) {
    p.form.elements[key].value = url;
    await p.submit();
    assert.equal(p.calls.length, 0);
    assert.match(p.errors[key].textContent, /homepage address.*500 characters/);
    assert.equal(p.form.elements[key].attrs['aria-invalid'], 'true');
  }
  p.form.elements[key].value = 'https://münchen.de/'; await p.submit();
  assert.equal(p.calls.length, 1);
  assert.equal(JSON.parse(p.calls[0][1].body).fields[formType][key], new URL('https://münchen.de/').href);
});

test('both source forms use neutral honeypot names, matching labels and disabled autofill', () => {
  for (const [page, prefix] of [['growth-roadmap', 'rm'], ['partners', 'pt']]) {
    const source = fs.readFileSync(new URL(`../src/${page}/index.njk`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`<label for="${prefix}-contact-check">Leave blank</label>`));
    assert.match(source, new RegExp(`<input id="${prefix}-contact-check" name="contact_check" type="text" tabindex="-1" autocomplete="off">`));
    assert.doesNotMatch(source, /hp_company_url|Company URL \(leave this empty\)/);
  }
});

test('initialization failure keeps submit disabled and exposes a usable email fallback', () => {
  const p = formPage({ initFails: true });
  assert.equal(p.button.disabled, true); assert.equal(p.calls.length, 0);
  assert.equal(p.status.hidden, false); assert.match(p.status.textContent, /could not start/);
  assert.equal(p.status.children[0].attrs.href, 'mailto:kevin@freelandme.com');
});

test('invalid answers can be corrected and a server validation retry retains the application id', async () => {
  let attempt = 0;
  const p = formPage({ fetcher: async () => ++attempt === 1 ? { status: 400, json: async () => ({ fields: { email: 'Check this email.' } }) } : { status: 200, json: async () => ({ accepted: true }) } });
  p.form.elements.email.value = 'bad'; await p.submit();
  assert.equal(p.calls.length, 0); assert.equal(p.form.elements.email.attrs['aria-invalid'], 'true');
  p.form.elements.email.value = 'correct@example.com';
  p.form.handlers.input({ target: p.form.elements.email }); await p.submit();
  assert.equal(p.button.disabled, false); assert.match(p.errors.email.textContent, /Check this email/);
  p.form.elements.email.value = 'confirmed@example.com'; await p.submit();
  assert.equal(p.calls.length, 2); assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 1);
  assert.equal(JSON.parse(p.calls[0][1].body).application_id, JSON.parse(p.calls[1][1].body).application_id);
});

test('fast autofill waits actual elapsed time and double submit cannot duplicate the request', async () => {
  const p = formPage({ fast: true }); await p.submit(); await p.submit();
  assert.equal(p.calls.length, 0); await p.time.advance(2499); assert.equal(p.calls.length, 0);
  await p.time.advance(1); assert.equal(p.calls.length, 1);
  assert.equal(JSON.parse(p.calls[0][1].body).elapsed_ms, 2500);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 1);
});

test('silent rejection neither records a lead nor persists an accepted receipt', async () => {
  const p = formPage({ booking: 'https://calendar.example/', fetcher: async () => ({ status: 200, json: async () => ({ accepted: false }) }) });
  await p.submit(); assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 0);
  assert.equal(p.storage.has('fl_app_roadmap_receipt'), false);
  assert.equal(p.storage.get('fl_app_roadmap'), 'application-id');
  assert.equal(p.form.replacement, undefined);
  assert.match(p.status.textContent, /kevin@freelandme.com/);
  assert.ok(!JSON.stringify(p.status).includes('data-booking-source'));
  assert.equal(p.status.children[0].textContent, 'We could not confirm your application.');
  assert.equal(p.status.children[1].textContent, 'Try again or email Kevin.');
  assert.doesNotMatch(p.status.textContent, /Application received|Pick a time|replies by email/);
  retryAvailable(p);
});

for (const eligible of [true, false]) test(`refresh restores accepted next step, eligibility ${eligible}, without a POST or lead event`, async () => {
  const p = formPage({ booking: 'https://calendar.example/', fetcher: async () => ({ status: 200, json: async () => ({ accepted: true, eligible }) }) });
  await p.submit(); assert.match(p.form.replacement.textContent, /kevin@freelandme.com/);
  const saved = p.storage.get('fl_app_roadmap_receipt');
  assert.deepEqual(Object.keys(JSON.parse(saved)), ['version', 'application_id', 'accepted', 'eligible', 'savedAt']);
  assert.doesNotMatch(saved, /example.com|brand.com|email|store_url/);
  const reload = formPage({ storage: p.storage, booking: 'https://calendar.example/', now: 103000 });
  assert.equal(reload.calls.length, 0); assert.equal(reload.events.length, 0);
  assert.equal(reload.form.replacement.textContent, p.form.replacement.textContent);
  assert.equal(reload.form.handlers.submit, undefined);
});

test('corrupt or expired receipts do not invent acceptance and retries retain their original id', async () => {
  for (const receipt of ['broken', JSON.stringify({ version: 1, application_id: 'application-id', accepted: true, eligible: true, savedAt: 1 })]) {
    const storage = new Map([['fl_app_roadmap', 'application-id'], ['fl_app_roadmap_receipt', receipt]]);
    const p = formPage({ storage, now: 90000000 });
    assert.equal(p.form.replacement, undefined); assert.equal(p.button.disabled, false);
    await p.submit(); assert.equal(JSON.parse(p.calls[0][1].body).application_id, 'application-id');
  }
});

test('refresh after an unconfirmed request reuses the idempotency key instead of creating another application', async () => {
  const storage = new Map(), lost = deferred();
  const first = formPage({ storage, fetcher: () => lost.promise });
  await first.submit(); assert.equal(first.calls.length, 1);
  const reload = formPage({ storage }); await reload.submit();
  assert.equal(JSON.parse(first.calls[0][1].body).application_id, JSON.parse(reload.calls[0][1].body).application_id);
  assert.equal(first.events.filter(e => e.name === 'generate_lead').length, 0);
  assert.equal(reload.events.filter(e => e.name === 'generate_lead').length, 1);
});

test('lead origin survives roadmap anchor clicks and only known public paths reach analytics', () => {
  const service = page({ pathname: '/services/meta-ads/', search: '' });
  service.handlers.click({ target: { closest: () => ({ getAttribute: () => 'service_meta_roadmap' }) } });
  const roadmap = page({ storage: service.storage, pathname: '/growth-roadmap/', search: '' });
  roadmap.handlers.click({ target: { closest: () => ({ getAttribute: () => 'roadmap_hero_apply' }) } });
  assert.equal(roadmap.FL.attribution().originating_page, '/services/meta-ads/');
  roadmap.FL.formEvent('generate_lead', { application_id: 'origin-id', originating_page: '/services/meta-ads/?email=private@example.com' });
  assert.equal(roadmap.calls.at(-1).params.originating_page, '/services/meta-ads/');
  roadmap.FL.formEvent('generate_lead', { application_id: 'private-id', originating_page: '/private@example.com/' });
  assert.equal(roadmap.calls.at(-1).params.originating_page, '/');
  assert.doesNotMatch(JSON.stringify(roadmap.calls), /private@example/);
});

test('application lead carries origin separately without expanding the frozen API attribution payload', async () => {
  const p = formPage({ attr: { landing_path: '/services/seo/', originating_page: '/services/seo/', last_cta_path: '/growth-roadmap/', last_cta_id: 'roadmap_hero_apply', utm: {} } });
  await p.submit();
  const event = p.events.find(e => e.name === 'generate_lead');
  assert.equal(event.data.originating_page, '/services/seo/'); assert.equal(event.data.source_page, '/growth-roadmap/');
  assert.deepEqual(Object.keys(JSON.parse(p.calls[0][1].body).attribution), ['landing_path', 'last_cta_id', 'last_cta_path', 'utm']);
  assert.doesNotMatch(JSON.stringify(event), /you@example|brand.com|store_url/);
});

test('all attribution paths reject email paths, fragments, queries and poisoned session paths', () => {
  for (const pathname of ['/person@example.com/', '/blog/person@example.com/', '/services/person@example.com/', '/person%40example.com/', '//person@example.com/']) {
    const expected = pathname.startsWith('/blog/') ? '/blog/' : '/';
    const storage = new Map([['fl_attr', JSON.stringify({ landing_path: pathname, last_cta_path: pathname, originating_page: pathname })]]);
    const p = page({ storage, pathname, search: '?email=person@example.com#private' });
    for (const key of ['landing_path', 'last_cta_path', 'originating_page']) assert.equal(p.FL.attribution()[key], expected);
    p.handlers.click({ target: { closest: () => ({ getAttribute: () => 'fixture_cta' }) } });
    assert.equal(p.calls[0].params.page_path, expected);
    p.FL.formEvent('generate_lead', { application_id: 'id', source_page: pathname, originating_page: pathname });
    assert.equal(p.calls[1].params.source_page, expected);
    assert.equal(p.calls[1].params.originating_page, expected);
    assert.doesNotMatch(JSON.stringify(p.calls), /person|example|private|[?#]/);
  }
  const p = page();
  for (const suffix of ['?email=person@example.com', '#person@example.com', '?email=person@example.com#secret']) {
    p.FL.formEvent('generate_lead', { application_id: String(p.calls.length), source_page: '/services/seo/' + suffix, originating_page: '/results/' + suffix });
    assert.equal(p.calls.at(-1).params.source_page, '/services/seo/');
    assert.equal(p.calls.at(-1).params.originating_page, '/results/');
  }
  assert.doesNotMatch(JSON.stringify(p.calls), /person|example|secret|[?#]/);
});

test('GA configuration and every later event receive safe locations before the loader runs', () => {
  const core = fs.readFileSync(new URL('../src/js/site.js', import.meta.url), 'utf8');
  for (const referrer of ['https://freelandme.com/person@example.com/?email=person@example.com#private', 'https://freelandme.com/results/?email=person@example.com#private', 'https://person@example.com/private', 'invalid', '']) {
    const calls = [], handlers = {}, storage = new Map();
    const location = { pathname: '/person@example.com/', search: '?email=person@example.com', hash: '#private', href: 'https://freelandme.com/person@example.com/?email=person@example.com#private' };
    const document = { referrer, documentElement: {}, addEventListener() {}, createElement: () => ({}), head: { appendChild() {
      // Even an immediately executing GA script must see sanitized defaults first.
      assert.deepEqual(calls.map(c => c[0]), ['set', 'js', 'config']);
      assert.equal(calls[0][1].page_location, 'https://freelandme.com/');
      assert.equal(calls[2][2].page_location, 'https://freelandme.com/');
    } } };
    const window = { FL: { ga: 'G-FIXTURE', env: 'production' }, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener: (name, cb) => handlers[name] = cb };
    const context = vm.createContext({ window, document, location, URL, URLSearchParams, sessionStorage: { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) }, gtag: (...args) => calls.push(args), setTimeout: cb => handlers.timer = cb });
    vm.runInContext(code, context); vm.runInContext(core, context);
    handlers.timer();
    const expectedRef = referrer.startsWith('https://freelandme.com/results/') ? 'https://freelandme.com/results/' : referrer.startsWith('https://freelandme.com/') ? 'https://freelandme.com/' : '';
    assert.equal(calls[0][1].page_referrer, expectedRef);
    assert.equal(calls[2][2].page_referrer, expectedRef);
    location.pathname = '/services/seo/';
    window.FL.track('fixture', { page_path: '/person@example.com/', source_page: '/unknown/', originating_page: '/results/?email=person@example.com', landing_path: '/blog/person@example.com/', last_cta_path: '/book/#private', page_location: location.href, page_referrer: referrer });
    const event = calls.at(-1);
    assert.equal(event[0], 'event');
    assert.deepEqual(JSON.parse(JSON.stringify(event[2])), { page_path: '/', source_page: '/', originating_page: '/results/', landing_path: '/blog/', last_cta_path: '/book/', page_location: 'https://freelandme.com/services/seo/', page_referrer: expectedRef });
    assert.equal(calls.at(-2)[0], 'set');
    assert.equal(calls.at(-2)[1].page_location, 'https://freelandme.com/services/seo/');
    assert.doesNotMatch(JSON.stringify(calls), /person|example|unknown|private|[?#]/);
    assert.equal(calls.filter(c => c[0] === 'config').length, 1);
  }
});

test('GA fails closed if attribution script is unavailable', () => {
  const calls = [];
  const window = { FL: { ga: 'G-FIXTURE', env: 'preview' }, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} };
  const document = { documentElement: {}, addEventListener() {}, createElement: () => ({}), head: { appendChild() {} } };
  vm.runInNewContext(fs.readFileSync(new URL('../src/js/site.js', import.meta.url), 'utf8'), { window, document, gtag: (...args) => calls.push(args), setTimeout() {} });
  window.FL.track('fixture', { page_path: '/person@example.com/', page_location: 'https://person@example.com/' });
  assert.equal(calls.find(c => c[0] === 'config')[2].page_location, 'https://freelandme.com/');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[2])), { page_path: '/', page_location: 'https://freelandme.com/', page_referrer: '', traffic_type: 'internal' });
  assert.doesNotMatch(JSON.stringify(calls), /person|example/);
});

for (const formType of ['roadmap', 'partner']) test(`${formType} rejection exposes neutral recovery and its retry can succeed`, async () => {
  let attempt = 0;
  const p = formPage({ formType, booking: 'https://calendar.example/', fetcher: async () => ({ status: 200, json: async () => ({ accepted: ++attempt > 1 }) }) });
  await p.submit();
  assert.equal(p.form.replacement, undefined);
  assert.equal(p.status.children[0].textContent, 'We could not confirm your application.');
  assert.equal(p.status.children[1].textContent, 'Try again or email Kevin.');
  assert.equal(p.status.attrs.role, 'status'); assert.equal(p.status.className, 'form-status');
  assert.doesNotMatch(p.status.textContent, /Application received|Pick a time|replies by email/);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 0);
  assert.equal(p.storage.has(`fl_app_${formType}_receipt`), false);
  const [retry, email] = p.status.children[2].children;
  assert.equal(email.attrs.href, 'mailto:kevin@freelandme.com');
  assert.equal(retry.attrs.type, 'button'); retryAvailable(p);
  assert.equal(p.form.elements.email.value, 'you@example.com');
  retry.handlers.click({ preventDefault() {} }); await flush();
  assert.equal(p.calls.length, 2);
  assert.equal(JSON.parse(p.calls[0][1].body).application_id, JSON.parse(p.calls[1][1].body).application_id);
  assert.equal(p.events.filter(e => e.name === 'generate_lead').length, 1);
  assert.equal(JSON.parse(p.storage.get(`fl_app_${formType}_receipt`)).accepted, true);
  assert.match(p.form.replacement.textContent, /Application received/);
});
function retryAvailable(p) {
  assert.equal(p.button.disabled, false);
  assert.equal(p.button.getAttribute('aria-busy'), null);
  assert.equal(p.status.hidden, false);
  assert.match(p.status.textContent, /again/i);
  assert.match(p.status.textContent, /kevin@freelandme.com/);
}
test('captcha loader expires at eight seconds and late loading cannot open or submit', async () => {
  const p = formPage({ captcha: true }); await p.submit();
  await p.time.advance(8000); retryAvailable(p);
  await p.load(); assert.equal(p.widgets.length, 0); assert.equal(p.calls.length, 0);
  await p.submit(); p.widgets[0].resolve({ response: 'retry-token' }); await flush(); assert.equal(p.calls.length, 1);
});
test('failed captcha script can reload on retry, while execution startup remains bounded', async () => {
  const p = formPage({ captcha: true }); await p.submit();
  p.scripts[0].onerror(); await flush(); retryAvailable(p);
  await p.submit(); assert.equal(p.scripts.length, 2); await p.load();
  await p.time.advance(8000); retryAvailable(p); assert.deepEqual(p.resets, [0]);
  p.widgets[0].resolve({ response: 'late-startup' }); await flush(); assert.equal(p.calls.length, 0);
  await p.submit(); p.widgets[1].resolve({ response: 'retry-token' }); await flush(); assert.equal(p.calls.length, 1);
});
test('visible captcha grants two minutes from opening, then resets and ignores stale tokens during retry', async () => {
  const p = formPage({ captcha: true }); await p.submit(); await p.load();
  await p.time.advance(7000); p.widgets[0].options['open-callback']();
  await p.time.advance(119999); assert.equal(p.button.disabled, true); assert.equal(p.calls.length, 0);
  await p.time.advance(1); retryAvailable(p); assert.deepEqual(p.resets, [0]); assert.deepEqual(p.removals, [0]);
  await p.submit(); p.widgets[0].resolve({ response: 'late-token' }); await flush(); assert.equal(p.calls.length, 0);
  p.widgets[1].options['open-callback'](); await p.time.advance(10000);
  p.widgets[1].resolve({ response: 'fresh-token' }); await flush(); assert.equal(p.calls.length, 1);
  assert.equal(JSON.parse(p.calls[0][1].body).hcaptcha_token, 'fresh-token');
  assert.equal(p.time.timers.size, 0);
});
for (const reason of ['close-callback', 'chalexpired-callback', 'expired-callback', 'error-callback']) {
  test(`captcha ${reason} restores retry and discards its late token`, async () => {
    const p = formPage({ captcha: true }); await p.submit(); await p.load();
    p.widgets[0].options[reason](); await flush(); retryAvailable(p);
    p.widgets[0].resolve({ response: 'late' }); await flush(); assert.equal(p.calls.length, 0);
  });
}
for (const audit of [false, true]) for (const stage of ['headers', 'body']) for (const abort of [true, false]) {
  test(`${audit ? 'site check' : 'application'} bounds stalled ${stage}, abort support ${abort}, and ignores late success`, async () => {
    const hung = deferred(); let attempt = 0;
    const success = { accepted: true, emailQueued: true };
    const p = formPage({ audit, abort, fetcher: async () => {
      attempt++;
      if (attempt > 1) return { status: 200, json: async () => success };
      return stage === 'headers' ? hung.promise : { status: 200, json: () => hung.promise };
    } });
    await p.submit(); await p.time.advance((audit ? 35000 : 30000) - 1); assert.equal(p.button.disabled, true);
    await p.time.advance(1); retryAvailable(p);
    if (abort) assert.equal(p.calls[0][1].signal.aborted, true);
    if (audit) assert.match(p.status.textContent, /could not confirm whether the report was emailed/);
    else assert.match(p.status.textContent, /It may have been received/);
    hung.resolve(stage === 'headers' ? { status: 200, json: async () => success } : success); await flush();
    assert.equal(p.form.replacement, undefined); assert.equal(p.window.location.href, undefined);
    assert.equal(p.events.filter(e => ['generate_lead', 'site_check_submit'].includes(e.name)).length, 0);
    await p.submit(); assert.equal(p.calls.length, 2);
    await p.time.advance(150);
    assert.equal(p.events.filter(e => ['generate_lead', 'site_check_submit'].includes(e.name)).length, 1);
    assert.equal(p.time.timers.size, 0);
  });
}
for (const audit of [false, true]) test(`${audit ? 'site check' : 'application'} clears deadline after normal success and does not show a late error`, async () => {
  const p = formPage({ audit }); await p.submit(); await p.time.advance(40000);
  assert.equal(p.events.filter(e => e.name === 'form_error').length, 0);
  assert.equal(p.time.timers.size, 0);
});

const motionCode = fs.readFileSync(new URL('../src/js/site.js', import.meta.url), 'utf8');
function motionPage({ reduced = false, width = 1200 } = {}) {
  const root = element(), stack = element(), reveal = element(), count = element('$17.94'), observers = [], frames = new Map(), media = [];
  count.dataset = { countTo: '17.94', countFrom: '26.75', prefix: '$', decimals: '2' };
  const panels = [element(), element()], cards = panels.map(panel => ({ ...element(), querySelector: () => panel }));
  stack.querySelectorAll = () => cards;
  let id = 0, now = 0, pins = 0, contexts = [], current;
  const matches = query => (!query.includes('min-width') || width >= Number(query.match(/min-width: (\d+)/)[1])) && (!query.includes('prefers-reduced-motion') || (query.includes('no-preference') ? !reduced : reduced));
  const matchMedia = query => { const item = { matches: matches(query), query, callbacks: [], addEventListener(_name, fn) { this.callbacks.push(fn); } }; media.push(item); return item; };
  const gsap = { registerPlugin() {}, utils: { toArray: x => x }, to(panel, config) { panel.style.transform = `scale(${config.scale})`; panel.style['--dim'] = config['--dim']; }, matchMedia: () => ({ add(query, fn) { const context = { query, fn, cleanup: null, pins: 0 }; contexts.push(context); run(context); } }) };
  function run(context) { if (matches(context.query)) { current = context; context.cleanup = context.fn(); current = null; } }
  const ScrollTrigger = { create() { pins++; current.pins++; }, refresh() {} };
  class Observer { constructor(callback, options) { this.callback = callback; this.options = options; this.disconnected = false; observers.push(this); } observe() {} unobserve() {} disconnect() { this.disconnected = true; } }
  let boot;
  const window = { matchMedia, gsap, ScrollTrigger, IntersectionObserver: Observer, addEventListener() {} };
  const document = { documentElement: root, body: element(), getElementById: () => null, createElement: () => element(), addEventListener(name, fn) { if (name === 'DOMContentLoaded') boot = fn; }, querySelector: selector => selector === '[data-stack]' ? stack : null, querySelectorAll: selector => selector === '.reveal' ? [reveal] : selector === '[data-count-to]' ? [count] : [] };
  vm.runInNewContext(motionCode, { window, document, gsap, ScrollTrigger, IntersectionObserver: Observer, gtag() {}, setTimeout() {}, performance: { now: () => now }, requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); } });
  boot();
  return { root, stack, count, cards, panels, observers, frames, pins: () => pins,
    change(next) {
      reduced = next.reduced ?? reduced; width = next.width ?? width;
      for (const item of media) { const value = matches(item.query); if (value !== item.matches) { item.matches = value; item.callbacks.forEach(fn => fn(item)); } }
      for (const ctx of contexts) { if (ctx.cleanup && !matches(ctx.query)) { pins -= ctx.pins; ctx.pins = 0; ctx.cleanup(); ctx.cleanup = null; } else if (!ctx.cleanup && matches(ctx.query)) run(ctx); }
    },
    countObserver: () => observers.filter(o => o.options?.threshold === 0.6).at(-1),
    frame() { now += 300; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); }
  };
}
test('live reduced motion reverts stack styles, cancels counts and observers, and survives resizing', () => {
  const p = motionPage(); assert.equal(p.pins(), 1); assert.ok(p.stack.classList.contains('stack-enhanced'));
  const cio = p.countObserver(); cio.callback([{ isIntersecting: true, target: p.count }]); p.frame();
  assert.notEqual(p.count.textContent, '$17.94'); assert.equal(p.frames.size, 1);
  const staleFrame = [...p.frames.values()][0]; p.change({ reduced: true });
  assert.equal(p.pins(), 0); assert.equal(p.stack.classList.contains('stack-enhanced'), false); assert.equal(p.root.classList.contains('motion-ready'), false);
  for (const el of [...p.cards, ...p.panels]) { assert.equal(el.style.transform, undefined); assert.equal(el.style['--dim'], undefined); assert.equal(el.style.zIndex, undefined); }
  assert.equal(p.frames.size, 0); assert.equal(p.count.textContent, '$17.94'); assert.ok(p.observers.every(o => o.disconnected));
  staleFrame(900); cio.callback([{ isIntersecting: true, target: p.count }]); assert.equal(p.count.textContent, '$17.94'); assert.equal(p.frames.size, 0);
  p.change({ width: 700 }); p.change({ width: 1200 }); assert.equal(p.pins(), 0);
  p.change({ reduced: false }); assert.equal(p.pins(), 1); assert.ok(p.stack.classList.contains('stack-enhanced')); assert.ok(p.root.classList.contains('motion-ready'));
  assert.notEqual(p.countObserver(), cio); assert.equal(p.countObserver().disconnected, false);
  p.change({ width: 700 }); assert.equal(p.pins(), 0); assert.equal(p.panels[0].style.transform, undefined); assert.equal(p.cards[0].style.zIndex, undefined);
  p.change({ width: 1200 }); assert.equal(p.pins(), 1);
});
test('initial reduced motion can enable all motion without a reload', () => {
  const p = motionPage({ reduced: true }); assert.equal(p.pins(), 0); assert.equal(p.observers.length, 0);
  p.change({ reduced: false }); assert.equal(p.pins(), 1); assert.equal(p.observers.length, 2);
  p.countObserver().callback([{ isIntersecting: true, target: p.count }]); assert.equal(p.frames.size, 1);
  p.change({ reduced: true }); assert.equal(p.frames.size, 0); assert.equal(p.count.textContent, '$17.94');
});
