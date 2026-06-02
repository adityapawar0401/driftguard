import type { ActionType, PlannedAction, WorkerPlan, WorkItem } from "./types.js";

const mapType: Record<string, ActionType> = {
  ISSUE_CLASSIFICATION: "issue_classification",
  CUSTOMER_REPLY_DRAFT: "customer_reply_draft",
  DEPARTMENT_ACTION: "department_action",
  STATUS_CHANGE: "status_change",
  SLA_ESCALATION: "sla_escalation",
  TREND_ALERT: "trend_alert",
  MEMORY_CANDIDATE: "memory_candidate",
  REPORT_EXPORT: "report_export"
};

function resultForIssue(plan: any, issueId?: string) {
  return (plan?.issueResults ?? []).find((result: any) => result.issueId === issueId);
}

export function normalizeIssueOpsPlan(input: {
  sourceSystem: "issueops";
  externalPlanId?: string;
  managerObjective: string;
  plan?: any;
}): WorkerPlan {
  const plan = input.plan?.plan ?? input.plan;
  const workItems: WorkItem[] = (plan?.issueResults ?? []).map((result: any) => ({
    workItemId: String(result.issueId ?? result.issueNumber),
    issueNumber: result.issueNumber,
    productSku: result.productSku,
    severity: result.classification?.severity,
    category: result.classification?.category,
    metadata: result
  }));
  const planItems: PlannedAction[] = (plan?.items ?? []).map((item: any) => {
    const issue = resultForIssue(plan, item.issueId);
    return {
      externalItemId: String(item.id),
      actionType: mapType[String(item.type)] ?? "unknown",
      title: String(item.title ?? item.type ?? "Untitled action"),
      proposedContent: String(item.proposedContent ?? ""),
      payload: item,
      proposedByAgent: item.proposedByAgent,
      executionMode: item.executionMode,
      sourceIssueId: item.issueId,
      issueNumber: issue?.issueNumber,
      productSku: issue?.productSku,
      category: issue?.classification?.category,
      severity: issue?.classification?.severity,
      department: inferDepartment(item, issue),
      metadata: { issueResult: issue }
    };
  });
  return {
    sourceSystem: input.sourceSystem,
    externalPlanId: input.externalPlanId ?? String(plan?.id ?? "issueops-plan"),
    managerObjective: input.managerObjective ?? String(plan?.managerObjective ?? ""),
    proposedBy: "issueops",
    proposedAt: String(plan?.createdAt ?? new Date().toISOString()),
    workItems,
    planItems
  };
}

function inferDepartment(item: any, issue: any): string | undefined {
  const content = `${item?.title ?? ""} ${item?.proposedContent ?? ""}`.toUpperCase();
  for (const department of ["SERVICE", "QUALITY", "FINANCE", "PROCUREMENT", "PRODUCTION", "CUSTOMER_SUPPORT"]) {
    if (content.includes(department)) return department;
  }
  return issue?.classification?.primaryDepartment;
}
