# Les messages interactifs de l'agent de Meta, et les Consignes

> Plan COURT : tâches, interfaces, tests attendus, ordre de déploiement, sans code. Écrit le 2026-10-07.
> **Pour l'exécutant :** lire la spec d'abord, elle porte les décisions et leurs raisons. Cases `- [ ]` à cocher.

**But :** l'agent de Meta envoie dans ses réponses les neuf composants WhatsApp de Meta (boutons, liste, lien,
formulaire, carrousels, image, lieu, demande de position), configurés depuis la console ou proposés par l'assistant ;
l'onglet « Compétences » devient « Consignes ».

**Architecture :** Meta fait foi (aucune table, aucune migration). Nos routes lisent et écrivent
`/{numéro}/agent-ui-skills` avec une ligne d'historique par écriture ; l'écho d'un message interactif de l'agent
devient un texte lisible dans l'Inbox ; l'assistant gagne trois opérations et annonce enfin ses bornes au modèle.

**Pile :** Fastify, Zod 4 (`safeParse`, `z.toJSONSchema`), Next.js, vitest, Playwright.

**Spec :** `docs/superpowers/specs/2026-10-07-messages-interactifs-design.md` (`abcd4acf`).

## Contraintes globales

- Aucun tiret cadratin ni demi-cadratin, dans le code, les textes d'écran et la doc.
- Toute réponse de Meta et toute sortie du modèle se lisent par `safeParse`, jamais `as`.
- Tout `flow_id` se vérifie contre `flows` de l'espace (`tenant_id = $1 and status = 'PUBLISHED'`), à la route comme
  à l'assistant.
- Les clés internes ne changent pas : onglet `competences`, élément `competence`, opérations `competence.*`,
  `data-testid` `mba-skill-*`, routes `/skills`. Seuls les libellés affichés deviennent « Consigne(s) » /
  « Instruction(s) ».
- Les neuf types, et leur nom à l'écran, sont ceux de la table du §3 de la spec, dans `src/mba/messages-interactifs.ts`
  (serveur) et `web/lib/messages-interactifs.ts` (console), jamais recopiés ailleurs.
- 🔴 Toucher `src/index.ts`, `src/server.ts` ou `src/worker.ts` (câblage partagé) s'annonce aux autres sessions avant,
  et se commite en plomberie sur `origin/main` (CLAUDE.md, « Règles spécifiques au projet »).
- Avant chaque push de code : `npm run typecheck`, `npm test`, `npm run auto-attaque` en local ; après, le run GitHub
  lu job par job (`gh run view <id> --json jobs`), jamais `gh run watch`.
- Toute retouche de `features.md` passe `tests/aide-proposer.test.ts` AVANT le push, fiche et empreinte dans le même
  commit.
- Chaque test de non-régression se vérifie dans les deux sens.

## Points de vigilance que la relecture doit chercher

1. Un `flow_id` venu d'un autre espace, ou d'un formulaire en brouillon, par la route ou par l'assistant : refusé avec
   un message lisible, jamais transmis à Meta (tests en T2 et T5).
2. Meta injoignable au moment de supprimer un formulaire : 503 lisible, rien n'est supprimé, ni chez Meta ni chez nous
   (test en T3).
3. Un écho de forme imprévue (type inconnu, champ manquant) : enregistré en `[message interactif]`, payload journalisé,
   et jamais une exception qui fait échouer le reste du lot de webhooks (test en T4).
4. Un client qui touche un bouton de l'agent dont le libellé égale le mot-clé d'une automation : aucune automation ne
   démarre, l'agent garde la conversation (test en T4).
5. Un espace dont l'agent de Meta n'est pas encore créé : l'onglet affiche le même état d'attente que « Consignes », et
   la suppression d'un formulaire n'appelle pas Meta (tests en T3 et T6).

---

## T0. Mesurer avant d'écrire (livraison 0)

**Fichiers :** un script jetable dans le scratchpad (jamais dans le dépôt), `tests/fixtures/echos-mba/*.json`,
`docs/MBA-API-REFERENCE.md`, `ops/mba-docs-watch.mjs`.

- [ ] Sur le numéro de test, avec un contact sur la liste, créer par appel direct un message interactif de chaque
  type, puis les déclencher dans une vraie conversation depuis le téléphone.
- [ ] Lire les échos dans `webhook_events` (rétention 30 jours) ; enregistrer un payload par type, anonymisé (numéros
  remplacés), dans `tests/fixtures/echos-mba/`.
- [ ] Mesurer : longueur maximale acceptée de `title` et d'`instruction` ; l'erreur d'un `flow_id` en brouillon créé
  `enabled` ; l'erreur d'un `flow_id` sur un autre type ; ce que rend `agent_test` quand un message interactif devrait
  partir ; la pagination de `GET /` (forme de `paging`).
- [ ] Supprimer les messages interactifs d'essai.
- [ ] Écrire dans `docs/MBA-API-REFERENCE.md` un relevé daté du 2026-10-07 : la doc de Meta relue à la source (le
  changelog depuis le 26 août, dont le plafond de 20 contacts de la liste, les causes d'échec d'`agent_event`, les
  connecteurs MCP), puis les mesures ci-dessus. Corriger la ligne 76 (la route sait écrire `handoff` depuis).
- [ ] Ajouter à la veille (`ops/mba-docs-watch.mjs`) les pages de l'index de Meta qu'elle ne connaît pas.

**Sortie :** les bornes `TITRE_MAX` et `CONSIGNE_MAX` (mesurées ; à défaut de refus jusqu'à 4 000, consigne 4 000 et
titre 200), les fixtures d'échos, les messages d'erreur de Meta à traduire.

## T1. Le client Meta et la validation

**Fichiers :** `src/mba/messages-interactifs.ts` (nouveau, pur), `src/mba/client.ts`,
`tests/mba-messages-interactifs.test.ts`, `tests/mba-client-messages-interactifs.test.ts`.

**Interfaces produites :**
- `TYPES_MESSAGE_INTERACTIF` : les neuf `component_type`, en tableau `as const` ; `TypeMessageInteractif`.
- `MessageInteractif` : `{ id: string; titre: string; type: TypeMessageInteractif; actif: boolean; consigne: string;
  formulaireId: string | null; creeLe: number; modifieLe: number }`.
- `validerCreation(entree: { titre; type; consigne; formulaireId?: string | null }) : { ok: true; valeur } | { ok: false;
  erreur: string }` et `validerModification(entree: { titre?; consigne?; actif? })`, mêmes formes.
- `TITRE_MAX`, `CONSIGNE_MAX` (valeurs de T0).
- `MbaClient` : `listMessagesInteractifs(pn): Promise<MessageInteractif[]>` (suit `after` jusqu'à l'absence de `next`,
  10 pages au plus), `creerMessageInteractif(pn, v)`, `modifierMessageInteractif(pn, id, v)`,
  `supprimerMessageInteractif(pn, id)`. Chemin `${pn}/agent-ui-skills`, en-tête `X-API-Version: 2.0.0`, sans
  `agent_id`. Traduction `actif` vers `status: 'enabled' | 'disabled'`.

**Tests attendus :** chemins, verbes, en-tête ; réponse lue par `safeParse` (une réponse illisible lève une erreur
nommée, jamais un objet à moitié rempli) ; pagination sur deux pages ; `flow_id` requis pour `flow`, refusé ailleurs ;
type hors des neuf refusé ; titre ou consigne vide ou trop long refusé ; la modification n'envoie jamais
`component_type` ni `flow_id`.

## T2. Les routes et l'historique

**Fichiers :** `src/http/mba.ts`, `src/reglages/historique.ts` (`ELEMENTS` gagne `message_interactif`), le câblage de
la dépendance neuve dans `src/index.ts` (annonce et plomberie), `tests/http-mba-messages-interactifs.test.ts`.

**Interfaces :**
- Consomme T1.
- Dépendance neuve des routes de l'agent de Meta : `formulairesPublies(tenantId): Promise<Array<{ id: string; nom:
  string }>>` (lecture de `flows`, filtrée sur l'espace ET `PUBLISHED`).
- Routes sous `{base}` = `/tenants/:tenantId/mba/:phoneNumberId`, même garde que `/skills` :
  `GET {base}/messages-interactifs` rend `{ messages: MessageInteractif[] }` ; `POST` (corps `{ titre, type, consigne,
  formulaireId? }`) rend 201 et le message ; `PUT {base}/messages-interactifs/:id` (corps `{ titre?, consigne?,
  actif? }`) ; `DELETE {base}/messages-interactifs/:id` rend 204.
- Chaque écriture écrit sa ligne d'historique (élément `message_interactif`, opération ajout, modification ou
  suppression, contenu supprimé conservé). Le libellé d'historique « Compétence » de la route `/skills` devient
  « Consigne ».

**Tests attendus :** écriture refusée sans le rôle admin ; ligne d'historique pour chacune des trois écritures, avec
le contenu supprimé ; `formulaireId` d'un formulaire d'un autre espace refusé (400, Meta jamais appelé) ; formulaire en
brouillon refusé ; erreur de Meta traduite en message lisible (les textes mesurés en T0) ; `tests/scope-tenant.test.ts`
reste vert sans y toucher (il dérive les routes).

## T3. Supprimer un formulaire utilisé

**Fichiers :** `src/http/flows.ts` (`FlowRouteDeps` gagne une dépendance), son câblage dans `src/index.ts` (annonce et
plomberie), `tests/http-flows-suppression.test.ts`.

**Interfaces :**
- `FlowRouteDeps.messagesInteractifsDuFormulaire(tenantId: string, flowId: string): Promise<string[]>` : les titres
  des messages interactifs du numéro de l'espace qui portent ce `flow_id` ; `[]` sans agent de Meta (aucun appel) ;
  lève si Meta ne répond pas.
- `DELETE /tenants/:tenantId/flows/:flowId` l'appelle AVANT toute dépréciation chez Meta : liste non vide, 409
  `{ error, messages: string[] }` ; levée, 503 « impossible de vérifier les messages interactifs, réessayez ».

**Tests attendus :** 409 qui nomme le message, et ni `deprecate` ni `delete` ni `remove` appelés ; 503 si la lecture
lève, rien supprimé ; espace sans agent, aucun appel et suppression comme aujourd'hui ; formulaire non utilisé,
suppression comme aujourd'hui.

## T4. L'écho dans l'Inbox

**Fichiers :** `src/webhooks/echo-interactif.ts` (nouveau, pur), `src/webhooks/handover.ts`,
`tests/webhooks-echo-interactif.test.ts`, `tests/webhooks-standby-automation.test.ts` (nouveau, ou cas ajouté à un
test existant de la réception).

**Interfaces :**
- `texteDeLEcho(message: Record<string, unknown>): string | null` : le texte de la table du §6 de la spec ; `null`
  seulement pour un écho sans rien d'affichable (alors journalisé, rien enregistré, comme aujourd'hui).
- `processHandovers` prend `text.body` d'abord, puis `texteDeLEcho(contenu)` ; un type non reconnu donne
  `[message interactif]` et journalise le payload complet (`journaliser('info', 'standby_echo_inconnu', ...)`).

**Rayon de souffle, à lire un par un et à consigner dans le commit :** les lecteurs de `conversation_messages.body`
pour `type = 'mba'` (aperçu de l'Inbox, historique lu par l'agent IA dans `src/agent/brain.gateway.ts`, analyse des
conversations, traduction, export). Le texte rendu est du texte, aucun ne doit le prendre pour un message du client.

**Tests attendus :** un cas par type sur les fixtures de T0 ; type inconnu ; écho texte inchangé (non-régression) ; un
écho illisible au milieu d'un lot n'empêche pas l'enregistrement des suivants ; un `button_reply` en `standby` dont le
libellé égale le mot-clé d'une automation active ne démarre ni automation ni scénario.

## T5. L'assistant de configuration

**Fichiers :** `src/mba/assistant/proposition.ts`, `inventaire.ts`, `conversation.ts`, `application.ts`,
`src/http/mba-assistant.ts` (`outilProposer`), `tests/mba-assistant-proposition.test.ts`,
`tests/mba-assistant-application.test.ts`, `tests/mba-assistant-bornes.test.ts` (nouveau).

**Interfaces :**
- Consomme T1 (`TYPES_MESSAGE_INTERACTIF`, `TITRE_MAX`, `CONSIGNE_MAX`, les méthodes du client) et la dépendance
  `formulairesPublies` de T2.
- Opérations : `message_interactif.ajouter { titre, type, consigne, formulaire? }` (`refine` : `formulaire` requis si
  et seulement si `type = 'flow'`), `message_interactif.modifier { cible, titre, consigne }`,
  `message_interactif.supprimer { cible, libelle }`.
- `ClientMbaLecture` gagne `listMessagesInteractifs` ; `InventaireMba` gagne `messagesInteractifs` et
  `formulairesPublies` ; le texte d'inventaire dit « Consignes (n) » et « Messages interactifs (n) ».
- L'application refuse un `formulaire` absent des formulaires publiés de l'espace, avec le message de T2 ;
  `elementDe` range les trois opérations sous `message_interactif` ; `libelleDe` les nomme, et dit
  « Consigne : … » au lieu de « Compétence : … » pour les trois opérations `competence.*`.
- 🔴 Le paramètre `operations` de l'outil `proposer` est dérivé de l'union des opérations par `z.toJSONSchema`, pour
  les onze opérations existantes comme pour les trois neuves.

**Tests attendus :** les trois opérations acceptées et refusées sur leurs bornes ; le `refine` dans les deux sens ;
formulaire d'un autre espace ou en brouillon refusé à l'application, Meta jamais appelé ; parité : chaque borne de Zod
(min, max, énumération) se retrouve dans le schéma annoncé ; un entretien enregistré avant ce lot (fixture avec des
opérations `competence.*`) se relit à l'identique.

## T6. La console (livraison B)

**Fichiers :** `web/lib/messages-interactifs.ts` (nouveau, pur : noms des types, canevas), `web/lib/api-mba.ts`,
`web/components/MbaMessagesInteractifsPanel.tsx` (nouveau, sur le modèle de `MbaSkillsPanel.tsx`),
`web/app/mba/parametres/page.tsx`, `web/lib/libelles-mba.ts`, `web/components/MbaSkillsPanel.tsx`,
`web/components/MbaOverviewPanel.tsx`, le panneau du banc « Tester », le diff de `MbaAssistantPanel`,
`web/e2e/mba-messages-interactifs.spec.ts` (nouveau), `web/e2e/mba-skills.spec.ts`,
`web/e2e/mba-parametres-overview.spec.ts`, `web/e2e/support/mba.ts`, `tests/web-messages-interactifs.test.ts`.

**Interfaces :**
- `NOMS_TYPES: Record<TypeMessageInteractif, { fr: string; en: string }>`, `canevas(type): string` (les neuf textes du
  §8 de la spec).
- `listMbaMessagesInteractifs`, `createMbaMessageInteractif`, `updateMbaMessageInteractif`,
  `deleteMbaMessageInteractif` dans `web/lib/api-mba.ts` ; les formulaires publiés par `listFlows` filtré sur
  `PUBLISHED`.
- Onglet `messages_interactifs`, libellé « Messages interactifs » / « Interactive messages », juste après
  « Consignes ».

**Ce que fait l'écran :** la ligne d'introduction (l'agent garde la conversation ; « Envoyer un bloc » et « Lancer un
scénario » la passent à un scénario) ; la liste (nom du type, titre, interrupteur, modifier, supprimer) ; l'éditeur
(type choisi à la création puis en lecture seule avec la phrase « Pour changer de type ou de formulaire, supprimez ce
message et recréez-le », sélecteur des formulaires publiés ou lien vers `/flows`, canevas pré-rempli tant que le champ
est vide) ; l'état d'attente identique à « Consignes » tant que l'agent n'existe pas ; sur « Tester », la phrase « Les
messages interactifs ne s'affichent pas ici : essayez-les sur WhatsApp avec un numéro de la liste » (ajustée à la
mesure de T0) ; le diff de l'assistant montre type, formulaire et consigne en entier. Renommage : chaque libellé
« Compétence(s) » / « Skill(s) » des fichiers ci-dessus.

**Tests attendus :** un canevas par type (pur) ; e2e : créer, basculer, modifier, supprimer un message, type en lecture
seule à la modification, formulaire proposé seulement s'il est publié ; e2e existants mis à jour sur les nouveaux
libellés (chercher d'abord dans `web/e2e` tout ce qui trouve ces éléments par texte ou par rôle) et lancés en local,
serveur démarré soi-même (CLAUDE.md, défauts de l'e2e).

## T7. La documentation

- [ ] Livraison A : `documentation.md` (les routes, la lecture des échos, la garde de suppression d'un formulaire,
  l'opération de l'assistant et son schéma dérivé).
- [ ] Livraison B : `features.md` (« Compétences » devient « Consignes » aux quatre endroits, et une section « Messages
  interactifs ») ; la fiche `docs/aide/fiches/le-repondeur-de-meta.md` et son empreinte, dans le même commit, vérifiées
  par `tests/aide-proposer.test.ts` avant le push.
- [ ] À chaque livraison : `docs/JOURNAL-TECHNIQUE.md`, `wip.md`, `todo.md`.

## Méthode de livraison

**Implémenteur par lot et revue humaine du diff**, parce que T4 se trouve sur le webhook de chaque conversation de
l'agent de Meta (un chemin que la production emprunte, où une exception ferait perdre des échos ou bloquer un lot) et
que T2, T5 et T6 écrivent la configuration d'un agent en service chez de vrais clients. feature-loop ne convient pas :
une bonne part des critères demande un œil sur un vrai téléphone. Une relecture indépendante en fin de livraison, pas
par tâche ; ses correctifs de rouge ne se font pas relire.

| Livraison | Tâches | Déploiement |
| --- | --- | --- |
| 0 | T0 | aucun (mesures et doc) |
| A, serveur | T1 à T5, T7 partie A | API et les deux workers (`up -d --build`), aucune migration ; contrôle public des deux portes après le `up` (502 NPM possible, `nginx -s reload`) |
| B, console | T6, T7 partie B | push APRÈS le déploiement de A : Vercel publie la console au push, et l'écran appelle des routes que seule A porte |

**L'essai réel qui clôt la feature**, sur le numéro de test, contact sur la liste, depuis la console de production :
(1) créer quatre messages interactifs, boutons de réponse, liste, bouton lien, formulaire publié ; (2) les déclencher
depuis le téléphone : chacun arrive et s'affiche dans l'Inbox avec ses boutons, ses lignes ou son lien ; (3) toucher
un bouton, une ligne, remplir le formulaire : l'agent poursuit en tenant compte du choix, la réponse du formulaire est
sur la fiche ; (4) faire proposer un message interactif par l'assistant, l'appliquer, voir sa ligne dans l'Historique ;
(5) tenter de supprimer le formulaire utilisé : refus qui nomme le message. Tant que ces cinq points n'ont pas été vus,
le lot n'est pas fini.
