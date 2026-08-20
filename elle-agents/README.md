# elle-agents

Service Python (ADK) qui expose quatre agents pour l'Atelier d'Elle :
- **agent_blog** — trouve/structure des idées d'articles
- **agent_notes_cours** — transforme un cours suivi ailleurs en notes structurées
- **agent_creation_cours** — conçoit un cours original, module par module
- **agent_projet** — challenge une idée de projet (cadrage, hypothèse la
  plus risquée, MVP, entretiens early adopters) avant d'y investir du temps
  de développement

Tourne en process séparé du serveur Node d'Elle. Les agents parlent à
Elle via **MCP** (`elle-mcp-server`, à lancer en même temps) — ils ne
touchent jamais Elle directement. Basculer entre modèle local (Ollama) et
modèle cloud (Claude/Gemini) se fait avec **une seule variable
d'environnement**, sans toucher au code des agents.

## Installation

```bash
cd elle-agents
python3 -m venv .venv && source .venv/bin/activate   # recommandé : évite les conflits de paquets système
pip install -r requirements.txt
cp .env.example .env
```

Remplissez `.env` :
- `ELLE_MCP_URL` doit pointer vers `elle-mcp-server` (par défaut `http://localhost:3001/mcp`).
- `ELLE_MODEL_PROVIDER` = `ollama` (par défaut), `anthropic`, `gemini` ou `groq`.
- Le reste dépend du fournisseur choisi (voir les commentaires dans `.env.example`).

> **Sécurité** : `requirements.txt` fixe `litellm>=1.83.0` volontairement — les
> versions 1.82.7 et 1.82.8 ont été compromises sur PyPI le 24 mars 2026
> (vol d'identifiants). Le paquet a depuis été nettoyé et une installation
> aujourd'hui est sûre par défaut, mais ce pin coûte rien et évite d'y
> retomber via un vieux cache. Règle générale utile ici : ne collez jamais
> une clé API dans un chat ou un message — mettez-la directement dans
> `.env`, qui ne doit jamais être commité (ajoutez-le à `.gitignore`).

## Lancement

Il faut les **trois** services, dans cet ordre :

```bash
# 1. Elle (dans le dossier du site)
ELLE_AGENT_TOKEN=xxxx node server.js

# 2. elle-mcp-server (même ELLE_AGENT_TOKEN dans son .env)
cd elle-mcp-server && npm start

# 3. elle-agents
cd elle-agents && source .venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8001
```

## Utilisation

```bash
curl -X POST http://localhost:8001/agents/blog/chat \
  -H "Content-Type: application/json" \
  --data '{"message": "3 idées d'\''articles sur le minimalisme numérique"}'
```

Réponse : `{"reply": "...", "session_id": "..."}`. Renvoyez ce `session_id`
au tour suivant pour continuer la même conversation — pas besoin de
renvoyer tout l'historique à chaque fois, ADK le garde en mémoire côté
service (tant que le process tourne).

Quatre agents, quatre routes : `/agents/blog/chat`, `/agents/notes-cours/chat`,
`/agents/creation-cours/chat`, `/agents/projet/chat`. `GET /health` renvoie
la liste des agents chargés.

Depuis l'ajout d'`agent_projet`, la réponse peut aussi contenir un champ
`choice` (question de cadrage à 2-4 options, avec une explication par
option) en plus de `doc` — voir le docstring de `main.py` et
`choice_contract.py` pour le détail du contrat.

## Ce qui a été testé, et ce qu'il reste à vérifier chez vous

Testé de bout en bout dans l'environnement de développement : construction
des 4 agents, bascule Ollama/Anthropic/Gemini, démarrage du service
FastAPI, validation des requêtes — et surtout, la chaîne complète en
conditions réelles : les agents découvrent bien les 4 outils via MCP
(`create_draft`, `list_content`, `get_content`, `search_content`) depuis
un `elle-mcp-server` réellement lancé, lui-même relié à une vraie instance
d'Elle. Vérifié aussi : une mise à jour par un agent ne dépublie jamais un
contenu déjà publié par une personne.

**Pour `agent_projet` en particulier**, voir CHANGES.md pour un point
important non résolu dans ce dépôt : `create_draft` avec `type="project"`
suppose qu'`elle-mcp-server` accepte cette valeur, ce qui reste à vérifier/
ajouter côté serveur MCP (pas dans cette archive).

**Pas testable dans cet environnement de développement** (aucun modèle
disponible) : un vrai appel modèle de bout en bout, où l'agent *décide*
d'appeler un outil suite à une vraie conversation. Toute la mécanique
autour de cet appel (découverte d'outils, exécution, écriture dans Elle)
est déjà prouvée ; il ne reste qu'à brancher un vrai modèle (Ollama local
ou une clé API) pour vérifier le raisonnement de l'agent lui-même.

## Architecture : pourquoi MCP plutôt qu'un appel direct

Une première version appelait l'API d'Elle directement en HTTP depuis
chaque agent (fichier `elle_tools.py`, maintenant supprimé). Une fois
`elle-mcp-server` construit, le remplacement s'est fait sans toucher aux
instructions des agents : `tools=[create_draft]` est devenu
`tools=[get_elle_toolset()]`, et les agents ont gagné 3 outils
(`list_content`, `get_content`, `search_content`) qu'ils n'avaient pas
avant — exactement le genre d'évolution "sans tout casser" que
l'architecture en services séparés est censée permettre.

## Intégration Atelier

Fait : la page **Agents** de l'Atelier a un onglet par agent, en plus de
l'assistant rapide d'origine. Elle passe par un pont côté Node
(`/admin/agents/:agent/chat`, authentifié comme le reste de l'Atelier),
qui relaie vers ce service. Aucun CORS à gérer : le navigateur ne parle
qu'à Elle, jamais directement à ce service.

`ELLE_AGENTS_URL` (variable d'env côté Elle, `server.js`) doit pointer
vers ce service — par défaut `http://localhost:8001`, à changer si vous
le faites tourner ailleurs sur votre réseau local.

## Prochaine étape suggérée

`agent_projet` est fait ; il reste, côté serveur MCP (`elle-mcp-server`,
hors de ce dépôt) :
1. Accepter `type="project"` dans `create_draft`/`list_content`/
   `search_content` — sans ça, l'étape 3 (Scope MVP) d'`agent_projet`
   échouera à l'enregistrement.
2. Le rendu du quiz de cadrage (`choice`) côté Atelier : un composant qui
   affiche les options en boutons (avec leur `why`) et les fait disparaître
   une fois une réponse envoyée — remplacées par la réponse retenue, comme
   pour `doc`/le Canevas. Voir CHANGES.md pour la discussion sur une
   éventuelle généralisation de ce composant aux 3 autres agents.
3. Intégration GitHub (commit/push via le serveur MCP officiel de GitHub),
   pour tester un projet avant de le publier.
