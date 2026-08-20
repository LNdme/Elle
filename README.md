# Elle — vue d'ensemble

Trois services distincts, à lancer dans cet ordre (chacun dans son
propre terminal) :

```
elle-mcp-server  (port 3001)  ──▶  elle/  (port 3000)
        ▲                              │
        │                              │ ELLE_AGENTS_URL
        └──────────  elle-agents (port 8001)
```

- **`elle/`** — le site + l'Atelier (Node, sans dépendance obligatoire).
  Voir `elle/README.md`.
- **`elle-mcp-server/`** — relaie les 4 outils MCP (`create_draft`,
  `list_content`, `get_content`, `search_content`) vers l'API `/api/agent/*`
  d'Elle. Voir `elle-mcp-server/README.md`.
- **`elle-agents/`** — service Python (ADK) qui expose 4 agents
  (`blog`, `notes-cours`, `creation-cours`, `projet`). Voir `elle-agents/README.md`.

`tests-python/` couvre les contrats `doc`/`choice` extraits des réponses
des agents (`canvas_contract.py`/`choice_contract.py`) et l'intégration
des outils web avec ADK — indépendant des trois services ci-dessus.

`CHANGES.md` documente l'historique des décisions (pourquoi MCP plutôt
qu'un pont HTTP direct, le contrat Canevas, `agent_projet`, le quiz de
cadrage, et la fusion de cette livraison) — utile pour comprendre le
*pourquoi*, pas seulement le *comment*.

## Démarrage local, étape par étape

### 1. `elle-mcp-server`

```bash
cd elle-mcp-server
npm install
cp .env.example .env
# Dans .env : choisissez un ELLE_AGENT_TOKEN (une chaîne random quelconque),
# et gardez ELLE_BASE_URL=http://localhost:3000 (valeur par défaut)
npm start
```

Vérifier : `curl http://localhost:3001/health`.

### 2. `elle-agents`

```bash
cd elle-agents
python3 -m venv .venv && . .venv/bin/activate   # environnement isolé, cf. README du dossier
pip install -r requirements.txt
cp .env.example .env
# Dans .env : ELLE_MCP_URL=http://localhost:3001/mcp, et un fournisseur de
# modèle (ELLE_MODEL_PROVIDER=ollama|anthropic|gemini|groq|deepseek + sa clé)
uvicorn main:app --host 0.0.0.0 --port 8001
```

Vérifier : `curl http://localhost:8001/health` → doit lister les 4 agents.

### 3. `elle/`

```bash
cd elle
# ELLE_AGENT_TOKEN doit être IDENTIQUE à celui mis dans elle-mcp-server/.env
ELLE_AGENT_TOKEN=<le-même-jeton> node server.js
```

Ouvrez `http://localhost:3000/admin` : le tout premier accès crée le
compte administrateur. Puis **Agents** dans la barre de l'Atelier — 5
onglets (Rapide, Blog, Notes de cours, Création de cours, Projet).
Les 4 derniers nécessitent `elle-agents` et `elle-mcp-server` déjà lancés ;
sans eux, ils répondent une erreur réseau claire plutôt que de planter.

### Tout arrêter

`Ctrl+C` dans chacun des trois terminaux (ou `pkill -f "node server.js"` /
`pkill -f uvicorn`).

## Ce qui a été vérifié pour de vrai avant cette livraison

Les trois services ont réellement tourné ensemble le temps de cette
vérification (compte admin créé, `create_draft(type="project")` exécuté
pour de vrai via `elle-mcp-server/test-client.js`, page Agents chargée
avec ses 5 onglets, panneau Canevas et quiz de cadrage testés avec un
`fetch` simulé dans un vrai DOM via jsdom). Voir la section la plus
récente de `CHANGES.md` pour le détail complet, y compris ce qui **n'a
pas** pu être vérifié dans ce bac à sable (surtout : une vraie
conversation avec un modèle réel, faute de fournisseur disponible ici).
