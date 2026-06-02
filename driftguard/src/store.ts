import fs from "node:fs";
import path from "node:path";
import type { DriftGuardDecision, MemoryRecord, Receipt, Store } from "./types.js";

const defaultFile = path.resolve(process.env.DRIFTGUARD_DATA_FILE ?? "./data/driftguard-store.json");
const everMindWriteRecordTypes = new Set(["decision", "decision_replaced", "memory", "receipt"]);

export interface StoreBackend {
  backendName: "local" | "evermind";
  status(): Promise<Record<string, unknown>>;
  read(): Promise<Store>;
  write(store: Store): Promise<Store>;
  reset(): Promise<Store>;
  addDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision>;
  replaceDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision>;
  findDecision(decisionId: string): Promise<DriftGuardDecision | undefined>;
  addMemory(memory: MemoryRecord): Promise<MemoryRecord>;
  addReceipt(receipt: Receipt): Promise<Receipt>;
  addRawEvent(event: Record<string, unknown>): Promise<void>;
}

export class JsonStore implements StoreBackend {
  backendName = "local" as const;

  constructor(private filePath = defaultFile) {}

  async status(): Promise<Record<string, unknown>> {
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

  async read(): Promise<Store> {
    if (!fs.existsSync(this.filePath)) {
      return { decisions: [], memories: [], receipts: [], rawEvents: [] };
    }
    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Store;
  }

  async write(store: Store): Promise<Store> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
    return store;
  }

  async reset(): Promise<Store> {
    return this.write({ decisions: [], memories: [], receipts: [], rawEvents: [] });
  }

  async addDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision> {
    const store = await this.read();
    store.decisions.unshift(decision);
    await this.write(store);
    return decision;
  }

  async replaceDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision> {
    const store = await this.read();
    store.decisions = [decision, ...store.decisions.filter((item) => item.decisionId !== decision.decisionId)];
    await this.write(store);
    return decision;
  }

  async findDecision(decisionId: string): Promise<DriftGuardDecision | undefined> {
    return (await this.read()).decisions.find((decision) => decision.decisionId === decisionId);
  }

  async addMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    const store = await this.read();
    store.memories.unshift(memory);
    await this.write(store);
    return memory;
  }

  async addReceipt(receipt: Receipt): Promise<Receipt> {
    const store = await this.read();
    store.receipts.unshift(receipt);
    await this.write(store);
    return receipt;
  }

  async addRawEvent(event: Record<string, unknown>): Promise<void> {
    const store = await this.read();
    store.rawEvents.unshift(event);
    await this.write(store);
  }
}

export class EverMindStore implements StoreBackend {
  backendName = "evermind" as const;
  private cache: Store = { decisions: [], memories: [], receipts: [], rawEvents: [] };
  private apiBase = normalizeEverMindBaseUrl(process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai");
  private strict = (process.env.EVERMIND_STRICT ?? "false").toLowerCase() === "true";
  private writeRawEvents = (process.env.DRIFTGUARD_EVERMIND_WRITE_RAW_EVENTS ?? "false").toLowerCase() === "true";
  private rateLimitCooldownUntil = 0;
  private cooldownSkipLogged = false;
  private lastEverMindWarning: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private apiKey = process.env.EVEROS_API_KEY ?? process.env.EVERMIND_API_KEY,
    private userId = process.env.EVERMIND_USER_ID ?? process.env.EVEROS_USER_ID ?? "driftguard-demo"
  ) {
    if (!apiKey) {
      throw new Error("EVEROS_API_KEY or EVERMIND_API_KEY is required when DRIFTGUARD_MEMORY_BACKEND=evermind.");
    }
  }

  async status(): Promise<Record<string, unknown>> {
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

  async read(): Promise<Store> {
    const everMindStore = await this.searchStore();
    this.cache = mergeStores(this.cache, everMindStore);
    return this.cache;
  }

  async write(store: Store): Promise<Store> {
    this.cache = store;
    return store;
  }

  async reset(): Promise<Store> {
    this.cache = { decisions: [], memories: [], receipts: [], rawEvents: [] };
    return this.cache;
  }

  async addDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision> {
    this.cache.decisions.unshift(decision);
    await this.enqueuePersistRecord("decision", decision.workspaceId, decision);
    return decision;
  }

  async replaceDecision(decision: DriftGuardDecision): Promise<DriftGuardDecision> {
    this.cache.decisions = [decision, ...this.cache.decisions.filter((item) => item.decisionId !== decision.decisionId)];
    await this.enqueuePersistRecord("decision_replaced", decision.workspaceId, decision);
    return decision;
  }

  async findDecision(decisionId: string): Promise<DriftGuardDecision | undefined> {
    const cached = this.cache.decisions.find((decision) => decision.decisionId === decisionId);
    if (cached) return cached;
    const found = await this.searchDecision(decisionId);
    if (found) {
      this.cache.decisions = [found, ...this.cache.decisions.filter((item) => item.decisionId !== found.decisionId)];
    }
    return found;
  }

  async addMemory(memory: MemoryRecord): Promise<MemoryRecord> {
    this.cache.memories.unshift(memory);
    await this.enqueuePersistRecord("memory", memory.workspaceId, memory);
    return memory;
  }

  async addReceipt(receipt: Receipt): Promise<Receipt> {
    this.cache.receipts.unshift(receipt);
    await this.enqueuePersistRecord("receipt", receipt.workspaceId, receipt);
    return receipt;
  }

  async addRawEvent(event: Record<string, unknown>): Promise<void> {
    this.cache.rawEvents.unshift(event);
    if (this.writeRawEvents) {
      await this.enqueuePersistRecord("raw_event_log", String(event.workspaceId ?? "workspace"), event);
    }
  }

  private enqueuePersistRecord(recordType: string, sessionId: string, payload: unknown): Promise<void> {
    const write = this.writeQueue.then(() => this.persistRecord(recordType, sessionId, payload));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async persistRecord(recordType: string, sessionId: string, payload: unknown): Promise<void> {
    if (!this.shouldSendToEverMind(recordType)) return;
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
    } catch (error) {
      let handledError = error;
      if (error instanceof EverMindRequestError && (error.status === 400 || error.status === 422)) {
        try {
          await this.request("/memories/agent", toDocumentedEverMindAgentPayload(body));
          return;
        } catch (retryError) {
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

  private async searchRecord<T>(id: string, expectedType: string): Promise<T | undefined> {
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
      return extractDriftGuardPayload<T>(result, expectedType, id);
    } catch (error) {
      if (this.strict) throw error;
      this.warn(`optional EverMind search failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async searchDecision(decisionId: string): Promise<DriftGuardDecision | undefined> {
    const candidates = await this.searchRecords<DriftGuardDecision>(`DRIFTGUARD_RECORD decision decisionId ${decisionId}`, ["decision", "decision_replaced"], 10);
    const matching = candidates.filter((decision) => decision.decisionId === decisionId);
    return matching.find((decision) => isRecord(decision.metadata) && (isRecord(decision.metadata.managerApproval) || isRecord(decision.metadata.humanOverride)))
      ?? matching[0];
  }

  private async searchStore(): Promise<Store> {
    const records = await this.searchDriftGuardRecords("DRIFTGUARD_RECORD source driftguard", 100);
    return recordsToStore(records);
  }

  private async searchRecords<T>(query: string, expectedTypes: string[], topK: number): Promise<T[]> {
    const records = await this.searchDriftGuardRecords(query, topK);
    return records
      .filter((record) => expectedTypes.includes(record.recordType ?? ""))
      .map((record) => record.payload as T)
      .filter((payload): payload is T => payload !== undefined && payload !== null);
  }

  private async searchDriftGuardRecords(query: string, topK: number): Promise<DriftGuardRecord[]> {
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
    } catch (error) {
      if (this.strict) throw error;
      this.warn(`optional EverMind search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private shouldSendToEverMind(recordType: string): boolean {
    return everMindWriteRecordTypes.has(recordType) || (recordType === "raw_event_log" && this.writeRawEvents);
  }

  private inRateLimitCooldown(): boolean {
    return this.rateLimitCooldownUntil > Date.now();
  }

  private warn(message: string): void {
    this.lastEverMindWarning = message;
    console.warn(`[driftguard:evermind] ${message}`);
  }

  private async request(pathname: string, body: unknown, method: "POST" | "GET" = "POST"): Promise<unknown> {
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
  constructor(public status: number, responseText: string) {
    super(`EverMind request failed ${status}: ${responseText}`);
  }
}

type DriftGuardRecord = {
  recordType?: string;
  payload?: unknown;
};

export function normalizeEverMindBaseUrl(baseUrl = process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai"): string {
  const withoutTrailingSlash = baseUrl.replace(/\/+$/, "");
  return withoutTrailingSlash.endsWith("/api/v1") ? withoutTrailingSlash : `${withoutTrailingSlash}/api/v1`;
}

export function buildEverMindUrl(pathname: string, baseUrl = process.env.EVERMIND_API_BASE_URL ?? process.env.EVEROS_API_BASE_URL ?? "https://api.evermind.ai"): string {
  const normalizedBase = normalizeEverMindBaseUrl(baseUrl);
  const normalizedPath = pathname.startsWith("/api/v1/")
    ? pathname.slice("/api/v1".length)
    : pathname.startsWith("/")
      ? pathname
      : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function toEverMindAgentMemoryPayload(recordType: string, sessionId: string, payload: unknown, userId = process.env.EVERMIND_USER_ID ?? process.env.EVEROS_USER_ID ?? "driftguard-demo"): object {
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

function driftGuardMetadata(recordType: string, payload: unknown): Record<string, unknown> {
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

function stableRecordId(payload: unknown): string {
  const value = isRecord(payload) ? payload : {};
  const id = value.decisionId ?? value.memoryId ?? value.receiptId ?? value.eventId ?? Date.now();
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toDocumentedEverMindAgentPayload(body: object): object {
  if (!isRecord(body) || !Array.isArray(body.messages)) return body;
  const { metadata: _metadata, ...topLevel } = body;
  return {
    ...topLevel,
    messages: body.messages.map((message) => {
      if (!isRecord(message)) return message;
      return {
        role: message.role,
        timestamp: message.timestamp,
        content: message.content
      };
    })
  };
}

function mergeStores(primary: Store, secondary: Store): Store {
  return {
    decisions: dedupeBy([...primary.decisions, ...secondary.decisions], (decision) => decision.decisionId),
    memories: dedupeBy([...primary.memories, ...secondary.memories], (memory) => memory.memoryId),
    receipts: dedupeBy([...primary.receipts, ...secondary.receipts], (receipt) => receipt.receiptId),
    rawEvents: dedupeBy([...primary.rawEvents, ...secondary.rawEvents], (event) => String(event.eventId ?? JSON.stringify(event)))
  };
}

function recordsToStore(records: DriftGuardRecord[]): Store {
  const store: Store = { decisions: [], memories: [], receipts: [], rawEvents: [] };
  for (const record of records) {
    if (record.recordType === "decision" || record.recordType === "decision_replaced") {
      if (isDriftGuardDecision(record.payload)) store.decisions.unshift(record.payload);
    }
    if (record.recordType === "memory") {
      if (isMemoryRecord(record.payload)) store.memories.unshift(record.payload);
    }
    if (record.recordType === "receipt") {
      if (isReceipt(record.payload)) store.receipts.unshift(record.payload);
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

function dedupeBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractDriftGuardPayload<T>(result: unknown, expectedType: string, id: string): T | undefined {
  for (const candidate of extractDriftGuardRecords(result)) {
    if (candidate.recordType === expectedType && JSON.stringify(candidate.payload).includes(id)) {
      return candidate.payload as T;
    }
  }
  return undefined;
}

function extractDriftGuardRecords(result: unknown): DriftGuardRecord[] {
  const records: DriftGuardRecord[] = [];
  const seen = new Set<string>();
  for (const value of walkJson(result)) {
    const candidate = parseDriftGuardRecord(value);
    if (!candidate) continue;
    const key = `${candidate.recordType}:${JSON.stringify(candidate.payload)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(candidate);
  }
  return records;
}

function parseDriftGuardRecord(value: unknown): DriftGuardRecord | undefined {
  if (isRecord(value) && value.marker === "DRIFTGUARD_RECORD") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) && parsed.marker === "DRIFTGUARD_RECORD" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  const text = isRecord(value.text) ? value.text.content : value.content;
  if (typeof text !== "string") return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) && parsed.marker === "DRIFTGUARD_RECORD" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isDriftGuardDecision(value: unknown): value is DriftGuardDecision {
  return isRecord(value) && typeof value.decisionId === "string" && typeof value.trajectoryId === "string" && typeof value.stepId === "string";
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  return isRecord(value) && typeof value.memoryId === "string" && typeof value.workspaceId === "string" && typeof value.content === "string";
}

function isReceipt(value: unknown): value is Receipt {
  return isRecord(value) && typeof value.receiptId === "string" && typeof value.decisionId === "string" && typeof value.message === "string";
}

function* walkJson(value: unknown): Generator<unknown> {
  yield value;
  if (Array.isArray(value)) {
    for (const item of value) yield* walkJson(item);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) yield* walkJson(item);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createStore(): StoreBackend {
  return (process.env.DRIFTGUARD_MEMORY_BACKEND ?? "local").toLowerCase() === "evermind"
    ? new EverMindStore()
    : new JsonStore();
}

export const store = createStore();
