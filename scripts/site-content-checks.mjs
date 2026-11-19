import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'htmlparser2';

export function visible(node, skipProof = false) {
  if (['script', 'style', 'head', 'template'].includes(node.name) || node.attribs?.hidden !== undefined || (skipProof && node.attribs?.['data-proof'] !== undefined)) return '';
  if (node.type === 'text') return node.data;
  return (node.children || []).map(n => visible(n, skipProof)).join('');
}
// Keep the requested denomination gate broad for plural money terms. Singular
// amounts need a quantity, so generic copy such as "another dollar" is not a price.
export const hasPrice = text => /[$\u00a3\u20ac]\s*\d|\b(?:USD|EUR|GBP)\s*\d|\d\s*(?:USD|EUR|GBP)\b|\b(?:bucks|dollars|grand|euros|pounds|cents)\b|\b(?:a|one|\d+)\s+(?:buck|dollar|euro|pound|cent)\b/i.test(text);
export const hasVisiblePrice = html => hasPrice(visible(parseDocument(html), true));
export const hasUnsourcedClaim = text => /\b62\s*%|\b9\s*x\s+more\s+likely\b|\b80\s*%(?=\s|$)/i.test(text.normalize('NFKC'));
export const hasPageClaim = html => {
  const doc = parseDocument(html);
  // Include metadata and structured data as well as visitor-visible copy.
  const content = node => {
    if (node.name === 'style' || (node.name === 'script' && node.attribs?.type !== 'application/ld+json')) return '';
    return [node.type === 'text' ? node.data : '', ...['content', 'alt', 'title', 'aria-label'].map(key => node.attribs?.[key] || ''), ...(node.children || []).map(content)].join(' ');
  };
  return hasUnsourcedClaim(visible(doc)) || hasUnsourcedClaim(content(doc));
};
export const isBlocking = (failure, mode) => mode !== 'codex-only' || failure.owner === 'codex' || ['stale-output', 'pdf-price', 'pdf-required', 'unsourced-claim'].includes(failure.check);

export const requiredPdfs = ['google-ads-starter-checklist.pdf', 'lead-follow-up-sequence.pdf', 'meta-ads-playbook.pdf'];
const extractor = fileURLToPath(new URL('./extract-pdf-text.py', import.meta.url));
function extractPdfText(files) {
  // File-backed stdio also works in Windows sandboxes that restrict child pipes.
  const temp = fs.mkdtempSync(path.join(path.dirname(extractor), '.pdf-check-'));
  const paths = ['input.json', 'output.json', 'errors.txt'].map(name => path.join(temp, name));
  const descriptors = [];
  try {
    fs.writeFileSync(paths[0], JSON.stringify(files));
    descriptors.push(fs.openSync(paths[0], 'r'), fs.openSync(paths[1], 'w'), fs.openSync(paths[2], 'w'));
    execFileSync(process.env.PYTHON || 'python', [extractor], { timeout: 30000, stdio: descriptors, windowsHide: true });
    return JSON.parse(fs.readFileSync(paths[1], 'utf8'));
  } finally {
    descriptors.forEach(fd => fs.closeSync(fd));
    paths.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    fs.rmdirSync(temp);
  }
}
export function readPdfFiles(site, { extract = extractPdfText } = {}) {
  const directories = ['src/downloads', '_site/downloads'];
  const names = new Set(requiredPdfs), failures = [], sources = [];
  for (const dir of directories) {
    try { for (const name of fs.readdirSync(path.join(site, dir))) if (/\.pdf$/i.test(name)) names.add(name); }
    catch { /* Missing directories produce required-file failures below. */ }
  }
  const files = [];
  for (const dir of directories) for (const name of names) {
    const file = `${dir}/${name}`;
    try {
      const stat = fs.statSync(path.join(site, file));
      if (!stat.isFile() || !stat.size) throw Error('Empty or not a file');
      files.push(file);
    } catch { failures.push({ file, check: 'pdf-required', detail: 'Required PDF is missing, empty or unreadable.' }); }
  }
  if (files.length) {
    try {
      const results = extract(files.map(file => path.join(site, file)));
      files.forEach((file, i) => {
        const result = results[i];
        if (!result || result.error || !result.text?.trim()) failures.push({ file, check: 'pdf-required', detail: result?.error || 'PDF text extraction returned no readable text.' });
        else sources.push({ file, text: result.text });
      });
    } catch (error) {
      for (const file of files) failures.push({ file, check: 'pdf-required', detail: 'PDF extraction failed. Requires Python with pypdf (already installed locally). ' + error.message.split('\n')[0] });
    }
  }
  for (const { file, text } of sources) {
    if (hasPrice(text)) failures.push({ file, check: 'pdf-price', detail: 'Money amount or spelled-out money in final PDF text.' });
    if (hasUnsourcedClaim(text)) failures.push({ file, check: 'unsourced-claim', detail: 'Unsourced claim in final PDF text (62%, 9x more likely, or 80%).' });
  }
  return { sources, failures };
}
