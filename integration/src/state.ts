import type { IntegrationDecision, IntegrationState } from "./types.js";

export function createInitialState(): IntegrationState {
  return {
    issueOpsBaseUrl: process.env.ISSUEOPS_BASE_URL ?? "http://localhost:3000",
    driftGuardBaseUrl: process.env.DRIFTGUARD_BASE_URL ?? "http://localhost:4100",
    workspaceId: process.env.INTEGRATION_WORKSPACE_ID ?? "demo-workspace",
    managerId: process.env.INTEGRATION_MANAGER_ID ?? "manager-demo",
    managerName: process.env.INTEGRATION_MANAGER_NAME ?? "Demo Manager",
    managerObjective: "Handle urgent customer issues while avoiding unapproved commitments.",
    maxIssues: 1,
    issueOpsHealth: "unknown",
    driftGuardHealth: "unknown",
    latestIssueOpsPlan: null,
    supervised: null,
    receipts: [],
    diagnostics: {
      issueOpsWritesDriftGuardMemory: false,
      issueOpsCreatesExecutionAuthority: false,
      integrationCallsExecutableBeforeApply: true,
      localApplySendsRawPayloadToExecutable: false,
      humanApprovalsStoredInDriftGuardMemory: false,
      receiptsStoredInDriftGuardMemory: false
    },
    lastMessage: "Ready. For DriftGuard demo, use this Integration app, not direct IssueOps apply."
  };
}

export const state = createInitialState();

export function withApproval(decisions: any[]): IntegrationDecision[] {
  return decisions.map((decision) => ({
    ...decision,
    approvalState: "pending",
    executionState: "not_applied"
  }));
}
