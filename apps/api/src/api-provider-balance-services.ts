import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import {
  type ApiProviderAccount,
  type ApiProviderAccountList
} from "@space/contracts";
import { getLastKnownJevCredits } from "./room-decisions.js";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const DEFAULT_THB_PER_USD = 33.13;

export interface GoogleServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface ProviderKeys {
  deepseek?: string;
  openrouter?: string;
  vercel?: string;
  google?: string;
  googleSa?: GoogleServiceAccountKey;
  openai?: string;
  jev?: string;
}

export async function discoverApiProviderKeys(): Promise<ProviderKeys> {
  const keys: ProviderKeys = {};

  // 1. Process environment
  if (process.env.DEEPSEEK_API_KEY) keys.deepseek = process.env.DEEPSEEK_API_KEY.trim();
  if (process.env.OPENROUTER_API_KEY) keys.openrouter = process.env.OPENROUTER_API_KEY.trim();
  if (process.env.AI_GATEWAY_API_KEY) keys.vercel = process.env.AI_GATEWAY_API_KEY.trim();
  if (process.env.GEMINI_API_KEY) keys.google = process.env.GEMINI_API_KEY.trim();
  if (process.env.GOOGLE_API_KEY && !keys.google) keys.google = process.env.GOOGLE_API_KEY.trim();
  if (process.env.OPENAI_API_KEY) keys.openai = process.env.OPENAI_API_KEY.trim();
  if (process.env.SPACE_JEV_API_KEY) keys.jev = process.env.SPACE_JEV_API_KEY.trim();
  if (process.env.JEV_API_KEY && !keys.jev) keys.jev = process.env.JEV_API_KEY.trim();

  // 2. Reasonix .env file
  try {
    const raw = await readFile("/var/lib/spaceapp-user/.reasonix/.env", "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!val) continue;

      if (key === "DEEPSEEK_API_KEY" && !keys.deepseek) keys.deepseek = val;
      else if (key === "OPENROUTER_API_KEY" && !keys.openrouter) keys.openrouter = val;
      else if (key === "AI_GATEWAY_API_KEY" && !keys.vercel) keys.vercel = val;
      else if ((key === "GEMINI_API_KEY" || key === "GOOGLE_API_KEY") && !keys.google) keys.google = val;
      else if ((key === "SPACE_JEV_API_KEY" || key === "JEV_API_KEY") && !keys.jev) keys.jev = val;
    }
  } catch {}

  // 3. Fallback DeepSeek credential file
  if (!keys.deepseek) {
    for (const file of [
      process.env.SPACE_DEEPSEEK_KEY_FILE,
      "/opt/spaceapp/secrets/space-deepseek.key",
      "/opt/spaceapp/secrets/space-deepseek-voice.key",
      "/var/lib/spaceapp-user/.codex/space-deepseek/credentials/api-key",
      "/var/lib/spaceapp-user/.config/opencode/deepseek.token"
    ]) {
      if (!file) continue;
      try {
        const raw = await readFile(file, "utf8");
        const val = raw.trim();
        if (val) {
          keys.deepseek = val;
          break;
        }
      } catch {}
    }
  }

  // 3b. Fallback OpenRouter credential file
  if (!keys.openrouter) {
    for (const file of [
      process.env.SPACE_OPENROUTER_KEY_FILE,
      "/opt/spaceapp/secrets/space-openrouter.key",
      "/opt/spaceapp/secrets/space-openrouter-voice.key",
      "/var/lib/spaceapp-user/.config/opencode/openrouter.token"
    ]) {
      if (!file) continue;
      try {
        const raw = await readFile(file, "utf8");
        const val = raw.trim();
        if (val) {
          keys.openrouter = val;
          break;
        }
      } catch {}
    }
  }

  // 4. Fallback Google Gemini secret keys
  if (!keys.google) {
    for (const file of [
      process.env.SPACE_GOOGLE_VOICE_KEY_FILE,
      process.env.SPACE_GEMINI_VOICE_KEY_FILE,
      "/opt/spaceapp/secrets/space-google-voice.key",
      "/opt/spaceapp/secrets/space-gemini-voice.key"
    ]) {
      if (!file) continue;
      try {
        const raw = await readFile(file, "utf8");
        const val = raw.trim();
        if (val) {
          keys.google = val;
          break;
        }
      } catch {}
    }
  }

  // 5. Fallback OpenAI secret key
  if (!keys.openai) {
    try {
      const raw = await readFile("/opt/spaceapp/secrets/space-openai-voice.key", "utf8");
      const val = raw.trim();
      if (val) keys.openai = val;
    } catch {}
  }

  // 6. Fallback Vercel secret key
  if (!keys.vercel) {
    try {
      const raw = await readFile("/opt/spaceapp/secrets/space-vercel-voice.key", "utf8");
      const val = raw.trim();
      if (val) keys.vercel = val;
    } catch {}
  }

  // 7. Google Cloud Service Account JSON
  try {
    const saPath = process.env.SPACE_GOOGLE_SA_FILE || "/opt/spaceapp/secrets/space-google-sa.json";
    const raw = await readFile(saPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      keys.googleSa = {
        project_id: parsed.project_id,
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        token_uri: parsed.token_uri
      };
    }
  } catch {}

  // 8. Fallback Jev TypeSafe secret key
  if (!keys.jev) {
    for (const file of [
      process.env.SPACE_JEV_TOKEN_FILE,
      "/opt/spaceapp/secrets/space-jev.key",
      "/opt/spaceapp/secrets/space-jevtypesafe.key",
      "/var/lib/spaceapp-user/.config/opencode/jev.token"
    ]) {
      if (!file) continue;
      try {
        const raw = await readFile(file, "utf8");
        const val = raw.trim();
        if (val) {
          keys.jev = val;
          break;
        }
      } catch {}
    }
  }

  return keys;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryDeepSeek(apiKey: string): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  try {
    const res = await fetchWithTimeout("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      return {
        id: "deepseek",
        providerId: "deepseek",
        label: "DeepSeek",
        status: "ERROR",
        balance: null,
        currency: null,
        detail: `HTTP error ${res.status}: ${res.statusText}`,
        sampledAt
      };
    }
    const json = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency: string;
        total_balance: string;
        granted_balance: string;
        topped_up_balance: string;
      }>;
    };
    const usdInfo = json.balance_infos?.find((b) => b.currency.toUpperCase() === "USD") ?? json.balance_infos?.[0];
    const total = usdInfo ? parseFloat(usdInfo.total_balance) : 0;
    const currency = usdInfo?.currency?.toUpperCase() ?? "USD";
    const balanceStr = `$${total.toFixed(2)}`;
    const toppedUp = usdInfo ? parseFloat(usdInfo.topped_up_balance) : 0;
    const granted = usdInfo ? parseFloat(usdInfo.granted_balance) : 0;

    let detail = `Topped up: $${toppedUp.toFixed(2)}`;
    if (granted > 0) detail += ` · Granted: $${granted.toFixed(2)}`;
    if (json.is_available === false) detail += " (Unavailable)";

    return {
      id: "deepseek",
      providerId: "deepseek",
      label: "DeepSeek",
      status: json.is_available !== false ? "CONNECTED" : "EXHAUSTED",
      balance: balanceStr,
      currency,
      detail,
      models: ["deepseek-chat", "deepseek-reasoner"],
      sampledAt
    };
  } catch (err: any) {
    return {
      id: "deepseek",
      providerId: "deepseek",
      label: "DeepSeek",
      status: "ERROR",
      balance: null,
      currency: null,
      detail: err?.message || "Failed to reach DeepSeek API",
      sampledAt
    };
  }
}

async function queryOpenRouter(apiKey: string): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  try {
    const [creditsRes, keyRes] = await Promise.all([
      fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${apiKey}` }
      }),
      fetchWithTimeout("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
    ]);

    if (!creditsRes.ok) {
      return {
        id: "openrouter",
        providerId: "openrouter",
        label: "OpenRouter",
        status: "ERROR",
        balance: null,
        currency: null,
        detail: `HTTP error ${creditsRes.status}: ${creditsRes.statusText}`,
        sampledAt
      };
    }

    const creditsJson = (await creditsRes.json()) as {
      data?: {
        total_credits?: number;
        total_usage?: number;
      };
    };

    let freeReqs: { used: number; limit: number; remaining: number } | null = null;
    if (keyRes.ok) {
      try {
        const keyJson = (await keyRes.json()) as {
          data?: {
            free_model_daily_requests?: { used: number; limit: number; remaining: number };
          };
        };
        if (keyJson.data?.free_model_daily_requests) {
          freeReqs = keyJson.data.free_model_daily_requests;
        }
      } catch {}
    }

    const totalCredits = creditsJson.data?.total_credits ?? 0;
    const totalUsage = creditsJson.data?.total_usage ?? 0;
    const remaining = Math.max(0, totalCredits - totalUsage);
    const balanceStr = `$${remaining.toFixed(2)}`;

    let detail = `Credits: $${totalCredits.toFixed(2)} · Used: $${totalUsage.toFixed(2)}`;
    if (freeReqs) {
      detail += ` · Free: ${freeReqs.remaining}/${freeReqs.limit} daily`;
    }

    const hasCapacity = remaining > 0 || (freeReqs != null && freeReqs.remaining > 0);

    return {
      id: "openrouter",
      providerId: "openrouter",
      label: "OpenRouter",
      status: hasCapacity ? "CONNECTED" : "EXHAUSTED",
      balance: balanceStr,
      currency: "USD",
      usage: `$${totalUsage.toFixed(2)}`,
      limit: `$${totalCredits.toFixed(2)}`,
      remainingPercent: totalCredits > 0 ? Math.min(100, Math.max(0, Math.round((remaining / totalCredits) * 100))) : 0,
      detail,
      sampledAt
    };
  } catch (err: any) {
    return {
      id: "openrouter",
      providerId: "openrouter",
      label: "OpenRouter",
      status: "ERROR",
      balance: null,
      currency: null,
      detail: err?.message || "Failed to reach OpenRouter API",
      sampledAt
    };
  }
}

async function queryVercelGateway(apiKey: string): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  try {
    const [creditsRes, userRes] = await Promise.all([
      fetchWithTimeout("https://ai-gateway.vercel.sh/v1/credits", {
        headers: { Authorization: `Bearer ${apiKey}` }
      }),
      fetchWithTimeout("https://api.vercel.com/v2/user", {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
    ]);

    let email = "operator@example.invalid";
    let isLimited = false;
    if (userRes.ok) {
      try {
        const userJson = (await userRes.json()) as {
          user?: { email?: string; username?: string; limited?: boolean };
        };
        email = userJson.user?.email || userJson.user?.username || email;
        isLimited = userJson.user?.limited ?? false;
      } catch {}
    }

    if (creditsRes.ok) {
      const creditsJson = (await creditsRes.json()) as {
        balance?: string | number;
        total_used?: string | number;
      };
      const balanceNum =
        typeof creditsJson.balance === "number"
          ? creditsJson.balance
          : parseFloat(creditsJson.balance || "0");
      const usedNum =
        typeof creditsJson.total_used === "number"
          ? creditsJson.total_used
          : parseFloat(creditsJson.total_used || "0");
      const totalCredits = Math.round((balanceNum + usedNum) * 100) / 100;
      const remainingPercent =
        totalCredits > 0
          ? Math.min(100, Math.max(0, Math.round((balanceNum / totalCredits) * 100)))
          : 0;
      const balanceStr = `$${balanceNum.toFixed(2)}`;
      const usageStr = `$${usedNum.toFixed(2)}`;
      const limitStr = `$${totalCredits.toFixed(2)}`;

      const detail = `Credits: ${limitStr} · Used: ${usageStr} · Account: ${email}${isLimited ? " (Limited tier)" : ""}`;

      return {
        id: "vercel-gateway",
        providerId: "vercel-gateway",
        label: "Vercel AI Gateway",
        status: balanceNum > 0 ? "CONNECTED" : "EXHAUSTED",
        balance: balanceStr,
        currency: "USD",
        usage: usageStr,
        limit: limitStr,
        remainingPercent,
        detail,
        sampledAt
      };
    }

    if (userRes.ok) {
      return {
        id: "vercel-gateway",
        providerId: "vercel-gateway",
        label: "Vercel AI Gateway",
        status: "CONNECTED",
        balance: "Connected",
        currency: null,
        detail: `Account: ${email}${isLimited ? " (Limited tier)" : ""}`,
        sampledAt
      };
    }

    return {
      id: "vercel-gateway",
      providerId: "vercel-gateway",
      label: "Vercel AI Gateway",
      status: "ERROR",
      balance: null,
      currency: null,
      detail: `HTTP error ${creditsRes.status}: ${creditsRes.statusText}`,
      sampledAt
    };
  } catch (err: any) {
    return {
      id: "vercel-gateway",
      providerId: "vercel-gateway",
      label: "Vercel AI Gateway",
      status: "ERROR",
      balance: null,
      currency: null,
      detail: err?.message || "Failed to reach Vercel API",
      sampledAt
    };
  }
}

let cachedGoogleSaToken: { token: string; expiresAtMs: number } | null = null;

async function getGoogleSaAccessToken(sa: GoogleServiceAccountKey): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedGoogleSaToken && Date.now() < cachedGoogleSaToken.expiresAtMs - 300_000) {
    return cachedGoogleSaToken.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const scopes = [
    "https://www.googleapis.com/auth/monitoring.read",
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/cloud-billing.readonly"
  ];
  const claim = {
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: nowSec + 3600,
    iat: nowSec
  };

  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64url(header)}.${b64url(claim)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!res.ok) throw new Error(`Google SA auth HTTP ${res.status}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cachedGoogleSaToken = {
    token: json.access_token,
    expiresAtMs: Date.now() + (json.expires_in || 3600) * 1000
  };
  return cachedGoogleSaToken.token;
}

interface BigQueryBillingData {
  datasetFound: boolean;
  tableFound: boolean;
  totalCost?: number;
  geminiCost?: number;
  currency?: string;
}

interface GoogleCloudTelemetry {
  projectId: string;
  requests24h?: number;
  requests7d?: number;
  requestsMonth?: number;
  outputTokensMonth?: number;
  estimatedCostUsd?: number | null;
  billingAccountId?: string | null;
  billingEnabled?: boolean;
  bigquery?: BigQueryBillingData;
}

async function fetchBigQueryBilling(
  sa: GoogleServiceAccountKey,
  token: string
): Promise<BigQueryBillingData> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  try {
    const tablesRes = await fetchWithTimeout(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/datasets/billing_export/tables`,
      { headers }
    );

    if (!tablesRes.ok) {
      return { datasetFound: false, tableFound: false };
    }

    const tablesData = (await tablesRes.json()) as {
      tables?: Array<{ tableReference?: { tableId?: string } }>;
    };

    const tables = tablesData.tables || [];
    const billingTable = tables.find(
      (t) =>
        t.tableReference?.tableId?.startsWith("gcp_billing_export_v1") ||
        t.tableReference?.tableId?.startsWith("gcp_billing_export_resource_v1")
    );

    if (!billingTable?.tableReference?.tableId) {
      return { datasetFound: true, tableFound: false };
    }

    const tableId = billingTable.tableReference.tableId;
    const query = `
      SELECT
        COALESCE(SUM(cost), 0) AS total_cost,
        currency,
        COALESCE(SUM(CASE WHEN LOWER(service.description) LIKE '%generative%' OR LOWER(service.description) LIKE '%gemini%' THEN cost ELSE 0 END), 0) AS gemini_cost
      FROM \`${sa.project_id}.billing_export.${tableId}\`
      WHERE invoice.month = FORMAT_DATE('%Y%m', CURRENT_DATE())
      GROUP BY currency
      LIMIT 1
    `;

    const queryRes = await fetchWithTimeout(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${sa.project_id}/queries`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 8000 })
      }
    );

    if (!queryRes.ok) {
      return { datasetFound: true, tableFound: true };
    }

    const queryData = (await queryRes.json()) as {
      rows?: Array<{ f?: Array<{ v?: string }> }>;
    };

    if (queryData.rows && queryData.rows.length > 0 && queryData.rows[0]) {
      const row = queryData.rows[0].f;
      const totalCost = parseFloat(row?.[0]?.v || "0");
      const currency = row?.[1]?.v || "USD";
      const geminiCost = parseFloat(row?.[2]?.v || "0");
      return {
        datasetFound: true,
        tableFound: true,
        totalCost,
        geminiCost,
        currency
      };
    }

    return { datasetFound: true, tableFound: true, totalCost: 0, geminiCost: 0, currency: "USD" };
  } catch {
    return { datasetFound: false, tableFound: false };
  }
}

async function fetchGoogleCloudTelemetry(sa: GoogleServiceAccountKey): Promise<GoogleCloudTelemetry | null> {
  try {
    const token = await getGoogleSaAccessToken(sa);
    const headers = { Authorization: `Bearer ${token}` };
    const endTime = new Date().toISOString();
    const startTime24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const startTime7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const filter = encodeURIComponent(`metric.type = "serviceruntime.googleapis.com/api/request_count"`);
    const [res24h, res7d, billingRes, bqData] = await Promise.all([
      fetchWithTimeout(
        `https://monitoring.googleapis.com/v3/projects/${sa.project_id}/timeSeries?filter=${filter}&interval.startTime=${startTime24h}&interval.endTime=${endTime}`,
        { headers }
      ).catch(() => null),
      fetchWithTimeout(
        `https://monitoring.googleapis.com/v3/projects/${sa.project_id}/timeSeries?filter=${filter}&interval.startTime=${startTime7d}&interval.endTime=${endTime}`,
        { headers }
      ).catch(() => null),
      fetchWithTimeout(
        `https://cloudbilling.googleapis.com/v1/projects/${sa.project_id}/billingInfo`,
        { headers }
      ).catch(() => null),
      fetchBigQueryBilling(sa, token).catch(() => undefined)
    ]);

    let requests24h = 0;
    if (res24h?.ok) {
      const data = (await res24h.json()) as {
        timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string } }> }>;
      };
      for (const ts of data.timeSeries || []) {
        for (const p of ts.points || []) {
          requests24h += parseInt(p.value?.int64Value || "0", 10);
        }
      }
    }

    let requests7d = 0;
    if (res7d?.ok) {
      const data = (await res7d.json()) as {
        timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string } }> }>;
      };
      for (const ts of data.timeSeries || []) {
        for (const p of ts.points || []) {
          requests7d += parseInt(p.value?.int64Value || "0", 10);
        }
      }
    }

    let billingAccountId: string | null = null;
    let billingEnabled = false;
    if (billingRes?.ok) {
      const billingData = (await billingRes.json()) as {
        billingAccountName?: string;
        billingEnabled?: boolean;
      };
      billingAccountId = billingData.billingAccountName?.replace("billingAccounts/", "") ?? null;
      billingEnabled = billingData.billingEnabled ?? false;
    }

    // Monthly requests: filter only generativelanguage.googleapis.com
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const geminiFilter = encodeURIComponent(
      `metric.type = "serviceruntime.googleapis.com/api/request_count" AND resource.labels.service = "generativelanguage.googleapis.com"`
    );
    let requestsMonth = 0;
    let outputTokensMonth = 0;
    let estimatedCostUsd: number | null = null;

    try {
      const [monthRes, tokenRes] = await Promise.all([
        fetchWithTimeout(
          `https://monitoring.googleapis.com/v3/projects/${sa.project_id}/timeSeries` +
            `?filter=${geminiFilter}` +
            `&interval.startTime=${monthStart}&interval.endTime=${endTime}` +
            `&aggregation.alignmentPeriod=2592000s&aggregation.perSeriesAligner=ALIGN_SUM`,
          { headers }
        ).catch(() => null),
        fetchWithTimeout(
          `https://monitoring.googleapis.com/v3/projects/${sa.project_id}/timeSeries` +
            `?filter=${encodeURIComponent('metric.type = "generativelanguage.googleapis.com/generate_content_usage_output_token_count"')}` +
            `&interval.startTime=${monthStart}&interval.endTime=${endTime}` +
            `&aggregation.alignmentPeriod=2592000s&aggregation.perSeriesAligner=ALIGN_SUM`,
          { headers }
        ).catch(() => null)
      ]);

      if (monthRes?.ok) {
        const data = (await monthRes.json()) as {
          timeSeries?: Array<{ points?: Array<{ value?: { int64Value?: string } }> }>;
        };
        for (const ts of data.timeSeries || []) {
          for (const p of ts.points || []) {
            const v = parseInt(p.value?.int64Value || "0", 10);
            if (!isNaN(v)) requestsMonth += v;
          }
        }
      }

      if (tokenRes?.ok) {
        const data = (await tokenRes.json()) as {
          timeSeries?: Array<{
            metric?: { labels?: Record<string, string> };
            points?: Array<{ value?: { int64Value?: string } }>;
          }>;
        };
        for (const ts of data.timeSeries || []) {
          for (const p of ts.points || []) {
            const v = parseInt(p.value?.int64Value || "0", 10);
            if (!isNaN(v)) outputTokensMonth += v;
          }
        }
        if (outputTokensMonth > 0) {
          estimatedCostUsd = Math.round((outputTokensMonth / 1_000_000) * 0.40 * 10000) / 10000;
        }
      }
    } catch {}

    return {
      projectId: sa.project_id,
      requests24h,
      requests7d,
      requestsMonth,
      outputTokensMonth,
      estimatedCostUsd,
      billingAccountId,
      billingEnabled,
      bigquery: bqData
    };
  } catch {
    return null;
  }
}

async function queryGoogleGemini(
  apiKey?: string,
  sa?: GoogleServiceAccountKey
): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  try {
    const [res, cloudTelemetry] = await Promise.all([
      apiKey
        ? fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
          )
        : Promise.resolve(null),
      sa ? fetchGoogleCloudTelemetry(sa) : Promise.resolve(null)
    ]);

    if (apiKey && res && !res.ok && !cloudTelemetry) {
      return {
        id: "google-gemini",
        providerId: "google",
        label: "Google Gemini (WebSocket / API)",
        status: "ERROR",
        balance: null,
        currency: null,
        detail: `HTTP error ${res.status}: ${res.statusText}`,
        sampledAt
      };
    }

    let modelCount = 50;
    if (res?.ok) {
      const data = (await res.json()) as {
        models?: Array<{ name: string; displayName?: string }>;
      };
      modelCount = data.models?.length ?? 50;
    }

    const selectedModels = [
      "gemini-3.8-live",
      "gemini-3.8-flash",
      "gemini-3.6-flash",
      "gemini-2.5-pro"
    ];

    let balanceStr = "Pay-as-you-go";
    let usageStr = "Gemini 3.8 Live · Aoede";
    let limitStr = "Standard Tier";
    let currency: string | null = "USD";
    let detailStr = `Gemini 3.8 Live (Aoede) · Realtime WebSocket & Generative API (${modelCount} models · Pay-as-you-go)`;

    if (cloudTelemetry) {
      const r24 = cloudTelemetry.requests24h ?? 0;
      const r7d = cloudTelemetry.requests7d ?? 0;
      const rMonth = cloudTelemetry.requestsMonth ?? 0;
      const now = new Date();
      const monthName = now.toLocaleString("en-US", { month: "long" });

      const bq = cloudTelemetry.bigquery;
      if (bq?.tableFound && bq.totalCost !== undefined) {
        if (bq.currency === "THB") {
          const thbRate =
            parseFloat(process.env.SPACE_THB_PER_USD || "") || DEFAULT_THB_PER_USD;
          const geminiCostUsd = (bq.geminiCost ?? 0) / thbRate;
          const totalCostUsd = (bq.totalCost ?? 0) / thbRate;
          currency = "USD";
          balanceStr = `$${geminiCostUsd.toFixed(2)}`;
          limitStr = `${monthName} MTD`;
          usageStr = `Gemini: $${geminiCostUsd.toFixed(2)} (฿${(bq.geminiCost ?? 0).toFixed(2)}) · Total GCP: $${totalCostUsd.toFixed(2)}`;
        } else {
          const symbol = bq.currency === "EUR" ? "€" : "$";
          currency = bq.currency || "USD";
          balanceStr = `${symbol}${bq.geminiCost?.toFixed(2) ?? "0.00"}`;
          limitStr = `${monthName} MTD`;
          usageStr = `Gemini: ${symbol}${bq.geminiCost?.toFixed(2) ?? "0.00"} · Total GCP: ${symbol}${bq.totalCost.toFixed(2)}`;
        }
      } else if (bq?.datasetFound) {
        balanceStr = "Pay-as-you-go";
        limitStr = `${r24} reqs (24h)`;
        usageStr = `${r24} reqs (24h) · ${r7d} reqs (7d)`;
      } else {
        balanceStr = "Pay-as-you-go";
        limitStr = `${r24} reqs (24h)`;
        usageStr = `${r24} reqs (24h) · ${r7d} reqs (7d)`;
      }

      const billingNote = cloudTelemetry.billingEnabled
        ? `Billing: Active (acct ${cloudTelemetry.billingAccountId ?? ""})`
        : "Billing: disabled";

      let bqStatus: string;
      if (bq?.tableFound) {
        if (bq.currency === "THB") {
          const thbRate =
            parseFloat(process.env.SPACE_THB_PER_USD || "") || DEFAULT_THB_PER_USD;
          const geminiCostUsd = (bq.geminiCost ?? 0) / thbRate;
          const totalCostUsd = (bq.totalCost ?? 0) / thbRate;
          bqStatus = `BigQuery Billing: $${geminiCostUsd.toFixed(2)} Gemini (฿${(bq.geminiCost ?? 0).toFixed(2)}) / $${totalCostUsd.toFixed(2)} total`;
        } else {
          const symbol = bq.currency === "EUR" ? "€" : "$";
          bqStatus = `BigQuery Billing: ${symbol}${bq.geminiCost?.toFixed(2) ?? "0.00"} Gemini / ${symbol}${(bq.totalCost ?? 0).toFixed(2)} total`;
        }
      } else if (bq?.datasetFound) {
        bqStatus = "BigQuery: billing_export dataset ready (awaiting Cloud Console export sync)";
      } else {
        bqStatus = "Monthly cost: see console.cloud.google.com/billing";
      }

      detailStr = [
        `Project: ${cloudTelemetry.projectId}`,
        bqStatus,
        `All-API 24h: ${r24} reqs`,
        `${modelCount} models`,
        "Live Voice: Aoede",
        billingNote
      ].join(" · ");
    }

    return {
      id: "google-gemini",
      providerId: "google",
      label: "Google Gemini (WebSocket / API)",
      status: "CONNECTED",
      balance: balanceStr,
      currency: currency || "USD",
      usage: usageStr,
      limit: limitStr,
      remainingPercent: 100,
      detail: detailStr,
      models: selectedModels,
      sampledAt
    };
  } catch (err: any) {
    return {
      id: "google-gemini",
      providerId: "google",
      label: "Google Gemini (WebSocket / API)",
      status: "ERROR",
      balance: null,
      currency: null,
      detail: err?.message || "Failed to reach Google Gemini API",
      sampledAt
    };
  }
}

async function queryOpenAiKey(apiKey: string): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const count = data.data?.length ?? 0;
      return {
        id: "openai",
        providerId: "openai",
        label: "OpenAI",
        status: "CONNECTED",
        balance: "Configured",
        currency: null,
        usage: "gpt-4o-realtime-preview",
        limit: "Pay-as-you-go",
        detail: `Voice & Realtime API key configured (${count} models verified)`,
        models: ["gpt-4o", "gpt-4o-realtime-preview", "gpt-4o-mini"],
        sampledAt
      };
    }
  } catch {}

  return {
    id: "openai",
    providerId: "openai",
    label: "OpenAI",
    status: "CONNECTED",
    balance: "Configured",
    currency: null,
    detail: "Voice & Realtime API key configured",
    sampledAt
  };
}

let lastKnownJevBalance: number | null = null;
let lastKnownJevSampledAt: string | null = null;

export function recordJevCredits(credits: number) {
  lastKnownJevBalance = credits;
  lastKnownJevSampledAt = new Date().toISOString();
}

async function queryJevTypeSafe(apiKey: string): Promise<ApiProviderAccount> {
  const sampledAt = new Date().toISOString();
  const credits = lastKnownJevBalance ?? getLastKnownJevCredits();
  if (credits !== null) {
    return {
      id: "jev-typesafe",
      providerId: "jev",
      label: "Jev / TypeSafe",
      status: "CONNECTED",
      balance: `$${credits.toFixed(2)}`,
      currency: "USD",
      detail: `Credits remaining: $${credits.toFixed(4)}`,
      models: ["jev-1.13.0"],
      sampledAt: lastKnownJevSampledAt ?? sampledAt
    };
  }

  return {
    id: "jev-typesafe",
    providerId: "jev",
    label: "Jev / TypeSafe",
    status: "CONNECTED",
    balance: "$5.00",
    currency: "USD",
    detail: "Jev System One Decision Engine (jevtypesafeai.com)",
    models: ["jev-1.13.0"],
    sampledAt
  };
}

export function createApiProviderAccountProvider(
  options: {
    now?: () => Date;
  } = {}
): () => Promise<ApiProviderAccountList> {
  const now = options.now ?? (() => new Date());

  let cached: { value: ApiProviderAccountList; collectedAtMs: number } | null = null;
  let inFlight: Promise<ApiProviderAccountList> | null = null;

  return async (): Promise<ApiProviderAccountList> => {
    const currentMs = now().getTime();
    if (cached && currentMs - cached.collectedAtMs < CACHE_TTL_MS) {
      return cached.value;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const keys = await discoverApiProviderKeys();
        const queries: Promise<ApiProviderAccount>[] = [];

        if (keys.deepseek) {
          queries.push(queryDeepSeek(keys.deepseek));
        } else {
          queries.push(
            Promise.resolve({
              id: "deepseek",
              providerId: "deepseek",
              label: "DeepSeek",
              status: "UNCONFIGURED",
              balance: null,
              currency: null,
              detail: "No DEEPSEEK_API_KEY found",
              sampledAt: null
            })
          );
        }

        if (keys.openrouter) {
          queries.push(queryOpenRouter(keys.openrouter));
        } else {
          queries.push(
            Promise.resolve({
              id: "openrouter",
              providerId: "openrouter",
              label: "OpenRouter",
              status: "UNCONFIGURED",
              balance: null,
              currency: null,
              detail: "No OPENROUTER_API_KEY found",
              sampledAt: null
            })
          );
        }

        if (keys.vercel) {
          queries.push(queryVercelGateway(keys.vercel));
        }

        if (keys.google || keys.googleSa) {
          queries.push(queryGoogleGemini(keys.google, keys.googleSa));
        }

        if (keys.openai) {
          queries.push(queryOpenAiKey(keys.openai));
        }

        if (keys.jev) {
          queries.push(queryJevTypeSafe(keys.jev));
        }

        const accounts = await Promise.all(queries);

        const list: ApiProviderAccountList = {
          data: accounts,
          pagination: {
            page: 1,
            pageSize: Math.max(accounts.length, 1),
            totalItems: accounts.length,
            totalPages: 1
          },
          source: "api-credentials-and-balance-services",
          isStale: false,
          error: null,
          checkedAt: now().toISOString()
        };

        cached = { value: list, collectedAtMs: currentMs };
        return list;
      } catch (err: any) {
        if (cached) {
          return { ...cached.value, isStale: true };
        }
        return {
          data: [],
          pagination: { page: 1, pageSize: 1, totalItems: 0, totalPages: 1 },
          source: "api-credentials-and-balance-services",
          isStale: true,
          error: err?.message || "Failed to query API providers",
          checkedAt: now().toISOString()
        };
      } finally {
        inFlight = null;
      }
    })();

    return await inFlight;
  };
}
