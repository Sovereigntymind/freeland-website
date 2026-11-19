import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import { textContent, findAll } from 'domutils';
import { decodeHTML } from 'entities';
import { replacements } from './migration-copy.mjs';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.resolve(site, '../_rebuild-docs');
const changes = [], baseline = [], migrated = [];
const dash = text => text.replace(/[\u2013\u2014]|&(?:mdash|ndash);|&#(?:8211|8212);|&#x201[34];/gi, ' - ');
const plain = html => textContent(parseDocument(html)).replace(/\s+/g, ' ').trim();
const sha = text => createHash('sha256').update(text).digest('hex');
const redirects = {};
for (const [destination, sources] of Object.entries({
  'ai-automation': ['ai-consulting', 'ai-workflow-design', 'done-for-you-ai', 'ai-lead-capture', 'call-center-booking-automation', 'crm-automation', 'automated-reporting'],
  'email-marketing-automation': ['lead-nurturing'],
  'influencer-affiliate': ['ecommerce-affiliate', 'affiliate-referral-automation'],
  'seo': ['google-business-profile'],
  'social-media-management': ['social-media-scheduling', 'ai-content-creation', 'thumbnail-graphic-generation', 'creative-graphic-design']
})) for (const slug of sources) redirects[`/services/${slug}/`] = `/services/${destination}/`;
redirects['/case-studies/'] = '/results/';

function note(slug, kind, before, after) { changes.push({ slug, kind, before, after }); }
function metadata(html) {
  const doc = parseDocument(html);
  const tags = findAll(n => n.type === 'tag' || n.type === 'script', doc.children);
  const meta = key => decodeHTML(tags.find(n => n.name === 'meta' && (n.attribs.name === key || n.attribs.property === key))?.attribs.content || '');
  return {
    title: textContent(tags.find(n => n.name === 'title')),
    description: meta('description'),
    canonical: tags.find(n => n.name === 'link' && n.attribs.rel === 'canonical')?.attribs.href,
    ogTitle: meta('og:title'), ogImage: meta('og:image'),
    published: meta('article:published_time'),
    schema: tags.filter(n => n.name === 'script' && n.attribs.type === 'application/ld+json').map(n => JSON.parse(textContent(n)))
  };
}
for (const entry of fs.readdirSync(path.join(site, 'src/blog'), { withFileTypes: true }).filter(e => e.isDirectory())) {
  const slug = entry.name, filename = path.join(site, 'src/blog', slug, 'index.njk');
  if (!fs.existsSync(filename)) continue;
  const original = fs.readFileSync(filename, 'utf8');
  if (original.startsWith('---') && /["']?layout["']?:\s*["']?layouts\/article\.njk/.test(original.split('---')[1])) continue; // Never overwrite editorial revisions.
  const before = metadata(original);
  if (!before.title || !before.description || !before.canonical) throw new Error(`Missing metadata: ${slug}`);
  let body = original.match(/{%\s*block content\s*%}([\s\S]*?){%\s*endblock\s*%}/)?.[1];
  if (!body) throw new Error(`No body: ${slug}`);
  const originalBody = body;
  let index = 0;
  body = body.replace(/<(p|li|h[1-6]|td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag, attrs, inner) => {
    if (!/\$\s*\d/.test(plain(inner))) return whole;
    const replacement = replacements[slug]?.[index++];
    if (!replacement) throw new Error(`Missing editorial replacement: ${slug} ${index}`);
    note(slug, 'Price-bearing passage rewritten', whole, `<${tag}${attrs}>${replacement}</${tag}>`);
    return `<${tag}${attrs}>${replacement}</${tag}>`;
  });
  if (index !== (replacements[slug]?.length || 0)) throw new Error(`Replacement count changed: ${slug}`);
  if (slug === 'how-to-automate-lead-follow-up') {
    body = body.replace(/<strong>The math on this is simple:<\/strong>[^<]*\$2,000[^<]*/, old => {
      const next = '<strong>Measure the effect of follow-up:</strong> Track response time, qualified leads and completed sales. Use your own customer margins to evaluate whether the change helps the business.\n';
      note(slug, 'Hypothetical revenue claim replaced with measurement guidance', old, next); return next;
    });
  }
  body = body.replace(/<a\b([^>]*?)href=(['"])([^'"]+)\2([^>]*)>([\s\S]*?)<\/a>/gi, (whole, left, quote, href, right, label) => {
    const url = href.replace(/^https?:\/\/(?:www\.)?freelandme\.com/, '');
    if (/^(?:\/?#contact|\/(?:free-audit|seo-audit)\/?(?:#.*)?)$/.test(url)) {
      const next = `<a${left}href="/growth-roadmap/"${right.replace(/\sdata-cta=(['"])[\s\S]*?\1/g, '')} data-cta="blog_${slug}_roadmap">Get your Growth Roadmap</a>`;
      note(slug, 'Legacy CTA route, label and event ID', whole, next); return next;
    }
    const [base, fragment] = url.split('#');
    if (redirects[base]) {
      const next = `<a${left}href="${redirects[base]}"${right}>${label}</a>`;
      note(slug, 'Link to retained destination (obsolete fragment removed)', whole, next); return next;
    }
    return whole;
  });
  const undashed = dash(body);
  if (body !== undashed) note(slug, 'Em/en dashes replaced by spaced hyphens (including HTML entities)', body.match(/.{0,35}(?:[\u2013\u2014]|&(?:mdash|ndash);).{0,35}/g) || [], 'Spaced hyphens, with all other wording retained.');
  body = undashed;
  // Legacy buttons use the foundation's button treatment without changing their destination.
  body = body.replace(/class="([^"]*\bbtn-primary\b[^"]*)"/g, (whole, names) => { const next = `class="${names.replace(/\bbtn-primary\b/g, 'button button-primary').replace(/\bbtn-large\b/g, '').trim()}"`; note(slug, 'Button class mapped to foundation', whole, next); return next; });
  if (/\$\s*\d/.test(plain(body))) throw new Error(`Unreviewed currency remains in ${slug}`);
  // FAQ markup is built from the now-visible answers, not independently rewritten claims.
  const bodyDoc = parseDocument(body), headings = findAll(n => /^h[2-4]$/.test(n.name), bodyDoc.children);
  const schema = structuredClone(before.schema), addedFaqs = [];
  const canonicalPath = new URL(before.canonical).pathname;
  for (let i = 0; i < schema.length; i++) {
    const node = schema[i];
    delete node['@context'];
    node['@id'] = before.canonical + '#' + ({ Article: 'article', BlogPosting: 'article', BreadcrumbList: 'breadcrumbs', FAQPage: 'faq' }[node['@type']] || `node-${i}`);
    if (node.mainEntityOfPage) node.mainEntityOfPage['@id'] = before.canonical + '#webpage';
    if (node['@type'] === 'FAQPage') {
      for (const q of node.mainEntity) {
        let question = dash(q.name);
        if (/\$\s*\d/.test(question) && slug === 'how-much-does-a-website-cost') question = 'Why do some web design agencies charge more than others?';
        const heading = headings.find(n => plain(textContent(n)).toLowerCase() === question.toLowerCase());
        q.name = question;
        if (heading) {
          q.name = textContent(heading).replace(/\s+/g, ' ').trim();
          let answer = heading.next;
          while (answer && answer.type === 'text' && !answer.data.trim()) answer = answer.next;
          if (!answer || answer.name !== 'p') throw new Error(`FAQ answer missing: ${slug}: ${question}`);
          q.acceptedAnswer.text = textContent(answer).replace(/\s+/g, ' ').trim();
        } else {
          let answer = dash(q.acceptedAnswer.text);
          if (/\$\s*\d/.test(answer)) {
            const special = {
              'best-marketing-tools-for-businesses-2026': question.includes('all-in-one') ? 'Compare CRM, messaging, scheduling, reporting and integration needs against the current platform plans. GoHighLevel is one option; check the fit and setup work before choosing it.' : 'Start with the jobs you need to do: manage contacts, publish content, measure results and run campaigns. Choose a small set of connected tools, and include setup and maintenance in the decision.',
              'google-ads-management-florida-small-business': 'Set the media budget from your margins, conversion data and the test you need to run. Scope account management separately, including any landing-page and measurement work.',
              'social-media-management-florida-small-business': 'The scope depends on channels, publishing frequency, available material, approvals and reporting. Define those responsibilities before comparing proposals.'
            };
            answer = special[slug] || plain(replacements[slug]?.at(-1) || '');
            if (!answer) throw new Error(`Unreviewed FAQ price: ${slug}: ${question}`);
          }
          q.acceptedAnswer.text = answer;
          const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
          addedFaqs.push(`<h3>${escape(question)}</h3><p>${escape(answer)}</p>`);
          note(slug, 'Previously schema-only FAQ made visible; price answer rewritten where needed', q.name, answer);
        }
      }
    }
  }
  function cleanSchema(value) {
    if (typeof value === 'string') {
      if (/\$\s*\d/.test(value)) throw new Error(`Unreviewed schema currency: ${slug}`);
      return dash(value);
    }
    if (Array.isArray(value)) return value.map(cleanSchema);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['price', 'priceRange', 'offers'].includes(key)).map(([k, v]) => [k, cleanSchema(v)]));
    return value;
  }
  const afterSchema = cleanSchema(schema);
  if (addedFaqs.length) body = body.replace(/<\/article>\s*$/, `<section class="post-body" aria-label="Frequently asked questions"><h2>Frequently asked questions</h2>${addedFaqs.join('\n')}</section>\n</article>`);
  note(slug, 'JSON-LD merged into shared graph; stable IDs; visible FAQ answers; dash/price policy', before.schema, afterSchema);
  const data = { layout: 'layouts/article.njk', title: dash(before.title), description: dash(before.description), canonicalPath, ogTitle: dash(before.ogTitle), ogImage: before.ogImage, ogType: 'article', tags: ['insights'], articleSlug: slug, schema: afterSchema };
  const article = before.schema.find(n => ['Article', 'BlogPosting'].includes(n['@type']));
  if (article?.datePublished || before.published) data.date = article?.datePublished || before.published;
  if (article?.dateModified) data.dateModified = article.dateModified;
  if (slug === 'how-much-does-a-website-cost') { data.editorialReview = 'Full rewrite required before launch; URL retained.'; note(slug, 'Editorial launch gate', 'Legacy website-cost article', data.editorialReview); }
  note(slug, 'Metadata retained on article layout (dash policy applied)', before, data);
  const output = `---\n${JSON.stringify(data, null, 2)}\n---\n${body.trim()}\n`;
  baseline.push({ slug, sourceHash: sha(original), bodyHash: sha(originalBody), before, after: data, outputHash: sha(output), imageRefs: [...originalBody.matchAll(/(?:src|srcset)="([^"]+)"/g)].map(m => m[1]) });
  migrated.push({ filename, output });
}
// Validate the entire batch before writing a single post.
if (migrated.length && migrated.length !== 21) throw new Error(`Expected 21 legacy posts, found ${migrated.length}`);
for (const { filename, output } of migrated) fs.writeFileSync(filename, output);
if (migrated.length) {
  fs.writeFileSync(path.join(docs, 'migration-baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
  const report = ['# Blog migration differences', '', '21 URLs retained. Titles, descriptions, canonicals, article dates, image references and body structure are carried forward except for the explicit changes below. The shared shell supplies social metadata and one JSON-LD graph. Legacy head-only keywords and social variants are normalized to the shared shell. Article publication/modification dates remain in the Article schema.', '', '**Launch gate: how-much-does-a-website-cost needs a full editorial rewrite.** Its URL, title, dates and images are retained; its price-bearing passages and FAQs have been rewritten without figures.', '', 'Each article also receives the shared in-article roadmap CTA and a published-proof link (currently /results/). Existing non-price copy is a migration, not fresh claim verification. Claude owns the subsequent voice/fact pass.', '', 'The JSON baseline records source, body and migrated hashes, extracted metadata/schema and original image references. Re-running migration skips already migrated files and never overwrites editorial edits.', ''];
  for (const c of changes) report.push(`## ${c.slug}: ${c.kind}`, '', 'Before:', '```', typeof c.before === 'string' ? c.before : JSON.stringify(c.before, null, 2), '```', 'After:', '```', typeof c.after === 'string' ? c.after : JSON.stringify(c.after, null, 2), '```', '');
  fs.writeFileSync(path.join(docs, 'migration-diff.md'), report.join('\n'));
}
console.log(`Migrated ${migrated.length} posts; ${changes.length} documented changes. Already migrated posts are left intact.`);
