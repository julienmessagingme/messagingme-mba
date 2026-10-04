# Une seule transition de consentement dans la fiche contact

Piste 1 restante du rapport d'architecture du 2026-10-02 (`todo.md`, section du 2026-10-03). Cadrage du
2026-10-03 en trois rondes de questions fermées, décisions de Julien.

## Le problème

« Qui peut lever un STOP, et alors que deviennent la date et la source, et quand prévient-on le système du client »
est réécrit dans six écritures de `src/crm/contact-store.pg.ts` (`upsertByPhoneReturningId`, `upsertManyByPhone`,
`setOptInByWaId`, `ecrireConsentementParId`, `applyEdits`, `applyEditsMany`), en CASE SQL et en `if` d'annonce, avec
des sémantiques qui divergent : deux de ces copies ont déjà réabonné un contact STOP (738a7c3d). Les tests actuels
reconnaissent le SQL par expressions régulières (`tests/contacts-consentement-store.test.ts` et voisins).

## Décisions (Julien, 2026-10-03)

- **Une seule règle, les écarts corrigés** (pas un déplacement à l'identique).
- **Qui lève un STOP** (`opted_out` vers `opted_in`) :
  - OUI : la fiche contact de la console (`applyEdits`), l'import CSV case cochée (`upsertManyByPhone` avec
    `peutLeverStop`, décision du 2026-09-26), la personne (formulaire coché, `markOptedIn` source `flow`), le bloc
    « Action » d'un scénario (`setOptInByWaId` source `scenario`, gardé tel quel) ;
  - NON : l'action en masse (`applyEditsMany`, **changement**), le webhook entrant et la création à la main
    (`upsertByPhoneReturningId`), l'import HubSpot et l'import sans case (`upsertManyByPhone`), l'API publique
    (`ecrireConsentementParId`, qui rend `refuse`).
- **Statut inchangé : rien n'est réécrit ni annoncé, partout** (**changement** pour `applyEdits` et
  `applyEditsMany`, qui remettaient la date à maintenant et renvoyaient le refus au client).
- **L'annonce au système du client** (`annoncer`) part après l'écriture, pour les seuls contacts qui sont réellement
  PASSÉS à `opted_out` par cette écriture.
- **Une fiche CRÉÉE directement `opted_out`** (insertion d'un upsert, création par l'API) porte `opt_out_at` ;
  aucune annonce (le refus vient du système du client, le lui renvoyer serait un écho). **Changement** si un chemin
  de création ne posait pas la date : à mesurer en lisant chaque chemin.
- **L'action en masse dit combien de fiches ont gardé leur STOP** : la route rend ce nombre à côté de `affected`,
  et l'écran l'affiche. L'écran tolère une réponse sans ce nombre (Vercel publie la console avant le `up` de l'API).
- **En production avant la démo**, essai réel d'ici le lundi 5 au soir, sinon le lot est retiré.

## Méthode de livraison

**Implémenteur + une relecture**, puis revue humaine du diff, parce que c'est le chemin du consentement : une
erreur fait écrire à quelqu'un qui a dit STOP, et les invariants (date qui suit le statut, annonce après le
`commit`, garde sous verrou contre deux STOP simultanés) ne se voient pas au compilateur. L'essai réel qui clôt le lot
est décrit en fin de plan.

## Tâche unique

**Interface.** Un module `src/crm/transition-consentement.ts` porte la règle, une fois :
- la table « qui peut lever un STOP » (une autorité nommée par appelant, typée, pas une chaîne libre) ;
- les fragments SQL de la transition (statut, `opt_out_at`, `opt_in_source`, et la garde « seulement si le statut
  change ») que les six écritures composent, quelle que soit la forme de leur requête (upsert `on conflict`,
  `update` par identifiant, par `wa_id`, en masse) ;
- de quoi savoir, après l'écriture, quels contacts sont réellement passés à `opted_out` (l'ancien statut lu dans la
  même instruction, sous verrou, comme `setOptInByWaId` le fait déjà).
Les six écritures de `PgContactStore` l'appellent ; aucune ne réécrit un `case` de consentement. `applyEditsMany`
rend aussi le nombre de fiches dont le STOP a été gardé ; la route `set_optin` le renvoie, l'écran de l'action en
masse (`web/app/contacts/page.tsx`, `web/lib/api/contacts.ts`) l'affiche quand il est là.

**Ce qui ne bouge pas** : `estDesabonne`, `src/crm/consentement.ts` (la reconnaissance du mot STOP), le RCS
(`rcs_optout_at`), le blocage (`blocked_at`), la purge, `upsertFromInbound` (n'écrit que `unknown`).

**Tests attendus.**
- Une table de cas jouée sur une VRAIE base (`tests/integration/`, CI seulement) : pour chaque écriture, chaque état
  de départ (`unknown`, `opted_in`, `opted_out`, fiche absente) et chaque demande, le statut, `opt_out_at` (posée,
  remise à `null`, inchangée), `opt_in_source` et les `wa_id` annoncés. Elle couvre les quatre changements de
  comportement ci-dessus, et la course de deux STOP simultanés (une seule annonce).
- Les tests par expressions régulières sur le SQL du consentement sont remplacés par cette table, SANS perdre
  aucun de leurs cas (corollaire (b) du CLAUDE.md) : la liste « ancien cas → cas de la table » va dans le rapport.
- `tests/optout-poussee.test.ts` (la liste dérivée des méthodes qui écrivent `opted_out`) reste vrai ou suit.
- Un test unitaire de l'écran de l'action en masse si l'existant en a un ; sinon l'e2e qui le couvre (chercher par
  `grep` dans `web/e2e`, et le lancer).
- Vérification dans les deux sens sur au moins : la masse qui ne lève plus un STOP, le statut inchangé qui ne
  réécrit plus la date, l'annonce limitée aux vrais passages à `opted_out`.

**Contrôles** : `npm run typecheck`, `npm test` (code de sortie lu sans pipe), `npx tsx scripts/auto-attaque.mts`
si une route change de forme, `tests/aide-proposer.test.ts` si `features.md` bouge. Jamais `test:integration` en
local : la table tourne en CI.

## Rayon de souffle

- Lecteurs de `applyEditsMany` (son type de retour change), de la route `set_optin` et de sa réponse.
- `features.md` (consentement, action en masse, fiche) et les fiches d'aide qui citent ces sections.
- Les signaux et la poussée d'opt-out (`src/signaux/emetteur.ts`, `annoncerDesabonnement`) : moins d'annonces en
  double, jamais une de moins pour un vrai passage.

## Déploiement

Aucune migration attendue. Relecture sans rouge, CI verte job par job, sessions voisines prévenues ; `up` de l'API et
des deux workers (le mot STOP passe par le worker, la fiche par l'API), contrôle public ; la console part au push et
tolère l'ancienne réponse.

## Essai réel qui clôt le lot (Julien, avant le lundi 5 au soir)

Sur sa propre fiche, dans la console : 1) se désabonner, enregistrer à nouveau, la date ne bouge pas ; 2) action en
masse « abonner » sur une sélection qui l'inclut, il reste désabonné et l'écran dit « 1 fiche a gardé son STOP » ;
3) se réabonner depuis la fiche, ça passe. Vérification en base des dates et des sources à chaque étape. Non
concluant lundi soir : le lot est retiré.
