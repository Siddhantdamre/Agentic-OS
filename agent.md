# Git Commit Workflow

## Mandatory Git Commit Policy

You must create **frequent, meaningful Git commits** throughout development.

Do **NOT** wait until the entire feature, task, or project is finished before committing.

The goal is to keep the Git history clean, traceable, and easy to revert.

### 1. Commit After Every Completed Feature

Whenever you complete a distinct feature, functionality, module, fix, or meaningful implementation step, create a Git commit immediately.

Examples:

* Add authentication → commit
* Add login API → commit
* Add login UI → commit
* Add database schema → commit
* Add dashboard → commit
* Add API integration → commit
* Add validation → commit
* Fix authentication bug → commit
* Add error handling → commit
* Add tests → commit
* Update deployment configuration → commit

Each commit should represent **one logical change**.

### 2. Do Not Combine Unrelated Changes

Avoid large commits containing multiple unrelated features.

Bad:

```text
feat: complete entire application
```

when the commit contains authentication, dashboard, payments, APIs, UI changes, and deployment.

Instead, split them:

```text
feat(auth): add authentication system
feat(auth): add login API
feat(auth): add login UI
feat(dashboard): add dashboard layout
feat(api): add user profile endpoint
fix(auth): handle expired sessions
test(auth): add authentication tests
```

### 3. Commit Naming Convention

Use Conventional Commits.

Preferred format:

```text
<type>(<scope>): <short description>
```

Examples:

```text
feat(auth): add JWT authentication
feat(api): add user profile endpoint
feat(ui): add dashboard navigation
fix(api): handle invalid user ID
fix(auth): prevent expired token errors
refactor(db): simplify user queries
test(auth): add login test coverage
docs(api): document authentication endpoints
chore(deps): update dependencies
```

Use these types where appropriate:

* `feat` — new functionality
* `fix` — bug fix
* `refactor` — code restructuring without behavior change
* `test` — tests
* `docs` — documentation
* `chore` — maintenance/configuration
* `perf` — performance improvement
* `style` — formatting/style-only changes
* `build` — build system changes
* `ci` — CI/CD changes

### 4. Before Every Commit

Before committing, inspect the changes.

Run:

```bash
git status
git diff
```

Make sure:

* Only relevant files are included.
* No secrets are being committed.
* `.env` files and credentials are not accidentally included.
* Temporary/debug files are not included.
* The change actually belongs to the commit.
* The code is in a reasonably working state.

Then stage only the relevant files:

```bash
git add <relevant-files>
```

Avoid blindly using:

```bash
git add .
```

when it could include unrelated or sensitive files.

### 5. Verify Before Committing

For each meaningful feature, run the appropriate checks before committing.

Depending on the project, this may include:

```bash
npm test
npm run lint
npm run build
```

or:

```bash
pytest
```

or the project's equivalent commands.

Do not commit known broken code unless the commit specifically represents a work-in-progress checkpoint and there is a clear reason to preserve it.

### 6. Commit Immediately After the Feature

Once a logical feature is complete and verified:

```bash
git add <files>
git commit -m "feat(scope): description"
```

Then continue working on the next feature.

Do not accumulate many completed features and commit them all together.

### 7. Keep Commits Atomic

A commit should answer:

> "What single logical change does this commit introduce?"

If the answer contains several unrelated changes, split the work into multiple commits.

Good:

```text
feat(users): add user registration
feat(users): add email validation
test(users): add registration tests
```

Bad:

```text
feat(users): implement everything
```

### 8. If a Feature Has Multiple Independent Parts

Break it into multiple commits.

For example, if implementing a payment system:

```text
feat(payments): add payment database models
feat(payments): add payment API
feat(payments): integrate payment provider
feat(payments): add payment UI
test(payments): add payment API tests
fix(payments): handle failed payments
```

### 9. Do Not Rewrite Existing Git History

Do not use destructive Git operations such as:

```bash
git reset --hard
git push --force
git push --force-with-lease
```

unless the user explicitly requests it.

Do not rewrite or squash existing commits just to make the history look cleaner.

Preserve the existing project history.

### 10. Check Git State Before Starting Work

At the beginning of a task, inspect:

```bash
git status
git branch --show-current
git log --oneline -10
```

Understand the current repository state before making changes.

If there are existing uncommitted changes made by the user, **do not overwrite or discard them**.

Work around them and make sure your commit does not accidentally include unrelated user changes.

### 11. Never Commit Secrets

Never commit:

```text
.env
.env.*
*.pem
*.key
credentials.json
service-account.json
API keys
access tokens
private keys
passwords
database credentials
```

If secrets are accidentally discovered in the working tree, stop and handle them safely rather than committing them.

### 12. End-of-Task Git Check

After completing the requested work, run:

```bash
git status
git log --oneline -10
```

Confirm that:

1. All completed logical features have appropriate commits.
2. No unrelated files were committed.
3. No secrets were committed.
4. The working tree is clean, unless there are intentional uncommitted changes.
5. Commit messages clearly describe the changes.

## Core Rule

**One meaningful feature/fix = one meaningful Git commit.**

Commit continuously during development, not only at the end.

The Git history should make it possible for another developer to understand exactly how the project was built, feature by feature.
