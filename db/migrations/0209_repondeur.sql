-- 0209 : le repondeur par defaut (lot 5, spec docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md).
-- Un agent IA designe par l'espace repond a tout message entrant que ni un scenario, ni un mot-cle, ni un humain
-- ne tient, comme l'agent de Meta, sans scenario construit par le client.
--
--  - tenant_settings.repondeur_agent_id : l'agent IA designe. Nul = le comportement d'avant (l'agent de Meta s'il est
--    allume, sinon personne). Cle etrangere en on delete set null : supprimer l'agent remet l'espace sans repondeur,
--    jamais une suppression refusee (une contrainte qui bloquerait rendrait 500 sur un geste ordinaire).
--  - tenant_settings_repondeur_une_voix_chk : UNE SEULE VOIX, tenue par la base et pas par les appelants. Deux
--    repondeurs ne peuvent pas coexister, quel que soit le chemin d'ecriture. Le seul ecrivain de mba_enabled
--    (PgTenantSettingsStore.setMbaEnabled) remet repondeur_agent_id a nul dans la meme instruction quand il allume.
--  - workflows.systeme : le scenario systeme cache, une ligne par espace (index unique partiel), ancre que
--    workflow_runs.workflow_id exige. Son graphe n'y est pas tenu : il est construit a chaque demarrage et fige dans
--    le parcours (graphe_fige, 0151). Le magasin des scenarios l'exclut de TOUTES ses lectures publiques.
--  - conversation_evenements_type_check : les quatorze types de 0194, plus sortie_agent (la regle d'arret par
--    laquelle un agent IA a termine, pour la frise du panneau Detail).
--  - repondeur_alertes_credit : une ligne par espace et par jour ou l'alerte de credit epuise est partie. Le une par
--    jour se tient ici, en base, et pas en memoire : l'API et les workers sont plusieurs copies.
--
-- 🔴 ELLE AJOUTE ET RELACHE, DONC AVANT LE UP de l'API et des deux workers. Le magasin des scenarios filtre sur
-- workflows.systeme dans chaque lecture : deploye avant elle, chaque liste de scenarios tomberait en 42703. Et le code
-- neuf ecrit sortie_agent dans conversation_evenements : avant elle, 23514 a chaque sortie d'agent. L'ancien code ne
-- lit aucune des colonnes neuves et n'ecrit que les quatorze types d'hier : il y survit.
--
-- 🔴 LE NOM DU CHECK DES TYPES EST CELUI QUE 0192 A POSE ET QUE 0194 A REPOSE (conversation_evenements_type_check) :
-- un nom a cote laisserait l'ancien CHECK en place ET ajouterait le neuf, et sortie_agent serait refuse par le
-- premier. Le drop et l'add sont dans la meme transaction : aucune fenetre sans CHECK.
--
-- ⚠️ AUCUNE REPRISE : zero espace n'a de repondeur au moment de l'appliquer, donc zero ligne ne viole la regle d'une
-- seule voix. Zero scenario n'est systeme. Rien ne bouge pour personne.
--
-- ⚠️ LES VERROUS. Les alter posent un ACCESS EXCLUSIVE sur tenant_settings (lue a chaque message entrant), workflows
-- et conversation_evenements le temps de relire leurs lignes (quelques centaines a quelques milliers). Lire
-- pg_stat_activity avant (aucune transaction longue ouverte sur ces tables). Et lock_timeout : si une transaction
-- tient une table malgre tout, l'alter echoue au bout de 5 s au lieu de faire attendre derriere lui chaque message
-- entrant ; on relance migrate, rien n'a ete applique.
set local lock_timeout = '5s';

alter table tenant_settings add column if not exists repondeur_agent_id uuid
  constraint tenant_settings_repondeur_agent_fk references agents (id) on delete set null;
alter table tenant_settings drop constraint if exists tenant_settings_repondeur_une_voix_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_une_voix_chk
  check (repondeur_agent_id is null or mba_enabled = false);

alter table workflows add column if not exists systeme text;
alter table workflows drop constraint if exists workflows_systeme_chk;
alter table workflows add constraint workflows_systeme_chk check (systeme in ('repondeur'));
create unique index if not exists workflows_systeme_uidx on workflows (tenant_id) where systeme = 'repondeur';

alter table conversation_evenements drop constraint if exists conversation_evenements_type_check;
alter table conversation_evenements add constraint conversation_evenements_type_check check (type in (
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent'
));

create table if not exists repondeur_alertes_credit (
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- Le jour dans le fuseau de l'espace : c'est sa journee que le client lit dans l'e-mail.
  jour      date not null,
  primary key (tenant_id, jour)
);
