import type { DriftGuardDecision, ExecutionAuthority, PlannedAction, RiskLevel, Verdict, MemoryRecord } from "./types.js";
import { id, now } from "./memory.js";

const refundWords = /\b(refund|replacement|compensation|credit|reimburse)\b/i;
const legalFaultWords = /\b(our fault|we are liable|legal fault|negligence)\b/i;
const rootCauseWords = /\b(root cause|confirmed cause|defect is confirmed|we confirmed)\b/i;
const safetyWords = /\b(safety|smoke|spark|fire|shock|burn|overheat|melted|short circuit|leakage near socket|power)\b/i;
const safeToUseWords = /\b(safe to use|continue using|keep using)\b/i;
const privatePublicWords = /\b(post|share).{0,40}\b(serial|phone|address|card|private|personal)\b.{0,30}\b(public|review|comment)\b/i;
const externalDoneWords = /\b(sent|dispatched|delivered|emailed|notified|refunded|created in erp|service visit scheduled)\b/i;

export function evaluateAction(input: {
  workspaceId: string;
  trajectoryId: string;
  stepId: string;
  externalPlanId: string;
  action: PlannedAction;
  memoryReferences: MemoryRecord[];
}): DriftGuardDecision {
  const action = input.action;
  const text = `${action.title}\n${action.proposedContent}`.trim();
  const reasons: string[] = [];
  const policyFindings: string[] = [];
  let modifiedPayload: Record<string, unknown> | null = null;
  let verdict: Verdict = "allow";
  let riskLevel: RiskLevel = "low";

  const isSafety = action.category === "SAFETY_CONCERN" || action.severity === "CRITICAL" || safetyWords.test(text);

  if (action.actionType === "customer_reply_draft") {
    const unsafeCommitment = refundWords.test(text) || legalFaultWords.test(text) || rootCauseWords.test(text);
    const missingStopUse = isSafety && !/\bstop using\b|\bdo not use\b/i.test(text);
    const unsafeUse = isSafety && safeToUseWords.test(text);
    const asksPrivatePublic = privatePublicWords.test(text);
    const claimsExternalDone = action.executionMode !== "REAL_CONNECTOR" && externalDoneWords.test(text);

    if (unsafeUse) {
      reasons.push("Safety-risk reply says or implies the product is safe to keep using.");
      policyFindings.push("safety_reply_stop_use_required");
      verdict = "block";
      riskLevel = "critical";
    }
    if (asksPrivatePublic) {
      reasons.push("Reply asks the customer to expose private data publicly.");
      policyFindings.push("blocked_data_class_private_customer_data");
      verdict = "block";
      riskLevel = "critical";
    }
    if (unsafeCommitment || missingStopUse || claimsExternalDone) {
      if (unsafeCommitment) reasons.push("Reply contains an unapproved refund, replacement, compensation, legal fault, or root-cause commitment.");
      if (missingStopUse) reasons.push("Safety-risk reply does not advise immediate stop-use and official support.");
      if (claimsExternalDone) reasons.push("Local placeholder action claims an external action already happened.");
      policyFindings.push("forbidden_commitment_or_missing_safety_context");
      if (verdict !== "block") {
        verdict = "allow_modified";
        riskLevel = isSafety ? "high" : "medium";
        modifiedPayload = { ...action.payload, proposedContent: safeReply(action, isSafety) };
      }
    }
  }

  if (action.actionType === "department_action") {
    const needsSafetyDept = isSafety && !/\b(SERVICE|QUALITY)\b/i.test(text);
    const externalDispatch = action.executionMode !== "REAL_CONNECTOR" && /\bdispatch|send|schedule technician|supplier committed|refund approved\b/i.test(text);
    if (needsSafetyDept) {
      reasons.push("Safety issue department action lacks Service or Quality handling.");
      policyFindings.push("safety_requires_service_quality");
      verdict = "allow_modified";
      riskLevel = "high";
      modifiedPayload = { ...action.payload, proposedContent: `${action.proposedContent}\n\nAdd local placeholder tasks for SERVICE and QUALITY review before customer commitments.` };
    }
    if (externalDispatch) {
      reasons.push("Department action implies real external dispatch, supplier commitment, or refund approval without connector authority.");
      policyFindings.push("local_only_no_external_dispatch");
      if (verdict !== "allow_modified") verdict = "review_required";
      riskLevel = riskLevel === "low" ? "medium" : riskLevel;
    }
  }

  if (action.actionType === "status_change") {
    if (/\b(RESOLVED|CLOSED)\b/i.test(text) && !/\b(outcome|receipt|confirmed|approved)\b/i.test(text)) {
      reasons.push("Status moves to resolved/closed without outcome evidence.");
      policyFindings.push("requires_outcome_evidence");
      verdict = "block";
      riskLevel = "high";
    }
    if (isSafety && /\b(RESOLVED|CLOSED|WAITING_FOR_CUSTOMER)\b/i.test(text) && !/\b(service|quality)\b/i.test(text)) {
      reasons.push("Safety issue moves out of escalated/service/quality flow without service or quality outcome.");
      policyFindings.push("safety_status_requires_outcome");
      verdict = "block";
      riskLevel = "critical";
    }
  }

  if (action.actionType === "memory_candidate") {
    reasons.push("Memory candidates require human review before becoming trusted durable precedent.");
    policyFindings.push("memory_candidate_requires_human_approval");
    verdict = "review_required";
    riskLevel = "medium";
    if (action.productSku || action.category) {
      modifiedPayload = { ...action.payload, durable: false, trustLevel: "llm_inferred", scope: { productSku: action.productSku, category: action.category } };
    }
  }

  if (action.actionType === "report_export") {
    if (externalDoneWords.test(text) && action.executionMode !== "REAL_CONNECTOR") {
      reasons.push("Report export claims external delivery occurred in local-only mode.");
      policyFindings.push("placeholder_no_external_delivery_claim");
      verdict = "block";
      riskLevel = "high";
    }
  }

  if (action.actionType === "trend_alert" && /\b\d+\b/.test(text) === false) {
    reasons.push("Trend alert lacks factual count support.");
    policyFindings.push("trend_alert_requires_factual_count");
    verdict = "review_required";
    riskLevel = "medium";
  }

  if (action.actionType === "sla_escalation" && /\bbreach|at risk|due|sla\b/i.test(text) === false) {
    reasons.push("SLA escalation lacks factual SLA basis.");
    policyFindings.push("sla_escalation_requires_fact_basis");
    verdict = "review_required";
    riskLevel = "medium";
  }

  if (action.actionType === "unknown") {
    reasons.push("Unknown action type requires review.");
    policyFindings.push("unknown_action_type");
    verdict = "review_required";
    riskLevel = "medium";
  }

  if (reasons.length === 0) {
    reasons.push("No blocking policy or memory constraint violation detected.");
  }

  const executionAuthority = authorityFor(verdict);
  return {
    decisionId: id("dec"),
    trajectoryId: input.trajectoryId,
    stepId: input.stepId,
    workspaceId: input.workspaceId,
    sourceSystem: "issueops",
    externalPlanId: input.externalPlanId,
    externalItemId: action.externalItemId,
    actionType: action.actionType,
    verdict,
    riskLevel,
    reasons,
    policyFindings,
    memoryReferences: input.memoryReferences.map((memory) => ({
      memoryId: memory.memoryId,
      content: memory.content,
      trustLevel: memory.trustLevel,
      authorityRank: memory.authorityRank
    })),
    originalPayload: action.payload,
    modifiedPayload,
    executablePayload: executionAuthority === "not_executable" ? null : modifiedPayload ?? action.payload,
    executionAuthority,
    requiresHumanReview: verdict === "review_required" || verdict === "block",
    createdAt: now(),
    metadata: { title: action.title, issueNumber: action.issueNumber, productSku: action.productSku, category: action.category, severity: action.severity }
  };
}

function authorityFor(verdict: Verdict): ExecutionAuthority {
  if (verdict === "allow") return "driftguard_allow";
  if (verdict === "allow_modified") return "driftguard_verified_modified";
  return "not_executable";
}

function safeReply(action: PlannedAction, isSafety: boolean): string {
  const base = [
    "Thank you for reporting this. We understand the concern and will review it through the appropriate support process.",
    "We cannot confirm refunds, replacements, root cause, or external actions until the responsible team has reviewed and approved them."
  ];
  if (isSafety) {
    base.unshift("Please stop using the product immediately and contact official support through the local placeholder support channel.");
  }
  base.push(`Reference: ${action.issueNumber ?? action.sourceIssueId ?? "the reported issue"}.`);
  return base.join(" ");
}
