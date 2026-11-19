import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { parseDocument } from 'htmlparser2';
import { findAll } from 'domutils';
const require = createRequire(import.meta.url);
const configure = require('../.eleventy.js');
const { cleanBuildOutput, lockBuildOutput } = require('./build-output-lock.cjs');
const { optimizeArticleImages } = require('./article-images.cjs');
const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(site, '_test-article-images');
// Release decoder handles before deleting Windows image fixtures between builds.
sharp.cache(false);
const nodes = html => findAll(n => !!n.name, parseDocument(html).children);
const manifestPath = path.join(site, '_site/build-pages.json');
const built = { skip: fs.existsSync(manifestPath) ? false : 'No completed build. Run npx @11ty/eleventy in freeland-website, then rerun this test.' };

test('before-build removes only the configured output, including on a second build', async () => {
  const target = path.join(site, '_test-clean-output');
  const sibling = path.join(site, '_test-clean-sibling');
  const cwd = process.cwd();
  process.chdir(site);
  try {
    fs.mkdirSync(sibling, { recursive: true }); fs.writeFileSync(path.join(sibling, 'keep'), 'keep');
    for (let build = 0; build < 2; build++) {
      fs.mkdirSync(path.join(target, 'retired'), { recursive: true });
      fs.writeFileSync(path.join(target, 'retired/index.html'), 'stale');
      const release = await cleanBuildOutput({ project: site, inputDir: 'src', outputDir: target });
      try {
        assert.equal(fs.existsSync(target), false);
        assert.equal(fs.readFileSync(path.join(sibling, 'keep'), 'utf8'), 'keep');
      } finally { release(); }
    }
    for (const outputDir of ['.', 'src', 'src/blog', '..']) await assert.rejects(cleanBuildOutput({ project: site, inputDir: 'src', outputDir }), /Unsafe build output/);
  } finally {
    process.chdir(cwd);
    for (const dir of [target, sibling]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second build cannot clean output while the first build writes images', async () => {
  const outputDir = path.join(scratch, 'locked-output');
  const first = await cleanBuildOutput({ project: site, inputDir: path.join(site, 'src'), outputDir });
  let second, pending;
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    pending = cleanBuildOutput({ project: site, inputDir: path.join(site, 'src'), outputDir });
    // Keep Sharp busy while the second build tries to clean the same directory.
    const image = path.join(outputDir, 'in-flight.avif');
    await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#223344' } }).avif().toFile(image);
    assert.ok(fs.statSync(image).size > 0);
    await assert.rejects(lockBuildOutput(outputDir, { timeoutMs: 0 }), /Timed out waiting/);
    first();
    second = await pending;
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    first();
    second ||= await pending;
    second?.();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a post-build failure releases the output lock', async () => {
  const handlers = {};
  configure({ on: (name, fn) => { handlers[name] = fn; }, addTransform() {}, addGlobalData() {}, addPassthroughCopy() {} });
  const output = path.join(scratch, 'failed-output');
  await handlers['eleventy.before']({ dir: { input: path.join(site, 'src'), output } });
  try {
    // Invalid finalizer output forces a failure before it can write any assets.
    await assert.rejects(handlers['eleventy.after']({ dir: {}, results: [] }), TypeError);
    const release = await lockBuildOutput(output, { timeoutMs: 0 });
    release();
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('article images use actual dimensions, sized AVIF/WebP and lazy loading after the lead image', async () => {
  const inputDir = path.join(scratch, 'src'), outputDir = path.join(scratch, 'out');
  fs.mkdirSync(path.join(inputDir, 'blog/images'), { recursive: true });
  try {
    await sharp({ create: { width: 2560, height: 1536, channels: 3, background: '#223344' } }).jpeg().toFile(path.join(inputDir, 'blog/images/wide.jpg'));
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#556677' } }).jpeg().toFile(path.join(inputDir, 'blog/images/small.jpg'));
    const html = '<div class="article-shell"><article><img src="/blog/images/wide.jpg" alt="Wide" width="860" height="400"><picture class="retained"><source type="image/webp" srcset="/blog/images/old.webp"><img src="/blog/images/small.jpg" alt="Small" width="860" height="400"></picture></article></div>';
    const result = await optimizeArticleImages(html, { inputDir, outputDir });
    const all = nodes(result), imgs = all.filter(n => n.name === 'img');
    assert.equal(all.filter(n => n.name === 'picture').length, 2);
    assert.equal(imgs[0].attribs.width, '2560'); assert.equal(imgs[0].attribs.height, '1536');
    assert.equal(imgs[1].attribs.width, '1200'); assert.equal(imgs[1].attribs.height, '800');
    assert.equal(imgs[0].attribs.loading, 'eager'); assert.equal(imgs[1].attribs.loading, 'lazy');
    assert.equal(imgs[1].parent.attribs.class, 'retained');
    assert.doesNotMatch(result, /old.webp/);
    for (const source of all.filter(n => n.name === 'source')) {
      assert.ok(['image/avif', 'image/webp'].includes(source.attribs.type));
      assert.ok(source.attribs.sizes);
      const entries = source.attribs.srcset.split(', ');
      assert.equal(entries.length, 2);
      for (const entry of entries) {
        const [url, width] = entry.split(' ');
        const metadata = await sharp(path.join(outputDir, url)).metadata();
        assert.equal(metadata.width, Number.parseInt(width));
        assert.ok([860, 1200, 1720].includes(metadata.width));
      }
    }
    // A clean rebuild in the same process must recreate image files, not reuse
    // an in-memory result that points at files removed by eleventy.before.
    fs.rmSync(outputDir, { recursive: true, force: true });
    await optimizeArticleImages(html, { inputDir, outputDir });
    assert.ok(fs.existsSync(path.join(outputDir, all.find(n => n.name === 'source').attribs.srcset.split(' ')[0])));
    assert.equal(await optimizeArticleImages('<p>Not an article</p>', { inputDir, outputDir }), '<p>Not an article</p>');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('all built article pictures have real fallback dimensions and generated responsive sources', built, async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  let count = 0;
  for (const entry of manifest.filter(r => r.url.startsWith('/blog/') && r.url !== '/blog/')) {
    const all = nodes(fs.readFileSync(path.resolve(site, entry.outputPath), 'utf8'));
    const shell = all.find(n => n.attribs.class?.split(/\s+/).includes('article-shell'));
    const imgs = findAll(n => n.name === 'img', shell.children);
    for (const img of imgs) {
      count++;
      const meta = await sharp(path.join(site, 'src', img.attribs.src)).metadata();
      assert.equal(Number(img.attribs.width), meta.width, entry.url);
      assert.equal(Number(img.attribs.height), meta.height, entry.url);
      assert.equal(img.parent.name, 'picture', entry.url);
      const sources = img.parent.children.filter(n => n.name === 'source');
      assert.deepEqual(sources.map(n => n.attribs.type), ['image/avif', 'image/webp']);
      for (const source of sources) {
        const expected = [...new Set([Math.min(860, meta.width), Math.min(1720, meta.width)])];
        const candidates = source.attribs.srcset.split(', ');
        assert.deepEqual(candidates.map(c => Number.parseInt(c.split(' ')[1])), expected);
        for (const candidate of candidates) {
          const [url, width] = candidate.split(' ');
          const generated = await sharp(path.join(site, '_site', url)).metadata();
          assert.equal(generated.width, Number.parseInt(width));
          assert.ok(Math.abs(generated.width / generated.height - meta.width / meta.height) < 0.005);
        }
      }
    }
  }
  assert.equal(count, 21);
});

test('every local img/source src and srcset in every built HTML file resolves to a nonempty file', built, t => {
  const output = path.join(site, '_site');
  const origin = 'https://freelandme.com';
  let pages = 0, references = 0;
  const files = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.html')) continue;
      pages++;
      const page = '/' + path.relative(output, file).replaceAll('\\', '/');
      for (const node of nodes(fs.readFileSync(file, 'utf8')).filter(n => ['img', 'source'].includes(n.name))) {
        const urls = [node.attribs.src, ...(node.attribs.srcset || '').split(',').map(candidate => candidate.trim().split(/\s+/)[0])].filter(Boolean);
        for (const src of urls) {
          const url = new URL(src, origin + page);
          if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) continue;
          const target = path.resolve(output, '.' + decodeURIComponent(url.pathname));
          assert.ok(target.startsWith(output + path.sep), `${page}: image escapes output: ${src}`);
          assert.ok(fs.existsSync(target), `${page}: missing ${node.name} image: ${src}`);
          assert.ok(fs.statSync(target).isFile() && fs.statSync(target).size > 0, `${page}: empty/non-file image: ${src}`);
          references++; files.add(target);
        }
      }
    }
  }
  walk(output);
  assert.ok(pages > 0 && references > 0, 'Expected built pages and image references');
  t.diagnostic(`${pages} HTML pages; ${references} local image references; ${files.size} distinct files verified.`);
});

test('all main and blog WebP/AVIF conversions survive the completed build', built, t => {
  let count = 0;
  for (const directory of ['images', 'blog/images']) {
    for (const source of fs.readdirSync(path.join(site, 'src', directory)).filter(file => /\.(jpe?g|png)$/i.test(file))) {
      for (const format of ['webp', 'avif']) {
        const generated = path.join(site, '_site', directory, `${path.parse(source).name}.${format}`);
        assert.ok(fs.existsSync(generated) && fs.statSync(generated).size > 0, `Missing conversion: ${generated}`);
        count++;
      }
    }
  }
  assert.ok(count > 0);
  t.diagnostic(`${count} main/blog format conversions verified.`);
});


test('package verification runs the required suites and blocking gate; deploy retains the gate', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(site, 'package.json'))).scripts;
  assert.equal(scripts.build, 'eleventy');
  assert.equal(scripts.test, undefined, 'package.json is frozen: suites run from scripts/verify.mjs');
  const verify = fs.readFileSync(path.join(site, 'scripts/verify.mjs'), 'utf8');
  for (const name of ['test_roadmap_apply.mjs', 'test_leads_export.mjs', 'test-events.mjs', 'test-migration.mjs', 'test-sitemap.mjs', 'test-content-gates.mjs', 'test-proof.mjs', 'test-elevate-structure.mjs', 'test-build-pipeline.mjs', 'test-site.mjs']) assert.ok(verify.includes(name), name);
  assert.match(verify, /--test-isolation=none/);
  const deploy = fs.readFileSync(path.join(site, '../deploy.sh'), 'utf8');
  assert.match(deploy, /npm run build[\s\S]*node "\$PREFIX\/scripts\/test-site\.mjs" \|\| exit 1/);
});
