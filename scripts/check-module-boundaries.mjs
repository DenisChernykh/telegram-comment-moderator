import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = path.resolve("src");
const violations = [];

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory()
        ? collectTypeScriptFiles(absolute)
        : Promise.resolve(entry.name.endsWith(".ts") ? [absolute] : []);
    }),
  );
  return nested.flat();
}

function moduleName(file) {
  const relative = path.relative(sourceRoot, file).split(path.sep);
  return relative[0] === "modules" ? relative[1] : undefined;
}

function resolveRelativeImport(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  if (path.extname(resolved)) return resolved;
  if (existsSync(`${resolved}.ts`)) return `${resolved}.ts`;
  return path.join(resolved, "index.ts");
}

function report(file, message) {
  violations.push(`${path.relative(process.cwd(), file)}: ${message}`);
}

for (const file of await collectTypeScriptFiles(sourceRoot)) {
  if (file.endsWith("worker-configuration.d.ts")) continue;
  const source = await readFile(file, "utf8");
  const ownModule = moduleName(file);
  const relativeFromModule = ownModule
    ? path.relative(path.join(sourceRoot, "modules", ownModule), file).split(path.sep)
    : [];
  const ownLayer = relativeFromModule[0];

  const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/gu);
  for (const match of imports) {
    const specifier = match[1];
    if (!specifier) continue;

    if (ownLayer === "application") {
      if (
        ["hono", "@hono/", "drizzle-orm", "jose", "wrangler", "cloudflare:"].some(
          (dependency) => specifier === dependency || specifier.startsWith(dependency),
        ) ||
        specifier.includes("/presentation/") ||
        specifier.includes("/infrastructure/")
      ) {
        report(file, `application must not import ${specifier}`);
      }
    }

    if (ownLayer === "presentation" && specifier.includes("/infrastructure/")) {
      report(file, `presentation must not import infrastructure (${specifier})`);
    }

    if (!specifier.startsWith(".")) continue;
    const importedFile = resolveRelativeImport(file, specifier);
    const importedModule = moduleName(importedFile);
    if (ownModule && importedModule && ownModule !== importedModule) {
      const importedRelative = path
        .relative(path.join(sourceRoot, "modules", importedModule), importedFile)
        .split(path.sep)
        .join("/");
      if (importedRelative !== "index.ts" && importedRelative !== "public-contracts.ts") {
        report(file, `cross-module import must use index.ts or public-contracts.ts (${specifier})`);
      }
    }

    const sourceArea = path.relative(sourceRoot, file).split(path.sep)[0];
    const importedArea = path.relative(sourceRoot, importedFile).split(path.sep)[0];
    if (sourceArea === "platform" && importedArea === "modules") {
      report(file, `platform must not import a product module (${specifier})`);
    }
    if (sourceArea === "app" && importedArea === "modules") {
      const importedRelative = path.relative(path.join(sourceRoot, "modules"), importedFile);
      const depth = importedRelative.split(path.sep);
      if (depth.length > 2 || !["index.ts", "public-contracts.ts"].includes(depth[1])) {
        report(file, `app must use a module root or public contract (${specifier})`);
      }
    }
  }
}

// The callback's actual-address validation is delegated to the public-only
// Cloudflare network. Never permit a private-origin compatibility override.
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
for (const [name, settings] of Object.entries({ default: config, ...config.env })) {
  const flags = settings.compatibility_flags ?? config.compatibility_flags ?? [];
  if (
    !flags.includes("global_fetch_strictly_public") ||
    flags.includes("global_fetch_private_origin")
  )
    violations.push(`wrangler.jsonc: ${name} must preserve the public-only callback network`);
}

if (violations.length > 0) {
  console.error(`Module boundary violations:\n${violations.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Module boundaries are valid.");
}
