//# 20 — Finish-the-SaaS Prompt

Paste everything below the line into a fresh Claude Code session at the repo
root. It picks up whatever is still open in the gap audit, then closes the
per-employee specs.

---

You are finishing Darex. Read CLAUDE.md, AGENTS.md §4a and the top 300 lines of BUILD_STATE.md first. Their commit, push and attribution rules are non-negotiable.

Goal: close every open row that code can close, verify each fix, and commit each one separately on main. Push when a batch is done.

1. Leftovers: in docs/new-109-pg-plan/gap26sept/*.md (not employees/), list every row still 🟡 or 🔴. For each one, confirm in code whether the gap is real. Fix it if code can fix it. If it needs a human (keys, OAuth IDs, a product decision, or an approval-table schema change), mark it 🔴 with the reason. Never fake a 🟢.

2. Employee specs: work through docs/new-109-pg-plan/gap26sept/employees/*.md one employee at a time. Order: executive, customer-support, sales-lead-gen, growth, customer-resolution, operations, finance, marketing-analytics, research, custom-employee. For each 🟡/🔴 row, make the employee really do that job from the /ask-ai chat, with the right tools, its own allowlist, and approval before risky actions. Also cover the Auto / Pick one / Team mode selector rows.

3. Per row: read the doc row, confirm the gap in code, then fix it. Build services/workflows and run the relevant tests. Typecheck apps/dashboard and run the relevant jest tests. If the stack is running, prove the change live from /ask-ai. Update the tracker row and add a BUILD_STATE.md entry in the same commit.

4. Commits: one row or feature per commit. Stage with git add <explicit paths>. Use conventional messages like fix|feat(<scope>): ... with a body saying why and what was verified. No AI or co-author lines. Before pushing, check git log origin/main..HEAD for 'claude|anthropic|generated with'; it must find nothing. Never --no-verify, never force-push.

5. You may use a multi-agent workflow with isolated worktrees for parallel work, then cherry-pick onto main. Keep BUILD_STATE.md and tracker entries from both sides when resolving conflicts.

Stop when every row is 🟢 or 🔴 with a human-only reason. Finish with a short report listing what was closed, what is blocked and why, and the test and push results.
