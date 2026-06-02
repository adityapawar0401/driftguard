export type SourceSystem = "issueops";
export type ActionType =
  | "issue_classification"
  | "customer_reply_draft"
  | "department_action"
  | "status_change"
  | "sla_escalation"
  | "trend_alert"
  | "memory_candidate"
  | "report_export"
  | "unknown";
export type Verdict = "allow" | "allow_modified" | "review_required" | "block" | "pause_and_replan";
export type ExecutionAuthority =
  | "driftguard_allow"
  | "driftguard_verified_modified"
  | "human_authorized_override"
  | "not_executable";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type MemoryLayer =
  | "raw_event_log"
  | "worker_proposal_memory"
  | "driftguard_decision_memory"
  | "connector_receipt_memory"
  | "safer_payload_memory"
  | "incident_conclusion_candidate"
  | "human_approved_conclusion"
  | "human_instruction"
  | "policy_memory"
  | "advisory_memory"
  | "human_override_memory";
export type TrustLevel =
  | "system_config"
  | "human_approved"
  | "observed_execution"
  | "connector_receipt"
  | "imported_document"
  | "llm_inferred"
  | "external_untrusted";
export type WriterType =
  | "worker_agent"
  | "driftguard"
  | "human_reviewer"
  | "connector"
  | "advisory_llm"
  | "system_seed"
  | "integration_adapter";
export type ActorRole =
  | "worker_agent"
  | "integration_adapter"
  | "driftguard_service"
  | "human_reviewer"
  | "connector"
  | "advisory_llm"
  | "system_seed";

export type Actor = {
  role: ActorRole;
  id: string;
  name?: string;
};

export type WorkItem = {
  workItemId: string;
  issueNumber?: string;
  productSku?: string;
  productFamily?: string;
  customerId?: string;
  severity?: string;
  category?: string;
  source?: string;
  reportedAt?: string;
  metadata?: Record<string, unknown>;
};

export type PlannedAction = {
  externalItemId: string;
  actionType: ActionType;
  title: string;
  proposedContent: string;
  payload: Record<string, unknown>;
  proposedByAgent?: string;
  executionMode?: string;
  sourceIssueId?: string;
  issueNumber?: string;
  productSku?: string;
  category?: string;
  severity?: string;
  department?: string;
  metadata?: Record<string, unknown>;
};

export type WorkerPlan = {
  sourceSystem: SourceSystem;
  externalPlanId: string;
  managerObjective: string;
  proposedBy?: string;
  proposedAt?: string;
  workItems: WorkItem[];
  planItems: PlannedAction[];
};

export type MemoryRecord = {
  memoryId: string;
  workspaceId: string;
  memoryLayer: MemoryLayer;
  memoryType: string;
  trustLevel: TrustLevel;
  authorityRank: number;
  writerType: WriterType;
  writerId: string;
  content: string;
  structuredJson: Record<string, unknown>;
  sourceEventType?: string;
  sourceDecisionId?: string | null;
  sourceTrajectoryId?: string | null;
  sourceStepId?: string | null;
  productSku?: string | null;
  category?: string | null;
  department?: string | null;
  customerId?: string | null;
  durable: boolean;
  requiresHumanApproval: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DriftGuardDecision = {
  decisionId: string;
  trajectoryId: string;
  stepId: string;
  workspaceId: string;
  sourceSystem: SourceSystem;
  externalPlanId: string;
  externalItemId: string;
  actionType: ActionType;
  verdict: Verdict;
  riskLevel: RiskLevel;
  reasons: string[];
  policyFindings: string[];
  memoryReferences: { memoryId: string; content: string; trustLevel: TrustLevel; authorityRank: number }[];
  originalPayload: Record<string, unknown>;
  modifiedPayload: Record<string, unknown> | null;
  executablePayload: Record<string, unknown> | null;
  executionAuthority: ExecutionAuthority;
  requiresHumanReview: boolean;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type Receipt = {
  receiptId: string;
  workspaceId: string;
  trajectoryId: string;
  stepId: string;
  decisionId: string;
  executionAuthority: ExecutionAuthority;
  status: "LOCAL_PLACEHOLDER_RECORDED" | "REFUSED" | "SKIPPED";
  message: string;
  createdAt: string;
  payload?: Record<string, unknown>;
};

export type Store = {
  decisions: DriftGuardDecision[];
  memories: MemoryRecord[];
  receipts: Receipt[];
  rawEvents: Record<string, unknown>[];
};
