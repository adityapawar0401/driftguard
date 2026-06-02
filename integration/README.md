# DriftGuard Integration

This is the safe demo/control plane that connects IssueOps to DriftGuard without changing IssueOps.

For DriftGuard demo, use the Integration app, not direct IssueOps apply.

## Run

```powershell
cd C:\dev\integration
npm install
npm run dev
```

Open `http://localhost:4200`.

Expected local stack:

```powershell
cd C:\dev\issueops
npm run dev

cd C:\dev\driftguard
npm run dev

cd C:\dev\integration
npm run dev
```

## What It Does

- Calls IssueOps `/api/issues/import` and `/api/plans/run` over HTTP.
- Sends the returned IssueOps plan to DriftGuard `/api/supervise-plan` with `actor.role=integration_adapter`.
- Displays original plan items, DriftGuard verdicts, reasons, memory references, modified payloads, and execution authority.
- Sends manager approvals and human overrides to DriftGuard with reviewer identity.
- Calls DriftGuard `/api/executable` before any apply.
- Records local-only placeholder receipts through DriftGuard `/api/receipt`.

## What It Does Not Do

- It does not modify IssueOps.
- It does not recreate IssueOps worker agents, datasets, or pipeline.
- It does not perform real email, ERP, service dispatch, portal, SMS, WhatsApp, or notification side effects.
- It does not call IssueOps apply with raw client-edited payloads.

If IssueOps does not expose a DriftGuard-aware persisted apply route, Integration performs local placeholder apply only and says so clearly.

## Role Boundary

Worker memory can inform proposals. Only DriftGuard memory can authorize execution.

- IssueOps role: worker/proposer only. It may use local worker context or memory to propose better plans, but it is not trusted as execution authority and cannot write DriftGuard memory.
- DriftGuard role: authority, precedent memory, and execution gate. It supervises IssueOps proposals and stores decisions, human approvals, overrides, receipts, and safer payload memory.
- Integration role: manager control plane. It calls IssueOps as the worker source and DriftGuard as the authority service.

Integration never treats IssueOps `approvalStatus`, `executionStatus`, or `executionMode` as DriftGuard authority. Local apply requires Integration manager approval plus a successful DriftGuard `/api/executable` response using only persisted `trajectoryId`, `stepId`, and `decisionId`.

Human approvals are stored through DriftGuard `/api/manager-approval`. Human-edited payloads and overrides are stored as human authority, not DriftGuard-verified output. The executable endpoint is an authority lookup/payload retrieval step, not a second review.

The UI includes a role-boundary diagnostics panel showing whether IssueOps writes DriftGuard memory, whether IssueOps creates execution authority, whether Integration calls executable before apply, whether raw payloads are sent to executable, and whether human approvals and receipts have been stored in DriftGuard memory.
