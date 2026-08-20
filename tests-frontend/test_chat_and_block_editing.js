"use strict";
/* test_chat_and_block_editing.js — Vérifie, par de vrais événements DOM
   contre le vrai app.js :
   1) modifier un message déjà envoyé (tronque la suite, renvoie avec
      historique rejoué, session_id remis à zéro) ;
   2) arrêter un message en cours (bouton Stop -> AbortController) ;
   3) modifier un bloc du Canevas en place ;
   4) laisser une remarque ciblée sur un bloc (appel à /remark, mise à
      jour uniquement de ce bloc). */

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

function makeDom() {
  return new JSDOM(`<!DOCTYPE html><html><body>${BODY_HTML}</body></html>`, {
    url: "http://localhost/admin/assistant", runScripts: "dangerously", pretendToBeVisual: true,
  });
}
function flush(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 5); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log("  \u2713 " + name); passed++; }
  catch (e) { console.log("  \u2717 " + name + "\n      " + (e && e.stack || e)); failed++; }
}

const DOC1 = {
  title: "Le filtre papier", kick: "Article",
  blocks: [
    { type: "heading", level: 2, text: "Intro" },
    { type: "text", text: "Un premier texte." },
    { type: "quote", text: "Une citation." },
  ],
  sources: [],
};

async function main() {

console.log("Modifier un message déjà envoyé");
{
  const dom = makeDom();
  const { window } = dom;
  const calls = [];
  let replyCount = 0;
  window.fetch = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (String(url).includes("/admin/agents/blog/chat")) {
      replyCount++;
      return { ok: true, json: async () => ({ reply: "Réponse " + replyCount, session_id: "session-" + replyCount, tool_calls: [], doc: replyCount === 1 ? DOC1 : null, choice: null }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  window.document.getElementById("chatText").value = "Écris un article sur le café";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);
  window.document.getElementById("chatText").value = "Ajoute une section sur le thé";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);

  await test("un bouton ✎ existe sur chaque message utilisateur", () => {
    const btns = window.document.querySelectorAll('[data-act="edit-msg"]');
    assert.strictEqual(btns.length, 2);
  });

  await test("cliquer ✎ transforme la bulle en zone éditable", () => {
    const firstBtn = window.document.querySelector('[data-act="edit-msg"]');
    firstBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    const ta = window.document.querySelector(".msg-edit-area");
    assert.ok(ta);
    assert.strictEqual(ta.value, "Écris un article sur le café");
  });

  await test("renvoyer l'édition tronque la suite et repart avec l'historique rejoué (session_id à null)", async () => {
    const ta = window.document.querySelector(".msg-edit-area");
    ta.value = "Écris plutôt un article sur le thé";
    window.document.querySelector('[data-act="save-msg-edit"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush(10);

    const lastChatCall = calls.filter((c) => String(c.url).includes("/admin/agents/blog/chat")).pop();
    assert.strictEqual(lastChatCall.body.message, "Écris plutôt un article sur le thé");
    assert.strictEqual(lastChatCall.body.session_id, null);
    assert.deepStrictEqual(lastChatCall.body.history, []);

    const log = window.document.getElementById("chatLog");
    assert.ok(!log.textContent.includes("Ajoute une section sur le thé"));
    assert.ok(log.textContent.includes("Écris plutôt un article sur le thé"));
  });

  await test("le Canevas repart à vide après l'édition (nouvelle réponse sans doc)", () => {
    const empty = window.document.querySelector(".canvas-empty");
    assert.ok(empty);
  });
}

console.log("\nArrêter un message en cours");
{
  const dom = makeDom();
  const { window } = dom;
  let rejectFetch;
  window.fetch = (url) => new Promise((resolve, reject) => {
    if (String(url).includes("/admin/agents/blog/chat")) { rejectFetch = reject; return; }
    resolve({ ok: true, json: async () => ({}) });
  });
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  window.document.getElementById("chatText").value = "Une idée d'article";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  await test("le bouton passe en mode 'Stop' pendant la génération", () => {
    const btn = window.document.getElementById("chatSend");
    assert.strictEqual(btn.dataset.mode, "stop");
    assert.strictEqual(btn.textContent, "Stop");
  });

  await test("cliquer Stop annule réellement la requête (AbortError) et affiche 'Message interrompu'", async () => {
    const btn = window.document.getElementById("chatSend");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    const abortErr = new window.DOMException("aborted", "AbortError");
    rejectFetch(abortErr);
    await flush(10);

    assert.strictEqual(btn.dataset.mode, "send");
    assert.strictEqual(btn.textContent, "Envoyer");
    const log = window.document.getElementById("chatLog");
    assert.ok(log.textContent.includes("Message interrompu"));
  });
}

console.log("\nCanevas : modifier un bloc en place");
{
  const dom = makeDom();
  const { window } = dom;
  window.fetch = async (url) => {
    if (String(url).includes("/admin/agents/blog/chat")) {
      return { ok: true, json: async () => ({ reply: "Voici.", session_id: "s1", tool_calls: [], doc: DOC1, choice: null }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  window.document.getElementById("chatText").value = "Rédige l'article";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);

  await test("les blocs texte/citation/titre ont une icône ✎, tous n'ont pas 💬", () => {
    const editBtns = window.document.querySelectorAll('[data-act="edit-block"]');
    const remarkBtns = window.document.querySelectorAll('[data-act="remark-block"]');
    assert.strictEqual(editBtns.length, 3);
    assert.strictEqual(remarkBtns.length, 2);
  });

  await test("cliquer ✎ sur un bloc puis enregistrer met à jour son contenu affiché", () => {
    const firstEditBtn = window.document.querySelector('[data-act="edit-block"]');
    firstEditBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    const ta = window.document.querySelector(".block-edit-area");
    assert.ok(ta);
    ta.value = "Introduction modifiée";
    window.document.querySelector('[data-act="save-block"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    const canvasBody = window.document.getElementById("canvasBody");
    assert.ok(canvasBody.textContent.includes("Introduction modifiée"));
  });
}

console.log("\nCanevas : remarque ciblée sur un bloc (appel réel à /remark)");
{
  const dom = makeDom();
  const { window } = dom;
  const remarkCalls = [];
  window.fetch = async (url, opts) => {
    if (String(url).includes("/admin/agents/blog/chat")) {
      return { ok: true, json: async () => ({ reply: "Voici.", session_id: "s1", tool_calls: [], doc: DOC1, choice: null }) };
    }
    if (String(url).includes("/admin/agents/blog/remark")) {
      const body = JSON.parse(opts.body);
      remarkCalls.push(body);
      return { ok: true, json: async () => ({ block: { id: body.target_block.id, type: "text", text: "Texte révisé avec un exemple." }, session_id: "s1" }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
  window.document.getElementById("chatText").value = "Rédige l'article";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);

  await test("cliquer 💬 ouvre un champ de remarque", () => {
    const remarkBtn = window.document.querySelector('[data-act="remark-block"]');
    remarkBtn.dispatchEvent(new window.Event("click", { bubbles: true }));
    assert.ok(window.document.querySelector(".remark-pop input"));
  });

  await test("envoyer la remarque appelle /remark avec le bon bloc cible, met à jour seulement ce bloc", async () => {
    const input = window.document.querySelector(".remark-pop input");
    input.value = "ajoute un exemple concret";
    window.document.querySelector('[data-act="send-block-remark"]').dispatchEvent(new window.Event("click", { bubbles: true }));
    await flush(10);

    assert.strictEqual(remarkCalls.length, 1);
    assert.strictEqual(remarkCalls[0].remark, "ajoute un exemple concret");
    assert.strictEqual(remarkCalls[0].target_block.type, "text");

    const canvasBody = window.document.getElementById("canvasBody");
    assert.ok(canvasBody.textContent.includes("Texte révisé avec un exemple."));
    assert.ok(canvasBody.textContent.includes("Une citation."));
  });
}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
}

main();
