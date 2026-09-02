# Darex — Agent Working Rules

> Repo map, architecture, and code conventions live in **`AGENTS.md`** — read it
> first. This file covers how work is committed and pushed. These rules are not
> optional.

---

## 1. Attribution — never mention the AI

**No commit, PR, branch name, or code comment may mention Claude, Anthropic, or
any AI assistant.** The git history belongs to the humans on this repo.

Specifically forbidden in any commit message or PR body:

- `Co-Authored-By: Claude ...` or any AI co-author trailer
- `Claude-Session:` or any session URL
- `🤖 Generated with ...` footers
- "written by AI", "AI-generated", "with the help of ...", or equivalents

Before pushing, verify:

```bash
git log origin/main..HEAD --format='%an|%ae|%cn|%ce|%B' | grep -i 'claude\|anthropic\|generated with'
```

Zero matches, or fix before pushing. If a bad commit is already pushed and it is
the only new commit, amend and `git push --force-with-lease`. If other commits
landed on top, do **not** rewrite shared history — say so and ask.

The author and committer must be the repo user's real git identity. Never set
`--author` to anything else.

---

## 2. Commit at feature level, one concern per commit

**Never dump unrelated work into one commit.** Split by feature or concern so
history is readable and a single change can be reverted on its own.

Split when the change touches:

- different features or product surfaces (Ask AI vs. connectors vs. billing)
- different layers where one is independently revertable (migration vs. UI)
- fix vs. feature vs. docs vs. refactor vs. chore
- unrelated bugs, even in the same file

Keep together when splitting would break the build or leave the repo in a state
that does not run. A migration and the code that requires it ship in one commit.

### Message format

```
<type>(<scope>): <what changed, imperative, lower case, no trailing period>

<why it changed, what broke before, what is verified now — wrap at 72 cols>
<the reasoning matters more than the diff six months later>
```

`type`: `feat` · `fix` · `docs` · `refactor` · `test` · `chore` · `perf` ·
`build` · `ci`

`scope`: the feature area — `ask-ai`, `memory`, `connectors`, `workflows`,
`billing`, `auth`, `packs`, `rls`, `dashboard`, `infra`, `evals`.

Good:

```
fix(tool-executor): resolve org allowlist as union of all active employees

Fallback picked one arbitrary active employee, blocking tools the org
actually owned — approved plans failed every step with "not in allowed
tool list". Now unions all active employees' allowlists plus core tools
plus connected connectors. Verified live: sheets_create and drive_list
execute against real accounts.
```

Bad: `update stuff`, `fixes`, `wip`, or one commit spanning a migration, three
API routes, and a README.

### Staging

Stage paths explicitly (`git add <path>`), never `git add -A` or `git add .` —
that is how scratch files, `.env`, and unrelated work get committed. Check
`git status --short` before every commit and leave anything you did not intend
to ship untracked.

---

## 3. Pushing

- Work on a branch. Only commit directly to `main` when the user says so.
- Push all the feature-level commits together in one `git push`; do not squash
  them into one commit to "make the push simpler". Multiple clean commits in one
  push is the goal.
- Never `git push --force` to a shared branch. `--force-with-lease` only, and
  only to fix a commit you just pushed that nobody else has built on.
- The pre-push hook runs typecheck, build, and tests. If it fails, fix the cause
  — never `--no-verify`.
- Report honestly: if tests fail, say so with the output. Never claim a push
  succeeded without checking the result.

---

## 4. What never gets committed

- Secrets, tokens, real client IDs, `.env*` files
- Scratch files, scratchpads, personal notes, agent tooling directories
- Generated build output, `dist/`, `node_modules/`
- Fake or placeholder credentials that look real

---

## 5. Keep `BUILD_STATE.md` current

Any change that alters runtime behaviour updates `BUILD_STATE.md` **in the same
commit** — what changed, why, and what was verified. It is the live source of
truth across sessions, and the reasoning is the part that is expensive to
recover later.
