# Corrections de design — le Canevas se rapproche de la démo

**63 tests réels** (45 Python + 18 front via jsdom, pilotés par de vrais
événements DOM contre le vrai `app.js`).

## Ce qui clochait, concrètement

En comparant le Canevas réellement implémenté (lu dans `app.js`/`styles.css`)
à `elle-canvas-demo.html`, quatre écarts nets :

1. **Proportions inversées.** `grid-template-columns:1fr 320px` — le chat
   prenait toute la place, le document (ce qui compte le plus) était
   relégué à une colonne fixe de 320px. La démo faisait l'inverse
   (chat étroit à 340px, document large) : le document est ce qu'on lit,
   le chat est l'outil pour l'amender.
2. **Aucune élévation "papier".** `box-shadow:var(--shadow-sm)` — une ombre
   d'1px, la même que n'importe quelle carte du site. Pas de sensation de
   feuille posée sur le bureau.
3. **Aucune animation.** Le seul signal pendant la réflexion était le mot
   "réfléchit…" en texte plat. Aucune reprise du curseur d'encre — la
   seule signature visuelle que je m'étais autorisée dans la démo.
4. **Pas de bascule mobile.** En dessous de 880px, chat et Canevas étaient
   simplement empilés — il fallait faire défiler tout le fil de
   discussion pour voir le document.

## Corrections apportées

- **`styles.css`** : grille inversée (`340px 1fr`, chat puis document),
  `.canvas-pane` élevé (ombre large `0 18px 40px`, rayon 16px, padding
  généreux), nouveau jeton `--canvas-shadow` (clair + sombre) ; curseur
  d'encre (`.ink-dot`, `@keyframes ink-breathe`) réutilisé dans
  l'indicateur de réflexion ; animation de révélation
  (`.canvas-pane.reveal`, `@keyframes canvas-ink-wipe`) rejouée à chaque
  nouvelle version du document ; bascule mobile `.canvas-switch`
  (Discussion / Page) avec pastille de mise à jour, respect de
  `prefers-reduced-motion`.
- **`app.js`** : en-tête du Canevas passe du texte statique "Aperçu" à un
  libellé d'agent + un statut ("brouillon prêt") ; `renderCanvas()`
  redéclenche l'animation à chaque mise à jour (retrait/reflow/ajout de la
  classe, seule façon fiable de rejouer une animation CSS après un
  changement de contenu) ; bascule mobile câblée (clic, changement
  d'onglet réinitialise sur "Discussion").

## Vérifié pour de vrai (jsdom, vrais événements DOM)

- L'en-tête affiche bien "Blog" (pas "Aperçu"), le statut passe de vide à
  "brouillon prêt" après réception d'un document.
- La classe `reveal` est bien ajoutée après une mise à jour.
- Le curseur d'encre est bien présent dans l'indicateur de réflexion
  pendant qu'une requête est en vol (fetch volontairement jamais résolu
  dans ce test, pour capter l'état intermédiaire réel).
- La bascule mobile change bien l'affichage, fait apparaître/disparaître
  la pastille, et se réinitialise au changement d'onglet.

## Ce qui n'a PAS été fait — à trancher avant de continuer

La démo permettait aussi de **modifier un bloc en place** et de **laisser
une remarque ciblée sur un passage précis** (icônes ✎ / 💬 au survol d'un
bloc). Le Canevas réel reste pour l'instant un **aperçu en lecture seule**
(`renderDocHtml` affiche, mais rien n'est cliquable dans le document).

C'est une pièce plus grosse que les corrections de design ci-dessus : elle
demanderait un contrat serveur supplémentaire (envoyer une remarque ciblée
sur un bloc précis et ne recevoir que ce bloc révisé — un peu comme
`canvas_contract.py` gère déjà `doc`/`choice`, mais pour un bloc isolé),
en plus du câblage front (survol, édition inline, popover de remarque).
Je ne l'ai pas construite sans confirmation, pour éviter de partir dans la
mauvaise direction sur une pièce aussi conséquente. Dites-moi si c'est ce
qu'il faut faire ensuite.
