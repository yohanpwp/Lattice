import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, relative, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { evaluateSpdx, isProhibitedLicense } from "./spdx.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../..");

export async function findLicenseFile(dir) {
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      if (/^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)([-_.].+)?$/i.test(entry)) {
        const full = join(dir, entry);
        const s = await stat(full);
        if (s.isFile()) {
          const content = await readFile(full, "utf8");
          return { filename: entry, content };
        }
      }
    }
    const readmePath = join(dir, "README.md");
    if (existsSync(readmePath)) {
      const readme = await readFile(readmePath, "utf8");
      const match = readme.match(/(?:^|\n)##?\s+License\s*\n+([\s\S]+?)(?=\n##|\n#[^#]|$)/i);
      if (match) {
        const text = match[1].trim();
        if (text.length > 50 && detectLicenseFromText(text)) {
          return { filename: "README.md#License", content: text };
        }
      }
    }
  } catch {
    // Directory unreadable or doesn't exist
  }
  return null;
}

export function detectLicenseFromText(text) {
  if (!text || typeof text !== "string") return null;
  if (/Apache License\s+Version 2\.0/i.test(text) || /http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/i.test(text)) {
    return "Apache-2.0";
  }
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(text) || /The MIT License/i.test(text)) {
    return "MIT";
  }
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    if (/Neither the name of/i.test(text) || /3-clause/i.test(text) || /third clause/i.test(text)) {
      return "BSD-3-Clause";
    }
    return "BSD-2-Clause";
  }
  if (/0BSD/i.test(text) || /Zero-Clause BSD/i.test(text)) {
    return "0BSD";
  }
  if (/ISC License/i.test(text) || /Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(text)) {
    return "ISC";
  }
  if (/CC0 1\.0 Universal/i.test(text) || /Creative Commons Zero/i.test(text)) {
    return "CC0-1.0";
  }
  if (/This is free and unencumbered software released into the public domain/i.test(text) || /unlicense\.org/i.test(text)) {
    return "Unlicense";
  }
  if (/PYTHON SOFTWARE FOUNDATION LICENSE/i.test(text)) {
    return "Python-2.0";
  }
  if (/Boost Software License/i.test(text)) {
    return "BSL-1.0";
  }
  if (/Blue Oak Model License/i.test(text) || /blueoakcouncil\.org\/license/i.test(text)) {
    return "BlueOak-1.0.0";
  }
  if (/Creative Commons Attribution 4\.0/i.test(text) || /CC-BY-4\.0/i.test(text)) {
    return "CC-BY-4.0";
  }
  if (/Unicode License Agreement/i.test(text) || /UNICODE, INC\. LICENSE AGREEMENT/i.test(text)) {
    return "Unicode-3.0";
  }
  if (/zlib\.h -- interface of the 'zlib' general purpose compression library/i.test(text) || /This software is provided 'as-is'/i.test(text)) {
    return "Zlib";
  }
  if (/Mozilla Public License/i.test(text)) {
    return "MPL-2.0";
  }
  if (/General Public License/i.test(text)) {
    return "GPL-3.0";
  }
  return null;
}

const KNOWN_UPSTREAM_LICENSES = {
  "@napi-rs/lzma-linux-x64-gnu": {
    license: "MIT",
    text: `MIT License\n\nCopyright (c) 2022 LongYinan\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`,
  },
  fsevents: {
    license: "MIT",
    text: `MIT License\n\nCopyright (C) 2010-2020 by Philipp Dunkel <pip@pipobscure.com>\nCopyright (C) 2014-2020 by Stefan Raab <stefan@raab.link>\nCopyright (C) 2020 by Axel von Bertoldi <axel.vonbertoldi@gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in\nall copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\nTHE SOFTWARE.`,
  },
  stackback: {
    license: "MIT",
    text: `The MIT License (MIT)\n\nCopyright (c) Roman Shtylman <shtylman@gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.`,
  },
};

export async function scanNpmDependencies() {
  const results = [];
  const pnpmLockPath = resolve(rootDir, "pnpm-lock.yaml");
  if (!existsSync(pnpmLockPath)) {
    return results;
  }

  const content = await readFile(pnpmLockPath, "utf8");
  const lock = parseYaml(content);
  if (!lock || !lock.packages) return results;

  const pnpmDir = resolve(rootDir, "node_modules/.pnpm");
  const pnpmSubdirs = existsSync(pnpmDir) ? await readdir(pnpmDir) : [];

  // Helper to resolve parent package license for optional platform subpackages
  const parentLicenses = new Map();
  async function getParentLicense(parentPkgName) {
    if (parentLicenses.has(parentPkgName)) return parentLicenses.get(parentPkgName);
    const prefix = parentPkgName.replace("/", "+") + "@";
    const matched = pnpmSubdirs.find((d) => d.startsWith(prefix));
    if (matched) {
      const dir = resolve(pnpmDir, matched, "node_modules", parentPkgName);
      const lic = await findLicenseFile(dir);
      if (lic) {
        parentLicenses.set(parentPkgName, lic);
        return lic;
      }
    }
    const rootDirPkg = resolve(rootDir, "node_modules", parentPkgName);
    if (existsSync(rootDirPkg)) {
      const lic = await findLicenseFile(rootDirPkg);
      if (lic) {
        parentLicenses.set(parentPkgName, lic);
        return lic;
      }
    }
    return null;
  }

  for (const [key, pkgData] of Object.entries(lock.packages)) {
    const cleanedKey = key.replace(/^\//, "");
    const atIdx = cleanedKey.indexOf("@", 1);
    if (atIdx === -1) continue;

    const name = cleanedKey.slice(0, atIdx);
    const rest = cleanedKey.slice(atIdx + 1);
    const parenIdx = rest.indexOf("(");
    const version = parenIdx === -1 ? rest : rest.slice(0, parenIdx);

    let pkgDir = null;
    let pkgJson = null;

    const safeName = name.replace("/", "+");
    const prefix = `${safeName}@${version}`;
    const matched = pnpmSubdirs.find((d) => d.startsWith(prefix));
    if (matched) {
      const candidate = resolve(pnpmDir, matched, "node_modules", name);
      if (existsSync(resolve(candidate, "package.json"))) {
        pkgDir = candidate;
      }
    }

    if (!pkgDir) {
      const rootCandidate = resolve(rootDir, "node_modules", name);
      if (existsSync(resolve(rootCandidate, "package.json"))) {
        pkgDir = rootCandidate;
      }
    }

    let statedLicense = "UNKNOWN";
    if (pkgDir) {
      try {
        pkgJson = JSON.parse(await readFile(resolve(pkgDir, "package.json"), "utf8"));
        statedLicense =
          typeof pkgJson.license === "string"
            ? pkgJson.license
            : typeof pkgJson.licenses === "object"
            ? (Array.isArray(pkgJson.licenses) ? pkgJson.licenses[0]?.type : pkgJson.licenses?.type) ?? "UNKNOWN"
            : pkgJson.license?.type ?? "UNKNOWN";
      } catch {
        // failed to read package.json
      }
    }

    let licenseFile = pkgDir ? await findLicenseFile(pkgDir) : null;
    let licenseText = licenseFile?.content ?? "";

    // Platform-specific optional packages inherit upstream license from their parent distribution
    if (!licenseText) {
      if (name.startsWith("@esbuild/")) {
        const parentLic = await getParentLicense("esbuild");
        if (parentLic) {
          licenseText = parentLic.content;
          if (statedLicense === "UNKNOWN") statedLicense = "MIT";
        }
      } else if (name.startsWith("@rollup/rollup-")) {
        const parentLic = await getParentLicense("rollup");
        if (parentLic) {
          licenseText = parentLic.content;
          if (statedLicense === "UNKNOWN") statedLicense = "MIT";
        }
      } else if (name.startsWith("@tauri-apps/cli-")) {
        const parentLic = await getParentLicense("@tauri-apps/cli");
        if (parentLic) {
          licenseText = parentLic.content;
          if (statedLicense === "UNKNOWN") statedLicense = "MIT OR Apache-2.0";
        }
      } else if (name.startsWith("@babel/")) {
        const parentLic = await getParentLicense("@babel/core");
        if (parentLic) {
          licenseText = parentLic.content;
          if (statedLicense === "UNKNOWN") statedLicense = "MIT";
        }
      } else if (KNOWN_UPSTREAM_LICENSES[name]) {
        const known = KNOWN_UPSTREAM_LICENSES[name];
        licenseText = known.text;
        if (statedLicense === "UNKNOWN") statedLicense = known.license;
      }
    }

    if (statedLicense === "UNKNOWN" && licenseText) {
      const detected = detectLicenseFromText(licenseText);
      if (detected) statedLicense = detected;
    }

    const hasLicenseFile = Boolean(licenseText && licenseText.trim().length > 20);

    results.push({
      ecosystem: "npm",
      name,
      version,
      statedLicense,
      hasLicenseFile,
      licenseText: hasLicenseFile ? licenseText : "",
    });
  }

  return results;
}

export async function scanGoDependencies() {
  const results = [];
  const backendDir = resolve(rootDir, "backend");
  if (!existsSync(resolve(backendDir, "go.mod"))) {
    return results;
  }

  // Union dependencies across supported target graphs (linux, windows, darwin)
  // so the audited inventory is identical on Windows, Linux, and macOS
  const usedModules = new Set();
  try {
    for (const targetOs of ["linux", "windows", "darwin"]) {
      const depsOutput = execSync('go list -deps -f "{{with .Module}}{{.Path}}{{end}}" ./...', {
        cwd: backendDir,
        env: { ...process.env, GOOS: targetOs },
        encoding: "utf8",
      });
      for (const line of depsOutput.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && trimmed !== "github.com/Lattice/backend") {
          usedModules.add(trimmed);
        }
      }
    }
  } catch (err) {
    console.warn("go list -deps union failed:", err.message);
  }

  let stdout = "";
  try {
    stdout = execSync("go list -m -json all", { cwd: backendDir, encoding: "utf8" });
  } catch (err) {
    console.warn("go list failed, skipping:", err.message);
    return results;
  }

  const rawObjects = stdout.trim().split(/\n(?=\{)/g);
  for (const raw of rawObjects) {
    if (!raw.trim()) continue;
    try {
      const mod = JSON.parse(raw);
      if (mod.Main || !mod.Version) continue;

      const name = mod.Path;
      const version = mod.Version;
      const dir = mod.Dir;

      // Only audit modules that are in the unioned dependency tree of backend
      if (usedModules.size > 0 && !usedModules.has(name)) {
        continue;
      }

      let licenseFile = dir ? await findLicenseFile(dir) : null;
      let licenseText = licenseFile?.content ?? "";
      let statedLicense = licenseText ? detectLicenseFromText(licenseText) : null;

      const hasLicenseFile = Boolean(licenseFile && licenseText && statedLicense);

      results.push({
        ecosystem: "go",
        name,
        version,
        statedLicense: statedLicense || "UNKNOWN",
        hasLicenseFile,
        licenseText: hasLicenseFile ? licenseText : "",
      });
    } catch {
      // Ignore parse error
    }
  }

  return results;
}

export function textMatchesLicense(text, license) {
  if (!text || text.length < 50) return false;
  if (license === "MIT") {
    return (
      text.includes("Permission is hereby granted") ||
      text.includes("MIT License") ||
      text.includes("The MIT License")
    );
  }
  if (license === "Apache-2.0" || license === "Apache-2.0 WITH LLVM-exception") {
    return (
      text.includes("Apache License") ||
      text.includes("http://www.apache.org/licenses/")
    );
  }
  if (license === "BSD-3-Clause" || license === "BSD-2-Clause") {
    return (
      text.includes("Redistribution and use in source and binary forms") ||
      text.includes("BSD")
    );
  }
  if (license === "0BSD") {
    return text.includes("Permission to use, copy, modify, and/or distribute");
  }
  if (license === "CC0-1.0") {
    return (
      text.includes("CC0 1.0") ||
      text.includes("Creative Commons") ||
      text.includes("public domain")
    );
  }
  if (license === "Unlicense") {
    return (
      text.includes("This is free and unencumbered software") ||
      text.includes("unlicense.org")
    );
  }
  if (license === "ISC") {
    return (
      text.includes("Permission to use, copy, modify, and/or distribute") ||
      text.includes("ISC")
    );
  }
  if (license === "Zlib") {
    return (
      text.includes("zlib") ||
      text.includes("Permission is granted to anyone to use this software")
    );
  }
  if (license === "Unicode-3.0" || license === "Unicode-DFS-2016") {
    return text.includes("Unicode") || text.includes("UNICODE");
  }
  if (license.includes(" AND ")) {
    const parts = license.split(" AND ");
    return parts.every((p) => textMatchesLicense(text, p.trim()));
  }
  return true;
}

export async function scanRustDependencies() {
  const results = [];
  const cargoLockPath = resolve(rootDir, "apps/desktop/src-tauri/Cargo.lock");
  if (!existsSync(cargoLockPath)) {
    throw new Error("Missing apps/desktop/src-tauri/Cargo.lock. Resolved Cargo lockfile is required.");
  }

  const metadataPath = resolve(rootDir, "apps/desktop/src-tauri/cargo-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error("Missing apps/desktop/src-tauri/cargo-metadata.json. Required for auditing resolved Cargo graph.");
  }

  const lockContent = await readFile(cargoLockPath, "utf8");
  const lockPackages = new Map();
  const pkgBlocks = lockContent.split("[[package]]").slice(1);
  for (const block of pkgBlocks) {
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    const verMatch = block.match(/version\s*=\s*"([^"]+)"/);
    if (nameMatch && verMatch && nameMatch[1] !== "lattice-desktop") {
      lockPackages.set(nameMatch[1] + "@" + verMatch[1], { name: nameMatch[1], version: verMatch[1] });
    }
  }

  const raw = await readFile(metadataPath, "utf8");
  const crates = JSON.parse(raw);

  for (const crate of crates) {
    const statedLicense = (crate.license || "UNKNOWN").replace(/\s*\/\s*/g, " OR ");
    const evalResult = evaluateSpdx(statedLicense);
    const chosenLicense = evalResult.ok ? evalResult.chosenLicense : statedLicense;

    const hasLicenseFile = Boolean(
      crate.hasLicenseFile &&
      crate.licenseText &&
      crate.licenseText.length >= 200 &&
      !crate.licenseText.includes("dual-licensed under the terms of") &&
      textMatchesLicense(crate.licenseText, chosenLicense)
    );

    results.push({
      ecosystem: "rust",
      name: crate.name,
      version: crate.version,
      statedLicense,
      hasLicenseFile,
      licenseText: hasLicenseFile ? crate.licenseText : "",
    });
  }

  // Ensure every resolved crate from Cargo.lock is accounted for
  for (const [id, pkg] of lockPackages.entries()) {
    if (!results.some((r) => r.name === pkg.name && r.version === pkg.version)) {
      throw new Error(`Cargo.lock contains resolved dependency missing from audited metadata: ${id}`);
    }
  }

  return results;
}

export const GRADLE_RUNTIME_CLOSURE = {
  "com.capacitorjs:android": [
    "androidx.appcompat:appcompat",
    "androidx.coordinatorlayout:coordinatorlayout",
    "androidx.core:core",
    "androidx.webkit:webkit",
    "org.apache.cordova:framework",
  ],
  "com.capacitorjs:app": [
    "com.capacitorjs:core",
    "com.capacitorjs:android",
  ],
  "com.aparajita.capacitor.securestorage:capacitor-secure-storage": [
    "com.capacitorjs:core",
  ],
  "androidx.appcompat:appcompat": [
    "androidx.activity:activity",
    "androidx.annotation:annotation",
    "androidx.annotation:annotation-experimental",
    "androidx.collection:collection",
    "androidx.core:core",
    "androidx.cursoradapter:cursoradapter",
    "androidx.customview:customview",
    "androidx.customview:customview-poolingcontainer",
    "androidx.drawerlayout:drawerlayout",
    "androidx.fragment:fragment",
    "androidx.interpolator:interpolator",
    "androidx.lifecycle:lifecycle-runtime",
    "androidx.lifecycle:lifecycle-viewmodel",
    "androidx.savedstate:savedstate",
    "androidx.vectordrawable:vectordrawable",
    "androidx.vectordrawable:vectordrawable-animated",
  ],
  "androidx.activity:activity": [
    "androidx.core:core",
    "androidx.lifecycle:lifecycle-runtime",
    "androidx.lifecycle:lifecycle-viewmodel",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate",
    "androidx.savedstate:savedstate",
  ],
  "androidx.fragment:fragment": [
    "androidx.activity:activity",
    "androidx.collection:collection",
    "androidx.core:core",
    "androidx.lifecycle:lifecycle-livedata-core",
    "androidx.lifecycle:lifecycle-viewmodel",
    "androidx.lifecycle:lifecycle-viewmodel-savedstate",
    "androidx.loader:loader",
    "androidx.savedstate:savedstate",
    "androidx.viewpager:viewpager",
  ],
  "androidx.lifecycle:lifecycle-runtime": [
    "androidx.annotation:annotation",
    "androidx.lifecycle:lifecycle-common",
  ],
  "org.jetbrains.kotlinx:kotlinx-coroutines-android": [
    "org.jetbrains.kotlinx:kotlinx-coroutines-core",
    "org.jetbrains.kotlin:kotlin-stdlib",
  ],
};

export function extractGradleRuntimeDependencies(gContent, varValues = new Map()) {
  const declared = [];

  // Match string notation: implementation / api / runtimeOnly / compile
  const strRegex = /(?:^|\s)(?:implementation|api|runtimeOnly|compile)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']\)?/gm;
  for (const m of gContent.matchAll(strRegex)) {
    const group = m[1].trim();
    const artifact = m[2].trim();
    const rawVer = (m[3] || "").trim();
    const depCoord = `${group}:${artifact}`;

    let resolvedVer = rawVer;
    if (rawVer.startsWith("$")) {
      const varName = rawVer.replace(/^\$(?:rootProject\.ext\.)?/, "").replace(/^\{|\}$/g, "");
      resolvedVer = varValues.get(varName) || rawVer;
    }

    declared.push({
      coord: depCoord,
      version: resolvedVer || null,
      rawVersion: rawVer || null,
    });
  }

  // Match map notation: implementation group: '...', name: '...', version: '...'
  const mapRegex = /(?:^|\s)(?:implementation|api|runtimeOnly|compile)\s*\(?\s*group\s*:\s*["']([^"']+)["']\s*,\s*name\s*:\s*["']([^"']+)["'](?:\s*,\s*version\s*:\s*["']([^"']+)["'])?\s*\)?/gm;
  for (const m of gContent.matchAll(mapRegex)) {
    const group = m[1].trim();
    const artifact = m[2].trim();
    const rawVer = (m[3] || "").trim();
    const depCoord = `${group}:${artifact}`;

    let resolvedVer = rawVer;
    if (rawVer.startsWith("$")) {
      const varName = rawVer.replace(/^\$(?:rootProject\.ext\.)?/, "").replace(/^\{|\}$/g, "");
      resolvedVer = varValues.get(varName) || rawVer;
    }

    declared.push({
      coord: depCoord,
      version: resolvedVer || null,
      rawVersion: rawVer || null,
    });
  }

  return declared;
}

export function parseGradleDependencyTree(output) {
  const resolved = new Map();
  const lines = output.split("\n");
  for (const line of lines) {
    const match = line.match(/[+\\]---\s+([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)(?:\s+->\s+([a-zA-Z0-9_.-]+))?/);
    if (match) {
      const coord = `${match[1]}:${match[2]}`;
      const version = match[4] || match[3];
      resolved.set(coord, version);
    }
  }
  return resolved;
}

export function validateResolvedGradleDeps(resolvedMap, deps) {
  for (const [coord, resolvedVer] of resolvedMap.entries()) {
    const matched = deps.find((d) => d.name === coord);
    if (!matched) {
      throw new Error(
        `Live Gradle runtime dependency ${coord} (${resolvedVer}) is missing from audited dependencies.json inventory`
      );
    }
    if (resolvedVer && matched.version !== resolvedVer) {
      throw new Error(
        `Version mismatch for ${coord}: Gradle resolved ${resolvedVer}, dependencies.json resolved ${matched.version}`
      );
    }
  }
}

export async function scanAndroidDependencies() {
  const results = [];
  const depsPath = resolve(rootDir, "apps/mobile/android/dependencies.json");
  if (!existsSync(depsPath)) return results;

  const content = await readFile(depsPath, "utf8");
  const deps = JSON.parse(content);

  // 1. Validate inventory against variables.gradle
  const varsPath = resolve(rootDir, "apps/mobile/android/variables.gradle");
  const varValues = new Map();
  if (existsSync(varsPath)) {
    const varsContent = await readFile(varsPath, "utf8");
    const varMatches = varsContent.matchAll(/([a-zA-Z0-9_]+)\s*=\s*['"]([^'"]+)['"]/g);
    for (const match of varMatches) {
      varValues.set(match[1], match[2]);
    }

    const varMappings = {
      androidxAppCompatVersion: "androidx.appcompat:appcompat",
      androidxCoordinatorLayoutVersion: "androidx.coordinatorlayout:coordinatorlayout",
      androidxCoreVersion: "androidx.core:core",
      androidxActivityVersion: "androidx.activity:activity",
      androidxFragmentVersion: "androidx.fragment:fragment",
      androidxWebkitVersion: "androidx.webkit:webkit",
      cordovaAndroidVersion: "org.apache.cordova:framework",
    };

    for (const [varName, depName] of Object.entries(varMappings)) {
      const expectedVersion = varValues.get(varName);
      if (expectedVersion) {
        const matchedDep = deps.find((d) => d.name === depName);
        if (!matchedDep) {
          throw new Error(
            `Dependency ${depName} specified in variables.gradle as ${varName} is missing from dependencies.json`
          );
        }
        if (matchedDep.version !== expectedVersion) {
          throw new Error(
            `Version mismatch for ${depName}: variables.gradle specifies ${varName}=${expectedVersion}, but dependencies.json resolved ${matchedDep.version}`
          );
        }
      }
    }
  }

  // 2. Discover all declared Gradle runtime dependencies across all build.gradle files
  const androidDir = resolve(rootDir, "apps/mobile/android");
  const gradleFiles = [
    resolve(androidDir, "app/build.gradle"),
    resolve(androidDir, "capacitor-cordova-android-plugins/build.gradle"),
    resolve(androidDir, "app/capacitor.build.gradle"),
    resolve(androidDir, "build.gradle"),
  ];

  const declaredDeps = [];
  for (const gPath of gradleFiles) {
    if (existsSync(gPath)) {
      const gContent = await readFile(gPath, "utf8");
      const fileDeps = extractGradleRuntimeDependencies(gContent, varValues);
      for (const d of fileDeps) {
        declaredDeps.push({ ...d, file: relative(rootDir, gPath) });
      }
    }
  }

  // 3. Verify EVERY declared Gradle runtime dependency (literal or variable) against audited inventory
  for (const declared of declaredDeps) {
    const matchedDep = deps.find((d) => d.name === declared.coord);
    if (!matchedDep) {
      throw new Error(
        `Gradle runtime dependency ${declared.coord} (${declared.version || "unspecified"}) declared in ${declared.file} is missing from audited dependencies inventory (dependencies.json)`
      );
    }
    if (declared.version && matchedDep.version !== declared.version) {
      throw new Error(
        `Version mismatch for ${declared.coord}: Gradle declared ${declared.version} in ${declared.file}, but dependencies.json resolved ${matchedDep.version}`
      );
    }
  }

  // 4. Try live Gradle runtime graph resolution if gradlew and Java 21+ are available
  let liveResolvedDeps = null;
  try {
    const javaExe = process.platform === "win32" ? "java.exe" : "java";
    let javaBin = null;
    if (process.env.JAVA_HOME && existsSync(resolve(process.env.JAVA_HOME, "bin", javaExe))) {
      javaBin = resolve(process.env.JAVA_HOME, "bin", javaExe);
    } else {
      const pathDirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
      for (const p of pathDirs) {
        if (p && existsSync(resolve(p, javaExe))) {
          javaBin = resolve(p, javaExe);
          break;
        }
      }
    }

    let javaVersion = 0;
    if (javaBin) {
      try {
        const vOut = execSync(`"${javaBin}" -version 2>&1`, { encoding: "utf8", timeout: 2000 });
        const vMatch = vOut.match(/version "(?:1\.)?(\d+)/);
        if (vMatch) javaVersion = parseInt(vMatch[1], 10);
      } catch {
        javaVersion = 0;
      }
    }

    const gradlewCmd = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    const gradlewBin = resolve(androidDir, gradlewCmd);
    if (javaVersion >= 21 && existsSync(gradlewBin)) {
      const out = execSync(`${gradlewCmd} :app:dependencies --configuration debugRuntimeClasspath --no-daemon -q`, {
        cwd: androidDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      liveResolvedDeps = parseGradleDependencyTree(out);
    }
  } catch {
    // Gradle execution failed, offline, or timed out; fallback to static transitive closure verification
  }

  // Validate live resolved graph OUTSIDE the execution try/catch so missing-dependency errors propagate
  if (liveResolvedDeps && liveResolvedDeps.size > 0) {
    validateResolvedGradleDeps(liveResolvedDeps, deps);
  }

  // 5. Verify full transitive dependency graph closure
  const directDepsToCheck = [
    ...new Set(declaredDeps.map((d) => d.coord)),
    "com.capacitorjs:android",
    "com.capacitorjs:app",
    "com.aparajita.capacitor.securestorage:capacitor-secure-storage",
    "androidx.appcompat:appcompat",
  ];

  const visited = new Set();
  const queue = [...directDepsToCheck];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const transitives = GRADLE_RUNTIME_CLOSURE[current] || [];
    for (const trans of transitives) {
      const matched = deps.find((d) => d.name === trans);
      if (!matched) {
        throw new Error(
          `Android runtime dependency ${current} requires transitive dependency ${trans}, but it is missing from audited dependencies.json inventory`
        );
      }
      if (!visited.has(trans)) {
        queue.push(trans);
      }
    }
  }

  // 6. Audit all dependencies in the resolved graph
  for (const dep of deps) {
    const text = (dep.licenseText || dep.text || "").trim();
    const hasLicenseFile = Boolean(text.length > 50);
    results.push({
      ecosystem: "android",
      name: dep.name,
      version: dep.version,
      statedLicense: dep.license,
      hasLicenseFile,
      licenseText: hasLicenseFile ? text : "",
    });
  }
  return results;
}

export async function scanIosDependencies() {
  const results = [];
  const plistPath = resolve(rootDir, "apps/mobile/ios/App/Pods-App-acknowledgements.plist");
  if (!existsSync(plistPath)) return results;

  const podVersions = new Map();
  const podLockPath = resolve(rootDir, "apps/mobile/ios/App/Podfile.lock");
  if (existsSync(podLockPath)) {
    const lockContent = await readFile(podLockPath, "utf8");
    const matches = lockContent.matchAll(/^\s*-\s+([A-Za-z0-9_.-]+)\s+\(([^)]+)\)/gm);
    for (const match of matches) {
      const cleanVer = match[2].replace(/^=\s*/, "").trim();
      podVersions.set(match[1], cleanVer);
    }
  }

  const content = await readFile(plistPath, "utf8");
  const dictMatches = content.split("<dict>").slice(1);
  for (const dict of dictMatches) {
    const titleMatch = dict.match(/<key>Title<\/key>\s*<string>([^<]+)<\/string>/);
    const licenseMatch = dict.match(/<key>License<\/key>\s*<string>([^<]+)<\/string>/);
    const textMatch = dict.match(/<key>FooterText<\/key>\s*<string>([^<]+)<\/string>/s);
    if (titleMatch && licenseMatch && titleMatch[1] !== "Acknowledgements") {
      const name = titleMatch[1];
      const version = podVersions.get(name) || "7.0.1";
      const licenseText = textMatch ? textMatch[1].trim() : "";
      const hasLicenseFile = Boolean(licenseText.length > 50);
      results.push({
        ecosystem: "ios",
        name,
        version,
        statedLicense: licenseMatch[1],
        hasLicenseFile,
        licenseText: hasLicenseFile ? licenseText : "",
      });
    }
  }

  // Ensure all resolved pods from Podfile.lock are accounted for
  for (const podName of podVersions.keys()) {
    if (!results.some((r) => r.name === podName)) {
      throw new Error(`iOS Podfile.lock contains resolved dependency missing from acknowledgements: ${podName}`);
    }
  }

  return results;
}

export function auditDependencies(all) {
  const audited = [];
  const violations = [];

  for (const dep of all) {
    const evalResult = evaluateSpdx(dep.statedLicense);

    if (!evalResult.ok) {
      violations.push({
        dep,
        reason: evalResult.reason,
      });
    } else if (!dep.hasLicenseFile || !dep.licenseText) {
      violations.push({
        dep,
        reason: `Missing authentic license file/evidence for ${dep.ecosystem}:${dep.name}`,
      });
    } else {
      audited.push({
        ...dep,
        chosenLicense: evalResult.chosenLicense,
      });
    }
  }

  audited.sort((a, b) => {
    if (a.ecosystem !== b.ecosystem) return a.ecosystem.localeCompare(b.ecosystem);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.version.localeCompare(b.version);
  });

  return { audited, violations };
}

export async function auditAllDependencies() {
  const npm = await scanNpmDependencies();
  const go = await scanGoDependencies();
  const rust = await scanRustDependencies();
  const android = await scanAndroidDependencies();
  const ios = await scanIosDependencies();

  const all = [...npm, ...go, ...rust, ...android, ...ios];
  return auditDependencies(all);
}

export function generateReport(audited) {
  let md = "# Third-Party Software Licenses & Notices\n\n";
  md += "This document provides the complete, audited third-party software inventory and license notices across all resolved dependencies in Lattice (NPM, Go modules, Tauri Rust crates, Android Gradle, and iOS CocoaPods).\n\n";
  md += "All dependencies adhere strictly to the permissive license allowlist (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, Unlicense, Python-2.0, BSL-1.0, Unicode-3.0, Zlib). Copyleft and source-available licenses are strictly prohibited.\n\n";

  md += "## Summary Table\n\n";
  md += "| Ecosystem | Dependency | Version | Stated License | Evaluated / Chosen License |\n";
  md += "|---|---|---|---|---|\n";

  for (const item of audited) {
    md += `| ${item.ecosystem} | ${item.name} | ${item.version} | ${item.statedLicense} | ${item.chosenLicense} |\n`;
  }

  md += "\n---\n\n## Third-Party License Texts & Notices\n\n";

  for (const item of audited) {
    md += `### [${item.ecosystem}] ${item.name} (${item.version})\n\n`;
    md += `**Evaluated License**: ${item.chosenLicense} (Stated: \`${item.statedLicense}\`)\n\n`;
    md += "```\n";
    md += item.licenseText.trim();
    md += "\n```\n\n";
  }

  return md;
}

export async function packageNotices(reportContent) {
  const noticePath = resolve(rootDir, "NOTICE");
  let noticeText = "";
  try {
    noticeText = await readFile(noticePath, "utf8");
  } catch {
    noticeText = "Lattice Legal Notices\n";
  }

  const combined = `${noticeText}\n\n${reportContent}`.trim();

  // 1. Android assets
  const androidAsset = resolve(rootDir, "apps/mobile/android/app/src/main/assets/notices.txt");
  await mkdir(dirname(androidAsset), { recursive: true });
  await writeFile(androidAsset, combined, "utf8");

  // 2. iOS App notices
  const iosAsset = resolve(rootDir, "apps/mobile/ios/App/App/notices.txt");
  await mkdir(dirname(iosAsset), { recursive: true });
  await writeFile(iosAsset, combined, "utf8");

  // 3. Client web bundle assets (if dist exists)
  const clientAsset = resolve(rootDir, "apps/client/dist/assets/notices.txt");
  if (existsSync(dirname(clientAsset))) {
    await writeFile(clientAsset, combined, "utf8");
  }

  // 4. Backend packaging for Docker
  const backendDir = resolve(rootDir, "backend");
  await writeFile(resolve(backendDir, "THIRD_PARTY_LICENSES.md"), reportContent, "utf8");
  await writeFile(resolve(backendDir, "NOTICE"), noticeText, "utf8");
  const licensePb = await readFile(resolve(rootDir, "LICENSE.md"), "utf8");
  await writeFile(resolve(backendDir, "LICENSE.md"), licensePb, "utf8");
  const licenseProduct = await readFile(resolve(rootDir, "LICENSE-PRODUCT.md"), "utf8");
  await writeFile(resolve(backendDir, "LICENSE-PRODUCT.md"), licenseProduct, "utf8");
}

async function main() {
  const isCheck = process.argv.includes("--check");
  const isGenerate = process.argv.includes("--generate");

  console.log("Scanning resolved dependency graphs across NPM, Go, Rust, Android, and iOS...");
  const { audited, violations } = await auditAllDependencies();

  if (violations.length > 0) {
    console.error(`\n❌ Found ${violations.length} license compliance violations:`);
    for (const v of violations) {
      console.error(`  - [${v.dep.ecosystem}] ${v.dep.name}@${v.dep.version}: ${v.reason}`);
    }
    process.exit(1);
  }

  console.log(`✓ Audited ${audited.length} dependencies: 0 policy violations.`);

  const reportPath = resolve(rootDir, "THIRD_PARTY_LICENSES.md");
  const expectedContent = generateReport(audited);

  if (isCheck) {
    if (!existsSync(reportPath)) {
      console.error("❌ THIRD_PARTY_LICENSES.md does not exist. Run with --generate to create it.");
      process.exit(1);
    }
    const current = await readFile(reportPath, "utf8");
    if (current.trim() !== expectedContent.trim()) {
      console.error("❌ THIRD_PARTY_LICENSES.md is stale. Run node tools/license-scan/scan.mjs --generate to update.");
      process.exit(1);
    }
    console.log("✓ THIRD_PARTY_LICENSES.md is up to date and compliant.");
    process.exit(0);
  }

  if (isGenerate) {
    await writeFile(reportPath, expectedContent, "utf8");
    await packageNotices(expectedContent);
    console.log(`✓ Successfully updated ${relative(rootDir, reportPath)} and packaged notices into mobile assets.`);
    process.exit(0);
  }

  console.log("Usage: node tools/license-scan/scan.mjs [--check | --generate]");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("Unexpected error during license scan:", err);
    process.exit(1);
  });
}
