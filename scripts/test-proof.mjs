import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent } from 'domutils';
import { checkProof, attribution, copyForPunctuation } from './proof-checks.mjs';
import { visible } from './site-content-checks.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proof = JSON.parse(fs.readFileSync(path.join(site, 'src/_data/proof.json')));
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(site, 'src/_includes')), { autoescape: true });
const render = (selection, data = proof) => env.renderString('{% from "partials/reviews.njk" import reviews %}{{ reviews(proof, ids=ids, tag=tag, limit=limit) }}', { proof: data, ids: [], tag: '', limit: 0, ...selection });
const elements = html => findAll(n => !!n.name, parseDocument(html).children);
const renderedIds = html => elements(html).filter(n => n.name === 'figure').map(n => n.attribs['data-review-id']);

test('all 14 live Google reviews match the full raw source, exact names and contiguous excerpts', () => {
  const selection = JSON.parse(fs.readFileSync(path.resolve(site, '../_rebuild-docs/REVIEW-SELECTION.json')));
  const raw = fs.readFileSync(path.resolve(site, '../_rebuild-docs/google-reviews-raw-full-2026-11-19.txt'), 'utf8').replace(/\r\n/g, '\n');
  const verified = proof.reviews.filter(r => r.verifiedVerbatim);
  assert.equal(verified.length, 14);
  assert.deepEqual(verified.map(r => r.name), selection.reviews.map(r => r.nameOnGoogle));
  for (const review of verified) {
    const selected = selection.reviews.find(r => r.id === review.id);
    const section = raw.split(review.name + '\n')[1];
    const original = section.split(/\d+ months ago\n/)[1].split('\n\ue8dc')[0].trim();
    assert.equal(review.text, original, review.id);
    assert.equal(review.excerpt, selected.excerpt.replace(/\n\ue8dc$/, ''), review.id);
    assert.ok(review.text.includes(review.excerpt), review.id);
    assert.deepEqual(review.tags, selected.tags);
    assert.equal(review.business, null, 'No business is shown separately in the live source');
    assert.equal(review.pulledAt, '2026-11-19');
    assert.equal(review.sourceFile, '_rebuild-docs/google-reviews-raw-full-2026-11-19.txt');
    assert.equal(review.sourceUrl, 'https://www.google.com/maps?cid=12454933700455021390');
  }
  assert.equal(proof.reviews.length, 15, 'Historical Debra inventory is withheld, distinct from the 14 current reviews');
  assert.equal(proof.reviews.find(r => r.id === 'google-debra-mauro').verifiedVerbatim, false);
  assert.equal(proof.googleProfile.reviewCount, 14);
  assert.equal(proof.googleProfile.verifiedTextCount, 14);
  assert.equal(proof.googleProfile.rating, 5);
  assert.equal(proof.letters.length, 5);
  assert.deepEqual(proof.letters.filter(r => r.cleared).map(r => r.id), ['letter-joe-miller', 'letter-tokyo-japanese-steakhouse', 'letter-debbie-mauro', 'letter-sasha-gooray', 'letter-hazem-cmr']);
  const letters = JSON.parse(fs.readFileSync(path.resolve(site, '../_rebuild-docs/LETTER-SELECTION.json')));
  for (const selected of letters.letters) {
    const letter = proof.letters.find(r => r.id === selected.id);
    assert.equal(letter.verifiedVerbatim, true);
    assert.equal(letter.cleared, selected.cleared);
    if (['letter-debbie-mauro', 'letter-sasha-gooray'].includes(letter.id)) assert.equal(letter.clearanceSource, 'Kevin 2026-11-19');
    assert.equal(letter.excerpt, selected.excerpts[0]);
    assert.equal(letter.text, selected.fullTextNormalized);
    assert.deepEqual(letter.excerpts, selected.excerpts);
    for (const excerpt of letter.excerpts) assert.ok(letter.text.includes(excerpt));
  }
  assert.equal(proof.letters.find(r => r.id === 'letter-hazem-cmr').verifiedVerbatim, false);
  const entries = [...proof.reviews, ...proof.letters];
  assert.equal(new Set(entries.map(r => r.id)).size, entries.length);
  const tags = new Set(['website-design', 'google-ads-management', 'meta-ads', 'ai-automation', 'email-marketing-automation', 'influencer-affiliate', 'seo', 'social-media-management', 'kevin', 'results', 'call']);
  for (const entry of entries) {
    assert.ok(entry.name || entry.business); assert.ok(entry.sourceFile);
    assert.ok((entry.text || entry.excerpt).trim());
    assert.equal(typeof entry.verifiedVerbatim, 'boolean'); assert.equal(typeof entry.cleared, 'boolean');
    assert.ok(entry.tags.every(tag => tags.has(tag)));
  }
});

test('selector preserves explicit order, filters before limit, and withholds all ineligible entries', () => {
  const ids = ['google-robert-s', 'google-sasha-gooray'];
  const html = render({ ids });
  assert.deepEqual(renderedIds(html), ids); assert.deepEqual(checkProof(html, proof), []);
  assert.deepEqual(renderedIds(render({ tag: 'website-design', limit: 1 })), ['google-sasha-gooray']);
  assert.deepEqual(renderedIds(render({ ids: ['google-debra-mauro', ...ids], limit: 1 })), ['google-robert-s']);
  assert.deepEqual(renderedIds(render({ ids: proof.letters.map(r => r.id) })), ['letter-joe-miller', 'letter-tokyo-japanese-steakhouse', 'letter-debbie-mauro', 'letter-sasha-gooray']);
  assert.deepEqual(renderedIds(render({ ids: ['google-yallboi-foxsin', 'google-debra-mauro'] })), []);
  assert.deepEqual(renderedIds(render({ ids: ['google-richard-steele'] })), []);
  assert.deepEqual(renderedIds(render({})), []);
  assert.ok(checkProof(render({ ids: ['missing'] }), proof).some(e => e.includes('Unknown review id')));
});

test('approved future letters use a separate heading and never expose internal paths as cite', () => {
  const data = structuredClone(proof); data.letters[0].verifiedVerbatim = true;
  const html = render({ ids: ['google-sasha-gooray', 'letter-joe-miller'] }, data);
  const all = elements(html);
  assert.deepEqual(all.filter(n => n.name === 'h2').map(textContent), ['Selected Google reviews', 'Letters']);
  assert.equal(all.filter(n => n.name === 'blockquote')[1].attribs.cite, undefined);
  assert.ok(!html.includes(data.letters[0].sourceFile)); assert.deepEqual(checkProof(html, data), []);
  data.letters[0].sourceUrl = 'file:///private.pdf';
  assert.equal(elements(render({ ids: ['letter-joe-miller'] }, data)).find(n => n.name === 'blockquote').attribs.cite, undefined);
});

const fixtures = JSON.parse(fs.readFileSync(path.join(site, 'scripts/fixtures/proof-negative.json')));
for (const fixture of fixtures) test(`proof gate rejects ${fixture.name}`, () => {
  const data = structuredClone(proof);
  if (fixture.entry) data.letters = [...data.letters.filter(r => r.id !== fixture.id), structuredClone(fixture.entry)];
  const entry = [...data.reviews, ...data.letters].find(r => r.id === fixture.id);
  if (fixture.verified !== undefined) entry.verifiedVerbatim = fixture.verified;
  const html = env.renderString('<figure data-review-id="{{ id }}"><blockquote cite="{{ cite }}">{{ quote }}</blockquote><figcaption>{{ caption }}</figcaption></figure>', {
    id: fixture.id, cite: fixture.cite ?? entry?.sourceUrl, quote: fixture.quote ?? entry?.text ?? entry?.excerpt ?? 'Unknown', caption: fixture.caption ?? (entry ? attribution(entry) : 'Unknown')
  });
  assert.ok(checkProof(html, data).some(error => error.includes(fixture.error)), fixture.name);
  if (fixture.entry) {
    assert.deepEqual(renderedIds(render({ ids: [fixture.id] }, data)), [], fixture.name);
    assert.ok(checkProof(html, data, '/').some(error => error.includes(fixture.error)), fixture.name);
  }
});

test('removing the proof id cannot bypass validation; legacy exception is exact and page-bound', () => {
  assert.ok(checkProof(render({ ids: ['google-sasha-gooray'] }).replace('data-review-id="google-sasha-gooray"', ''), proof).length);
  const legacy = proof.trackRecord.find(r => r.id === 'sasha-existing');
  const html = `<figure><blockquote>“${legacy.claim}”</blockquote><figcaption>${legacy.attribution}</figcaption></figure>`;
  assert.deepEqual(checkProof(html, proof, '/'), []);
  assert.ok(checkProof(html, proof, '/about/').length);
  assert.ok(checkProof(html.replace('90%', '100%'), proof, '/').length);
  assert.ok(checkProof(html.replace('Sasha', 'Someone'), proof, '/').length);
});

test('verbatim review punctuation survives without exempting altered quotes or surrounding copy', () => {
  const data = structuredClone(proof); delete data.reviews.find(r => r.id === 'google-robert-s').excerpt;
  const html = render({ ids: ['google-robert-s'] }, data);
  const hasDash = html => /[\u2013\u2014]/.test(visible(copyForPunctuation(html, data)));
  assert.match(html, /\u2014/);
  assert.equal(hasDash(html), false);
  assert.equal(hasDash(html + '<p>Nearby\u2014copy</p>'), true);
  assert.equal(hasDash(html.replace('nothing short of exceptional', 'rewritten')), true);
  assert.equal(hasDash(html.replace('Robert S</span>', 'Other person</span>')), true);
  assert.equal(hasDash(html.replace('google-robert-s', 'google-jakim-hartford')), true);
});

test('all completed build pages pass the proof gate', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(site, '_site/build-pages.json')));
  for (const page of manifest) {
    const html = fs.readFileSync(path.resolve(site, page.outputPath), 'utf8');
    assert.deepEqual(checkProof(html, proof, page.url), [], page.url);
  }
});

test('every selected page renders the approved Google IDs in order, with separate cleared letters', () => {
  const selection = JSON.parse(fs.readFileSync(path.resolve(site, '../_rebuild-docs/REVIEW-SELECTION.json')));
  for (const [placement, ids] of Object.entries(selection.placements)) {
    const slug = placement.split(' (')[0];
    const file = slug === 'home' ? '_site/index.html' : `_site/${slug}/index.html`;
    const html = fs.readFileSync(path.join(site, file), 'utf8');
    assert.deepEqual(renderedIds(html).filter(id => id?.startsWith('google-')), ids, placement);
    const all = elements(html);
    assert.ok(all.some(n => n.name === (['home', 'results', 'growth-roadmap'].includes(slug) ? 'h3' : 'h2') && textContent(n) === 'Selected Google reviews'), placement);
    assert.ok(all.some(n => n.name === 'a' && textContent(n) === 'See all reviews on Google' && n.attribs.href === proof.googleProfile.sourceUrl));
    assert.deepEqual(renderedIds(html).filter(id => id?.startsWith('letter-')), slug === 'results' ? ['letter-joe-miller', 'letter-tokyo-japanese-steakhouse', 'letter-debbie-mauro', 'letter-sasha-gooray'] : []);
    if (slug === 'results') {
      const letters = all.find(n => n.name === 'section' && n.attribs['aria-label'] === 'Letters');
      assert.ok(letters);
      assert.deepEqual(findAll(n => n.name === 'figure', letters.children).map(n => n.attribs['data-review-id']), ['letter-joe-miller', 'letter-tokyo-japanese-steakhouse', 'letter-debbie-mauro', 'letter-sasha-gooray']);
    }
  }
  const roadmap = elements(fs.readFileSync(path.join(site, '_site/growth-roadmap/index.html'), 'utf8'));
  const beside = roadmap.find(n => n.attribs.class === 'apply-copy');
  assert.ok(findAll(n => n.attribs?.['data-review-id'] === 'google-brody-guy', beside.children).length);
});

test('invalid excerpts, omitted source links and missing customer-reported context fail the gate', () => {
  const data = structuredClone(proof);
  data.reviews[0].excerpt = 'A fabricated excerpt.';
  assert.ok(checkProof(render({ ids: [data.reviews[0].id] }, data), data).some(e => e.includes('Invalid excerpt')));
  const html = render({ ids: ['google-sasha-gooray'] });
  assert.ok(checkProof(html.replace('See our Google reviews', 'Read more'), proof).some(e => e.includes('Missing Google reviews link')));
  const joe = proof.letters.find(r => r.id === 'letter-joe-miller');
  assert.ok(checkProof(render({ ids: [joe.id] }).replace(joe.contextLabel, ''), proof).some(e => e.includes('Missing proof context')));
});

test('Google Ads uses only the cleared Debbie letter and Hazem never renders on any page', () => {
  const html = fs.readFileSync(path.join(site, '_site/services/google-ads-management/index.html'), 'utf8');
  assert.deepEqual(renderedIds(html), ['letter-debbie-mauro']);
  const group = elements(html).find(n => n.attribs['aria-label'] === 'Letters');
  assert.ok(group);
  assert.deepEqual(renderedIds(render({ ids: ['letter-hazem-cmr'] })), []);
  for (const page of JSON.parse(fs.readFileSync(path.join(site, '_site/build-pages.json')))) {
    assert.ok(!renderedIds(fs.readFileSync(path.resolve(site, page.outputPath), 'utf8')).includes('letter-hazem-cmr'), page.url);
  }
});
