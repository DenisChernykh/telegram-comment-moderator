import { existsSync } from "node:fs";
export function localEnv() {
  if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars");
}
