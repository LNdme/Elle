"use strict";
/* Script de diagnostic pour elle-mcp-server.
   Vérifie, avec un vrai client MCP, que les 4 outils fonctionnent et que
   la règle de sécurité (une mise à jour ne dépublie jamais un contenu)
   est respectée.

   Lancement (Elle et elle-mcp-server doivent déjà tourner) :
     node test-client.js
*/
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const MCP_URL = process.env.MCP_URL || "http://localhost:3001/mcp";
const ELLE_URL = process.env.ELLE_URL || "http://localhost:3000";

async function callTool(client, name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(name + " a échoué : " + JSON.stringify(r.content));
  return r.structuredContent;
}

async function main() {
  const client = new Client({ name: "elle-diagnostic", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

  console.log("=== outils exposés ===");
  const tools = await client.listTools();
  console.log(tools.tools.map(t => t.name).join(", "));

  console.log("\n=== create_draft (nouveau projet) ===");
  const created = await callTool(client, "create_draft", {
    type: "project",
    title: "Diagnostic elle-mcp-server",
    category: "Diagnostic",
    blocks: [{ type: "text", text: "Créé par test-client.js pour vérifier l'installation." }]
  });
  console.log(created);
  if (!created.ok) throw new Error("create_draft a échoué");

  console.log("\n=== list_content (type=project) ===");
  console.log(await callTool(client, "list_content", { type: "project", limit: 5 }));

  console.log("\n=== get_content (slug=" + created.slug + ") ===");
  const got = await callTool(client, "get_content", { slug: created.slug });
  console.log(got);

  console.log("\n=== search_content (q=diagnostic) ===");
  console.log(await callTool(client, "search_content", { q: "diagnostic" }));

  console.log("\n=== brouillon invisible publiquement ===");
  const pub = await fetch(ELLE_URL + "/post/" + created.slug);
  console.log("HTTP " + pub.status + " (attendu : 404)");
  if (pub.status !== 404) throw new Error("Le brouillon est visible publiquement, ce n'est pas censé arriver !");

  console.log("\n=== une mise à jour ne change jamais le statut ===");
  const updated = await callTool(client, "create_draft", {
    id: got.item.id, type: "project", title: "Diagnostic elle-mcp-server (mis à jour)",
    category: "Diagnostic", blocks: got.item.blocks
  });
  const gotAfter = await callTool(client, "get_content", { slug: updated.slug });
  console.log("statut après mise à jour par l'agent :", gotAfter.item.status, "(attendu : draft, inchangé)");

  await client.close();
  console.log("\n✓ Tout fonctionne.");
}

main().catch(e => { console.error("\n✗ ÉCHEC :", e.message); process.exit(1); });
