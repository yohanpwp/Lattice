// Generates TypeScript types and schema constants from contracts/schemas/*.json.
// Run with: pnpm gen
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "../../contracts/schemas");
const outDir = join(here, "generated");

// [file relative to contracts/schemas, schema constant name, validator export name]
const SCHEMAS = [
  ["app-config.json", "appConfigSchema", "validateAppConfig"],
  ["features.json", "featuresSchema", "validateFeatures"],
  ["dashboard-layout.json", "dashboardLayoutSchema", "validateDashboardLayout"],
  ["plugin-manifest.json", "pluginManifestSchema", "validatePluginManifest"],
  ["events/envelope.json", "eventEnvelopeSchema", "validateEventEnvelope"],
];

const banner =
  "// AUTO-GENERATED from contracts/schemas by scripts/gen.mjs. Do not edit by hand.\n";

let types = banner + "\n";
let schemas = banner + "\n";

// Validators are generated at build time as plain functions (no runtime code
// generation), so they work under a strict Content-Security-Policy that
// forbids eval / new Function (browsers, Tauri webviews).
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  code: { source: true, esm: true },
});
addFormats(ajv);
const validatorExports = {};

for (const [file, constName, validatorName] of SCHEMAS) {
  const schema = JSON.parse(await readFile(join(schemaDir, file), "utf8"));
  ajv.addSchema(schema, validatorName);
  validatorExports[validatorName] = validatorName;

  const ts = await compile(schema, schema.title, {
    bannerComment: "",
    additionalProperties: false,
    unreachableDefinitions: true,
  });
  types += ts.trim() + "\n\n";

  schemas += `export const ${constName} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}

import { build } from "esbuild";

let validatorCode = standaloneCode(ajv, validatorExports);
const root = join(here, "../..");
const bundled = await build({
  absWorkingDir: root,
  stdin: { contents: validatorCode, resolveDir: root, sourcefile: "standalone.js", loader: "js" },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  write: false,
});
validatorCode = bundled.outputFiles[0].text;

if (/^import .* from ["'](?:node:|fs|path)/m.test(validatorCode) || /new Function|\beval\(/.test(validatorCode)) {
  throw new Error("Generated validators still contain Node-only imports or eval; update gen.mjs");
}

const standalone =
  "// @ts-nocheck\n" + banner + "/* eslint-disable */\n" + validatorCode + "\n";

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "standalone.ts"), standalone);
await writeFile(join(outDir, "types.ts"), types.trimEnd() + "\n");
await writeFile(join(outDir, "schemas.ts"), schemas.trimEnd() + "\n");
console.log("generated:", outDir);
