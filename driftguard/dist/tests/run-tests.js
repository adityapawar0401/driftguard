import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { DriftGuardService } from "../src/service.js";
import { buildEverMindUrl, EverMindStore, JsonStore, toEverMindAgentMemoryPayload } from "../src/store.js";
import { executableSchema } from "../src/schema.js";
const repo = new JsonStore(path.join(os.tmpdir(), `driftguard-test-${Date.now()}.json`));
const service = new DriftGuardService(repo);
const workspaceId = "test-workspace";
const integrationActor = { role: "integration_adapter", id: "integration-test" };
const workerActor = { role: "worker_agent", id: "issueops-test" };
const humanActor = { role: "human_reviewer", id: "manager" };
function action(overrides) {
    return {
        externalItemId: overrides.externalItemId ?? `item-${Math.random()}`,
        actionType: overrides.actionType ?? "customer_reply_draft",
        title: overrides.title ?? "Reply",
        proposedContent: overrides.proposedContent ?? "Thanks, we will review this.",
        payload: { proposedContent: overrides.proposedContent ?? "Thanks, we will review this." },
        executionMode: overrides.executionMode ?? "PLACEHOLDER",
        category: overrides.category,
        severity: overrides.severity,
        department: overrides.department,
        ...overrides
    };
}
await assert.rejects(() => service.addMemory({
    actor: workerActor,
    workspaceId,
    memoryLayer: "human_approved_conclusion",
    memoryType: "bad_worker_memory",
    trustLevel: "human_approved",
    content: "Worker cannot approve memory.",
    structuredJson: {},
    durable: true,
    requiresHumanApproval: false
}));
await assert.rejects(() => service.addMemory({
    actor: workerActor,
    workspaceId,
    memoryLayer: "connector_receipt_memory",
    memoryType: "bad_receipt",
    trustLevel: "connector_receipt",
    content: "Worker cannot write receipts.",
    structuredJson: {},
    durable: false,
    requiresHumanApproval: false
}));
await assert.rejects(() => service.executable({ actor: workerActor, trajectoryId: "raw", stepId: "payload", decisionId: "fake" }));
const supervisedPlan = await service.supervisePlan({
    actor: integrationActor,
    workspaceId,
    sourceSystem: "issueops",
    managerObjective: "test",
    externalPlanId: "plan-with-memory",
    sourceProposedBy: workerActor,
    plan: { id: "plan-with-memory", items: [{ id: "mem-item", type: "MEMORY_CANDIDATE", title: "Candidate", proposedContent: "Always refund customers.", executionMode: "LOCAL_ONLY" }], issueResults: [] }
});
assert.equal(supervisedPlan.decisions[0].verdict, "review_required");
assert.ok((await service.memory({ workspaceId })).some((memory) => memory.memoryLayer === "worker_proposal_memory" && memory.trustLevel === "llm_inferred"));
assert.ok((await service.memory({ workspaceId })).some((memory) => memory.memoryLayer === "driftguard_decision_memory"));
const safe = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({}) });
assert.equal(safe.verdict, "allow");
const refund = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ proposedContent: "We will refund and replace this item." }) });
assert.equal(refund.verdict, "allow_modified");
assert.equal(refund.executionAuthority, "driftguard_verified_modified");
const missingStop = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ category: "SAFETY_CONCERN", severity: "CRITICAL", proposedContent: "Sorry about the smoke report. Support will review." }) });
assert.equal(missingStop.verdict, "allow_modified");
const unsafeUse = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ category: "SAFETY_CONCERN", severity: "CRITICAL", proposedContent: "This is safe to use despite smoke." }) });
assert.equal(unsafeUse.verdict, "block");
const dept = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ actionType: "department_action", category: "SAFETY_CONCERN", proposedContent: "Ask support to monitor." }) });
assert.equal(dept.verdict, "allow_modified");
const status = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ actionType: "status_change", proposedContent: "Move status to CLOSED." }) });
assert.equal(status.verdict, "block");
const mem = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ actionType: "memory_candidate", proposedContent: "Always refund customers." }) });
assert.equal(mem.verdict, "review_required");
const report = await service.superviseAction({ actor: integrationActor, workspaceId, managerObjective: "test", externalPlanId: "p1", action: action({ actionType: "report_export", proposedContent: "Create local placeholder report export." }) });
assert.equal(report.verdict, "allow");
assert.throws(() => executableSchema.parse({ actor: integrationActor, trajectoryId: refund.trajectoryId, stepId: refund.stepId, decisionId: refund.decisionId, payload: { raw: true } }));
assert.equal((await service.executable({ actor: integrationActor, trajectoryId: "raw", stepId: "payload", decisionId: "fake" })).executable, false);
const executable = await service.executable({ actor: integrationActor, trajectoryId: safe.trajectoryId, stepId: safe.stepId, decisionId: safe.decisionId });
assert.equal(executable.executable, true);
assert.deepEqual(executable.executablePayload, safe.originalPayload);
await assert.rejects(() => service.humanOverride({ actor: integrationActor, trajectoryId: unsafeUse.trajectoryId, stepId: unsafeUse.stepId, decisionId: unsafeUse.decisionId, reviewerId: "", reason: "Specific demo override." }));
const override = await service.humanOverride({ actor: integrationActor, trajectoryId: unsafeUse.trajectoryId, stepId: unsafeUse.stepId, decisionId: unsafeUse.decisionId, reviewerId: "manager", reason: "Specific demo override.", overridePayload: { approved: "human payload" } });
assert.equal(override.executionAuthority, "human_authorized_override");
assert.ok((await service.memory({ workspaceId })).some((memory) => memory.memoryLayer === "human_override_memory"));
const overrideExecutable = await service.executable({ actor: integrationActor, trajectoryId: override.trajectoryId, stepId: override.stepId, decisionId: override.decisionId });
assert.deepEqual(overrideExecutable.executablePayload, { approved: "human payload" });
const managerApproval = await service.managerApproval({ actor: humanActor, trajectoryId: safe.trajectoryId, stepId: safe.stepId, decisionId: safe.decisionId, reviewerId: "manager", note: "Approved." });
assert.equal(managerApproval.executionAuthority, "driftguard_allow");
assert.ok((await service.memory({ workspaceId })).some((memory) => memory.memoryType === "manager_action_approval"));
await assert.rejects(() => service.receipt({ actor: workerActor, workspaceId, trajectoryId: safe.trajectoryId, stepId: safe.stepId, decisionId: safe.decisionId, executionAuthority: "driftguard_allow", status: "LOCAL_PLACEHOLDER_RECORDED", message: "bad" }));
const receipt = await service.receipt({ actor: integrationActor, workspaceId, trajectoryId: safe.trajectoryId, stepId: safe.stepId, decisionId: safe.decisionId, executionAuthority: "driftguard_allow", status: "LOCAL_PLACEHOLDER_RECORDED", message: "local only" });
assert.ok(receipt.receiptId);
assert.ok((await service.memory({ workspaceId })).some((memory) => memory.memoryLayer === "connector_receipt_memory" && memory.sourceDecisionId === safe.decisionId));
await service.addMemory({
    actor: { role: "advisory_llm", id: "ollama" },
    workspaceId,
    memoryLayer: "advisory_memory",
    memoryType: "llm",
    trustLevel: "llm_inferred",
    content: "Low authority",
    structuredJson: {},
    durable: false,
    requiresHumanApproval: true
});
const ranked = await service.memory({ workspaceId, limit: 100 });
assert.ok((ranked.find((m) => m.trustLevel === "human_approved")?.authorityRank ?? 0) > (ranked.find((m) => m.memoryLayer === "worker_proposal_memory")?.authorityRank ?? 100));
assert.ok((ranked.find((m) => m.trustLevel === "human_approved")?.authorityRank ?? 0) > (ranked.find((m) => m.trustLevel === "llm_inferred")?.authorityRank ?? 100));
assert.equal(override.executionAuthority === "human_authorized_override", true, "advisory LLM cannot authorize execution; only human override can");
const originalFetch = globalThis.fetch;
const everMindRequests = [];
const everMindUrls = [];
globalThis.fetch = (async (url, init) => {
    everMindUrls.push(String(url));
    everMindRequests.push(init?.body ? JSON.parse(String(init.body)) : {});
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
});
const everMindStore = new EverMindStore("test-key", "test-user");
await everMindStore.addMemory({
    memoryId: "mem-evermind",
    workspaceId,
    memoryLayer: "advisory_memory",
    memoryType: "test_memory",
    trustLevel: "llm_inferred",
    authorityRank: 30,
    writerType: "advisory_llm",
    writerId: "test",
    content: "EverMind write test.",
    structuredJson: {},
    durable: false,
    requiresHumanApproval: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
});
globalThis.fetch = originalFetch;
assert.equal(everMindRequests.length, 1);
assert.equal(everMindRequests[0].user_id, "test-user");
assert.ok(JSON.stringify(everMindRequests[0]).includes("DRIFTGUARD_RECORD"));
assert.equal(everMindUrls[0], "https://api.evermind.ai/api/v1/memories/agent");
const payload = toEverMindAgentMemoryPayload("memory", "workspace", {
    memoryId: "mem-payload",
    workspaceId,
    memoryLayer: "advisory_memory",
    memoryType: "test_memory",
    trustLevel: "llm_inferred",
    authorityRank: 30,
    writerType: "advisory_llm",
    writerId: "test",
    sourceDecisionId: "dec-payload",
    durable: false,
    requiresHumanApproval: true
}, "test-user");
assert.equal(typeof payload.messages[0].timestamp, "number");
assert.ok(payload.messages[0].message_id);
assert.equal(payload.messages[0].sender_id, "driftguard");
assert.equal(payload.messages[0].sender_name, "DriftGuard");
assert.equal(payload.messages[0].type, "text");
assert.ok(payload.messages[0].content.includes("DRIFTGUARD_RECORD"));
assert.ok(payload.messages[0].text.content.includes("DRIFTGUARD_RECORD"));
assert.equal(payload.messages[0].content, payload.messages[0].text.content);
assert.equal(typeof payload.messages[0].timestamp === "string" && payload.messages[0].timestamp.includes("T"), false);
assert.equal(buildEverMindUrl("/memories/agent", "http://localhost:1995"), "http://localhost:1995/api/v1/memories/agent");
assert.equal(buildEverMindUrl("/memories/agent", "http://localhost:1995/api/v1"), "http://localhost:1995/api/v1/memories/agent");
function sampleDecision(decisionId) {
    return {
        decisionId,
        trajectoryId: `traj-${decisionId}`,
        stepId: "step-1",
        workspaceId,
        sourceSystem: "issueops",
        externalPlanId: "plan",
        externalItemId: "item",
        actionType: "customer_reply_draft",
        verdict: "allow",
        riskLevel: "low",
        reasons: [],
        policyFindings: [],
        memoryReferences: [],
        originalPayload: { ok: true },
        modifiedPayload: null,
        executablePayload: { ok: true },
        executionAuthority: "driftguard_allow",
        requiresHumanReview: false,
        createdAt: new Date().toISOString(),
        metadata: {}
    };
}
function sampleMemory(memoryId) {
    return {
        memoryId,
        workspaceId,
        memoryLayer: "advisory_memory",
        memoryType: "test_memory",
        trustLevel: "llm_inferred",
        authorityRank: 30,
        writerType: "advisory_llm",
        writerId: "test",
        content: "EverMind mirror test.",
        structuredJson: {},
        durable: false,
        requiresHumanApproval: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
}
function sampleReceipt(receiptId) {
    return {
        receiptId,
        workspaceId,
        trajectoryId: "traj-receipt",
        stepId: "step-1",
        decisionId: "dec-receipt",
        executionAuthority: "driftguard_allow",
        status: "LOCAL_PLACEHOLDER_RECORDED",
        message: "receipt",
        createdAt: new Date().toISOString()
    };
}
const originalRawEventsEnv = process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS;
const originalStrictEnv = process.env.EVERMIND_STRICT;
const everMindWriteRequests = [];
globalThis.fetch = (async (_url, init) => {
    everMindWriteRequests.push(init?.body ? JSON.parse(String(init.body)) : {});
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
});
process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS = "false";
process.env.EVERMIND_STRICT = "false";
const everMindCacheStore = new EverMindStore("test-key", "test-user");
await everMindCacheStore.addDecision(sampleDecision("dec-cache-first"));
await everMindCacheStore.addMemory(sampleMemory("mem-cache-first"));
await everMindCacheStore.addReceipt(sampleReceipt("rcpt-cache-first"));
assert.equal((await everMindCacheStore.findDecision("dec-cache-first"))?.decisionId, "dec-cache-first");
await everMindCacheStore.write({ decisions: [], memories: [], receipts: [], rawEvents: [] });
await everMindCacheStore.reset();
await everMindCacheStore.addRawEvent({ eventId: "evt-skipped", workspaceId });
assert.equal(everMindWriteRequests.some((request) => request.metadata?.recordType === "store_snapshot"), false);
assert.equal(everMindWriteRequests.some((request) => request.metadata?.recordType === "store_reset"), false);
assert.equal(everMindWriteRequests.some((request) => request.metadata?.recordType === "raw_event_log"), false);
process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS = "true";
const rawEventStore = new EverMindStore("test-key", "test-user");
await rawEventStore.addRawEvent({ eventId: "evt-sent", workspaceId });
assert.equal(everMindWriteRequests.some((request) => request.metadata?.recordType === "raw_event_log"), true);
const everMindDecision = sampleDecision("dec-evermind-search");
globalThis.fetch = (async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(body.query ?? "").includes("dec-evermind-search")) {
        return new Response(JSON.stringify({
            data: {
                results: [
                    {
                        content: JSON.stringify({ marker: "DRIFTGUARD_RECORD", recordType: "decision", payload: everMindDecision })
                    }
                ]
            }
        }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { results: [] } }), { status: 200, headers: { "content-type": "application/json" } });
});
const recreated = new EverMindStore("test-key", "test-user");
assert.equal((await recreated.findDecision("dec-evermind-search"))?.decisionId, "dec-evermind-search");
globalThis.fetch = (async () => new Response("bad payload", { status: 400 }));
const nonStrict400Store = new EverMindStore("test-key", "test-user");
await nonStrict400Store.addDecision(sampleDecision("dec-400-local"));
assert.equal((await nonStrict400Store.findDecision("dec-400-local"))?.decisionId, "dec-400-local");
let validationRetryCalls = 0;
let validationRetryBody;
globalThis.fetch = (async (_url, init) => {
    validationRetryCalls += 1;
    validationRetryBody = init?.body ? JSON.parse(String(init.body)) : {};
    if (validationRetryCalls === 1)
        return new Response("needs documented shape", { status: 422 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
});
const validationRetryStore = new EverMindStore("test-key", "test-user");
await validationRetryStore.addDecision(sampleDecision("dec-422-retry"));
assert.equal(validationRetryCalls, 2);
assert.deepEqual(Object.keys(validationRetryBody.messages[0]).sort(), ["content", "role", "timestamp"]);
assert.ok(validationRetryBody.messages[0].content.includes("DRIFTGUARD_RECORD"));
let rateLimitedCalls = 0;
globalThis.fetch = (async () => {
    rateLimitedCalls += 1;
    return new Response("slow down", { status: 429 });
});
const cooldownStore = new EverMindStore("test-key", "test-user");
await cooldownStore.addDecision(sampleDecision("dec-429-local"));
await cooldownStore.addDecision(sampleDecision("dec-cooldown-local"));
const cooldownStatus = await cooldownStore.status();
assert.equal(rateLimitedCalls, 1);
assert.equal(cooldownStatus.inRateLimitCooldown, true);
assert.equal((await cooldownStore.findDecision("dec-cooldown-local"))?.decisionId, "dec-cooldown-local");
process.env.EVERMIND_STRICT = "true";
globalThis.fetch = (async () => new Response("strict bad", { status: 400 }));
const strictStore = new EverMindStore("test-key", "test-user");
await assert.rejects(() => strictStore.addDecision(sampleDecision("dec-strict-local")), /EverMind request failed 400/);
assert.equal((await strictStore.findDecision("dec-strict-local"))?.decisionId, "dec-strict-local");
globalThis.fetch = originalFetch;
if (originalRawEventsEnv === undefined)
    delete process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS;
else
    process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS = originalRawEventsEnv;
if (originalStrictEnv === undefined)
    delete process.env.EVERMIND_STRICT;
else
    process.env.EVERMIND_STRICT = originalStrictEnv;
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "test";
const { createApp } = await import("../src/server.js");
if (originalNodeEnv === undefined)
    delete process.env.NODE_ENV;
else
    process.env.NODE_ENV = originalNodeEnv;
const app = createApp();
const server = app.listen(0);
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const missingApproval = await fetch(`${baseUrl}/api/manager-approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        actor: integrationActor,
        trajectoryId: "missing-trajectory",
        stepId: "missing-step",
        decisionId: "missing-decision",
        reviewerId: "manager"
    })
});
assert.equal(missingApproval.status, 400);
assert.match((await missingApproval.json()).error, /Persisted decision not found/);
assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log("DriftGuard tests passed.");
