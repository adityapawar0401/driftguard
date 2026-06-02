const writerByRole = {
    worker_agent: "worker_agent",
    integration_adapter: "integration_adapter",
    driftguard_service: "driftguard",
    human_reviewer: "human_reviewer",
    connector: "connector",
    advisory_llm: "advisory_llm",
    system_seed: "system_seed"
};
export function requireActor(actor) {
    if (!actor?.role || !actor.id) {
        throw new Error("Actor with role and id is required.");
    }
    return actor;
}
export function requireRole(actor, allowed, action) {
    const checked = requireActor(actor);
    if (!allowed.includes(checked.role)) {
        throw new Error(`${checked.role} cannot ${action}.`);
    }
    return checked;
}
export function writerTypeFor(actor) {
    return writerByRole[actor.role];
}
export function assertCanWriteMemory(input) {
    const actor = requireActor(input.actor);
    if (actor.role === "worker_agent") {
        const forbidden = [
            "human_approved_conclusion",
            "human_instruction",
            "policy_memory",
            "connector_receipt_memory",
            "human_override_memory",
            "driftguard_decision_memory",
            "safer_payload_memory"
        ];
        if (forbidden.includes(input.memoryLayer) || input.trustLevel === "human_approved" || input.trustLevel === "system_config") {
            throw new Error("worker_agent cannot write trusted DriftGuard memory.");
        }
    }
    if (actor.role === "integration_adapter") {
        if (input.trustLevel === "human_approved" || input.trustLevel === "system_config" || input.durable) {
            throw new Error("integration_adapter cannot create trusted or durable memory without a human reviewer.");
        }
        if (input.memoryLayer !== "advisory_memory" && input.memoryLayer !== "incident_conclusion_candidate") {
            throw new Error("integration_adapter cannot write authoritative memory directly.");
        }
    }
    if (actor.role === "advisory_llm") {
        if (!["advisory_memory", "incident_conclusion_candidate"].includes(input.memoryLayer)) {
            throw new Error("advisory_llm may only write advisory memory or incident conclusion candidates.");
        }
        if (input.trustLevel !== "llm_inferred" || input.durable || !input.requiresHumanApproval) {
            throw new Error("advisory_llm memory must be llm_inferred, non-durable, and require human approval.");
        }
    }
    if (actor.role === "connector") {
        if (input.memoryLayer !== "connector_receipt_memory" || input.trustLevel !== "connector_receipt") {
            throw new Error("connector may only write connector receipt memory.");
        }
    }
    if (actor.role === "driftguard_service") {
        if (!["driftguard_decision_memory", "safer_payload_memory", "incident_conclusion_candidate"].includes(input.memoryLayer)) {
            throw new Error("driftguard_service may only write DriftGuard decision, safer payload, or incident candidate memory.");
        }
        if (input.trustLevel === "human_approved" || input.trustLevel === "system_config") {
            throw new Error("driftguard_service cannot impersonate human or system policy authority.");
        }
    }
    if (actor.role === "human_reviewer" && !actor.id) {
        throw new Error("human_reviewer memory writes require reviewer id.");
    }
    if (input.trustLevel === "human_approved" && actor.role !== "human_reviewer") {
        throw new Error("human_approved trust requires human_reviewer actor.");
    }
    if (input.trustLevel === "system_config" && actor.role !== "system_seed") {
        throw new Error("system_config trust requires system_seed actor.");
    }
    if (input.durable && actor.role !== "human_reviewer" && actor.role !== "system_seed") {
        throw new Error("durable=true requires human_reviewer or system_seed actor.");
    }
}
