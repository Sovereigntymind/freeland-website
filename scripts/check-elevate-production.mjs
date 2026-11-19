// Run after an explicit FL_ENV=production NODE_ENV=production build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { findAll } from 'domutils';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(site, file), 'utf8');
const manifest = JSON.parse(read('_site/build-pages.json'));
const xml = read('_site/sitemap.xml');
const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
const excluded = [], included = [];
assert.equal(manifest.length, 53); // 53 since the SEO intake confirmation page (noindex) was added
for (const page of manifest) {
  const html = fs.readFileSync(path.resolve(site, page.outputPath), 'utf8');
  const noindex = findAll(n => n.name === 'meta' && n.attribs.name === 'robots' && /noindex/.test(n.attribs.content), parseDocument(html).children).length > 0;
  (noindex ? excluded : included).push(page.url);
  assert.equal(urls.includes('https://freelandme.com' + page.url), !noindex, page.url);
}
assert.equal(urls.length, 41);
assert.equal(new Set(urls).size, 41);
assert.equal(excluded.length, 12);
assert.deepEqual([...urls].sort(), included.map(url => 'https://freelandme.com' + url).sort());
for (const slug of ['google-ads-checklist', 'lead-follow-up', 'meta-ads-playbook']) assert.ok(excluded.includes('/' + slug + '/'));
assert.match(read('_site/robots.txt'), /^Allow: \/$/m);
assert.doesNotMatch(read('_site/robots.txt'), /^Disallow: \/$/m);
assert.doesNotMatch(read('_site/_headers'), /X-Robots-Tag: noindex/);
console.log(`Production check passed: ${manifest.length} HTML pages; ${urls.length} unique sitemap URLs; ${excluded.length} noindex pages excluded.`);
console.log('Excluded: ' + excluded.sort().join(', '));
