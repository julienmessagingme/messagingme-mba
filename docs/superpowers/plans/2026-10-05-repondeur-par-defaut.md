# Le répondeur par défaut (lot 5) : plan d'implémentation

> Plan COURT, règle du dépôt : tâches, interfaces, tests attendus, ordre de déploiement, sans code. L'implémenteur lit
> la spec avec lui.

**But :** un agent IA désigné par l'espace répond à tout message entrant que ni un scénario, ni un mot-clé, ni un humain
ne tient, comme l'agent de Meta, sans scénario construit par le client.

**Architecture :** un réglage d'espace (`repondeur_agent_id`) exclusif de l'agent de Meta par un CHECK ; un scénario
système caché par espace, dont le graphe (un bloc Agent IA) est construit au démarrage et figé dans le parcours ; un
nouveau type de lancement `repondeur` ; un démarreur que `remettreSiPersonneNeSuit` appelle à la place de « confier à
Meta ». Tout le reste (sessions, tours, crédit, escalade, inactivité, opérateur) est le moteur existant.

**Spec :** `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md` (validée par Julien le 2026-10-04).

## Contraintes globales

- Aucun tiret cadratin ni demi-cadratin, commentaires en français, densité de commentaires comme le code voisin.
- Isolation : `tenant_id = $1` sur chaque requête neuve ; toute route neuve d'espace entre au registre (`acces:
  'tenant'`), et `npx tsx scripts/auto-attaque.mts` passe en local avant de pousser.
- Toute entrée non fiable en `safeParse` ; le dernier message d'un modèle passe par `ressembleAUnBlocOutil`.
- Commit en plomberie depuis une extraction d'origin, jamais depuis l'arbre partagé ; annoncer avant d'éditer
  `src/socle.ts`, `src/worker.ts`, `src/index.ts`, `src/server.ts`.
- Migration : **0208** (0207 est prise, relire `db/migrations` d'origin au moment d'écrire).

## Amendement de la spec, mesuré le 2026-10-05

La spec (§ 6) gardait aux agents de SCÉNARIO une lecture « depuis le message déclencheur », pour ne pas changer leur
comportement. **Mesuré en base : zéro session d'agent n'a jamais existé, zéro scénario ne porte de bloc Agent IA.** La
précaution ne protège personne : TOUS les agents lisent la même chose, les 30 derniers messages du contact sur 30 jours.
Un seul chemin de lecture au lieu de deux.

## Ce que le code fait déjà, et qu'on ne touche pas

Le CHECK garantit que `mba_enabled` est faux dès qu'un répondeur IA est désigné. Or, agent de Meta éteint :
`rendreLaMain` écrit déjà `app_workflow` ; `rendreLaMainAMba` de l'exécuteur ne fait rien (fin de parcours : le fil reste
`app_workflow`) ; le balayage ne rend rien à Meta. C'est exactement le comportement voulu (« le prochain message relance
l'agent »). **Le seul branchement neuf dans `fil.ts` est `remettreSiPersonneNeSuit`.** Les autres gestes se vérifient
par des tests, pas par du code.

## Revue : les cinq cas les plus probables que rien d'autre ne teste

1. **Deux messages du contact coup sur coup** (même lot de webhook, ou deux jobs proches) : un seul parcours répondeur et
   un seul tour. Test dans la tâche A5.
2. **Bascule de l'agent de Meta vers un agent IA en pleine conversation** : les contacts sur la liste de Meta en sont
   retirés, aucun message n'obtient deux réponses, un `standby` arrivé après la bascule n'est pas perdu. Test A2.
3. **L'agent répondeur désactivé ou supprimé** : le réglage retombe à nul, personne ne répond, aucun 500, la console
   l'annonce. Test A2 (et B1 pour l'écran).
4. **Un opérateur écrit pendant un tour, puis rend la main** : le tour se termine en `main_perdue` sans écrire, et le
   message suivant du contact relance l'agent. Test A5.
5. **Crédit épuisé, avec plusieurs copies de l'API et des workers** : aucune session ni parcours par message, une seule
   alerte par jour et par espace. Test A8.

---

## Livraison A : le serveur

### A1. La migration 0208

**Fichier :** `db/migrations/0208_repondeur.sql` (+ un test qui lit le SQL, comme les migrations voisines).

- `tenant_settings.repondeur_agent_id uuid` nullable, clé étrangère vers `agents(id)` en `on delete set null`.
- `tenant_settings_repondeur_une_voix_chk` : `repondeur_agent_id is null or mba_enabled = false`.
- `workflows.systeme text` nullable, `workflows_systeme_chk` : `systeme in ('repondeur')`, index unique partiel
  `workflows_systeme_uidx (tenant_id) where systeme = 'repondeur'`.
- `conversation_evenements_type_check` reposé sous son nom avec les QUATORZE types de 0194 plus `sortie_agent`
  (`lock_timeout` de 5 s, comme 0194).
- Table `repondeur_alertes_credit (tenant_id uuid references tenants on delete cascade, jour date, primary key
  (tenant_id, jour))`.
- **Elle passe AVANT le `up` de l'API et des workers** : le magasin des scénarios filtre sur `systeme`, donc l'ancien
  schéma ferait tomber chaque liste de scénarios en `42703`. Elle n'enlève rien : l'ancien code y survit.
- Relue en base juste après : les colonnes, leurs types et défauts, les trois CHECK sous leur nom, l'index partiel
  avec son prédicat, la clé étrangère en `confdeltype = 'n'`, la table vide, et ZÉRO espace en violation (aucun n'a de
  répondeur).

### A2. Le réglage, son écrivain unique, la bascule

**Fichiers :** `src/settings/store.pg.ts`, nouveau `src/repondeur/reglage.ts`, `src/agent/gestion.ts`
(`changerStatut`), `src/http/agents.ts` (route), `src/mcp/outils-agent.ts`, `src/server.ts` (registre si nouveau
module), tests.

**Interfaces :**
- `TenantSettings.repondeurAgentId: string | null` (lu par `get`, déjà en `select *`).
- `PgSettingsStore.setMbaEnabled(t, true)` remet `repondeur_agent_id` à nul DANS LA MÊME instruction.
- `PgSettingsStore.setRepondeur(tenantId, agentId: string | null): Promise<void>`.
- `choisirRepondeur(deps, tenantId, agentId: string | null, auteur: AuteurModification): Promise<Issue<{ repondeurAgentId: string | null }>>` :
  refuse un agent absent ou non actif (422 lisible), refuse si le Gateway n'est pas configuré ; si l'agent de Meta est
  allumé, l'éteint par le chemin existant (`appliquerActivation(false)`), puis retire de la liste de Meta CHAQUE contact
  de `mba_liste` (`liste.retirer`, par paquets, un échec journalisé n'arrête pas les autres), puis `setRepondeur` ;
  journalise une ligne d'historique des réglages (élément `repondeur`, origine `formulaire` ou `mcp`).
- `changerStatut(..., 'disabled')` remet le répondeur à nul s'il désignait cet agent.
- Route `PUT /tenants/:tenantId/agents/repondeur` `{ agentId: string | null }`, admins seulement ; la liste
  `GET /tenants/:tenantId/agents` rend `repondeurAgentId`.
- Outil MCP `set_default_responder({ agent_id: string | null })`, `exigePersonne`, plafond coûteux NON (geste rapide) ;
  `list_agents` rend `repondeur: true` sur l'agent désigné.

**Tests attendus :** le CHECK refuse les deux ordres (intégration) ; allumer l'agent de Meta efface le répondeur sans
erreur ; un agent brouillon ou désactivé est refusé ; Gateway absent refusé ; la bascule retire tous les contacts de la
liste et éteint l'agent de Meta (faux magasins, ordre des appels vérifié) ; désactiver ou supprimer l'agent remet à nul ;
la route refuse un non-admin et un autre espace ; l'outil MCP est invisible pour une clé d'API.

### A3. Le scénario système, invisible partout

**Fichiers :** `src/workflow/store.pg.ts` (+ son interface), les deux endroits qui écrivent le nom d'un scénario dans une
cause de frise ou un journal (`src/workflow/wiring.ts`, `src/ops/erreurs-livraison.pg.ts`), tests.

**Interfaces :**
- `assurerScenarioSysteme(tenantId: string, systeme: 'repondeur'): Promise<string>` : crée la ligne (nom
  « Répondeur automatique », graphe vide) ou rend celle qui existe, sans course (`on conflict` sur l'index unique).
- `listResume`, `list`, `listPublies`, `getById`, et TOUTE autre lecture publique du magasin (code, jeton de test)
  excluent `systeme is not null`. L'exécuteur ne lit pas la ligne : le parcours porte son graphe figé.
- Partout où le nom du scénario sort (frise, journal des échecs), une ligne système se nomme « Répondeur automatique ».

**Tests attendus :** chaque lecture publique ignore la ligne système (une par méthode) ; deux `assurerScenarioSysteme`
simultanés rendent le même identifiant (intégration) ; la détection de doublon de nom n'est pas gênée par elle ; la
résolution `/v1` par nom ne la trouve pas.

### A4. Le type de lancement `repondeur` et le graphe figé fourni

**Fichiers :** `src/workflow/lancements.ts`, `src/workflow/executor.ts` (la condition de figeage), nouveau
`src/repondeur/graphe.ts`, `tests/workflow-lancements.test.ts`, tests.

**Interfaces :**
- `PolitiqueDeLancement.graphe` gagne `'fourni_fige'` ; l'exécuteur fige le graphe pour `brouillon_fige` ET
  `fourni_fige` (une seule fonction qui le dit, pas deux comparaisons).
- Ligne de la table : `repondeur: { reprise: 'sauf_operateur', publieLesEtiquettes: true, graphe: 'fourni_fige',
  fenetre: 'selon_preuve' }`.
- `DemandeRepondeur { type: 'repondeur'; tenantId; workflowId; waId; graphe: WorkflowGraph; fenetreOuverte: true }`.
- `grapheDuRepondeur(agent: { id: string; sorties: SortieAgent[] }): WorkflowGraph` : une entrée, un bloc Agent IA ;
  chaque règle d'arrêt, `humain` et `timeout` mènent à une fin ; `echec` et `plafond` restent NON branchées (le moteur
  les rend déjà à l'équipe, `boutonSansSuite`).
- La sortie d'un bloc agent écrit l'événement de frise `sortie_agent` portant le code, pour TOUT agent (dans
  `sortirDuBlocAgent`, par une méthode neuve du dépôt de l'Inbox, scopée espace).

**Tests attendus :** la table s'exécute ligne par ligne sur le vrai exécuteur, `repondeur` compris ; un parcours
répondeur résiste à une reprise (graphe figé relu, pas la ligne) ; une sortie écrit son événement avec le code ;
**l'escalade depuis le répondeur** laisse le fil à l'équipe, escalade marquée, et la dernière phrase part (le piège
« sortie `humain` non branchée » de l'exploration).

### A5. Le démarreur et le branchement dans `fil.ts`

**Fichiers :** nouveau `src/repondeur/demarrer.ts`, `src/inbox/fil.ts`, `src/socle.ts` (câblage, annoncé), tests
(`tests/fil.test.ts`, `tests/remise-mba-entrant.test.ts`, neuf `tests/repondeur-demarrer.test.ts`).

**Interfaces :**
- `creerDemarreurRepondeur(deps): { demarrer(tenantId: string, waId: string): Promise<IssueRepondeur> }` avec
  `IssueRepondeur = 'parti' | 'credit_epuise' | 'indisponible' | 'refuse'`. Il lit le réglage, l'agent (actif, ses
  règles d'arrêt), le solde ; solde nul ou négatif : `credit_epuise` SANS rien démarrer ; Gateway absent ou agent
  inactif : `indisponible` ; sinon `assurerScenarioSysteme`, `grapheDuRepondeur`, `lancements.lancer({ type:
  'repondeur', ... })`, et un refus de `runFrom` devient `refuse`.
- `DepsControleDuFil.repondeur: { demarrer(...) }`, REQUIS. Le fil est construit avant l'exécuteur
  (`src/socle.ts`) : le câblage passe par une liaison tardive qui LÈVE si on l'appelle avant d'être branchée, et un test
  vérifie que le socle la branche.
- `remettreSiPersonneNeSuit` : avec un répondeur IA, mêmes gardes et même ordre qu'avec l'agent de Meta (délai de
  reprise de l'équipe, parcours en attente, contact désabonné ou bloqué, fil de test, aucun numéro), puis `demarrer`.
  `credit_epuise` : le fil passe à l'équipe avec une demande, cause « crédit IA épuisé », et l'alerte (A8) ;
  `indisponible` ou `refuse` : à l'équipe aussi (le client n'attend pas un robot qui ne viendra pas).

**Tests attendus :** sans répondeur, rien ne change (les tests existants passent tels quels) ; avec un répondeur, un
entrant non pris démarre UNE fois ; deux entrants coup sur coup n'en démarrent qu'un (cas 1 de la revue) ; un entrant
redélivré par Meta (même identifiant) ne démarre rien ; un entrant RCS ne démarre rien ; un parcours
en attente, un fil d'opérateur dans son délai, un contact désabonné ne démarrent rien ; crédit épuisé : aucun
`lancer`, fil à l'équipe ; avec un répondeur et l'agent de Meta éteint, `rendreLaMain` écrit `app_workflow`, la fin de
parcours laisse `app_workflow`, le balayage ne rend rien à Meta ; un opérateur qui écrit pendant un tour fait finir le
tour en `main_perdue`, et le message suivant relance l'agent (cas 4).

### A6. Ce que lit chaque tour

**Fichiers :** `src/agent/run-turn.ts`, `src/worker.ts` (`lireConversation`, annoncé), le magasin qui sert la lecture,
`tests/agent-run-turn.test.ts`, `tests/integration/agent-conversation.integration.test.ts`.

- La borne n'est plus l'ouverture de la session : ce sont les **30 derniers messages du contact sur 30 jours**, dans
  l'ordre chronologique (les 30 PLUS RÉCENTS, pas les 30 premiers après la borne).
- 🔴 Le test d'intégration qui posait le premier message À l'instant d'ouverture masquait le défaut : le message
  déclencheur est posé AVANT l'ouverture, et le premier tour doit le voir.

**Tests attendus :** le message déclencheur est dans le transcript du premier tour (vérifié dans les deux sens : avec
l'ancienne borne, il manque) ; un message de 31 jours est exclu ; 40 messages récents donnent les 30 derniers, en ordre.

### A7. La mention d'IA sur le dernier message

**Fichier :** `src/agent/brain.gateway.ts` (`texteDeSortie`), `tests/agent-brain-gateway.test.ts`.

- Quand le texte de sortie vient du paramètre `message` et que l'annonce est due, la phrase de mention est ajoutée
  devant si le message ne la porte pas déjà.

**Tests attendus :** due et absente : ajoutée ; déjà présente : pas doublée ; non due : rien ; texte écrit par le
modèle : inchangé (on ne touche pas au chemin ordinaire).

### A8. L'alerte de crédit

**Fichiers :** nouveau `src/repondeur/alerte-credit.ts`, câblage (Resend, celui des e-mails transactionnels), tests.

- `alerterCreditEpuise(tenantId)` : `insert ... on conflict do nothing` dans `repondeur_alertes_credit` pour le jour
  (fuseau de l'espace) ; seule l'insertion qui a pris envoie l'e-mail aux admins de l'espace, avec le lien de recharge.
  Sans Resend configuré : journalisé, rien d'envoyé, aucun échec. Appelée par A5 ; et par le tour quand il sort faute
  de CRÉDIT (motif distinct du plafond d'allers-retours, à distinguer dans `run-turn` s'il ne l'est pas).

**Tests attendus :** deux appels le même jour, une seule insertion et un seul envoi (intégration, cas 5) ; le lendemain,
un nouvel envoi ; Resend absent, aucun échec.

### A9. Documentation de la livraison A

`documentation.md` (le répondeur : réglage, une seule voix, scénario système, lecture des tours, en modifiant sur place),
`CLAUDE.md` (« Dernière appliquée : 0208 » écrite DANS le commit qui prend le numéro), `wip.md`, journal.

---

## Livraison B : la console (poussée APRÈS le déploiement de A)

### B1. Le réglage sur la page des agents

**Fichiers :** `web/app/agents/page.tsx` (ou le composant de la liste), `web/lib/` (appel de la route), test e2e.
- Un bloc « Répondeur de l'espace » : « Aucun » ou un des agents actifs ; l'agent de Meta affiché quand il est allumé,
  avec un lien vers son écran ; choisir un agent IA alors que l'agent de Meta est allumé demande une confirmation
  (« l'agent de Meta sera éteint pour tous vos contacts ») ; un agent désactivé n'apparaît pas.

### B2. Les libellés « répondeur automatique »

- Campagnes (`web/components/campagne/EtapeContenu.tsx`), widget (`web/app/widgets/page.tsx`, et le choix « agent IA
  (à venir) » retiré), publicités : « Le répondeur automatique prend la main ». Les valeurs en base ne changent pas.
- La frise de l'Inbox dit « L'agent IA a terminé : <code> » pour `sortie_agent`, et « Répondeur automatique » pour la
  cause d'un scénario système.
- ⚠️ Les e2e trouvent des éléments par rôle et par texte : `grep` des libellés changés dans `web/e2e` avant.

### B3. L'aide et le fonctionnel

- `features.md` : la section de l'agent IA dit qu'il peut être le répondeur de l'espace ; la fiche d'aide
  « construire-un-agent-ia » cesse de dire qu'un agent ne parle que dans un scénario. Relue, empreinte mise à jour dans
  le MÊME commit, `tests/aide-proposer.test.ts` vert avant de pousser.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante à la fin de chaque livraison (aucun
workflow multi-agents), parce que le lot change qui répond aux clients sur tout message non pris (un chemin que la
production emprunte) et que `fil.ts` et l'exécuteur portent des invariants invisibles (gardes ordonnées, écritures
gardées, graphe figé, liaison tardive du câblage).

**Ordre de déploiement :** A : CI verte job par job, `compose build`, la migration 0208 lue sous `pg_stat_activity`
puis appliquée et relue en base, `up` de l'API et des deux workers, rechargement NPM, contrôle public. B : poussée
seulement après que A tourne, Vercel la publie.

**L'essai réel qui clôt** : sur un espace sans scénario que Julien choisit (y désigner l'agent IA ÉTEINT l'agent de
Meta pour tous les contacts de cet espace), Gan PrevMCP en répondeur, depuis son téléphone : (1) un premier message
auquel l'agent répond en le prenant en compte ; (2) une demande d'humain qui arrive dans « À traiter » ; (3) l'humain
rend la main, le message suivant est repris par l'agent ; (4) l'agent de Meta ne répond pas en double. La mémoire de
30 jours se vérifie par un second échange le lendemain.
