"use strict";
/* Pont HTTP vers Elle. Utilise le même jeton ELLE_AGENT_TOKEN et les
   mêmes routes /api/agent/* que le service d'agents ADK. */

const ELLE_BASE_URL = (process.env.ELLE_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const ELLE_AGENT_TOKEN = process.env.ELLE_AGENT_TOKEN || "";

async function callElle(path, options = {}) {
  if (!ELLE_AGENT_TOKEN) {
    return { ok: false, error: "ELLE_AGENT_TOKEN n\u2019est pas configur\u00e9 c\u00f4t\u00e9 elle-mcp-server (.env)." };
  }
  try {
    const res = await fetch(ELLE_BASE_URL + path, {
      ...options,
      headers: {
        "Authorization": "Bearer " + ELLE_AGENT_TOKEN,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || ("HTTP " + res.status) };
    return data;
  } catch (e) {
    return { ok: false, error: "Impossible de joindre Elle sur " + ELLE_BASE_URL + " : " + e.message };
  }
}

async function createDraft(fields) {
  const data = await callElle("/api/agent/draft", { method: "POST", body: JSON.stringify(fields) });
  if (data.ok === false) return { ok: false, error: data.error || "Erreur inconnue." };
  return { ok: true, id: data.id, slug: data.slug };
}

async function listContent({ type, status, limit } = {}) {
  const qs = new URLSearchParams();
  if (type) qs.set("type", type);
  if (status) qs.set("status", status);
  if (limit) qs.set("limit", String(limit));
  const data = await callElle("/api/agent/content?" + qs.toString());
  return data.ok === false ? data : { ok: true, items: data.items || [] };
}

async function getContent(slug) {
  const data = await callElle("/api/agent/content/" + encodeURIComponent(slug));
  return data.ok === false ? data : { ok: true, item: data.item || null };
}

async function searchContent(q, limit) {
  const qs = new URLSearchParams({ q: q || "" });
  if (limit) qs.set("limit", String(limit));
  const data = await callElle("/api/agent/search?" + qs.toString());
  return data.ok === false ? data : { ok: true, items: data.items || [] };
}

module.exports = { createDraft, listContent, getContent, searchContent };
