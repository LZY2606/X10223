import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function projectRoot(): string {
  return process.cwd();
}

export function defaultDatabasePath(): string {
  const dir = path.join(projectRoot(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, "gelworkbench.db");
}

export function casePackDir(): string {
  return path.join(projectRoot(), "case-pack");
}

export function ensureBundledCasePackPath(): string {
  const dir = casePackDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
