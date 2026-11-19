import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent } from 'domutils';
import nunjucks from 'nunjucks';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(fs.readFileSync(path.resolve(site, '../_rebuild-docs/migration-baseline.json')));
const dash = s => s.replace(/[\u2013\u2014]/g, ' - ');
// Deliberate post-migration edits (Phase 5/6 copy and SEO passes) are recorded per slug so every other field stays pinned.
const approved = JSON.parse(fs.readFileSync(path.join(site, 'scripts/migration-approved-edits.json'), 'utf8'));
test('all 21 posts retained', () => assert.equal(baseline.length, 21));
for (const record of baseline) test(`migration retains metadata, dates, schema types and images: ${record.slug}`, () => {
  const source = fs.readFileSync(path.join(site, 'src/blog', record.slug, 'index.njk'), 'utf8');
  const data = JSON.parse(source.split('---')[1]);
  const ok = approved[record.slug] || {};
  assert.equal(data.title, ok.title ?? dash(record.before.title)); assert.equal(data.description, ok.description ?? dash(record.before.description));
  assert.equal('https://freelandme.com' + data.canonicalPath, record.before.canonical);
  const doc = parseDocument(fs.readFileSync(path.join(site, '_site/blog', record.slug, 'index.html'), 'utf8'));
  const nodes = findAll(n => !!n.name, doc.children);
  const schema = JSON.parse(textContent(nodes.find(n => n.name === 'script' && n.attribs.type === 'application/ld+json')))['@graph'];
  for (const old of record.before.schema) {
    const current = schema.find(n => n['@type'] === old['@type']); assert.ok(current, old['@type']);
    for (const key of ['datePublished', 'dateModified', 'image']) if (old[key]) assert.deepEqual(current[key], key === 'dateModified' && ok.dateModified ? ok.dateModified : old[key]); // dateModified moves only through an approved edit (rewritten body, launch day)
  }
  const images = nodes.flatMap(n => [n.attribs.src, n.attribs.srcset].filter(Boolean));
  // Legacy full-size WebP sources are replaced with sized AVIF/WebP variants;
  // the original fallback photograph must remain the same.
  for (const image of record.imageRefs.filter(image => !image.endsWith('.webp') && !(ok.removedImages || []).includes(image))) assert.ok(images.includes(image), image);
  assert.ok(nodes.some(n => n.name === 'a' && n.attribs.href === '/growth-roadmap/' && n.attribs['data-cta']));
  assert.ok(nodes.some(n => n.name === 'a' && n.attribs.href === '/results/'));
});
test('unpublished cases produce no case pages', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(site, 'src/_data/proof.json')));
  for (const c of proof.cases) { assert.equal(c.published, false); assert.equal(c.result, null); assert.equal(fs.existsSync(path.join(site, '_site/results', c.slug, 'index.html')), false); }
});
test('case template can render a future approved case with article and breadcrumb nodes', () => {
  const source = fs.readFileSync(path.join(site, 'src/results/case.njk'), 'utf8').split('---').slice(2).join('---');
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(site, 'src/_includes')), { autoescape: true });
  const siteData = JSON.parse(fs.readFileSync(path.join(site, 'src/_data/site.json')));
  const html = env.renderString(source, { site: siteData, env: {}, buildDate: { iso: '2026-11-18', year: 2026 }, page: { url: '/results/fixture/' }, title: 'Fixture case', description: 'Test only', case: { slug: 'fixture', client: 'Fixture', title: 'Fixture case', summary: 'Test only', before: 'Before', work: 'Work', after: 'After', meaning: 'Meaning' } });
  const doc = parseDocument(html), nodes = findAll(n => !!n.name, doc.children);
  assert.equal(nodes.filter(n => n.name === 'h1').length, 1);
  const graphs = nodes.filter(n => n.name === 'script' && n.attribs.type === 'application/ld+json'); assert.equal(graphs.length, 1);
  const graph = JSON.parse(textContent(graphs[0]))['@graph']; assert.ok(graph.some(n => n['@type'] === 'Article')); assert.ok(graph.some(n => n['@type'] === 'BreadcrumbList'));
});
test('only eight service pages remain', () => {
  const dir = path.join(site, 'src/services');
  assert.equal(fs.readdirSync(dir).filter(name => fs.existsSync(path.join(dir, name, 'index.njk'))).length, 8);
});
