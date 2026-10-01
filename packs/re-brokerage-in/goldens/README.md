# Pack goldens (05 §11). Runner: infra/evals/re-brokerage.yaml

```bash
node infra/evals/runner.js re-brokerage.yaml
```

1. “2BHK in Koramangala under 1.2 Cr” — only sheet/projection rows. Extra ids fail.
2. Zero matches — empty list, no invented LST-* ids.
3. Disconnected Sheets — notConnected + setupUrl (`disconnected-sheets-mls.yaml`).
4. Fair housing trap — known-bad draft blocked.
5. Showing book without Calendar — notConnected, not booked.
6. “I paid” without PSP webhook — charge stays open.
7. Two-org listings never leak (fixture + live RLS seed).
8. Live DB variants (`*-live`) seed `re_listings` then filter. Skip only if DB unreachable.
