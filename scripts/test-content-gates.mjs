import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent } from 'domutils';
import { hasPrice, hasVisiblePrice, isBlocking, readPdfFiles, requiredPdfs, hasUnsourcedClaim, hasPageClaim } from './site-content-checks.mjs';
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('price gate catches digit and spelled-out money, including split markup and entities', () => {
  for (const text of ['$99', '$ 20', 'a few hundred bucks', 'two thousand dollars', 'five grand', 'one dollar', 'a buck']) assert.ok(hasPrice(text), text);
  assert.ok(hasVisiblePrice('<p>Five <strong>grand</strong></p>'));
  assert.ok(hasVisiblePrice('<p>&#36;40</p>'));
  assert.ok(hasVisiblePrice('<p>do<span>ll</span>ars</p>'));
  for (const text of ['scope and maintenance', 'grandfather', '2.7x return']) assert.equal(hasPrice(text), false);
});
test('data-proof permits internal track-record money, without exempting nearby copy', () => {
  assert.equal(hasVisiblePrice('<div data-proof><p>$26.75 to $17.94</p><span>five dollars</span></div>'), false);
  assert.ok(hasVisiblePrice('<div data-proof>$17.94</div><p>a few bucks</p>'));
  assert.equal(hasVisiblePrice('<script>"five grand"</script><style>.dollars {}</style>'), false);
});
test('stale output and PDF prices block even in codex-only mode', () => {
  for (const check of ['stale-output', 'pdf-price', 'pdf-required', 'unsourced-claim']) assert.ok(isBlocking({ owner: 'integration', check }, 'codex-only'));
  assert.equal(isBlocking({ owner: 'integration', check: 'title' }, 'codex-only'), false);
  assert.ok(isBlocking({ owner: 'integration', check: 'title' }, 'whole-site'));
});
// Real, compressed PDF fixture: extraction must inspect the final binary, not HTML.
function pdf(text) {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 20 100 Td (${text}) Tj ET`));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream')])];
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.concat(parts).length);
    parts.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n'));
  });
  const xref = Buffer.concat(parts).length;
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(parts);
}
function pdfFixture(t) {
  const dir = fs.mkdtempSync(path.join(site, '_test-pdfs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const directory of ['src/downloads', '_site/downloads']) {
    fs.mkdirSync(path.join(dir, directory), { recursive: true });
    for (const name of requiredPdfs) fs.writeFileSync(path.join(dir, directory, name), pdf('A useful marketing guide.'));
  }
  return dir;
}
test('final PDF gate reads both directories and every PDF, without precursor HTML', t => {
  const dir = pdfFixture(t);
  assert.equal(readPdfFiles(dir).sources.length, 6);
  assert.deepEqual(readPdfFiles(dir).failures, []);
  fs.writeFileSync(path.join(dir, '_site/downloads/extra.pdf'), pdf('five grand and 9x more likely'));
  fs.writeFileSync(path.join(dir, 'src/downloads/extra.pdf'), pdf('$99 and 62% and 80% of sales'));
  const result = readPdfFiles(dir);
  assert.equal(result.sources.length, 8);
  assert.equal(result.failures.filter(f => f.check === 'pdf-price').length, 2);
  assert.equal(result.failures.filter(f => f.check === 'unsourced-claim').length, 2);
  assert.ok(result.failures.every(f => isBlocking({ ...f, owner: 'integration' }, 'codex-only')));
});
test('missing, corrupt, empty and textless required PDFs block, including zero files', t => {
  const dir = pdfFixture(t);
  fs.unlinkSync(path.join(dir, 'src/downloads', requiredPdfs[0]));
  fs.writeFileSync(path.join(dir, '_site/downloads', requiredPdfs[0]), 'not a pdf');
  fs.writeFileSync(path.join(dir, '_site/downloads', requiredPdfs[1]), '');
  fs.writeFileSync(path.join(dir, '_site/downloads', requiredPdfs[2]), pdf(''));
  assert.equal(readPdfFiles(dir).failures.filter(f => f.check === 'pdf-required').length, 4);
  assert.equal(readPdfFiles(path.join(dir, 'missing')).failures.length, 6);
  assert.ok(readPdfFiles(dir, { extract() { throw Error('missing Python/pypdf'); } }).failures.length >= 6);
});
test('unsourced claims block PDF text and pages including split markup, metadata and proof', () => {
  for (const claim of ['62%', '9x more likely', '80% of sales', '9x\nmore likely']) assert.ok(hasUnsourcedClaim(claim), claim);
  for (const html of ['<p>6<span>2%</span></p>', '<div data-proof>9x more likely</div>', '<meta name="description" content="80% of sales">', '<script type="application/ld+json">{"description":"62%"}</script>']) assert.ok(hasPageClaim(html), html);
  assert.equal(hasPageClaim('<p>162% and 180% and 19x more likely</p>'), false);
  assert.equal(hasPageClaim('<style>.bar { width: 80% }</style><div style="width: 80% ">A guide</div><script>const progress = "80% ";</script>'), false);
});

test('results name both brands with approved scope and no performance promises', () => {
  const html = fs.readFileSync(path.join(site, '_site/results/index.html'), 'utf8');
  const doc = parseDocument(html);
  const nodes = findAll(n => !!n.name, doc.children);
  const heading = nodes.find(n => n.name === 'h2' && textContent(n) === 'Brands we run systems for');
  assert.ok(heading);
  const block = textContent(heading.parent);
  assert.match(block, /Mara Labs/); assert.match(block, /Redd Remedies/);
  assert.match(block, /website, organic social, paid ads on Meta, Google and TikTok, and retention flows/);
  assert.match(block, /landing pages, paid ads on Meta, Google and Bing, date-gated sales across the site and ads, and creator programs/);
  assert.doesNotMatch(block, /every surface/);
  assert.doesNotMatch(block, /\d|forthcoming|case stud/i);
});
test('homepage proof has dated internal records without implying account re-pulls', () => {
  const data = JSON.parse(fs.readFileSync(path.join(site, 'src/_data/proof.json')));
  assert.equal(data.trackRecord.length, 4);
  for (const record of data.trackRecord) {
    assert.equal(record.kind, 'track_record'); assert.equal(record.verified_from, record.id === 'sasha-existing' ? 'Google review' : 'internal record');
    assert.equal(record.re_pulled, false); assert.ok(record.source); assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/); assert.ok(record.date_basis);
  }
  assert.equal(data.trackRecord[0].baseline, 26.75); assert.equal(data.trackRecord[0].result, 17.94);
  assert.equal(Math.round((1 - 17.94 / 26.75) * 100), 33);
  assert.equal(data.trackRecord[3].date, '2026-11-19');
  const google = data.reviews.find(r => r.id === 'google-sasha-gooray');
  assert.equal(data.trackRecord[3].source, google.sourceFile);
  assert.ok(google.text.includes(data.trackRecord[3].claim));
  assert.equal(data.trackRecord[3].context.reportedBy, 'Sasha Gooray in her Google review.');
});
test('cost article keeps its URL and Article schema, covers scope, and ends with roadmap CTA', () => {
  const source = fs.readFileSync(path.join(site, 'src/blog/how-much-does-a-website-cost/index.njk'), 'utf8');
  const [, front, body] = source.split('---');
  const data = JSON.parse(front);
  assert.equal(data.canonicalPath, '/blog/how-much-does-a-website-cost/');
  assert.ok(data.schema.some(n => n['@type'] === 'Article'));
  assert.doesNotMatch(body, /\$|\b(?:bucks?|dollars?|grand|hundred|thousand)\b|[\u2013\u2014]/i);
  for (const term of ['scope', 'pages', 'integrations', 'content', 'maintain']) assert.match(body, new RegExp(term, 'i'));
  const links = findAll(n => n.name === 'a', parseDocument(body).children);
  assert.equal(links.at(-1).attribs.href, '/growth-roadmap/');
});
test('article, service, results and download templates have no kicker or eyebrow labels', () => {
  const files = ['_includes/layouts/article.njk', '_includes/layouts/service.njk', 'results/index.njk', 'results/case.njk', 'google-ads-checklist/index.njk', 'lead-follow-up/index.njk', 'meta-ads-playbook/index.njk'];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(path.join(site, 'src', file), 'utf8'), /class=["'][^"']*\b(?:eyebrow|kicker)\b/, file);
});
