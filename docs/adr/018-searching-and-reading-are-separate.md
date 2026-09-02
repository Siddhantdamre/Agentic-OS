# 18. Searching and reading are separate capabilities

**Status:** Accepted

## Context

`researchTopicActivity` reached the web only through Jina search. Without
`JINA_API_KEY` it returned an empty report carrying the reason "no search provider
configured (JINA_API_KEY unset)".

That reason was true and the behaviour was wrong. It withheld the entire capability
over the half of it that costs money. An owner who could name three competitor URLs got
nothing, because discovery was unavailable — even though reading a page somebody has
already named needs no key at all: Jina's reader endpoint answers unauthenticated.

The same conflation appeared in the product's own description of itself. The Ask AI
greeting listed `web_search` and `web_extract` together as "always available", and the
connectors audit counted them as one blocked provider. Measured from inside the worker
container with no key: `r.jina.ai` returns HTTP 200 with real page text, `s.jina.ai`
returns 401.

## Decision

Treat discovery and retrieval as different capabilities with different costs.

- **Searching** — "what exists about this topic" — needs a paid provider.
- **Reading** — "what does this page say" — does not.

`ResearchActivityInput` accepts an optional `urls` array read through the keyless
reader, merged with search results and de-duplicated by URL. The empty-result reason
names the stage that actually came up empty, rather than blaming search for a URL that
failed to load.

Anything the product says about its own tools is computed from the environment, never
written down. Add the key and `web_search` turns on in the greeting with no code
change.

## Consequences

Competitive intelligence works with zero credentials, from sources the owner chooses.
That is also the better half for this use case: an owner knows which three competitors
matter, and watching those every morning beats discovering strangers.

Synthesis still needs the model. A run with named URLs and no model credit returns
"sources were retrieved but not analysed" — which is a different and more useful
failure than "no search provider configured".

## What breaks if you remove it

A workspace with no search budget is told it has no research capability, when in fact
it has most of one. And the greeting resumes promising a tool the agent will refuse two
messages later, which is the specific failure a demo does not survive.

## Evidence

Verified with `JINA_API_KEY` deleted from the environment: the reason moved from "no
search provider configured" to "synthesis model unavailable — sources were retrieved
but not analysed", which is the retrieval layer working.

Commits 0cd87b1 (audit correction), 8c3035d (the `urls` path).
