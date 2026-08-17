# Run & Test Prompt

Paste this to Claude Code when you want full stack up, browser-tested, bugs found and fixed.

---

Start the full Darex stack and browser-test it end to end. Fix every real bug found, don't just report.

Steps:
1. Check docker daemon (`docker info`). If Docker Desktop won't come up headless, use `colima start --cpu 4 --memory 6` and `docker context use colima` instead of fighting Docker Desktop.
2. Run `./start.sh --dev` from repo root. If port 3000 is taken by another project, run the dashboard on a free port instead: `cd apps/dashboard && ./node_modules/.bin/next dev -p 3001`.
3. Open the app in the browser tool. Sign up fresh (don't rely on demo/seed creds — DB is often empty). Walk the full onboarding wizard.
4. Click through every sidebar page: dashboard, conversations/inbox, employees, brain, listings, inquiries, insight, analytics, integrations/connectors, billing, skills, settings.
5. For each page: check the console for real errors (ignore stale buffered ones — reload and recheck), check network tab for 404/500s, click the main interactive elements (test chat, forms, filters).
6. For every real bug found (missing API route, broken render, wrong config key, crash) — find the root cause in the source, fix it, verify the fix in the browser, don't stop at "found it."
7. If AI chat replies fail, check `docker logs darex-worker` and `docker logs darex-litellm` for the real error — auth/key mismatches are common in this repo's dev env (LITELLM_MASTER_KEY vs placeholder keys, DB_PASSWORD vs APP_DB_PASSWORD in `.env`).
8. Don't touch other build/docker processes without checking `ps aux` first — this repo sometimes has another session's stack running concurrently; killing shared buildkit processes corrupts the build cache for both.
9. End with a plain summary: what was broken, what got fixed, what's left that needs a human (API keys, quotas, third-party accounts) — don't call those "bugs."
