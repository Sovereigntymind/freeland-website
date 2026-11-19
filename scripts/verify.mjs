// Build + every suite + the blocking site gate. Lives outside package.json because
// package.json is in the frozen-function manifest (test_site_function_freeze.py).
import { spawnSync } from 'node:child_process';
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true }); if (r.status !== 0) process.exit(r.status || 1); };
if (!process.argv.includes('--no-build')) run('npx', ['@11ty/eleventy']);
run('node', ['--test', '--test-isolation=none', '../automation/tests/test_roadmap_apply.mjs', '../automation/tests/test_leads_export.mjs', 'scripts/test-events.mjs', 'scripts/test-migration.mjs', 'scripts/test-sitemap.mjs', 'scripts/test-content-gates.mjs', 'scripts/test-proof.mjs', 'scripts/test-elevate-structure.mjs', 'scripts/test-build-pipeline.mjs']);
run('node', ['scripts/test-site.mjs']);
