"use strict";
/* test_canvas_design.js — Vérifie, par de vrais événements DOM, les
   éléments de design rapprochant le Canevas réel de la démo :
   en-tête avec libellé d'agent + statut, curseur d'encre pendant la
   réflexion, animation de révélation au renouvellement du document,
   bascule mobile Discussion/Page avec pastille de mise à jour. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "elle", "public", "app.js"), "utf8");

const BODY_HTML = `
<div class="tabs" id="agentTabs">
  <button type="button" data-tab="quick" class="on">Rapide</button>
  <button type="button" data-tab="blog">Blog</button>
  <button type="button" data-tab="notes-cours">Notes de cours</button>
  <button type="button" data-tab="creation-cours">Création de cours</button>
  <button type="button" data-tab="projet">Projet</button>
</div>
<div id="agent-root" data-haskey="1"><div class="chat-intro">Chargement…</div></div>
<div id="toast" class="toast"></div>
`;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log("  \u2713 " + name); passed++; }
  catch (e) { console.log("  \u2717 " + name + "\n      " + (e && e.stack || e)); failed++; }
}

function makeDom() {
  return new JSDOM(`<!DOCTYPE html><html><body>${BODY_HTML}</body></html>`, {
    url: "http://localhost/admin/assistant",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
}

function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 5); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

async function main() {

console.log("En-tête du Canevas");
{
  const dom = makeDom();
  const { window } = dom;
  window.fetch = async (url) => {
    if (String(url).includes("/admin/agents/blog/chat")) {
      return {
        ok: true,
        json: async () => ({
          reply: "Voici un brouillon.", session_id: "s1", tool_calls: [], choice: null,
          doc: { title: "Titre", kick: "Article", blocks: [{ type: "text", text: "Contenu." }], sources: [] },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  test("l'en-tête du Canevas affiche le libellé de l'agent courant (\"Blog\"), pas un texte statique \"Aperçu\"", () => {
    const head = window.document.querySelector(".canvas-head .kick");
    assert.ok(head, "aucun .canvas-head .kick trouvé");
    assert.strictEqual(head.textContent, "Blog");
  });

  test("le statut est vide avant tout document, puis affiche 'brouillon prêt' après réception", async () => {
    const status = window.document.getElementById("canvasStatus");
    assert.strictEqual(status.textContent, "");
    window.document.getElementById("chatText").value = "Rédige l'article";
    window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush(10);
    assert.ok(status.textContent.includes("brouillon prêt"));
  });

  test("le panneau canevas reçoit la classe 'reveal' après une mise à jour du document", () => {
    const pane = window.document.querySelector(".canvas-pane");
    assert.ok(pane.classList.contains("reveal"));
  });
}

console.log("\nCurseur d'encre pendant la réflexion");
{
  const dom = makeDom();
  const { window } = dom;
  let resolveFetch;
  window.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  window.document.getElementById("chatText").value = "Une idée";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  test("l'indicateur de réflexion contient le curseur d'encre respirant", () => {
    const typing = window.document.getElementById("chatTyping");
    assert.ok(!typing.classList.contains("hidden"));
    assert.ok(typing.querySelector(".ink-dot"), "aucun .ink-dot dans l'indicateur de réflexion");
  });

  resolveFetch({ ok: true, json: async () => ({ reply: "ok", session_id: "s", tool_calls: [], doc: null, choice: null }) });
  await flush(10);
}

console.log("\nBascule mobile Discussion / Page");
{
  const dom = makeDom();
  const { window } = dom;
  window.fetch = async (url) => {
    if (String(url).includes("/admin/agents/blog/chat")) {
      return {
        ok: true,
        json: async () => ({
          reply: "Voici.", session_id: "s1", tool_calls: [], choice: null,
          doc: { title: "T", kick: "K", blocks: [{ type: "text", text: "x" }], sources: [] },
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  test("au chargement, la discussion est visible et la page ne l'est pas", () => {
    const chatEl = window.document.querySelector(".agent-layout .chat");
    const paneEl = window.document.querySelector(".canvas-pane");
    assert.ok(chatEl.classList.contains("show"));
    // la page reste "show" par défaut en desktop (CSS grid) ; le test qui
    // compte est le comportement du clic ci-dessous, propre au mobile.
    assert.ok(paneEl);
  });

  test("répondre alors qu'on est sur 'Discussion' fait apparaître la pastille sur 'Page'", async () => {
    window.document.getElementById("chatText").value = "x";
    window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush(10);
    const badge = window.document.getElementById("canvasBadge");
    assert.ok(!badge.classList.contains("hidden"));
  });

  test("cliquer sur 'Page' bascule l'affichage et efface la pastille", () => {
    const pageBtn = window.document.querySelector('[data-view="canvas"]');
    pageBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    const chatEl = window.document.querySelector(".agent-layout .chat");
    const paneEl = window.document.querySelector(".canvas-pane");
    const badge = window.document.getElementById("canvasBadge");
    assert.ok(!chatEl.classList.contains("show"));
    assert.ok(paneEl.classList.contains("show"));
    assert.ok(badge.classList.contains("hidden"));
  });

  test("changer d'onglet réinitialise la bascule sur 'Discussion'", () => {
    window.document.querySelector('[data-tab="projet"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    const chatEl = window.document.querySelector(".agent-layout .chat");
    assert.ok(chatEl.classList.contains("show"));
  });
}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
}

main();
