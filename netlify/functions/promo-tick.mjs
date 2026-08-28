// Backup trigger for GitHub Actions workflows in Sovereigntymind/my-claude-projects.
// GitHub's own cron silently skipped 5 runs in a row on 2026-08-28 (Redd Bone
// Health banner stayed up 11h). Netlify's scheduler fires this at the hours our
// promo windows use (01/02/08/09 CT = 06/07/13/14 UTC) plus the 12Z safety tick;
// promo-scheduler's runner is idempotent, so extra ticks no-op.
// Needs Netlify env var GH_DISPATCH_TOKEN (GitHub token with Actions write on
// my-claude-projects; currently Kevin's gh OAuth token, swap to a fine-grained PAT).
const REPO = "Sovereigntymind/my-claude-projects";

// One-shot extras: [workflow file, UTC date, UTC hour]. Delete a row once it has run.
// ponytail: hand-maintained list; a workflow name lookup would be more than we need.
const ONE_SHOTS = [
  ["redd-blog-publish-0902.yml", "2026-09-02", 14], // Redd 10-Year Health Gap blog, 9:07am CDT (D-163)
];

// Missed-cron backups: GitHub's own schedule ran daily-automation 10h late on
// 8/27 (20:52Z vs 11Z) and nightly-feeds 8h late on 8/28. At the check hour, if
// the workflow has no run created inside the window, dispatch it. Neither job is
// idempotent for a same-day double run (Daily Focus email would send twice), so
// the run-list check is the guard, and an API error fails CLOSED (no dispatch).
// [workflow file, UTC check hour, window hours back]
const BACKUPS = [
  ["daily-automation.yml", 13, 6], // cron 11Z; by 13Z (9am ET) it must have run
  ["nightly-feeds.yml", 6, 10],    // cron 22Z; by 06Z it must have run
];

async function ranWithin(token, workflow, hours) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/runs?created=>=${since}&per_page=1`,
    { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "freelandme-promo-tick" } },
  );
  if (!res.ok) { console.error(`promo-tick: run check ${workflow} HTTP ${res.status}`); return true; }
  const n = (await res.json()).total_count;
  console.log(`promo-tick: ${workflow} runs since ${since}: ${n}`);
  return n > 0;
}

async function dispatch(token, workflow, inputs) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "freelandme-promo-tick",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    },
  );
  const msg = `promo-tick: ${workflow} -> HTTP ${res.status}`;
  if (res.status !== 204) console.error(msg, await res.text());
  else console.log(msg);
  return res.status === 204;
}

export default async () => {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.error("promo-tick: GH_DISPATCH_TOKEN not set");
    return new Response("no token", { status: 500 });
  }
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const jobs = [dispatch(token, "promo-scheduler.yml", { mode: "tick" })];
  for (const [wf, date, h] of ONE_SHOTS) {
    if (date === today && h === hour) jobs.push(dispatch(token, wf, {}));
  }
  for (const [wf, h, win] of BACKUPS) {
    if (h === hour && !(await ranWithin(token, wf, win))) jobs.push(dispatch(token, wf, {}));
  }
  const ok = (await Promise.all(jobs)).every(Boolean);
  return new Response(ok ? "ok" : "dispatch failed", { status: ok ? 200 : 500 });
};

export const config = { schedule: "7 6,7,12,13,14 * * *" };
