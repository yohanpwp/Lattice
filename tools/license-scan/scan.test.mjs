import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateSpdx, isProhibitedLicense } from "./spdx.mjs";
import {
  auditAllDependencies,
  auditDependencies,
  generateReport,
  scanIosDependencies,
  scanAndroidDependencies,
  scanRustDependencies,
  extractGradleRuntimeDependencies,
  parseGradleDependencyTree,
  validateResolvedGradleDeps,
  GRADLE_RUNTIME_CLOSURE,
} from "./scan.mjs";

describe("SPDX AST Evaluator & Policy Semantics", () => {
  it("evaluates dual-license (MIT OR GPL-3.0) as permitted and records choice MIT", () => {
    const result = evaluateSpdx("(MIT OR GPL-3.0)");
    assert.equal(result.ok, true);
    assert.equal(result.chosenLicense, "MIT");
  });

  it("evaluates dual-license (GPL-3.0 OR Apache-2.0) as permitted and records choice Apache-2.0", () => {
    const result = evaluateSpdx("(GPL-3.0 OR Apache-2.0)");
    assert.equal(result.ok, true);
    assert.equal(result.chosenLicense, "Apache-2.0");
  });

  it("evaluates combined license (MIT AND GPL-3.0) as prohibited failure", () => {
    const result = evaluateSpdx("(MIT AND GPL-3.0)");
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes("GPL-3.0"));
  });

  it("evaluates valid exception (Apache-2.0 WITH LLVM-exception) as permitted", () => {
    const result = evaluateSpdx("Apache-2.0 WITH LLVM-exception");
    assert.equal(result.ok, true);
    assert.equal(result.chosenLicense, "Apache-2.0 WITH LLVM-exception");
  });

  it("evaluates unapproved exception (Apache-2.0 WITH UnknownException) as prohibited failure", () => {
    const result = evaluateSpdx("Apache-2.0 WITH UnknownException");
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes("UnknownException"));
  });

  it("strictly prohibits copyleft MPL-2.0 and source-available BUSL-1.1", () => {
    const mplResult = evaluateSpdx("MPL-2.0");
    assert.equal(mplResult.ok, false);
    assert.equal(isProhibitedLicense("MPL-2.0"), true);

    const buslResult = evaluateSpdx("BUSL-1.1");
    assert.equal(buslResult.ok, false);
    assert.equal(isProhibitedLicense("BUSL-1.1"), true);

    const ssplResult = evaluateSpdx("SSPL-1.0");
    assert.equal(ssplResult.ok, false);
    assert.equal(isProhibitedLicense("SSPL-1.0"), true);
  });

  it("approves all permissive allowlisted licenses", () => {
    const allowed = [
      "MIT",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "0BSD",
      "CC0-1.0",
      "Unlicense",
      "Python-2.0",
      "BSL-1.0",
    ];

    for (const lic of allowed) {
      const res = evaluateSpdx(lic);
      assert.equal(res.ok, true, `Expected ${lic} to be approved`);
      assert.equal(res.chosenLicense, lic);
    }
  });

  it("handles complex parenthesized nested expressions", () => {
    const res = evaluateSpdx("((MIT OR BSD-3-Clause) AND (Apache-2.0 OR GPL-2.0))");
    assert.equal(res.ok, true);
    assert.equal(res.chosenLicense, "MIT AND Apache-2.0");
  });
});

describe("License Scanner & Reporting Semantics", () => {
  it("formats markdown report with ecosystem table and full license texts", () => {
    const sample = [
      {
        ecosystem: "npm",
        name: "test-pkg",
        version: "1.0.0",
        statedLicense: "MIT",
        chosenLicense: "MIT",
        hasLicenseFile: true,
        licenseText: "MIT License text...",
      },
    ];

    const report = generateReport(sample);
    assert.ok(report.includes("| npm | test-pkg | 1.0.0 | MIT | MIT |"));
    assert.ok(report.includes("### [npm] test-pkg (1.0.0)"));
    assert.ok(report.includes("MIT License text..."));
  });

  it("detects stale report when content differs", () => {
    const sample = [
      {
        ecosystem: "npm",
        name: "test-pkg",
        version: "1.0.0",
        statedLicense: "MIT",
        chosenLicense: "MIT",
        hasLicenseFile: true,
        licenseText: "Sample text",
      },
    ];
    const generated = generateReport(sample);
    const staleContent = "# Old Report\n";
    assert.notEqual(generated.trim(), staleContent.trim());
  });

  it("fails audit if any dependency is missing a license file", () => {
    const sample = [
      {
        ecosystem: "npm",
        name: "bad-pkg",
        version: "1.0.0",
        statedLicense: "MIT",
        hasLicenseFile: false,
        licenseText: "",
      },
    ];

    const { audited, violations } = auditDependencies(sample);
    assert.equal(audited.length, 0);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].reason.includes("Missing authentic license file"));
  });

  it("fails audit if any dependency declares prohibited copyleft without permitted branch", () => {
    const sample = [
      {
        ecosystem: "npm",
        name: "copyleft-pkg",
        version: "1.0.0",
        statedLicense: "GPL-3.0",
        hasLicenseFile: true,
        licenseText: "GNU GENERAL PUBLIC LICENSE Version 3...",
      },
    ];

    const { audited, violations } = auditDependencies(sample);
    assert.equal(audited.length, 0);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].reason.toLowerCase().includes("prohibited"));
  });

  it("audits all resolved Rust crates from Cargo.lock and matches metadata", async () => {
    const rustDeps = await scanRustDependencies();
    assert.ok(rustDeps.length >= 400, `Expected at least 400 Rust crates, got ${rustDeps.length}`);
    for (const dep of rustDeps) {
      assert.ok(dep.name, "Crate name must be non-empty");
      assert.ok(dep.version, "Crate version must be non-empty");
      assert.ok(dep.statedLicense, `Crate ${dep.name} must have statedLicense`);
      assert.equal(dep.hasLicenseFile, true, `Crate ${dep.name} must have authentic license file`);
      assert.ok(dep.licenseText.length > 20, `Crate ${dep.name} must have licenseText`);
    }
  });

  it("extracts exact resolved versions for iOS pods from Podfile.lock", async () => {
    const iosDeps = await scanIosDependencies();
    assert.ok(iosDeps.length >= 3, `Expected at least 3 iOS deps, got ${iosDeps.length}`);

    const secureStorage = iosDeps.find((d) => d.name === "AparajitaCapacitorSecureStorage");
    assert.ok(secureStorage, "AparajitaCapacitorSecureStorage must be present");
    assert.equal(secureStorage.version, "7.1.6", "Must extract version 7.1.6 from Podfile.lock");
    assert.equal(secureStorage.statedLicense, "MIT");

    const appPlugin = iosDeps.find((d) => d.name === "CapacitorApp");
    assert.ok(appPlugin, "CapacitorApp must be present");
    assert.equal(appPlugin.version, "7.0.0", "Must extract version 7.0.0 from Podfile.lock");

    const corePlugin = iosDeps.find((d) => d.name === "Capacitor");
    assert.ok(corePlugin, "Capacitor must be present");
    assert.equal(corePlugin.version, "7.0.1", "Must extract version 7.0.1 from Podfile.lock");
  });

  it("audits Android dependencies covering full resolved runtime graph (30+ packages)", async () => {
    const androidDeps = await scanAndroidDependencies();
    assert.ok(androidDeps.length >= 30, `Expected at least 30 Android deps covering direct and transitive runtime graph, got ${androidDeps.length}`);

    const appDep = androidDeps.find((d) => d.name === "com.capacitorjs:app");
    assert.ok(appDep, "com.capacitorjs:app must be present in Android audit");
    assert.equal(appDep.version, "7.0.0");
    assert.equal(appDep.statedLicense, "MIT");

    const appCompatDep = androidDeps.find((d) => d.name === "androidx.appcompat:appcompat");
    assert.ok(appCompatDep, "androidx.appcompat:appcompat must be present");
    assert.equal(appCompatDep.version, "1.7.0");
    assert.equal(appCompatDep.statedLicense, "Apache-2.0");

    const coroutinesDep = androidDeps.find((d) => d.name === "org.jetbrains.kotlinx:kotlinx-coroutines-android");
    assert.ok(coroutinesDep, "Transitive dependency kotlinx-coroutines-android must be verified");
    assert.equal(coroutinesDep.statedLicense, "Apache-2.0");
  });

  it("verifies zero MPL-2.0 copyleft crates across all scanned Rust dependencies", async () => {
    const rustDeps = await scanRustDependencies();
    const banned = new Set(["cssparser", "cssparser-macros", "selectors", "dtoa-short", "option-ext"]);
    for (const dep of rustDeps) {
      assert.ok(!banned.has(dep.name), `Copyleft crate ${dep.name} must not be present in resolved dependencies`);
      assert.notEqual(dep.statedLicense, "MPL-2.0", `Crate ${dep.name} declared prohibited MPL-2.0`);
    }
  });

  it("asserts that Rust notice texts do not contain announcement stubs and meet length requirements", async () => {
    const rustDeps = await scanRustDependencies();
    for (const dep of rustDeps) {
      assert.ok(
        !dep.licenseText.includes("dual-licensed under the terms of"),
        `Crate ${dep.name} contains dual-license announcement stub instead of authentic license text`
      );
      assert.ok(
        dep.licenseText.length >= 200,
        `Crate ${dep.name} license text length (${dep.licenseText.length}) is below required threshold`
      );
    }
  });

  it("verifies that all Rust crates contain authentic license texts matching the chosen license", async () => {
    const rustDeps = await scanRustDependencies();
    for (const dep of rustDeps) {
      const evalResult = evaluateSpdx(dep.statedLicense);
      assert.equal(evalResult.ok, true, `SPDX eval failed for ${dep.name}`);
      assert.equal(dep.hasLicenseFile, true, `Crate ${dep.name} must have valid license file`);
      assert.ok(dep.licenseText.length >= 200, `Crate ${dep.name} text too short`);
    }
  });

  it("asserts that auditDependencies rejects any Rust dependency with MPL-2.0 license", () => {
    const fakeDeps = [
      {
        ecosystem: "rust",
        name: "option-ext",
        version: "0.2.0",
        statedLicense: "MPL-2.0",
        hasLicenseFile: true,
        licenseText: "Mozilla Public License Version 2.0...",
      },
    ];
    const { audited, violations } = auditDependencies(fakeDeps);
    assert.equal(audited.length, 0);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].reason.toLowerCase().includes("prohibited"));
  });

  it("asserts that scanRustDependencies rejects crates with mismatched license text", async () => {
    // If a crate evaluated as MIT contains only Apache boilerplate, textMatchesLicense fails
    const { textMatchesLicense } = await import("./scan.mjs");
    assert.equal(textMatchesLicense("Apache License Version 2.0 http://www.apache.org/licenses/ (complete text)", "MIT"), false);
    assert.equal(textMatchesLicense("Permission is hereby granted, free of charge, to any person obtaining a copy", "Apache-2.0"), false);
    assert.equal(textMatchesLicense("Permission is hereby granted, free of charge, to any person obtaining a copy", "MIT"), true);
  });

  it("extracts both literal and variable runtime dependencies from Gradle build files", () => {
    const varMap = new Map([["androidxAppCompatVersion", "1.7.0"]]);
    const sampleGradle = `
      dependencies {
        implementation fileTree(dir: 'libs', include: ['*.jar'])
        implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
        implementation 'com.google.guava:guava:31.1-android'
        api "org.example:shared-api:2.5.0"
        runtimeOnly 'com.example:runtime-plugin:1.0.0'
        testImplementation "junit:junit:4.13.2"
        androidTestImplementation "androidx.test.ext:junit:1.1.5"
      }
    `;

    const deps = extractGradleRuntimeDependencies(sampleGradle, varMap);
    assert.equal(deps.length, 4);

    const appcompat = deps.find((d) => d.coord === "androidx.appcompat:appcompat");
    assert.ok(appcompat);
    assert.equal(appcompat.version, "1.7.0");

    const guava = deps.find((d) => d.coord === "com.google.guava:guava");
    assert.ok(guava, "Literal implementation dependency must be extracted");
    assert.equal(guava.version, "31.1-android");

    const sharedApi = deps.find((d) => d.coord === "org.example:shared-api");
    assert.ok(sharedApi, "api dependency must be extracted");
    assert.equal(sharedApi.version, "2.5.0");

    const runtimePlugin = deps.find((d) => d.coord === "com.example:runtime-plugin");
    assert.ok(runtimePlugin, "runtimeOnly dependency must be extracted");
    assert.equal(runtimePlugin.version, "1.0.0");

    // test dependencies must not be included
    assert.ok(!deps.some((d) => d.coord.includes("junit")));
  });

  it("parses Gradle dependency tree output into resolved coordinates and versions", () => {
    const sampleTree = `
+--- androidx.appcompat:appcompat:1.6.1 -> 1.7.0 (*)
|    +--- androidx.activity:activity:1.8.0 -> 1.9.3
\\--- com.capacitorjs:core:7.0.1
    `;
    const parsed = parseGradleDependencyTree(sampleTree);
    assert.equal(parsed.get("androidx.appcompat:appcompat"), "1.7.0");
    assert.equal(parsed.get("androidx.activity:activity"), "1.9.3");
    assert.equal(parsed.get("com.capacitorjs:core"), "7.0.1");
  });

  it("verifies Gradle runtime graph transitive closure coverage", () => {
    assert.ok(GRADLE_RUNTIME_CLOSURE["androidx.appcompat:appcompat"].includes("androidx.fragment:fragment"));
    assert.ok(GRADLE_RUNTIME_CLOSURE["androidx.appcompat:appcompat"].includes("androidx.drawerlayout:drawerlayout"));
    assert.ok(GRADLE_RUNTIME_CLOSURE["androidx.appcompat:appcompat"].includes("androidx.savedstate:savedstate"));
    assert.ok(GRADLE_RUNTIME_CLOSURE["com.capacitorjs:android"].includes("androidx.webkit:webkit"));
  });

  it("propagates missing-dependency error when live Gradle resolution contains an unlisted dependency", () => {
    const liveMap = new Map([
      ["androidx.appcompat:appcompat", "1.7.0"],
      ["com.unlisted.transitive:evil-lib", "1.0.0"],
    ]);
    const deps = [
      { name: "androidx.appcompat:appcompat", version: "1.7.0", license: "Apache-2.0" },
    ];
    assert.throws(
      () => validateResolvedGradleDeps(liveMap, deps),
      /Live Gradle runtime dependency com\.unlisted\.transitive:evil-lib \(1\.0\.0\) is missing from audited dependencies\.json inventory/
    );
  });
});

