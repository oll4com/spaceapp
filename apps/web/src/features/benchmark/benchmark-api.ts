// Direct same-origin fetch (no live-api.ts import): the demo bundle boundary
// forbids live-api.ts, so the Benchmark page stays self-contained.

let cachedCsrfToken: string | null = null;
let cachedCsrfHeader = "x-space-csrf-token";

async function fetchCsrf(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken?: string; headerName?: string };
      if (data.csrfToken) cachedCsrfToken = data.csrfToken;
      if (data.headerName) cachedCsrfHeader = data.headerName;
      return cachedCsrfToken || "";
    }
  } catch {}
  return "";
}

export class BenchmarkHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: { message?: string } };
    if (payload.error?.message) return payload.error.message;
  } catch {}
  return `HTTP ${res.status}`;
}

export async function benchmarkPost<T>(url: string, body: unknown): Promise<T> {
  const token = await fetchCsrf();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers[cachedCsrfHeader] = token;

  let res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    cachedCsrfToken = null;
    const retryToken = await fetchCsrf();
    if (retryToken) headers[cachedCsrfHeader] = retryToken;
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) throw new BenchmarkHttpError(res.status, await errorMessage(res));
  return (await res.json()) as T;
}

export async function benchmarkGet<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { credentials: "same-origin", signal: controller.signal });
    if (!res.ok) throw new BenchmarkHttpError(res.status, await errorMessage(res));
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
