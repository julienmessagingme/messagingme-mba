# RC6 : qui répond au client (MBA, agent IA, scénario ou équipe), et le bloc « Envoyer au MBA »

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code. Le plus structurel du chantier : chaque message entrant
> que personne ne tient passe par ce lot.

**But :** un seul réglage sur l'Accueil décide qui répond à un nouveau contact ou à un message que personne ne tient :
le MBA, un agent IA, un scénario, ou l'équipe. Un MBA allumé n'est plus forcément répondeur : en veille, il ne prend
un contact que par le bloc « Envoyer au MBA ».

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Les positions | Quatre : MBA, Agent IA, Scénario, Équipe. MBA et Agent IA grisés tant qu'ils ne sont pas configurés |
| Le MBA quand il n'est pas choisi | Allumé = DISPONIBLE. Il n'est répondeur que si on choisit « MBA » ; sinon il est en veille (aucune remise, aucune fin de parcours, aucun balayage ne lui confie rien) et ne prend un contact que par le bloc. Même règle en mode Agent IA : la contrainte « une voix » se relâche |
| Mode Scénario, au message suivant | Le scénario repart, au plus une fois par délai pour un même contact ; entre-temps, à l'équipe |
| Le délai | Réglable sous le choix « Scénario », 24 h par défaut |
| Le bloc « Envoyer au MBA » | Le MBA répond tout de suite au dernier message du client, le parcours s'arrête ; MBA éteint : la conversation va à l'équipe, avec une ligne de frise qui dit pourquoi, et l'éditeur avertit |
| Les deux réglages derrière le lien actuel (passage de main du MBA, garde d'un opérateur) | Ils restent où ils sont (`/mba/parametres?tab=activation`) |
| Les espaces sans répondeur aujourd'hui | Ils passent sur « Équipe » : leurs messages sans suite entrent dans « À traiter » (aujourd'hui ils ne vont nulle part) |
| Un ou deux réglages (nouveau contact, message quelconque) | Un seul ; l'automation « un nouveau contact écrit pour la 1re fois » garde la priorité pour qui veut un accueil distinct |

**Règles par défaut posées par ce plan (à relire par Julien à la revue) :** allumer le MBA quand le mode est « Équipe »
le fait passer en « MBA » (continuité avec aujourd'hui, où allumer le MBA le fait répondre) ; éteindre le MBA quand le
mode est « MBA » le fait passer en « Équipe », après confirmation ; quitter le mode « MBA » reprend à Meta tous les fils
qu'il tient (sinon il continuerait de parler aux contacts de sa liste).

## Faits qui cadrent le lot (lus sur `e5c338d7`)

- Aujourd'hui : `tenant_settings.mba_enabled` et `repondeur_agent_id`, exclusifs par
  `tenant_settings_repondeur_une_voix_chk` (0209) ; `unRepondeurRepond` (`src/inbox/fil.ts:210`) ;
  `remettreSiPersonneNeSuit` (`fil.ts:489`) choisit entre l'agent IA et `confier` à Meta ; la fin de parcours rend au
  MBA (`rendreApresParcours`, `fil.ts:473`, appelée par l'exécuteur l. 854, 1182, 1568, 1607) ; le balayage rend au MBA
  les fils inactifs (`src/inbox/control-sweep.ts:74,99`, `mbaActifParTenant`) ; `requalifierLesStandby`
  (`src/webhooks/standby-hors-liste.ts`) ; `setMbaEnabled` efface le répondeur IA (`src/settings/store.pg.ts:257-266`) ;
  `choisirRepondeur` éteint le MBA (`src/repondeur/reglage.ts:75-126`).
- Meta ne répond jamais de lui-même : l'agent est en `ALLOWLISTED_ONLY` et ne parle qu'aux contacts de `mba_liste`.
  C'est ce qui rend la veille sûre.
- 🔴 **Le type `mba_handoff` existe encore dans `parseGraph`** (bloc retiré le 2026-08-18, traversé en passe-plat,
  `src/workflow/graph.ts:11-24`). Des graphes anciens peuvent en contenir. Le bloc neuf prend un AUTRE type
  (`vers_mba`) : réveiller `mba_handoff` changerait en silence le comportement de scénarios publiés.

## Contraintes globales

- Isolation `tenant_id = $1`, routes au registre, `npx tsx scripts/auto-attaque.mts` avant de pousser.
- Fichiers de câblage partagés (`src/socle.ts`, `src/worker.ts`, `src/index.ts`, `src/server.ts`) : annoncés, commit en
  plomberie.
- Migration : la prochaine libre du dossier d'origin au moment d'écrire ; « Dernière appliquée » dans le commit qui
  applique.

## Livraison A : le serveur

### A1. La migration

- `tenant_settings.repondeur_mode text not null default 'equipe'`, CHECK `in ('mba', 'agent', 'scenario', 'equipe')`.
- `tenant_settings.repondeur_workflow_id uuid` nullable, clé étrangère vers `workflows(id)` en `on delete set null`.
- `tenant_settings.repondeur_delai_scenario_s integer not null default 86400`, CHECK entre 3 600 et 2 592 000 (1 h à
  30 jours).
- `contacts.repondeur_scenario_le timestamptz` nullable : le dernier départ du scénario répondeur pour ce contact (une
  colonne plutôt qu'une lecture de `workflow_runs`, que la rétention purge et qu'aucun index ne sert par contact et par
  scénario).
- CHECK à SENS UNIQUE, leçon de 0144 : `repondeur_agent_id is null or repondeur_mode = 'agent'` et
  `repondeur_workflow_id is null or repondeur_mode = 'scenario'`. L'inverse (mode `agent` sans agent, agent supprimé
  après coup) est un état ATTEIGNABLE, lu comme « Équipe » avec un avertissement à l'écran ; le refuser ferait échouer
  la suppression d'un agent ou d'un scénario.
- `tenant_settings_repondeur_une_voix_chk` SUPPRIMÉE (relâcher : l'ancien code y survit).
- Reprise : `agent` si `repondeur_agent_id` est posé, sinon `mba` si `mba_enabled`, sinon `equipe`. Compter avant et
  après, par mode.
- `conversation_evenements_type_check` reposé sous son nom avec le type `mba_indisponible` en plus (le bloc a trouvé le
  MBA éteint). Si RC2 est passé avant, partir de SES dix-sept types.
- **Elle passe AVANT le `up`** : le code neuf lit `repondeur_mode` à chaque entrant. Relue en base juste après (colonnes,
  défauts, les CHECK sous leur nom, la clé étrangère en `confdeltype = 'n'`, la répartition des modes égale au comptage
  d'avant).

### A2. Le réglage et son écrivain unique

**Fichiers :** `src/settings/store.pg.ts`, `src/repondeur/reglage.ts`, `src/mba/activation.ts`, `src/agent/gestion.ts`,
`src/http/agents.ts` (ou une route d'espace dédiée), `src/mcp/outils-agent.ts`, tests.

- `choisirRepondeur(deps, tenantId, choix, auteur)` avec `choix = { mode: 'mba' } | { mode: 'agent'; agentId } |
  { mode: 'scenario'; workflowId; delaiS? } | { mode: 'equipe' }` :
  - `mba` : allume le MBA s'il est éteint (chemin existant `appliquerActivation(true)`), refusé s'il n'est pas
    configurable (pas de numéro, non éligible) ;
  - `agent` : agent actif et Gateway configuré exigés (règles d'aujourd'hui) ; n'éteint PLUS le MBA ;
  - `scenario` : scénario PUBLIÉ de l'espace exigé, non système ;
  - quitter `mba` : reprend à Meta les fils qu'il tient (`liste.toutRetirer`, `reprendreLesFilsDeMeta`, existants) ;
  - une ligne d'historique des réglages (élément `repondeur`).
- `setMbaEnabled(t, true)` n'efface plus le répondeur IA ; allumer le MBA en mode `equipe` passe le mode à `mba` ;
  éteindre le MBA en mode `mba` passe le mode à `equipe` (règles par défaut ci-dessus).
- Désactiver l'agent répondeur ou dépublier le scénario répondeur ramène le mode à `equipe` (comme
  `oublierRepondeurSi` aujourd'hui).
- Route `PUT /tenants/:tenantId/repondeur` (admins), et `GET` qui rend `{ mode, agentId, workflowId, delaiS, mbaAllume,
  mbaConfigurable, agentsActifs, scenariosPublies }`, ce dont la carte a besoin en un appel.
- Outil MCP `set_default_responder` : accepte `{ mode, agent_id?, workflow_id?, delai_heures? }` ; l'ancienne forme
  `{ agent_id }` reste acceptée (uuid = `agent`, `null` = `mba` si le MBA est allumé, sinon `equipe`), ses refus et sa
  réponse documentés dans `describe`.

**Tests attendus :** chaque passage de mode, dans les deux sens, avec l'ordre des appels à Meta (faux magasins) ;
allumer le MBA en `agent` le laisse en veille (mode inchangé) ; le CHECK refuse `repondeur_workflow_id` en mode `agent`
(intégration) et la suppression d'un agent répondeur ne lève rien ; route refusée à un non-admin et à un autre espace ;
l'ancienne forme MCP donne le même résultat qu'avant.

### A3. Le chemin d'un entrant

**Fichiers :** `src/inbox/fil.ts`, `src/inbox/control-sweep.ts`, `src/webhooks/standby-hors-liste.ts`,
`src/workflow/lancements.ts`, nouveau `src/repondeur/scenario.ts`, `src/worker.ts` et `src/socle.ts` (câblage), tests.

- `unRepondeurRepond` disparaît au profit du MODE : chaque lecteur dit ce qu'il veut savoir (« le MBA est-il le
  répondeur ? », « un robot répond-il ? »). Un `grep` de ses appelants fait la liste, chacun est revu.
- `remettreSiPersonneNeSuit`, mêmes gardes et même ordre qu'aujourd'hui, puis selon le mode : `mba` → `confier`
  (inchangé) ; `agent` → démarreur IA (inchangé) ; `scenario` → si `contacts.repondeur_scenario_le` est plus vieux que le
  délai, démarre le scénario (type de lancement neuf `repondeur_scenario` : `reprise: 'sauf_operateur'`,
  `publieLesEtiquettes: true`, `graphe: 'publie'`, `fenetre: 'selon_preuve'`) et pose la date dans la même transaction
  que la réclamation ; sinon à l'équipe ; `equipe` → le fil passe à l'équipe (`app_human`, pot commun, il entre dans
  « À traiter »).
- Fin de parcours (`rendreApresParcours`) et balayage d'inactivité : vers le MBA SEULEMENT en mode `mba` ; dans les
  autres modes, le fil repasse `app_workflow` (le message suivant relance le répondeur du mode).
- `requalifierLesStandby` suit le mode, pas la présence d'un agent.
- Widget, publicité et étages de campagne dont la destination vaut « mba » (le répondeur automatique de l'espace)
  passent par la même remise : vérifier chacun, aucun ne doit appeler `confier` en direct.

**Tests attendus :** pour chaque mode, un entrant non pris fait ce que dit le tableau (sans répondeur IA ni MBA, rien ne
change pour les tests existants du mode `agent` et `mba`) ; en `scenario`, deux messages à une minute : un seul départ,
le second à l'équipe ; le lendemain : nouveau départ ; deux entrants simultanés : un seul départ (course) ; MBA allumé en
mode `agent` ou `scenario` : aucune fin de parcours, aucun balayage, aucune remise ne lui confie un contact (vérifié dans
les deux sens) ; en `equipe`, l'entrant apparaît dans « À traiter ».

### A4. Le bloc « Envoyer au MBA »

**Fichiers :** `src/workflow/graph.ts` (type `vers_mba`), `src/workflow/engine.ts`, `src/workflow/executor.ts`,
`src/workflow/wiring.ts`, tests.

- MBA allumé : `confier` (liste, `release`, fil `mba`) puis l'événement `message_sans_suite` avec le DERNIER message
  entrant du contact, pour que le MBA y réponde tout de suite ; le parcours se termine SANS second rendu.
- MBA éteint : le fil passe à l'équipe, événement de frise `mba_indisponible`, ligne au journal des échecs.
- Valable dans tous les modes.

**Tests attendus :** allumé : contact sur la liste, un seul `release`, un seul événement portant le bon texte ; éteint :
fil à l'équipe et frise ; un graphe ancien qui contient `mba_handoff` est toujours traversé en passe-plat.

## Livraison B : la console (poussée APRÈS le `up` de A)

- **Accueil** : une carte « Qui répond au client » (admins), quatre positions ; « Agent IA » ouvre le choix de l'agent ;
  « Scénario » ouvre le choix du scénario publié et le délai (en heures) ; une position non configurée est grisée avec
  le lien qui la configure ; un mode dont la cible a disparu est signalé (« L'agent choisi a été désactivé : vos
  messages vont à l'équipe »). La carte MBA garde son interrupteur (le MBA disponible) et le lien vers ses réglages,
  relibellé (il ne règle plus « qui répond »).
- `/agents` : le bloc « Répondeur de l'espace » (`web/components/RepondeurEspace.tsx`) laisse sa place à une phrase et
  un lien vers l'Accueil.
- Éditeur : bloc « Envoyer au MBA » dans la palette, avec l'avertissement quand le MBA est éteint.
- Confirmations : quitter « MBA » (« l'agent de Meta cessera de répondre aux conversations qu'il tient ») ; éteindre le
  MBA en mode « MBA ».
- ⚠️ `grep` dans `web/e2e` des libellés de la carte MBA et du répondeur avant de les changer.

## Documentation

`documentation.md` (le répondeur à quatre modes, la veille du MBA, la fin de « une voix », modifiés sur place),
`features.md` (Accueil, agent IA, scénarios, fiches d'aide relues avec leur empreinte, `tests/aide-proposer.test.ts`
vert avant le push), `CLAUDE.md` (dernière migration ; et toute ligne qui décrit « une voix » ou « allumé = répondeur »),
`brain/MESSAGINGME.md` si la fiche produit décrit le répondeur, journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante à la fin de chaque livraison, parce que le
lot change qui répond à tout message entrant non pris, sur un chemin que la production emprunte des centaines de fois
par jour, et qu'il défait un invariant posé hier (« une voix ») dont dépendent des lecteurs que le compilateur ne
signale pas : la fin de parcours, le balayage, la requalification des `standby`, les destinations « mba » du widget, des
publicités et des campagnes.

**Ordre de déploiement :** A : CI verte job par job, `compose build`, `pg_stat_activity` lu, migration appliquée puis
relue en base (dont la répartition des modes), `up` de l'API et des deux workers, rechargement NPM et contrôle public.
B : poussée seulement après que A tourne.

**L'essai réel qui clôt :** sur un espace de test avec MBA configuré et un agent IA actif, depuis un vrai téléphone,
les quatre modes l'un après l'autre : (1) « Scénario » : un message lance le scénario, un second dans l'heure arrive à
l'équipe, et le MBA allumé ne répond jamais ; (2) le bloc « Envoyer au MBA » au bout du scénario : le MBA répond tout de
suite au dernier message ; (3) « Agent IA » : l'agent répond, le MBA reste muet ; (4) « Équipe » : le message apparaît
dans « À traiter » ; (5) « MBA » : comportement d'aujourd'hui.
