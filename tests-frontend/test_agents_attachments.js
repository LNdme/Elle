"use strict";
/* test_agents_attachments.js — Charge le VRAI app.js dans une VRAIE page
   jsdom construite à partir du fragment HTML réel produit par
   assistantPage() (server.js), et pilote l'interface par de vrais
   événements DOM (clic, saisie, changement de fichier) — pas d'appel de
   fonctions internes de app.js, qui n'expose rien : exactement comme un
   navigateur le ferait.

   Seul fetch() est remplacé par un faux, pour capturer le payload envoyé
   à /admin/agents/blog/chat et renvoyer une réponse réaliste. */

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "elle", "public", "app.js"), "utf8");

// Fragment HTML réel produit par assistantPage() dans server.js (tabs +
// #agent-root), sans les <script> externes (katex/hljs) : app.js gère
// déjà leur absence gracieusement (renderMath/highlightAll vérifient
// window.katex/window.hljs avant de s'en servir).
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
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${BODY_HTML}</body></html>`, {
    url: "http://localhost/admin/assistant",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // FileReader n'est pas toujours complet dans jsdom : on fournit une
  // implémentation minimale mais réelle (lit vraiment le contenu du Blob).
  if (!window.FileReader || !window.FileReader.prototype.readAsText) {
    window.FileReader = class {
      readAsText(blob) {
        Promise.resolve(blob.text ? blob.text() : "").then((text) => {
          this.result = text;
          if (this.onload) this.onload();
        });
      }
      readAsDataURL(blob) {
        Promise.resolve(blob.text ? blob.text() : "").then((text) => {
          this.result = "data:text/plain;base64," + Buffer.from(text).toString("base64");
          if (this.onload) this.onload();
        });
      }
    };
  }
  return dom;
}

function flush(times) {
  // laisse les microtasks/promesses (fetch mocké, FileReader) se résoudre
  let p = Promise.resolve();
  for (let i = 0; i < (times || 5); i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

async function main() {

console.log("Onglet Blog : pièce jointe image (upload réel simulé) puis envoi");
{
  const dom = makeDom();
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes("/admin/upload")) {
      return { ok: true, json: async () => ({ url: "/uploads/real-hash.jpg" }) };
    }
    if (String(url).includes("/admin/agents/blog/chat")) {
      return { ok: true, json: async () => ({ reply: "Illustration ajoutée.", session_id: "s1", tool_calls: [], doc: null, choice: null }) };
    }
    return { ok: false, json: async () => ({ error: "inattendu" }) };
  };
  window.eval(APP_JS);
  await flush();

  // passer sur l'onglet Blog
  window.document.querySelector('[data-tab="blog"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  test("le bouton d'attache et l'input fichier existent bien sur l'onglet Blog", () => {
    assert.ok(window.document.getElementById("agentAttachBtn"));
    assert.ok(window.document.getElementById("agentFileInput"));
  });

  // simuler la sélection d'un fichier image
  const fileInput = window.document.getElementById("agentFileInput");
  const file = new window.File(["donnée-image-factice"], "cover.jpg", { type: "image/jpeg" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush(10);

  test("l'image jointe déclenche un upload réel vers /admin/upload", () => {
    assert.ok(calls.some((c) => String(c.url).includes("/admin/upload")));
  });

  test("une puce d'aperçu apparaît avec le nom du fichier", () => {
    const row = window.document.getElementById("attachRow");
    assert.ok(!row.classList.contains("hidden"));
    assert.ok(row.textContent.includes("cover.jpg"));
  });

  // envoyer un message
  const textEl = window.document.getElementById("chatText");
  textEl.value = "Insère cette photo en illustration";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);

  test("le payload envoyé à l'agent contient bien l'URL réelle de l'image jointe", () => {
    const chatCall = calls.find((c) => String(c.url).includes("/admin/agents/blog/chat"));
    assert.ok(chatCall, "aucun appel vers /admin/agents/blog/chat capturé");
    assert.strictEqual(chatCall.body.attachments.length, 1);
    assert.strictEqual(chatCall.body.attachments[0].kind, "image");
    assert.strictEqual(chatCall.body.attachments[0].url, "/uploads/real-hash.jpg");
  });

  test("les pièces jointes en attente sont vidées après l'envoi", () => {
    const row = window.document.getElementById("attachRow");
    assert.ok(row.classList.contains("hidden"));
  });

  test("le message envoyé affiche une puce de pièce jointe dans la bulle utilisateur", () => {
    const log = window.document.getElementById("chatLog");
    assert.ok(log.innerHTML.includes("msg-atts"));
    assert.ok(log.innerHTML.includes("cover.jpg"));
  });
}

console.log("\nOnglet Notes de cours : pièce jointe fichier texte (pas d'upload, lu localement)");
{
  const dom = makeDom();
  const { window } = dom;
  const calls = [];
  window.fetch = async (url, opts) => {
    calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => ({ reply: "Notes mises à jour.", session_id: "s2", tool_calls: [], doc: null, choice: null }) };
  };
  window.eval(APP_JS);
  await flush();
  window.document.querySelector('[data-tab="notes-cours"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();

  const fileInput = window.document.getElementById("agentFileInput");
  const file = new window.File(["# Idée clé\nContenu utile pour les notes."], "notes.md", { type: "text/markdown" });
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event("change", { bubbles: true }));
  await flush(10);

  test("un fichier texte joint n'appelle PAS /admin/upload (lu localement)", () => {
    assert.ok(!calls.some((c) => String(c.url).includes("/admin/upload")));
  });

  const textEl = window.document.getElementById("chatText");
  textEl.value = "Utilise ce fichier pour enrichir les notes";
  window.document.getElementById("chatSend").dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush(10);

  test("le contenu réel du fichier texte atteint le payload envoyé à l'agent", () => {
    const chatCall = calls.find((c) => String(c.url).includes("/admin/agents/notes-cours/chat"));
    assert.ok(chatCall);
    assert.strictEqual(chatCall.body.attachments[0].kind, "text");
    assert.ok(chatCall.body.attachments[0].content.includes("Contenu utile pour les notes."));
  });
}

console.log("\nRendu des sources : un fichier joint (sans URL) n'affiche pas de lien mort");
{
  const dom = makeDom();
  const { window } = dom;
  window.fetch = async (url) => {
    if (String(url).includes("/admin/agents/blog/chat")) {
      return {
        ok: true,
        json: async () => ({
          reply: "Voici le brouillon.",
          session_id: "s3",
          tool_calls: [],
          doc: {
            title: "Titre", kick: "Article",
            blocks: [{ type: "text", text: "Contenu." }],
            sources: [
              { title: "Source web", url: "https://example.com" },
              { title: "notes.md", url: "" },
            ],
          },
          choice: null,
        }),
      };
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

  test("la source web a bien un lien <a>", () => {
    const canvas = window.document.querySelector(".canvas-sources") || window.document.body;
    assert.ok(canvas.innerHTML.includes('href="https://example.com"'));
  });

  test("le fichier joint sans URL n'a PAS de lien <a> (pas de href vide)", () => {
    const html = window.document.body.innerHTML;
    assert.ok(!html.includes('href=""'), "un href vide a été trouvé — lien mort");
    assert.ok(html.includes("notes.md"));
    assert.ok(html.includes("fichier joint"));
  });
}

console.log(`\n${passed} test(s) réussi(s), ${failed} échec(s).`);
process.exit(failed ? 1 : 0);
}

main();
