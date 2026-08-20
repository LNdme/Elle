"use strict";
require("dotenv").config();

const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");

const elle = require("./elle-client");

const CONTENT_TYPES = ["blog", "project", "podcast", "course"];

function buildServer() {
  const server = new McpServer({ name: "elle-mcp-server", version: "1.0.0" });

  server.registerTool("create_draft", {
    description:
      "Cr\u00e9e un brouillon dans Elle (blog, projet, podcast ou cours), ou met \u00e0 jour un " +
      "contenu existant si 'id' est fourni (ex. mettre \u00e0 jour la progression d'un cours). " +
      "Une NOUVELLE cr\u00e9ation reste toujours en brouillon. Une MISE \u00c0 JOUR ne touche jamais " +
      "au statut publi\u00e9/brouillon existant, dans un sens comme dans l'autre : seule une " +
      "personne publie ou d\u00e9publie du contenu.",
    inputSchema: {
      id: z.number().optional().describe("Fournir pour mettre \u00e0 jour un contenu existant plut\u00f4t que d'en cr\u00e9er un nouveau"),
      type: z.enum(CONTENT_TYPES).describe("Type de contenu"),
      title: z.string().min(1).describe("Titre du contenu"),
      blocks: z.array(z.record(z.any())).describe(
        "Blocs de contenu, dans l'ordre. Types possibles : " +
        "{type:'heading',level,text} | {type:'text',text} | {type:'quote',text} | " +
        "{type:'code',lang,code} | {type:'formula',mode,tex}"
      ),
      category: z.string().optional().describe("Cat\u00e9gorie libre"),
      subtype: z.enum(["external", "authored"]).optional().describe("Pour type=course uniquement"),
      source_url: z.string().optional().describe("Pour un cours externe uniquement"),
      source_platform: z.string().optional().describe("Pour un cours externe uniquement"),
      progress: z.number().min(0).max(100).optional().describe("Pour un cours externe uniquement, 0-100")
    },
    outputSchema: {
      ok: z.boolean(),
      id: z.number().optional(),
      slug: z.string().optional(),
      error: z.string().optional()
    }
  }, async (args) => {
    const result = await elle.createDraft(args);
    return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.registerTool("list_content", {
    description: "Liste les contenus d'Elle, avec filtres optionnels par type et par statut.",
    inputSchema: {
      type: z.enum(CONTENT_TYPES).optional(),
      status: z.enum(["draft", "published"]).optional(),
      limit: z.number().min(1).max(50).optional().describe("D\u00e9faut 20, max 50")
    },
    outputSchema: {
      ok: z.boolean(),
      items: z.array(z.record(z.any())).optional(),
      error: z.string().optional()
    }
  }, async (args) => {
    const result = await elle.listContent(args);
    return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.registerTool("get_content", {
    description: "R\u00e9cup\u00e8re le d\u00e9tail complet d'un contenu Elle par son slug (inclut les blocs).",
    inputSchema: { slug: z.string().min(1) },
    outputSchema: {
      ok: z.boolean(),
      item: z.record(z.any()).nullable().optional(),
      error: z.string().optional()
    }
  }, async ({ slug }) => {
    const result = await elle.getContent(slug);
    return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.registerTool("search_content", {
    description: "Recherche dans les contenus d'Elle (titre et texte des blocs).",
    inputSchema: {
      q: z.string().min(1).describe("Termes de recherche"),
      limit: z.number().min(1).max(50).optional()
    },
    outputSchema: {
      ok: z.boolean(),
      items: z.array(z.record(z.any())).optional(),
      error: z.string().optional()
    }
  }, async ({ q, limit }) => {
    const result = await elle.searchContent(q, limit);
    return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  return server;
}

// Mode "stateless" (sessionIdGenerator: undefined) : une instance de
// serveur + de transport par requ\u00eate. Pas besoin de suivre des sessions
// MCP pour ce cas d'usage (chaque appel d'outil est ind\u00e9pendant).
const app = createMcpExpressApp({ host: process.env.MCP_HOST || "127.0.0.1" });

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); server.close(); });
  } catch (e) {
    console.error("Erreur MCP:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erreur serveur" }, id: null });
    }
  }
});
app.get("/mcp", (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});
app.delete("/mcp", (req, res) => {
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, tools: ["create_draft", "list_content", "get_content", "search_content"] });
});

const PORT = parseInt(process.env.MCP_PORT || "3001", 10);
app.listen(PORT, () => {
  console.log("");
  console.log("  elle-mcp-server \u25B8 http://localhost:" + PORT + "/mcp");
  console.log("  (relaye vers Elle sur " + (process.env.ELLE_BASE_URL || "http://localhost:3000") + ")");
  console.log("");
});
