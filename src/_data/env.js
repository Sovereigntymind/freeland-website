// Build context. Preview builds run with FL_ENV=preview (PLAN.md R1-3): noindex everywhere, robots Disallow, GA hits internal.
module.exports = () => ({ preview: process.env.FL_ENV === "preview" });
