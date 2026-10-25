import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { memoryGraphSnapshotSchema } from "@space/contracts";
import type { MemoryGraphSnapshot } from "./types.js";

export interface MemoryGraphSnapshotStore {
  read(): Promise<MemoryGraphSnapshot | null>;
  write(snapshot: MemoryGraphSnapshot): Promise<void>;
  invalidate(): Promise<void>;
}

interface MemoryGraphSnapshotFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

interface CreateMemoryGraphSnapshotStoreOptions {
  rootDir: string;
  filename?: string;
  openFile?: (path: string, flags: "r" | "wx", mode?: number) => Promise<MemoryGraphSnapshotFileHandle>;
}

export function createMemoryGraphSnapshotStore(options: CreateMemoryGraphSnapshotStoreOptions): MemoryGraphSnapshotStore {
  const snapshotPath = join(options.rootDir, options.filename ?? "snapshot.json");
  const openFile = options.openFile ?? open;
  const syncRootDirectory = async () => {
    let directoryHandle: MemoryGraphSnapshotFileHandle;
    try {
      directoryHandle = await openFile(options.rootDir, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  };
  return {
    async read() {
      try {
        const parsed = memoryGraphSnapshotSchema.safeParse(JSON.parse(await readFile(snapshotPath, "utf8")));
        return parsed.success ? parsed.data as MemoryGraphSnapshot : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async write(snapshot) {
      await mkdir(options.rootDir, { recursive: true, mode: 0o750 });
      const temporaryPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        const handle = await openFile(temporaryPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(snapshot)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryPath, snapshotPath);
        await syncRootDirectory();
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    },
    async invalidate() {
      await rm(snapshotPath, { force: true });
      await syncRootDirectory();
    }
  };
}
