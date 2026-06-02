export async function getJson(url) {
    const response = await fetch(url).catch((error) => {
        throw new Error(`${url} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok)
        throw new Error(`${url} returned ${response.status}`);
    return response.json();
}
export async function postJson(url, body = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    }).catch((error) => {
        throw new Error(`${url} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${url} returned ${response.status}: ${text}`);
    }
    return response.json();
}
export async function driftGuardGetJson(url) {
    try {
        return await getJson(url);
    }
    catch (error) {
        throw new Error(`DriftGuard request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function driftGuardPostJson(url, body = {}) {
    try {
        return await postJson(url, body);
    }
    catch (error) {
        throw new Error(`DriftGuard request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
