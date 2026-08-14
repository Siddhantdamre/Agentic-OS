# @darex/shared-types

Shared TypeScript contracts for Darex apps and services.

**Status:** Used by `@darex/dashboard` and `@darex/workflows`. Types only — no runtime I/O.

## What lives here

- Domain: `Org`, `User`, `AIEmployee`, `Channel`, `Conversation`, `Message`
- Agent: `AgentTaskInput`, `AgentTaskResult`, `ToolExecutionResult`
- Ask AI: `ClassifyResult`, `PlanStep`, `GeneratedPlan`
- Crew: `CrewPlan`, `CrewWorkflowInput`, `MAX_CREW_SPAWN`
- Memory: `MemoryRecord`, `KnowledgeSource`, `RetrieveMemoryRequest`, `MemoryWriteBackPayload`
- Work item: `WorkItem`, `WorkEvent`, `WorkItemWorkflowInput`
- Risk: `RiskClass`, `ConfirmPolicy`, `ToolRiskMeta`, `DataClass`
- Registry: `ConnectorDef`, `OrgConnector`, `SyncCursor`
- Pack: `PackManifest`, `OrgPack`, `PackInstallState`
- Billing: `BillingSubscription`, `UsageMeter`, `BillingPlanType`
- Audit: `AuditEvent`, `DsrRequest`
- Metrics: `MetricDefinition`, `InsightCard`, `EvalRun`

Unions are exhaustive-switch-ready (`kind` / `tier` / `provider` / `meterType` / `actorType` discriminants, plus `as const` catalogs). Tenant records carry `orgId`.

Import:

```ts
import type { PlanStep, ToolExecutionResult, WorkItem, RiskClass } from '@darex/shared-types';
import { RISK_CLASSES, WORK_ITEM_STATUSES } from '@darex/shared-types';
```
