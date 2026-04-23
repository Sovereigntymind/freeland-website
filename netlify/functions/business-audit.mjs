/**
 * Business Audit Netlify Function
 *
 * Receives form data, runs the 19-check website audit, and POSTs results
 * to n8n webhook for branded report generation and email delivery.
 *
 * Adapted from automation/lead-pipeline/web-auditor.js for serverless execution.
 */

// --- Industry data for revenue impact calculations ---
const INDUSTRY_DATA = {
  dental:      { avgTicket: 1500, missedPerDay: 4, closeRate: 0.30, label: "dental practice" },
  hvac:        { avgTicket: 800,  missedPerDay: 6, closeRate: 0.40, label: "HVAC company" },
  auto:        { avgTicket: 600,  missedPerDay: 5, closeRate: 0.35, label: "auto repair shop" },
  restaurant:  { avgTicket: 200,  missedPerDay: 8, closeRate: 0.50, label: "restaurant" },
  salon:       { avgTicket: 150,  missedPerDay: 5, closeRate: 0.45, label: "salon/spa" },
  legal:       { avgTicket: 3000, missedPerDay: 3, closeRate: 0.20, label: "law firm" },
  realestate:  { avgTicket: 8000, missedPerDay: 4, closeRate: 0.15, label: "real estate agency" },
  insurance:   { avgTicket: 1200, missedPerDay: 4, closeRate: 0.25, label: "insurance agency" },
  contractor:  { avgTicket: 2000, missedPerDay: 5, closeRate: 0.30, label: "contractor" },
  construction:{ avgTicket: 2000, missedPerDay: 5, closeRate: 0.30, label: "contractor" },
  plumbing:    { avgTicket: 700,  missedPerDay: 6, closeRate: 0.35, label: "plumbing company" },
  roofing:     { avgTicket: 5000, missedPerDay: 4, closeRate: 0.25, label: "roofing company" },
  landscaping: { avgTicket: 400,  missedPerDay: 5, closeRate: 0.35, label: "landscaping company" },
  fitness:     { avgTicket: 300,  missedPerDay: 4, closeRate: 0.35, label: "fitness center" },
  medical:     { avgTicket: 1200, missedPerDay: 4, closeRate: 0.25, label: "medical practice" },
  retail:      { avgTicket: 200,  missedPerDay: 6, closeRate: 0.40, label: "retail store" },
  default:     { avgTicket: 500,  missedPerDay: 5, closeRate: 0.30, label: "business" },
};

// --- Fetch with timeout ---
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = Date.now();
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    const elapsed = Date.now() - start;
    return { response, elapsed };
  } finally {
    clearTimeout(timer);
  }
}

async function urlExists(url) {
  try {
    const { response } = await fetchWithTimeout(url, 5000);
    return response.ok;
  } catch {
    return false;
  }
}

// --- Firecrawl fallback (ported from autoresearch/audit-coverage experiments) ---
// Uses process.env in Netlify. If FIRECRAWL_API_KEY is set in Netlify env vars, falls back
// to Firecrawl for JS-rendered SPAs, 4xx/5xx bot blocks, and thin error pages. Otherwise
// skips gracefully (site remains flagged unreachable, same as before).
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY || null;

async function firecrawlScrape(url) {
  if (!FIRECRAWL_KEY) return null;
  try {
    const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${FIRECRAWL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["rawHtml"] }),
      signal: AbortSignal.timeout(20000), // Netlify functions have a 26s limit, stay well under
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.data?.rawHtml || null;
  } catch {
    return null;
  }
}

function looksLikeJsShell(html) {
  if (!html) return true;
  if (html.length < 3000) return true;
  const hasFrameworkSig = /__NEXT_DATA__|__NUXT__|data-reactroot|ng-version|data-react-helmet|window\.__INITIAL_STATE__|id=["'](root|app|__next|__nuxt)["']/.test(html);
  const shellBody = /<body[^>]*>\s*(<noscript>[\s\S]{0,500}?<\/noscript>\s*)?<div id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>\s*(<script|<\/body>)/i.test(html);
  return hasFrameworkSig && shellBody;
}

function looksLikeErrorPage(html) {
  if (!html) return false;
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().toLowerCase() : "";
  const errorTitle = /^\s*(4\d{2}|5\d{2})\b|\b(forbidden|not found|access denied|bot protection|attention required|access restricted|cloudflare|service unavailable|under construction|error)\b/i.test(title);
  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const veryThin = textOnly.split(/\s+/).filter((w) => w.length > 0).length < 50;
  return errorTitle || veryThin;
}

// --- HTML parsing helpers ---
function extractTag(html, tag) {
  // Use 's' (dotAll) flag so '.' matches newlines — avoids fragile \\s\\S escaping in RegExp constructor
  const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "is");
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function extractMeta(html, nameOrProperty) {
  const patterns = [
    new RegExp(`<meta[^>]*name=["']${nameOrProperty}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${nameOrProperty}["']`, "i"),
    new RegExp(`<meta[^>]*property=["']${nameOrProperty}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${nameOrProperty}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function hasViewport(html) {
  return /meta[^>]*name=["']viewport["']/i.test(html);
}

function hasContactForm(html) {
  return [
    /<form[^>]*>/i,
    /name=["'](?:email|phone|name|message)["']/i,
    /type=["'](?:email|tel)["']/i,
    /web3forms|formspree|netlify.*form|wufoo|typeform|jotform|gravity.*form|contact.*form.*7/i,
  ].some((p) => p.test(html));
}

function hasClickToCall(html) {
  return /href=["']tel:/i.test(html);
}

function hasChatWidget(html) {
  return [
    /tawk\.to|tidio|intercom|drift|hubspot|zendesk|crisp|livechat|olark|freshchat/i,
    /chat-widget|chatbot|live-chat|chat-bubble|chat-container/i,
    /myaifrontdesk|dialogflow|botpress|manychat/i,
  ].some((p) => p.test(html));
}

function extractPhoneNumbers(html) {
  const phones = [];
  const telLinks = html.match(/href=["']tel:([^"']+)["']/gi) || [];
  for (const link of telLinks) {
    const num = link.match(/tel:([^"']+)/i);
    if (num) phones.push(num[1]);
  }
  return [...new Set(phones)];
}

function extractSocialLinks(html) {
  const socials = {};
  const platforms = {
    facebook: /facebook\.com\/[^"'\s)]+/i,
    instagram: /instagram\.com\/[^"'\s)]+/i,
    twitter: /(?:twitter|x)\.com\/[^"'\s)]+/i,
    linkedin: /linkedin\.com\/[^"'\s)]+/i,
    tiktok: /tiktok\.com\/@?[^"'\s)]+/i,
    youtube: /youtube\.com\/[^"'\s)]+/i,
    yelp: /yelp\.com\/biz\/[^"'\s)]+/i,
  };
  for (const [name, pattern] of Object.entries(platforms)) {
    const match = html.match(pattern);
    if (match) socials[name] = match[0];
  }
  return socials;
}

function extractSchemaTypes(html) {
  const schemas = [];
  const jsonLdBlocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    try {
      const content = block.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1];
      if (content) {
        const parsed = JSON.parse(content);
        if (parsed["@type"]) schemas.push(parsed["@type"]);
        if (Array.isArray(parsed["@graph"])) {
          for (const item of parsed["@graph"]) {
            if (item["@type"]) schemas.push(item["@type"]);
          }
        }
      }
    } catch { /* malformed JSON-LD */ }
  }
  const microdataTypes = html.match(/itemtype=["']https?:\/\/schema\.org\/([^"']+)["']/gi) || [];
  for (const m of microdataTypes) {
    const type = m.match(/schema\.org\/([^"']+)/i)?.[1];
    if (type) schemas.push(type);
  }
  return [...new Set(schemas)];
}

function getH1Text(html) {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return null;
  return match[1].replace(/<[^>]+>/g, "").trim();
}

function checkCityInTitle(html, city) {
  const title = extractTag(html, "title");
  if (!title || !city) return false;
  return title.toLowerCase().includes(city.toLowerCase());
}

function checkCityInH1(html, city) {
  const h1 = getH1Text(html);
  if (!h1 || !city) return false;
  return h1.toLowerCase().includes(city.toLowerCase());
}

function getWordCount(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function checkSocialProof(html) {
  return [
    /testimonial/i, /\breview[s]?\b/i, /\brating[s]?\b/i, /★|☆/,
    /trust.{0,10}badge/i, /bbb|better\s*business\s*bureau/i,
    /client[s]?\s*(?:say|love|trust|result)/i,
    /google.{0,5}reviews?/i, /elfsight|birdeye|podium|trustpilot/i,
  ].some((p) => p.test(html));
}

function getAltTextCoverage(html) {
  const imgs = html.match(/<img[^>]+>/gi) || [];
  if (imgs.length === 0) return { total: 0, withAlt: 0, percentage: 100 };
  const withAlt = imgs.filter((img) => /alt=["'][^"']+["']/i.test(img)).length;
  return { total: imgs.length, withAlt, percentage: Math.round((withAlt / imgs.length) * 100) };
}

function checkGoogleMaps(html) {
  return /google\.com\/maps|maps\.googleapis\.com|maps\.google\.com/i.test(html);
}

// --- Score the audit (0-100, 19 checks) ---
function scoreAudit(results) {
  let score = 0;
  if (results.metaTitle) score += 3;
  if (results.metaDescription) score += 3;
  if (results.cityInTitle) score += 5;
  if (results.cityInH1) score += 4;
  if (results.schemas.length > 0) score += 4;
  if (results.hasSitemap) score += 3;
  if (results.hasH1) score += 4;
  if (results.wordCount >= 300) score += 4;
  if (results.hasContactForm) score += 7;
  if (results.hasClickToCall) score += 5;
  if (results.hasChatWidget) score += 10;
  if (results.hasGoogleMaps) score += 6;
  if (results.hasSocialProof) score += 8;
  if (Object.keys(results.socialLinks).length >= 2) score += 4;
  if (results.ogTitle || results.ogImage) score += 3;
  if (results.altTextCoverage.percentage >= 80) score += 5;
  else if (results.altTextCoverage.percentage >= 50) score += 2;
  if (results.ssl) score += 8;
  if (results.loadTimeMs < 2000) score += 8;
  else if (results.loadTimeMs < 3000) score += 6;
  else if (results.loadTimeMs < 5000) score += 3;
  if (results.mobileResponsive) score += 6;

  const grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";
  return { score, maxScore: 100, grade };
}

// --- Revenue insights for failed checks ---
function getInsights(results, industryName, cityName, businessName) {
  const ind = INDUSTRY_DATA[industryName] || INDUSTRY_DATA.default;
  const insights = [];

  if (!results.hasChatWidget) {
    const monthlyRev = Math.round(ind.missedPerDay * 22 * ind.closeRate * ind.avgTicket);
    insights.push({
      title: "After-Hours Lead Capture",
      detail: `No chat or AI assistant found. Calls outside business hours go unanswered — ~$${monthlyRev.toLocaleString()}/mo in capturable revenue.`,
      fix: "An AI assistant can answer 24/7, book appointments, and handle FAQs",
      revenue: monthlyRev,
    });
  }
  if (!results.hasContactForm) {
    const leads = Math.round(ind.missedPerDay * 0.4 * 22);
    const rev = Math.round(leads * ind.avgTicket * ind.closeRate);
    insights.push({
      title: "Contact Form Missing",
      detail: `No contact form on homepage. Visitors outside phone hours can't reach you — ~${leads} lost inquiries/mo (~$${rev.toLocaleString()}).`,
      fix: "A simple contact form takes 30 minutes to set up",
      revenue: rev,
    });
  }
  if (!results.hasClickToCall) {
    const rev = Math.round(ind.avgTicket * ind.closeRate * 3 * 22);
    insights.push({ title: "No Tap-to-Call Button", detail: `60% of local searches happen on mobile. No tap-to-call means manual dialing — ~$${rev.toLocaleString()}/mo impact.`, fix: "Free to add, takes 2 minutes", revenue: rev });
  }
  if (!results.hasSocialProof) {
    const rev = Math.round(ind.avgTicket * ind.closeRate * 15);
    insights.push({ title: "No Reviews or Trust Signals", detail: `No visible reviews, testimonials, or trust badges. 88% of consumers check reviews first — ~$${rev.toLocaleString()}/mo impact.`, fix: "Display Google reviews widget or testimonials section", revenue: rev });
  }
  if (!results.cityInTitle) {
    const rev = Math.round(ind.avgTicket * ind.closeRate * 5);
    insights.push({ title: "City Missing from Google Title", detail: `"${cityName}" not in page title. Local searchers find competitors first — ~$${rev.toLocaleString()}/mo impact.`, fix: `Add "${cityName}" to your page title (free, 2 minutes)`, revenue: rev });
  }
  if (results.loadTimeMs > 3000) {
    const rev = Math.round(ind.avgTicket * ind.closeRate * 10);
    insights.push({ title: "Slow Page Load", detail: `Site loads in ${(results.loadTimeMs / 1000).toFixed(1)}s (should be under 3s). 53% of mobile visitors leave.`, fix: "Compress images, optimize code, or upgrade hosting", revenue: rev });
  }
  if (!results.hasGoogleMaps) {
    insights.push({ title: "No Google Maps Embed", detail: "No maps on site. Harder for customers to find your location.", fix: "Embed Google Maps (5 minutes)", revenue: Math.round(ind.avgTicket * 2) });
  }
  if (results.schemas.length === 0) {
    insights.push({ title: "No Google Business Data (Schema)", detail: "No structured data — Google can't show your hours, phone, or ratings in search results.", fix: "Add LocalBusiness schema (30 minutes)", revenue: 0 });
  }
  if (!results.metaDescription) {
    insights.push({ title: "No Google Search Description", detail: "Google auto-generates your description — usually not what you'd want.", fix: "Write a 155-character description with city + services", revenue: 0 });
  }

  insights.sort((a, b) => b.revenue - a.revenue);
  return insights;
}

// --- Generate branded HTML report ---
function generateReport(audit, scoring, insights, formData) {
  const { score, grade } = scoring;
  const ind = INDUSTRY_DATA[formData.industry] || INDUSTRY_DATA.default;
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const totalMonthlyRevenue = insights.reduce((sum, i) => sum + i.revenue, 0);

  const scoreColor = score >= 80 ? "#22c55e" : score >= 60 ? "#eab308" : score >= 40 ? "#f97316" : "#ef4444";
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (score / 100) * circumference;

  const checkRow = (name, pass, detail) => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;width:36px;text-align:center;font-size:1.2rem">${pass ? '<span style="color:#22c55e">&#10003;</span>' : '<span style="color:#ef4444">&#10007;</span>'}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;font-weight:600;color:#fff;white-space:nowrap">${name}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #1a1a2e;color:#999;font-size:0.9rem">${detail}</td>
    </tr>`;

  const insightRows = insights.slice(0, 5).map(i => `
    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="color:#fff">${i.title}</strong>
        ${i.revenue > 0 ? `<span style="color:#ff6b7f;font-weight:700;font-size:0.9rem">-$${i.revenue.toLocaleString()}/mo</span>` : ''}
      </div>
      <p style="color:#999;font-size:0.88rem;margin:0 0 8px;line-height:1.5">${i.detail}</p>
      <p style="color:#4d88ff;font-size:0.85rem;margin:0"><strong>Fix:</strong> ${i.fix}</p>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Business Audit Report — ${formData.business_name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#05091a;color:#ccc;line-height:1.6}
.container{max-width:680px;margin:0 auto;padding:32px 24px}
</style>
</head>
<body>
<div class="container">

<div style="text-align:center;padding:32px 0;border-bottom:1px solid rgba(255,255,255,0.08)">
  <img src="https://freelandme.com/images/logo.webp" alt="Freeland Marketing" style="width:200px;height:auto;margin-bottom:16px" width="200" height="62" />
  <h1 style="font-size:1.8rem;font-weight:800;color:#fff;margin-bottom:8px">Business Audit Report</h1>
  <p style="color:#888;font-size:0.95rem">${formData.business_name} &middot; ${date}</p>
</div>

<div style="text-align:center;padding:40px 0">
  <svg width="140" height="140" viewBox="0 0 140 140" style="width:140px;height:140px">
    <circle cx="70" cy="70" r="54" fill="none" stroke="#1a1a2e" stroke-width="10"/>
    <circle cx="70" cy="70" r="54" fill="none" stroke="${scoreColor}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 70 70)"/>
    <text x="70" y="62" text-anchor="middle" fill="#fff" font-size="36" font-weight="800">${score}</text>
    <text x="70" y="82" text-anchor="middle" fill="#888" font-size="14">/100</text>
  </svg>
  <div style="margin-top:16px">
    <span style="display:inline-block;background:${scoreColor}22;color:${scoreColor};padding:6px 20px;border-radius:100px;font-weight:700;font-size:1.1rem">Grade: ${grade}</span>
  </div>
  ${totalMonthlyRevenue > 0 ? `<p style="color:#ff6b7f;font-size:1.1rem;font-weight:700;margin-top:16px">Estimated Revenue Left on Table: $${totalMonthlyRevenue.toLocaleString()}/mo</p>` : ''}
</div>

<h2 style="color:#fff;font-size:1.3rem;margin:24px 0 16px;padding-bottom:8px;border-bottom:2px solid #4d88ff">Top Findings</h2>
${insightRows}

<h2 style="color:#fff;font-size:1.3rem;margin:32px 0 16px;padding-bottom:8px;border-bottom:2px solid #4d88ff">Full Audit Results (19 Checks)</h2>

<h3 style="color:#8ab4f8;font-size:0.95rem;margin:20px 0 8px">Can Customers Find You? (30 pts)</h3>
<table style="width:100%;border-collapse:collapse;font-size:0.9rem">
${checkRow("Google Search Title", !!audit.metaTitle, audit.metaTitle ? `"${audit.metaTitle.slice(0,50)}${audit.metaTitle.length > 50 ? "..." : ""}"` : "Missing")}
${checkRow("Google Search Description", !!audit.metaDescription, audit.metaDescription ? `"${audit.metaDescription.slice(0,50)}..."` : "Missing")}
${checkRow("City in Title", !!audit.cityInTitle, audit.cityInTitle ? `"${formData.city}" found` : `"${formData.city}" missing`)}
${checkRow("City in Headline", !!audit.cityInH1, audit.cityInH1 ? "Found" : "Missing")}
${checkRow("Schema / Business Data", audit.schemas.length > 0, audit.schemas.length > 0 ? audit.schemas.join(", ") : "None")}
${checkRow("Sitemap", !!audit.hasSitemap, audit.hasSitemap ? "Found" : "Missing")}
${checkRow("Main Headline (H1)", !!audit.hasH1, audit.hasH1 ? `"${(audit.h1Text || "").slice(0,40)}..."` : "Missing")}
${checkRow("Content Depth", audit.wordCount >= 300, `${audit.wordCount} words ${audit.wordCount >= 300 ? "(good)" : "(need 300+)"}`)}
</table>

<h3 style="color:#8ab4f8;font-size:0.95rem;margin:20px 0 8px">Can Customers Reach You? (28 pts)</h3>
<table style="width:100%;border-collapse:collapse;font-size:0.9rem">
${checkRow("Contact Form", !!audit.hasContactForm, audit.hasContactForm ? "Found" : "Missing")}
${checkRow("Tap-to-Call", !!audit.hasClickToCall, audit.hasClickToCall ? `Active${audit.phoneNumbers?.[0] ? ": " + audit.phoneNumbers[0] : ""}` : "Missing")}
${checkRow("After-Hours AI/Chat", !!audit.hasChatWidget, audit.hasChatWidget ? "Found" : "Missing")}
${checkRow("Google Maps", !!audit.hasGoogleMaps, audit.hasGoogleMaps ? "Embedded" : "Missing")}
</table>

<h3 style="color:#8ab4f8;font-size:0.95rem;margin:20px 0 8px">Trust Signals (20 pts)</h3>
<table style="width:100%;border-collapse:collapse;font-size:0.9rem">
${checkRow("Reviews / Social Proof", !!audit.hasSocialProof, audit.hasSocialProof ? "Found" : "Missing")}
${checkRow("Social Media Links", Object.keys(audit.socialLinks).length >= 2, Object.keys(audit.socialLinks).length > 0 ? Object.keys(audit.socialLinks).join(", ") : "None")}
${checkRow("Sharing Preview (OG)", !!(audit.ogTitle || audit.ogImage), (audit.ogTitle || audit.ogImage) ? "Set up" : "Missing")}
${checkRow("Image Alt Text", audit.altTextCoverage.percentage >= 80, `${audit.altTextCoverage.withAlt}/${audit.altTextCoverage.total} images`)}
</table>

<h3 style="color:#8ab4f8;font-size:0.95rem;margin:20px 0 8px">Speed & Security (22 pts)</h3>
<table style="width:100%;border-collapse:collapse;font-size:0.9rem">
${checkRow("HTTPS / SSL", !!audit.ssl, audit.ssl ? "Secure" : "Not secure")}
${checkRow("Page Load Speed", audit.loadTimeMs < 3000, `${(audit.loadTimeMs / 1000).toFixed(1)}s ${audit.loadTimeMs < 2000 ? "(fast)" : audit.loadTimeMs < 3000 ? "(ok)" : "(slow)"}`)}
${checkRow("Mobile Responsive", !!audit.mobileResponsive, audit.mobileResponsive ? "Yes" : "No viewport tag")}
</table>

<div style="text-align:center;margin:48px 0 32px;padding:32px;background:linear-gradient(135deg,rgba(0,51,160,0.15),rgba(191,10,48,0.15));border-radius:16px;border:1px solid rgba(255,255,255,0.1)">
  <h2 style="color:#fff;font-size:1.4rem;margin-bottom:12px">Ready to Fix These Issues?</h2>
  <p style="color:#ccc;margin-bottom:20px;font-size:0.95rem">Book a free 15-minute strategy call. We'll walk through your report and show you exactly what to prioritize.</p>
  <a href="https://freelandme.com/#contact" style="display:inline-block;background:linear-gradient(135deg,#BF0A30,#8b0022);color:#fff;padding:14px 36px;border-radius:100px;font-weight:700;font-size:1rem;text-decoration:none">Book Free Strategy Call &rarr;</a>
</div>

<div style="text-align:center;padding:24px 0;border-top:1px solid rgba(255,255,255,0.08);color:#555;font-size:0.82rem">
  <p>Freeland Marketing & Entertainment &middot; Palm Coast, FL</p>
  <p style="margin-top:4px"><a href="https://freelandme.com" style="color:#4d88ff;text-decoration:none">freelandme.com</a> &middot; kevin@freelandme.com</p>
</div>

</div>
</body>
</html>`;
}

// --- MAIN AUDIT LOGIC ---
async function runAudit(formData) {
  const rawWebsite = formData.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const baseUrl = `https://${rawWebsite}`;
  const cityName = (formData.city || "").replace(/,.*$/, "").trim();

  const results = {
    ssl: false, loadTimeMs: 99999, mobileResponsive: false,
    metaTitle: null, metaDescription: null, ogTitle: null, ogImage: null,
    schemas: [], hasSitemap: false, hasContactForm: false,
    hasClickToCall: false, hasChatWidget: false, phoneNumbers: [],
    socialLinks: {}, siteReachable: false, hasH1: false, h1Text: null,
    cityInTitle: false, cityInH1: false, wordCount: 0,
    hasSocialProof: false, altTextCoverage: { total: 0, withAlt: 0, percentage: 100 },
    hasGoogleMaps: false, errors: [],
  };

  // 1. Fetch homepage
  let html = "";
  try {
    const { response, elapsed } = await fetchWithTimeout(baseUrl, 8000);
    results.siteReachable = true;
    results.loadTimeMs = elapsed;
    results.ssl = response.url.startsWith("https://");
    html = await response.text();
  } catch (err) {
    results.errors.push(`Could not reach ${baseUrl}: ${err.message}`);
    // Try HTTP fallback
    try {
      const { response, elapsed } = await fetchWithTimeout(`http://${rawWebsite}`, 8000);
      results.siteReachable = true;
      results.loadTimeMs = elapsed;
      results.ssl = response.url.startsWith("https://");
      html = await response.text();
    } catch (err2) {
      results.errors.push(`HTTP fallback failed: ${err2.message}`);
    }
  }

  // Firecrawl fallback: if native fetch failed, returned a JS shell, or returned an error page, try Firecrawl
  if (!results.siteReachable || looksLikeJsShell(html) || looksLikeErrorPage(html)) {
    const fcHtml = await firecrawlScrape(baseUrl);
    if (fcHtml && fcHtml.length > (html?.length || 0)) {
      html = fcHtml;
      results.siteReachable = true;
      results.ssl = baseUrl.startsWith("https://");
      if (!results.loadTimeMs || results.loadTimeMs === 99999) results.loadTimeMs = 3000;
    }
  }

  // 2. Parse HTML
  if (html) {
    results.metaTitle = extractTag(html, "title");
    results.metaDescription = extractMeta(html, "description");
    results.mobileResponsive = hasViewport(html);
    results.hasContactForm = hasContactForm(html);
    results.hasClickToCall = hasClickToCall(html);
    results.hasChatWidget = hasChatWidget(html);
    results.phoneNumbers = extractPhoneNumbers(html);
    results.socialLinks = extractSocialLinks(html);
    results.schemas = extractSchemaTypes(html);
    results.ogTitle = extractMeta(html, "og:title");
    results.ogImage = extractMeta(html, "og:image");
    results.hasH1 = !!getH1Text(html);
    results.h1Text = getH1Text(html);
    results.cityInTitle = checkCityInTitle(html, cityName);
    results.cityInH1 = checkCityInH1(html, cityName);
    results.wordCount = getWordCount(html);
    results.hasSocialProof = checkSocialProof(html);
    results.altTextCoverage = getAltTextCoverage(html);
    results.hasGoogleMaps = checkGoogleMaps(html);
  }

  // 3. Check sitemap (parallel not needed — single fast check)
  results.hasSitemap = await urlExists(`${baseUrl}/sitemap.xml`);

  // 4. Score
  const scoring = scoreAudit(results);
  results.score = scoring.score;
  results.grade = scoring.grade;

  // 5. Generate insights
  const insights = getInsights(results, formData.industry || "default", cityName, formData.business_name);

  // 6. Generate branded report
  const reportHtml = generateReport(results, scoring, insights, formData);

  return { results, scoring, insights, reportHtml };
}

// --- NETLIFY FUNCTION HANDLER ---
export default async (req) => {
  // Only accept POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let formData;
  try {
    formData = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate required fields
  if (!formData.business_name || !formData.email || !formData.website) {
    return new Response(JSON.stringify({ error: "Missing required fields: business_name, email, website" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Run the audit
    const { results, scoring, insights, reportHtml } = await runAudit(formData);

    // POST results + report to n8n for email delivery
    const n8nPayload = {
      lead: {
        business_name: formData.business_name,
        email: formData.email,
        website: formData.website,
        city: formData.city,
        industry: formData.industry,
        phone: formData.phone,
        source: "business-audit-landing-page",
      },
      audit: {
        score: scoring.score,
        grade: scoring.grade,
        siteReachable: results.siteReachable,
        issuesFound: insights.length,
        totalMonthlyRevenueLost: insights.reduce((sum, i) => sum + i.revenue, 0),
        topInsights: insights.slice(0, 3).map(i => ({ title: i.title, revenue: i.revenue })),
      },
      reportHtml,
      timestamp: new Date().toISOString(),
    };

    // Send to n8n webhook (awaited — Netlify kills pending promises when the response returns,
    // so fire-and-forget silently drops the call. ~1s added to user-facing latency, worth it
    // for reliable email delivery.)
    try {
      const n8nRes = await fetch("https://freelandme.app.n8n.cloud/webhook/business-audit-results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(n8nPayload),
        signal: AbortSignal.timeout(10000),
      });
      if (!n8nRes.ok) {
        console.error(`n8n webhook returned ${n8nRes.status}`);
      }
    } catch (err) {
      console.error("n8n webhook failed:", err.message);
      // Don't fail the user-facing response if email delivery fails.
    }

    // Return success
    return new Response(JSON.stringify({
      success: true,
      score: scoring.score,
      grade: scoring.grade,
      issuesFound: insights.length,
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://freelandme.com",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Audit failed", message: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

// Netlify function config — extend timeout
export const config = {
  path: "/.netlify/functions/business-audit",
};
