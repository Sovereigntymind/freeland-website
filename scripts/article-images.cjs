const fs = require('node:fs');
const path = require('node:path');
const Image = require('@11ty/eleventy-img').default;
const sharp = require('sharp');
const { parseDocument } = require('htmlparser2');
const { findAll, replaceElement } = require('domutils');
const serialize = require('dom-serializer').default;

// Run on rendered articles so legacy markup and newly added posts use the same
// dimensions and responsive formats without altering their editorial sources.
async function optimizeArticleImages(html, { inputDir, outputDir }) {
  if (!html.includes('article-shell')) return html;
  const doc = parseDocument(html);
  const shells = findAll(n => n.attribs?.class?.split(/\s+/).includes('article-shell'), doc.children);
  const images = shells.flatMap(shell => findAll(n => n.name === 'img', shell.children));
  for (const [index, img] of images.entries()) {
    const src = img.attribs.src;
    if (!src?.startsWith('/') || src.startsWith('//')) throw new Error(`Article image must be local: ${src}`);
    const file = path.resolve(inputDir, '.' + src);
    if (!file.startsWith(path.resolve(inputDir) + path.sep) || !fs.existsSync(file)) throw new Error(`Missing article image: ${src}`);
    const meta = await sharp(file).metadata();
    const widths = [...new Set([Math.min(860, meta.width), Math.min(1720, meta.width)])];
    const urlPath = '/blog/images/responsive/';
    const destination = path.join(outputDir, urlPath.slice(1));
    // eleventy-img caches directory creation within the process; a watch rebuild
    // has just removed this output tree, so recreate it explicitly every time.
    fs.mkdirSync(destination, { recursive: true });
    const variants = await Image(file, {
      widths, formats: ['avif', 'webp'], useCache: false,
      outputDir: destination, urlPath,
      sharpAvifOptions: { quality: 65 }, sharpWebpOptions: { quality: 82 }
    });
    const picture = parseDocument('<picture></picture>').children[0];
    if (img.parent?.name === 'picture') picture.attribs = { ...img.parent.attribs };
    for (const format of ['avif', 'webp']) {
      const source = parseDocument('<source>').children[0];
      source.attribs = {
        type: `image/${format}`,
        srcset: variants[format].map(v => `${v.url} ${v.width}w`).join(', '),
        sizes: '(max-width: 924px) calc(100vw - 64px), 860px'
      };
      picture.children.push(source);
    }
    // Retain the original fallback URL and its real intrinsic dimensions.
    const fallback = parseDocument('<img>').children[0];
    fallback.attribs = { ...img.attribs, width: String(meta.width), height: String(meta.height), loading: index === 0 ? 'eager' : 'lazy', decoding: 'async' };
    delete fallback.attribs.srcset;
    delete fallback.attribs.sizes;
    picture.children.push(fallback);
    replaceElement(img.parent?.name === 'picture' ? img.parent : img, picture);
  }
  return serialize(doc, { encodeEntities: 'utf8' });
}
module.exports = { optimizeArticleImages };
