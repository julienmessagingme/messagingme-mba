# Les envois d'un bloc de scénario sortent du câblage

Piste 2 du rapport d'architecture du 2026-10-02 (`todo.md`, section du 2026-10-03), candidat 1 du rapport du
2026-09-14. Cadrage du 2026-10-03 en deux rondes de questions fermées, décisions de Julien.

## Le problème

Les quatre envois WhatsApp d'un bloc de scénario (`sendTemplate`, `sendQuickMessage`, `sendQuestion`, `sendFlow`)
sont écrits dans le littéral de `buildWorkflowRuntime` (`src/workflow/wiring.ts`), avec `visuelsPourEnvoi` et le
calcul des suffixes de boutons tracés. Aucun test ne les exécute : les 17 fichiers qui montent l'exécuteur lui
donnent des faux, et ce qui garde ce code aujourd'hui relit son TEXTE (`workflow-cablage-categorie`,
`workflow-lien-bouton`). Les deux branches de `sendTemplate` ont divergé trois fois (carrousel, en-tête média,
catégorie). ⚠️ Le chiffre « 20 commits dont 8 correctifs » du rapport porte sur tout le fichier, pas sur ces
quatre fonctions.

## Décisions (Julien, 2026-10-03)

- **Périmètre : les quatre envois seulement.** `envoyerTexteAgent`, `sendEmail`, l'Inbox, le MCP, les campagnes
  directes et l'API publique ne bougent pas. Le point d'envoi unique reste un candidat à part.
- **Comportement à l'identique** : mêmes appels à Meta, mêmes refus (mot pour mot), même journal, mêmes
  `console.error`. Un défaut trouvé en route va au todo, il ne se corrige pas dans ce lot.
- **Le cache des modèles reste dans le câblage** (`templateVarInfo`, `prepareCarouselMedia`,
  `prepareHeaderMedia`, construits une fois et partagés avec les campagnes et l'API) : le module les reçoit.
- **Les gardes par lecture de texte sur ces envois deviennent des tests qui exécutent le module.**
- **En production dès que relu**, essai réel d'ici le lundi 5 au soir, sinon le lot est retiré (revert puis
  `up`), pour une démo du 7 sur du code éprouvé.

## Méthode de livraison

**Implémenteur + une relecture**, puis revue humaine du diff : c'est le chemin de CHAQUE message qu'un scénario
envoie, et il porte des invariants invisibles au compilateur (les deux branches journalisent la même chose, un
bouton garde son index d'origine, un lien inutilisable refuse au lieu d'envoyer un message nu). L'essai réel qui
clôt le lot est décrit en fin de plan.

## Tâche unique : le module `src/workflow/envois-bloc.ts`

**Interface.**
- `creerEnvoisDeBloc(deps: DepsEnvoisDeBloc): EnvoisDeBloc`, où `EnvoisDeBloc` est
  `Pick<WorkflowExecutorDeps, 'sendTemplate' | 'sendQuickMessage' | 'sendQuestion' | 'sendFlow'>`.
- `DepsEnvoisDeBloc`, tout REQUIS (aucun membre optionnel) : `dryRun` ; `client(tenant, qui, quoiNonEnvoye)`
  (le `clientWhatsApp` du câblage, qui reste là parce qu'`envoyerTexteAgent` s'en sert aussi) ;
  `templateVarInfo`, `prepareCarouselMedia`, `prepareHeaderMedia` ; les liens tracés (`listByTemplates`,
  `jetonPourE164`) ; les indications de variables (`get`) ; la fiche (`getResolvableByPhone`) ; `varsDuContact` ;
  le journal (ce que `logTemplateSent` et `recordOutboundByWaId` demandent). Des types ÉTROITS (`Pick` des
  stores), pour que les tests montent des faux sans `as unknown as`.
- Le type `TplInfo` sort du câblage, exporté par le module ; le cache qui le produit reste dans le câblage.
- `visuelsPourEnvoi` et le calcul des suffixes entrent dans le module (privés), s'ils n'ont pas d'autre lecteur.

**Câblage.** `buildWorkflowRuntime` construit le module une fois et le passe à l'exécuteur ; ce qu'il RETOURNE
ne change pas (`src/index.ts` et `src/worker.ts` lisent `templateVarInfo`, `prepareCarouselMedia`,
`prepareHeaderMedia`, `envoyerTexteAgent`). Le spread du module dans les dépendances de l'exécuteur porte un
`satisfies` sur l'objet intérieur (le contrôle des propriétés en trop ne traverse pas un spread, CLAUDE.md).

**Tests attendus** (nouveau `tests/workflow-envois-bloc.test.ts`, vrai module, faux client Meta, faux dépôts) :
- les quatre : DRY_RUN n'appelle rien ; aucun numéro rend le refus du client sans appel ; le journal porte
  `origine: 'scenario'` ; un journal qui lève ne fait pas échouer un envoi parti ; le `messageId` remonte ;
- `sendTemplate`, branche « variables déjà résolues » : composants construits, catégorie de SA lecture, lecture en
  échec part sans visuel, refus de visuel et variable manquante rendent leur message ;
- `sendTemplate`, branche « indications » : modèle introuvable refuse, fiche et indications lues seulement si le
  modèle a des variables, variable manquante refuse, catégorie de SA lecture ;
- suffixes : bouton tracé avec jeton suffixé, lecture des liens en échec part sans suffixe ;
- `sendQuickMessage` : texte vide refuse ; lien inutilisable refuse sans appel ; les quatre formes (lien en
  `sendCtaUrl`, boutons en `sendInteractive` avec la liste ENTIÈRE, image légendée, texte) ; visuel non préparé
  refuse ;
- `sendQuestion` : variables rendues dans le corps et les lignes, fiche lue seulement s'il y en a ; liste ou
  texte ; le journal porte le corps rendu ;
- `sendFlow` : formulaire vide refuse ; jeton de flow non vide.

**Tests remplacés ou repointés.**
- `tests/workflow-cablage-categorie.test.ts` et les trois cas textuels de `tests/workflow-lien-bouton.test.ts`
  (`describe('câblage du bouton de lien (scénario)')`) : remplacés par leurs équivalents exécutants, AUCUN cas
  perdu (corollaire (b) du CLAUDE.md : réécrire un test conserve le cas qu'il exerçait).
- `tests/optout-chemins.test.ts` : l'inventaire des fichiers qui appellent Meta reste un relevé de fichiers ;
  le nouveau module y entre avec son verdict, mesuré en suivant l'appel (la garde est dans
  `WorkflowExecutor.apply`), pas déduit du voisinage.
- `tests/origine-message.test.ts` ne bouge pas : il lit `envoyerTexteAgent`, qui reste dans le câblage.

**Vérifications dans les deux sens** (le test tombe avec le défaut remis, puis passe) sur trois cas au moins : la
catégorie d'une branche retirée, le `lien` ignoré, la liste de boutons filtrée avant l'envoi.

**Contrôles avant de rendre** : `npm run typecheck`, `npm test`, `npm run lint` s'il existe, et
`npx tsx scripts/auto-attaque.mts` n'est pas concerné (aucune route touchée). Jamais `test:integration` en local.

## Rayon de souffle

- Lecteurs de ce que retourne `buildWorkflowRuntime` : `src/index.ts`, `src/worker.ts`. Le retour ne change pas.
- `TplInfo` : local au câblage aujourd'hui ; vérifier qu'aucun autre fichier ne le redéfinit.
- Les deux processus exécutent ce câblage (API et worker) : le déploiement reconstruit les deux.

## Déploiement

Aucune migration. Après relecture sans rouge et CI verte (jobs lus un par un) : prévenir les sessions qui
déploient aussi (RSSI, serveur MCP), `git merge --ff-only` sur le VPS, `up -d --build` de l'API et de TOUS les
services worker du compose (le double worker est en production depuis le 2026-10-03 : relire leurs noms dans
`docker-compose.yml`), attente de `healthy`, rechargement de NPM, contrôle public des deux portes.

## Essai réel qui clôt le lot (Julien, avant le lundi 5 au soir)

Un scénario d'essai : un modèle avec une variable, un message rapide avec image et boutons, une question en liste,
puis un formulaire. Julien le lance sur son téléphone et répond à chaque étape ; je vérifie en base les quatre
lignes du fil (`origine = 'scenario'`, catégorie du modèle) et les événements de blocs. Non concluant lundi soir :
le lot est retiré.
