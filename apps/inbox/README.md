# apps/inbox — Chatwoot Fork (Phase 3)

This directory will contain the Darex-branded fork of [Chatwoot](https://github.com/chatwoot/chatwoot).

**Status:** Placeholder. Populated in **Phase 3**.

## What goes here
- Full Chatwoot Ruby on Rails backend (forked, not rebuilt)
- Darex branding applied to the Chatwoot Vue frontend
- WhatsApp Cloud API + Email inbound/outbound channels
- Webhook configuration pointing to `/services/workflows` for AI routing

## Why Chatwoot (not a custom inbox)
Chatwoot already solves: org/agent model, multi-channel ingestion (WhatsApp/Email/FB/IG), conversation assignment, canned responses, and a dashboard shell. Forking saves months over a from-scratch inbox.

## Phase 3 Entry Checklist
- [ ] `git clone --depth 1 https://github.com/chatwoot/chatwoot .`
- [ ] Apply Darex brand overrides (colors, logos, wordmark)
- [ ] Strip unused features (unnecessary integrations, non-needed channels)
- [ ] Configure WhatsApp Cloud API webhook
- [ ] Configure outbound webhook → `services/workflows`
