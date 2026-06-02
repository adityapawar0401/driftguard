# DriftGuard

DriftGuard is a local runtime supervision service for autonomous worker-agent plans. It receives proposed actions, applies policy and memory-based constraints, persists decisions, and returns execution authority only for persisted safe or human-authorized actions.

For DriftGuard demo, use the Integration app, not direct IssueOps apply.

## Run

```powershell
cd C:\dev\driftguard
npm install
npm run seed
npm run dev
```

Service URL: `http://localhost:4100`

## Memory Backend

DriftGuard supports two persistence backends:

- `DRIFTGUARD_MEMORY_BACKEND=local`: writes to local JSON at `DRIFTGUARD_DATA_FILE`.
- `DRIFTGUARD_MEMORY_BACKEND=evermind`: writes DriftGuard records to EverMind through the EverMind HTTP API.

Use `.env.local` to select the backend:

```ini
DRIFTGUARD_MEMORY_BACKEND=evermind
EVEROS_API_KEY=...
EVERMIND_USER_ID=driftguard-demo
```

When EverMind is selected, DriftGuard does not use the local JSON store as a mirror or authority source. Decisions, memories, approvals, overrides, and receipts are serialized as DriftGuard records into EverMind with their existing authority metadata. DriftGuard keeps an in-process cache for current-run responsiveness, and reloads exact decisions from EverMind search when cache misses occur. Raw events remain local in memory unless `DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS=true`.

## API

- `GET /health`
- `POST /api/supervise-plan`
- `POST /api/supervise-action`
- `GET /api/decisions/:decisionId`
- `POST /api/executable`
- `POST /api/human-override`
- `POST /api/manager-approval`
- `POST /api/receipt`
- `GET /api/memory`
- `POST /api/memory`
- `POST /api/seed`

## Safety Model

Worker memory can inform proposals. Only DriftGuard memory can authorize execution.

DriftGuard does not generate IssueOps plans and does not execute external actions. Execution requires a persisted `decisionId`, `trajectoryId`, and `stepId`. The executable endpoint reloads the stored decision and never accepts a client-supplied payload.

Human overrides are allowed, scoped to one decision, and labeled with `human_authorized_override`; they are not represented as DriftGuard-verified policy approvals.

Memory is stored in local JSON by default at `./data/driftguard-store.json`, with authority-ranked layers for policy, decisions, safer payloads, receipts, advisory notes, and human overrides.

## Roles

Every write or authority endpoint requires an `actor`:

- `worker_agent`: may propose work through Integration only. It cannot write trusted memory, create execution authority, call executable, submit receipts, or approve memory.
- `integration_adapter`: may submit worker plans, request executable payloads by persisted IDs, submit local receipts, and carry manager approval or override requests with reviewer identity. It cannot impersonate a human reviewer or create trusted durable memory directly.
- `driftguard_service`: internal DriftGuard writer for decision, safer payload, and incident candidate memory. It cannot impersonate a human reviewer.
- `human_reviewer`: may approve actions, override actions, and write durable human-approved instructions or conclusions with reviewer identity.
- `connector`: may submit execution receipts only.
- `advisory_llm`: may write advisory memory or incident candidates only as `llm_inferred`, non-durable, and requiring human approval.
- `system_seed`: may seed `system_config` policy memory.

## Memory Authority

IssueOps memory is worker context only. If IssueOps returns `memoryUsed` or `memoryCandidates`, DriftGuard treats those as proposal context or `memory_candidate` actions, not authority. Memory candidates are `review_required` until a human reviewer approves them through DriftGuard.

DriftGuard memory is the supervision authority. DriftGuard writes decision memory, safer payload memory, human approval memory, human override memory, and connector receipt memory with explicit actor identity and authority ranking.

## Execution Authority

`POST /api/executable` is an authority lookup and persisted payload retrieval step, not a second review. It accepts only:

```json
{
  "actor": { "role": "integration_adapter", "id": "integration-control-plane" },
  "trajectoryId": "...",
  "stepId": "...",
  "decisionId": "..."
}
```

It reloads the stored decision and returns:

- `driftguard_allow`: original persisted payload.
- `driftguard_verified_modified`: DriftGuard modified persisted payload.
- `human_authorized_override`: human persisted override payload.
- `not_executable`: refused.

Human decisions are recorded as human authority. DriftGuard does not re-judge human decisions at execution time.
