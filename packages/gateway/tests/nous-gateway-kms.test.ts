import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGatewayConfig } from "../src/config.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { gcpKmsDecrypter, gcpKmsKeyProvider, type HttpsCall } from "../src/nous/kms.js";
import { unwrapSecretToFile } from "../src/nous/secrets.js";

// K5-kms: the credential key unwrapped by Cloud KMS through X.509 workload identity federation; the HTTPS calls are recorded, never sent.
const KEY = "projects/p/locations/europe-west3/keyRings/ngw-eu1/cryptoKeys/ngw-credential-key";
const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;

function fixture(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ngw-kms-"));
  const file = (name: string, content: string | Buffer) => { writeFileSync(join(dir, name), content); return join(dir, name); };
  const certConfig = file("certificate_config.json", JSON.stringify({ cert_configs: { workload: { cert_path: file("ngw_app.crt", pem("TEFG")), key_path: file("ngw_app.key", "KEY-PEM") } } }));
  const credentialConfigFile = file("wif.json", JSON.stringify({ type: "external_account", subject_token_type: "urn:ietf:params:oauth:token-type:mtls",
    audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/ngw-eu1/providers/ngw-hosts", token_url: "https://sts.mtls.googleapis.com/v1/token",
    credential_source: { certificate: { certificate_config_location: certConfig, trust_chain_path: file("chain.pem", pem("SU5U") + pem("Uk9PVA==")) } }, ...config }));
  return { wrappedFile: file("credential-key.wrapped", Buffer.from("wrapped-bytes")), credentialConfigFile };
}

describe("Cloud KMS credential key provider", () => {
  it("exchanges the host certificate at STS over mTLS, unwraps the wrapped key once and gives 32 bytes the cipher uses", async () => {
    const calls: Parameters<HttpsCall>[] = [];
    const material = Buffer.alloc(32, 9);
    const call: HttpsCall = async (url, init) => {
      calls.push([url, init]);
      return url.startsWith("https://sts.") ? { status: 200, body: JSON.stringify({ access_token: "ya29.short" }) }
        : { status: 200, body: JSON.stringify({ plaintext: material.toString("base64") }) };
    };
    const files = fixture();
    const key = await gcpKmsKeyProvider({ keyName: KEY, ...files, call }).load();
    expect(key.equals(material)).toBe(true);
    const [[stsUrl, sts], [kmsUrl, kms]] = calls as [Parameters<HttpsCall>, Parameters<HttpsCall>];
    expect(stsUrl).toBe("https://sts.mtls.googleapis.com/v1/token");
    expect(sts.cert).toContain("BEGIN CERTIFICATE");
    expect(sts.key).toBe("KEY-PEM");
    const form = new URLSearchParams(sts.body);
    expect(form.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:mtls");
    expect(JSON.parse(form.get("subject_token")!)).toEqual(["TEFG", "SU5U", "Uk9PVA=="]);
    expect(kmsUrl).toBe(`https://cloudkms.googleapis.com/v1/${KEY}:decrypt`);
    expect(kms.headers.authorization).toBe("Bearer ya29.short");
    expect(JSON.parse(kms.body)).toEqual({ ciphertext: Buffer.from("wrapped-bytes").toString("base64") });
    const cipher = createCredentialCipher(key);
    expect(cipher.decrypt(cipher.encrypt("token", "acct"), "acct")).toBe("token");
  });

  it("refuses a non-X.509 configuration, impersonation, a refused certificate and a key that is not 32 bytes", async () => {
    const ok: HttpsCall = async (url) => url.startsWith("https://sts.") ? { status: 200, body: '{"access_token":"t"}' } : { status: 200, body: JSON.stringify({ plaintext: "c2hvcnQ=" }) };
    await expect(gcpKmsKeyProvider({ keyName: KEY, ...fixture({ subject_token_type: "urn:ietf:params:oauth:token-type:jwt" }), call: ok }).load()).rejects.toThrow(/X.509/);
    await expect(gcpKmsKeyProvider({ keyName: KEY, ...fixture({ service_account_impersonation_url: "https://x" }), call: ok }).load()).rejects.toThrow(/impersonation/);
    await expect(gcpKmsKeyProvider({ keyName: KEY, ...fixture({ token_url: "https://evil.example/token" }), call: ok }).load()).rejects.toThrow(/googleapis/);
    await expect(gcpKmsKeyProvider({ keyName: KEY, ...fixture(), call: async () => ({ status: 403, body: "{}" }) }).load()).rejects.toThrow(/STS refused/);
    await expect(gcpKmsKeyProvider({ keyName: KEY, ...fixture(), call: ok }).load()).rejects.toThrow(/32 bytes/);
    expect(() => gcpKmsKeyProvider({ keyName: "ngw-credential-key", ...fixture() })).toThrow(/NGW_KMS_KEY_NAME/);
  });

  it("reads the KMS settings only in NGW_MODE=nous, all three or none", () => {
    const base = { NGW_MODE: "nous", NGW_REGION: "eu1" };
    expect(loadGatewayConfig({}).ngw).toBeNull();
    expect(loadGatewayConfig(base).ngw).toEqual({ region: "eu1", kms: null, admin: null });
    expect(loadGatewayConfig({ ...base, NGW_KMS_KEY_NAME: KEY, NGW_CREDENTIAL_KEY_WRAPPED_FILE: "/etc/ngw/kms/credential-key.wrapped",
      GOOGLE_APPLICATION_CREDENTIALS: "/etc/ngw/kms/wif.json" }).ngw?.kms).toEqual({ keyName: KEY, wrappedFile: "/etc/ngw/kms/credential-key.wrapped",
      credentialConfigFile: "/etc/ngw/kms/wif.json" });
    expect(() => loadGatewayConfig({ ...base, NGW_KMS_KEY_NAME: KEY })).toThrow(/NGW_CREDENTIAL_KEY_WRAPPED_FILE/);
    expect(() => loadGatewayConfig({ NGW_MODE: "nous" })).toThrow(/NGW_REGION/);
    // K5-listener: the replica listens on its wg-int address itself; the Space Gateway's second (LAN) listener is refused.
    expect(loadGatewayConfig({ ...base, SPACE_GATEWAY_HOST: "10.78.0.21" }).host).toBe("10.78.0.21");
    expect(() => loadGatewayConfig({ ...base, SPACE_GATEWAY_LAN_HOST: "10.78.0.21", SPACE_GATEWAY_LAN_PORT: "4925",
      SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.78.0.11/32" })).toThrow(/LAN listener/);
  });

  it("unwraps a boot-time secret only into tmpfs or ramfs, mode 0400, without a temporary file left (K5-secrets)", async () => {
    const env = Buffer.from("PGBACKREST_REPO1_S3_KEY=k\n");
    const call: HttpsCall = async (url) => url.startsWith("https://sts.") ? { status: 200, body: '{"access_token":"t"}' } : { status: 200, body: JSON.stringify({ plaintext: env.toString("base64") }) };
    const files = fixture();
    const decrypt = gcpKmsDecrypter({ keyName: KEY, credentialConfigFile: files.credentialConfigFile, call });
    const out = join(mkdtempSync(join(tmpdir(), "ngw-run-")), "pgbackrest.env");
    await expect(unwrapSecretToFile({ wrappedFile: files.wrappedFile, outputFile: out, decrypt, filesystemType: async () => 0xef53 })).rejects.toThrow(/not tmpfs/);
    expect(existsSync(out)).toBe(false);
    await unwrapSecretToFile({ wrappedFile: files.wrappedFile, outputFile: out, decrypt, filesystemType: async () => 0x01021994 });
    expect(readFileSync(out)).toEqual(env);
    expect(statSync(out).mode & 0o777).toBe(0o400);
    await unwrapSecretToFile({ wrappedFile: files.wrappedFile, outputFile: out, decrypt, filesystemType: async () => 0x01021994 }); // a reboot-less re-run replaces it
    expect(readdirSync(join(out, ".."))).toEqual(["pgbackrest.env"]);
  });
});
