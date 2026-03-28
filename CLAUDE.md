# Freeland Website (freelandme.com)

## Stack
Eleventy 3.1.2 + Nunjucks, Netlify auto-deploy, Node 20

## Build & Deploy
- Build: `npm run build` (from this directory, publishes `_site`)
- Deploy: `bash deploy.sh` from repo root (splits subtree, pushes to Netlify)
- Ask Kevin before deploying

## Gotchas
- SVGs need BOTH inline style AND width/height — Netlify strips one or the other
- Cache headers: `must-revalidate` for CSS — NOT immutable

## Analytics & Contact
- GA4: G-89PW952D8G
- Contact form: web3forms.com → /thank-you.html

## SEO Rules
- Lead with service keywords, NOT location
- Every page: title, meta description, canonical, OG tags, Twitter cards, schema
- Blog posts: Article schema, sitemap.xml entry, internal links
- No phone number placeholder
- No fixed pricing on service pages — drive to consultation
  - Exception: AI Lead Capture ($199/$399/$599)
