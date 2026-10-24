import { constants } from "node:fs";
import { copyFile, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export function recordingVersion(args) {
  if (!args.length) return null;
  if (args.length !== 2 || args[0] !== "--version" || !/^[a-z][a-z0-9-]{0,63}$/.test(args[1])) {
    throw new Error("Usage: temporal:record-histories [--version patch-name]. Use a new version only alongside a reviewed patched() change.");
  }
  return args[1];
}

export async function preflightRecording(directory, version, replayExisting) {
  const names = (await readdir(directory)).filter(name => name.endsWith(".json")).sort();
  if (!version && names.length) throw new Error("Saved histories already exist. Preserve them; record a reviewed patched() change with --version NEW-PATCH-NAME.");
  if (version && names.some(name => name.endsWith(`--${version}.json`))) {
    throw new Error(`History version ${version} already exists; it cannot be overwritten.`);
  }
  // Never generate a replacement oracle before checking the existing executions.
  // The caller supplies the actual production replay gate, not a validity check.
  if (names.length) {
    if (typeof replayExisting !== "function") {
      throw new Error("Existing histories must pass replay before recording a new version.");
    }
    await replayExisting(names);
  }
}

export async function publishHistories(staging, directory, version) {
  const names = (await readdir(staging)).filter(name => name.endsWith(".json")).sort();
  if (!names.length) throw new Error("Recorder produced no histories; nothing was published.");
  const plan = [];
  for (const name of names) {
    const source = join(staging, name);
    const targetName = version ? `${name.slice(0, -5)}--${version}.json` : name;
    const target = join(directory, targetName);
    const fixture = JSON.parse(await readFile(source, "utf8"));
    if (!fixture.workflowId || !fixture.history?.events?.some(event => event.workflowTaskCompletedEventAttributes)) {
      throw new Error(`Invalid recorded history ${name}; nothing was published.`);
    }
    // Validate the entire plan before writing any file, including the last one.
    try { await readFile(target); } catch (error) {
      if (error.code === "ENOENT") { plan.push({ source, target }); continue; }
      throw error;
    }
    throw new Error(`Refusing to overwrite saved history ${targetName}; nothing was published.`);
  }
  const created = [];
  try {
    for (const { source, target } of plan) {
      // A concurrent recorder must not win the preflight-to-copy race silently.
      await copyFile(source, target, constants.COPYFILE_EXCL);
      created.push(target);
    }
  } catch (error) {
    await Promise.all(created.map(path => unlink(path)));
    throw error;
  }
  return created;
}
