# Changements — édition/arrêt du chat + édition en place et remarques dans le Canevas

**94 tests réels** :
```bash
cd livraison
python3 -m pytest tests-python/ -q                              # 63 tests
cd tests-frontend && npm install
node test_agents_attachments.js && node test_canvas_design.js && node test_chat_and_block_editing.js   # 28 tests
cd ../tests-node && node test_agent_proxy_chat.js               # 3 tests
```

## 1. Modifier un message déjà envoyé

**Comment ça marche** : cliquer ✎ (visible au survol d'un message
utilisateur) transforme la bulle en zone éditable. Renvoyer tronque tout
ce qui suivait ce message côté client, et le serveur repart d'une
**session ADK neuve** dans laquelle l'historique précédent est rejoué via
`session_service.append_event()` — sans réappeler le modèle pour ces tours
passés, juste réinjecté tel quel. `session_id` renvoyé par le serveur
remplace celui du client.

**Limite assumée** (documentée dans `main.py`) : les pièces jointes des
tours antérieurs au message édité ne sont pas rejouées avec leur préambule
complet, seul le texte affiché côté client l'est. Cas rare, acceptable en
l'état.

**Fichiers touchés** : `main.py` (`ChatRequest.history`, `_replay_history`),
`server.js` (relaie `history`), `app.js` (`startMsgEdit`/`saveMsgEdit`,
bouton ✎ par message).

## 2. Arrêter un message en cours

**Comment ça marche** : le bouton Envoyer devient Stop pendant la
génération. Un clic déclenche un `AbortController.abort()` réel côté
navigateur → la connexion HTTP se ferme → **Node détecte la fermeture**
(`res.on("close")`) et annule à son tour son appel sortant vers
elle-agents avec son propre `AbortController` → **FastAPI détecte la
déconnexion** (`request.is_disconnected()`, sondé en tâche de fond) et
annule pour de vrai la tâche asyncio qui consommait le Runner
(`asyncio.Task.cancel()`) — la génération ne continue donc pas en tâche de
fond après un Stop, et ne pourra pas appeler `create_draft` après coup.

**Vérifié réellement** (pas supposé) :
- `test_main_edit_and_stop.py` : un faux Runner délibérément lent (5s)
  reçoit bien une vraie `CancelledError`, la requête se termine en moins
  de 2s (pas d'attente des 5s).
- `test_agent_proxy_chat.js` : le motif exact `res.on("close") → abort()`
  utilisé dans `server.js` est vérifié isolément avec un vrai serveur HTTP
  et une vraie destruction de connexion TCP côté client — voir la note
  dans ce fichier sur pourquoi la vérification à 3 sauts complets
  (navigateur → Node → elle-agents) via `server.js` entier s'est révélée
  instable dans ce bac à sable (timing du socket TCP), et pourquoi isoler
  le mécanisme lève cette ambiguïté. **La vérification en conditions
  réelles (navigateur + Node + elle-agents déployés) reste à faire
  manuellement une fois en place.**

**Fichiers touchés** : `main.py` (`_watch_disconnect`, `_consume_run`,
requêtes 499 si annulé), `server.js` (`AbortController` propagé vers le
fetch sortant), `app.js` (bouton Stop, message "Message interrompu").

## 3. Modifier un bloc du Canevas en place

**Comment ça marche** : survoler un bloc titre/texte/citation fait
apparaître ✎. Cliquer transforme ce bloc en zone éditable ; Enregistrer
met à jour uniquement ce bloc, sans aucun appel réseau (c'est un aperçu
côté client, la persistance reste le rôle de `create_draft`).

**Fichiers touchés** : `app.js` (`canvasBlocksHtml`, `startBlockEdit`,
`saveBlockEdit`), `styles.css` (`.block-wrap`, `.block-toolbar`, `.block-edit-area`).

## 4. Remarque ciblée sur un bloc (✎/💬 → révision par l'agent)

**Comment ça marche** : 💬 (visible sur texte/citation, pas sur les titres)
ouvre un champ de remarque. L'envoi appelle un **nouvel endpoint**
`/agents/{key}/remark`, avec le bloc ciblé + la remarque. L'agent reçoit
une instruction stricte : renvoyer *uniquement* la révision de ce bloc
précis (même id, même type), pas tout le document. Seul ce bloc est
remplacé côté Canevas — les autres blocs, la conversation et `state.doc`
(hormis ce bloc) restent intacts.

**Garde-fous** (`canvas_contract.extract_block_revision`) : si l'agent
dérive (change l'id, change le type, ou ne renvoie pas de JSON exploitable),
le serveur répond 502 plutôt que d'accepter une révision incohérente — le
bloc reste inchangé côté client, avec un message d'erreur.

Réutilise le même mécanisme d'annulation que `/chat` (Stop fonctionne
aussi sur une remarque en cours).

**Fichiers touchés** :
- `canvas_contract.py` — `BlockRevisionContract`, `extract_block_revision()`.
- `main.py` — `RemarkRequest`/`RemarkResponse`, `_run_remark`, routes
  `/agents/{blog,notes-cours,creation-cours,projet}/remark`.
- `server.js` — `handleAgentProxyRemark`, route `/admin/agents/{key}/remark`.
- `app.js` — `openBlockRemark`, `submitBlockRemark`.
- `styles.css` — `.remark-pop`, `.remark-thinking`.

## Vérifié pour de vrai

- **63 tests Python** dont 15 nouveaux : révision de bloc (contrat +
  garde-fous d'id/type), endpoint `/remark` complet (succès, erreurs
  400/502, annulation), rejeu d'historique réel (relu depuis
  `session_service` après coup, pas supposé), annulation réelle du Runner.
- **28 tests front (jsdom)** dont 10 nouveaux : édition de message avec
  troncature et vérification du payload exact envoyé au serveur, bouton
  Stop avec vraie `AbortError`, édition de bloc en place, remarque ciblée
  avec vérification qu'un seul bloc change.
- **3 tests Node** : `history` relayé par le vrai `server.js` lancé en
  processus séparé ; mécanisme d'annulation vérifié isolément.

## Pas vérifiable depuis ce bac à sable

- Le comportement réel de bout en bout avec un vrai modèle (la consigne
  de révision ciblée est en place et testée pour la plomberie, mais son
  respect effectif par le modèle reste à observer en usage réel).
- L'annulation à 3 sauts complets (navigateur réel + Node + elle-agents
  déployés) — voir la note dans `test_agent_proxy_chat.js`.
