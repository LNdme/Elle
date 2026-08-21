#:package Aspire.Hosting.JavaScript@13.5.1
#:package Aspire.Hosting.Python@13.5.1
#:sdk Aspire.AppHost.Sdk@13.4.2+d7d0b6759ce4b936c76bc4775814d27db560dd6d

var builder = DistributedApplication.CreateBuilder(args);

// Paramètres partagés — évitent de hardcoder des secrets dans le code.
// Valeurs par défaut en local : ELLE_AGENT_TOKEN=1234 (doit matcher entre elle et elle-mcp-server).
var agentToken = builder.AddParameter("elle-agent-token", secret: true);
var openRouterKey = builder.AddParameter("openrouter-api-key", secret: true);
var anthropicKey = builder.AddParameter("anthropic-api-key", secret: true);

// 1) Elle — site + atelier (Node, SQLite). Port 3000, endpoint externe.
var elle = builder.AddNodeApp("elle", "elle", "server.js")
    .WithHttpEndpoint(port: 3000, env: "PORT")
    .WithExternalHttpEndpoints()
    .WithEnvironment("ELLE_AGENT_TOKEN", agentToken);

// 2) elle-mcp-server — relais MCP (Node/Hono). Port 3001.
// ELLE_BASE_URL pointe vers elle via service discovery, pas localhost hardcodé.
var mcp = builder.AddNodeApp("elle-mcp-server", "elle-mcp-server", "server.js")
    .WithHttpEndpoint(port: 3001, env: "MCP_PORT")
    .WithEnvironment("MCP_HOST", "127.0.0.1")
    .WithEnvironment("ELLE_BASE_URL", elle.GetEndpoint("http"))
    .WithEnvironment("ELLE_AGENT_TOKEN", agentToken)
    .WithExternalHttpEndpoints();

// 3) elle-agents — 4 agents Python (FastAPI/Uvicorn). Port 8001.
// ELLE_MCP_URL pointe vers le MCP via service discovery.
var agents = builder.AddUvicornApp("elle-agents", "elle-agents", "main:app")
    .WithHttpEndpoint(port: 8001, env: "PORT")
    .WithEnvironment("ELLE_MCP_URL", $"{mcp.GetEndpoint("http")}/mcp")
    .WithEnvironment("ELLE_MODEL_PROVIDER", "openrouter")
    .WithEnvironment("OPENROUTER_API_KEY", openRouterKey)
    .WithEnvironment("ANTHROPIC_API_KEY", anthropicKey)
    .WithExternalHttpEndpoints();

// Boucle de service discovery : elle a besoin de connaître l'URL des agents
// (pour /api/agent/*). On l'ajoute après coup pour éviter la dépendance circulaire
// au moment de la construction — Aspire résout l'endpoint au runtime.
elle.WithEnvironment("ELLE_AGENTS_URL", agents.GetEndpoint("http"));

builder.Build().Run();