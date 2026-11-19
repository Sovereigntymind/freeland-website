import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent, getOuterHTML } from 'domutils';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(site, file), 'utf8');
const siteData = JSON.parse(read('src/_data/site.json'));
const proof = JSON.parse(read('src/_data/proof.json'));
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(path.join(site, 'src/_includes')), { autoescape: true });
const nodes = html => findAll(n => !!n.name, parseDocument(html).children);
const graph = html => JSON.parse(textContent(nodes(html).find(n => n.name === 'script' && n.attribs.type === 'application/ld+json')))['@graph'];
const normalize = html => html.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const base = { site: siteData, proof, env: {}, buildDate: { iso: '2026-11-19', year: 2026 }, page: { url: '/services/fixture/' }, serviceName: 'Fixture service', serviceSlug: 'fixture', title: 'Fixture', description: 'Fixture description', lead: 'Fixture lead', content: '', steps: [], faqs: [] };

test('all eight existing service bodies render exactly as before optional blocks', () => {
  const original = read('scripts/fixtures/service-before-elevate.njk');
  let count = 0;
  for (const dir of fs.readdirSync(path.join(site, 'src/services'))) {
    const file = `src/services/${dir}/index.njk`;
    if (!fs.existsSync(path.join(site, file))) continue;
    const { front, body } = JSON.parse(read('scripts/fixtures/service-inputs-before-elevate.json'))[dir];
    const data = { ...base, ...front, content: body };
    const current = env.render('layouts/service.njk', data), before = env.renderString(original, data);
    const main = html => normalize(getOuterHTML(nodes(html).find(n => n.name === 'main')));
    assert.equal(main(current), main(before), dir); count++;
  }
  assert.equal(count, 8);
});

test('service blocks follow the contract, preserve FAQ parity, and keep CTA destination', () => {
  const data = { ...base, included: [{ title: 'Include title', text: 'Include text' }], fit: { for: ['Fit yes'], notFor: ['Fit no'] }, start: 'Start text', access: ['Access item'], measure: 'Measure text', sample: { title: 'Sample title', text: 'Sample text' }, reviewIds: ['google-sasha-gooray'], relatedPosts: [{ url: '/blog/email-marketing-small-business/', title: 'Guide title' }], faqs: [{ q: 'Question <one>?', a: 'Answer & detail.' }], contextualCta: 'Your contextual next step.', closingHeading: 'Your <next> step & plan.', serviceType: 'Fixture type' };
  const html = env.render('layouts/service.njk', data), all = nodes(html);
  const headings = all.filter(n => n.name === 'h2').map(textContent);
  assert.deepEqual(headings.slice(0, 11), ['What is included', 'Who it is for', 'How we start', 'What access we need', 'How we measure', 'Sample title', 'Related guides', 'Questions before we start', 'Selected Google reviews', data.closingHeading, 'Start']);
  for (const text of ['Fixture lead', 'Include title', 'Include text', 'Fit yes', 'Fit no', 'Start text', 'Access item', 'Measure text', 'Sample text', 'Guide title', data.contextualCta]) assert.ok(textContent(parseDocument(html)).includes(text), text);
  const faq = graph(html).find(n => n['@type'] === 'FAQPage');
  const visibleQuestions = all.filter(n => n.name === 'summary').map(textContent);
  const visibleAnswers = all.filter(n => n.name === 'details').map(n => textContent(n.children.find(c => c.name === 'p')));
  assert.deepEqual(faq.mainEntity.map(n => n.name), visibleQuestions);
  assert.deepEqual(faq.mainEntity.map(n => n.acceptedAnswer.text), visibleAnswers);
  const service = graph(html).find(n => n['@type'] === 'Service');
  assert.equal(service.serviceType, 'Fixture type'); assert.deepEqual(service.areaServed, siteData.areaServed);
  assert.deepEqual(service.audience, { '@type': 'BusinessAudience', name: 'Founder-led DTC brands' });
  assert.ok(all.some(n => n.attribs['data-cta'] === 'service_fixture_roadmap' && n.attribs.href === '/growth-roadmap/'));
});

test('each optional service block works independently and missing FAQs emit no FAQPage', () => {
  for (const [key, value, expected] of [
    ['included', [{ title: 'One', text: 'Two' }], 'What is included'],
    ['fit', { for: ['Yes'], notFor: [] }, 'A good fit'],
    ['start', 'Start alone', 'Start alone'], ['access', ['Access alone'], 'Access alone'],
    ['measure', 'Measure alone', 'Measure alone'], ['sample', { title: 'Sample alone', text: 'Text' }, 'Sample alone'],
    ['reviewIds', ['google-sasha-gooray'], 'Selected Google reviews'],
    ['relatedPosts', [{ url: '/blog/', title: 'Guide' }], 'Related guides'],
    ['contextualCta', 'CTA alone', 'CTA alone'],
    ['closingHeading', 'Closing alone', 'Closing alone']
  ]) {
    const html = env.render('layouts/service.njk', { ...base, [key]: value });
    assert.ok(html.includes(expected), key); assert.ok(!graph(html).some(n => n['@type'] === 'FAQPage'), key);
  }
});

test('Home and Results use proof data and display context without publishing private source paths', () => {
  assert.match(read('src/index.njk'), /include "partials\/track-record.njk"/);
  assert.doesNotMatch(read('src/index.njk'), /data-count-to=|33%|2\.7x|10x/);
  const data = structuredClone(proof); data.trackRecord[0].metric.value = 41;
  const html = env.render('partials/track-record.njk', { proof: data, trackRecordMode: 'metrics' });
  assert.match(html, /data-count-to="41"/);
  for (const page of ['_site/index.html', '_site/results/index.html']) {
    const html = read(page), text = textContent(parseDocument(html));
    assert.match(text, /logged job value divided by ad spend/i); assert.match(text, /customer-reported/i);
    for (const item of proof.trackRecord.filter(i => page.includes('results') || i.metric)) {
      const expectedContext = page.includes('results') ? item.contextLine : item.homeContextLine;
      assert.ok(expectedContext && text.includes(expectedContext), expectedContext);
      assert.ok(!html.includes(item.source));
    }
  }
});

test('built graph identities, breadcrumbs, canonical, social links and all service links are complete', () => {
  const manifest = JSON.parse(read('_site/build-pages.json'));
  for (const page of manifest) {
    const html = fs.readFileSync(path.resolve(site, page.outputPath), 'utf8'), all = nodes(html), data = graph(html);
    const org = data.find(n => n['@id'] === siteData.url + '/#org');
    const person = data.find(n => n['@id'] === siteData.url + '/#kevin');
    const webpage = data.find(n => n['@id'] === siteData.url + page.url + '#webpage');
    for (const key of ['alternateName', 'legalName', 'description', 'areaServed', 'knowsAbout']) assert.deepEqual(org[key], siteData[key], `${page.url} ${key}`);
    assert.deepEqual(org.sameAs, siteData.orgSameAs); assert.ok(org.sameAs.includes(proof.googleProfile.sourceUrl));
    assert.deepEqual(person.sameAs, siteData.personSameAs); assert.equal(person.description, siteData.personDescription); assert.deepEqual(person.knowsAbout, siteData.personKnowsAbout);
    assert.equal(webpage.inLanguage, 'en-US');
    const breadcrumb = data.find(n => n['@type'] === 'BreadcrumbList');
    if (breadcrumb) assert.deepEqual(webpage.breadcrumb, { '@id': breadcrumb['@id'] }, page.url);
    else assert.equal(webpage.breadcrumb, undefined, page.url);
    const canonicals = all.filter(n => n.name === 'link' && n.attribs.rel === 'canonical');
    assert.equal(canonicals.length, page.url === '/404.html' ? 0 : 1, page.url);
    if (canonicals.length) assert.equal(canonicals[0].attribs.href, siteData.url + page.url);
    const footer = all.find(n => n.name === 'footer'); const links = findAll(n => n.name === 'a', footer.children);
    for (const social of siteData.social) assert.ok(links.some(n => n.attribs.href === social.url && textContent(n) === social.label));
    for (const slug of ['meta-ads','google-ads-management','website-design','ai-automation','email-marketing-automation','influencer-affiliate','seo','social-media-management']) assert.ok(links.some(n => n.attribs.href === `/services/${slug}/`));
    assert.ok(links.some(n => n.attribs.href === '/llm-info/' && textContent(n) === 'Fact sheet'));
    assert.ok(!data.some(n => ['Review','AggregateRating'].includes(n['@type'])));
  }
});

test('article layout changes only author and publisher fields to stable graph references', () => {
  let count = 0;
  for (const dir of fs.readdirSync(path.join(site, 'src/blog'))) {
    const file = `src/blog/${dir}/index.njk`;
    if (!fs.existsSync(path.join(site, file))) continue;
    const data = JSON.parse(read(file).split('---')[1]);
    const original = data.schema.find(n => n['@type'] === 'Article');
    const current = graph(read(`_site/blog/${dir}/index.html`)).find(n => n['@type'] === 'Article');
    const { author, publisher, ...rest } = original;
    const { author: actualAuthor, publisher: actualPublisher, ...actualRest } = current;
    assert.deepEqual(actualRest, rest, dir);
    assert.deepEqual(actualAuthor, { '@id': siteData.url + '/#kevin' });
    assert.deepEqual(actualPublisher, { '@id': siteData.url + '/#org' }); count++;
  }
  assert.equal(count, 21);
});

test('How it works defines only the stable Roadmap service; production robots permits noindex discovery', () => {
  const services = graph(read('_site/how-it-works/index.html')).filter(n => n['@type'] === 'Service');
  assert.equal(services.length, 1); assert.equal(services[0]['@id'], siteData.url + '/growth-roadmap/#service');
  assert.equal(services[0].url, siteData.url + '/growth-roadmap/');
  assert.doesNotMatch(read('src/robots.txt'), /^Disallow:/m);
  assert.match(read('src/robots.txt'), /^Allow: \/$/m);
});

test('all expanded services retain buying questions, work samples, matching FAQ schema and contextual roadmap CTA', () => {
  for (const dir of fs.readdirSync(path.join(site, 'src/services'))) {
    const file = `src/services/${dir}/index.njk`;
    if (!fs.existsSync(path.join(site, file))) continue;
    const data = JSON.parse(read(file).split('---')[1]);
    const html = read(`_site/services/${dir}/index.html`), all = nodes(html);
    assert.ok(data.faqs.length >= 5, dir); assert.ok(data.sample.title && data.sample.text, dir);
    assert.ok(data.contextualCta, dir);
    assert.ok(all.some(n => n.attribs['data-work-sample'] !== undefined), dir);
    assert.deepEqual(graph(html).find(n => n['@type'] === 'FAQPage').mainEntity.map(q => ({q:q.name,a:q.acceptedAnswer.text})), data.faqs, dir);
    assert.deepEqual(all.filter(n => n.name === 'summary').map(textContent), data.faqs.map(q => q.q), dir);
    assert.ok(all.some(n => n.attribs['data-cta'] === `service_${dir}_roadmap` && n.attribs.href === '/growth-roadmap/'), dir);
    assert.ok(textContent(parseDocument(html)).includes(data.contextualCta), dir);
  }
});

test('lead magnets are noindex, have shortened titles, link back to roadmap and are linked by matching articles', () => {
  for (const [slug, title, article] of [
    ['google-ads-checklist','Google Ads Starter Checklist (Free PDF) | Freeland','google-ads-management-florida-small-business'],
    ['lead-follow-up','5-Touch Lead Follow-Up Sequence (Free PDF) | Freeland','how-to-automate-lead-follow-up'],
    ['meta-ads-playbook','Meta Ads Playbook (Free PDF) | Freeland','how-to-run-facebook-ads']
  ]) {
    const all = nodes(read(`_site/${slug}/index.html`));
    assert.equal(textContent(all.find(n => n.name === 'title')), title);
    assert.ok(all.some(n => n.name === 'meta' && n.attribs.name === 'robots' && n.attribs.content.includes('noindex')));
    assert.ok(all.some(n => n.name === 'a' && n.attribs['data-cta'] === `${slug}_roadmap` && n.attribs.href === '/growth-roadmap/'));
    assert.ok(nodes(read(`_site/blog/${article}/index.html`)).some(n => n.name === 'a' && n.attribs.href === `/${slug}/` && textContent(n) === title.split(' | ')[0]));
    assert.doesNotMatch(read('_site/sitemap.xml'), new RegExp(`<loc>https://freelandme.com/${slug}/</loc>`));
  }
});

test('supplement FAQ and Service schema match visible copy and About picture uses existing formats', () => {
  const html = read('_site/for/supplement-brands/index.html');
  const all = nodes(html), data = graph(html);
  assert.equal(data.find(n => n['@type'] === 'Service').audience.name, 'Founder-led supplement brands');
  const faq = data.find(n => n['@type'] === 'FAQPage').mainEntity;
  assert.equal(faq.length, 3); assert.deepEqual(faq.map(q => q.name), all.filter(n => n.name === 'summary').map(textContent));
  assert.doesNotMatch(JSON.stringify(faq), /Amazon/);
  const picture = nodes(read('_site/about/index.html')).find(n => n.name === 'picture' && n.attribs.class === 'portrait');
  const sources = findAll(n => n.name === 'source', picture.children);
  assert.deepEqual(sources.map(n => n.attribs.srcset), ['/images/kevin-headshot.avif','/images/kevin-headshot.webp']);
  const img = findAll(n => n.name === 'img', picture.children)[0];
  assert.equal(img.attribs.width,'1000'); assert.equal(img.attribs.height,'813');
});

test('roadmap exits follow the form, booking has email fallback, and source annotations never render', () => {
  const html = read('_site/growth-roadmap/index.html');
  assert.ok(html.indexOf('data-cta="roadmap_site_check"') > html.indexOf('</form>'));
  const book = nodes(read('_site/book/index.html'));
  assert.ok(book.some(n => n.name === 'a' && n.attribs.href === 'mailto:kevin@freelandme.com'));
  for (const page of JSON.parse(read('_site/build-pages.json'))) {
    const html = fs.readFileSync(path.resolve(site,page.outputPath),'utf8');
    assert.doesNotMatch(html, /\[Checked:|NEEDS KEVIN|\[launch date\]/, page.url);
  }
});

test('SEO intake redirects to its dedicated noindex confirmation with email and no acquisition button', () => {
  const intake = nodes(read('_site/seo-intake/index.html'));
  assert.equal(intake.find(n => n.name === 'input' && n.attribs.name === 'redirect').attribs.value, 'https://freelandme.com/seo-intake/confirmation/');
  const html = read('_site/seo-intake/confirmation/index.html'), all = nodes(html);
  const main = all.find(n => n.name === 'main');
  assert.match(textContent(main).replace(/\s+/g, ' '), /Your SEO intake was submitted\. Kevin will review the information\. Email him if you need to add anything\./);
  assert.ok(all.some(n => n.name === 'meta' && n.attribs.name === 'robots' && n.attribs.content === 'noindex, nofollow'));
  assert.ok(findAll(n => n.name === 'a' && n.attribs.href === 'mailto:kevin@freelandme.com', main.children).length);
  assert.equal(findAll(n => n.name === 'a' && n.attribs.href === '/growth-roadmap/', main.children).length, 0);
  assert.equal(all.filter(n => n.attribs.class?.split(' ').includes('button-primary')).length, 0);
  assert.doesNotMatch(read('_site/sitemap.xml'), /<loc>https:\/\/freelandme.com\/seo-intake\/confirmation\/<\/loc>/);
});

// Claude 11/19: the booking action leads on /book/ (the page's own audience has already applied); the not-applied route is a link directly under it, never a second primary button.
test('Book puts the booking action and proof right under the lede, then the not-applied route, before the agenda', () => {
  const html = read('_site/book/index.html'), all = nodes(html);
  const first = all.find(n => n.attribs.id === 'first-title');
  const row = all.find(n => n.attribs.class === 'book-action-proof');
  const siblings = row.parent.children.filter(n => !!n.name);
  assert.equal(siblings[siblings.indexOf(row) - 1].attribs.class, 'lede');
  assert.equal(siblings[siblings.indexOf(row) + 1], first);
  assert.equal(findAll(n => n.name === 'a' && n.attribs.href === '/growth-roadmap/', first.children).length, 1);
  assert.equal(findAll(n => n.attribs?.class?.split(' ').includes('button-primary'), first.children).length, 0);
  assert.ok(html.indexOf('id="first-title"') < html.indexOf('id="call-title"'));
  const columns = row.children.filter(n => !!n.name);
  assert.equal(columns.length, 2);
  assert.ok(findAll(n => n.name === 'a' && n.attribs['data-booking-source'] === 'book_page', columns[0].children).length);
  assert.ok(findAll(n => n.attribs?.['data-review-id'] === 'google-brody-guy', columns[1].children).length);
  assert.ok(html.indexOf('data-booking-proof') < html.indexOf('id="call-title"'));
  assert.equal(all.filter(n => n.attribs['data-review-id'] === 'google-brody-guy').length, 1);
  assert.match(read('src/css/site-codex.css'), /@media\(max-width:900px\)\{\.book-action-proof\{grid-template-columns:1fr\}\}/);
});

test('service reviews immediately precede the closing CTA after FAQs and guides', () => {
  for (const slug of fs.readdirSync(path.join(site, 'src/services'))) {
    if (!fs.existsSync(path.join(site, `src/services/${slug}/index.njk`))) continue;
    const data = JSON.parse(read(`src/services/${slug}/index.njk`).split('---')[1]);
    const all = nodes(read(`_site/services/${slug}/index.html`));
    const main = all.find(n => n.name === 'main');
    const blocks = main.children.filter(n => !!n.name);
    const band = blocks.find(n => n.attribs.class?.includes('cta-band'));
    const reviews = blocks.find(n => n.attribs['data-service-proof'] !== undefined);
    if (data.reviewIds?.length) {
      assert.ok(reviews, slug); assert.equal(blocks[blocks.indexOf(band) - 1], reviews, slug);
      assert.ok(findAll(n => n.attribs?.['data-review-id'], reviews.children).length, slug);
    } else assert.equal(reviews, undefined, slug);
  }
});

test('Home context is short and sourced while Results retains every full context line', () => {
  const home = read('_site/index.html'), results = read('_site/results/index.html');
  for (const item of proof.trackRecord.filter(r => r.metric)) {
    assert.ok(item.homeContextLine && item.homeContextLine.split(/\s+/).length <= 25, item.id);
    assert.ok(textContent(parseDocument(home)).includes(item.homeContextLine), item.id);
    assert.ok(textContent(parseDocument(results)).includes(item.contextLine), item.id);
    assert.ok(!textContent(parseDocument(home)).includes(item.contextLine), item.id);
    assert.match(item.homeContextLine, /per Freeland's internal case record|per Joe Miller's signed letter/);
  }
  assert.doesNotMatch(home, /measurement dates are not on file/);
  const sasha = proof.trackRecord.find(r => r.id === 'sasha-existing');
  const google = proof.reviews.find(r => r.id === 'google-sasha-gooray');
  assert.ok(google.text.includes(sasha.claim));
  assert.equal(sasha.source, google.sourceFile);
  assert.equal(sasha.context.reportedBy, 'Sasha Gooray in her Google review.');
  assert.match(sasha.contextLine, /Sasha Gooray in her Google review/);
  assert.doesNotMatch(sasha.contextLine, /by email|Shows:|delivery time/);
  assert.ok(textContent(parseDocument(results)).includes(sasha.claim));
});

test('nested review headings are h3 and standalone headings stay h2, including explicit macro levels', () => {
  for (const [file, level] of [['index.html', 'h3'], ['results/index.html', 'h3'], ['growth-roadmap/index.html', 'h3'], ['about/index.html', 'h2'], ['book/index.html', 'h2'], ['services/website-design/index.html', 'h2']]) {
    const headings = nodes(read('_site/' + file)).filter(n => /^h[1-6]$/.test(n.name) && ['Selected Google reviews', 'Letters'].includes(textContent(n)));
    assert.ok(headings.length, file);
    for (const heading of headings) assert.equal(heading.name, level, file);
  }
  for (const level of [2, 3]) {
    const html = env.renderString('{% from "partials/reviews.njk" import reviews %}{{ reviews(proof, ids=["google-brody-guy", "letter-joe-miller"], headingLevel=level) }}', { proof, level });
    assert.deepEqual(nodes(html).filter(n => /^h[1-6]$/.test(n.name)).map(n => n.name), [`h${level}`, `h${level}`]);
    assert.doesNotMatch(html, /data-review-heading="auto"/);
  }
});

test('every built page installs the URL sanitizer before the GA loader', () => {
  for (const page of JSON.parse(read('_site/build-pages.json'))) {
    const html = fs.readFileSync(path.resolve(site, page.outputPath), 'utf8');
    assert.ok(html.indexOf('src="/js/events.js') >= 0, page.url);
    assert.ok(html.indexOf('src="/js/events.js') < html.indexOf('src="/js/site.js'), page.url);
  }
});

test('service closingHeading escapes copy and defaults unchanged', () => {
  for (const closingHeading of [undefined, '', null]) {
    const all = nodes(env.render('layouts/service.njk', { ...base, closingHeading }));
    const band = all.find(n => n.attribs.class?.includes('cta-band'));
    assert.equal(textContent(findAll(n => n.name === 'h2', band.children)[0]), 'Start with the work your numbers need.');
  }
  const all = nodes(env.render('layouts/service.njk', { ...base, closingHeading: 'Your <em>next</em> step & plan.' }));
  const band = all.find(n => n.attribs.class?.includes('cta-band'));
  const heading = findAll(n => n.name === 'h2', band.children)[0];
  assert.equal(textContent(heading), 'Your <em>next</em> step & plan.');
  assert.equal(findAll(n => n.name === 'em', heading.children).length, 0);
});

test('Home presents four current guide titles and exact reasons after Why Freeland and before reviews', () => {
  const all = nodes(read('_site/index.html'));
  const section = all.find(n => n.name === 'section' && n.attribs['aria-labelledby'] === 'guides-title');
  assert.ok(section);
  const inside = findAll(n => !!n.name, section.children);
  assert.equal(textContent(inside.find(n => n.name === 'h2')), 'Guides founders read first');
  assert.equal(textContent(inside.find(n => n.attribs.class === 'lede')), 'Four questions founders ask before they hire anyone.');
  const expected = [
    ['why-hire-marketing-agency', 'Agency, in-house or do it yourself: how to choose.'],
    ['how-to-run-facebook-ads', 'What a working Meta setup looks like before you spend more.'],
    ['email-marketing-small-business', 'The flows to build first after the first order.'],
    ['ai-automation-services-florida', 'What to ask before you hire anyone to automate your store.']
  ];
  const rows = inside.filter(n => n.name === 'li');
  assert.equal(rows.length, 4);
  for (const [i, [slug, reason]] of expected.entries()) {
    const row = findAll(n => !!n.name, rows[i].children);
    const link = row.find(n => n.name === 'a');
    assert.equal(link.attribs.href, `/blog/${slug}/`);
    assert.equal(textContent(link), JSON.parse(read(`src/blog/${slug}/index.njk`).split('---')[1]).title.replace(/ \| Freeland$/, ''));
    assert.equal(textContent(row.find(n => n.name === 'p')), reason);
  }
  assert.deepEqual(inside.filter(n => n.name === 'a').map(n => n.attribs.href), [...expected.map(([slug]) => `/blog/${slug}/`), '/blog/']);
  assert.equal(textContent(inside.filter(n => n.name === 'a').at(-1)), 'All guides');
  const main = all.find(n => n.name === 'main');
  const blocks = main.children.filter(n => !!n.name);
  const why = blocks.find(n => findAll(c => c.name === 'h2' && textContent(c) === 'Why Freeland', n.children).length);
  assert.equal(blocks[blocks.indexOf(why) + 1], section);
  assert.ok(all.indexOf(section) < all.findIndex(n => n.attribs['data-review-id']));
  assert.match(read('src/css/site-codex.css'), /\.founder-guides a,\.all-guides\{[^}]*min-height:44px/);
});
