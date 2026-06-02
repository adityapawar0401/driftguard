import "./env.js";
import { driftGuardService } from "./service.js";

const workspaceId = process.argv[2] ?? "demo-workspace";
console.log(JSON.stringify(await driftGuardService.seed(workspaceId), null, 2));
