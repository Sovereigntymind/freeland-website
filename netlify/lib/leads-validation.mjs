const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bands = ['under-50k', '50k-250k', '250k-1m', 'over-1m'];
const channels = ['Meta', 'Google', 'TikTok', 'Amazon', 'Email and SMS', 'Other'];
const roles = ['Founder', 'Marketing lead', 'Other'];
export function validate(input) {
  const errors = {};
  const string = (value, key, cap, required = true) => {
    if (typeof value !== 'string' || value.length > cap || (required && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) {
      errors[key] = `Add a valid ${key.replaceAll('_', ' ')} (up to ${cap} characters).`;
      return '';
    }
    return value.trim();
  };
  if (!object(input)) return { errors: { form: 'Send a JSON object.' } };
  // Check the trap before validation, including whitespace, controls and oversize values.
  if (input.hp_company_url != null && input.hp_company_url !== '') return { errors, silent: true };
  const id = string(input.application_id, 'application_id', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) errors.application_id = 'Reload the form and try again.';
  const type = input.form_type;
  if (!['roadmap', 'partner'].includes(type)) errors.form_type = 'Choose a valid form.';
  const fields = {};
  const raw = object(input.fields) && object(input.fields[type]) ? input.fields[type] : {};
  const allowed = type === 'roadmap' ? ['store_url', 'revenue_band', 'main_channel', 'role', 'email'] : ['agency_name', 'agency_website', 'client_count', 'services', 'email'];
  if (!object(input.fields) || Object.keys(input.fields).some(k => k !== type) || Object.keys(raw).some(k => !allowed.includes(k))) errors.fields = 'Send only fields for this form.';
  for (const key of allowed) {
    const value = ['agency_name', 'services'].includes(key) && typeof raw[key] === 'string'
      ? raw[key].replace(/<[^>]*>/g, '').replace(/[<>\u0000-\u001f\u007f]/g, '') : raw[key];
    fields[key] = string(value, key, { email: 254, store_url: 500, agency_website: 500, agency_name: 120, services: 500 }[key] || 40);
  }
  fields.email = fields.email.toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(fields.email)) errors.email = 'Add a valid email.';
  const urlKey = type === 'roadmap' ? 'store_url' : 'agency_website';
  try {
    const url = new URL(fields[urlKey]);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith('.local')) throw new Error();
    fields[urlKey] = url.href;
  } catch { errors[urlKey] = 'Add a full website URL, such as https://yourstore.com.'; }
  for (const [key, values] of Object.entries(type === 'roadmap' ? { revenue_band: bands, main_channel: channels, role: roles } : { client_count: ['1-5', '6-20', '21-50', '50+'] })) {
    if (!values.includes(fields[key])) errors[key] = 'Choose one of the listed options.';
  }
  const source = input.attribution ?? {};
  if (!object(source) || (source.utm !== undefined && !object(source.utm))) errors.attribution = 'Invalid attribution.';
  const attribution = {};
  for (const key of ['landing_path', 'last_cta_id', 'last_cta_path']) {
    attribution[key] = string(source[key] ?? '', key, key === 'last_cta_id' ? 100 : 200, false);
    if (key.endsWith('path') && attribution[key] && !/^\/(?!\/)[^?#\\\s]*$/.test(attribution[key])) errors[key] = 'Use a page path without query parameters.';
  }
  attribution.utm = {};
  for (const key of ['source', 'medium', 'campaign', 'term', 'content']) attribution.utm[key] = string(source.utm?.[key] ?? '', `utm_${key}`, 100, false);
  const token = string(input.hcaptcha_token ?? '', 'hcaptcha_token', 8192, false);
  if (!Number.isSafeInteger(input.elapsed_ms) || input.elapsed_ms < 0 || input.elapsed_ms > 86400000) errors.elapsed_ms = 'Reload the form and try again.';
  return { errors, id: id.toLowerCase(), type, fields, attribution, token, silent: input.elapsed_ms < 2500 };
}

export function eligible(type, fields, floor) {
  if (type !== 'roadmap') return false;
  if (floor === null) return true;
  const amounts = [0, 50000, 250000, 1000000];
  return amounts[bands.indexOf(fields.revenue_band)] >= Number(floor) && ['Founder', 'Marketing lead'].includes(fields.role);
}
