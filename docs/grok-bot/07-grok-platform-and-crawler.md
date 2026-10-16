# Rest of Grok, and the "GrokBot" crawler (a different thing)

## Grok platform features (context)

From third-party feature guides; dates as reported.

| Feature | Notes |
|---|---|
| DeepSearch / DeeperSearch | Multi-step research over web and X; DeepSearch capped at 10 search steps |
| Think mode / Expert mode | Visible chain-of-thought; higher compute than Auto |
| Imagine | Text-to-image (Aurora), image editing, text-to-video with native audio (v1.0 Feb 2026) |
| Voice, Camera mode | Real-time voice (redesigned Jul 2025), scene analysis while talking |
| Companions | 3D characters with persistent memory (Jul 2025) |
| Memory | Cross-session memory, consumer apps (beta Apr 2025) |
| Projects, Tasks | File containers with instructions; scheduled automation |
| Build | Agentic coding tool (Grok Build), parallel agents |

## Grok API (docs.x.ai)

Unified endpoint `api.x.ai/v1`, OpenAI-client compatible. Responses API (text,
multi-turn, tools), Voice API, Imagine API (images, video), Code API (Grok Build),
function calling, web search, structured outputs, Batch API.

## The "GrokBot" web crawler is not Grok Bot

Searching "xAI grok bot" mixes up two things:

| | Grok Bot | GrokBot / xAI-Bot crawler |
|---|---|---|
| What | Product: AI teammates app | Web fetchers feeding Grok |
| URL | x.ai/bot | none official |
| Relevant to | Users doing work | Site owners |

Crawler facts (all third-party; xAI publishes no crawler docs):

- Names seen in directories: `GrokBot`, `xAI-Grok`, `Grok-DeepSearch`, family
  called `xAI-Bot`.
- Functions: training crawl, retrieval for DeepSearch, on-demand page fetch, and
  the X firehose (cannot be blocked by robots.txt).
- Real traffic often uses generic browser or iPhone user agents from datacenter
  proxies, so robots.txt rules may not reach it. Grok has said it uses an iPhone
  UA string to avoid blocks.
- Suggested rule for site owners:
  ```
  User-agent: xAI-Bot
  Allow: /
  Disallow: /account/
  ```
- robots.txt is advisory. Protect sensitive data with authentication.
