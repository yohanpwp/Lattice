/**
 * SPDX boolean expression tokenizer, AST parser, and policy evaluator.
 */

export const ALLOWED_LICENSES = new Set([
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
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Zlib",
  "MIT-0",
]);

export const ALLOWED_EXCEPTIONS = new Set([
  "LLVM-exception",
  "Apache-2.0-Clause-Exception",
]);

export function isProhibitedLicense(license) {
  if (!license || typeof license !== "string") return false;
  const upper = license.trim().toUpperCase();
  if (/^AGPL/i.test(upper)) return true;
  if (/^LGPL/i.test(upper)) return true;
  if (/^GPL/i.test(upper)) return true;
  if (/^BUSL/i.test(upper)) return true;
  if (/^SSPL/i.test(upper)) return true;
  if (/^OSL/i.test(upper)) return true;
  if (/^EUPL/i.test(upper)) return true;
  if (/^CPAL/i.test(upper)) return true;
  if (/^MPL/i.test(upper)) return true;
  return false;
}

export function normalizeLicenseId(name) {
  if (!name) return "";
  const trimmed = name.trim();
  // Standardize common variations
  if (/^Apache[ -]?2(\.0)?$/i.test(trimmed)) return "Apache-2.0";
  if (/^MIT$/i.test(trimmed)) return "MIT";
  if (/^BSD[ -]?3[ -]?Clause$/i.test(trimmed)) return "BSD-3-Clause";
  if (/^BSD[ -]?2[ -]?Clause$/i.test(trimmed)) return "BSD-2-Clause";
  if (/^ISC$/i.test(trimmed)) return "ISC";
  if (/^0BSD$/i.test(trimmed)) return "0BSD";
  if (/^CC0[ -]?1(\.0)?$/i.test(trimmed)) return "CC0-1.0";
  if (/^Unlicense$/i.test(trimmed)) return "Unlicense";
  if (/^Python[ -]?2(\.0)?$/i.test(trimmed)) return "Python-2.0";
  if (/^BSL[ -]?1(\.0)?$/i.test(trimmed)) return "BSL-1.0";
  if (/^BlueOak[ -]?1(\.0(\.0)?)?$/i.test(trimmed)) return "BlueOak-1.0.0";
  if (/^CC[ -]?BY[ -]?4(\.0)?$/i.test(trimmed)) return "CC-BY-4.0";
  if (/^CC[ -]?BY[ -]?3(\.0)?$/i.test(trimmed)) return "CC-BY-3.0";
  if (/^Unicode-3\.0$/i.test(trimmed)) return "Unicode-3.0";
  if (/^Unicode-DFS-2016$/i.test(trimmed)) return "Unicode-DFS-2016";
  if (/^Zlib$/i.test(trimmed)) return "Zlib";
  if (/^MIT-0$/i.test(trimmed)) return "MIT-0";
  return trimmed;
}

export function tokenizeSpdx(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "LPAREN", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", value: ")" });
      i++;
      continue;
    }
    let j = i;
    while (j < input.length && !/\s|\(|\)/.test(input[j])) {
      j++;
    }
    const word = input.slice(i, j);
    if (word === "AND" || word === "and") {
      tokens.push({ type: "AND", value: "AND" });
    } else if (word === "OR" || word === "or") {
      tokens.push({ type: "OR", value: "OR" });
    } else if (word === "WITH" || word === "with") {
      tokens.push({ type: "WITH", value: "WITH" });
    } else {
      tokens.push({ type: "ID", value: word });
    }
    i = j;
  }
  return tokens;
}

export function parseSpdx(input) {
  const tokens = tokenizeSpdx(input);
  if (tokens.length === 0) {
    throw new Error("Empty SPDX expression");
  }

  let index = 0;

  function peek() {
    return tokens[index];
  }

  function consume(type) {
    const tok = tokens[index];
    if (!tok || (type && tok.type !== type)) {
      throw new Error(`Expected token ${type}, found ${tok ? tok.type : "EOF"}`);
    }
    index++;
    return tok;
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) {
      throw new Error("Unexpected end of expression");
    }
    if (tok.type === "LPAREN") {
      consume("LPAREN");
      const expr = parseOr();
      consume("RPAREN");
      return expr;
    }
    if (tok.type === "ID") {
      consume("ID");
      return { type: "ID", name: tok.value };
    }
    throw new Error(`Unexpected token: ${tok.value}`);
  }

  function parseWith() {
    let expr = parsePrimary();
    while (peek() && peek().type === "WITH") {
      consume("WITH");
      const exception = parsePrimary();
      expr = { type: "WITH", base: expr, exception };
    }
    return expr;
  }

  function parseAnd() {
    let expr = parseWith();
    while (peek() && peek().type === "AND") {
      consume("AND");
      const right = parseWith();
      expr = { type: "AND", left: expr, right };
    }
    return expr;
  }

  function parseOr() {
    let expr = parseAnd();
    while (peek() && peek().type === "OR") {
      consume("OR");
      const right = parseAnd();
      expr = { type: "OR", left: expr, right };
    }
    return expr;
  }

  const ast = parseOr();
  if (index < tokens.length) {
    throw new Error(`Unexpected trailing tokens starting at ${tokens[index].value}`);
  }
  return ast;
}

export function evaluateAst(node) {
  if (!node) {
    return { ok: false, violations: ["empty"], reason: "Empty AST node" };
  }

  if (node.type === "ID") {
    const normalized = normalizeLicenseId(node.name);
    if (isProhibitedLicense(normalized)) {
      return {
        ok: false,
        violations: [node.name],
        reason: `Prohibited copyleft or source-available license: ${node.name}`,
      };
    }
    if (ALLOWED_LICENSES.has(normalized)) {
      return { ok: true, chosenLicense: normalized };
    }
    return {
      ok: false,
      violations: [node.name],
      reason: `Unrecognized or unapproved license identifier: ${node.name}`,
    };
  }

  if (node.type === "WITH") {
    const baseResult = evaluateAst(node.base);
    if (!baseResult.ok) {
      return baseResult;
    }
    const exceptionName = node.exception.name;
    if (ALLOWED_EXCEPTIONS.has(exceptionName)) {
      return {
        ok: true,
        chosenLicense: `${baseResult.chosenLicense} WITH ${exceptionName}`,
      };
    }
    return {
      ok: false,
      violations: [exceptionName],
      reason: `Unapproved exception: ${exceptionName}`,
    };
  }

  if (node.type === "AND") {
    const left = evaluateAst(node.left);
    const right = evaluateAst(node.right);
    if (left.ok && right.ok) {
      return {
        ok: true,
        chosenLicense: `${left.chosenLicense} AND ${right.chosenLicense}`,
      };
    }
    const violations = [
      ...(left.violations || []),
      ...(right.violations || []),
    ];
    return {
      ok: false,
      violations,
      reason: left.reason || right.reason,
    };
  }

  if (node.type === "OR") {
    const left = evaluateAst(node.left);
    const right = evaluateAst(node.right);
    // If left is approved, choose left
    if (left.ok) {
      return { ok: true, chosenLicense: left.chosenLicense };
    }
    // Else if right is approved, choose right
    if (right.ok) {
      return { ok: true, chosenLicense: right.chosenLicense };
    }
    const violations = [
      ...(left.violations || []),
      ...(right.violations || []),
    ];
    return {
      ok: false,
      violations,
      reason: `No approved alternative in OR expression: ${left.reason}; ${right.reason}`,
    };
  }

  return { ok: false, violations: [String(node)], reason: `Unknown AST node type: ${node.type}` };
}

export function evaluateSpdx(expression) {
  if (!expression || typeof expression !== "string" || expression.trim() === "") {
    return { ok: false, violations: ["missing"], reason: "Missing license expression" };
  }
  try {
    const normalized = expression.replace(/\s*\/\s*/g, " OR ");
    const ast = parseSpdx(normalized);
    return evaluateAst(ast);
  } catch (err) {
    return {
      ok: false,
      violations: [expression],
      reason: `SPDX parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
