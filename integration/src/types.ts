export type ApprovalState = "pending" | "approved" | "rejected" | "deferred";
export type ExecutionState = "not_applied" | "local_applied" | "refused";

export type IntegrationDecision = {
  decisionId: string;
  trajectoryId: string;
  stepId: string;
  externalItemId: string;
  actionType: string;
  verdict: string;
  riskLevel: string;
  reasons: string[];
  memoryReferences: { memoryId: string; content: string; trustLevel: string; authorityRank: number }[];
  originalPayload: Record<string, unknown>;
  modifiedPayload: Record<string, unknown> | null;
  executablePayload: Record<string, unknown> | null;
  executionAuthority: string;
  requiresHumanReview: boolean;
  approvalState: ApprovalState;
  executionState: ExecutionState;
  receiptId?: string;
};

export type IntegrationState = {
  issueOpsBaseUrl: string;
  driftGuardBaseUrl: string;
  workspaceId: string;
  managerId: string;
  managerName: string;
  managerObjective: string;
  maxIssues: number;
  issueOpsHealth: "unknown" | "ok" | "error";
  driftGuardHealth: "unknown" | "ok" | "error";
  latestIssueOpsPlan: any | null;
  supervised: { trajectoryId: string; supervisedPlanId: string; decisions: IntegrationDecision[]; summary: any; memoryUsed: any[] } | null;
  receipts: any[];
  diagnostics: {
    issueOpsWritesDriftGuardMemory: boolean;
    issueOpsCreatesExecutionAuthority: boolean;
    integrationCallsExecutableBeforeApply: boolean;
    localApplySendsRawPayloadToExecutable: boolean;
    humanApprovalsStoredInDriftGuardMemory: boolean;
    receiptsStoredInDriftGuardMemory: boolean;
  };
  lastMessage: string;
};
