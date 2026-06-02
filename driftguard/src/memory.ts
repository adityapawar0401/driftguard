import crypto from "node:crypto";
import type { MemoryRecord, TrustLevel, WriterType, MemoryLayer, PlannedAction } from "./types.js";

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function now(): string {
  return new Date().toISOString();
}

export function authorityRank(trustLevel: TrustLevel, layer?: MemoryLayer): number {
  if (trustLevel === "system_config") return 100;
  if (layer === "human_override_memory") return 88;
  if (trustLevel === "human_approved") return 90;
  if (trustLevel === "connector_receipt") return 76;
  if (trustLevel === "observed_execution") return 70;
  if (trustLevel === "imported_document") return 65;
  if (trustLevel === "llm_inferred") return 30;
  return 5;
}

export function makeMemory(input: {
  workspaceId: string;
  memoryLayer: MemoryLayer;
  memoryType: string;
  trustLevel: TrustLevel;
  writerType: WriterType;
  writerId: string;
  content: string;
  structuredJson?: Record<string, unknown>;
  sourceEventType?: string;
  sourceDecisionId?: string | null;
  sourceTrajectoryId?: string | null;
  sourceStepId?: string | null;
  productSku?: string | null;
  category?: string | null;
  department?: string | null;
  customerId?: string | null;
  durable?: boolean;
  requiresHumanApproval?: boolean;
}): MemoryRecord {
  const createdAt = now();
  return {
    memoryId: id("mem"),
    authorityRank: authorityRank(input.trustLevel, input.memoryLayer),
    structuredJson: {},
    durable: false,
    requiresHumanApproval: false,
    createdAt,
    updatedAt: createdAt,
    ...input
  };
}

export function relevantMemories(memories: MemoryRecord[], action?: PlannedAction): MemoryRecord[] {
  return [...memories]
    .filter((memory) => {
      if (!action) return true;
      const productOk = !memory.productSku || memory.productSku === action.productSku;
      const categoryOk = !memory.category || memory.category === action.category;
      const departmentOk = !memory.department || memory.department === action.department;
      return productOk && categoryOk && departmentOk;
    })
    .sort((a, b) => b.authorityRank - a.authorityRank)
    .slice(0, 8);
}

export const seedPolicies = (workspaceId = "demo-workspace"): MemoryRecord[] => [
  makeMemory({
    workspaceId,
    memoryLayer: "policy_memory",
    memoryType: "safety_handling",
    trustLevel: "system_config",
    writerType: "system_seed",
    writerId: "seed",
    content: "Safety-related product issues require Service and Quality handling before customer commitments.",
    structuredJson: { constraintType: "sequencing_required", requiredDepartments: ["SERVICE", "QUALITY"] },
    durable: true
  }),
  makeMemory({
    workspaceId,
    memoryLayer: "policy_memory",
    memoryType: "customer_commitment",
    trustLevel: "system_config",
    writerType: "system_seed",
    writerId: "seed",
    content: "Customer replies must not promise refunds, replacements, compensation, legal fault, or root cause without manager or department confirmation.",
    structuredJson: { constraintType: "forbidden_commitment" },
    durable: true
  }),
  makeMemory({
    workspaceId,
    memoryLayer: "policy_memory",
    memoryType: "safety_reply",
    trustLevel: "system_config",
    writerType: "system_seed",
    writerId: "seed",
    content: "Safety-risk replies must advise the customer to stop using the product immediately and contact official support.",
    structuredJson: { constraintType: "requires_context", requiredText: "stop using" },
    durable: true
  }),
  makeMemory({
    workspaceId,
    memoryLayer: "policy_memory",
    memoryType: "local_only",
    trustLevel: "system_config",
    writerType: "system_seed",
    writerId: "seed",
    content: "Placeholder actions must not claim real external execution or delivery occurred.",
    structuredJson: { constraintType: "runtime_local_only" },
    durable: true
  }),
  makeMemory({
    workspaceId,
    memoryLayer: "policy_memory",
    memoryType: "memory_candidate",
    trustLevel: "system_config",
    writerType: "system_seed",
    writerId: "seed",
    content: "Memory candidates are not trusted or durable until human approved.",
    structuredJson: { constraintType: "requires_human_review" },
    durable: true
  })
];
