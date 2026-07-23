import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MigrationFile {
  id: string;
  filename: string;
  sql: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(moduleDirectory);
export const migrationDirectory = join(packageRoot, "migrations");

export async function loadMigrations(): Promise<MigrationFile[]> {
  const filenames = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      id: filename.replace(/\.sql$/, ""),
      filename,
      sql: await readFile(join(migrationDirectory, filename), "utf8")
    }))
  );
}
