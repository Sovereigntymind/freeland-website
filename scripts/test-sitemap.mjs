import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const config = fs.readFileSync(new URL('../.eleventy.js', import.meta.url), 'utf8');
const block = config.slice(config.indexOf('    // --- Sitemap:'), config.indexOf('    // --- Minify HTML ---'));
const run = new Function('fs', 'path', 'out', 'results', '__dirname', 'require', 'console', block);
function fixture(gitFails = false) {
  const output = new Map(), calls = [];
  const results = [
    { url: '/', inputPath: './src/index.njk', outputPath: '_site/index.html' },
    { url: '/blog/post/', inputPath: './src/blog/post/index.njk', outputPath: '_site/blog/post/index.html' },
    { url: '/private/', inputPath: './src/private/index.njk', outputPath: '_site/private/index.html' },
    { url: '/404.html', inputPath: './src/404.html', outputPath: '_site/404.html' },
    { url: '/thank-you.html', inputPath: './src/thank-you.html', outputPath: '_site/thank-you.html' },
    { url: '/robots.txt', inputPath: './src/robots.txt', outputPath: '_site/robots.txt' }
  ];
  const fakeFS = { readFileSync: p => p.includes('private') ? '<meta name="robots" content="noindex, nofollow">' : '<html></html>', writeFileSync: (p, text) => output.set(path.basename(p), text) };
  run(fakeFS, path, '_site', results, '.', () => ({ execFileSync: (command, args) => { calls.push({ command, args }); if (gitFails) throw Error('No git'); return args.at(-1).includes('post') ? '2026-03-14T10:00:00-04:00\n' : '2026-11-18T10:00:00-05:00\n'; } }), { log() {} });
  return { output, calls };
}
test('sitemap includes only current build results and source-specific commit dates', () => {
  const { output, calls } = fixture(); const xml = output.get('sitemap.xml');
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.match(xml, /<loc>https:\/\/freelandme.com\/blog\/post\/<\/loc><lastmod>2026-03-14<\/lastmod>/);
  assert.match(xml, /<lastmod>2026-11-18<\/lastmod>/);
  assert.doesNotMatch(xml, /private|404|thank-you|robots|stale/);
  assert.equal(calls.length, 2); for (const c of calls) { assert.equal(c.command, 'git'); assert.deepEqual(c.args.slice(0, 4), ['log', '-1', '--format=%cI', '--']); }
});
test('unavailable git history uses the documented build date fallback', () => {
  const { output } = fixture(true); const date = new Date().toISOString().slice(0, 10);
  assert.equal((output.get('sitemap.xml').match(new RegExp(`<lastmod>${date}</lastmod>`, 'g')) || []).length, 2);
});
