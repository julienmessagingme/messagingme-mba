-- 0128 : retrait des colonnes que la migration 0127 a remplacees.
--
-- 🔴 ELLE PASSE APRES LE DEPLOIEMENT, contrairement a la regle habituelle : elle RETIRE des colonnes que
-- l ancien code lit encore. Le TYPE de la migration decide de l ordre, pas la routine.
--
-- ⚠️ ELLE FERME LE RETOUR ARRIERE. Entre 0127 et 0128, les deux formes coexistent et redeployer l ancien
-- code marche encore. Apres celle-ci, non : les consentements ne vivent plus que dans la table de liaison.
-- Ne la jouer qu une fois le nouveau code VU EN PRODUCTION, pas seulement pousse.
--
-- 🔴 CE QUI A DU ETRE CORRIGE AVANT DE POUVOIR L APPLIQUER (2026-09-10, commit 08a23ba). Deux lecteurs
-- ecrivaient encore ces colonnes, et aucun n etait visible d un test unitaire :
--   * `PgUserStore.deleteUser` eteignait les outils du partant sur `agent_tools` EN PLUS de la table de
--     liaison. Tout `delete` d un compte serait tombe en 42703, sur un chemin qu on n emprunte que le jour
--     d un depart de collaborateur ;
--   * trois fixtures d integration inseraient `agent_id`, `actif` et `active_par`, donc la CI serait devenue
--     rouge sur une base fraiche.
-- La lecon est celle de 0127, dans l autre sens : « qui ecrit encore ceci ? » se demande AVANT d ecrire le
-- `drop column`, pas apres l avoir applique.
--
-- ⚠️ ORDRE DES NUMEROS : 0129 a ete appliquee AVANT celle-ci (le 2026-09-10 a 20h50). Le runner applique les
-- fichiers absents de `schema_migrations` par ordre de nom, sans exiger que la suite soit continue, et les
-- deux migrations sont independantes.

-- Les deux CHECK de 0086 partent avec les colonnes qu ils gardaient. Leurs jumeaux vivent sur
-- `agent_tool_consommateurs` depuis 0127 : les retirer ici ne desarme rien. Noms LUS EN BASE
-- (`pg_constraint`) avant d ecrire ces lignes, jamais devines : un nom a cote laisserait la contrainte en
-- place, et un `if exists` ne protege que de l absence.
alter table agent_tools drop constraint if exists agent_tools_actif_humain_chk;
alter table agent_tools drop constraint if exists agent_tools_autonome_humain_chk;

-- L index du chemin chaud d avant, `(tenant_id, agent_id) where actif`. Son remplacant est
-- `agent_tool_consommateurs_actifs_idx` (0127), qui sert la meme requete depuis la table de liaison.
drop index if exists agent_tools_actifs_idx;
-- L unicite du nom PAR AGENT. Son remplacant est `agent_tools_nom_espace_idx` (0127), plus strict :
-- un nom est desormais unique par ESPACE, puisque la definition appartient a l espace.
drop index if exists agent_tools_name_idx;

-- ⚠️ Les deux cles etrangeres vers `users` (`agent_tools_active_par_fkey`, `agent_tools_autonome_par_fkey`)
-- n ont pas besoin d etre nommees : Postgres les supprime avec les colonnes qu elles portent.
alter table agent_tools
  drop column if exists agent_id,
  drop column if exists actif,
  drop column if exists active_par,
  drop column if exists active_le,
  drop column if exists autonome,
  drop column if exists autonome_par,
  drop column if exists autonome_le;
