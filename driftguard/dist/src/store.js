import fs from "node:fs";
import path from "node:path";
const defaultFile = path.resolve(process.env.DRIFTGUARD_DATA_FILE ?? "./data/driftguard-store.json");
const everMindWriteRecordTypes = new Set(["decision", "decision_replaced", "memory", "receipt"]);
export class JsonStore {
    filePath;
    backendName = "local";
    constructor(filePath = defaultFile) {
        this.filePath = filePath;
    }
    async status() {
        const store = await this.read();
        return {
            backend: this.backendName,
            filePath: this.filePath,
            decisionCount: store.decisions.length,
            memoryCount: store.memories.length,
            receiptCount: store.receipts.length,
            rawEventCount: store.rawEvents.length
        };
    }
    async read() {
        if (!fs.existsSync(this.filePath)) {
            return { decisions: [], memories: [], receipts: [], rawEvents: [] };
        }
        return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    }
    async write(store) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
        return store;
    }
    async reset() {
        return this.write({ decisions: [], memories: [], receipts: [], rawEvents: [] });
    }
    async addDecision(decision) {
        const store = await this.read();
        store.decisions.unshift(decision);
        await this.write(store);
        return decision;
    }
    async replaceDecision(decision) {
        const store = await this.read();
        store.decisions = [decision, ...store.decisions.filter((item) => item.decisionId !== decision.decisionId)];
        await this.write(store);
        return decision;
    }
    async findDecision(decisionId) {
        return (await this.read()).decisions.find((decision) => decision.decisionId === decisionId);
    }
    async addMemory(memory) {
        const store = await this.read();
        store.memories.unshift(memory);
        await this.write(store);
        return memory;
    }
    async addReceipt(receipt) {
        const store = await this.read();
        store.receipts.unshift(receipt);
        await this.write(store);
        return receipt;
    }
    async addRawEvent(event) {
        const store = await this.read();
        store.rawEvents.unshift(event);
        await this.write(store);
    }
}
export class EverMindStore {
    apiKey;
    userId;
    backendName = "evermind";
    cache = { decisions: [], memories: [], receipts: [], rawEvents: [] };
    apiBase = normalizeEverMindBaseUrl(process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai");
    strict = (process.env.EVERMIND_STRICT ?? "false").toLowerCase() === "true";
    writeRawEvents = (process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS ?? "false").toLowerCase() === "true";
    rateLimitCooldownUntil = 0;
    cooldownSkipLogged = false;
    lastEverMindWarning = null;
    writeQueue = Promise.resolve();
    constructor(apiKey = process.env.EVEROS_API_KEY ?? process.env.EVERMIND_API_KEY, userId = process.env.EVERMIND_USER_ID ?? process.env.EVEROS_USER_ID ?? "driftguard-demo") {
        this.apiKey = apiKey;
        this.userId = userId;
        if (!apiKey) {
            throw new Error("EVEROS_API_KEY or EVERMIND_API_KEY is required when DRIFTGUARD_MEMORY_BACKEND=evermind.");
        }
    }
    async status() {
        return {
            backend: this.backendName,
            persistence: "evermind",
            cache: "memory-only",
            strict: this.strict,
            apiBase: this.apiBase,
            userId: this.userId,
            apiKeyConfigured: Boolean(this.apiKey),
            decisionCount: this.cache.decisions.length,
            memoryCount: this.cache.memories.length,
            receiptCount: this.cache.receipts.length,
            rawEventCount: this.cache.rawEvents.length,
            rateLimitCooldownUntil: this.rateLimitCooldownUntil || null,
            inRateLimitCooldown: this.inRateLimitCooldown(),
            lastEverMindWarning: this.lastEverMindWarning
        };
    }
    async read() {
        const everMindStore = await this.searchStore();
        this.cache = mergeStores(this.cache, everMindStore);
        return this.cache;
    }
    async write(store) {
        this.cache = store;
        return store;
    }
    async reset() {
        this.cache = { decisions: [], memories: [], receipts: [], rawEvents: [] };
        return this.cache;
    }
    async addDecision(decision) {
        this.cache.decisions.unshift(decision);
        await this.enqueuePersistRecord("decision", decision.workspaceId, decision);
        return decision;
    }
    async replaceDecision(decision) {
        this.cache.decisions = [decision, ...this.cache.decisions.filter((item) => item.decisionId !== decision.decisionId)];
        await this.enqueuePersistRecord("decision_replaced", decision.workspaceId, decision);
        return decision;
    }
    async findDecision(decisionId) {
        const cached = this.cache.decisions.find((decision) => decision.decisionId === decisionId);
        if (cached)
            return cached;
        const found = await this.searchDecision(decisionId);
        if (found) {
            this.cache.decisions = [found, ...this.cache.decisions.filter((item) => item.decisionId !== found.decisionId)];
        }
        return found;
    }
    async addMemory(memory) {
        this.cache.memories.unshift(memory);
        await this.enqueuePersistRecord("memory", memory.workspaceId, memory);
        return memory;
    }
    async addReceipt(receipt) {
        this.cache.receipts.unshift(receipt);
        await this.enqueuePersistRecord("receipt", receipt.workspaceId, receipt);
        return receipt;
    }
    async addRawEvent(event) {
        this.cache.rawEvents.unshift(event);
        if (this.writeRawEvents) {
            await this.enqueuePersistRecord("raw_event_log", String(event.workspaceId ?? "workspace"), event);
        }
    }
    enqueuePersistRecord(recordType, sessionId, payload) {
        const write = this.writeQueue.then(() => this.persistRecord(recordType, sessionId, payload));
        this.writeQueue = write.catch(() => undefined);
        return write;
    }
    async persistRecord(recordType, sessionId, payload) {
        if (!this.shouldSendToEverMind(recordType))
            return;
        if (this.inRateLimitCooldown()) {
            if (!this.cooldownSkipLogged) {
                this.warn(`skipping EverMind writes during rate-limit cooldown until ${new Date(this.rateLimitCooldownUntil).toISOString()}`);
                this.cooldownSkipLogged = true;
            }
            return;
        }
        const body = toEverMindAgentMemoryPayload(recordType, sessionId, payload, this.userId);
        try {
            await this.request("/memories/agent", body);
        }
        catch (error) {
            let handledError = error;
            if (error instanceof EverMindRequestError && (error.status === 400 || error.status === 422)) {
                try {
                    await this.request("/memories/agent", toDocumentedEverMindAgentPayload(body));
                    return;
                }
                catch (retryError) {
                    handledError = retryError;
                }
            }
            const message = handledError instanceof Error ? handledError.message : String(handledError);
            if (handledError instanceof EverMindRequestError && handledError.status === 429 && !this.strict) {
                this.rateLimitCooldownUntil = Date.now() + 60_000;
                this.cooldownSkipLogged = false;
                this.warn(`rate limited by EverMind; cooling down writes for 60s: ${message}`);
                return;
            }
            if (this.strict) {
                throw handledError;
            }
            this.warn(`non-strict memory write failed: ${message}`);
        }
    }
    async searchRecord(id, expectedType) {
        const body = {
            query: `DRIFTGUARD_RECORD ${expectedType} ${id}`,
            filters: { user_id: this.userId },
            method: "hybrid",
            memory_types: ["raw_message", "agent_memory"],
            top_k: 10,
            include_original_data: true
        };
        try {
            const result = await this.request("/memories/search", body, "POST").catch(async (error) => {
                if (error instanceof EverMindRequestError && error.status === 405) {
                    return this.request("/memories/search", body, "GET");
                }
                throw error;
            });
            return extractDriftGuardPayload(result, expectedType, id);
        }
        catch (error) {
            if (this.strict)
                throw error;
            this.warn(`optional EverMind search failed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }
    async searchDecision(decisionId) {
        const candidates = await this.searchRecords(`DRIFTGUARD_RECORD decision decisionId ${decisionId}`, ["decision", "decision_replaced"], 10);
        const matching = candidates.filter((decision) => decision.decisionId === decisionId);
        return matching.find((decision) => isRecord(decision.metadata) && (isRecord(decision.metadata.managerApproval) || isRecord(decision.metadata.humanOverride)))
            ?? matching[0];
    }
    async searchStore() {
        const records = await this.searchDriftGuardRecords("DRIFTGUARD_RECORD source driftguard", 100);
        return recordsToStore(records);
    }
    async searchRecords(query, expectedTypes, topK) {
        const records = await this.searchDriftGuardRecords(query, topK);
        return records
            .filter((record) => expectedTypes.includes(record.recordType ?? ""))
            .map((record) => record.payload)
            .filter((payload) => payload !== undefined && payload !== null);
    }
    async searchDriftGuardRecords(query, topK) {
        const body = {
            query,
            filters: { user_id: this.userId },
            method: "hybrid",
            memory_types: ["raw_message", "agent_memory", "episodic_memory"],
            top_k: topK,
            include_original_data: true
        };
        try {
            const result = await this.request("/memories/search", body, "POST").catch(async (error) => {
                if (error instanceof EverMindRequestError && error.status === 405) {
                    return this.request("/memories/search", body, "GET");
                }
                throw error;
            });
            return extractDriftGuardRecords(result);
        }
        catch (error) {
            if (this.strict)
                throw error;
            this.warn(`optional EverMind search failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    shouldSendToEverMind(recordType) {
        return everMindWriteRecordTypes.has(recordType) || (recordType === "raw_event_log" && this.writeRawEvents);
    }
    inRateLimitCooldown() {
        return this.rateLimitCooldownUntil > Date.now();
    }
    warn(message) {
        this.lastEverMindWarning = message;
        console.warn(`[driftguard:evermind] ${message}`);
    }
    async request(pathname, body, method = "POST") {
        const response = await fetch(buildEverMindUrl(pathname, this.apiBase), {
            method,
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new EverMindRequestError(response.status, text);
        }
        return response.json().catch(() => ({}));
    }
}
export class EverMindRequestError extends Error {
    status;
    constructor(status, responseText) {
        super(`EverMind request failed ${status}: ${responseText}`);
        this.status = status;
    }
}
export function normalizeEverMindBaseUrl(baseUrl = process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai") {
    const withoutTrailingSlash = baseUrl.replace(/\/+$/, "");
    return withoutTrailingSlash.endsWith("/api/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/api/v1`;
}
export function buildEverMindUrl(pathname, baseUrl = process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai") {
    const normalizedBase = normalizeEverMindBaseUrl(baseUrl);
    const normalizedPath = pathname.startsWith("/api/v1/")
        ? pathname.slice("/api/v1".length)
        : pathname.startsWith("/")
            ? pathname
            : `/${pathname}`;
    return `${normalizedBase}${normalizedPath}`;
}
export function toEverMindAgentMemoryPayload(recordType, sessionId, payload, userId = process.env.EVERMIND_USER_ID ?? process.env.EVEROS_USER_ID ?? "driftguard-demo") {
    const now = new Date().toISOString();
    const metadata = driftGuardMetadata(recordType, payload);
    const content = JSON.stringify({
        marker: "DRIFTGUARD_RECORD",
        recordType,
        payload,
        metadata
    });
    return {
        user_id: userId,
        session_id: `driftguard:${sessionId}`,
        messages: [
            {
                message_id: `dg_${recordType}_${stableRecordId(payload)}`,
                sender_id: "driftguard",
                sender_name: "DriftGuard",
                role: "assistant",
                timestamp: Date.now(),
                content,
                type: "text",
                text: {
                    content
                },
                metadata
            }
        ],
        metadata: {
            source: "driftguard",
            recordType,
            timestamp: now
        },
        async_mode: false
    };
}
function driftGuardMetadata(recordType, payload) {
    const value = isRecord(payload) ? payload : {};
    return {
        source: "driftguard",
        recordType,
        workspaceId: value.workspaceId,
        memoryLayer: value.memoryLayer,
        memoryType: value.memoryType,
        trustLevel: value.trustLevel,
        authorityRank: value.authorityRank,
        writerType: value.writerType,
        writerId: value.writerId,
        sourceDecisionId: value.sourceDecisionId ?? value.decisionId,
        sourceTrajectoryId: value.sourceTrajectoryId ?? value.trajectoryId,
        sourceStepId: value.sourceStepId ?? value.stepId,
        productSku: value.productSku ?? (isRecord(value.metadata) ? value.metadata.productSku : undefined),
        category: value.category ?? (isRecord(value.metadata) ? value.metadata.category : undefined),
        department: value.department ?? (isRecord(value.metadata) ? value.metadata.department : undefined),
        customerId: value.customerId ?? (isRecord(value.metadata) ? value.metadata.customerId : undefined),
        durable: value.durable,
        requiresHumanApproval: value.requiresHumanApproval
    };
}
function stableRecordId(payload) {
    const value = isRecord(payload) ? payload : {};
    const id = value.decisionId ?? value.memoryId ?? value.receiptId ?? value.eventId ?? Date.now();
    return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}
function toDocumentedEverMindAgentPayload(body) {
    if (!isRecord(body) || !Array.isArray(body.messages))
        return body;
    const { metadata: _metadata, ...topLevel } = body;
    return {
        ...topLevel,
        messages: body.messages.map((message) => {
            if (!isRecord(message))
                return message;
            return {
                role: message.role,
                timestamp: message.timestamp,
                content: message.content
            };
        })
    };
}
function mergeStores(primary, secondary) {
    return {
        decisions: dedupeBy([...primary.decisions, ...secondary.decisions], (decision) => decision.decisionId),
        memories: dedupeBy([...primary.memories, ...secondary.memories], (memory) => memory.memoryId),
        receipts: dedupeBy([...primary.receipts, ...secondary.receipts], (receipt) => receipt.receiptId),
        rawEvents: dedupeBy([...primary.rawEvents, ...secondary.rawEvents], (event) => String(event.eventId ?? JSON.stringify(event)))
    };
}
function recordsToStore(records) {
    const store = { decisions: [], memories: [], receipts: [], rawEvents: [] };
    for (const record of records) {
        if (record.recordType === "decision" || record.recordType === "decision_replaced") {
            if (isDriftGuardDecision(record.payload))
                store.decisions.unshift(record.payload);
        }
        if (record.recordType === "memory") {
            if (isMemoryRecord(record.payload))
                store.memories.unshift(record.payload);
        }
        if (record.recordType === "receipt") {
            if (isReceipt(record.payload))
                store.receipts.unshift(record.payload);
        }
        if (record.recordType === "raw_event_log" && isRecord(record.payload)) {
            store.rawEvents.unshift(record.payload);
        }
    }
    return {
        decisions: dedupeBy(store.decisions, (decision) => decision.decisionId),
        memories: dedupeBy(store.memories, (memory) => memory.memoryId),
        receipts: dedupeBy(store.receipts, (receipt) => receipt.receiptId),
        rawEvents: dedupeBy(store.rawEvents, (event) => String(event.eventId ?? JSON.stringify(event)))
    };
}
function dedupeBy(items, keyFor) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = keyFor(item);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}
function extractDriftGuardPayload(result, expectedType, id) {
    for (const candidate of extractDriftGuardRecords(result)) {
        if (candidate.recordType === expectedType && JSON.stringify(candidate.payload).includes(id)) {
            return candidate.payload;
        }
    }
    return undefined;
}
function extractDriftGuardRecords(result) {
    const records = [];
    const seen = new Set();
    for (const value of walkJson(result)) {
        const candidate = parseDriftGuardRecord(value);
        if (!candidate)
            continue;
        const key = `${candidate.recordType}:${JSON.stringify(candidate.payload)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        records.push(candidate);
    }
    return records;
}
function parseDriftGuardRecord(value) {
    if (isRecord(value) && value.marker === "DRIFTGUARD_RECORD")
        return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return isRecord(parsed) && parsed.marker === "DRIFTGUARD_RECORD" ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    }
    if (!isRecord(value))
        return undefined;
    const text = isRecord(value.text) ? value.text.content : value.content;
    if (typeof text !== "string")
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return isRecord(parsed) && parsed.marker === "DRIFTGUARD_RECORD" ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function isDriftGuardDecision(value) {
    return isRecord(value) && typeof value.decisionId === "string" && typeof value.trajectoryId === "string" && typeof value.stepId === "string";
}
function isMemoryRecord(value) {
    return isRecord(value) && typeof value.memoryId === "string" && typeof value.workspaceId === "string" && typeof value.content === "string";
}
function isReceipt(value) {
    return isRecord(value) && typeof value.receiptId === "string" && typeof value.decisionId === "string" && typeof value.message === "string";
}
function* walkJson(value) {
    yield value;
    if (Array.isArray(value)) {
        for (const item of value)
            yield* walkJson(item);
        return;
    }
    if (isRecord(value)) {
        for (const item of Object.values(value))
            yield* walkJson(item);
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function createStore() {
    return (process.env.DRIFTGUARD_MEMORY_BACKEND ?? "local").toLowerCase() === "evermind"
        ? new EverMindStore()
        : new JsonStore();
}
export const store = createStore();
