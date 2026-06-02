import { evaluateAction } from "./policies.js";
import { assertCanWriteMemory, requireRole, writerTypeFor } from "./authz.js";
import { makeMemory, id, now, relevantMemories, seedPolicies } from "./memory.js";
import { normalizeIssueOpsPlan } from "./normalize.js";
import { store, type StoreBackend } from "./store.js";
import type { Actor, DriftGuardDecision, MemoryRecord, PlannedAction, Receipt } from "./types.js";

export class DriftGuardService {
  constructor(private repo: StoreBackend = store) {}

  async backendStatus() {
    return this.repo.status();
  }

  async seed(workspaceId = "demo-workspace") {
    const current = await this.repo.read();
    const existing = new Set(current.memories.map((memory) => `${memory.workspaceId}:${memory.memoryType}:${memory.content}`));
    let added = 0;
    for (const memory of seedPolicies(workspaceId)) {
      if (!existing.has(`${memory.workspaceId}:${memory.memoryType}:${memory.content}`)) {
        await this.repo.addMemory(memory);
        added += 1;
      }
    }
    const updated = await this.repo.read();
    return { seeded: true, added, memoryCount: updated.memories.length };
  }

  async supervisePlan(input: { actor?: Actor; workspaceId: string; sourceSystem: "issueops"; managerObjective: string; externalPlanId?: string; plan?: unknown; sourceProposedBy?: Actor }) {
    requireRole(input.actor, ["integration_adapter"], "submit worker plans for supervision");
    await this.seed(input.workspaceId);
    const workerPlan = normalizeIssueOpsPlan(input);
    const trajectoryId = id("traj");
    const supervisedPlanId = id("sup");
    await this.repo.addRawEvent({ eventId: id("evt"), workspaceId: input.workspaceId, eventType: "worker_plan_received", trajectoryId, createdAt: now(), workerPlan });
    await this.repo.addMemory(makeMemory({
      workspaceId: input.workspaceId,
      memoryLayer: "worker_proposal_memory",
      memoryType: "worker_plan_proposal",
      trustLevel: "llm_inferred",
      writerType: "worker_agent",
      writerId: input.sourceProposedBy?.id ?? "issueops",
      content: `IssueOps proposed ${workerPlan.planItems.length} plan items for ${workerPlan.externalPlanId}.`,
      structuredJson: { externalPlanId: workerPlan.externalPlanId, itemCount: workerPlan.planItems.length },
      sourceTrajectoryId: trajectoryId,
      durable: false,
      requiresHumanApproval: true
    }));
    const decisions = await Promise.all(workerPlan.planItems.map((action, index) =>
      this.decideAction({
        workspaceId: input.workspaceId,
        trajectoryId,
        stepId: `step_${index + 1}`,
        externalPlanId: workerPlan.externalPlanId,
        action
      })
    ));
    const memoryUsed = uniqueMemory(decisions.flatMap((decision) => decision.memoryReferences));
    return {
      trajectoryId,
      supervisedPlanId,
      decisions,
      summary: summarize(decisions),
      memoryUsed,
      warnings: ["Execution is local-only unless a persisted DriftGuard decision grants authority."]
    };
  }

  async superviseAction(input: { actor?: Actor; workspaceId: string; managerObjective: string; externalPlanId: string; action: PlannedAction }) {
    requireRole(input.actor, ["integration_adapter"], "submit worker actions for supervision");
    await this.seed(input.workspaceId);
    const trajectoryId = id("traj");
    return this.decideAction({
      workspaceId: input.workspaceId,
      trajectoryId,
      stepId: "step_1",
      externalPlanId: input.externalPlanId,
      action: input.action
    });
  }

  async decideAction(input: { workspaceId: string; trajectoryId: string; stepId: string; externalPlanId: string; action: PlannedAction }) {
    const memories = relevantMemories((await this.repo.read()).memories, input.action);
    const decision = evaluateAction({ ...input, memoryReferences: memories });
    await this.repo.addDecision(decision);
    await this.repo.addMemory(makeMemory({
      workspaceId: input.workspaceId,
      memoryLayer: "driftguard_decision_memory",
      memoryType: "supervision_decision",
      trustLevel: "observed_execution",
      writerType: "driftguard",
      writerId: "policy-engine",
      content: `DriftGuard verdict ${decision.verdict} for ${decision.actionType}: ${decision.reasons.join(" ")}`,
      structuredJson: { verdict: decision.verdict, riskLevel: decision.riskLevel, policyFindings: decision.policyFindings },
      sourceDecisionId: decision.decisionId,
      sourceTrajectoryId: decision.trajectoryId,
      sourceStepId: decision.stepId,
      productSku: String(decision.metadata.productSku ?? "") || null,
      category: String(decision.metadata.category ?? "") || null,
      durable: true
    }));
    if (decision.modifiedPayload) {
      await this.repo.addMemory(makeMemory({
        workspaceId: input.workspaceId,
        memoryLayer: "safer_payload_memory",
        memoryType: "verified_modified_payload",
        trustLevel: "observed_execution",
        writerType: "driftguard",
        writerId: "policy-engine",
        content: `Safer payload generated for ${decision.actionType}.`,
        structuredJson: decision.modifiedPayload,
        sourceDecisionId: decision.decisionId,
        sourceTrajectoryId: decision.trajectoryId,
        sourceStepId: decision.stepId,
        durable: true
      }));
    }
    return decision;
  }

  async executable(input: { actor?: Actor; trajectoryId: string; stepId: string; decisionId: string }) {
    requireRole(input.actor, ["integration_adapter"], "request executable payloads");
    const decision = await this.repo.findDecision(input.decisionId);
    if (!decision || decision.trajectoryId !== input.trajectoryId || decision.stepId !== input.stepId) {
      return { executable: false, executionAuthority: "not_executable", reason: "Persisted decision not found for trajectoryId/stepId/decisionId." };
    }
    if (decision.executionAuthority === "not_executable" || !decision.executablePayload) {
      return { executable: false, executionAuthority: decision.executionAuthority, reason: "Decision is not executable without human override." };
    }
    const executablePayload = decision.executionAuthority === "driftguard_allow"
      ? decision.originalPayload
      : decision.executionAuthority === "driftguard_verified_modified"
        ? decision.modifiedPayload
        : decision.executablePayload;
    return { executable: true, executionAuthority: decision.executionAuthority, executablePayload };
  }

  async managerApproval(input: { actor?: Actor; trajectoryId: string; stepId: string; decisionId: string; reviewerId: string; reviewerName?: string; editedPayload?: Record<string, unknown>; note?: string }) {
    const actor = requireRole(input.actor, ["integration_adapter", "human_reviewer"], "record manager approval");
    if (!input.reviewerId) throw new Error("reviewerId is required.");
    if (actor.role === "human_reviewer" && actor.id !== input.reviewerId) {
      throw new Error("human_reviewer actor id must match reviewerId.");
    }
    const original = await this.repo.findDecision(input.decisionId);
    if (!original || original.trajectoryId !== input.trajectoryId || original.stepId !== input.stepId) {
      throw new Error("Persisted decision not found for manager approval.");
    }
    const edited = Boolean(input.editedPayload);
    const decision: DriftGuardDecision = {
      ...original,
      executionAuthority: edited ? "human_authorized_override" : original.executionAuthority,
      executablePayload: edited ? input.editedPayload ?? null : original.executablePayload,
      modifiedPayload: edited ? input.editedPayload ?? null : original.modifiedPayload,
      requiresHumanReview: false,
      reasons: [...original.reasons, `Manager approval by ${input.reviewerName ?? input.reviewerId}${edited ? " with human-edited payload" : ""}.`],
      metadata: { ...original.metadata, managerApproval: { reviewerId: input.reviewerId, reviewerName: input.reviewerName, note: input.note, edited, at: now() } }
    };
    await this.repo.replaceDecision(decision);
    await this.repo.addMemory(makeMemory({
      workspaceId: decision.workspaceId,
      memoryLayer: "human_approved_conclusion",
      memoryType: "manager_action_approval",
      trustLevel: "human_approved",
      writerType: "human_reviewer",
      writerId: input.reviewerId,
      content: `Manager approved ${decision.decisionId}${edited ? " with human authority over edited payload" : " for local execution"}.`,
      structuredJson: { edited, note: input.note ?? null },
      sourceDecisionId: decision.decisionId,
      sourceTrajectoryId: decision.trajectoryId,
      sourceStepId: decision.stepId,
      durable: true
    }));
    return decision;
  }

  async humanOverride(input: { actor?: Actor; trajectoryId: string; stepId: string; decisionId: string; reviewerId: string; reviewerName?: string; overridePayload?: Record<string, unknown>; reason: string }) {
    const actor = requireRole(input.actor, ["integration_adapter", "human_reviewer"], "record human override");
    if (!input.reviewerId) throw new Error("reviewerId is required.");
    if (actor.role === "human_reviewer" && actor.id !== input.reviewerId) {
      throw new Error("human_reviewer actor id must match reviewerId.");
    }
    const original = await this.repo.findDecision(input.decisionId);
    if (!original || original.trajectoryId !== input.trajectoryId || original.stepId !== input.stepId) {
      throw new Error("Persisted decision not found for override.");
    }
    const decision: DriftGuardDecision = {
      ...original,
      verdict: "allow_modified",
      executionAuthority: "human_authorized_override",
      executablePayload: input.overridePayload ?? original.modifiedPayload ?? original.originalPayload,
      modifiedPayload: input.overridePayload ?? original.modifiedPayload,
      requiresHumanReview: false,
      reasons: [...original.reasons, `Human override by ${input.reviewerName ?? input.reviewerId}: ${input.reason}`],
      metadata: { ...original.metadata, humanOverride: { reviewerId: input.reviewerId, reviewerName: input.reviewerName, reason: input.reason, at: now() } }
    };
    await this.repo.replaceDecision(decision);
    await this.repo.addMemory(makeMemory({
      workspaceId: decision.workspaceId,
      memoryLayer: "human_override_memory",
      memoryType: "specific_action_override",
      trustLevel: "human_approved",
      writerType: "human_reviewer",
      writerId: input.reviewerId,
      content: `Human-authorized override for ${decision.decisionId}: ${input.reason}`,
      structuredJson: { overridePayload: input.overridePayload ?? null },
      sourceDecisionId: decision.decisionId,
      sourceTrajectoryId: decision.trajectoryId,
      sourceStepId: decision.stepId,
      durable: false
    }));
    return decision;
  }

  async receipt(input: Omit<Receipt, "receiptId" | "createdAt"> & { actor?: Actor }) {
    const actor = requireRole(input.actor, ["integration_adapter", "connector"], "submit execution receipts");
    const { actor: _actor, ...receiptInput } = input;
    const receipt = await this.repo.addReceipt({ ...receiptInput, receiptId: id("rcpt"), createdAt: now() });
    await this.repo.addMemory(makeMemory({
      workspaceId: input.workspaceId,
      memoryLayer: "connector_receipt_memory",
      memoryType: "local_placeholder_receipt",
      trustLevel: "connector_receipt",
      writerType: actor.role === "connector" ? "connector" : "integration_adapter",
      writerId: actor.id,
      content: input.message,
      structuredJson: { status: input.status, decisionId: input.decisionId },
      sourceDecisionId: input.decisionId,
      sourceTrajectoryId: input.trajectoryId,
      sourceStepId: input.stepId,
      durable: true
    }));
    return receipt;
  }

  async memory(query: { workspaceId?: string; limit?: number }) {
    return (await this.repo.read()).memories
      .filter((memory) => !query.workspaceId || memory.workspaceId === query.workspaceId)
      .slice(0, query.limit ?? 100);
  }

  async addMemory(input: Omit<MemoryRecord, "memoryId" | "authorityRank" | "createdAt" | "updatedAt" | "writerType" | "writerId"> & { actor?: Actor }) {
    assertCanWriteMemory({
      actor: input.actor,
      memoryLayer: input.memoryLayer,
      trustLevel: input.trustLevel,
      durable: input.durable,
      requiresHumanApproval: input.requiresHumanApproval
    });
    const actor = input.actor!;
    const { actor: _actor, ...memoryInput } = input;
    return this.repo.addMemory(makeMemory({
      ...memoryInput,
      writerType: writerTypeFor(actor),
      writerId: actor.id
    }));
  }
}

function summarize(decisions: DriftGuardDecision[]) {
  const summary = {
    allow: 0,
    allowModified: 0,
    reviewRequired: 0,
    block: 0,
    pauseAndReplan: 0,
    riskCounts: { low: 0, medium: 0, high: 0, critical: 0 }
  };
  for (const decision of decisions) {
    if (decision.verdict === "allow") summary.allow += 1;
    if (decision.verdict === "allow_modified") summary.allowModified += 1;
    if (decision.verdict === "review_required") summary.reviewRequired += 1;
    if (decision.verdict === "block") summary.block += 1;
    if (decision.verdict === "pause_and_replan") summary.pauseAndReplan += 1;
    summary.riskCounts[decision.riskLevel] += 1;
  }
  return summary;
}

function uniqueMemory(items: DriftGuardDecision["memoryReferences"]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.memoryId)) return false;
    seen.add(item.memoryId);
    return true;
  });
}

export const driftGuardService = new DriftGuardService();
