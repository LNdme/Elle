# Elle — journal personnel (Blog · Projets · Podcasts)

Un site magazine **et** son atelier de rédaction privé, qui tourne **sur votre téléphone** via Termux.
Aucune dépendance obligatoire : le serveur utilise le moteur **SQLite intégré à Node**. Vos contenus sont
stockés localement et survivent au redémarrage.

---

## Démarrage rapide (Termux, Android)

1. Installez Termux (depuis F-Droid de préférence), puis :
   ```bash
   pkg update -y && pkg install nodejs unzip -y
   ```
2. Copiez `elle-server.zip` dans Termux, puis :
   ```bash
   unzip elle-server.zip
   cd elle-server
   node server.js
   ```
3. Ouvrez le navigateur du téléphone sur **http://localhost:3000**
   L'atelier est sur **http://localhost:3000/admin** — le **premier accès** vous fait créer le **compte administrateur**. Si une ancienne base utilisait encore le PIN, l'atelier propose une migration vers l'authentification complète.

> Node ≥ 18 suffit. Si votre version de Node ne charge pas le SQLite intégré :
> `node --experimental-sqlite server.js` — ou installez le moteur classique : `npm install better-sqlite3` puis relancez.

Changer le port : `PORT=8080 node server.js`

---

## Déploiement en ligne (Render)

Le site est un **serveur Node de longue durée** avec une base **SQLite en
fichier** : il lui faut un hébergeur avec disque persistant. Render convient.

1. Poussez ce dépôt sur GitHub (la base `elle/data/elle.db` et les fichiers
   `.env` ne sont **pas** versionnés — `seed()` recrée le contenu de démo).
2. Dashboard Render → **New → Blueprint** → connectez le dépôt. Le fichier
   `render.yaml` à la racine décrit le service `elle` ; un disque persistant
   (`elle/data`) est prévu — il nécessite un plan payant Render (le plan
   gratuit redémarre de zéro à chaque redéploiement).
3. Déployé, ouvrez `https://<service>.onrender.com/admin` : le **premier
   accès** crée le compte administrateur.
4. Réglages recommandés dans l'onglet Environment du service :
   - `AUTH_SECRET` : une longue chaîne aléatoire (sécurise les sessions).
   - `ANTHROPIC_API_KEY` (facultatif) si vous voulez l'onglet « Rapide ».

> Node ≥ 22.13 requis (SQLite intégré sans drapeau). Le `render.yaml` fixe
> `NODE_VERSION=22.13.0`.

---

## Ce que contient le site

- **Accueil** : un **héro** configurable, des **carrousels** (Blog, Projets, Podcasts) et un **espace Questions**.
- **Quatre types de contenus**, avec chacun sa page de liste (`/blog`, `/projects`, `/podcasts`, `/courses`) :
  chaque contenu se crée avec le même éditeur en blocs et peut être mis **en vedette**.
- **Espace communauté** (`/contribuer`) : les visiteurs créent un petit compte, déposent une **idée**,
  un **bug** ou une **suggestion**, et suivent leurs contributions dans « Mon espace ». L'Atelier reste
  réservé au **rôle administrateur** — les comptes « visiteur » n'y ont aucun accès. Côté atelier,
  **Contributions** et **Messages** permettent de modérer le tout.
- **Pages fixes** centrées (À propos, Contact…), modifiables dans l'atelier.
- **Espace Questions** (accordéon) entièrement éditable.
- **Assistant IA** dans l'atelier pour trouver et structurer des idées (voir plus bas).
- Thème **clair / sombre**, design responsive (téléphone → grand écran).

### Le héro d'accueil (Réglages → Page d'accueil)
Deux styles :
- **Grand texte + bouton** : un grand titre, un sous-titre et un bouton d'appel à l'action.
- **Image + texte** : une image à côté du texte (ajoutez l'image dans les réglages).

### L'éditeur en blocs
Titre, Texte (avec **gras**, *italique*, `code`, [liens](https://exemple.fr), listes `-`, et formules `$…$`),
Image, Code (coloration), Formule (LaTeX/KaTeX), Citation. Aperçu en direct, brouillon ou publié, mise en vedette.

### Les cours (`/courses`)
Deux façons d'utiliser ce type de contenu, choisies dans l'éditeur :
- **Notes prises sur une plateforme** (ex. un MOOC) : renseignez la plateforme et le lien source, suivez votre
  progression (0–100 %), et prenez vos notes avec les mêmes blocs que le reste du site (formules, code, citations).
- **Cours que vous concevez vous-même** : pas de source externe ; utilisez des blocs Titre (H2) pour découper le
  cours en modules/leçons.

---

## Assistant IA (facultatif)

La page **Agents** de l'Atelier (anciennement « Assistant ») a 5 onglets :

- **Rapide** — l'assistant d'origine, qui appelle directement l'API Anthropic
  (voir ci-dessous). Fonctionne seul, sans rien d'autre à lancer.
- **Blog**, **Notes de cours**, **Création de cours**, **Projet** — quatre
  agents plus capables (service séparé `elle-agents`, voir son README), qui
  peuvent créer ou mettre à jour un brouillon **eux-mêmes** pendant la
  conversation (toujours en statut brouillon — jamais publié directement).
  Nécessitent `elle-agents` et `elle-mcp-server` lancés en même temps qu'Elle
  (`ELLE_AGENTS_URL`, par défaut `http://localhost:8001`). À côté du chat,
  un panneau **Canevas** affiche l'aperçu structuré (titre, contenu, sources)
  que l'agent construit au fil de la conversation ; l'agent **Projet** pose
  en plus, à l'étape de cadrage, des questions à choix (boutons + courte
  explication) qui disparaissent dès qu'une réponse est envoyée — cliquée ou
  tapée librement, peu importe.

### Onglet « Rapide »

Il appelle l'API d'Anthropic — il faut donc **votre propre clé** et une connexion internet.

Deux façons de fournir la clé :
- **Variable d'environnement (recommandé, prioritaire)** :
  ```bash
  ANTHROPIC_API_KEY=sk-ant-xxxx node server.js
  ```
- **Dans l'atelier** : Réglages → *Assistant* → collez la clé (stockée localement dans la base).

Le **modèle** est réglable (par défaut `claude-sonnet-4-6`). Depuis cet onglet, le bouton
**« Créer le brouillon »** transforme la dernière réponse en brouillon d'article, de projet ou de podcast.
Sans clé, l'onglet affiche simplement un message d'aide — les 4 autres onglets restent utilisables.

---

## Sauvegarde & données

Tout est dans le dossier **`data/`** :
- `data/elle.db` — la base (textes, réglages, questions…)
- `data/uploads/` — les images

**Sauvegarder** = copier le dossier `data/` ailleurs. **Restaurer** = le remettre à sa place.
Au tout premier lancement, des contenus d'exemple sont créés ; supprimez-les quand vous voulez.

---

## Lancer en tâche de fond (optionnel)

```bash
nohup node server.js > elle.log 2>&1 &
```
Pour arrêter : `pkg install procps -y` puis `pkill -f server.js`.
Pour éviter que le téléphone ne coupe Termux : `termux-wake-lock`.

---

## Notes

- Premier chargement : les polices, KaTeX et la coloration du code viennent d'un CDN (internet requis une fois,
  puis mis en cache). Le reste fonctionne hors-ligne.
- Authentification oubliée ? Si votre base est neuve, relancez la création du compte administrateur. Si vous venez d'une ancienne base avec PIN, utilisez le formulaire de migration du premier accès. En dernier recours, vous pouvez supprimer
  cette ligne avec un outil SQLite, ou repartez d'une base neuve en supprimant `data/elle.db`.
- Projet 100 % local : aucune donnée n'est envoyée ailleurs, sauf les requêtes que **vous** adressez à
  l'assistant IA si vous l'activez.
