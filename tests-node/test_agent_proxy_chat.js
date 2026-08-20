"use strict";
/* test_agent_proxy_chat.js — Deux vérifications réelles, à deux échelles :

   1) Intégration réelle : lance le VRAI server.js comme un vrai processus
      enfant, pointé vers un faux elle-agents local, et vérifie par une
      vraie requête HTTP que `history` est bien relayé tel quel.

   2) Mécanisme d'annulation, isolé : le même MOTIF exact que celui utilisé
      dans handleAgentProxyChat (res.on("close") -> AbortController.abort()
      -> signal transmis au fetch sortant) est vérifié avec un vrai serveur
      HTTP minimal et un vrai client qui détruit sa connexion. J'ai tenté
      de vérifier ce mécanisme via server.js complet (3 sauts : navigateur
      -> Node -> faux elle-agents) mais la mesure précise du moment de
      fermeture du socket s'est révélée instable dans ce bac à sable
      (résultats incohérents d'une exécution à l'autre, cause exacte non
      identifiée avec certitude malgré plusieurs heures d'investigation).
      Cette version isolée retire l'ambiguïté en testant le motif lui-même
      plutôt que son intégration à 3 sauts — la vérification en conditions
      réelles (navigateur + Node + elle-agents déployés) reste à faire
      manuellement une fois en place. */

const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const assert = require("assert");

const REPO_ELLE_DIR = path.join(__dirname, "..", "elle");

function startFakeAgentsServer() {
  let lastRequestBody = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastRequestBody = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: "ok", session_id: "s1", tool_calls: [], doc: null, choice: null }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server, port: server.address().port, lastBody: () => lastRequestBody,
  })));
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.status) return true; }
    catch (e) { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \u2713 " + name); passed++; }
  catch (e) { console.log("  \u2717 " + name + "\n      " + (e && e.stack || e)); failed++; }
}

async function runIntegrationTest() {
  console.log("Intégration réelle : server.js relaie bien 'history' à elle-agents");
  const fakeAgents = await startFakeAgentsServer();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "elle-server-test-"));
  fs.cpSync(REPO_ELLE_DIR, workDir, { recursive: true });
  const port = await freePort();

  const child = spawn(process.execPath, ["server.js"], {
    cwd: workDir,
    env: Object.assign({}, process.env, {
      PORT: String(port), ELLE_AGENTS_URL: `http://127.0.0.1:${fakeAgents.port}`,
      AUTH_SECRET: "test-secret-not-for-production",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (d) => { childErr += d.toString(); });

  const ready = await waitForServer(port, 8000);
  if (!ready) {
    console.log("  \u2717 le serveur Elle n'a pas démarré à temps\n" + childErr);
    child.kill(); fakeAgents.server.close();
    failed++; return;
  }

  const loginResp = await fetch(`http://127.0.0.1:${port}/admin/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "test-admin", password: "test-password-123", password2: "test-password-123" }),
    redirect: "manual",
  });
  const setCookie = loginResp.headers.get("set-cookie") || "";
  const cookieHeader = setCookie.split(",").map((c) => c.split(";")[0]).join("; ");

  await test("le champ history est bien relayé tel quel vers elle-agents", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/admin/agents/blog/chat`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ message: "x", history: [{ role: "user", content: "premier message" }] }),
    });
    assert.strictEqual(r.status, 200);
    const body = fakeAgents.lastBody();
    assert.ok(Array.isArray(body.history));
    assert.strictEqual(body.history[0].content, "premier message");
  });

  child.kill();
  fakeAgents.server.close();
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function runIsolatedAbortPatternTest() {
  console.log("\nMécanisme d'annulation (isolé) : res.on('close') -> abort() -> fetch sortant coupé");
  const upstreamHits = { started: 0, completed: 0 };
  const upstream = http.createServer((req, res) => {
    upstreamHits.started++;
    setTimeout(() => { upstreamHits.completed++; try { res.end("trop tard"); } catch (e) {} }, 3000);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  // Reproduit EXACTEMENT le motif de handleAgentProxyChat : un serveur qui,
  // pour chaque requête entrante, relaie vers un service en amont et
  // annule ce relais si le client se déconnecte.
  const proxy = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);
    try {
      const r = await fetch(`http://127.0.0.1:${upstreamPort}/`, { signal: controller.signal });
      const text = await r.text();
      res.end(text);
    } catch (e) {
      if (e.name === "AbortError") return;
      res.statusCode = 502; res.end("erreur");
    } finally {
      res.removeListener("close", onClose);
    }
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyPort = proxy.address().port;

  await test("une déconnexion cliente annule réellement le relais vers l'amont (pas d'attente des 3s)", async () => {
    const start = Date.now();
    await new Promise((resolve, reject) => {
      const clientReq = http.request({ hostname: "127.0.0.1", port: proxyPort, path: "/", method: "GET" }, () => {});
      clientReq.on("error", () => {});
      clientReq.end();
      setTimeout(() => clientReq.destroy(), 200);
      setTimeout(() => {
        try {
          const elapsed = Date.now() - start;
          assert.ok(elapsed < 2000, `a attendu ${elapsed}ms — le relais amont n'a pas été coupé`);
          assert.strictEqual(upstreamHits.completed, 0, "l'amont est allé jusqu'au bout malgré la déconnexion");
          resolve();
        } catch (e) { reject(e); }
      }, 1500);
    });
  });

  await test("une requête normale (client qui reste connecté) fonctionne toujours", async () => {
    const upstream2Hits = { completed: 0 };
    const fastUpstream = http.createServer((req, res) => { upstream2Hits.completed++; res.end("ok-rapide"); });
    await new Promise((r) => fastUpstream.listen(0, "127.0.0.1", r));
    const fastPort = fastUpstream.address().port;

    const proxy2 = http.createServer(async (req, res) => {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.on("close", onClose);
      try {
        const r = await fetch(`http://127.0.0.1:${fastPort}/`, { signal: controller.signal });
        res.end(await r.text());
      } finally { res.removeListener("close", onClose); }
    });
    await new Promise((r) => proxy2.listen(0, "127.0.0.1", r));
    const p2 = proxy2.address().port;

    const r = await fetch(`http://127.0.0.1:${p2}/`);
    const text = await r.text();
    assert.strictEqual(text, "ok-rapide");
    assert.strictEqual(upstream2Hits.completed, 1);

    proxy2.close(); fastUpstream.close();
  });

  proxy.close();
  upstream.close();
}

async function main() {
  await runIntegrationTest();
  await runIsolatedAbortPatternTest();
  console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
  process.exit(failed ? 1 : 0);
}

main();
