import "./env.js";
import express from "express";
import cors from "cors";
import { driftGuardService } from "./service.js";
import { executableSchema, humanOverrideSchema, managerApprovalSchema, memoryCreateSchema, receiptSchema, superviseActionSchema, supervisePlanSchema } from "./schema.js";
export function createApp() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: "5mb" }));
    app.get("/health", asyncRoute(async (_req, res) => {
        res.json({
            ok: true,
            service: "driftguard",
            externalSideEffects: "local-placeholder-only",
            memory: await driftGuardService.backendStatus()
        });
    }));
    app.get("/api/memory/backend", asyncRoute(async (_req, res) => {
        res.json(await driftGuardService.backendStatus());
    }));
    app.post("/api/seed", asyncRoute(async (req, res) => {
        res.json(await driftGuardService.seed(req.body?.workspaceId ?? "demo-workspace"));
    }));
    app.post("/api/supervise-plan", asyncRoute(async (req, res) => {
        const input = supervisePlanSchema.parse(req.body);
        res.json(await driftGuardService.supervisePlan(input));
    }));
    app.post("/api/supervise-action", asyncRoute(async (req, res) => {
        const input = superviseActionSchema.parse(req.body);
        res.json(await driftGuardService.superviseAction(input));
    }));
    app.get("/api/decisions/:decisionId", asyncRoute(async (req, res) => {
        const decision = await driftGuardService["repo"].findDecision(req.params.decisionId);
        if (!decision)
            return res.status(404).json({ error: "Decision not found." });
        return res.json(decision);
    }));
    app.post("/api/executable", asyncRoute(async (req, res) => {
        const input = executableSchema.parse(req.body);
        res.json(await driftGuardService.executable(input));
    }));
    app.post("/api/human-override", asyncRoute(async (req, res) => {
        const input = humanOverrideSchema.parse(req.body);
        res.json(await driftGuardService.humanOverride(input));
    }));
    app.post("/api/manager-approval", asyncRoute(async (req, res) => {
        const input = managerApprovalSchema.parse(req.body);
        res.json(await driftGuardService.managerApproval(input));
    }));
    app.post("/api/receipt", asyncRoute(async (req, res) => {
        const input = receiptSchema.parse(req.body);
        res.json(await driftGuardService.receipt(input));
    }));
    app.get("/api/memory", asyncRoute(async (req, res) => {
        res.json({ memories: await driftGuardService.memory({ workspaceId: req.query.workspaceId?.toString(), limit: Number(req.query.limit ?? 100) }) });
    }));
    app.post("/api/memory", asyncRoute(async (req, res) => {
        const input = memoryCreateSchema.parse(req.body);
        res.json(await driftGuardService.addMemory(input));
    }));
    app.use((err, _req, res, _next) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        res.status(400).json({ error: message });
    });
    return app;
}
function asyncRoute(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
if (process.env.NODE_ENV !== "test") {
    const port = Number(process.env.DRIFTGUARD_PORT ?? 4100);
    createApp().listen(port, () => {
        console.log(`DriftGuard listening on http://localhost:${port}`);
        driftGuardService.backendStatus()
            .then((status) => console.log(`DriftGuard memory backend: ${status.backend}`))
            .catch((error) => console.error(`Unable to read DriftGuard memory backend status: ${error instanceof Error ? error.message : String(error)}`));
    });
}
