# Les outils MCP jusqu'à l'agent de Meta, par le relais (route A)

Chantier noté dans `todo.md` (« MCP par la ROUTE A », 2026-09-24), lancé le 2026-10-02 avant une démo à un interlocuteur
de Meta. Route A arbitrée par Julien le 2026-09-24 : Meta parle HTTP à NOTRE relais, nous parlons MCP au serveur du
client, et on garde les gardes du relais (consentement outil par outil, journal des appels, adresse privée, opt-out).

## Méthode de livraison

**Implémenteur par lot (la session elle-même) puis UNE relecture indépendante du diff**, parce que le relais est un
chemin que la production emprunte (Meta l'appelle à chaque tour de l'agent qui utilise un outil) et qu'il porte une
garde d'identité. L'essai réel qui clôt le lot est décrit en fin de plan.

## La décision qui manquait, et pourquoi elle ne coûte rien

Julien a tranché le 2026-10-02 : pour commencer, les paramètres d'un outil MCP sont remplis par l'agent. MAIS la
console sait déjà régler, paramètre par paramètre, d'où vient la valeur d'un outil MCP (`McpOutilReglage.tsx` : modèle,
fiche du contact, champ personnalisé, valeur fixe), et c'est la garde d'identité des agents IA. Le relais la respecte
donc : seuls les paramètres `modele` partent chez Meta comme variables ; les autres sont posés par nous, depuis la fiche
du contact identifié par l'en-tête de Meta, exactement comme l'exécuteur d'un agent IA le fait.

## Tâches

1. **Un point de passage pour compléter les arguments** : l'étape 4 de `executerOutil` (`src/agent/executor.ts`, les
   valeurs `contact`, `champ`, `fixe` écrites APRÈS celles du modèle) devient une fonction pure partagée, appelée par
   l'exécuteur et par le relais. Deux copies dériveraient, et c'est une garde d'identité.
2. **Publication** (`src/mba/outils-a-publier.ts`) : une branche `mcp`, qui déclare à Meta les paramètres `modele` de
   l'outil (`paramsOutil(outil.params)`) en variables. Un outil MCP non activable ou disparu n'est pas publié.
3. **Relais** (`src/http/mba-relais.ts`) : une troisième branche vers le résolveur MCP (`creerResolveurMcp`), avec la
   validation du corps contre les variables `modele`, les arguments complétés (tâche 1), le journal sous l'appelant
   `mba`, et le délai de l'outil. Le résolveur garde ses propres gardes (source active, adresse publique).
4. **Onglet Outils de l'agent de Meta** : proposer à l'agent un outil MCP de la bibliothèque de l'espace (le consentement
   `mba`), avec un lien vers son réglage de paramètres. La phrase de `McpServeurs.tsx` qui dit que le verrou est chez
   nous change. Deux routes : `GET /tenants/:tenantId/mba-outils/mcp` (les outils MCP appelables, pas encore à CE numéro)
   et `POST /tenants/:tenantId/mba-outils/mcp/:outilId` (rattacher PUIS activer, au nom de l'administrateur). Un outil
   non appelable est refusé AVANT le rattachement, sinon il resterait une ligne éteinte qu'aucun geste ne rallume. La
   ligne d'un outil MCP dit son serveur, renvoie vers « Connecteurs MCP » pour ses réglages et n'a pas de « Modifier »
   (ses mots sont partagés avec les agents IA). L'écran tolère une API qui n'a pas encore la route : la console part
   sur Vercel au `git push`, avant le `up` de l'API.

## Tests attendus

La complétion des arguments (les trois origines, l'ordre d'écriture, l'exécuteur inchangé) ; la publication d'un outil
MCP (variables `modele` seulement, non activable écarté) ; le relais (corps validé, valeurs de la fiche posées par nous et
jamais par Meta, outil non proposé refusé, journal, échec du serveur MCP rendu en `succes: false`) ; l'onglet (la ligne
MCP, la parité de `publiable` avec la publication, les routes qui refusent un outil non MCP, déjà rattaché ou non
appelable, et l'écran qui se tait sur une API sans la route).

## Ordre de déploiement

Aucune migration. CI verte, `up -d --build mba-api mba-worker`, contrôle public. La console part sur Vercel au push et
tolère l'API d'avant : l'ordre n'a pas de fenêtre de panne.

## Essai réel qui clôt le lot

Sur l'espace MessagingMe : un serveur MCP connecté, un de ses outils proposé à l'agent de Meta, publié ; Julien pose à
l'agent une question qui exige cet outil, et lit la réponse ; le journal des appels montre l'appel sous `mba`.
