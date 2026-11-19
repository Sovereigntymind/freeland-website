/* Session attribution and confirmed-lead events. No email or store URL enters analytics. */
(function () {
  'use strict';
  var FL = window.FL = window.FL || {};
  var memory = {};
  function read(key, fallback) {
    try { return JSON.parse(sessionStorage.getItem(key)) || memory[key] || fallback; }
    catch (_) { return memory[key] || fallback; }
  }
  function write(key, value) {
    memory[key] = value;
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* Private mode: retain this page's state. */ }
  }
  function clean(value, cap) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, cap); }
  // One allowlist for every analytics path, including stored attribution.
  function path(value) {
    var p = String(value || '').split(/[?#]/)[0];
    var pages = ['/', '/about/', '/results/', '/services/', '/how-it-works/', '/growth-roadmap/', '/book/', '/partners/', '/faq/', '/for/supplement-brands/', '/free-business-audit/', '/meta-ads-playbook/', '/google-ads-checklist/', '/lead-follow-up/', '/llm-info/'];
    var services = ['meta-ads', 'google-ads-management', 'website-design', 'ai-automation', 'email-marketing-automation', 'influencer-affiliate', 'seo', 'social-media-management'];
    if (pages.indexOf(p) !== -1 || services.some(function (slug) { return p === '/services/' + slug + '/'; })) return p;
    var guides = ["ai-automation-services-florida", "best-marketing-tools-for-businesses-2026", "content-marketing-strategy-small-business", "crm-automation-florida-small-business", "email-marketing-small-business", "google-ads-management-florida-small-business", "google-business-profile-setup-florida", "how-florida-small-businesses-can-dominate-social-media-2026", "how-much-does-a-website-cost", "how-to-automate-lead-follow-up", "how-to-generate-leads-for-your-business", "how-to-get-more-google-reviews", "how-to-run-facebook-ads", "local-seo-guide-florida-small-business", "social-media-management-florida-small-business", "video-marketing-small-business", "website-design-florida-small-business", "what-is-a-crm", "what-is-ai-automation-and-how-it-transforms-small-business", "what-is-social-media-marketing", "why-hire-marketing-agency"];
    if (guides.some(function (slug) { return p === '/blog/' + slug + '/'; })) return p;
    return p.indexOf('/blog/') === 0 ? '/blog/' : '/';
  }
  FL.analyticsPath = path;
  FL.analyticsContext = function () {
    var base = 'https://freelandme.com', referrer = '';
    try {
      var ref = new URL(document.referrer);
      if (ref.origin === base) referrer = base + path(ref.pathname);
    } catch (_) { /* Missing, external or malformed referrers are omitted. */ }
    return { page_location: base + path(location.pathname), page_referrer: referrer };
  };
  var stored = read('fl_attr', {}), utm = {}, query = new URLSearchParams(location.search);
  ['source', 'medium', 'campaign', 'term', 'content'].forEach(function (key) {
    utm[key] = clean(stored.landing_path ? (stored.utm || {})[key] : query.get('utm_' + key), 100);
  });
  var attr = { landing_path: path(stored.landing_path || location.pathname), last_cta_id: clean(stored.last_cta_id, 100), last_cta_path: stored.last_cta_path ? path(stored.last_cta_path) : '', utm: utm };
  attr.originating_page = path(stored.originating_page || stored.landing_path || location.pathname);
  write('fl_attr', attr);
  FL.attribution = function () { return JSON.parse(JSON.stringify(attr)); };
  FL.internal = FL.internal || read('fl_internal', false) === true;
  FL.markInternal = function () { FL.internal = true; write('fl_internal', true); };
  document.addEventListener('click', function (event) {
    var element = event.target.closest && event.target.closest('[data-cta]');
    if (!element) return;
    attr.last_cta_id = clean(element.getAttribute('data-cta'), 100);
    if (['/growth-roadmap/', '/book/', '/partners/'].indexOf(location.pathname) === -1) attr.originating_page = path(location.pathname);
    attr.last_cta_path = path(location.pathname); write('fl_attr', attr);
    if (FL.track) FL.track('cta_click', { cta_id: attr.last_cta_id, page_path: attr.last_cta_path });
  });
  var eventKeys = {
    form_start: ['form_id'],
    form_error: ['form_id', 'error_type'],
    generate_lead: ['form_id', 'application_id', 'revenue_band', 'main_channel', 'source_page', 'cta_id', 'originating_page']
  };
  FL.formEvent = function (name, input, response) {
    if (!Object.prototype.hasOwnProperty.call(eventKeys, name)) return;
    input = input || {};
    if ((response && response.test === true) || input.test === true || input.status === 'test' || input.delivery_mode === 'test_delivery') FL.markInternal();
    if (!FL.track) return;
    var params = {};
    eventKeys[name].forEach(function (key) {
      if (typeof input[key] === 'string') params[key] = ['source_page', 'originating_page'].indexOf(key) !== -1 ? path(input[key]) : clean(input[key], 100);
    });
    if (name === 'generate_lead') {
      if (!params.application_id) return;
      var leads = read('fl_leads', []); if (!Array.isArray(leads)) leads = [];
      if (leads.indexOf(params.application_id) !== -1) return;
      leads.push(params.application_id); write('fl_leads', leads);
    }
    if (FL.env === 'preview' || window.FL_ENV === 'preview' || FL.internal) params.traffic_type = 'internal';
    FL.track(name, params);
  };
})();
