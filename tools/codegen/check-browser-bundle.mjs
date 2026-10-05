import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entry = `
import { assertAppConfig, assertDashboardLayout, assertEventEnvelope, assertFeatures, assertPluginManifest, ContractError } from "./packages/types/src/index.ts";
export const validators = { "app-config": assertAppConfig, "dashboard-layout": assertDashboardLayout, "event-envelope": assertEventEnvelope, features: assertFeatures, "plugin-manifest": assertPluginManifest };
export { ContractError };
`;
const result = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: "browser-validator-smoke.ts", loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  write: false,
});
const bundle = result.outputFiles[0].text;
if (/^import .* from ["'](?:node:|fs|path)/m.test(bundle)) throw new Error("Browser validator bundle contains a Node-only import");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`;
const validators = await import(moduleUrl);
for (const [kind, schema] of Object.entries(validators.validators)) {
  for (const fixtureKind of ["valid", "invalid"]) {
    const fixtureDir = resolve(root, "fixtures/contracts", fixtureKind);
    const fixtureNames = (await readdir(fixtureDir)).filter((name) => name === `${kind}.json` || name.startsWith(`${kind}-`));
    for (const name of fixtureNames) {
      const value = JSON.parse(await readFile(resolve(fixtureDir, name), "utf8"));
      let valid = true;
      try { schema(value); } catch (error) {
        if (!(error instanceof validators.ContractError)) throw error;
        valid = false;
      }
      if (valid !== (fixtureKind === "valid")) throw new Error(`Browser bundle ${fixtureKind} fixture mismatch: ${name}`);
    }
  }
}
console.log("Browser-target bundle validates all shared contract fixtures without Node runtime imports.");
