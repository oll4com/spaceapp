import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import type { CredentialKeyProvider } from "../credential-cipher.js";

/**
 * Google Cloud KMS key provider of the Nous Gateway (plan clipboard:_0qBSFCftZuD step 4, K5-kms; install plan §5, runbook I-2.1 and
 * I-2.5): the 32-byte data key is stored only wrapped (`gcloud kms encrypt`, raw ciphertext file) and unwrapped once at start into
 * memory. No key file and no service-account key: the host proves itself with its X.509 certificate from the ngw CA to Google's STS
 * (workload identity federation, `providers create-x509`), and the short-lived token it gets calls `cryptoKeys.decrypt`.
 * shortcut: X.509 credential configurations only, without service-account impersonation (the runbook grants the principal on the key
 * directly); an OIDC-sourced configuration needs its own subject-token reader.
 */
export type HttpsCall = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; cert?: string; key?: string })
  => Promise<{ status: number; body: string }>;

export const httpsCall: HttpsCall = (url, init) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: init.method, headers: { ...init.headers, "content-length": Buffer.byteLength(init.body) }, cert: init.cert, key: init.key,
    timeout: 15_000 }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    res.on("error", reject);
  });
  req.on("timeout", () => req.destroy(new Error(`${new URL(url).host} did not answer in 15 s`)));
  req.on("error", reject);
  req.end(init.body);
});

/** The fields of a `gcloud iam workload-identity-pools create-cred-config` file this provider reads. */
interface X509CredentialConfig {
  type?: string; subject_token_type?: string; audience?: string; token_url?: string; service_account_impersonation_url?: string;
  credential_source?: { certificate?: { certificate_config_location?: string; trust_chain_path?: string } };
}

const KEY_NAME = /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/;

/** The base64 DER of every certificate in a PEM file, in order. */
const pemCertificates = (pem: string) => [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((match) => match[1]!.replace(/\s+/g, ""));

/** Unwraps a `gcloud kms encrypt` ciphertext with this host's workload identity (one STS exchange per call); also K5-secrets and the Stripe key. */
export function gcpKmsDecrypter(options: { keyName: string; credentialConfigFile: string; call?: HttpsCall }): (ciphertext: Buffer) => Promise<Buffer> {
  if (!KEY_NAME.test(options.keyName)) throw new Error("NGW_KMS_KEY_NAME must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>.");
  const call = options.call ?? httpsCall;
  return async (ciphertext) => {
    const config = JSON.parse(await readFile(options.credentialConfigFile, "utf8")) as X509CredentialConfig;
    const certificate = config.credential_source?.certificate;
    if (config.type !== "external_account" || config.subject_token_type !== "urn:ietf:params:oauth:token-type:mtls" || !certificate?.certificate_config_location
      || typeof config.audience !== "string" || typeof config.token_url !== "string") {
      throw new Error("The workload identity configuration must be an X.509 external_account (gcloud iam workload-identity-pools create-cred-config).");
    }
    if (config.service_account_impersonation_url) throw new Error("Service-account impersonation is not supported; grant the workload principal on the key.");
    const tokenUrl = new URL(config.token_url);
    if (tokenUrl.protocol !== "https:" || !tokenUrl.hostname.endsWith(".googleapis.com")) throw new Error("token_url must be a googleapis.com HTTPS URL.");
    const certConfig = JSON.parse(await readFile(certificate.certificate_config_location, "utf8")) as { cert_configs?: { workload?: { cert_path?: string; key_path?: string } } };
    const workload = certConfig.cert_configs?.workload;
    if (!workload?.cert_path || !workload.key_path) throw new Error("The certificate configuration names no workload cert_path and key_path.");
    const [cert, key, chain] = await Promise.all([readFile(workload.cert_path, "utf8"), readFile(workload.key_path, "utf8"),
      certificate.trust_chain_path ? readFile(certificate.trust_chain_path, "utf8") : Promise.resolve("")]);
    const leaf = pemCertificates(cert);
    if (leaf.length === 0) throw new Error("The workload certificate file holds no certificate.");

    // STS over mTLS with this host's certificate; the subject token is the chain as JSON (leaf first).
    const sts = await call(tokenUrl.toString(), { method: "POST", cert, key, headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: config.audience,
        scope: "https://www.googleapis.com/auth/cloudkms", requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:oauth:token-type:mtls", subject_token: JSON.stringify([leaf[0], ...pemCertificates(chain)]) }).toString() });
    const accessToken = sts.status === 200 ? (JSON.parse(sts.body) as { access_token?: unknown }).access_token : null;
    if (typeof accessToken !== "string" || !accessToken) throw new Error(`Google STS refused the workload certificate (HTTP ${sts.status}).`);

    const decrypted = await call(`https://cloudkms.googleapis.com/v1/${options.keyName}:decrypt`, { method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ ciphertext: ciphertext.toString("base64") }) });
    const plaintext = decrypted.status === 200 ? (JSON.parse(decrypted.body) as { plaintext?: unknown }).plaintext : null;
    if (typeof plaintext !== "string") throw new Error(`Cloud KMS did not unwrap the blob (HTTP ${decrypted.status}).`);
    return Buffer.from(plaintext, "base64");
  };
}

export function gcpKmsKeyProvider(options: { keyName: string; wrappedFile: string; credentialConfigFile: string; call?: HttpsCall }): CredentialKeyProvider {
  const decrypt = gcpKmsDecrypter(options);
  return {
    async load() {
      const material = await decrypt(await readFile(options.wrappedFile));
      if (material.length !== 32) throw new Error("The unwrapped credential key is not 32 bytes.");
      return material;
    }
  };
}
