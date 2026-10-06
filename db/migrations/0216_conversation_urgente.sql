-- 0216 : le statut « urgent » d'une conversation (RC2, plan docs/superpowers/plans/2026-10-06-rc2-statut-urgent.md).
-- Tout collaborateur peut marquer une conversation urgente, et un agent IA aussi, par un outil. Elle range la
-- conversation dans le dossier « Urgent » et la fait passer en tete de « A traiter ».
--
--  - conversations.urgente_le : depuis quand. Un HORODATAGE porte l'etat, pas un booleen, comme archived_at (0120)
--    et signalee_le (0123). Nul = pas urgente.
--  - conversations.urgente_par : le collaborateur qui l'a posee. Cle etrangere en on delete set null : le depart
--    d'un collaborateur efface son nom, jamais l'urgence elle-meme. Un agent IA qui la pose la laisse a nul :
--    c'est l'evenement de la frise, et sa cause, qui disent « agent IA ».
--  - conversations_urgentes_idx : index PARTIEL sur les seules urgentes, rares par rapport au reste de la table, pour
--    le dossier « Urgent » et son compteur. Meme raisonnement que conversations_signalees_main_idx (0123).
--  - conversation_evenements_type_check : les quinze types de 0209, plus urgente et urgence_levee.
--
-- 🔴 UNE DECISION, PAS UN CONSTAT. Aucun lien avec conversation_analysis.urgence (la note de 0 a 10 posee par
-- l'analyse) : meme separation que signalee_le et conversation_analysis.abusive. Une re-analyse ne pose ni ne retire
-- rien ici.
--
-- 🔴 ELLE AJOUTE ET RELACHE, DONC AVANT LE UP de l'API et des deux workers. La liste de l'Inbox nomme urgente_le dans
-- son select et dans son tri : deployee avant elle, l'Inbox entiere tomberait en 42703, a chaque rafraichissement. Et
-- le code neuf ecrit urgente et urgence_levee dans conversation_evenements (Traite et l'archivage levent l'urgence
-- dans leur propre requete) : avant elle, 23514, geste compris. L'ancien code ne lit aucune colonne neuve et n'ecrit
-- que les quinze types d'hier : il y survit.
--
-- 🔴 LE NOM DU CHECK DES TYPES EST CELUI QUE 0192 A POSE, QUE 0194 ET 0209 ONT REPOSE
-- (conversation_evenements_type_check) : un nom a cote laisserait l'ancien CHECK en place ET ajouterait le neuf, et
-- les deux types seraient refuses par le premier. Le drop et l'add sont dans la meme transaction : aucune fenetre
-- sans CHECK.
--
-- ⚠️ AUCUNE REPRISE : zero conversation n'est urgente au moment de l'appliquer. Rien ne bouge pour personne.
--
-- ⚠️ LES VERROUS. Les deux add column (nullables, SANS defaut) ne reecrivent pas la table, mais le premier pose un
-- ACCESS EXCLUSIVE sur conversations, ecrite a chaque message entrant, et le GARDE jusqu'au commit : lectures et
-- ecritures attendent donc aussi la validation de la cle etrangere, la construction de l'index (une passe sur la
-- table) et la revalidation du CHECK sur conversation_evenements. lock_timeout ne borne que l'attente du verrou, pas
-- sa duree. Mesure le 2026-10-06 : quelques dizaines de conversations en production, donc une fraction de seconde.
-- Lire pg_stat_activity avant (aucune transaction longue ouverte sur ces deux tables). Et lock_timeout : si une
-- transaction tient une table malgre tout, l'alter echoue au bout de 5 s au lieu de faire attendre derriere lui
-- l'upsert de chaque message entrant ; on relance migrate, rien n'a ete applique.
set local lock_timeout = '5s';

alter table conversations add column if not exists urgente_le timestamptz;
alter table conversations add column if not exists urgente_par uuid
  constraint conversations_urgente_par_fk references users (id) on delete set null;

create index if not exists conversations_urgentes_idx
  on conversations (tenant_id, urgente_le desc)
  where urgente_le is not null;

alter table conversation_evenements drop constraint if exists conversation_evenements_type_check;
alter table conversation_evenements add constraint conversation_evenements_type_check check (type in (
  'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
  'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte',
  'escaladee', 'rendue_scenario', 'sortie_agent', 'urgente', 'urgence_levee'
));
