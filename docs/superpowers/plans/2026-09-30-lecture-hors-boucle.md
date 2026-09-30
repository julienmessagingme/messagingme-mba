# Lire les fichiers déposés hors de la boucle d'événements : plan

**Origine :** `todo.md` § « Lecture des CSV et des documents : des formes de quelques centaines de Ko figent l'API »
(2026-09-30), décidé par Julien le jour même. Aucune borne ne couvre ces formes (guillemets mal placés puis une
traîne d'espaces, doublons d'en-tête) : chaque lot en a fermé une, chaque relecture en a trouvé d'autres. On borne
donc le TEMPS, pas la forme.

**Mesures du cadrage** (poste de dev chargé, Node 24) : un worker qui enregistre tsx (`register()` de
`tsx/esm/api`) puis importe un module TypeScript du dépôt démarre en 0,35 s ; sur le plus gros vrai fichier (762 600
numéros seuls), rendre les rangées coûte au fil principal 0,45 s en clone structuré, 0,18 s en JSON. `tsx` est une
dépendance de production, donc présent dans l'image.

**Contraintes :** pas de tiret long ; aucune migration ; aucun fichier de câblage partagé (le helper s'importe dans
les routes) ; `parseCsv`, `extraireDepuisCsv`, `reconnaitre` et `texteEnFiches` restent des fonctions pures et
synchrones, testées telles quelles ; un refus reste un 400 lisible par `statusCode`, comme aujourd'hui.

## Méthode de livraison

**En direct, puis UNE relecture indépendante du diff**, parce que le lot tient d'un seul tenant (un helper, quatre
points d'appel) et que son critère se vérifie par un test : la boucle d'événements répond pendant qu'un fichier
pathologique est lu. Il emprunte pourtant des chemins de production (import de contacts, FAQ, connaissance d'un
agent), d'où la relecture ; pas de feature-loop, parce que l'enjeu est le rayon de souffle et non la complétude.
Aucun workflow.

**Essai réel qui clôt la feature**, en production après le déploiement, par une sonde dans le conteneur : un
fichier « guillemets et espaces » de 330 Ko est refusé en 400 à l'échéance pendant que `/live` répond ; un vrai
fichier de 762 600 numéros se lit comme avant ; l'import de FAQ et un document CSV déposé dans la connaissance d'un
agent rendent les mêmes lignes et les mêmes fiches qu'avant.

## Tâche 1 : le helper `horsBoucle`

- `src/lib/hors-boucle.ts` : `horsBoucle<T>(module: URL, fonction: string, args: unknown[], options?)`. Un worker
  par appel (pas de pool tant que 0,35 s de démarrage ne gêne personne), `resourceLimits` pour la mémoire, échéance
  par `terminate()`. Le résultat revient en JSON. Une erreur levée dans le worker revient avec son `message` et son
  `statusCode` ; échéance dépassée ou mémoire épuisée : `LectureInterrompue` (`statusCode = 400`, message en
  français qui dit quoi faire), journalisée. ⚠️ Ce qui REVIENT du worker n'est pas borné par lui : chaque lecture ne
  rapporte au fil principal que ce dont sa route a besoin, sous une forme compacte (relecture du lot : des rangées
  rendues par nom pesaient 473 Mo de JSON pour un CSV forgé de 7,9 Mo).
- `src/lib/hors-boucle-worker.mjs` : enregistre tsx, importe le module, appelle la fonction (les octets reviennent
  en `Buffer`), poste le JSON.
- Défauts : échéance 10 s (le plus gros vrai fichier coûte 2,5 à 3 s), 30 s pour l'extraction d'un document (un vrai
  gros PDF, que la boucle supportait en la bloquant, ne doit pas devenir un refus) ; mémoire 1 024 Mo par worker (le
  plus gros vrai CSV en demande 440) ; au plus 4 lectures à la fois, au-delà un 429 « réessayez dans un instant ».
  Mesuré sur le VPS : 8 cœurs, 17 Go disponibles, 4 Go de tas pour `mba-api`. La route des pièces jointes de
  l'assistant n'a pas le plafond coûteux : sans cette limite, des workers en rafale prendraient tous les cœurs.
- Tests (`tests/lib-hors-boucle.test.ts`) : résultat rendu ; erreur à `statusCode` propagée ; échéance tenue sur une
  lecture qui dure, et le worker est bien tué (un appel suivant répond) ; la boucle du fil principal reste libre
  pendant une lecture d'une seconde ; au-delà de 4 lectures simultanées, la suivante est refusée en 429.

## Tâche 2 : l'import de contacts et son aperçu

- `src/http/import.ts` : l'import lit par `parseCsvHorsBoucle` (les rangées voyagent indexées par numéro de colonne,
  reconstruites par nom sur le fil principal), l'aperçu par `apercuCsvHorsBoucle` (l'en-tête, quatre rangées, le
  compte : rien d'autre ne revient).
- Test de route (`tests/http-import.test.ts`) : pendant l'import d'un fichier « guillemets et espaces » d'une
  seconde environ, la boucle n'est jamais bloquée plus d'une petite fraction de cette durée (un minuteur de 10 ms
  mesure son plus long retard). Lu dans le fil principal, le fichier la bloquerait pendant toute sa lecture : c'est
  la mutation qui doit faire tomber le test. Les tests existants du rendu restent verts.

## Tâche 3 : l'import de FAQ

- `src/http/mba.ts`, `extraire` : `extraireDepuisCsv` par `horsBoucle`, pour le corps comme pour l'URL, et
  `extraireDepuisHtml` aussi (une page de FAQ en HTML, quadratique sur des `<details>` non fermés).
- Tests de route (`tests/http-mba.test.ts`) : même propriété, en CSV et en HTML ; les tests existants restent verts.

## Tâche 4 : la connaissance d'un agent et les pièces jointes de l'assistant

- `src/http/agent-knowledge.ts` et `src/http/agent-setup.ts` : `lireDocumentHorsBoucle`, UN worker par document,
  qui enchaîne `reconnaitre`, `extraireTexte` et `texteEnFiches` et ne rend que la nature et les fiches, jamais le
  texte. La logique des routes (refus 413, 415, 422, chemin des images) ne bouge pas ; le texte qu'un modèle de
  vision lit dans une image passe par `texteEnFichesHorsBoucle`. Premier jet à trois workers par dépôt : il dépassait
  les 5 s des tests sous la suite complète.
- Tests de route : même propriété, sur la route de document de la connaissance et sur la pièce jointe de
  l'assistant.
- Hors lot, au `todo.md` : `pageEnFiches` (import d'une page ou d'un site), à passer par lot de pages.
- Hors lot, restent au `todo.md` : les causes des deux formes quadratiques des documents (`texteDocx`,
  `texteEnFiches`). Le worker les borne sans les corriger ; un vrai document qui les frôle serait refusé à
  l'échéance au lieu d'être lu.

## Ordre de déploiement

Aucune migration, aucun ordre imposé. CI lue job par job, `up -d --build`, fumée publique, puis l'essai réel
ci-dessus par la sonde du conteneur.
