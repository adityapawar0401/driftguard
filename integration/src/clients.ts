export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url).catch((error) => {
    throw new Error(`${url} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown = {}): Promise<T> {
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
  return response.json() as Promise<T>;
}

export async function driftGuardGetJson<T>(url: string): Promise<T> {
  try {
    return await getJson<T>(url);
  } catch (error) {
    throw new Error(`DriftGuard request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function driftGuardPostJson<T>(url: string, body: unknown = {}): Promise<T> {
  try {
    return await postJson<T>(url, body);
  } catch (error) {
    throw new Error(`DriftGuard request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
