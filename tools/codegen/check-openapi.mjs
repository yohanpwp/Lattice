import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const openapiPath = resolve(root, "contracts/openapi.yaml");
const document = parse(await readFile(openapiPath, "utf8"));
const paths = Object.keys(document.paths ?? {});
if (paths.some((path) => path.startsWith("/api/")) || paths.sort().join(",") !== "/v1/config,/v1/health") {
  throw new Error(`OpenAPI must describe only implemented /v1 routes; found: ${paths.join(", ")}`);
}

function pointerTarget(document, pointer) {
  let target = document;
  for (const segment of pointer.replace(/^\//, "").split("/")) {
    target = target?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return target;
}

async function resolveRefs(value, basePath, ownerDocument, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) await resolveRefs(item, basePath, ownerDocument, seen);
    return;
  }
  if (typeof value.$ref === "string") {
    const [file, pointer = ""] = value.$ref.split("#");
    const targetPath = file ? resolve(dirname(basePath), file) : basePath;
    let targetDocument = ownerDocument;
    if (file) {
      try { targetDocument = JSON.parse(await readFile(targetPath, "utf8")); }
      catch (error) { throw new Error(`Cannot resolve OpenAPI reference ${value.$ref}: ${String(error)}`); }
    }
    const key = `${targetPath}#${pointer}`;
    if (seen.has(key)) return;
    seen.add(key);
    const target = pointer ? pointerTarget(targetDocument, pointer) : targetDocument;
    if (target === undefined) throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
    await resolveRefs(target, targetPath, targetDocument, seen);
  }
  for (const child of Object.values(value)) await resolveRefs(child, basePath, ownerDocument, seen);
}

await resolveRefs(document, openapiPath, document);
console.log("OpenAPI paths and schema references are valid.");
