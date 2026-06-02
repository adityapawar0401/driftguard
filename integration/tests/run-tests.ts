import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp, executableLookupBody, humanOverrideBody, managerApprovalBody, receiptBody, supervisePlanBody } from "../src/app.js";
import { driftGuardPostJson } from "../src/clients.js";
import { createInitialState, state as appState, withApproval } from "../src/state.js";

const state = createInitialState();
assert.equal(state.issueOpsBaseUrl, process.env.ISSUEOPS_BASE_URL ?? "http://localhost:3000");
assert.equal(state.driftGuardBaseUrl, process.env.DRIFTGUARD_BASE_URL ?? "http://localhost:4100");
assert.equal(state.diagnostics.issueOpsWritesDriftGuardMemory, false);
assert.equal(state.diagnostics.issueOpsCreatesExecutionAuthority, false);
assert.equal(state.diagnostics.integrationCallsExecutableBeforeApply, true);
assert.equal(state.diagnostics.localApplySendsRawPayloadToExecutable, false);

const decisions = withApproval([
  {
    decisionId: "dec1",
    trajectoryId: "traj1",
    stepId: "step1",
    externalItemId: "item1",
    actionType: "customer_reply_draft",
    verdict: "allow",
    riskLevel: "low",
    reasons: [],
    memoryReferences: [],
    originalPayload: {},
    modifiedPayload: null,
    executablePayload: {},
    executionAuthority: "driftguard_allow",
    requiresHumanReview: false
  }
]);
assert.equal(decisions[0].approvalState, "pending");
assert.equal(decisions[0].executionState, "not_applied");

const superviseBody = supervisePlanBody({ workspaceId: "demo", managerObjective: "test", externalPlanId: "p1", plan: { items: [] } });
assert.equal(superviseBody.actor.role, "integration_adapter");
assert.equal(superviseBody.sourceProposedBy.role, "worker_agent");

const approvalBody = managerApprovalBody(decisions[0], { id: "manager-demo", name: "Demo Manager" });
assert.equal(approvalBody.actor.role, "integration_adapter");
assert.equal(approvalBody.reviewerId, "manager-demo");

const overrideBody = humanOverrideBody(decisions[0], { id: "manager-demo", name: "Demo Manager" }, "Scoped override");
assert.equal(overrideBody.actor.role, "integration_adapter");
assert.equal(overrideBody.reviewerId, "manager-demo");
assert.equal(overrideBody.reason, "Scoped override");

const executableBody = executableLookupBody(decisions[0]);
assert.deepEqual(Object.keys(executableBody).sort(), ["actor", "decisionId", "stepId", "trajectoryId"]);
assert.equal("payload" in executableBody, false, "Local apply does not send raw payload to executable.");

const localReceiptBody = receiptBody({ workspaceId: "demo", decision: decisions[0], executionAuthority: "driftguard_allow", executablePayload: { persisted: true } });
assert.equal(localReceiptBody.actor.role, "integration_adapter");
assert.equal(localReceiptBody.decisionId, "dec1");

function canApply(decision: (typeof decisions)[number]) {
  return decision.approvalState === "approved" && decision.executionAuthority !== "not_executable";
}
assert.equal(canApply(decisions[0]), false, "Apply refuses without manager approval.");
decisions[0].approvalState = "approved";
assert.equal(canApply(decisions[0]), true);
decisions[0].executionAuthority = "not_executable";
assert.equal(canApply(decisions[0]), false, "Apply refuses block/review decisions unless human override grants authority.");

decisions[0].executionAuthority = "human_authorized_override";
assert.equal(canApply(decisions[0]), true, "Human override path records executable human authority.");

const appSource = fs.readFileSync(path.resolve("src/app.ts"), "utf8");
assert.ok(appSource.includes("IssueOps role"));
assert.ok(appSource.includes("DriftGuard role"));
assert.ok(appSource.includes("Integration role"));
assert.equal(/from\s+['"].*issueops/i.test(appSource), false, "Integration does not import IssueOps internals.");

const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("connection reset");
}) as typeof fetch;
await assert.rejects(
  () => driftGuardPostJson("http://localhost:4100/api/supervise-plan", {}),
  /DriftGuard request failed: .*connection reset/
);

const app = createApp();
const server = app.listen(0);
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
appState.latestIssueOpsPlan = { id: "plan-route-test", items: [] };
appState.supervised = null;

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  if (target.startsWith(baseUrl)) return originalFetch(url, init);
  if (target.includes("/api/supervise-plan")) {
    return new Response("driftguard down", { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const failedSupervise = await originalFetch(`${baseUrl}/api/supervise`, { method: "POST" });
const failedSuperviseBody = await failedSupervise.json() as { error: string };
assert.equal(failedSupervise.status, 400);
assert.ok(failedSuperviseBody.error.startsWith("DriftGuard request failed:"));
assert.ok(appState.lastMessage.startsWith("DriftGuard request failed:"));
assert.equal(appState.supervised, null);

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  if (target.startsWith(baseUrl)) return originalFetch(url, init);
  if (target.includes("/api/supervise-plan")) {
    return new Response(JSON.stringify({
      trajectoryId: "traj-success",
      supervisedPlanId: "sup-success",
      decisions: [decisions[0]],
      summary: { allow: 1 },
      memoryUsed: []
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const successfulSupervise = await originalFetch(`${baseUrl}/api/supervise`, { method: "POST" });
const successfulSuperviseBody = await successfulSupervise.json() as typeof appState;
assert.equal(successfulSupervise.status, 200);
assert.equal(successfulSuperviseBody.supervised?.trajectoryId, "traj-success");
assert.equal(successfulSuperviseBody.lastMessage, "DriftGuard supervised 1 plan item(s).");

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const target = String(url);
  if (target.startsWith(baseUrl)) return originalFetch(url, init);
  if (target.includes("/api/manager-approval")) {
    return new Response(JSON.stringify({
      ...decisions[0],
      approvalState: undefined,
      executionState: undefined,
      reasons: ["Approved in test"]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (target.includes("/api/executable")) {
    return new Response(JSON.stringify({
      executable: true,
      executionAuthority: "driftguard_allow",
      executablePayload: { persisted: true }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (target.includes("/api/receipt")) {
    return new Response(JSON.stringify({
      receiptId: "receipt-success",
      decisionId: "dec1",
      status: "LOCAL_PLACEHOLDER_RECORDED"
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const approvedRoute = await originalFetch(`${baseUrl}/api/approve`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ decisionId: "dec1" })
});
assert.equal(approvedRoute.status, 200);
const approvedBody = await approvedRoute.json() as typeof appState;
assert.equal(approvedBody.supervised?.decisions[0].approvalState, "approved");
const appliedRoute = await originalFetch(`${baseUrl}/api/apply`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ decisionId: "dec1" })
});
assert.equal(appliedRoute.status, 200);
const appliedBody = await appliedRoute.json() as typeof appState;
assert.equal(appliedBody.supervised?.decisions[0].executionState, "local_applied");
assert.equal(appliedBody.receipts[0].receiptId, "receipt-success");

server.close();
globalThis.fetch = originalFetch;

console.log("Integration tests passed.");
