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
  const ok = (await Promise.all(jobs)).every(Boolean);
  return new Response(ok ? "ok" : "dispatch failed", { status: ok ? 200 : 500 });
};

export const config = { schedule: "7 6,7,12,13,14 * * *" };
