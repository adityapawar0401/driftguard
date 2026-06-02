import { z } from "zod";

export const actorSchema = z.object({
  role: z.enum([
    "worker_agent",
    "integration_adapter",
    "driftguard_service",
    "human_reviewer",
    "connector",
    "advisory_llm",
    "system_seed"
  ]),
  id: z.string().min(1),
  name: z.string().optional()
});

export const actionTypeSchema = z.enum([
  "issue_classification",
  "customer_reply_draft",
  "department_action",
  "status_change",
  "sla_escalation",
  "trend_alert",
  "memory_candidate",
  "report_export",
  "unknown"
]);

export const plannedActionSchema = z.object({
  externalItemId: z.string(),
  actionType: actionTypeSchema,
  title: z.string().default("Untitled action"),
  proposedContent: z.string().default(""),
  payload: z.record(z.unknown()).default({}),
  proposedByAgent: z.string().optional(),
  executionMode: z.string().optional(),
  sourceIssueId: z.string().optional(),
  issueNumber: z.string().optional(),
  productSku: z.string().optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
  department: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

export const supervisePlanSchema = z.object({
  actor: actorSchema,
  workspaceId: z.string().min(1),
  sourceSystem: z.literal("issueops"),
  managerObjective: z.string().default("Review proposed work safely."),
  externalPlanId: z.string().optional(),
  sourceProposedBy: actorSchema.optional(),
  plan: z.unknown(),
  context: z.record(z.unknown()).optional(),
  options: z.record(z.unknown()).optional()
});

export const superviseActionSchema = z.object({
  actor: actorSchema,
  workspaceId: z.string().min(1),
  sourceSystem: z.literal("issueops"),
  managerObjective: z.string().default("Review proposed work safely."),
  externalPlanId: z.string().default("single-action"),
  action: plannedActionSchema,
  context: z.record(z.unknown()).optional()
});

export const executableSchema = z.object({
  actor: actorSchema,
  trajectoryId: z.string(),
  stepId: z.string(),
  decisionId: z.string()
}).strict();

export const humanOverrideSchema = executableSchema.extend({
  reviewerId: z.string().min(1),
  reviewerName: z.string().optional(),
  overridePayload: z.record(z.unknown()).optional(),
  reason: z.string().min(1)
});

export const managerApprovalSchema = executableSchema.extend({
  reviewerId: z.string().min(1),
  reviewerName: z.string().optional(),
  editedPayload: z.record(z.unknown()).optional(),
  note: z.string().optional()
});

export const receiptSchema = executableSchema.extend({
  workspaceId: z.string().default("demo-workspace"),
  executionAuthority: z.enum(["driftguard_allow", "driftguard_verified_modified", "human_authorized_override", "not_executable"]),
  status: z.enum(["LOCAL_PLACEHOLDER_RECORDED", "REFUSED", "SKIPPED"]).default("LOCAL_PLACEHOLDER_RECORDED"),
  message: z.string().default("Integration local apply only. No external side effect occurred."),
  payload: z.record(z.unknown()).optional()
});

export const memoryCreateSchema = z.object({
  actor: actorSchema,
  workspaceId: z.string().default("demo-workspace"),
  memoryLayer: z.enum([
    "raw_event_log",
    "worker_proposal_memory",
    "driftguard_decision_memory",
    "connector_receipt_memory",
    "safer_payload_memory",
    "incident_conclusion_candidate",
    "human_approved_conclusion",
    "human_instruction",
    "policy_memory",
    "advisory_memory",
    "human_override_memory"
  ]).default("human_instruction"),
  memoryType: z.string().default("manual_instruction"),
  trustLevel: z.enum([
    "system_config",
    "human_approved",
    "observed_execution",
    "connector_receipt",
    "imported_document",
    "llm_inferred",
    "external_untrusted"
  ]).default("human_approved"),
  content: z.string().min(1),
  structuredJson: z.record(z.unknown()).default({}),
  productSku: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  durable: z.boolean().default(true),
  requiresHumanApproval: z.boolean().default(false)
});
