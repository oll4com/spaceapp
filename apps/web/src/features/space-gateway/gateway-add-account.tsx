import { useCallback, useEffect, useState } from "react";
import { GATEWAY_KEYLESS_KEY, type GatewayAccount } from "@space/contracts";
import { writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { Check, Copy } from "../ui-theme/app-icons.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";

/** Sign-in flows that add accounts to Space Gateway: ChatGPT (Codex), Claude, Antigravity profiles and OpenAI API keys. */
/** Copies a sign-in link or code; the icon turns into a check for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = window.setTimeout(() => setState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);
  const title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <button type="button" className={`space-gateway-copy${state === "copied" ? " copied" : ""}`} aria-label={label} title={title}
      onClick={() => { writeClipboardText(text).then(() => setState("copied"), () => setState("failed")); }}>
      {state === "copied" ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
    </button>
  );
}

type SignInMethod = "device" | "browser" | "import";
/** A finished sign-in: the account's label and, when the gateway named it, its id. */
type OnConnected = (label: string, accountId?: string) => void;

function AddCodexAccount({ client, onConnected, title = "Add a ChatGPT (Codex) account" }: { client: SpaceGatewayClient; onConnected: OnConnected; title?: string }) {
  const [method, setMethod] = useState<SignInMethod>("device");
  const [device, setDevice] = useState<{ flowId: string; verificationUrl: string; userCode: string; intervalSeconds: number } | null>(null);
  const [browser, setBrowser] = useState<{ flowId: string; authorizationUrl: string } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [authJson, setAuthJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!device) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void client.pollDeviceSignIn(device.flowId).then((result) => {
        if (cancelled) return;
        if (result.status === "CONNECTED") {
          setDevice(null);
          setMessage({ tone: "ok", text: `Connected ${result.account?.label ?? "the account"}.` });
          onConnected(result.account?.label ?? "", result.account?.id);
        } else if (result.status === "EXPIRED") {
          setDevice(null);
          setMessage({ tone: "error", text: "The code expired. Start again." });
        }
      }).catch((reason) => { if (!cancelled) { setDevice(null); setMessage({ tone: "error", text: errorText(reason, "Sign-in failed.") }); } });
    }, Math.max(3, device.intervalSeconds) * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, device, onConnected]);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); } catch (reason) { setMessage({ tone: "error", text: errorText(reason, failure) }); } finally { setBusy(false); }
  }

  return (
    <section className="space-gateway-add" aria-label={title}>
      <h3>{title}</h3>
      <div className="filter-tabs" role="tablist" aria-label="Sign-in method">
        {([["device", "Sign in with a code"], ["browser", "Sign in with the browser"], ["import", "Import auth.json"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={method === id} className={`filter-tab${method === id ? " active" : ""}`}
            onClick={() => { setMethod(id); setMessage(null); }}>{label}</button>
        ))}
      </div>
      {method === "device" ? (device ? (
        <div className="space-gateway-signin" role="status">
          <span>Open <a href={device.verificationUrl} target="_blank" rel="noreferrer">{device.verificationUrl}</a>
            <CopyButton text={device.verificationUrl} label="Copy link" />, sign in with the ChatGPT account and enter this code:</span>
          <span className="space-gateway-copy-row">
            <code className="space-gateway-user-code">{device.userCode}</code>
            <CopyButton text={device.userCode} label="Copy code" />
          </span>
          <span>Waiting for sign-in…</span>
          <button type="button" className="space-gateway-button" onClick={() => setDevice(null)}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="space-gateway-button primary" disabled={busy}
          onClick={() => void run(async () => setDevice(await client.startDeviceSignIn()), "Could not start sign-in.")}>Get a sign-in code</button>
      )) : null}
      {method === "browser" ? (browser ? (
        <form className="space-gateway-signin" onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await client.completeBrowserSignIn(browser.flowId, callbackUrl.trim());
            setBrowser(null); setCallbackUrl("");
            setMessage({ tone: "ok", text: `Connected ${result.account.label}.` });
            onConnected(result.account.label, result.account.id);
          }, "Could not finish sign-in.");
        }}>
          <span>1. <a href={browser.authorizationUrl} target="_blank" rel="noreferrer">Open the ChatGPT sign-in page</a>
            <CopyButton text={browser.authorizationUrl} label="Copy link" /> and sign in.</span>
          <span>2. The browser then opens a localhost page that does not load. Copy its full address and paste it here.</span>
          <label className="space-gateway-field">Address after sign-in
            <input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=…" />
          </label>
          <button type="submit" className="space-gateway-button primary" disabled={busy || !callbackUrl.trim()}>Finish sign-in</button>
        </form>
      ) : (
        <button type="button" className="space-gateway-button primary" disabled={busy}
          onClick={() => void run(async () => setBrowser(await client.startBrowserSignIn()), "Could not start sign-in.")}>Start browser sign-in</button>
      )) : null}
      {method === "import" ? (
        <form className="space-gateway-signin" onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await client.importAuthJson(authJson);
            setAuthJson("");
            setMessage({ tone: "ok", text: `Imported ${result.account.label}.` });
            onConnected(result.account.label, result.account.id);
          }, "Could not import the file.");
        }}>
          <label className="space-gateway-field">Contents of a Codex auth.json
            <textarea rows={4} value={authJson} spellCheck={false} onChange={(event) => setAuthJson(event.target.value)} placeholder='{"tokens": {…}}' />
            <span>Space Gateway takes over this sign-in. Sign the Codex CLI out of this account afterwards: two programs refreshing the same sign-in log each other out.</span>
          </label>
          <button type="submit" className="space-gateway-button primary" disabled={busy || authJson.trim().length < 2}>Import</button>
        </form>
      ) : null}
      {message ? <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </section>
  );
}

function AddClaudeAccount({ client, onConnected, initialMethod = "sign-in", title = "Add a Claude account" }: {
  client: SpaceGatewayClient; onConnected: OnConnected; initialMethod?: "sign-in" | "api-key"; title?: string;
}) {
  const [method, setMethod] = useState<"sign-in" | "api-key">(initialMethod);
  const [flow, setFlow] = useState<{ flowId: string; authorizationUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); } catch (reason) { setMessage({ tone: "error", text: errorText(reason, failure) }); } finally { setBusy(false); }
  }

  const methodTabs = (
    <div className="filter-tabs" role="tablist" aria-label="How to add the Claude account">
      {([["sign-in", "Sign in"], ["api-key", "API key"]] as const).map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={method === id} className={`filter-tab${method === id ? " active" : ""}`}
          onClick={() => setMethod(id)}>{label}</button>
      ))}
    </div>
  );
  if (method === "api-key") {
    return (
      <>
        {methodTabs}
        <AddOpenAiApiKey client={client} onConnected={onConnected} provider="CLAUDE" />
      </>
    );
  }
  return (
    <section className="space-gateway-add" aria-label={title}>
      {methodTabs}
      <h3>{title}</h3>
      {flow ? (
        <form className="space-gateway-signin" onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await client.completeClaudeSignIn(flow.flowId, code.trim());
            setFlow(null); setCode("");
            setMessage({ tone: "ok", text: `Connected ${result.account.label}.` });
            onConnected(result.account.label, result.account.id);
          }, "Could not finish sign-in.");
        }}>
          <span>1. <a href={flow.authorizationUrl} target="_blank" rel="noreferrer">Open the Claude sign-in page</a>
            <CopyButton text={flow.authorizationUrl} label="Copy link" /> and sign in with the Claude account.</span>
          <span>2. Copy the code shown after you authorize and paste it here.</span>
          <label className="space-gateway-field">Authorization code
            <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="code#state" spellCheck={false} autoComplete="off" />
            <span>This is a separate sign-in for Space Gateway. Claude profiles on this server keep their own sign-in.</span>
          </label>
          <div className="space-gateway-toolbar">
            <button type="submit" className="space-gateway-button primary" disabled={busy || !code.trim()}>Finish sign-in</button>
            <button type="button" className="space-gateway-button" disabled={busy} onClick={() => { setFlow(null); setCode(""); }}>Cancel</button>
          </div>
        </form>
      ) : (
        <button type="button" className="space-gateway-button primary" disabled={busy}
          onClick={() => void run(async () => setFlow(await client.startClaudeSignIn()), "Could not start sign-in.")}>Start Claude sign-in</button>
      )}
      {message ? <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </section>
  );
}

function AddAntigravityAccount({ client, onConnected, title = "Add an Antigravity account", reconnect = false }: {
  client: SpaceGatewayClient; onConnected: OnConnected; title?: string;
  /** Profiles already in Space Gateway can pass their current sign-in again. */
  reconnect?: boolean;
}) {
  const [profiles, setProfiles] = useState<Array<{ profileId: string; email: string | null; inGateway: boolean }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const load = useCallback(async () => {
    try { setProfiles((await client.antigravityProfiles()).data); }
    catch (reason) { setMessage({ tone: "error", text: errorText(reason, "Could not list Antigravity profiles.") }); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  async function add(profileId: string) {
    setBusy(profileId);
    setMessage(null);
    try {
      const result = await client.importAntigravityProfile(profileId);
      setMessage({ tone: "ok", text: `Connected ${result.account.label}.` });
      onConnected(result.account.label, result.account.id);
      await load();
    } catch (reason) {
      setMessage({ tone: "error", text: errorText(reason, "Could not add the account.") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-gateway-add" aria-label={title}>
      <h3>{title}</h3>
      <p className="space-gateway-note">Antigravity accounts come from the Antigravity profiles signed in on this server. The profile keeps working: Google sign-ins can be shared.</p>
      {profiles === null ? <p className="space-gateway-empty">Loading profiles…</p>
        : profiles.length === 0 ? <p className="space-gateway-empty">No Antigravity profile is signed in. Sign one in from CLI accounts first.</p>
          : <ul className="space-gateway-profile-list">
            {profiles.map((profile) => (
              <li key={profile.profileId}>
                <span>{profile.email ?? profile.profileId}</span>
                <span className="space-gateway-chip">{profile.profileId}</span>
                {profile.inGateway && !reconnect
                  ? <span className="space-gateway-chip tone-ok">In Space Gateway</span>
                  : <button type="button" className="space-gateway-button" disabled={busy !== null}
                    onClick={() => void add(profile.profileId)}>{busy === profile.profileId ? "Adding…" : reconnect ? "Use this profile's sign-in" : "Add to Space Gateway"}</button>}
              </li>
            ))}
          </ul>}
      {message ? <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </section>
  );
}

const apiKeyProviders = {
  OPENAI_API: { title: "Add an OpenAI API key", placeholder: "sk-…",
    note: "OpenAI API keys serve embeddings (Space memory) and the OpenAI key pool. The key is checked with a free request and stored encrypted; it is never shown again." },
  OPENROUTER: { title: "Add an OpenRouter API key", placeholder: "sk-or-…",
    note: "OpenRouter keys form a key pool at /pools/openrouter/v1: each request uses one key and moves to another when a key is out of credit, rate limited or rejected. The key is checked with a free request and stored encrypted." },
  DEEPSEEK: { title: "Add a DeepSeek API key", placeholder: "sk-…",
    note: "DeepSeek keys form a key pool at /pools/deepseek/v1, rotated per request with failover. The key is checked with a free balance request and stored encrypted." },
  GROQ: { title: "Add a Groq API key", placeholder: "gsk_…",
    note: "Free tier. Groq keys form a key pool at /pools/groq/v1 (and groq: models of /pools/space/v1): a rate-limited key cools down for as long as Groq says and the request moves to another key. The key is checked with a free model list request and stored encrypted." },
  NVIDIA: { title: "Add an NVIDIA API key", placeholder: "nvapi-…",
    note: "Free tier from build.nvidia.com. NVIDIA keys form a key pool at /pools/nvidia/v1 (and nvidia: models of /pools/space/v1); free answers can take minutes, so stream them. The key is checked with a free request and stored encrypted." },
  CLOUDFLARE_AI: { title: "Add a Cloudflare Workers AI token", placeholder: "<32-hex account ID>:<API token>",
    note: "Free daily allowance (10,000 neurons, reset at 00:00 UTC). Enter the account ID and a Workers AI API token joined by a colon. The tokens form a key pool at /pools/cloudflare/v1 (and cloudflare: models of /pools/space/v1). The token is checked against the account's model catalog and stored encrypted." },
  ADAPTION: { title: "Add an Adaption Labs API key", placeholder: "pt_live_…",
    note: "Granted credits (no card on file, so it never bills). Adaption Labs keys form a key pool at /pools/adaption/v1 (and adaption: models of /pools/space/v1); a key out of credits moves the request to another key. The key is checked with a free model list request and stored encrypted." },
  AMD_TOKEN_LAB: { title: "Add an AMD Token Lab API key", placeholder: "tl-…",
    note: "Granted points (no card on file, so it never bills). AMD Token Lab keys form a key pool at /pools/amd/v1 (and amd: models of /pools/space/v1); a key out of points moves the request to another key. The key is checked with a free model list request and stored encrypted." },
  INCEPTION: { title: "Add an Inception Labs API key", placeholder: "sk_…",
    note: "Granted free tokens. Inception Labs keys form a key pool at /pools/inception/v1 (and inception: models of /pools/space/v1, Mercury); a key out of tokens moves the request to another key. The key is checked with a free request and stored encrypted." },
  JINA: { title: "Add a Jina AI API key", placeholder: "jina_…",
    note: "Granted free tokens. Jina AI keys form a key pool for embeddings and rerank at /pools/jina/v1/embeddings and /pools/jina/v1/rerank (no chat). The key is checked with a free request and stored encrypted." },
  MIXEDBREAD: { title: "Add a Mixedbread API key", placeholder: "Mixedbread API key",
    note: "Granted credits. Mixedbread keys form a key pool for embeddings at /pools/mixedbread/v1/embeddings (no chat). The key is checked with a free request and stored encrypted." },
  AZURE_OPENAI: { title: "Add an Azure OpenAI resource", placeholder: "<resource>:<key>, or the Endpoint and Key",
    note: "A $200 Azure credit until 5 Feb 2027 with a card behind it: the pool stops after that date. Paste <resource>:<key> or the Endpoint URL and Key; its keys form a key pool at /pools/azure/v1 (and azure: models of /pools/space/v1), where the model is the deployment name. The key is checked with a free request and stored encrypted." },
  ZAI: { title: "Add a Z.AI API key", placeholder: "Z.AI API key",
    note: "Free GLM Flash models on an account with no card: its keys form a key pool at /pools/zai/v1 (and zai: models of /pools/space/v1) that sends and lists only the free models. The key is checked with a free request and stored encrypted." },
  SILICONFLOW: { title: "Add a SiliconFlow API key", placeholder: "sk-…",
    note: "SiliconFlow's $0 models on an account with no card: its keys form a key pool at /pools/siliconflow/v1 (and siliconflow: models of /pools/space/v1) that sends and lists only those five. The key is checked with a free request and stored encrypted." },
  MISTRAL: { title: "Add a Mistral API key", placeholder: "Mistral API key",
    note: "Mistral La Plateforme's free tier (no card): every model, rate limited, at /pools/mistral/v1 (and mistral: models of /pools/space/v1). The free tier may use prompts for training. The key is checked with a free request and stored encrypted." },
  BEDROCK: { title: "Add a Claude on Amazon Bedrock key", placeholder: "<region>:<Bedrock API key>",
    note: "Claude on the AWS credit, with a card behind it: the pool sends nothing until Space records the credit and stops at 90% of it. Paste <region>:<Bedrock API key> (a bare key is taken as us-east-1's); its keys form a key pool at /pools/bedrock/v1/messages (and bedrock: models of /pools/space/v1). The key is checked with a request that spends nothing and stored encrypted." },
  VERTEX: { title: "Add a Claude on Google Vertex AI service account", placeholder: "Service-account key JSON",
    note: "Claude on the Google Cloud credit, with a card behind it: the pool sends nothing until Space records the credit and stops at 90% of it. Paste the service account's JSON key (add \"location\" for a region; default global); it forms a key pool at /pools/vertex/v1/messages (and vertex: models of /pools/space/v1). The key is checked with a request that spends nothing and stored encrypted." },
  OVH: { title: "Add OVHcloud AI Endpoints", placeholder: "", keyless: true,
    note: "Free anonymous access, no key and no account: 2 requests a minute per server IP, at /pools/ovh/v1 (and ovh: models of /pools/space/v1)." },
  AGENTROUTER: { title: "Add an AgentRouter API key", placeholder: "sk-…",
    note: "Granted credits. AgentRouter is a third-party relay that sees prompts: its keys form a key pool at /pools/agentrouter/v1 (and agentrouter: models of /pools/space/v1), the last of the free routes. The key is checked with a free request and stored encrypted." },
  FREEAI: { title: "Add a Free.ai API key", placeholder: "Free.ai API key",
    note: "Free chat from an unvetted third party that sees prompts: its keys form a key pool at /pools/freeai/v1 (and freeai: models of /pools/space/v1), last of the free routes. Free.ai refuses no key, so a wrong one is only found when it fails." },
  GOOGLE_AI: { title: "Add a Google AI API key", placeholder: "AIza…",
    note: "Google AI (Gemini API) keys serve Space Memory embeddings (gemini-embedding-001) and nothing else. A free-tier key has low per-minute and per-day limits: memories are embedded gradually and the rest wait for the next day. The key is checked with a free request and stored encrypted; it is never shown again." },
  CLAUDE: { title: "Add a Claude API key", placeholder: "sk-ant-…",
    note: "Paid per token. Space Gateway uses the key only while Claude API key fallback (Settings › Routing) is on and every pooled Claude account is out of quota, and never for Claude Code; the accounts take over again at their next reset. The key is checked with a free request and stored encrypted; it is never shown again." }
} as const;

const spaceKeyButtons: Partial<Record<keyof typeof apiKeyProviders, string>> = {
  OPENAI_API: "Use this server's OpenAI key", CLAUDE: "Use this server's Claude key",
  OPENROUTER: "Use this server's OpenRouter key", DEEPSEEK: "Use this server's DeepSeek key"
};

function AddOpenAiApiKey({ client, onConnected, provider = "OPENAI_API", title, note }: { client: SpaceGatewayClient; onConnected: OnConnected;
  provider?: keyof typeof apiKeyProviders; title?: string; note?: string }) {
  const text = { ...apiKeyProviders[provider], ...(title ? { title } : {}), ...(note ? { note } : {}) };
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function add(input: { apiKey?: string; useSpaceKey?: boolean }) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.addOpenAiApiKey({ provider, ...input });
      setApiKey("");
      setMessage({ tone: "ok", text: `Connected ${result.account.label}.` });
      onConnected(result.account.label, result.account.id);
    } catch (reason) {
      setMessage({ tone: "error", text: errorText(reason, "Could not add the key.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-gateway-add" aria-label={text.title}>
      <h3>{text.title}</h3>
      <p className="space-gateway-note">{text.note}</p>
      <form className="space-gateway-signin" onSubmit={(event) => { event.preventDefault(); void add({ apiKey: apiKey.trim() }); }}>
        {"keyless" in text ? null : <label className="space-gateway-field">API key
          <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={text.placeholder} autoComplete="off" spellCheck={false} />
        </label>}
        <div className="space-gateway-toolbar">
          {"keyless" in text
            ? <button type="button" className="space-gateway-button primary" disabled={busy} onClick={() => void add({ apiKey: GATEWAY_KEYLESS_KEY })}>Add without a key</button>
            : <button type="submit" className="space-gateway-button primary" disabled={busy || apiKey.trim().length < 20}>Add key</button>}
          {spaceKeyButtons[provider]
            ? <button type="button" className="space-gateway-button" disabled={busy} onClick={() => void add({ useSpaceKey: true })}>{spaceKeyButtons[provider]}</button>
            : null}
        </div>
      </form>
      {message ? <p className={message.tone === "ok" ? "space-gateway-success" : "space-gateway-alert"} role={message.tone === "ok" ? "status" : "alert"}>{message.text}</p> : null}
    </section>
  );
}

type AddProvider = "CODEX" | "CLAUDE" | "ANTIGRAVITY" | keyof typeof apiKeyProviders;

export function AddAccount({ client, onConnected, initialProvider = "CODEX", initialClaudeMethod }: {
  client: SpaceGatewayClient; onConnected: OnConnected; initialProvider?: AddProvider; initialClaudeMethod?: "sign-in" | "api-key";
}) {
  const [provider, setProvider] = useState<AddProvider>(initialProvider);
  return (
    <>
      <div className="filter-tabs" role="tablist" aria-label="Provider to add">
        {([["CODEX", "ChatGPT (Codex)"], ["CLAUDE", "Claude"], ["ANTIGRAVITY", "Antigravity"], ["OPENAI_API", "OpenAI API"], ["OPENROUTER", "OpenRouter"],
          ["DEEPSEEK", "DeepSeek"], ["NVIDIA", "NVIDIA"], ["GROQ", "Groq"], ["CLOUDFLARE_AI", "Cloudflare Workers AI"],
          ["ADAPTION", "Adaption Labs"], ["AMD_TOKEN_LAB", "AMD Token Lab"], ["INCEPTION", "Inception Labs"], ["ZAI", "Z.AI"], ["SILICONFLOW", "SiliconFlow"], ["OVH", "OVHcloud AI"], ["MISTRAL", "Mistral"], ["AZURE_OPENAI", "Azure OpenAI"], ["BEDROCK", "Claude on Bedrock"], ["VERTEX", "Claude on Vertex AI"], ["JINA", "Jina AI"], ["MIXEDBREAD", "Mixedbread"], ["AGENTROUTER", "AgentRouter"], ["FREEAI", "Free.ai"], ["GOOGLE_AI", "Google AI"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={provider === id} className={`filter-tab${provider === id ? " active" : ""}`}
            onClick={() => setProvider(id)}>{label}</button>
        ))}
      </div>
      {provider === "CODEX" ? <AddCodexAccount client={client} onConnected={onConnected} />
        : provider === "CLAUDE" ? <AddClaudeAccount client={client} onConnected={onConnected} initialMethod={initialClaudeMethod} />
          : provider === "ANTIGRAVITY" ? <AddAntigravityAccount client={client} onConnected={onConnected} />
            : <AddOpenAiApiKey key={provider} client={client} onConnected={onConnected} provider={provider} />}
    </>
  );
}

/**
 * A new sign-in for an account Space Gateway stopped using (rejected or expired sign-in, deactivated): the provider's
 * own sign-in, which replaces the account's credentials when the same account signs in. An API key is replaced by a
 * new key, added as its own account.
 */
export function SignInAgain({ client, account, onConnected }: {
  client: SpaceGatewayClient; account: Pick<GatewayAccount, "provider" | "planType" | "label" | "alias">; onConnected: OnConnected;
}) {
  const name = account.alias ?? account.label;
  if (account.provider === "CODEX") return <AddCodexAccount client={client} onConnected={onConnected} title={`Sign ${name} in again`} />;
  if (account.provider === "ANTIGRAVITY") return <AddAntigravityAccount client={client} onConnected={onConnected} title={`Sign ${name} in again`} reconnect />;
  if (account.provider === "CLAUDE" && account.planType !== "api") {
    return <AddClaudeAccount client={client} onConnected={onConnected} title={`Sign ${name} in again`} />;
  }
  const provider = account.provider === "CLAUDE" ? "CLAUDE" : account.provider as keyof typeof apiKeyProviders;
  if (!(provider in apiKeyProviders)) return <p className="space-gateway-note">Remove this account and add it again from Add account.</p>;
  return <AddOpenAiApiKey client={client} onConnected={onConnected} provider={provider} title={`Replace ${name}`}
    note="The provider rejected this key. A new key is checked and added as its own account; remove this one afterwards." />;
}
