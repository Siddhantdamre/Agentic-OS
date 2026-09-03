# 20. Search has a floor that needs no credential

**Status:** Accepted

## Context

An agent that can read a page it was handed but cannot find one is a bookmark follower,
not a researcher. It is also the agent that says "I don't have information on that",
which is the single behaviour this product cannot afford — a business hires an employee
to find out, not to report that it does not know.

Search was one call to `s.jina.ai`, which returns 401 without `JINA_API_KEY`. That key
has never been set in this deployment. So every agent's web search returned an error,
and had done since it was written.

The outage was invisible because nothing owned it. The same dead call was copied into
three files — the tool, the research activity, and the duty planner's key gate — and two
more places told the model the capability was unavailable: the MCP tool description
("Requires JINA_API_KEY") and the Ask AI route, which computed `available: jinaKey` and
therefore correctly informed the agent it could not search the web.

## Decision

**One function searches the web, and it has a floor that needs no credential.**

`tools/search-providers.ts` tries providers in order and returns the first that answers:

| | provider | credential |
|---|---|---|
| 1 | Jina | `JINA_API_KEY` |
| 2 | Brave | `BRAVE_SEARCH_API_KEY` |
| 3 | **DuckDuckGo** | **none** |
| 4 | **Wikipedia** | **none** |

Same shape as the model fallback chain (ADR 16's sibling), for the same reason: a
capability with one provider is a capability with an outage, and a paid front door must
fall to a free floor rather than to nothing.

`web_search` moves from `KEY_GATED` to `NEEDS_NO_CREDENTIAL` in the duty planner. Every
workspace can search, including one that has bought nothing.

**A result always carries the provider that produced it.** A search result that cannot be
traced is worse than no search result, because an agent will cite it either way.

**Zero results is never fabricated into something.** When every provider fails, callers
get an empty list and the list of what was tried, with the reason for each.

## Consequences

### The keyless floor throttles, and that is distinguishable from breaking

Measured: three queries fired back to back — normal inside a research loop — and
DuckDuckGo failed all three, while the same query alone returned four results. It
throttles bursts and recovers on its own. The chain backs off twice.

Zero results then has two causes that look identical from outside and need opposite
responses:

- **throttled** — the response contained no result markup at all. Transient.
- **parser stale** — the markup was there and nothing was extracted. Permanent, and it
  turns every web question in the product into "the internet had nothing on that".

The second throws with `PARSER STALE` in the message, and `check-web-search.js` fails the
build on it. Collapsing the two is how a dead parser survives for months.

### A provider that never says no needs a relevance bar

Wikipedia always returns its nearest article, however far away. Asked about
"Maharashtra ready reckoner rate hike 2026" it returned **"One Rank, One Pension"** — a
real title, a real URL, a real snippet, and an agent would have cited it. A
confidently-sourced irrelevant answer is worse than "I could not find that", because the
citation is what makes it believable.

The first relevance rule required one matching term, and Wikipedia then answered
"best CRM for Indian real estate brokers" with Cognizant, IBM and a list of unicorn
startups — every one matching on the single word "Indian". One term out of five is a
coincidence, not a topic. The bar now scales with the specificity of the question: half
its substantive terms, rounded up.

Applied only to providers that never say no. A general engine returning nothing is a real
answer.

### Somebody still gets better results with a key

Jina and Brave stay first in the chain. Brave gives 2,000 free queries a month and
removes the throttling entirely; the keyless floor is what makes the product work
without it, not an argument against buying one.

## What breaks if you remove it

Every agent goes back to answering web questions from model priors, or declining them.
The product's core promise — an employee that finds out rather than reporting that it
does not know — depends on this being reachable in a workspace that has bought nothing.

## Evidence

Verified 3 September 2026, live, in the worker container, with no search credential set:

```
Q: Maharashtra ready reckoner rate hike 2026   -> duckduckgo
   Maharashtra Freezes Ready Reckoner Rates for 2026-27  | 66mgroad.com
   Ready Reckoner Rates Maharashtra 2026: Latest Guide   | realtynxt.com
   Maharashtra's ready-reckoner hike: April 2026         | finclara.co
Q: MahaRERA new registration rules             -> duckduckgo
   MahaRERA - Maharashtra Real Estate Regulatory Authority | maharera.maharashtra.gov.in
```

`check-web-search.js` in the gate: 8/8, including that no returned URL points at the
DuckDuckGo redirector. 18/18 parser and relevance unit tests, pinned against a captured
real response so a layout change fails loudly rather than returning silence.
