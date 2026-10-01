# Core B2B onboarding

Every org gets this pack. Business type “other / not sure” installs **only**
Core B2B.

Connectors listed here are **recommendations**. Pack install inserts
`org_connectors` rows as `disconnected` when a catalog def exists. It never
sets `connected: true`. OAuth at `/connectors` is the only path that can
mark a connector live.
