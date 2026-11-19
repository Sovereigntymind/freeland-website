import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent } from 'domutils';
import { visible, hasPrice, hasPageClaim, isBlocking, readPdfFiles } from './site-content-checks.mjs';
import { checkProof, copyForPunctuation } from './proof-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const proof = JSON.parse(fs.readFileSync(path.join(root, 'src/_data/proof.json'), 'utf8'));
const origin = 'https://freelandme.com';
const expectedMissing = new Set(['/growth-roadmap/', '/how-it-works/', '/book/', '/partners/', '/for/supplement-brands/', '/llm-info/']);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'build-pages.json'), 'utf8'));
const records = new Map(), failures = [], missing = new Map();
const owned = url => /^\/(?:blog|services|results)(?:\/|$)/.test(url);
const fail = (url, check, detail) => failures.push({ url, owner: owned(url) ? 'codex' : 'integration', check, detail });
const elements = doc => findAll(n => !!n.name, doc.children);
for (const entry of manifest) {
  const html = fs.readFileSync(path.resolve(root, entry.outputPath), 'utf8');
  const doc = parseDocument(html), nodes = elements(doc);
  records.set(entry.url, { entry, doc, nodes, html, ids: new Set(nodes.map(n => n.attribs.id).filter(Boolean)) });
}
const generatedPaths = new Set(manifest.map(entry => path.resolve(root, entry.outputPath)));
function checkStale(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkStale(file);
    else if (file.endsWith('.html') && !generatedPaths.has(file)) fail('/' + path.relative(out, file).replaceAll('\\', '/'), 'stale-output', 'HTML file was not produced by the current build. Clean output and rebuild.');
  }
}
checkStale(out);
const pdfSources = readPdfFiles(root);
for (const { file, check, detail } of pdfSources.failures) fail(file, check, detail);
for (const [url, { doc, nodes, html }] of records) {
  for (const detail of checkProof(html, proof, url)) fail(url, 'proof', detail);
  if (hasPageClaim(html)) fail(url, 'unsourced-claim', 'Unsourced claim in page content or metadata (62%, 9x more likely, or 80%).');
  const count = nodes.filter(n => n.name === 'h1').length;
  if (count !== 1) fail(url, 'h1', `Expected one H1, found ${count}`);
  if (!nodes.some(n => n.name === 'title' && textContent(n).trim())) fail(url, 'title', 'Missing title');
  if (!nodes.some(n => n.name === 'meta' && n.attribs.name === 'description' && n.attribs.content?.trim())) fail(url, 'description', 'Missing description');
  const canonical = nodes.find(n => n.name === 'link' && n.attribs.rel === 'canonical')?.attribs.href;
  if (url === '/404.html') {
    if (nodes.some(n => n.name === 'link' && n.attribs.rel === 'canonical')) fail(url, 'canonical', '404 must not declare a canonical');
  } else if (!canonical || !canonical.startsWith(origin + '/')) fail(url, 'canonical', 'Missing or invalid canonical');
  const scripts = nodes.filter(n => n.name === 'script' && n.attribs.type === 'application/ld+json');
  if (scripts.length !== 1) fail(url, 'schema', `Expected one graph script, found ${scripts.length}`);
  const definitions = new Set(), references = [];
  function visit(value, at = '$') {
    if (typeof value === 'string' && hasPrice(value)) fail(url, 'schema-price', at + ': ' + value);
    if (!value || typeof value !== 'object') return;
    if (value['@id']) {
      if (Object.keys(value).some(k => k !== '@id')) definitions.add(value['@id']);
      else references.push(value['@id']);
    }
    for (const [key, child] of Object.entries(value)) {
      if (['price', 'priceRange', 'offers'].includes(key)) fail(url, 'schema-price-key', `${at}.${key}`);
      visit(child, `${at}.${key}`);
    }
  }
  for (const script of scripts) {
    try {
      const data = JSON.parse(textContent(script));
      if (!Array.isArray(data['@graph'])) fail(url, 'schema', 'Missing @graph array');
      visit(data);
      const bodyText = visible(doc).replace(/\s+/g, ' ').trim();
      for (const item of data['@graph'] || []) if (item['@type'] === 'FAQPage') {
        for (const qa of item.mainEntity || []) for (const text of [qa.name, qa.acceptedAnswer?.text]) {
          if (text && !bodyText.includes(text.replace(/\s+/g, ' ').trim())) fail(url, 'faq-visible', text);
        }
      }
    } catch (error) { fail(url, 'schema-json', error.message); }
  }
  for (const id of references) if (!definitions.has(id)) fail(url, 'schema-reference', id);
  if (hasPrice(visible(doc, true))) fail(url, 'visible-price', 'Money amount or spelled-out money outside data-proof');
  if (/[\u2013\u2014]/.test(visible(copyForPunctuation(html, proof)))) fail(url, 'visible-dash', 'Em or en dash outside an exact verified source quotation');
  for (const node of nodes.filter(n => n.attribs.href)) {
    const href = node.attribs.href;
    let link;
    try { link = new URL(href, origin + url); } catch { fail(url, 'link', href); continue; }
    if (link.origin !== origin || !['https:', 'http:'].includes(link.protocol)) continue;
    let targetPath;
    try { targetPath = decodeURIComponent(link.pathname); } catch { fail(url, 'link-encoding', href); continue; }
    let target = records.get(targetPath) || records.get(targetPath.replace(/\/index\.html$/, '/')) || records.get(targetPath + '/');
    const disk = path.resolve(out, '.' + targetPath);
    if (!disk.startsWith(out + path.sep) && disk !== out) { fail(url, 'link-path', href); continue; }
    const exists = target || (!targetPath.endsWith('/') && fs.existsSync(disk) && fs.statSync(disk).isFile() && !targetPath.endsWith('.html'));
    if (!exists) {
      if (expectedMissing.has(targetPath)) {
        if (!missing.has(targetPath)) missing.set(targetPath, new Set());
        missing.get(targetPath).add(url);
      } else fail(url, 'internal-link', href);
      continue;
    }
    if (link.hash && target) {
      let fragment; try { fragment = decodeURIComponent(link.hash.slice(1)); } catch { fragment = link.hash.slice(1); }
      if (fragment && !target.ids.has(fragment) && !target.nodes.some(n => n.name === 'a' && n.attribs.name === fragment)) fail(url, 'fragment', href);
    }
  }
  if (owned(url) && /href=["'](?:\/?#contact|\/(?:free-audit|seo-audit)\/)/.test(html)) fail(url, 'legacy-cta', 'Unmigrated CTA');
}
const report = { pages: records.size, codexPages: [...records.keys()].filter(owned).length, passedPages: [...records.keys()].filter(url => !failures.some(f => f.url === url)).length, failures, expectedMissing: [...missing].map(([url, sources]) => ({ url, sourceCount: sources.size })), mode: process.argv.includes('--codex-only') ? 'codex-only' : 'whole-site' };
const reportPath = process.env.TEST_SITE_REPORT ? path.resolve(process.env.TEST_SITE_REPORT) : path.join(root, 'test-site-report.json');
report.pdfSources = pdfSources.sources.map(({ file }) => ({ file }));
report.notes = ['Final source and built PDFs checked using Python/pypdf; extraction failures block verification.'];
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const blocking = failures.filter(f => isBlocking(f, report.mode));
console.log(`${pdfSources.sources.length} final PDFs extracted and checked for prices and unsourced claims.`);

console.log(`${report.pages} pages checked (${report.codexPages} Codex); ${report.passedPages} pages pass; ${blocking.length} blocking failures in ${report.mode} mode.`);
for (const item of report.expectedMissing) console.log(`EXPECTED-MISSING: ${item.url} (${item.sourceCount} referring pages; Claude-owned)`);
for (const f of blocking.slice(0, 35)) console.error(`${f.url} [${f.check}] ${f.detail}`);
if (failures.length > blocking.length) console.log(`${failures.length - blocking.length} integration findings remain in ${reportPath}.`);
process.exitCode = blocking.length ? 1 : 0;
