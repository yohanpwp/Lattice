// Generates TypeScript types and schema constants from contracts/schemas/*.json.
// Run with: pnpm gen
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "../../../contracts/schemas");
const outDir = join(here, "../src/generated");

// [file relative to contracts/schemas, exported constant name]
const SCHEMAS = [
  ["app-config.json", "appConfigSchema"],
  ["features.json", "featuresSchema"],
  ["dashboard-layout.json", "dashboardLayoutSchema"],
  ["plugin-manifest.json", "pluginManifestSchema"],
  ["events/event-envelope.json", "eventEnvelopeSchema"],
];

const banner =
  "// AUTO-GENERATED from contracts/schemas by scripts/gen.mjs. Do not edit by hand.\n";

let types = banner + "\n";
let schemas = banner + "\n";

for (const [file, constName] of SCHEMAS) {
  const schema = JSON.parse(await readFile(join(schemaDir, file), "utf8"));

  const ts = await compile(schema, schema.title, {
    bannerComment: "",
    additionalProperties: false,
    unreachableDefinitions: true,
  });
  types += ts.trim() + "\n\n";

  schemas += `export const ${constName} = ${JSON.stringify(schema, null, 2)} as const;\n\n`;
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "types.ts"), types.trimEnd() + "\n");
await writeFile(join(outDir, "schemas.ts"), schemas.trimEnd() + "\n");
console.log("generated:", outDir);
