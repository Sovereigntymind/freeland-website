import { parseDocument } from 'htmlparser2';
import { findAll, textContent, getOuterHTML, removeElement } from 'domutils';

const nodes = node => findAll(n => !!n.name, node.children || []);
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const quoteText = node => {
  const paragraphs = nodes(node).filter(n => n.name === 'p');
  return normalize(paragraphs.length ? paragraphs.map(textContent).join('\n\n') : textContent(node));
};
export const canRender = entry => entry?.verifiedVerbatim === true && !entry.placementExcluded &&
  (entry.source === 'Google review' || (entry.source === 'Letter' && entry.cleared === true));
export const publicSource = entry => /^https?:\/\//.test(entry.sourceUrl || '') ? entry.sourceUrl : undefined;
export const attribution = entry => [entry.name, entry.business, entry.source].filter(Boolean).join(', ');

// The copy rule must not force edits to verbatim source punctuation. Remove only
// quote bodies that independently pass every proof check; surrounding copy and
// attribution still receive the usual punctuation check.
export function copyForPunctuation(html, proof) {
  const doc = parseDocument(html);
  for (const figure of nodes(doc).filter(n => n.name === 'figure' && n.attribs['data-review-id'])) {
    if (checkProof(getOuterHTML(figure), proof).length === 0) {
      for (const quote of nodes(figure).filter(n => n.name === 'blockquote')) removeElement(quote);
    }
  }
  return doc;
}

// Rendering tests and the standalone site gate share the same checks. No broad
// exemption for data-proof: only the exact pre-existing Sasha quotation survives.
export function checkProof(html, proof, page = '') {
  const all = nodes(parseDocument(html)), errors = [];
  const entries = new Map([...proof.reviews, ...proof.letters].map(entry => [entry.id, entry]));
  for (const figure of all.filter(n => n.attribs['data-review-id'] !== undefined)) {
    const id = figure.attribs['data-review-id'], entry = entries.get(id);
    if (!entry) { errors.push(`Unknown review id: ${id}`); continue; }
    if (!canRender(entry)) { errors.push(`Withheld review rendered: ${id}`); continue; }
    const children = nodes(figure), quotes = children.filter(n => n.name === 'blockquote');
    const captions = children.filter(n => n.name === 'figcaption');
    if (figure.name !== 'figure' || quotes.length !== 1 || captions.length !== 1) {
      errors.push(`Invalid review structure: ${id}`); continue;
    }
    const excerpts = entry.excerpts || (entry.excerpt ? [entry.excerpt] : []);
    if (excerpts.some(excerpt => !entry.text?.includes(excerpt))) errors.push(`Invalid excerpt: ${id}`);
    if (quoteText(quotes[0]) !== normalize(excerpts.length ? excerpts.join('\n\n') : entry.text)) errors.push(`Altered quote: ${id}`);
    if (entry.source === 'Google review' && entry.excerpt && !children.some(n => n.name === 'a' && n.attribs.href === publicSource(entry) && textContent(n) === 'See our Google reviews')) errors.push(`Missing Google reviews link: ${id}`);
    if (entry.contextLabel && !children.some(n => n.name === 'p' && textContent(n) === entry.contextLabel)) errors.push(`Missing proof context: ${id}`);
    if (normalize(textContent(captions[0])) !== normalize(attribution(entry))) errors.push(`Altered attribution: ${id}`);
    if (quotes[0].attribs.cite !== publicSource(entry)) errors.push(`Invalid public citation: ${id}`);
    if (entry.sourceFile && textContent(figure).includes(entry.sourceFile)) errors.push(`Internal source exposed: ${id}`);
  }
  const legacy = proof.trackRecord.find(entry => entry.id === 'sasha-existing');
  for (const quote of all.filter(n => n.name === 'blockquote')) {
    let parent = quote.parent;
    while (parent && parent.attribs?.['data-review-id'] === undefined) parent = parent.parent;
    if (parent) continue; // Validated above, including malformed wrappers.
    const text = normalize(textContent(quote));
    const container = quote.parent;
    const caption = nodes(container).find(n => n.name === 'figcaption');
    const heading = nodes(container).find(n => n.name === 'h3');
    if (['/', '/results/'].includes(page) && text === `“${legacy.claim}”` &&
        normalize(textContent(caption || heading || { children: [] })) === legacy.attribution) continue;
    // Existing founder statements and instructional email examples are not client proof.
    if (page === '/' && text === '“I read the numbers myself. The system does the heavy lifting. You talk to me, not an account manager.”' &&
        caption && normalize(textContent(caption)) === 'Kevin Freeland, Founder') continue;
    if (page === '/about/' && text === "“We treat every client's business like it is our own. That means no wasted spend, no fluff reports, and no excuses.”") continue;
    if (page.startsWith('/blog/') && !caption) continue;
    errors.push('Unidentified or altered client quote');
  }
  for (const n of all.filter(n => n.attribs['data-proof-error'])) errors.push(`Proof selection error: ${n.attribs['data-proof-error']}`);
  return errors;
}
