import fs from "node:fs";
import path from "node:path";
for (const file of [".env.local", ".env"]) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved))
        continue;
    for (const line of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match)
            continue;
        const [, key, rawValue] = match;
        if (process.env[key] != null)
            continue;
        process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
}
