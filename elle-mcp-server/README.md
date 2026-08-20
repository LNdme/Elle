# elle-mcp-server

Serveur MCP qui expose le contenu d'Elle à n'importe quel client MCP —
les agents ADK, mais aussi Claude Desktop ou tout autre outil MCP si un
jour vous voulez piloter votre blog depuis autre chose.

4 outils exposés :
- **create_draft** — crée un contenu (blog/projet/podcast/cours), ou met à jour
  un contenu existant si `id` est fourni. Une nouvelle création reste
  toujours en brouillon ; une mise à jour ne touche jamais au statut
  publié/brouillon existant.
- **list_content** — liste les contenus, filtrable par type et statut.
- **get_content** — détail complet d'un contenu par son slug (avec les blocs).
- **search_content** — recherche texte dans les titres et le contenu.

C'est un simple relais : il ne touche jamais SQLite directement, il
appelle l'API `/api/agent/*` d'Elle (même jeton, même logique de
sauvegarde que l'Atelier). Elle doit donc tourner en même temps.

## Installation

```bash
cd elle-mcp-server
npm install
cp .env.example .env
```

`ELLE_AGENT_TOKEN` dans `.env` doit être **identique** à celui utilisé
pour lancer `server.js` (Elle).

## Lancement

```bash
npm start
```

Le serveur écoute par défaut sur `http://localhost:3001/mcp`, en
Streamable HTTP (le transport MCP recommandé aujourd'hui — pas de SSE
séparé à gérer). Mode "stateless" : chaque appel d'outil est indépendant,
pas de session à suivre entre deux appels.

`MCP_HOST` vaut `127.0.0.1` par défaut (protection anti DNS-rebinding
automatique, fournie par le SDK MCP). Si le service agents tourne sur une
autre machine de votre réseau local, passez `MCP_HOST=0.0.0.0` — mais
sachez que le endpoint `/mcp` n'a pas d'authentification propre pour
l'instant (seul l'appel *sortant* vers Elle est protégé par jeton) :
à réserver à un réseau local de confiance, pas à exposer sur internet.

## Vérifier que ça marche

```bash
node test-client.js
```

Ce script se connecte avec un vrai client MCP, appelle les 4 outils, et
vérifie que le brouillon créé reste bien invisible publiquement et que le
statut publié/brouillon résiste à une mise à jour par un agent.

## SDK MCP : note sur la version

Ce projet utilise `@modelcontextprotocol/sdk` v1.x (le paquet stable au
moment de l'écriture). Une nouvelle spec MCP v2 et un découpage du SDK en
paquets séparés (`@modelcontextprotocol/server`, `/node`, `/express`...)
sont en cours de stabilisation. Pas d'urgence à migrer : v1.x reste
maintenu, à surveiller pour plus tard.

## Qui appelle ce serveur

Aujourd'hui : les quatre agents dans `elle-agents/` (via `McpToolset`
d'ADK). Rien n'empêche d'y connecter aussi Claude Desktop ou un autre
client MCP compatible Streamable HTTP si vous voulez explorer/éditer
votre contenu Elle depuis ailleurs.
