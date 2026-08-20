# Changements — fusion dans la livraison complète (front + elle-mcp-server) + vérification réelle

Cette livraison contenait, pour la première fois dans une même archive,
les trois services : `elle/` (site + Atelier), `elle-mcp-server/`, et une
version d'`elle-agents/` **antérieure** à `agent_projet`/au Canevas/au
quiz de cadrage. Ce qui a été fait :

## 1. `elle-agents/` remplacé par la version à jour

L'`elle-agents/` de cette livraison ne contenait ni `agent_projet/`, ni
`canvas_contract.py`/`choice_contract.py`, ni `web_search_tool.py`, ni le
support DeepSeek — une capture antérieure au travail des deux versions
précédentes de ce fichier. Diff complet fichier par fichier avant de
trancher : aucune perte, uniquement des ajouts de mon côté. L'ancien
dossier a été remplacé en bloc par la version à jour (`tests-python/` et
ce `CHANGES.md` remontés au même niveau que les trois services).

## 2. Bonne surprise : `type="project"` fonctionnait déjà

La note précédente de ce fichier flaggait `create_draft(type="project")`
comme dépendant d'un changement non vérifiable côté `elle-mcp-server`.
En recevant enfin ce service, verdict inverse : **rien à changer**.
`CONTENT_TYPES` dans `elle-mcp-server/server.js` inclut déjà `"project"`,
et le schéma SQLite d'Elle traite `project` comme un type de contenu de
première classe depuis le début (page `/projects`, seed de contenu de
démo, etc.). Prouvé par une **exécution réelle** de
`elle-mcp-server/test-client.js` contre un `elle/server.js` réellement
lancé (voir « Vérifié pour de vrai » plus bas pour le détail). Détail de
la correction dans la section dédiée, plus bas dans ce fichier.

## 3. Câblage du Canevas + du quiz de cadrage côté Atelier (`elle/`)

C'était le morceau manquant identifié dès la première version de ce
fichier : `app.js` ignorait complètement les champs `doc`/`choice` de la
réponse et re-parsait le markdown de `reply` pour l'afficher. Ajouté :

- **`server.js`** : `"projet"` ajouté à `AGENT_KEYS` et à la regex de la
  route `/admin/agents/:agent/chat` ; onglet **Projet** ajouté à la page
  Agents (5 onglets au total).
- **`public/app.js`** :
  - Agent `projet` déclaré dans la config `AGENTS` du script (label,
    endpoint, intro, placeholder).
  - **Panneau Canevas** : pour les agents `kind:"mcp"` (Blog, Notes de
    cours, Création de cours, Projet), la page passe en deux colonnes
    (`.agent-layout.has-canvas`) — chat à gauche, aperçu structuré à
    droite (`doc.title`/`kick`/`blocks` via `renderDocHtml` déjà
    existant, + liste de `sources`). Reste en une colonne sous 880px
    (empilé, chat d'abord). `doc` absent (tour conversationnel) : le
    panneau garde son dernier état plutôt que de se vider, conformément
    au contrat documenté dans `main.py`.
  - **Quiz de cadrage** (`choice`) : un bloc de boutons (texte + `why`)
    apparaît sous le fil de discussion quand la réponse contient un
    `choice`. Cliquer une option l'envoie comme réponse ; taper une
    réponse libre fonctionne tout aussi bien. Dans les deux cas, le quiz
    disparaît **immédiatement** à l'envoi (avant même la réponse de
    l'agent) — jamais un QCM qui bloque la conversation.
- **`public/styles.css`** : classes `.agent-layout`/`.canvas-pane`/
  `.canvas-*` et `.choice-box`/`.choice-opt*`, cohérentes avec les
  variables et rayons déjà utilisés ailleurs (`--line`, `--field`,
  `--r`, `--shadow-sm`...). Réutilise `.hidden` (déjà globale) plutôt que
  de redéfinir une règle équivalente.
- **READMEs** (`elle/`, `elle-mcp-server/`) : mis à jour pour refléter 4
  agents / 5 onglets et le nouveau panneau Canevas + quiz.

## Vérifié pour de vrai, dans ce bac à sable, en conditions quasi réelles

Contrairement aux vérifications précédentes (import Python isolé), cette
fois les **trois services ont réellement tourné en même temps** :

- **`elle/server.js`** lancé pour de vrai (Node 22, moteur `node:sqlite`
  intégré, pas besoin de `better-sqlite3`) ; compte admin créé ; page
  `/admin/assistant` récupérée et vérifiée : 5 boutons d'onglet présents
  (`quick, blog, notes-cours, creation-cours, projet`).
- **`elle-mcp-server`** installé (`npm install`) et lancé pour de vrai ;
  son propre script `test-client.js` exécuté contre le `elle/server.js`
  ci-dessus : `create_draft(type="project")`, `list_content`,
  `get_content`, `search_content` fonctionnent tous, et la règle « une
  mise à jour ne dépublie jamais » tient. Aucune modification nécessaire
  côté serveur MCP — voir point 2 plus haut.
- **`elle-agents`** lancé pour de vrai avec `uvicorn` (dans le même venv
  isolé que les tests Python) : `/health` confirme les 4 agents chargés.
  Appel réel `POST /admin/agents/projet/chat` à travers toute la chaîne
  (`elle` → `elle-agents` → LiteLLM → Ollama) : échoue proprement avec un
  message clair (Ollama non lancé dans ce bac à sable), sans jamais
  planter le serveur — comportement attendu et correctement remonté
  jusqu'au JSON renvoyé au client.
- **Rendu front réel du Canevas + du quiz** : la vraie page HTML rendue
  par `assistantPage()` chargée dans **jsdom**, le vrai `app.js` exécuté
  dedans, un `fetch` mocké renvoyant un payload `doc`+`choice` réaliste.
  Vérifié : bascule sur l'onglet Projet → mise en page deux colonnes ;
  message envoyé → `doc.title`/`kick`/`sources` s'affichent dans le
  panneau ; `choice` affiche 2 boutons avec leur `why` ; cliquer une
  option envoie bien son texte ET fait disparaître le quiz *avant même*
  la réponse ; les deux messages utilisateur (celui tapé, celui cliqué)
  apparaissent correctement dans le fil.

## Pas vérifiable depuis ce bac à sable (à faire chez vous)

- Une vraie conversation avec un modèle réel (Ollama/Anthropic/Gemini/
  Groq/DeepSeek au choix) : le bac à sable n'a accès à aucun fournisseur
  de modèle, donc aucun des 4 agents n'a pu réellement répondre — tout ce
  qui précède vérifie la plomberie autour du modèle, pas le modèle
  lui-même ni sa fiabilité à produire des blocs ```json```/```choice```
  bien formés.
- Rendu visuel réel dans un navigateur (jsdom simule le DOM et le JS,
  pas le CSS ni la mise en page pixel par pixel) — à confirmer à l'œil une
  fois lancé chez vous, en particulier le comportement du panneau Canevas
  en position `sticky` sur mobile étroit.

## Comment tester chez vous (ordre de démarrage)

Voir `README.md` à la racine de cette livraison pour la checklist
complète. En bref, trois terminaux : `elle-mcp-server` (port 3001) →
`elle-agents` (port 8001, `ELLE_MCP_URL` pointant sur le premier) →
`elle/` (port 3000, `ELLE_AGENTS_URL` pointant sur le deuxième,
`ELLE_AGENT_TOKEN` identique entre `elle` et `elle-mcp-server`).

---

# Changements — agent_projet + quiz de cadrage (`choice`)

```bash
python3 -m pytest tests-python/ -v   # 32 tests, tous réels (voir plus bas)
```

## Ce qui a changé

1. **`agent_projet/`** (nouveau) — quatrième agent, même structure que les
   trois autres (`__init__.py` + `agent.py`, `LlmAgent` avec le toolset MCP
   + web_search/web_fetch). Méthode en 4 étapes séquentielles, à ne pas
   sauter :
   1. **Cadrage** — douleur réelle / qui exactement / pourquoi maintenant.
   2. **Revue « CEO »** — challenge le scope, nomme explicitement
      l'hypothèse la plus risquée à tester en premier.
   3. **Scope MVP** — 3 à 5 fonctionnalités pour tester cette hypothèse,
      enregistrées via `create_draft (type="project")`.
   4. **Early adopters** — script d'entretiens façon Mom Test, puis mise à
      jour de la MÊME entrée projet (id existant) après chaque retour —
      jamais une nouvelle entrée, sur le modèle de ce que fait déjà
      `agent_notes_cours` pour un cours qu'on complète au fil des séances.

2. **`choice_contract.py`** (nouveau) — même logique qu'`extract_canvas`,
   pour un DEUXIÈME bloc structuré distinct : ```choice``` (au lieu de
   ```json```), contenant `{"question", "options":[{"text","why"}]}`.
   2 à 4 options obligatoires (moins n'est pas un choix, plus redevient
   une liste à lire). Utilisé par `agent_projet` à l'étape Cadrage pour
   poser une question fermée SANS que ce soit un QCM strict : l'instruction
   de l'agent précise explicitement que la personne peut toujours répondre
   en texte libre, et que cette réponse libre est parfaitement valide.

3. **`main.py`** — `ChatResponse` gagne un champ `choice: dict | None`,
   extrait juste après `doc` (les deux balises étant différentes, l'ordre
   d'extraction n'a pas d'incidence sur le parsing, mais garde un seul
   point d'entrée séquentiel). Route `/agents/projet/chat` ajoutée, agent
   enregistré dans `AGENTS`.

4. **`tests-python/test_choice_contract.py`** (nouveau) — 10 tests, même
   esprit que `test_canvas_contract.py` : bloc absent, JSON cassé, champ
   requis manquant, bornes 2-4 options, plusieurs blocs (on garde le
   dernier valide), et un test de coexistence `choice` + `json` dans le
   même message.

## Point corrigé : `create_draft` et `type="project"` — c'était déjà bon

**Correction par rapport à la version précédente de cette note** : en
recevant `elle-mcp-server` et `elle/` (livraison suivante, voir section
tout en haut de ce fichier), il s'avère que `type="project"` est accepté
**depuis le début** — `CONTENT_TYPES` dans `elle-mcp-server/server.js`
contient `["blog", "project", "podcast", "course"]`, et le schéma SQLite
d'Elle (`content-module.js`) a toujours eu `project` comme type de
première classe (page `/projects`, seed de contenu, etc.). Vérifié par
une **vraie exécution** de `elle-mcp-server/test-client.js` contre un
`elle/server.js` réellement lancé : `create_draft(type="project")`,
`list_content(type="project")`, `get_content`, `search_content`
fonctionnent tous, sans une seule ligne changée côté serveur. Détail dans
la section tout en haut de ce fichier.

Seul écueil mineur relevé (et sans conséquence visible) : `create_draft`
sans `subtype` explicite stocke `subtype="external"` par défaut même pour
un projet — mais tout l'affichage conditionné par `subtype` dans
`server.js` est déjà restreint à `a.type === "course"`, donc ça ne fuit
nulle part dans l'interface publique ou l'Atelier.

Choix délibéré de ne PAS ajouter un `subtype` pour la phase en cours
(cadrage/MVP/validation) : comme pour `kick`/`sources` dans le patch
précédent, la progression est encodée dans le CONTENU (un `heading` par
étape déjà franchie, cf. instruction de l'agent) plutôt que dans un champ
de schéma supplémentaire.

## Sur la question ouverte : généraliser le quiz de cadrage aux autres agents ?

Le mécanisme (`choice_contract.py`, champ `choice` dans `ChatResponse`) est
volontairement agent-agnostique au niveau du code : n'importe quel agent
pourrait émettre un bloc ```choice``` demain sans toucher à `main.py`.
Mais seule l'instruction d'`agent_projet` l'utilise pour l'instant — pas
`agent_blog`/`agent_notes_cours`/`agent_creation_cours`. Raisonnement :

- **`agent_blog`** et **`agent_creation_cours`** sont d'abord génératifs
  (proposer un angle, un titre, un plan de modules) : forcer un choix à
  chaque question ralentirait un brainstorm plutôt que de l'aider, et
  risquerait d'enfermer la personne dans les options que l'agent a
  imaginées plutôt que l'idée qu'elle avait en tête.
- **`agent_notes_cours`** restructure surtout un contenu déjà donné (la
  personne colle le texte d'une leçon) : il pose rarement une vraie
  question de cadrage à options discrètes.
- **L'étape Cadrage d'`agent_projet`** est, elle, structurellement pleine
  de questions à réponses plausibles en nombre limité (« qui exactement »,
  « pourquoi maintenant ») — le cas d'usage pour lequel ce mécanisme a été
  pensé.

Recommandation inchangée : garder le mécanisme partagé au niveau du code
(fait), ne l'activer QUE dans l'instruction d'`agent_projet` pour
l'instant, et revisiter une généralisation aux 3 autres une fois qu'on
l'aura vu fonctionner en usage réel — même logique « évolution sans tout
casser » que celle qui a fait passer ce projet d'un appel HTTP direct à
MCP (voir plus bas, section Architecture du README).

## Vérifié pour de vrai dans ce bac à sable (à cette étape)

- Les 32 tests passent (`python3 -m pytest tests-python/ -v`), y compris
  `test_tools_integrate_with_real_adk_agent` — `google-adk` installé pour
  de vrai dans un venv isolé (`python3 -m venv`, cf. recommandation du
  README) pour éviter tout conflit avec les paquets système.
- `main.py` s'importe et construit réellement l'app FastAPI avec les
  **4** agents chargés (`blog`, `notes-cours`, `creation-cours`, `projet`)
  et la route `/agents/projet/chat` — vérifié par exécution directe.
- `ChatResponse.model_fields` confirme les 5 champs attendus : `reply,
  session_id, tool_calls, doc, choice`.

## Pas vérifiable depuis ce bac à sable à cette étape (résolu depuis, voir plus haut)

- Un vrai agent qui décide, de lui-même, d'émettre le bloc ```choice``` en
  réponse à une conversation réelle de Cadrage — dépend du modèle branché ;
  reste à observer en usage réel une fois un fournisseur configuré (voir
  section tout en haut de ce fichier pour le reste, déjà vérifié pour de
  vrai depuis).

## Prochaine étape suggérée (à cette étape — obsolète, voir le haut du fichier)

~~Côté `elle-mcp-server` : ajouter `"project"` aux types acceptés~~ (déjà
bon, voir plus haut). ~~Côté Atelier (`app.js`) : un composant `choice`~~
(fait, voir tout en haut de ce fichier).

---

# Changements — branchement du Canevas sur les agents

Suite à la question laissée ouverte dans la version précédente
(« Canevas vs contrat `main.py` »), option retenue : **adapter `main.py`**
au contrat JSON structuré (`title` / `kick` / `blocks` / `sources`), en
gardant `{message, session_id} → {reply, session_id, ...}` comme
enveloppe de transport — pas de rupture de contrat HTTP, juste un champ
en plus.

```bash
python3 -m pytest tests-python/ -v   # 22 tests, tous réels (voir plus bas)
```

## Ce qui a changé

1. **`canvas_contract.py`** (nouveau) — extrait un bloc ```json``` du
   texte de réponse de l'agent, le valide contre le contrat
   `{title, kick, blocks, sources}`, et renvoie le texte affiché
   **débarrassé de ce bloc** (jamais de JSON brut dans une bulle de chat).
   `blocks` reprend exactement la forme de l'éditeur d'Elle
   (heading/text/quote/code/formula/image) : aucune traduction entre
   Canevas et `create_draft`.

2. **`main.py`** — `ChatResponse` gagne un champ `doc: dict | None`.
   Après calcul de `reply_text`, `extract_canvas()` en sort le doc pour le
   Canevas ; `null` pour un tour purement conversationnel (le Canevas
   garde alors son dernier état côté client, il ne se vide pas). Le
   docstring du module documente le nouveau contrat de réponse.

3. **Les 3 `agent.py`** — instruction ajoutée : terminer chaque message
   qui propose/met à jour un contenu concret par le bloc JSON du Canevas,
   et **réutiliser tel quel** ce même `title`/`blocks` au moment d'appeler
   `create_draft` plutôt que de les régénérer une seconde fois.

4. **`tests-python/test_web_search_tool.py`** — correctif d'un bug
   préexistant : `sys.path.insert(..., "livraison", "elle-agents")`
   pointait vers un dossier qui n'existe pas dans cette archive (la
   suite ne tournait pas du tout, `ModuleNotFoundError`). Remplacé par le
   chemin réel (`elle-agents/`, sœur de `tests-python/`).

5. **`tests-python/test_canvas_contract.py`** (nouveau) — 9 tests. L'un
   d'eux a révélé un vrai bug pendant l'écriture (voir plus bas) plutôt
   que d'être un test de complaisance.

## Point important : `create_draft` n'a PAS besoin de changer de schéma

La question posée était « quelle approche, sachant que ça touche
`create_draft` ? ». En creusant, ce n'est vrai qu'à moitié :

- **`kick` ne touche rien** : c'est déjà le champ `category` d'Elle
  (l'étiquette au-dessus du titre, cf. `esc(a.category || ...)` dans
  `server.js`). Aucun changement côté `create_draft`.
- **`sources` ne touche rien non plus, si on accepte un compromis** : les
  instructions demandent à l'agent de plier `sources` dans un bloc
  `"quote"` final (« Sources : ... ») au moment d'appeler `create_draft` —
  exactement le format d'avant. Le Canevas, lui, continue de les afficher
  à part grâce au bloc JSON. `create_draft` (côté `elle-mcp-server`) reste
  donc inchangé.

Si vous voulez un jour que les sources soient stockées comme des données
structurées (pas repliées en texte), il faudra alors ajouter un champ
`sources` optionnel au schéma de l'outil MCP — mais ce n'est plus une
nécessité immédiate pour brancher le Canevas, seulement une amélioration
possible plus tard.

## Bug trouvé en écrivant les tests

`extract_canvas()` ne retirait, dans une première version, que le
*dernier* bloc ```json``` du texte affiché. Si le modèle laisse un
brouillon JSON avant de se corriger dans le même message, le premier bloc
restait affiché brut dans la bulle de chat. Corrigé : tous les blocs
```json``` sont retirés de l'affichage (valides ou non), et c'est le
dernier bloc *valide* qui alimente le Canevas.

## Vérifié pour de vrai dans ce bac à sable

- Les 22 tests passent, `google-adk` installé pour de vrai (y compris le
  test qui construit un `LlmAgent` complet avec `McpToolset` + les 2
  outils de recherche web).
- `main.py` s'importe et construit réellement l'app FastAPI, avec les 3
  agents chargés et les 8 routes attendues (`/health` + 3×`/chat` +
  4 routes doc auto-générées par FastAPI) — vérifié par exécution directe,
  pas seulement lu.
- `ChatResponse.model_fields` confirme les 4 champs attendus :
  `reply, session_id, tool_calls, doc`.

## Pas vérifiable depuis ce bac à sable (à faire chez vous)

- Un vrai agent qui décide, de lui-même, d'émettre le bloc JSON du Canevas
  en réponse à une conversation réelle — ça dépend du modèle branché
  (Ollama local, Claude, DeepSeek...) et de sa fiabilité à suivre une
  consigne de formatage. À surveiller particulièrement avec un petit
  modèle local (`qwen2.5:7b-instruct`) : si le JSON sort mal formé,
  `extract_canvas()` l'ignore proprement (testé), mais le Canevas ne se
  mettra simplement pas à jour ce tour-ci.
- Le rendu du Canevas côté Atelier (`app.js` / la page **Agents**) : ce
  patch ne touche que `elle-agents`. Côté front, il ne reste plus qu'à
  afficher `doc` avec les fonctions déjà existantes `blockHtml` /
  `renderDocHtml` de `app.js` — même forme de blocs, zéro nouveau code de
  rendu à écrire, juste à câbler le composant Canevas sur ce champ de la
  réponse `/admin/agents/:agent/chat` (le pont Node existant n'a qu'à
  relayer le `doc` reçu de ce service, sans le transformer).

## Prochaine étape suggérée

Câbler le composant Canevas dans la page **Agents** de l'Atelier : un
panneau à côté du chat qui affiche `renderDocHtml(doc.blocks)` (déjà dans
`app.js`) et garde son dernier état quand `doc` est `null`. Le pont Node
(`/admin/agents/:agent/chat`) n'a besoin d'aucune modification : il relaie
déjà tout le corps de la réponse de ce service.
