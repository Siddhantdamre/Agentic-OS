# Takeaways for Darex

Grok Bot is close to Darex's own direction: named AI employees, shared memory,
chat as the front door, approval before risky actions. Comparison, from the
research only (no Grok code exists in this repo):

| Grok Bot idea | Darex angle |
|---|---|
| Named role Bots with a job description | Matches per-employee specs and the Auto / Pick one / Team selector |
| Group chats, bot-to-bot handoff, single owner per stage | Team mode in Ask AI |
| Skills (`/`) and connectors (`@`) in the composer | Chat coverage of every tool and tab action |
| Routines on schedule or event | Workflows and daily brief |
| Draft-first prompts ("do not send") | Approval before risky actions |
| Computer use for API-less apps | Fallback when no connector exists |
| Watch-me-once skill capture | Possible future onboarding path |

## Where Grok Bot is weak and Darex can be stronger

- Shared credentials across all Bots, no isolation between roles.
- Approvals advisory, no dry run, no per-action audit view, actions logged as the
  human user.
- No grounding in a company knowledge base; memory is per Bot.
- No compliance certifications.

Darex's shared "brain" (memory plus connectors), per-employee tool allowlists and
approval plans map directly onto these gaps.

## Caveat

Treat the competitive read as directional: Grok Bot is an early beta and much of
the critical detail above comes from one reviewer.
