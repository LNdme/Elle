# Changements — pièces jointes dans le Canevas (image d'illustration + fichier texte pour la bibliographie)

**55 tests réels** (45 Python + 10 front réels via jsdom, pilotés par de
vrais événements DOM — clic, saisie, changement de fichier — contre le
vrai `app.js`, pas des mocks de fonctions internes) :

```bash
cd livraison
python3 -m pytest tests-python/ -q                    # 45 tests
cd tests-frontend && npm install && node test_agents_attachments.js   # 10 tests
```

## Le problème que ça règle

Le Canevas (chat + document en direct, à la manière de la démo
`elle-canvas-demo.html`) était déjà branché sur les 4 agents MCP (Blog,
Notes de cours, Création de cours, Projet), mais **rien dans le chat ne
permettait de joindre un fichier** : ni une image pour illustrer un
article, ni un `.md`/`.txt` pour enrichir la bibliographie pendant la
rédaction. C'est ce qui manquait, exactement comme décrit.

## Choix de conception : pas de vision, volontairement

Une image jointe est uploadée **côté client**, avant l'appel à l'agent —
exactement comme la couverture d'un article dans l'éditeur classique
(réutilise `uploadFile()`, déjà existant dans `app.js`). Le modèle ne
reçoit jamais les octets de l'image : seulement son URL réelle, avec
consigne de la réutiliser telle quelle dans un bloc `"image"` si elle
illustre le contenu.

Pourquoi : les 5 fournisseurs configurables (Ollama local, Anthropic,
Gemini, Groq, DeepSeek) n'ont pas tous un support fiable et uniforme de la
vision via LiteLLM/ADK. Le besoin réel — illustrer un article — ne
nécessite pas que le modèle "voie" l'image, seulement qu'il connaisse son
URL. Un fichier texte/Markdown joint, lui, est simplement lu côté client
(`FileReader`) et son contenu inséré tel quel dans le message : l'agent
peut alors s'en inspirer et le citer dans `sources` avec `"url":""`.

## Ce qui a changé

**`elle-agents/`**
- `attachments.py` (nouveau) — modèle `Attachment` + `build_attachment_preamble()`, qui construit le texte à préfixer au message de la personne à partir des pièces jointes.
- `main.py` — `ChatRequest` accepte désormais `attachments: list[Attachment]` ; le préambule est injecté avant le message dans le `Content` envoyé au modèle. Un message vide est maintenant accepté s'il y a au moins une pièce jointe.
- Les 4 `agent_*/agent.py` — courte consigne ajoutée : réutiliser l'URL exacte d'une image jointe dans un bloc `"image"`, citer un fichier texte joint dans `"sources"` avec `"url":""`.

**`elle/`**
- `server.js`, `handleAgentProxyChat` — fait suivre `attachments` vers elle-agents ; accepte une requête sans `message` si des pièces jointes sont présentes.
- `public/app.js` — bouton trombone + liste de puces dans le composer (agents MCP uniquement, pas l'onglet « Rapide ») ; upload réel d'image via `uploadFile()` existant ; lecture réelle des fichiers texte via `FileReader` ; pièces jointes incluses dans le payload puis vidées après envoi ; puces affichées dans la bulle utilisateur envoyée ; rendu des sources corrigé pour ne plus produire de lien mort (`href=""`) quand une source est un fichier joint sans URL — affiche un tag « fichier joint » à la place.
- `public/styles.css` — styles pour le bouton d'attache, les puces, le tag « fichier joint », dans les tokens déjà existants (pas de nouvelle couleur).

## Vérifié pour de vrai

- Les 45 tests Python existants + les 8 nouveaux tests de `attachments.py` passent.
- **`tests-python/test_main_contract.py`** (nouveau) : vérifie avec un faux `Runner` (produisant de vrais objets `google.adk.events.Event`) que le préambule de pièce jointe atteint réellement le message envoyé au modèle, que l'extraction `doc`/`sources`/`tool_calls` fonctionne bout en bout.
- **`tests-frontend/test_agents_attachments.js`** (nouveau, jsdom) : charge le vrai `app.js` dans une vraie page, simule un vrai changement de fichier sur l'input, vérifie que l'image déclenche un vrai appel à `/admin/upload`, que le fichier texte n'en déclenche aucun, que l'URL réelle et le contenu réel atteignent le payload envoyé à l'agent, et que le rendu des sources ne produit pas de lien mort.

## Pas vérifiable depuis ce bac à sable

- Le rendu visuel réel dans un navigateur (jsdom valide le DOM/JS, pas le CSS calculé).
- L'appel réel de bout en bout avec un vrai modèle qui choisit effectivement d'insérer un bloc `"image"` ou de citer un fichier joint — la consigne est en place et testée pour la plomberie, mais le comportement du modèle lui-même reste à observer en usage réel.
