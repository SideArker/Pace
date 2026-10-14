const PACKAGE_URL = "https://registry.npmjs.org/@sidearker%2fpace/latest";

export async function latestNpmVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(PACKAGE_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 16_384) return undefined;
    const body = await response.text();
    if (body.length > 16_384) return undefined;
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
