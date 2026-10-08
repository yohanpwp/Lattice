import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const openapiPath = resolve(root, "contracts/openapi.yaml");
const document = parse(await readFile(openapiPath, "utf8"));
const expectedOperations = new Map([
  ["/v1/health", ["get"]],
  ["/v1/config", ["get"]],
  ["/v1/features", ["get"]],
]);

function validateImplementedRoutes(document) {
  const paths = Object.keys(document.paths ?? {}).sort();
  const expectedPaths = [...expectedOperations.keys()].sort();
  if (paths.join(",") !== expectedPaths.join(",")) {
    throw new Error(`OpenAPI must describe only implemented M0-M2 /v1 routes; found: ${paths.join(", ")}`);
  }
  for (const [path, methods] of expectedOperations) {
    const operations = document.paths[path] ?? {};
    const actualMethods = Object.keys(operations).filter((key) => /^[a-z]+$/.test(key)).sort();
    if (actualMethods.join(",") !== [...methods].sort().join(",")) {
      throw new Error(`${path} methods must be ${methods.join(", ")}; found: ${actualMethods.join(", ")}`);
    }
    for (const method of methods) {
      if (!operations[method]?.responses?.["200"]) {
        throw new Error(`${method.toUpperCase()} ${path} must document a 200 response`);
      }
    }
  }
  if (!document.paths["/v1/features"].get.security?.some((scheme) => scheme.pocketbaseToken)) {
    throw new Error("GET /v1/features must require the PocketBase auth token");
  }
  if (!document.components?.securitySchemes?.pocketbaseToken) {
    throw new Error("OpenAPI must define the pocketbaseToken security scheme");
  }
}

validateImplementedRoutes(document);

// These representative regressions must remain rejected by the route checker.
for (const mutation of [
  (doc) => { doc.paths["/v1/payments/checkout"] = { post: { responses: { "200": {} } } }; },
  (doc) => { delete doc.paths["/v1/features"].get.security; },
]) {
  const negative = structuredClone(document);
  mutation(negative);
  let rejected = false;
  try { validateImplementedRoutes(negative); } catch { rejected = true; }
  if (!rejected) throw new Error("OpenAPI route checker accepted an invalid contract regression");
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
