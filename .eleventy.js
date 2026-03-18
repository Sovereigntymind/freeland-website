const Image = require("@11ty/eleventy-img");
const fs = require("fs");
const CleanCSS = require("clean-css");
const path = require("path");
const sharp = require("sharp");

module.exports = function(eleventyConfig) {
  // Pass through static files as-is
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/blog/images");
  eleventyConfig.addPassthroughCopy("src/styles.css");
  eleventyConfig.addPassthroughCopy("src/robots.txt");
  eleventyConfig.addPassthroughCopy("src/sitemap.xml");
  eleventyConfig.addPassthroughCopy("src/_headers");
  eleventyConfig.addPassthroughCopy("src/site.webmanifest");

  // After build: generate WebP images + minify CSS
  eleventyConfig.on("eleventy.after", async ({ dir }) => {
    const out = dir.output;

    // --- Generate WebP versions of local images ---
    const mainImages = [
      { src: "./src/images/hero-bg.jpg",       name: "hero-bg" },
      { src: "./src/images/kevin-headshot.jpg", name: "kevin-headshot" },
      { src: "./src/images/josh-headshot.jpg",  name: "josh-headshot" },
      { src: "./src/images/joe-tiki-logo.png",  name: "joe-tiki-logo" },
    ];

    const blogImageNames = [
      "Yz9jwTyJpb06TSV6U6MHN_JCkv8NwO",
      "n2hvMUYzyesDvDO4TrpsK_pirj3Eyl",
      "oiZiG99bnLXCH7g6rzCXY_EyVJ2IEI",
      "uVngk6c7sVd-Q6tonUrYt_n9krfwnk",
      "yu7WKtk0fUDgXGX8Kky57_FqhbhiXz",
      "zuR-VhB_CZ7bebLicgx0K_gW0zliSk",
      "what-is-a-crm",
      "crm-automation-florida",
    ];

    const imgOutDir = path.join(out, "images");
    fs.mkdirSync(imgOutDir, { recursive: true });

    for (const { src, name } of mainImages) {
      if (!fs.existsSync(src)) continue;
      await Image(src, {
        widths: ["auto"],
        formats: ["webp"],
        outputDir: imgOutDir,
        filenameFormat: () => `${name}.webp`,
        sharpWebpOptions: { quality: 82 },
      });
    }

    const blogImgOutDir = path.join(out, "blog", "images");
    fs.mkdirSync(blogImgOutDir, { recursive: true });

    for (const name of blogImageNames) {
      const src = `./src/blog/images/${name}.jpg`;
      if (!fs.existsSync(src)) continue;
      await Image(src, {
        widths: ["auto"],
        formats: ["webp"],
        outputDir: blogImgOutDir,
        filenameFormat: () => `${name}.webp`,
        sharpWebpOptions: { quality: 82 },
      });
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

    // --- Minify CSS ---
    const cssPath = path.join(out, "styles.css");
    if (fs.existsSync(cssPath)) {
      const css = fs.readFileSync(cssPath, "utf8");
      const { styles } = new CleanCSS({ level: 1 }).minify(css);
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
