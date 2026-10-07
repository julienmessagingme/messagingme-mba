-- 0217 : qui repond au client (RC6, plan docs/superpowers/plans/2026-10-06-rc6-qui-repond.md). Un seul reglage de
-- l'Accueil decide qui repond a un nouveau contact ou a un message que personne ne tient : l'agent de Meta, un agent
-- IA, un scenario, ou l'equipe. L'agent de Meta allume n'est plus forcement repondeur : hors du mode mba, il est en
-- veille et ne prend un contact que par le bloc « Envoyer au MBA » (type vers_mba).
--
--  - tenant_settings.repondeur_mode : mba, agent, scenario ou equipe (miroir de MODES_REPONDEUR, src/repondeur/mode.ts).
--    Defaut equipe : un espace neuf voit ses messages sans suite dans « A traiter ».
--  - tenant_settings.repondeur_workflow_id : le scenario du mode scenario. Cle etrangere en on delete set null :
--    supprimer le scenario laisse l'espace en mode scenario SANS scenario, que le code lit comme equipe.
--  - tenant_settings.repondeur_delai_scenario_s : au plus un depart du scenario par contact et par delai, 24 h par
--    defaut, de 1 h a 30 jours.
--  - contacts.repondeur_scenario_le : le dernier depart du scenario repondeur pour ce contact. Une colonne plutot qu'une
--    lecture de workflow_runs, que la retention purge et qu'aucun index ne sert par contact. Posee par une seule
--    instruction gardee (PgContactStore.reclamerDepartRepondeur) : deux entrants simultanes, un seul depart.
--  - deux CHECK A SENS UNIQUE (lecon de 0144) : une cible n'existe que dans son mode. L'inverse (mode agent sans agent,
--    mode scenario sans scenario) est un etat ATTEIGNABLE, la suppression apres coup, lu comme equipe avec un
--    avertissement a l'ecran. Le refuser ferait echouer la suppression d'un agent ou d'un scenario.
--  - tenant_settings_repondeur_une_voix_chk SUPPRIMEE : un agent IA repondeur et l'agent de Meta allume (en veille)
--    coexistent desormais. Relacher : l'ancien code y survit (il ne l'ecrit jamais en violation).
--  - conversation_evenements_type_check : les dix-sept types de 0216, plus mba_indisponible (le bloc « Envoyer au
--    MBA » a trouve l'agent de Meta eteint, la conversation va a l'equipe).
--
-- 🔴 LA REPRISE CHANGE CE QUE VIVENT DES CLIENTS. agent si repondeur_agent_id est pose, sinon mba si mba_enabled, sinon
-- equipe. Les deux premiers reproduisent exactement aujourd'hui. Le troisieme NON : un espace sans repondeur ne
-- repondait a personne et laissait ses messages sans suite hors d'« A traiter » ; en equipe, ils y entrent (decision
-- de Julien du 2026-10-06). Un espace sans ligne de reglages n'a pas de ligne a reprendre : le code le lit equipe.
--
-- 🔴 LE COMPTAGE, AVANT ET APRES, se lit avec ces deux requetes (la premiere AVANT migrate, la seconde juste apres) :
--   select case when repondeur_agent_id is not null then 'agent' when mba_enabled then 'mba' else 'equipe' end as mode,
--          count(*) from public.tenant_settings group by 1 order by 1;
--   select repondeur_mode, count(*) from public.tenant_settings group by 1 order by 1;
-- Les deux doivent rendre les MEMES lignes, et aucune ligne scenario.
--
-- 🔴 ELLE AJOUTE ET RELACHE, DONC AVANT LE UP de l'API et des deux workers. Le code neuf lit repondeur_mode a chaque
-- message entrant (select * de PgTenantSettingsStore.get, qui retombe sur la regle de la reprise si la colonne
-- manque), ecrit les trois colonnes au reglage, pose contacts.repondeur_scenario_le et ecrit mba_indisponible :
-- avant elle, 42703 au reglage et 23514 au bloc. L'ancien code ne lit aucune colonne neuve et n'ecrit que les
-- dix-sept types d'hier : il y survit, a UN geste pres. Designer un agent IA repondeur (son setRepondeur ecrit
-- repondeur_agent_id sans repondeur_mode) viole tenant_settings_repondeur_agent_chk : 23514, rien n'est ecrit, et
-- l'ecran de l'ancienne console le dit en erreur. Fenetre assumee : entre migrate et le up, quelques minutes.
-- Son setMbaEnabled, lui, remet l'agent a nul quand il allume : il ne viole rien.
--
-- 🔴 LE NOM DU CHECK DES TYPES EST CELUI QUE 0192 A POSE, QUE 0194, 0209 ET 0216 ONT REPOSE : un nom a cote laisserait
-- l'ancien CHECK en place ET ajouterait le neuf. Le drop et l'add sont dans la meme transaction.
--
-- ⚠️ L'ORDRE COMPTE : la reprise passe AVANT les deux CHECK a sens unique (un espace a agent IA est en equipe tant que
-- la reprise ne l'a pas mis en agent), et le drop de la contrainte d'une seule voix avant tout.
--
-- ⚠️ LES VERROUS. tenant_settings (lue a chaque message entrant) et contacts (ecrite a chaque message entrant) prennent
-- un ACCESS EXCLUSIVE le temps des alter : l'ajout d'une colonne avec defaut constant ne reecrit pas la table, mais
-- les CHECK et la cle etrangere relisent tenant_settings (une ligne par espace) ; la colonne nullable de contacts ne
-- relit rien. Lire pg_stat_activity avant (aucune transaction longue ouverte sur ces tables). Et lock_timeout : si une
-- transaction tient une table malgre tout, l'alter echoue au bout de 5 s au lieu de faire attendre derriere lui chaque
-- message entrant ; on relance migrate, rien n'a ete applique.
set local lock_timeout = '5s';

alter table tenant_settings drop constraint if exists tenant_settings_repondeur_une_voix_chk;

alter table tenant_settings add column if not exists repondeur_mode text not null default 'equipe';
alter table tenant_settings drop constraint if exists tenant_settings_repondeur_mode_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_mode_chk
  check (repondeur_mode in ('mba', 'agent', 'scenario', 'equipe'));

alter table tenant_settings add column if not exists repondeur_workflow_id uuid
  constraint tenant_settings_repondeur_workflow_fk references workflows (id) on delete set null;

alter table tenant_settings add column if not exists repondeur_delai_scenario_s integer not null default 86400;
alter table tenant_settings drop constraint if exists tenant_settings_repondeur_delai_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_delai_chk
  check (repondeur_delai_scenario_s between 3600 and 2592000);

update tenant_settings
   set repondeur_mode = case when repondeur_agent_id is not null then 'agent' when mba_enabled then 'mba' else 'equipe' end;

alter table tenant_settings drop constraint if exists tenant_settings_repondeur_agent_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_agent_chk
  check (repondeur_agent_id is null or repondeur_mode = 'agent');
alter table tenant_settings drop constraint if exists tenant_settings_repondeur_scenario_chk;
alter table tenant_settings add constraint tenant_settings_repondeur_scenario_chk
  check (repondeur_workflow_id is null or repondeur_mode = 'scenario');

alter table conversation_evenements drop constraint if exists conversation_evenements_type_check;
alter table conversation_evenements add constraint conversation_evenements_type_check check (type in (
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent', 'urgente', 'urgence_levee', 'mba_indisponible'
));

-- EN DERNIER : contacts est la table la plus chaude (chaque message entrant y ecrit), et le verrou exclusif de cet alter
-- tient jusqu'au commit. Place ici, il ne couvre plus la reprise ni la revalidation du CHECK des evenements
-- (relecture de RC6).
alter table contacts add column if not exists repondeur_scenario_le timestamptz;
