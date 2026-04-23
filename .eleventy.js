const Image = require("@11ty/eleventy-img");
const fs = require("fs");
const CleanCSS = require("clean-css");
const path = require("path");
const sharp = require("sharp");

module.exports = function(eleventyConfig) {
  // Global data: current build date for footer
  eleventyConfig.addGlobalData("buildDate", () => {
    const d = new Date();
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return {
      month: months[d.getMonth()],
      year: d.getFullYear(),
      iso: d.toISOString().slice(0, 10)
    };
  });

  // Pass through static files as-is
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/blog/images");
  eleventyConfig.addPassthroughCopy("src/styles.css");
  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/_headers");
  eleventyConfig.addPassthroughCopy("src/site.webmanifest");
  eleventyConfig.addPassthroughCopy("src/fonts");

  // After build: generate WebP images + minify CSS
  eleventyConfig.on("eleventy.after", async ({ dir }) => {
    const out = dir.output;

    // --- Generate WebP versions of ALL images (jpg/png → webp) ---
    const imgOutDir = path.join(out, "images");
    fs.mkdirSync(imgOutDir, { recursive: true });

    // Convert all main images (WebP + AVIF)
    const mainImgDir = "./src/images";
    if (fs.existsSync(mainImgDir)) {
      const mainFiles = fs.readdirSync(mainImgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      for (const file of mainFiles) {
        const name = path.parse(file).name;
        await Image(path.join(mainImgDir, file), {
          widths: ["auto"],
          formats: ["webp"],
          outputDir: imgOutDir,
          filenameFormat: () => `${name}.webp`,
          sharpWebpOptions: { quality: 82 },
        });
        await Image(path.join(mainImgDir, file), {
          widths: ["auto"],
          formats: ["avif"],
          outputDir: imgOutDir,
          filenameFormat: () => `${name}.avif`,
          sharpAvifOptions: { quality: 65 },
        });
      }
      console.log(`[11ty] Images: ${mainFiles.length} main → WebP + AVIF`);
    }

    // Convert all blog images (WebP + AVIF)
    const blogImgDir = "./src/blog/images";
    const blogImgOutDir = path.join(out, "blog", "images");
    fs.mkdirSync(blogImgOutDir, { recursive: true });

    if (fs.existsSync(blogImgDir)) {
      const blogFiles = fs.readdirSync(blogImgDir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
      for (const file of blogFiles) {
        const name = path.parse(file).name;
        await Image(path.join(blogImgDir, file), {
          widths: ["auto"],
          formats: ["webp"],
          outputDir: blogImgOutDir,
          filenameFormat: () => `${name}.webp`,
          sharpWebpOptions: { quality: 82 },
        });
        await Image(path.join(blogImgDir, file), {
          widths: ["auto"],
          formats: ["avif"],
          outputDir: blogImgOutDir,
          filenameFormat: () => `${name}.avif`,
          sharpAvifOptions: { quality: 65 },
        });
      }
      console.log(`[11ty] Images: ${blogFiles.length} blog → WebP + AVIF`);
    }

    // --- Generate favicons from logo ---
    const logoSrc = "./src/images/logo.webp";
    if (fs.existsSync(logoSrc)) {
      const faviconSizes = [
        { size: 512, name: "android-chrome-512x512" },
        { size: 192, name: "android-chrome-192x192" },
        { size: 180, name: "apple-touch-icon" },
        { size: 32,  name: "favicon-32x32" },
        { size: 16,  name: "favicon-16x16" },
      ];
      for (const { size, name } of faviconSizes) {
        const padding = Math.round(size * 0.08);
        const logoSize = size - padding * 2;
        const logoBuffer = await sharp(logoSrc)
          .resize(logoSize, logoSize, { fit: "inside", background: { r: 255, g: 255, b: 255, alpha: 255 } })
          .png()
          .toBuffer();
        const meta = await sharp(logoBuffer).metadata();
        const left = Math.floor((size - meta.width) / 2);
        const top  = Math.floor((size - meta.height) / 2);
        await sharp({
          create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 255 } },
        })
          .composite([{ input: logoBuffer, left, top }])
          .png()
          .toFile(path.join(out, `${name}.png`));
      }
      console.log("[11ty] Favicons generated from logo");
    }

    // --- Optimize logo.webp for smaller file size + generate mobile variant ---
    const logoWebp = path.join(out, "images", "logo.webp");
    if (fs.existsSync(logoWebp)) {
      const origSize = fs.statSync(logoWebp).size;
      const desktop = await sharp(logoWebp)
        .resize(520, 160, { fit: "inside" })
        .webp({ quality: 78, effort: 6 })
        .toBuffer();
      fs.writeFileSync(logoWebp, desktop);
      const logoMobile = path.join(out, "images", "logo-360.webp");
      const mobile = await sharp(logoWebp)
        .resize(360, 111, { fit: "inside" })
        .webp({ quality: 76, effort: 6 })
        .toBuffer();
      fs.writeFileSync(logoMobile, mobile);
      console.log(`[11ty] Logo: ${Math.round(origSize/1024)}KB → ${Math.round(desktop.length/1024)}KB (desktop) + ${Math.round(mobile.length/1024)}KB (mobile)`);
    }

    // --- Generate optimized OG share image (1200x630) ---
    const heroJpg = path.join(out, "images", "hero-bg.jpg");
    const ogOut = path.join(out, "images", "og-share.jpg");
    if (fs.existsSync(heroJpg) && !fs.existsSync(ogOut)) {
      const ogBuf = await sharp(heroJpg)
        .resize(1200, 630, { fit: "cover" })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
      fs.writeFileSync(ogOut, ogBuf);
      console.log(`[11ty] OG image: ${Math.round(ogBuf.length/1024)}KB (1200x630)`);
    }

    // --- Auto-generate sitemap.xml from all built pages ---
    const today = new Date().toISOString().slice(0, 10);
    const sitemapPages = [];
    function findHtml(dir, base) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) findHtml(full, base);
        else if (entry.name === 'index.html') {
          const rel = path.relative(base, dir).replace(/\\/g, '/');
          const urlPath = rel ? `/${rel}/` : '/';
          if (urlPath === '/404/' || urlPath.endsWith('/thank-you/')) continue;
          // Exclude any page with noindex meta tag — contradicts sitemap inclusion and wastes crawl budget
          const html = fs.readFileSync(full, 'utf8');
          if (/<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)) continue;
          let priority = '0.7', freq = 'monthly';
          if (urlPath === '/') { priority = '1.0'; freq = 'weekly'; }
          else if (['/services/', '/seo-audit/', '/free-audit/', '/free-business-audit/', '/services/ai-lead-capture/', '/services/done-for-you-ai/', '/services/google-business-profile/'].includes(urlPath)) { priority = '0.9'; }
          else if (urlPath.startsWith('/services/') || urlPath === '/blog/' || urlPath === '/about/' || urlPath === '/case-studies/') { priority = '0.8'; }
          sitemapPages.push({ urlPath, priority, freq });
        }
      }
    }
    findHtml(out, out);
    sitemapPages.sort((a, b) => {
      if (a.priority !== b.priority) return parseFloat(b.priority) - parseFloat(a.priority);
      return a.urlPath.localeCompare(b.urlPath);
    });
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPages.map(p =>
      `  <url>\n    <loc>https://freelandme.com${p.urlPath}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${p.freq}</changefreq>\n    <priority>${p.priority}</priority>\n  </url>`
    ).join('\n')}\n</urlset>\n`;
    fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemapXml);
    console.log(`[11ty] Sitemap: ${sitemapPages.length} URLs (auto-generated)`);

    // --- Minify HTML ---
    const htmlFiles = [];
    function walkDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.name.endsWith('.html')) htmlFiles.push(full);
      }
    }
    walkDir(out);
    let htmlSaved = 0;
    for (const file of htmlFiles) {
      const orig = fs.readFileSync(file, 'utf8');
      const mini = orig
        .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')          // strip comments (keep IE conditionals)
        .replace(/>\s{2,}</g, '> <')                       // collapse whitespace between tags
        .replace(/\n\s*\n/g, '\n')                         // collapse blank lines
        .replace(/^\s+/gm, '');                            // strip leading whitespace per line
      fs.writeFileSync(file, mini);
      htmlSaved += orig.length - mini.length;
    }
    console.log(`[11ty] HTML: ${htmlFiles.length} files minified, saved ${Math.round(htmlSaved/1024)}KB total`);

    // --- Minify CSS ---
    const cssPath = path.join(out, "styles.css");
    if (fs.existsSync(cssPath)) {
      const css = fs.readFileSync(cssPath, "utf8");
      const { styles } = new CleanCSS({ level: 2 }).minify(css);
      fs.writeFileSync(cssPath, styles);
      console.log(`[11ty] CSS: ${css.length} → ${styles.length} bytes (${Math.round((1 - styles.length / css.length) * 100)}% smaller)`);
    }
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes"
    }
  };
};
