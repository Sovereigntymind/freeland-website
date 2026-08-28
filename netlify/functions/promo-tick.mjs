// Backup trigger for my-claude-projects/.github/workflows/promo-scheduler.yml.
// GitHub's own cron silently skipped 5 runs in a row on 2026-08-28 (Redd Bone
// Health banner stayed up 11h). Netlify's scheduler fires this at the hours our
// promo windows use (01/02/08/09 CT = 06/07/13/14 UTC) plus the 12Z safety tick;
// the runner is idempotent, so extra ticks no-op.
// Needs Netlify env var GH_DISPATCH_TOKEN (fine-grained PAT, Actions: read/write
// on Sovereigntymind/my-claude-projects only).
export default async () => {
  const token = process.env.GH_DISPATCH_TOKEN;
  if (!token) {
    console.error("promo-tick: GH_DISPATCH_TOKEN not set");
    return new Response("no token", { status: 500 });
  }
  const res = await fetch(
    "https://api.github.com/repos/Sovereigntymind/my-claude-projects/actions/workflows/promo-scheduler.yml/dispatches",
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "freelandme-promo-tick",
      },
      body: JSON.stringify({ ref: "main", inputs: { mode: "tick" } }),
    },
  );
  const msg = `promo-tick: dispatch -> HTTP ${res.status}`;
  if (res.status !== 204) {
    console.error(msg, await res.text());
    return new Response(msg, { status: 500 });
  }
  console.log(msg);
  return new Response(msg, { status: 200 });
};

export const config = { schedule: "7 6,7,12,13,14 * * *" };
