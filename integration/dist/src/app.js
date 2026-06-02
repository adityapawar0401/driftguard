import express from "express";
import { z } from "zod";
import { driftGuardGetJson, driftGuardPostJson, getJson, postJson } from "./clients.js";
import { state, withApproval } from "./state.js";
const settingsSchema = z.object({
    issueOpsBaseUrl: z.string().url().optional(),
    driftGuardBaseUrl: z.string().url().optional(),
    workspaceId: z.string().min(1).optional(),
    managerObjective: z.string().min(1).optional(),
    maxIssues: z.number().int().min(1).max(12).optional()
});
const decisionSchema = z.object({
    decisionId: z.string(),
    reason: z.string().optional(),
    overridePayload: z.record(z.unknown()).optional()
});
export function integrationActor() {
    return { role: "integration_adapter", id: "integration-control-plane", name: "DriftGuard Integration" };
}
export function executableLookupBody(decision) {
    return {
        actor: integrationActor(),
        trajectoryId: decision.trajectoryId,
        stepId: decision.stepId,
        decisionId: decision.decisionId
    };
}
export function supervisePlanBody(input) {
    return {
        actor: integrationActor(),
        workspaceId: input.workspaceId,
        sourceSystem: "issueops",
        managerObjective: input.managerObjective,
        externalPlanId: input.externalPlanId,
        sourceProposedBy: { role: "worker_agent", id: "issueops", name: "IssueOps" },
        plan: input.plan
    };
}
export function managerApprovalBody(decision, reviewer) {
    return {
        ...executableLookupBody(decision),
        reviewerId: reviewer.id,
        reviewerName: reviewer.name,
        note: "Approved in Integration manager control plane."
    };
}
export function humanOverrideBody(decision, reviewer, reason, overridePayload) {
    return {
        ...executableLookupBody(decision),
        reviewerId: reviewer.id,
        reviewerName: reviewer.name,
        reason,
        overridePayload
    };
}
export function receiptBody(input) {
    return {
        actor: integrationActor(),
        workspaceId: input.workspaceId,
        trajectoryId: input.decision.trajectoryId,
        stepId: input.decision.stepId,
        decisionId: input.decision.decisionId,
        executionAuthority: input.executionAuthority,
        status: "LOCAL_PLACEHOLDER_RECORDED",
        message: "Integration local apply only. No IssueOps source was modified and no external side effect occurred.",
        payload: input.executablePayload
    };
}
export function createApp() {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.get("/", (_req, res) => res.type("html").send(renderPage()));
    app.get("/client.js", (_req, res) => res.type("application/javascript").send(clientJs()));
    app.get("/api/state", (_req, res) => res.json(state));
    app.post("/api/settings", (req, res) => {
        const input = settingsSchema.parse(req.body);
        Object.assign(state, input);
        state.lastMessage = "Settings updated.";
        res.json(state);
    });
    app.post("/api/check", asyncRoute(async (_req, res) => {
        state.issueOpsHealth = "unknown";
        state.driftGuardHealth = "unknown";
        try {
            await getJson(`${state.issueOpsBaseUrl}/api/state`);
            state.issueOpsHealth = "ok";
        }
        catch {
            state.issueOpsHealth = "error";
        }
        try {
            await getJson(`${state.driftGuardBaseUrl}/health`);
            state.driftGuardHealth = "ok";
        }
        catch {
            state.driftGuardHealth = "error";
        }
        state.lastMessage = "Connection check complete.";
        res.json(state);
    }));
    app.post("/api/load-issueops", asyncRoute(async (_req, res) => {
        const result = await postJson(`${state.issueOpsBaseUrl}/api/issues/import`);
        state.lastMessage = `IssueOps synthetic dataset load requested: ${JSON.stringify(result)}`;
        res.json(state);
    }));
    app.post("/api/run-issueops", asyncRoute(async (_req, res) => {
        const result = await postJson(`${state.issueOpsBaseUrl}/api/plans/run`, {
            maxIssues: state.maxIssues,
            managerObjective: state.managerObjective
        });
        state.latestIssueOpsPlan = result.plan;
        state.supervised = null;
        state.lastMessage = `IssueOps proposed plan ${result.plan?.id ?? ""} for ${result.processedIssueCount ?? 0} issue(s).`;
        res.json(state);
    }));
    app.post("/api/supervise", asyncRoute(async (_req, res) => {
        if (!state.latestIssueOpsPlan)
            return res.status(400).json({ error: "Run IssueOps first." });
        const result = await driftGuardPostJson(`${state.driftGuardBaseUrl}/api/supervise-plan`, supervisePlanBody({
            workspaceId: state.workspaceId,
            managerObjective: state.managerObjective,
            externalPlanId: state.latestIssueOpsPlan.id,
            plan: state.latestIssueOpsPlan
        }));
        state.supervised = {
            trajectoryId: result.trajectoryId,
            supervisedPlanId: result.supervisedPlanId,
            decisions: withApproval(result.decisions),
            summary: result.summary,
            memoryUsed: result.memoryUsed
        };
        state.lastMessage = `DriftGuard supervised ${result.decisions.length} plan item(s).`;
        res.json(state);
    }));
    app.post("/api/approve", asyncRoute(async (req, res) => {
        const input = decisionSchema.parse(req.body);
        const decision = findDecision(input.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        if (decision.executionAuthority === "not_executable") {
            return res.status(400).json({ error: "Decision is not executable. Use human override for scoped manager authorization." });
        }
        const approved = await driftGuardPostJson(`${state.driftGuardBaseUrl}/api/manager-approval`, managerApprovalBody(decision, { id: state.managerId, name: state.managerName }));
        Object.assign(decision, approved);
        decision.approvalState = "approved";
        state.diagnostics.humanApprovalsStoredInDriftGuardMemory = true;
        state.lastMessage = `Approved ${decision.decisionId}.`;
        res.json(state);
    }));
    app.post("/api/reject", (req, res) => {
        const input = decisionSchema.parse(req.body);
        const decision = findDecision(input.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        decision.approvalState = "rejected";
        state.lastMessage = `Rejected ${decision.decisionId}.`;
        res.json(state);
    });
    app.post("/api/defer", (req, res) => {
        const input = decisionSchema.parse(req.body);
        const decision = findDecision(input.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        decision.approvalState = "deferred";
        state.lastMessage = `Deferred ${decision.decisionId}.`;
        res.json(state);
    });
    app.post("/api/human-override", asyncRoute(async (req, res) => {
        const input = decisionSchema.extend({ reason: z.string().min(1) }).parse(req.body);
        const decision = findDecision(input.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        const override = await driftGuardPostJson(`${state.driftGuardBaseUrl}/api/human-override`, humanOverrideBody(decision, { id: state.managerId, name: state.managerName }, input.reason, input.overridePayload));
        Object.assign(decision, override, { approvalState: "approved", executionState: "not_applied" });
        state.lastMessage = `Human override recorded for ${decision.decisionId}.`;
        res.json(state);
    }));
    app.post("/api/apply", asyncRoute(async (req, res) => {
        const input = decisionSchema.parse(req.body);
        const decision = findDecision(input.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        if (decision.approvalState !== "approved") {
            decision.executionState = "refused";
            return res.status(400).json({ error: "Manager approval in Integration is required before local apply." });
        }
        const executable = await driftGuardPostJson(`${state.driftGuardBaseUrl}/api/executable`, executableLookupBody(decision));
        if (!executable.executable) {
            decision.executionState = "refused";
            return res.status(400).json({ error: executable.reason ?? "DriftGuard refused execution." });
        }
        const receipt = await driftGuardPostJson(`${state.driftGuardBaseUrl}/api/receipt`, receiptBody({
            workspaceId: state.workspaceId,
            decision,
            executionAuthority: executable.executionAuthority,
            executablePayload: executable.executablePayload
        }));
        decision.executionState = "local_applied";
        decision.receiptId = receipt.receiptId;
        state.receipts.unshift(receipt);
        state.diagnostics.receiptsStoredInDriftGuardMemory = true;
        state.lastMessage = "Integration local apply only. No IssueOps source was modified and no external side effect occurred.";
        res.json(state);
    }));
    app.get("/api/memory", asyncRoute(async (_req, res) => {
        const result = await driftGuardGetJson(`${state.driftGuardBaseUrl}/api/memory?workspaceId=${encodeURIComponent(state.workspaceId)}`);
        res.json(result);
    }));
    app.use((err, _req, res, _next) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        state.lastMessage = message;
        res.status(400).json({ error: message });
    });
    return app;
}
function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
function findDecision(decisionId) {
    return state.supervised?.decisions.find((decision) => decision.decisionId === decisionId);
}
function renderPage() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DriftGuard Integration</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Segoe UI, Arial, sans-serif; background: #f6f7f9; color: #1d2430; }
    body { margin: 0; }
    header { background: #17202a; color: #fff; padding: 18px 24px; }
    header h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    main { padding: 18px; display: grid; gap: 14px; }
    section { background: #fff; border: 1px solid #d8dde6; border-radius: 8px; padding: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    label { display: grid; gap: 5px; font-size: 12px; color: #4a5565; }
    input, textarea { border: 1px solid #c8d0dc; border-radius: 6px; padding: 9px; font: inherit; }
    textarea { min-height: 64px; }
    button { border: 1px solid #1d4f91; background: #1d4f91; color: #fff; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button.secondary { background: #fff; color: #1d4f91; }
    button.warn { border-color: #9b3a24; background: #9b3a24; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e2e6ee; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f0f3f7; color: #354052; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; background: #e9edf3; margin: 1px; }
    .ok { color: #17643b; } .error { color: #a12828; } .muted { color: #667085; }
    pre { white-space: pre-wrap; max-height: 180px; overflow: auto; background: #f6f7f9; border: 1px solid #e2e6ee; padding: 8px; border-radius: 6px; }
  </style>
</head>
<body>
  <header><h1>DriftGuard Integration Control Plane</h1><div class="muted">Use this app for the DriftGuard demo path, not direct IssueOps apply.</div></header>
  <main id="app"></main>
  <script src="/client.js"></script>
</body>
</html>`;
}
function clientJs() {
    return `
const app = document.getElementById('app');
let state;
let pendingAction = false;
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body || {}) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Request failed');
  state = json; render();
}
async function load() { state = await (await fetch('/api/state')).json(); render(); }
function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function setSettings() {
  return api('/api/settings', {
    issueOpsBaseUrl: document.getElementById('issueOpsBaseUrl').value,
    driftGuardBaseUrl: document.getElementById('driftGuardBaseUrl').value,
    workspaceId: document.getElementById('workspaceId').value,
    managerObjective: document.getElementById('managerObjective').value,
    maxIssues: Number(document.getElementById('maxIssues').value)
  });
}
async function act(path, body) {
  if (pendingAction) return;
  pendingAction = true;
  render();
  try {
    await api(path, body);
  } catch (e) {
    state.lastMessage = e.message;
    render();
  } finally {
    pendingAction = false;
    render();
  }
}
function decisionRows() {
  const decisions = state.supervised?.decisions || [];
  return decisions.map(d => '<tr>' +
    '<td>' + esc(d.originalPayload.issueNumber || d.originalPayload.issueId || d.externalItemId) + '</td>' +
    '<td>' + esc(d.actionType) + '</td>' +
    '<td><pre>' + esc(d.originalPayload.proposedContent || d.originalPayload.title || JSON.stringify(d.originalPayload, null, 2)) + '</pre></td>' +
    '<td><span class="pill">' + esc(d.verdict) + '</span><br><span class="muted">' + esc(d.executionAuthority) + '</span></td>' +
    '<td>' + esc(d.riskLevel) + '</td>' +
    '<td>' + d.reasons.map(r => '<div>' + esc(r) + '</div>').join('') + '</td>' +
    '<td>' + d.memoryReferences.slice(0,3).map(m => '<div class="pill">' + esc(m.trustLevel) + '</div>').join('') + '</td>' +
    '<td><pre>' + esc(d.modifiedPayload ? JSON.stringify(d.modifiedPayload, null, 2) : '') + '</pre></td>' +
    '<td>' + esc(d.approvalState) + '<br>' + esc(d.executionState) + '</td>' +
    '<td>' +
      '<button ' + disabledAttr() + ' onclick="act(\\'/api/approve\\',{decisionId:\\'' + d.decisionId + '\\'})">Approve</button> ' +
      '<button class="secondary" ' + disabledAttr() + ' onclick="act(\\'/api/defer\\',{decisionId:\\'' + d.decisionId + '\\'})">Defer</button> ' +
      '<button class="warn" ' + disabledAttr() + ' onclick="act(\\'/api/reject\\',{decisionId:\\'' + d.decisionId + '\\'})">Reject</button> ' +
      '<button class="secondary" ' + disabledAttr() + ' onclick="overrideDecision(\\'' + d.decisionId + '\\')">Override</button> ' +
      '<button ' + disabledAttr() + ' onclick="act(\\'/api/apply\\',{decisionId:\\'' + d.decisionId + '\\'})">Local Apply</button>' +
    '</td></tr>').join('');
}
function disabledAttr() { return pendingAction ? 'disabled' : ''; }
function overrideDecision(id) {
  const reason = prompt('Human override reason');
  if (reason) act('/api/human-override', { decisionId: id, reason });
}
function render() {
  const diagnostics = state.diagnostics || {};
  app.innerHTML = \`
  <section>
    <strong>Dashboard</strong>
    <div>IssueOps: <span class="\${state.issueOpsHealth}">\${state.issueOpsHealth}</span> | DriftGuard: <span class="\${state.driftGuardHealth}">\${state.driftGuardHealth}</span></div>
    <div>Plan items: \${state.latestIssueOpsPlan?.items?.length || 0} | Pending approvals: \${(state.supervised?.decisions || []).filter(d => d.approvalState === 'pending').length} | Local receipts: \${state.receipts.length}</div>
    <div class="muted">\${esc(state.lastMessage)}</div>
  </section>
  <section>
    <strong>Role Boundaries</strong>
    <div class="grid">
      <div><span class="pill">IssueOps role</span><br>worker/proposer only</div>
      <div><span class="pill">DriftGuard role</span><br>authority/memory/execution gate</div>
      <div><span class="pill">Integration role</span><br>manager control plane</div>
      <div>IssueOps memory is worker context only; DriftGuard memory is supervision authority.</div>
    </div>
  </section>
  <section>
    <strong>Role-Boundary Diagnostics</strong>
    <div class="grid">
      <div>IssueOps writes DriftGuard memory: \${diagnostics.issueOpsWritesDriftGuardMemory ? 'Yes' : 'No'}</div>
      <div>IssueOps creates execution authority: \${diagnostics.issueOpsCreatesExecutionAuthority ? 'Yes' : 'No'}</div>
      <div>Integration calls DriftGuard executable before apply: \${diagnostics.integrationCallsExecutableBeforeApply ? 'Yes' : 'No'}</div>
      <div>Local apply sends raw payload to executable: \${diagnostics.localApplySendsRawPayloadToExecutable ? 'Yes' : 'No'}</div>
      <div>Human approvals stored in DriftGuard memory: \${diagnostics.humanApprovalsStoredInDriftGuardMemory ? 'Yes' : 'No'}</div>
      <div>Receipts stored in DriftGuard memory: \${diagnostics.receiptsStoredInDriftGuardMemory ? 'Yes' : 'No'}</div>
    </div>
  </section>
  <section>
    <strong>Settings</strong>
    <div class="grid">
      <label>IssueOps URL <input id="issueOpsBaseUrl" value="\${esc(state.issueOpsBaseUrl)}"></label>
      <label>DriftGuard URL <input id="driftGuardBaseUrl" value="\${esc(state.driftGuardBaseUrl)}"></label>
      <label>Workspace <input id="workspaceId" value="\${esc(state.workspaceId)}"></label>
      <label>Max issues <input id="maxIssues" type="number" min="1" max="12" value="\${state.maxIssues}"></label>
    </div>
    <label>Manager objective <textarea id="managerObjective">\${esc(state.managerObjective)}</textarea></label>
    <button \${pendingAction ? 'disabled' : ''} onclick="setSettings()">Save Settings</button>
  </section>
  <section>
    <strong>Run IssueOps</strong>
    <p class="muted">Integration calls IssueOps as an external API. It does not import or modify IssueOps source.</p>
    <button \${pendingAction ? 'disabled' : ''} onclick="act('/api/check')">Check Connections</button>
    <button \${pendingAction ? 'disabled' : ''} onclick="act('/api/load-issueops')">Load Synthetic Dataset</button>
    <button \${pendingAction ? 'disabled' : ''} onclick="act('/api/run-issueops')">Run IssueOps Agents</button>
    <button \${pendingAction ? 'disabled' : ''} onclick="act('/api/supervise')">Supervise With DriftGuard</button>
  </section>
  <section>
    <strong>DriftGuard Supervision</strong>
    <table><thead><tr><th>Issue</th><th>Action</th><th>Original</th><th>Verdict</th><th>Risk</th><th>Reasons</th><th>Memory</th><th>Modified</th><th>State</th><th>Manager</th></tr></thead><tbody>\${decisionRows()}</tbody></table>
  </section>
  <section>
    <strong>Execution Receipts</strong>
    <pre>\${esc(JSON.stringify(state.receipts, null, 2))}</pre>
  </section>\`;
}
load();`;
}
