# @darex/shared-types

Shared TypeScript contracts for Darex apps and services.

**Status:** Used by `@darex/dashboard` and `@darex/workflows`. Types only — no runtime I/O.

## What lives here

- Domain: `Org`, `User`, `AIEmployee`, `Channel`, `Conversation`, `Message`
- Agent: `AgentTaskInput`, `AgentTaskResult`, `ToolExecutionResult`
- Ask AI: `ClassifyResult`, `PlanStep`, `GeneratedPlan`

Import:

```ts
import type { PlanStep, ToolExecutionResult } from '@darex/shared-types';
```
