import { setupFreeModelCatalogSchema, type SetupFreeModelCatalog } from "./setup-free-models.js";
import { constants } from "node:fs";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const modelPattern = /^opencode\/[a-z0-9][a-z0-9._-]{0,100}$/;

async function readRegularFile(path: string, maxBytes: number): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return null;
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
}

export type InstallationNotes = { platform: string; hardwareProfile: string; completedActions: string[] };

/**
 * The installer's handoff, authenticated with this installation's session secret: the memory's digest and the manifest's
 * HMAC. An upgrade's handoff is signed too, with `completed: false` and no model (it ran no assistant check).
 */
async function readSignedHandoff(memoryRoot: string | undefined, installationSecret: string | undefined): Promise<{
  memory: string; modelId: string | null; completed: boolean; catalogDigest?: string } | null> {
  if (!memoryRoot || !installationSecret || installationSecret.length < 32) return null;
  const [memory, manifestText] = await Promise.all([
    readRegularFile(join(memoryRoot, "INSTALLATION_MEMORY.md"), 4096),
    readRegularFile(join(memoryRoot, "installation-handoff.json"), 1024)
  ]);
  if (!memory || !manifestText) return null;
  try {
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    if (manifest.schema !== 1 || typeof manifest.completed !== "boolean" ||
        !(manifest.modelId === null && !manifest.completed || typeof manifest.modelId === "string" && modelPattern.test(manifest.modelId)) ||
        typeof manifest.memorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.memorySha256) ||
        typeof manifest.mac !== "string" || !/^[a-f0-9]{64}$/.test(manifest.mac)) return null;
    if (createHash("sha256").update(memory).digest("hex") !== manifest.memorySha256) return null;
    const catalogDigest = manifest.catalogSha256;
    if (catalogDigest !== undefined && (typeof catalogDigest !== "string" || !/^[a-f0-9]{64}$/.test(catalogDigest))) return null;
    const payload = {
      schema: 1, memorySha256: manifest.memorySha256,
      modelId: manifest.modelId, completed: manifest.completed,
      ...(catalogDigest ? { catalogSha256: catalogDigest } : {})
    };
    const expected = createHmac("sha256", installationSecret).update(JSON.stringify(payload)).digest();
    const supplied = Buffer.from(manifest.mac, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    return { memory, modelId: manifest.modelId as string | null, completed: manifest.completed,
      ...(catalogDigest ? { catalogDigest } : {}) };
  } catch { return null; }
}

/** Only allowlisted installer facts: platform, hardware profile and the installer actions its assistant completed. */
function installationNotes(memory: string, completed: boolean): InstallationNotes | null {
  const lines = memory.split(/\r?\n/);
  const platform = lines.find(line => /^Platform: (linux|darwin|win32)$/.test(line))?.slice(10);
  // The installer's profiles (run-spaceapp INSTALL_PROFILES); "full" was never one of them (review 2026-10-21 #10).
  const hardwareProfile = lines.find(line => /^Hardware profile: (small|medium|large|light|standard)$/.test(line))?.slice(18);
  const actions = completed ? lines.find(line => line.startsWith("Completed installer assistant actions: "))?.slice(39).split(", ") ?? [] : [];
  const completedActions = ["CHECK_PREREQUISITES", "START_DOCKER"].filter(action => actions.includes(action));
  return platform && hardwareProfile ? { platform, hardwareProfile, completedActions } : null;
}

/** The host's sanitized memory is authenticated with this installation's session secret. */
export async function readAuthenticatedInstallationHandoff(
  memoryRoot: string | undefined, installationSecret: string | undefined, includeNotes = false
): Promise<{ modelId: string; completed: true; catalog?: SetupFreeModelCatalog; notes?: InstallationNotes } | null> {
  const signed = await readSignedHandoff(memoryRoot, installationSecret);
  if (!signed?.completed || !signed.modelId) return null;
  const lines = signed.memory.split(/\r?\n/);
  if (!lines.includes(`Verified free model: ${signed.modelId}`) ||
      // The installer's assistant counts only after a real tool call (operator rule 2026-10-11), never a text answer.
      !lines.includes("Assistant status: completed a live account-free tool call before Docker setup.")) return null;
  try {
    let catalog: SetupFreeModelCatalog | undefined;
    if (signed.catalogDigest) {
      const text = await readRegularFile(join(memoryRoot!, "free-model-catalog.json"), 65_536);
      if (!text || createHash("sha256").update(text).digest("hex") !== signed.catalogDigest) return null;
      const parsed = setupFreeModelCatalogSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return null;
      if (Math.abs(Date.now() - Date.parse(parsed.data.checkedAt)) <= 86400_000) catalog = parsed.data;
    }
    const notes = includeNotes ? installationNotes(signed.memory, true) : null;
    return { modelId: signed.modelId, completed: true, ...(catalog ? { catalog } : {}), ...(notes ? { notes } : {}) };
  } catch { return null; }
}

const upgradeProofName = "installation-upgrade-proof.json";
type UpgradeProof = { schema: 1; kind: "setup-tool-call"; modelId: string; verifiedAt: string };
const upgradeMac = (secret: string, proof: UpgradeProof) =>
  createHmac("sha256", secret).update(`spaceapp-installation-upgrade-proof:v1\n${JSON.stringify(proof)}`).digest();

/**
 * An installation upgraded from before 1.1.8 has no pre-Docker assistant check: the installer runs it only on a fresh
 * install (review 2026-10-21 #7). First Setup records here the live account-free tool call it observed after the upgrade,
 * signed with this installation's secret so the CLI container, which shares the memory volume, cannot write one. It
 * never stands for a pre-Docker run: readers get `source: "UPGRADE"`.
 */
export async function writeInstallationUpgradeProof(
  memoryRoot: string, installationSecret: string, modelId: string, verifiedAt: string
): Promise<void> {
  if (installationSecret.length < 32 || !modelPattern.test(modelId) || !Number.isFinite(Date.parse(verifiedAt))) {
    throw new Error("An upgrade proof needs this installation's secret and a verified free model.");
  }
  const proof: UpgradeProof = { schema: 1, kind: "setup-tool-call", modelId, verifiedAt };
  const target = join(memoryRoot, upgradeProofName);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...proof, mac: upgradeMac(installationSecret, proof).toString("hex") })}\n`,
      { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

export async function readInstallationUpgradeProof(
  memoryRoot: string | undefined, installationSecret: string | undefined
): Promise<{ modelId: string; verifiedAt: string } | null> {
  if (!memoryRoot || !installationSecret || installationSecret.length < 32) return null;
  const text = await readRegularFile(join(memoryRoot, upgradeProofName), 1024);
  if (!text) return null;
  try {
    const saved = JSON.parse(text) as Record<string, unknown>;
    if (saved.schema !== 1 || saved.kind !== "setup-tool-call" ||
        typeof saved.modelId !== "string" || !modelPattern.test(saved.modelId) ||
        typeof saved.verifiedAt !== "string" || !Number.isFinite(Date.parse(saved.verifiedAt)) ||
        typeof saved.mac !== "string" || !/^[a-f0-9]{64}$/.test(saved.mac)) return null;
    const proof: UpgradeProof = { schema: 1, kind: "setup-tool-call", modelId: saved.modelId, verifiedAt: saved.verifiedAt };
    const expected = upgradeMac(installationSecret, proof);
    const supplied = Buffer.from(saved.mac, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
      ? { modelId: proof.modelId, verifiedAt: proof.verifiedAt } : null;
  } catch { return null; }
}

/**
 * The installation's account-free assistant check: the installer's signed pre-Docker handoff, else the signed check First
 * Setup observed after an upgrade. `source` says which; only INSTALLER means a pre-Docker run happened.
 */
export async function readSetupAssistantProof(
  handoffRoot: string | undefined, memoryRoot: string | undefined, installationSecret: string | undefined, includeNotes = false
): Promise<{ modelId: string; completed: true; source: "INSTALLER" | "UPGRADE"; catalog?: SetupFreeModelCatalog;
  notes?: InstallationNotes } | null> {
  const installer = await readAuthenticatedInstallationHandoff(handoffRoot, installationSecret, includeNotes);
  if (installer?.completed) return { ...installer, source: "INSTALLER" };
  const upgrade = await readInstallationUpgradeProof(memoryRoot, installationSecret);
  if (!upgrade) return null;
  // An upgrade's signed handoff still names the platform and hardware profile; it completed no installer action.
  const signed = includeNotes ? await readSignedHandoff(handoffRoot, installationSecret) : null;
  const notes = signed && !signed.completed ? installationNotes(signed.memory, false) : null;
  return { modelId: upgrade.modelId, completed: true, source: "UPGRADE", ...(notes ? { notes } : {}) };
}
