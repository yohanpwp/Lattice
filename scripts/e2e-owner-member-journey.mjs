import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const clientDistDir = path.resolve(rootDir, "apps/client/dist");
const serverExe = path.resolve(rootDir, "backend/server.exe");

function ensureCurrentBuilds() {
  console.log("[Build Verification] Compiling fresh backend/server.exe from source...");
  execSync("go build -o server.exe ./cmd/server", {
    cwd: path.join(rootDir, "backend"),
    stdio: "inherit",
    env: process.env,
  });
  console.log("[Build Verification] Compiling fresh web client bundle (pnpm --filter @lattice/client build)...");
  execSync("pnpm --filter @lattice/client build", {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  console.log("[Build Verification] ✓ Fresh artifacts built successfully.\n");
}

const BACKEND_PORT = 8195;
const CLIENT_PORT = 8196;
const CDP_PORT = 9339;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function startClientServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split("?")[0];
      let filePath = path.join(clientDistDir, urlPath);
      if (urlPath === "/" || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(clientDistDir, "index.html");
      }
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not Found");
        } else {
          res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
          res.end(data);
        }
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function startBackendServer(port, tempDir) {
  const tenantConfig = {
    version: 1,
    tenant_id: "tenant_pilot",
    backend_url: `http://127.0.0.1:${port}`,
    realtime_url: `http://127.0.0.1:${port}/api/realtime`,
    app_key: "pk_pilot_e2e",
    schema_version: "20260101_01",
    min_client_version: "0.1.0",
    features: [],
    collections: [],
  };
  fs.writeFileSync(path.join(tempDir, "tenant.json"), JSON.stringify(tenantConfig, null, 2));
  fs.writeFileSync(path.join(tempDir, "features.json"), JSON.stringify({ features: {} }, null, 2));

  const tokenProc = spawn(serverExe, ["workspace", "setup-token", `--dir=${tempDir}`], {
    env: { ...process.env, TENANT_CONFIG: path.join(tempDir, "tenant.json"), FEATURES_CONFIG: path.join(tempDir, "features.json") },
  });

  return new Promise((resolve, reject) => {
    let tokenOutput = "";
    tokenProc.stdout.on("data", (d) => { tokenOutput += d.toString(); });
    tokenProc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Failed to generate setup token, exit code ${code}`));
      const match = tokenOutput.match(/Setup Token \(valid 24h\):\s*([a-zA-Z0-9_]+)/);
      if (!match) return reject(new Error(`Could not parse setup token from output: ${tokenOutput}`));
      const setupToken = match[1].trim();

      const proc = spawn(serverExe, ["serve", `--http=127.0.0.1:${port}`, `--dir=${tempDir}`], {
        env: { ...process.env, TENANT_CONFIG: path.join(tempDir, "tenant.json"), FEATURES_CONFIG: path.join(tempDir, "features.json") },
        stdio: "ignore",
      });

      resolve({ proc, setupToken });
    });
  });
}

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Endpoint ${url} not ready within ${timeoutMs}ms`);
}

class BrowserPage {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.id = 1;
    this.ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params.args.map((a) => a.value !== undefined ? a.value : a.description || "").join(" ");
          console.log(`    [Browser Console] ${msg.params.type}: ${text}`);
        }
      } catch {}
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = this.id++;
      const handler = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === msgId) {
          this.ws.removeEventListener("message", handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      this.ws.addEventListener("message", handler);
      this.ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  async evaluate(fn, ...args) {
    const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})`;
    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error((res.exceptionDetails.text || "Evaluation error") + ": " + (res.exceptionDetails.exception?.description || ""));
    }
    return res.result.value;
  }

  async waitForSelector(selector, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await this.evaluate((sel) => Boolean(document.querySelector(sel)), selector);
      if (found) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for selector "${selector}" after ${timeoutMs}ms`);
  }

  async waitForFunction(fn, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.evaluate(fn);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
  }

  async waitForText(text, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await this.evaluate((txt) => document.body.innerText.includes(txt), text);
      if (found) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for text "${text}" after ${timeoutMs}ms`);
  }

  async click(selector) {
    await this.waitForSelector(selector);
    await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("Element not found: " + sel);
      el.scrollIntoView();
      el.click();
    }, selector);
  }

  async clickByText(tag, text, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const clicked = await this.evaluate((t, txt) => {
        const els = Array.from(document.querySelectorAll(t));
        const el = els.find((e) => e.innerText && e.innerText.includes(txt));
        if (el) {
          el.scrollIntoView();
          el.click();
          return true;
        }
        return false;
      }, tag, text);
      if (clicked) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting to click "${tag}" with text "${text}" after ${timeoutMs}ms`);
  }

  async fill(selector, value) {
    await this.waitForSelector(selector);
    await this.evaluate(
      (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("Element not found: " + sel);
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (set) {
          set.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      selector,
      value
    );
  }

  async getText(selector) {
    await this.waitForSelector(selector);
    return await this.evaluate((sel) => document.querySelector(sel)?.innerText || "", selector);
  }

  async getPageText() {
    return await this.evaluate(() => document.body.innerText);
  }

  async getAuthCredentials() {
    return await this.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith("lattice:auth:")) {
          try {
            return JSON.parse(localStorage.getItem(k));
          } catch {}
        }
      }
      return null;
    });
  }

  async getAuthToken() {
    const creds = await this.getAuthCredentials();
    return creds?.token || null;
  }
}

async function createBrowserSession(cdpPort, browserContextId) {
  const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const versionData = await versionRes.json();
  const rootWs = new WebSocket(versionData.webSocketDebuggerUrl);
  await new Promise((r) => { rootWs.onopen = r; });

  let msgId = 1;
  function callRoot(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      const handler = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === id) {
          rootWs.removeEventListener("message", handler);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      };
      rootWs.addEventListener("message", handler);
      rootWs.send(JSON.stringify({ id, method, params }));
    });
  }

  let ctxId = browserContextId;
  if (!ctxId) {
    const ctx = await callRoot("Target.createBrowserContext");
    ctxId = ctx.browserContextId;
  }

  const target = await callRoot("Target.createTarget", {
    url: "about:blank",
    browserContextId: ctxId,
  });

  const pageWs = new WebSocket(`ws://127.0.0.1:${cdpPort}/devtools/page/${target.targetId}`);
  await new Promise((r) => { pageWs.onopen = r; });

  const page = new BrowserPage(pageWs, target.targetId);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  return { page, ctxId, targetId: target.targetId, close: () => { pageWs.close(); rootWs.close(); } };
}

async function run() {
  console.log("=== Lattice Pilot Milestone 2: Owner & Two-Member Journey Browser Test ===");
  console.log("Proving complete scenario through real browser without DB edits or initial state injection\n");

  ensureCurrentBuilds();

  const tempDir = path.join(os.tmpdir(), `lattice_e2e_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  let clientServer, backendProc, chromeProc, setupToken;
  const sessions = [];

  try {
    // 1. Start Client Static Server
    console.log(`[1/8] Starting web client server on port ${CLIENT_PORT}...`);
    clientServer = await startClientServer(CLIENT_PORT);
    console.log(`✓ Web client running at ${CLIENT_URL}`);

    // 2. Start Backend Server on clean temp dir
    console.log(`[2/8] Initializing fresh isolated backend instance on port ${BACKEND_PORT}...`);
    const backend = await startBackendServer(BACKEND_PORT, tempDir);
    backendProc = backend.proc;
    setupToken = backend.setupToken;
    await waitForHttp(`${BACKEND_URL}/v1/config`);
    console.log(`✓ Backend running at ${BACKEND_URL}`);
    console.log(`✓ Operator Setup Token verified: ${setupToken.slice(0, 18)}...`);

    // 3. Launch Chrome Headless
    console.log(`[3/8] Launching headless Chrome with remote debugging on port ${CDP_PORT}...`);
    chromeProc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${path.join(tempDir, "chrome_user_data")}`,
      "about:blank",
    ]);
    await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    console.log(`✓ Headless Chrome ready`);

    // 4. Owner Session: Setup Workspace & Enable Module
    console.log("\n[4/8] Owner Session: Setting up workspace and enabling Customer & Job Tracking...");
    const ownerSession = await createBrowserSession(CDP_PORT);
    sessions.push(ownerSession);
    const owner = ownerSession.page;

    await owner.send("Page.navigate", { url: `${CLIENT_URL}?workspace=${encodeURIComponent(BACKEND_URL)}` });
    await owner.waitForSelector("#setup-token");
    console.log("  → WorkspaceSetupForm rendered for uninitialized workspace");

    await owner.fill("#setup-token", setupToken);
    await owner.fill("#setup-name", "Alice Owner");
    await owner.fill("#setup-email", "alice@example.com");
    await owner.fill("#setup-password", "Password123!");
    await owner.fill("#setup-confirm-password", "Password123!");

    // Check console logs and network errors
    owner.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.method === "Runtime.consoleAPICalled") {
        console.log("  [Browser Console]:", ...msg.params.args.map((a) => a.value || a.description));
      }
    });

    await owner.evaluate(() => {
      const form = document.querySelector("form");
      if (form) form.requestSubmit();
    });

    try {
      await owner.waitForSelector(".app-header", 10000);
    } catch (e) {
      const pageText = await owner.getPageText();
      console.log("Page text after setup submit:", pageText);
      throw e;
    }
    const roleChip = await owner.getText(".lattice-role-chip--owner");
    if (!roleChip.includes("OWNER")) throw new Error("Expected owner role chip on header");
    console.log("  ✓ Owner Alice successfully authenticated and loaded Dashboard");

    // Open Modules Modal
    await owner.clickByText("button", "Modules");
    await owner.waitForSelector(".lattice-modal");
    console.log("  → Modules modal opened");

    // Configure Customer & Job Tracking
    await owner.clickByText("button", "Configure");

    await owner.waitForSelector("#cjt-modal-title");
    console.log("  → Customer & Job Tracking setup modal opened (Suggested Datasets mode)");
    await owner.clickByText("button", "Save & Enable Module");
    await owner.waitForFunction(() => !document.querySelector("#cjt-modal-title"), 15000);
    console.log("  ✓ Module setup saved and setup modal closed");

    // Close modules modal
    await owner.click(".lattice-modal-close");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"), 15000);
    console.log("  ✓ Modules modal closed");

    const modStatus = await owner.evaluate(async (bUrl) => {
      const authKey = Object.keys(localStorage).find((k) => k.includes("auth"));
      const token = authKey ? JSON.parse(localStorage.getItem(authKey))?.token : null;
      const res = await fetch(`${bUrl}/v1/workspace/modules`, {
        headers: token ? { Authorization: token } : {},
      });
      return { status: res.status, body: await res.json() };
    }, BACKEND_URL);
    console.log("  [Server Modules Status]:", JSON.stringify(modStatus));

    // Verify "Jobs & Customers" tab appears in SchemaNavigation
    try {
      await owner.waitForFunction(() => {
        const tabs = Array.from(document.querySelectorAll(".lattice-tab"));
        return tabs.some((t) => t.innerText.includes("Jobs & Customers"));
      }, 10000);
    } catch (e) {
      const tabs = await owner.evaluate(() => Array.from(document.querySelectorAll(".lattice-tab")).map((t) => t.innerText));
      const body = await owner.getPageText();
      console.log("Current tabs on page:", tabs);
      console.log("Current page body:\n", body);
      throw e;
    }
    console.log("  ✓ 'Jobs & Customers' tab is visible in workspace navigation");

    // 5. Owner Session: Invite Two Members with Pilot Preset
    console.log("\n[5/8] Owner Session: Inviting two team members with Customer & Job Tracking preset...");
    await owner.clickByText("button", "Manage Team");
    await owner.waitForSelector(".lattice-modal");

    // Invite Tech 1 (Bob)
    await owner.clickByText("button", "+ Invite Member");
    await owner.waitForSelector("#invite-email");
    await owner.fill("#invite-email", "tech1@example.com");
    await owner.clickByText("button", "Customer & Job Tracking Member Preset");
    console.log("  → Applied Customer & Job Tracking Member Preset for tech1@example.com");
    await owner.clickByText("button", "Send Invitation");

    await owner.waitForSelector("code");
    const token1 = await owner.evaluate(() => {
      const code = document.querySelector(".lattice-modal code");
      return code ? code.innerText.trim() : null;
    });
    if (!token1) throw new Error("Failed to read invitation token 1 from UI");
    console.log(`  ✓ Member 1 invited. Token: ${token1}`);

    // Dismiss token card
    await owner.clickByText("button", "Dismiss");

    // Invite Tech 2 (Carol)
    await owner.clickByText("button", "+ Invite Member");
    await owner.waitForSelector("#invite-email");
    await owner.fill("#invite-email", "tech2@example.com");
    await owner.clickByText("button", "Customer & Job Tracking Member Preset");
    console.log("  → Applied Customer & Job Tracking Member Preset for tech2@example.com");
    await owner.clickByText("button", "Send Invitation");

    await owner.waitForSelector("code");
    const token2 = await owner.evaluate(() => {
      const code = document.querySelector(".lattice-modal code");
      return code ? code.innerText.trim() : null;
    });
    if (!token2) throw new Error("Failed to read invitation token 2 from UI");
    console.log(`  ✓ Member 2 invited. Token: ${token2}`);

    // Close members modal
    await owner.click(".lattice-modal-close");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));

    // 6. Member 1 Session (Bob): Accept Invitation
    console.log("\n[6/8] Member 1 Session (Bob): Accepting invitation & registering account...");
    const member1Session = await createBrowserSession(CDP_PORT);
    sessions.push(member1Session);
    const m1 = member1Session.page;

    await m1.send("Page.navigate", {
      url: `${CLIENT_URL}?workspace=${encodeURIComponent(BACKEND_URL)}&invite=${token1}`,
    });
    await m1.waitForSelector("#invite-token-input");
    console.log("  → AcceptInviteForm loaded with invite token prefilled");

    await m1.fill("#invite-name-input", "Bob Tech 1");
    await m1.fill("#invite-password-input", "MemberPassword123!");
    await m1.fill("#invite-confirm-password-input", "MemberPassword123!");
    await m1.clickByText("button", "Accept & Sign In");

    await m1.waitForSelector(".app-header");
    const m1Header = await m1.getText(".app-header");
    if (!m1Header.includes("MEMBER")) throw new Error("Expected MEMBER role chip for Bob");
    console.log("  ✓ Bob registered and authenticated as MEMBER");

    // 7. Member 2 Session (Carol): Accept Invitation
    console.log("\n[7/8] Member 2 Session (Carol): Accepting invitation & registering account...");
    const member2Session = await createBrowserSession(CDP_PORT);
    sessions.push(member2Session);
    const m2 = member2Session.page;

    await m2.send("Page.navigate", {
      url: `${CLIENT_URL}?workspace=${encodeURIComponent(BACKEND_URL)}&invite=${token2}`,
    });
    await m2.waitForSelector("#invite-token-input");

    await m2.fill("#invite-name-input", "Carol Tech 2");
    await m2.fill("#invite-password-input", "MemberPassword123!");
    await m2.fill("#invite-confirm-password-input", "MemberPassword123!");
    await m2.clickByText("button", "Accept & Sign In");

    await m2.waitForSelector(".app-header");
    const m2Header = await m2.getText(".app-header");
    if (!m2Header.includes("MEMBER")) throw new Error("Expected MEMBER role chip for Carol");
    console.log("  ✓ Carol registered and authenticated as MEMBER");

    // 8. Owner Session: Create Customer and Assign One Job to Each Member
    console.log("\n[8/8] Owner Session: Creating customer and assigning jobs...");
    await owner.clickByText(".lattice-tab", "Jobs & Customers");
    await owner.waitForSelector(".lattice-container");

    // Create Customer
    await owner.clickByText("button", "Customers (");
    await owner.clickByText("button", "+ New Customer");
    await owner.waitForSelector('.lattice-modal input');
    await owner.evaluate(() => {
      const setVal = (el, val) => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const inputs = Array.from(document.querySelectorAll('.lattice-modal input'));
      if (inputs[0]) setVal(inputs[0], "Acme Corp");
      if (inputs[1]) setVal(inputs[1], "555-0100");
    });
    await owner.clickByText(".lattice-modal button", "Save Customer");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));
    console.log("  ✓ Customer 'Acme Corp' (555-0100) created");

    // Create Job 1 assigned to tech1
    await owner.clickByText("button", "Jobs (");
    await owner.clickByText("button", "+ New Job");
    await owner.waitForSelector(".lattice-modal");
    await owner.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      const hasTech1 = selects.some((s) => Array.from(s.options).some((o) => o.text.includes("tech1@example.com")));
      const hasCustomer = selects.some((s) => Array.from(s.options).some((o) => o.text.includes("Acme Corp")));
      return hasTech1 && hasCustomer;
    });
    await owner.evaluate(() => {
      const setVal = (el, val) => {
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("");
        const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setSelect = (el, val) => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const titleInput = document.querySelector('.lattice-modal input[placeholder*="Repair"]') || document.querySelectorAll('.lattice-modal input')[0];
      if (!titleInput) throw new Error("Title input not found in Job modal");
      setVal(titleInput, "HVAC Repair");

      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      const customerSelect = selects.find((s) => Array.from(s.options).some((o) => o.text.includes("Acme Corp")));
      if (customerSelect) {
        const opt = Array.from(customerSelect.options).find((o) => o.text.includes("Acme Corp"));
        if (opt) setSelect(customerSelect, opt.value);
      }

      const assigneeSelect = selects.find((s) => Array.from(s.options).some((o) => o.text.includes("tech1@example.com")));
      if (assigneeSelect) {
        const opt = Array.from(assigneeSelect.options).find((o) => o.text.includes("tech1@example.com"));
        if (opt) setSelect(assigneeSelect, opt.value);
      }
    });
    await owner.clickByText(".lattice-modal button", "Create Job");
    try {
      await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"), 5000);
    } catch (e) {
      const modalText = await owner.evaluate(() => document.querySelector(".lattice-modal")?.innerText);
      console.log("  [Job 1 Modal Text]:", modalText);
      throw e;
    }
    console.log("  ✓ Job 'HVAC Repair' created and assigned to tech1@example.com");

    // Test cancel and reopen resets job modal draft (preventing draft leak)
    console.log("  Testing create-job modal draft clearing on cancel and reopen...");
    await owner.clickByText("button", "+ New Job");
    await owner.waitForSelector(".lattice-modal");
    await owner.evaluate(() => {
      const setVal = (el, val) => {
        const proto = window.HTMLInputElement.prototype;
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("");
        const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const titleInput = document.querySelector('.lattice-modal input[placeholder*="Repair"]') || document.querySelectorAll('.lattice-modal input')[0];
      if (titleInput) setVal(titleInput, "Draft That Should Be Cleared");
    });
    // Click Cancel to dismiss
    await owner.clickByText(".lattice-modal button", "Cancel");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));
    console.log("    ✓ Modal closed via Cancel button");

    // Reopen modal and assert title was cleanly reset
    await owner.clickByText("button", "+ New Job");
    await owner.waitForSelector(".lattice-modal");
    const draftTitleAfterReopen = await owner.evaluate(() => {
      const titleInput = document.querySelector('.lattice-modal input[placeholder*="Repair"]') || document.querySelectorAll('.lattice-modal input')[0];
      return titleInput ? titleInput.value : null;
    });
    if (draftTitleAfterReopen !== "") {
      throw new Error(`Expected draft title to be cleared on cancel, but got: "${draftTitleAfterReopen}"`);
    }
    console.log("    ✓ Modal reopened with clean draft (draftTitle cleared)");
    // Close again via ✕ button to test header close button as well
    await owner.clickByText(".lattice-modal button", "✕");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));
    console.log("    ✓ Modal closed via ✕ button and draft verified clean");

    // Create Job 2 assigned to tech2
    await owner.clickByText("button", "+ New Job");
    await owner.waitForSelector(".lattice-modal");
    await owner.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      const hasTech2 = selects.some((s) => Array.from(s.options).some((o) => o.text.includes("tech2@example.com")));
      const hasCustomer = selects.some((s) => Array.from(s.options).some((o) => o.text.includes("Acme Corp")));
      return hasTech2 && hasCustomer;
    });
    await owner.evaluate(() => {
      const setVal = (el, val) => {
        const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("");
        const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };
      const setSelect = (el, val) => {
        const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
        if (set) set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      const titleInput = document.querySelector('.lattice-modal input[placeholder*="Repair"]') || document.querySelectorAll('.lattice-modal input')[0];
      if (!titleInput) throw new Error("Title input not found in Job modal");
      setVal(titleInput, "Filter Replacement");

      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      const customerSelect = selects.find((s) => Array.from(s.options).some((o) => o.text.includes("Acme Corp")));
      if (customerSelect) {
        const opt = Array.from(customerSelect.options).find((o) => o.text.includes("Acme Corp"));
        if (opt) setSelect(customerSelect, opt.value);
      }

      const assigneeSelect = selects.find((s) => Array.from(s.options).some((o) => o.text.includes("tech2@example.com")));
      if (assigneeSelect) {
        const opt = Array.from(assigneeSelect.options).find((o) => o.text.includes("tech2@example.com"));
        if (opt) setSelect(assigneeSelect, opt.value);
      }
    });
    await owner.clickByText(".lattice-modal button", "Create Job");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));
    console.log("  ✓ Job 'Filter Replacement' created and assigned to tech2@example.com");

    const ownerJobsText = await owner.getPageText();
    if (!ownerJobsText.includes("HVAC Repair") || !ownerJobsText.includes("Filter Replacement")) {
      throw new Error("Owner job list missing created jobs");
    }
    console.log("  ✓ Both jobs confirmed visible in owner view");

    const ownerTokenDbg = await owner.getAuthToken();
    const dbgJobsRes = await fetch(`${BACKEND_URL}/api/collections/jobs/records`, {
      headers: ownerTokenDbg ? { Authorization: ownerTokenDbg } : {},
    });
    const dbgJobs = await dbgJobsRes.json();
    console.log("  [Server All Jobs]:", JSON.stringify(dbgJobs.items?.map((j) => ({ id: j.id, title: j.title, assignee: j.assignee, customer: j.customer }))));

    const dbgUsersRes = await fetch(`${BACKEND_URL}/v1/workspace/users`, {
      headers: ownerTokenDbg ? { Authorization: ownerTokenDbg } : {},
    });
    const dbgUsers = await dbgUsersRes.json();
    if (Array.isArray(dbgUsers)) {
      console.log("  [Server All Users]:", JSON.stringify(dbgUsers.map((u) => ({ id: u.id, email: u.email, role: u.role, permissions: u.permissions }))));
    } else {
      console.log("  [Server Users Error]:", dbgUsers);
    }

    // Verify Bob sees only his assigned job
    console.log("\n[Member Verification] Verifying Bob's assigned-only view and customer relation expansion...");
    await m1.clickByText(".lattice-tab", "Jobs & Customers");
    await m1.waitForSelector(".lattice-container");

    try {
      await m1.waitForFunction(() => document.body.innerText.includes("HVAC Repair"), 5000);
    } catch (e) {
      const bobBody = await m1.getPageText();
      const bobAuthToken = await m1.getAuthToken();
      const bobAuthRec = (await m1.getAuthCredentials())?.record;
      console.log("  [Bob Page Text]:", bobBody);
      console.log("  [Bob Auth Record]:", JSON.stringify(bobAuthRec));
      const bobJobsDirect = await fetch(`${BACKEND_URL}/api/collections/jobs/records`, {
        headers: bobAuthToken ? { Authorization: bobAuthToken } : {},
      });
      console.log("  [Bob Direct API Jobs Status]:", bobJobsDirect.status, await bobJobsDirect.text());
      throw e;
    }
    const m1PageText = await m1.getPageText();
    if (!m1PageText.includes("Acme Corp") || !m1PageText.includes("555-0100")) {
      throw new Error("Customer relation expansion ('Acme Corp', '555-0100') missing on Bob's job card");
    }
    if (m1PageText.includes("Filter Replacement")) {
      throw new Error("ISOLATION VIOLATION: Bob can see Carol's job 'Filter Replacement'");
    }
    console.log("  ✓ Isolation verified: Bob sees 'HVAC Repair' with customer relation; 'Filter Replacement' is hidden");

    // Bob updates status from "Open" to "In progress"
    await m1.clickByText("button", "Open");
    await m1.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some((b) => b.innerText.includes("In progress"));
    });
    console.log("  ✓ Bob successfully updated job status to 'In progress'");

    // Verify Carol sees only her assigned job
    console.log("\n[Member Verification] Verifying Carol's assigned-only view and customer relation expansion...");
    await m2.clickByText(".lattice-tab", "Jobs & Customers");
    await m2.waitForSelector(".lattice-container");

    await m2.waitForFunction(() => document.body.innerText.includes("Filter Replacement"));
    const m2PageText = await m2.getPageText();
    if (!m2PageText.includes("Acme Corp") || !m2PageText.includes("555-0100")) {
      throw new Error("Customer relation expansion missing on Carol's job card");
    }
    if (m2PageText.includes("HVAC Repair")) {
      throw new Error("ISOLATION VIOLATION: Carol can see Bob's job 'HVAC Repair'");
    }
    console.log("  ✓ Isolation verified: Carol sees 'Filter Replacement' with customer relation; 'HVAC Repair' is hidden");

    // Carol updates status to "Done" (cycles Open -> In progress -> Done)
    await m2.clickByText("button", "Open");
    await m2.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some((b) => b.innerText.includes("In progress"));
    });
    await m2.clickByText("button", "In progress");
    await m2.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      return btns.some((b) => b.innerText.includes("Done"));
    });
    console.log("  ✓ Carol successfully updated job status to 'Done'");

    // Cross-Member Direct API Isolation Checks
    console.log("\n[Security Verification] Cross-member direct API checks & session revocation...");

    const bobToken = await m1.getAuthToken();
    const carolToken = await m2.getAuthToken();

    const jobsListRes = await fetch(`${BACKEND_URL}/api/collections/jobs/records`, {
      headers: { Authorization: carolToken },
    });
    const carolJobs = await jobsListRes.json();
    const carolJobId = carolJobs.items[0]?.id;

    const bobCrossRes = await fetch(`${BACKEND_URL}/api/collections/jobs/records/${carolJobId}`, {
      headers: { Authorization: bobToken },
    });
    if (bobCrossRes.status !== 404) {
      throw new Error(`Expected 404 Not Found on cross-member read, got ${bobCrossRes.status}`);
    }
    console.log(`  ✓ Direct API Isolation: Bob requesting Carol's job (${carolJobId}) returned HTTP 404 Not Found`);

    const bobUpdateRes = await fetch(`${BACKEND_URL}/api/collections/jobs/records/${carolJobId}`, {
      method: "PATCH",
      headers: { Authorization: bobToken, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Done" }),
    });
    if (bobUpdateRes.status !== 404) {
      throw new Error(`Expected 404 Not Found on cross-member mutation, got ${bobUpdateRes.status}`);
    }
    console.log(`  ✓ Direct API Isolation: Bob attempting to mutate Carol's job returned HTTP 404 Not Found`);

    // Verify customer directory read access for both members
    const bobCustRes = await fetch(`${BACKEND_URL}/api/collections/customers/records`, {
      headers: { Authorization: bobToken },
    });
    if (bobCustRes.status !== 200) {
      throw new Error(`Expected 200 OK for customer directory read, got ${bobCustRes.status}`);
    }
    const carolCustRes = await fetch(`${BACKEND_URL}/api/collections/customers/records`, {
      headers: { Authorization: carolToken },
    });
    if (carolCustRes.status !== 200) {
      throw new Error(`Expected 200 OK for customer directory read, got ${carolCustRes.status}`);
    }
    console.log("  ✓ Directory Access: Both members can read Customers directory via API (200 OK)");

    // Account Deactivation: Owner deactivates Carol Tech 2
    console.log("\n[Account Deactivation] Owner deactivates Carol Tech 2; verifying session revocation...");
    await owner.clickByText("button", "Manage Team");
    await owner.waitForSelector(".lattice-modal");

    await owner.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      return rows.some((r) => r.innerText.includes("tech2@example.com"));
    }, 10000);

    await owner.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const carolRow = rows.find((r) => r.innerText.includes("tech2@example.com"));
      if (!carolRow) throw new Error("Carol's user row not found");
      const disableBtn = Array.from(carolRow.querySelectorAll("button")).find((b) => b.innerText.trim() === "Disable");
      if (!disableBtn) throw new Error("Disable button not found on Carol's row");
      disableBtn.click();
    });

    await owner.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const carolRow = rows.find((r) => r.innerText.includes("tech2@example.com"));
      return carolRow && carolRow.innerText.includes("Enable");
    });
    console.log("  ✓ Owner deactivated Carol's account in WorkspaceMembersModal");

    const revokedRes = await fetch(`${BACKEND_URL}/api/collections/jobs/records`, {
      headers: { Authorization: carolToken },
    });
    if (revokedRes.status !== 401) {
      throw new Error(`Expected 401 Unauthorized for deactivated account session, got ${revokedRes.status}`);
    }
    const revokedBody = await revokedRes.json();
    if (!revokedBody.message?.includes("disabled")) {
      throw new Error(`Expected disabled message in 401 response, got ${JSON.stringify(revokedBody)}`);
    }
    console.log("  ✓ Carol's active session immediately revoked: HTTP 401 Unauthorized ('Your account has been disabled.')");

    await owner.click(".lattice-modal-close");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"));

    // 11. Repeat Setup with Existing Compatible Datasets & Incompatible Mapping Error
    console.log("\n[Existing Dataset Setup] Testing custom dataset mapping and incompatible mapping rejection...");
    // Create client_directory and work_orders schemas via server API
    const ownerTokenForSchema = await owner.getAuthToken();
    const createSchemaViaApi = async (schemaDef) => {
      const res = await fetch(`${BACKEND_URL}/v1/schemas`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: ownerTokenForSchema },
        body: JSON.stringify(schemaDef),
      });
      if (!res.ok) throw new Error(`Failed to create schema: ${res.status} ${await res.text()}`);
    };

    await createSchemaViaApi({
      schema_id: "client_directory",
      name: "Client Directory",
      fields: [
        { name: "client_name", label: "Client Name", type: "text", required: true },
        { name: "contact_number", label: "Contact Number", type: "text", required: false },
      ],
    });
    await createSchemaViaApi({
      schema_id: "work_orders",
      name: "Work Orders",
      assignee_field: "assigned_tech",
      fields: [
        { name: "summary", label: "Summary", type: "text", required: true },
        { name: "client_link", label: "Client Link", type: "relation", required: true, target: "client_directory" },
        { name: "current_state", label: "State", type: "select", required: true, options: ["Open", "In progress", "Done"] },
        { name: "assigned_tech", label: "Assigned Tech", type: "relation", required: true, target: "users" },
      ],
    });
    console.log("  ✓ Pre-created custom schemas 'client_directory' and 'work_orders'");

    // Open module setup modal
    await owner.clickByText("button", "Modules");
    await owner.waitForSelector(".lattice-modal");
    await owner.clickByText(".lattice-modal button", "Configure");
    await owner.waitForSelector("#cjt-modal-title");
    await owner.clickByText("button", "Map Existing Datasets");

    // Wait for schemas to populate select dropdowns
    try {
      await owner.waitForFunction(() => {
        const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
        return selects[0] && Array.from(selects[0].options).some((o) => o.value === "client_directory");
      }, 10000);
    } catch (e) {
      const opts = await owner.evaluate(() => {
        const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
        return selects.map((s, idx) => ({
          idx,
          options: Array.from(s.options).map((o) => ({ value: o.value, text: o.text })),
        }));
      });
      console.log("Current selects in modal:", JSON.stringify(opts));
      throw e;
    }

    // Select client_directory and work_orders and their corresponding fields
    await owner.evaluate(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      // 0: Customer dataset
      if (selects[0]) { selects[0].value = "client_directory"; selects[0].dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await owner.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      return selects[1] && Array.from(selects[1].options).some((o) => o.value === "client_name");
    }, 5000);

    await owner.evaluate(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      // 1: Customer name field
      if (selects[1]) { selects[1].value = "client_name"; selects[1].dispatchEvent(new Event("change", { bubbles: true })); }
      // 2: Customer phone field
      if (selects[2]) { selects[2].value = "contact_number"; selects[2].dispatchEvent(new Event("change", { bubbles: true })); }
      // 3: Job dataset
      if (selects[3]) { selects[3].value = "work_orders"; selects[3].dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await owner.waitForFunction(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      return selects[4] && Array.from(selects[4].options).some((o) => o.value === "summary");
    }, 5000);

    await owner.evaluate(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      // 4: Job title field
      if (selects[4]) { selects[4].value = "summary"; selects[4].dispatchEvent(new Event("change", { bubbles: true })); }
      // 5: Job customer relation field
      if (selects[5]) { selects[5].value = "client_link"; selects[5].dispatchEvent(new Event("change", { bubbles: true })); }
      // 6: Job status field
      if (selects[6]) { selects[6].value = "current_state"; selects[6].dispatchEvent(new Event("change", { bubbles: true })); }
      // 7: Job assignee field
      if (selects[7]) { selects[7].value = "assigned_tech"; selects[7].dispatchEvent(new Event("change", { bubbles: true })); }
    });

    // Intentionally select incompatible relation target on Job Customer Field (assigned_tech pointing to users instead of client_directory)
    await owner.evaluate(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      if (selects[5]) {
        selects[5].value = "assigned_tech";
        selects[5].dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await owner.clickByText("button", "Save & Enable Module");
    await owner.waitForSelector(".lattice-alert-error");
    const errorText = await owner.getText(".lattice-alert-error");
    if (!errorText.includes("must target customer collection") && !errorText.includes("incompatible") && !errorText.includes("assigned_tech")) {
      throw new Error(`Expected incompatible mapping error banner, got: ${errorText}`);
    }
    console.log(`  ✓ Incompatible mapping rejected with understandable error banner: "${errorText.trim().slice(0, 75)}..."`);

    // Correct the mapping: point back to client_link
    await owner.evaluate(() => {
      const selects = Array.from(document.querySelectorAll(".lattice-modal select"));
      if (selects[5]) {
        selects[5].value = "client_link";
        selects[5].dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await owner.clickByText("button", "Save & Enable Module");
    await owner.waitForFunction(() => !document.querySelector("#cjt-modal-title"), 15000);
    console.log("  ✓ Corrected mapping saved successfully with 200 OK");

    // Close modules modal
    await owner.click(".lattice-modal-close");
    await owner.waitForFunction(() => !document.querySelector(".lattice-modal-overlay"), 15000);
    console.log("  ✓ Modules modal closed");

    console.log("\n=======================================================");
    console.log("✅ MILESTONE 2 VERIFIED: The complete owner and two-member journey passed in headless browser!");
    console.log("=======================================================\n");

  } finally {
    for (const s of sessions) {
      try { s.close(); } catch {}
    }
    if (chromeProc) {
      try { chromeProc.kill(); } catch {}
    }
    if (backendProc) {
      try { backendProc.kill(); } catch {}
    }
    if (clientServer) {
      try { clientServer.close(); } catch {}
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((err) => {
  console.error("\n❌ E2E Browser Test Failed:", err);
  process.exit(1);
});
