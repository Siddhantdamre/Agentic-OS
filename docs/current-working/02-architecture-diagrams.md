# 02 — Architecture diagrams

All diagrams are mermaid (render in GitHub / Cursor preview). They describe the
**current code** as of 2026-08-14, not the original spec. Each diagram shows a
specific architectural concern or data flow.

## 1. System context (14 services)

```mermaid
flowchart LR
  subgraph Clients["Clients"]
    User["Browser User"]
    Widget["Embed Widget"]
    Meta["Meta WhatsApp"]
    IG["Meta Instagram"]
    Chatwoot["Chatwoot Webhook"]
  end

  subgraph Core["Core Services :3000"]
    Dash["Dashboard<br/>(Next.js)"]
  end

  subgraph Auth["Auth & Config"]
    ST["SuperTokens<br/>:3567"]
    Nango["Nango<br/>:3003"]
    Redis["Redis<br/>:6379"]
  end

  subgraph Agent["Agent & Tools"]
    AA["atomic-agent<br/>:8787 SSE"]
    Bridge["MCP Bridge<br/>:8790"]
    Exec["Tool Executor"]
  end

  subgraph Orchestration["Orchestration"]
    Temporal["Temporal Server<br/>:7233"]
    Worker["Temporal Worker"]
    Queue["Task Queue"]
  end

  subgraph Data["Data & Traces"]
    PG["Postgres<br/>:5432"]
    Langfuse["Langfuse<br/>:3002"]
    CH["ClickHouse<br/>(persistence)"]
  end

  subgraph Compute["Compute"]
    Sandbox["Sandbox<br/>:8080"]
    LLM["LiteLLM<br/>:4000"]
  end

  subgraph Providers["Provider APIs"]
    Gmail["Gmail"]
    GSheets["Google Sheets"]
    GDrive["Google Drive"]
    Zoho["Zoho CRM"]
    QBO["QuickBooks"]
    Jina["Jina"]
  end

  subgraph Inbox["Inbox Gateway"]
    IGW["Inbox :3004<br/>(HMAC)"]
  end

  Clients --> Dash
  Dash --> Auth
  Dash --> Core
  Dash --> Agent
  Dash --> Orchestration
  Dash --> Data
  Dash --> Compute
  Temporal --> Worker
  Worker --> Agent
  Agent --> Exec
  Bridge --> Exec
  Exec --> Nango
  Exec --> Providers
  Exec --> PG
  Exec --> Sandbox
  Exec --> Jina
  Exec --> LLM
  Langfuse --> CH
  IGW --> Dash
```

## 2. Monorepo architecture

```mermaid
graph TD
  subgraph Apps["Apps"]
    Dashboard["apps/dashboard<br/>Next.js 14<br/>(UI + all API routes)"]
    Inbox["apps/inbox<br/>Express :3004<br/>(Chatwoot proxy)"]
  end

  subgraph Services["Services"]
    WF["services/workflows<br/>Temporal worker<br/>MCP bridge<br/>Tool executor<br/>RAG pipelines"]
    Connectors["services/connectors<br/>Nango SDK wrappers<br/>(test proxy only)"]
  end

  subgraph Packages["Packages"]
    SharedTypes["packages/shared-types<br/>(README placeholder)"]
  end

  subgraph Infra["Infra"]
    Docker["infra/docker<br/>14 Dockerfiles"]
    Migrations["infra/migrations<br/>14 SQL migrations"]
    Scripts["infra/scripts<br/>LiteLLM setup<br/>compose commands"]
  end

  Dashboard -->|import @darex/workflows/dist| WF
  Dashboard -->|import @darex/connectors| Connectors
  Inbox -.->|thin proxy| Dashboard
  WF -->|read| SharedTypes
  Dashboard -->|read| SharedTypes
```

## 3. Ask AI execution (simple vs complex vs plan)

```mermaid
flowchart TD
  Start["User: Ask AI question"] --> Input["POST /api/ask-ai<br/>(streaming)"]
  Input --> Classify["classifyRequest<br/>(LiteLLM JSON)"]

  Classify -->|simple| SimplePath["Simple Q&A"]
  SimplePath --> DirectAgent["runAutonomousAgentDirect<br/>(NDJSON stream)"]
  DirectAgent --> AA1["atomic-agent :8787"]
  AA1 --> MCP1["MCP Bridge :8790"]
  MCP1 --> Exec1["Tool Executor"]
  Exec1 --> Result1["Response ~6s"]

  Classify -->|complex| ComplexPath["Complex multi-step"]
  ComplexPath --> Plan["generatePlan<br/>(LiteLLM JSON)"]
  Plan --> SavePlan["INSERT agent_plans<br/>(pending)"]
  SavePlan --> UI["PlanCard UI<br/>+ DraftPanel"]
  UI --> Approve{Human Approve?}
  Approve -->|Revise| Revise["POST /api/ask-ai/revise<br/>(LiteLLM only)"]
  Revise --> UI
  Approve -->|Execute| Execute["GET SSE /api/ask-ai/execute"]
  Execute --> Stage["stageSteps<br/>(parallel)"]
  Stage --> ParallelExec["executeAutonomousToolAction<br/>(skip atomic-agent)"]
  ParallelExec --> Result2["Response ~13s<br/>(per step)"]
  Approve -->|Reject| Reject["Fallback direct agent"]
  Reject --> AA1

  Result1 --> Display["Display on page<br/>+ save to messages table"]
  Result2 --> Display
```

## 4. Authentication & tenancy (RLS)

```mermaid
sequenceDiagram
  participant User as Browser
  participant MW as middleware.ts
  participant API as Dashboard API
  participant DB as Postgres RLS
  participant Cache as Redis

  User->>MW: GET /dashboard (cookie)
  MW->>MW: extract darex_session cookie
  MW->>API: getScopedClient(userId)
  API->>DB: SELECT org_id FROM users WHERE id=$1
  DB-->>API: org_id
  API->>DB: BEGIN; SET app.current_org_id = $org_id
  DB->>Cache: SETEX org:{userId} 86400 {orgId}
  API-->>User: HTTP response (RLS active)
  Note over DB: All future queries filtered by<br/>app.current_org_id via RLS policy
  API->>DB: SELECT * FROM conversations<br/>(RLS: org_id = app.current_org_id)
  DB-->>API: only org's conversations
```

## 5. OAuth connection flow (Nango)

```mermaid
sequenceDiagram
  participant UI as Integrations UI
  participant API as GET/POST /api/integrations/nango-token
  participant Nango as Nango :3003
  participant DB as channels table
  participant PG as Postgres

  UI->>API: GET ?provider=gmail
  API->>DB: SELECT * FROM channels WHERE org_id=$1 AND channel_type=$2
  DB-->>API: existing record (if any)
  API-->>UI: publicKey, connectionId={orgId}_{provider}
  UI->>Nango: nango.auth(provider, connectionId)
  Nango-->>UI: OAuth popup (Gmail/Google)
  UI-->>Nango: Grant permissions (gmail.compose scope)
  Nango-->>UI: OAuth complete, close popup
  UI->>API: POST confirm connection
  API->>Nango: GET /connections/{connectionId}
  Nango-->>API: { connectionId, credentials: {token, refresh} }
  API->>PG: UPSERT channels (org_id, channel_type=gmail, metadata={connectionId})
  PG-->>API: upserted
  API-->>UI: success + refresh integrations list
```

## 6. Inbound channels (all types)

```mermaid
flowchart TD
  subgraph Channels["Inbound Channels"]
    WA["WhatsApp<br/>(Meta Graph)"]
    Gmail["Gmail<br/>(Nango + polling)"]
    IG["Instagram DM<br/>(Meta Graph)"]
    SMS["SMS<br/>(Twilio/Plivo)"]
    CW["Chatwoot<br/>(HMAC)"]
    Widget["Embed Widget<br/>(iframe)"]
  end

  subgraph Webhook["Webhook Endpoints"]
    WAH["/api/webhooks/whatsapp<br/>(X-Hub-Signature-256)"]
    CWGH["/api/webhooks/chatwoot<br/>(HMAC)"]
    SMSH["/api/webhooks/sms"]
    IGH["/api/webhooks/instagram"]
    GH["/api/webhooks/gmail"]
    WidgetH["/api/webhooks/widget"]
  end

  subgraph Gateway["Inbox Gateway :3004"]
    HMAC["HMAC signer<br/>+ forwarder"]
  end

  subgraph Persist["Persist & Route"]
    Conv["INSERT conversations"]
    Msg["INSERT messages"]
    Log["INSERT channel_logs"]
  end

  subgraph Process["Process"]
    SSE["Emit needs_attention<br/>(SSE /api/stream/events)"]
    Agent["fireInboundAgent<br/>(Temporal or direct)"]
  end

  subgraph Outbound["Outbound Response"]
    AgentReply["Agent generates reply"]
    Send["channel.send()<br/>(provider-specific)"]
  end

  WA --> WAH
  Gmail --> GH
  IG --> IGH
  SMS --> SMSH
  CW --> CWGH
  Widget --> WidgetH

  WAH --> HMAC
  GH --> HMAC
  IGH --> HMAC
  SMSH --> HMAC
  CWGH --> HMAC
  WidgetH --> HMAC

  HMAC --> Conv
  HMAC --> Msg
  HMAC --> Log
  HMAC -->|200 OK| Channels

  Conv --> SSE
  Msg --> Agent
  Log --> Agent

  Agent --> AgentReply
  AgentReply --> Send
  Send -->|provider API| Channels
```

## 7. Tool execution with Nango & RLS

```mermaid
sequenceDiagram
  participant caller as MCP Bridge
  participant executor as executeAutonomousToolAction<br/>tool-executor.ts
  participant cache as Redis<br/>(60s tool allowlist)
  participant rls as Postgres RLS
  participant nango as Nango Vault
  participant provider as Provider API<br/>Gmail/Sheets/etc

  caller->>executor: tool={name}, args={...}
  executor->>executor: extract org_id from session
  executor->>cache: GET tool_allowlist:{orgId}
  alt cache hit
    cache-->>executor: [tools...]
  else cache miss
    executor->>rls: SELECT employees.tool_allowlist<br/>+ channels.channel_type<br/>WHERE org_id=$org
    rls-->>executor: [tools...]
    executor->>cache: SET 60s
  end
  executor->>executor: isToolAllowed(tool)?
  alt not in allowlist
    executor-->>caller: error: not allowed
  else allowed
    executor->>executor: authenticate from session
    alt tool needs OAuth
      executor->>nango: GET credential<br/>{orgId}_{provider}
      nango->>nango: decrypt per-org secret
      nango-->>executor: token + refresh
    end
    executor->>provider: HTTP call<br/>(Authorization: Bearer token)
    provider-->>executor: result
    executor-->>caller: tool result JSON
  end
```

## 8. Temporal workflow orchestration

```mermaid
graph TD
  Inbound["Inbound trigger<br/>(webhook/conversation)"]
  Temporal["Temporal Server<br/>:7233"]
  
  Inbound --> Dispatch{Which Workflow?}
  
  Dispatch -->|Solo agent| AutoWF["AutonomousAgentWorkflow<br/>(max 3 turns)"]
  Dispatch -->|Multiple agents| CrewWF["CrewWorkflow<br/>(fan-out 3 child)"]
  Dispatch -->|RAG| RAGWF["RAG IngestWorkflow<br/>(chunks→embeddings)"]
  Dispatch -->|Task| WorkItemWF["WorkItemWorkflow<br/>(async task)"]
  Dispatch -->|Scheduled| NurtureWF["NurtureWorkflow<br/>(lead follow-up)"]
  Dispatch -->|Scheduled| BriefingWF["BriefingWorkflow<br/>(daily digest)"]
  Dispatch -->|Post-execute| MemoryWF["MemoryWriteBackWorkflow<br/>(org learning)"]
  Dispatch -->|Integration| IntWF["Integration-specific<br/>(Zoho/QBO/etc)"]

  AutoWF --> Activity1["runAgentTurnActivity"]
  CrewWF --> Planner["Crew Planner<br/>(LiteLLM)"]
  Planner --> Fanout["Fan-out<br/>3x AutonomousAgentWorkflow<br/>(each own sessionKey)"]
  Fanout --> Manager["Manager Synthesis<br/>(LiteLLM)"]
  
  Activity1 --> AA["atomic-agent :8787"]
  AA --> Tool["Tool calls via MCP"]
  Tool --> Exec["executeAutonomousToolAction"]
  Exec --> DB["Postgres RLS queries"]
  Exec --> Nango["Nango token fetch"]
  Exec --> Provider["Provider APIs"]
  
  Activity1 -->|isDone?| Loop{Continue?}
  Loop -->|yes, < 3 turns| Activity1
  Loop -->|no, done| SaveMsg["saveMessageActivity"]
  
  SaveMsg --> Channel["logChannelActivity<br/>(if from channel)"]
  Channel --> Outbound["send via channel<br/>(WhatsApp/Gmail/etc)"]
  
  Manager --> SaveMsg
  RAGWF --> Embed["Generate embeddings<br/>(via LLM)"]
  Embed --> Vec["INSERT pgvector"]
  
  NurtureWF --> Schedule["Schedule next follow-up"]
  BriefingWF --> Generate["Generate digest<br/>(LLM + data)"]
  Generate --> Email["Email org users"]
  
  MemoryWF --> Learning["Extract facts<br/>from agent transcript"]
  Learning --> Store["INSERT org_memory<br/>with confidence"]
  
  Temporal -.-> Activity1
  Temporal -.-> Planner
  Temporal -.-> SaveMsg
  Temporal -.-> Channel
```

## 9. Tool allowlist resolution

```mermaid
flowchart TD
  Call["executeAutonomousToolAction called<br/>with org_id + tool name"]
  HasList{"Caller passed<br/>toolAllowlist?"}
  
  HasList -->|yes| UseProvided["Use provided list<br/>+ always add core tools"]
  HasList -->|no| CheckCache["Check Redis cache<br/>tool_allowlist:{orgId}"]
  
  CheckCache -->|hit| UseCached["Use cached list<br/>(60s TTL)"]
  CheckCache -->|miss| QueryDB["Query org's resources"]
  
  QueryDB --> EmpTools["SELECT employees.tool_allowlist<br/>WHERE org_id=$1<br/>AND enabled=true"]
  QueryDB --> ChannelTools["SELECT channel_type<br/>FROM channels<br/>WHERE org_id=$1<br/>AND connected=true"]
  QueryDB --> CoreTools["Add hardcoded:<br/>web_search<br/>web_extract<br/>database_query<br/>file_ops<br/>sandbox"]
  
  EmpTools --> Union["UNION all lists"]
  ChannelTools --> Union
  CoreTools --> Union
  
  Union --> Cache["SETEX Redis 60s"]
  UseCached --> Normalize["normalize tool name<br/>(underscores, hyphens)"]
  UseProvided --> Normalize
  Cache --> Normalize
  
  Normalize --> Check{"isToolAllowed<br/>(normalized)?"}
  Check -->|no| Deny["DENY<br/>error: tool not in allowed list<br/>+ log attempt"]
  Check -->|yes| Allow["ALLOW<br/>proceed to execution"]
```

## 10. Complete database schema (tenant + system tables)

```mermaid
erDiagram
  ORGS ||--o{ USERS : contains
  ORGS ||--o{ ORG_MEMBERS : defines
  ORGS ||--o{ ORG_INVITES : generates
  ORGS ||--o{ CHANNELS : owns
  ORGS ||--o{ CONVERSATIONS : has
  ORGS ||--o{ MESSAGES : has
  ORGS ||--o{ AI_EMPLOYEES : has
  ORGS ||--o{ AGENT_PLANS : has
  ORGS ||--o{ CHANNEL_LOGS : tracks
  ORGS ||--o{ ORG_MEMORY : stores
  ORGS ||--o{ ORG_ONBOARDING : has
  ORGS ||--o{ LISTINGS : has
  ORGS ||--o{ SHOWINGS : schedules
  ORGS ||--o{ IDEMPOTENCY_KEYS : uses
  ORGS ||--o{ AUDIT_LOGS : tracks
  ORGS ||--o{ ORG_SUBSCRIPTIONS : has
  ORGS ||--o{ BILLING_METERS : tracks

  USERS ||--o{ ORG_MEMBERS : has_role
  CONVERSATIONS ||--o{ MESSAGES : contains
  AI_EMPLOYEES ||--o{ CONVERSATIONS : assigned
  CHANNELS ||--o{ CONVERSATIONS : sources
  LISTINGS ||--o{ SHOWINGS : has

  ORGS : int id PK
  ORGS : string name
  ORGS : string slug
  ORGS : jsonb metadata
  ORGS : timestamp created_at

  USERS : int id PK
  USERS : string email UK
  USERS : int org_id FK
  USERS : string password_hash
  USERS : string name

  ORG_MEMBERS : int id PK
  ORG_MEMBERS : int org_id FK
  ORG_MEMBERS : int user_id FK
  ORG_MEMBERS : string role
  ORG_MEMBERS : timestamp joined_at

  CHANNELS : int id PK
  CHANNELS : int org_id FK
  CHANNELS : string channel_type
  CHANNELS : jsonb metadata
  CHANNELS : boolean connected
  CHANNELS : timestamp connected_at

  CONVERSATIONS : int id PK
  CONVERSATIONS : int org_id FK
  CONVERSATIONS : int channel_id FK
  CONVERSATIONS : string external_id
  CONVERSATIONS : string participant_id
  CONVERSATIONS : string status
  CONVERSATIONS : timestamp created_at

  MESSAGES : int id PK
  MESSAGES : int org_id FK
  MESSAGES : int conversation_id FK
  MESSAGES : string role
  MESSAGES : text content
  MESSAGES : jsonb metadata
  MESSAGES : timestamp created_at

  AI_EMPLOYEES : int id PK
  AI_EMPLOYEES : int org_id FK
  AI_EMPLOYEES : string name
  AI_EMPLOYEES : string persona
  AI_EMPLOYEES : jsonb tool_allowlist
  AI_EMPLOYEES : boolean enabled

  AGENT_PLANS : int id PK
  AGENT_PLANS : int org_id FK
  AGENT_PLANS : int user_id FK
  AGENT_PLANS : jsonb steps
  AGENT_PLANS : string status
  AGENT_PLANS : timestamp created_at

  ORG_MEMORY : int id PK
  ORG_MEMORY : int org_id FK
  ORG_MEMORY : text content
  ORG_MEMORY : vector embedding
  ORG_MEMORY : float confidence
  ORG_MEMORY : timestamp created_at

  AUDIT_LOGS : int id PK
  AUDIT_LOGS : int org_id FK
  AUDIT_LOGS : int user_id FK
  AUDIT_LOGS : string action
  AUDIT_LOGS : jsonb changes
  AUDIT_LOGS : timestamp created_at

  LISTINGS : int id PK
  LISTINGS : int org_id FK
  LISTINGS : string address
  LISTINGS : string status
  LISTINGS : float price
  LISTINGS : timestamp created_at

  SHOWINGS : int id PK
  SHOWINGS : int org_id FK
  SHOWINGS : int listing_id FK
  SHOWINGS : timestamp scheduled_at
  SHOWINGS : string status
```

## 11. Docker network topology (14 services)

```mermaid
graph TB
  subgraph Host["Docker Host"]
    subgraph Net["docker-compose network (bridge)"]
      Dashboard["dashboard<br/>:3000"]
      Inbox["inbox<br/>:3004"]
      Langfuse["langfuse-server<br/>:3002"]
      Nango["nango<br/>:3003"]
      ST["supertokens<br/>:3567"]
      LLM["litellm<br/>:4000"]
      Postgres["postgres<br/>:5432"]
      Redis["redis<br/>:6379"]
      Temporal["temporal<br/>:7233"]
      TUI["temporal-ui<br/>:8233"]
      AA["atomic-agent<br/>:8787 localhost"]
      Bridge["atomic-bridge<br/>:8790 localhost"]
      Worker["temporal-worker<br/>(no port)"]
      Sandbox["sandbox<br/>:8080 internal only"]
    end
  end

  subgraph HostNet["Host Network"]
    HostDash["localhost:3000"]
    HostT7233["localhost:7233"]
    HostAA["localhost:8787"]
    HostBridge["localhost:8790"]
  end

  Dashboard ---|publishes| HostDash
  Temporal ---|publishes| HostT7233
  AA ---|localhost only| HostAA
  Bridge ---|localhost only| HostBridge

  Dashboard --> Postgres
  Dashboard --> Redis
  Dashboard --> ST
  Dashboard --> Nango
  Dashboard --> Langfuse
  Dashboard --> LLM
  Dashboard --> Temporal

  Worker --> Temporal
  Worker --> Dashboard

  Sandbox ---|RPC| Bridge

  note as N1
    atomic-agent (:8787) and atomic-bridge (:8790)
    bind only to localhost, not exposed to host.
    Accessed via Dashboard inside container.
  end
```

## 12. Real estate workflow

```mermaid
graph TD
  List["Listing created<br/>(address + property details)"]
  List --> Schedule["Schedule showing<br/>(date/time)"]
  Schedule --> Email["Email prospect<br/>(via Gmail inbound)"]
  Email --> Confirm["Prospect confirms<br/>(SMS/WhatsApp)"]
  Confirm --> Temporal["Showing Workflow<br/>(Temporal)"]
  Temporal --> Reminder["Send reminder<br/>24h before"]
  Reminder --> Attend["Attend showing<br/>(log status)"]
  Attend --> Interest["Prospect expresses interest"]
  Interest --> Eval["Live Listing Eval<br/>(agent analyzes)"]
  Eval --> LLM["LLM generates<br/>market comp + risk"]
  LLM --> Update["Update listing<br/>with analysis"]
  Update --> Rent["Rent calculation<br/>(if qualified)"]
  Rent --> Contract["Generate contract<br/>(Leegality)"]
  Contract --> Sign["eSign contract<br/>(DocuSign/etc)"]
  Sign --> Done["Lease active<br/>Rent reminders scheduled"]
  Done --> Nag["Periodic follow-up<br/>(NurtureWorkflow)"]
```

## 13. Billing workflow

```mermaid
sequenceDiagram
  participant User as User
  participant Dashboard as Dashboard :3000
  participant Billing as /api/billing/* routes
  participant Stripe as Stripe SDK
  participant Webhook as POST /api/webhooks/billing
  participant DB as Postgres org_subscriptions

  User->>Dashboard: /billing page
  Dashboard->>Billing: GET subscription status
  Billing->>DB: SELECT * FROM org_subscriptions WHERE org_id=$1
  DB-->>Billing: current plan + meters
  Billing-->>Dashboard: display current + upgrade options

  User->>Dashboard: Choose plan
  Dashboard->>Billing: POST create checkout
  Billing->>Stripe: create session (plan + customer_id)
  Stripe-->>Billing: checkout_url
  Billing-->>Dashboard: redirect
  Dashboard->>Stripe: stripe.redirectToCheckout()

  Stripe->>Webhook: POST billing.subscription.created
  Webhook->>DB: INSERT org_subscriptions (plan_id, customer_id, status=active)
  DB-->>Webhook: 200

  Webhook->>Stripe: GET subscription details
  Stripe-->>Webhook: {plan, meter_limits, next_billing_date}
  Webhook->>DB: UPSERT billing_meters (org_id, meter_type, usage, limit)
```

## 14. Security: RBAC + audit + RLS

```mermaid
flowchart TD
  Request["API Request<br/>(/api/...)"]
  Auth["Authenticate<br/>(session → users.id)"]
  Org["Resolve org<br/>(users.org_id)"]
  RBAC["Check RBAC<br/>(org_members.role)"]

  RBAC -->|owner| Owner["Full access<br/>read + write<br/>settings"]
  RBAC -->|editor| Editor["Write data<br/>conversations + messages<br/>no settings"]
  RBAC -->|viewer| Viewer["Read only<br/>no mutations"]
  RBAC -->|denied| Deny["403 Forbidden"]

  Owner --> RLS["Set app.current_org_id"]
  Editor --> RLS
  Viewer --> RLS

  RLS --> Query["Query resources"]
  Query --> RLSCheck["RLS FORCE<br/>+ WITH CHECK<br/>org_id = app.current_org_id"]
  RLSCheck -->|matches| Success["Return data<br/>+ log audit"]
  RLSCheck -->|no match| Return["Return empty<br/>+ log attempt"]

  Success --> AuditLog["INSERT audit_logs<br/>(user, action, changes)"]
  Return --> AuditLog
  Deny --> AuditLog
```

## 15. Session & cache layer

```mermaid
graph TD
  Request["HTTP Request<br/>(cookie: darex_session)"]
  Extract["Extract cookie"]
  Check["Check Redis<br/>session:{sessionId}"]
  Cache{Cache hit?}
  Cache -->|yes| UseCached["Use cached<br/>user + org"]
  Cache -->|no| QueryDB["Query Postgres<br/>users + org_members"]
  QueryDB --> GetUser["SELECT * FROM users"]
  GetUser --> GetRole["SELECT role FROM org_members"]
  GetRole --> SetCache["SETEX Redis<br/>86400s TTL"]
  SetCache --> UseCached
  UseCached --> RateLimit["Check rate_limit<br/>(Redis)"]
  RateLimit --> Allow{"Within limit?"}
  Allow -->|yes| Proceed["Proceed"]
  Allow -->|no| Block["429 Too Many Requests"]
  
  ToolCache["Tool Allowlist<br/>Separate cache<br/>60s TTL"]
  ResolveOrg["resolveOrgToolAllowlist"]
  ResolveOrg --> ToolCache
```

## 16. Error handling & fallbacks

```mermaid
graph TD
  Entry["Request enters"]
  Try["Try Temporal"]
  TemporalOK{Temporal<br/>responds?}
  TemporalOK -->|timeout/error| Fallback["Use Direct Agent"]
  TemporalOK -->|ok| Execute["Temporal Workflow<br/>executes"]

  TempErr["Temporal Error<br/>(worker down)"]
  TempErr --> Fallback

  Fallback --> Direct["runAutonomousAgentDirect"]
  Direct --> AAError{atomic-agent<br/>error?}
  AAError -->|yes| JSONFallback["Return error JSON<br/>+ retry UI"]
  AAError -->|no| Success["Success"]

  Execute --> WorkflowErr{Workflow<br/>failed?}
  WorkflowErr -->|activity timeout| Retry["Retry with backoff<br/>(2s-30s)"]
  WorkflowErr -->|permanent| Fail["Log error<br/>+ notify user"]

  Fallback --> ToolErr{Tool execution<br/>failed?}
  ToolErr -->|rate limit| ThrottleWait["Wait 60s<br/>+ retry"]
  ToolErr -->|auth (OAuth)| ConnError["Return connected:false<br/>+ /connectors link"]
  ToolErr -->|network| Retry
  ToolErr -->|logic| Fail

  Success --> LogTrace["Log to Langfuse"]
  Retry --> LogTrace
  Fail --> LogTrace
  ConnError --> LogTrace
```

## 17. Component dependency (import graph)

```mermaid
graph TD
  Dashboard["apps/dashboard"]
  WFDist["@darex/workflows/dist"]
  WFSrc["services/workflows/src"]
  TE["tool-executor.ts"]
  AAClient["atomic-agent-client.ts"]
  MCPBridge["mcp-bridge.ts"]

  Dashboard -->|runtime import| WFDist
  WFDist -->|built from| WFSrc
  WFSrc --> TE
  WFSrc --> AAClient
  WFSrc --> MCPBridge

  AAClient -->|POST| AtomicAgent["atomic-agent :8787"]
  MCPBridge -->|via MCP protocol| AA_Tools["tool registry"]

  TE -->|calls| NangoLib["Nango SDK"]
  TE -->|calls| Providers["Provider API client"]
  TE -->|calls| DB["Postgres client"]
  TE -->|calls| Jina["Jina web client"]
  TE -->|calls| Sandbox["HTTP to sandbox"]

  Dashboard -->|build-time| TypeShared["packages/shared-types"]
  WFSrc -->|build-time| TypeShared
```

## 18. Realtime event flow (SSE)

```mermaid
sequenceDiagram
  participant User as User Browser
  participant EventSource as EventSource<br/>/api/stream/events
  participant Hub as realtimeHub<br/>(in-memory)
  participant API as Dashboard API
  participant DB as Postgres

  User->>EventSource: open connection
  EventSource->>Hub: subscribe org_id
  Hub-->>EventSource: connected
  EventSource-->>User: SSE stream open

  API->>DB: INSERT message (needs_attention=true)
  API->>Hub: emit('needs_attention', {org_id, conversationId})
  Hub->>EventSource: send event
  EventSource-->>User: SSE event<br/>{ type: 'needs_attention', conversationId }
  User->>User: toast({conversationId})
  User->>API: GET /api/conversations/{id}
  API->>DB: SELECT messages WHERE conversation_id=$1
  DB-->>API: fresh messages
  API-->>User: conversation data
  User->>User: update conversation UI

  Note over Hub: In-memory only (single process).<br/>Redis pub/sub wired but not active.<br/>Multi-instance requires shared Redis.
```

## 19. Langfuse observability

```mermaid
graph TD
  Start["User runs Ask AI"]
  Trace["Create Trace<br/>(ask_ai_session)"]
  Classify["Trace Span<br/>(classify_request)"]
  Plan["Trace Span<br/>(generate_plan)"]
  Agent["Trace Span<br/>(agent_turn)"]
  Tools["Trace Spans<br/>(tool_execution)"]

  Trace --> Classify
  Trace --> Plan
  Trace --> Agent
  Agent --> Tools

  Tools -->|send| Langfuse["Langfuse :3002<br/>(HTTP batch)"]
  Langfuse -->|store| ClickHouse["ClickHouse<br/>(persistence)"]
  ClickHouse -->|serve| Dashboard["Langfuse Dashboard<br/>(charts + latency)"]

  Note over Langfuse: Schema fixed (event-level timestamp).<br/>ClickHouse persistence still flaky.<br/>Fallback: in-memory buffer.
```

## 20. Scaling architecture (future)

```mermaid
graph TB
  subgraph Load["Load Balancing"]
    LB["Nginx / AWS ALB"]
  end

  subgraph Compute["Compute Layer (auto-scale)"]
    D1["Dashboard :3000 #1"]
    D2["Dashboard :3000 #2"]
    D3["Dashboard :3000 #N"]
  end

  subgraph Queue["Message Queue"]
    Redis["Redis Cluster<br/>(pub/sub)"]
  end

  subgraph Cache["Cache Layer"]
    RC["Redis Cache<br/>(sessions, tools, etc)"]
  end

  subgraph Workers["Background Workers (auto-scale)"]
    W1["Temporal Worker #1"]
    W2["Temporal Worker #2"]
    W3["Temporal Worker #N"]
  end

  subgraph DataLayer["Data Layer"]
    PGCluster["Postgres Cluster<br/>(primary + replicas)"]
    PGBouncer["PgBouncer<br/>(connection pool)"]
    CHCluster["ClickHouse Cluster<br/>(time-series)"]
  end

  subgraph Compute2["Stateless Services (auto-scale)"]
    AA1["atomic-agent :8787 #1"]
    AA2["atomic-agent :8787 #N"]
    BR1["atomic-bridge :8790 #1"]
    BR2["atomic-bridge :8790 #N"]
  end

  subgraph Monitoring["Observability"]
    Prometheus["Prometheus<br/>(metrics)"]
    Grafana["Grafana<br/>(dashboards)"]
    Alert["Alerting<br/>(PagerDuty)"]
  end

  LB --> D1
  LB --> D2
  LB --> D3

  D1 --> Redis
  D2 --> Redis
  D3 --> Redis

  D1 --> RC
  D2 --> RC
  D3 --> RC

  D1 ---|trigger| W1
  D2 ---|trigger| W2
  D3 ---|trigger| W3

  W1 --> PGBouncer
  W2 --> PGBouncer
  W3 --> PGBouncer

  PGBouncer --> PGCluster

  W1 ---|call| AA1
  W2 ---|call| AA2

  AA1 --> BR1
  AA2 --> BR2

  BR1 --> PGBouncer
  BR2 --> PGBouncer

  D1 --> Prometheus
  W1 --> Prometheus
  AA1 --> Prometheus

  Prometheus --> Grafana
  Grafana --> Alert

  Dashboard ---|spans| CHCluster
```

All diagrams describe the **current state** as of commit `604d97a` (2026-08-14).
