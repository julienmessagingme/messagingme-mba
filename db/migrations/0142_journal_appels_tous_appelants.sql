-- 0142 : le journal des appels de connecteur s ouvre a SES TROIS APPELANTS, et devient lisible.
--
-- 🔴 CE QUE L INVENTAIRE DE LA TACHE 9 A TROUVE, ET QUI EST LE VRAI SUJET DE CETTE MIGRATION.
-- `creerAppelConnecteur` (src/agent/resolvers/http.ts) est le point de passage unique des appels vers le
-- systeme d un client. Il a TROIS appelants : l agent IA, le bloc « Appel HTTP » d un scenario, et depuis le
-- 2026-09-13 la poussee d un opt-out. UN SEUL journalisait ses echecs, et c est l executeur d agent qui le
-- faisait, au-dessus. Les deux autres n ecrivaient qu un `console.warn` : un connecteur qui refuse l appel
-- d un scenario, ou qui ne recoit jamais le refus d un contact, ne laissait AUCUNE trace consultable.
-- C est le motif « une capacite cablee sur un consommateur sur trois », deja paye plusieurs fois ici.
--
-- 🔴 DEUX VERROUS DE SCHEMA EMPECHAIENT LES DEUX AUTRES D ECRIRE, et c est pour ca qu ils ne le faisaient pas :
--   1. `session_id` est NOT NULL et reference `agent_sessions`. Un scenario n ouvre pas de session d agent, une
--      poussee d opt-out non plus. C est aussi la raison d etre de `JOURNAL_MUET` (le bac a sable). La colonne
--      devient NULLABLE : « cet appel n appartient a aucune session » est une verite, pas un trou.
--   2. rien ne disait QUI appelait. Sans cette colonne, les lignes d un scenario et celles d un agent
--      seraient indiscernables, et le jour ou la facturation lira cette table (son propre commentaire le
--      promet depuis 0086, et RIEN ne la lit aujourd hui, verifie), elle compterait les unes pour les autres.
--
-- ⚠️ `source` A UN DEFAUT ET UN CHECK. Le defaut vaut pour les lignes existantes, qui viennent toutes de
-- l agent : c est exact, il etait le seul appelant. Le CHECK ferme l enumeration en base, pas seulement dans
-- le code, pour qu aucun autre chemin d ecriture ne puisse poser une valeur que la lecture ne sait pas rendre.
--
-- ⚠️ MIGRATION QUI RELACHE ET QUI AJOUTE, donc AVANT le deploiement : l ancien code y SURVIT sans rien
-- changer (il continue de renseigner `session_id`, et `source` prend son defaut). C est la regle corrigee du
-- 2026-09-10 : ce qui decide n est pas « ajoute / retire » mais « l ancien code survit-il ? ».

alter table agent_tool_calls alter column session_id drop not null;

alter table agent_tool_calls add column if not exists source text not null default 'agent';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_tool_calls_source_check') then
    alter table agent_tool_calls
      add constraint agent_tool_calls_source_check
      check (source in ('agent', 'scenario', 'optout'));
  end if;
end $$;

-- 🔴 L INDEX QUI REND LE JOURNAL LISIBLE, ET C EST UN CONTRAT AVEC UNE REQUETE PRECISE. L ecran demande
-- « les appels EN ECHEC de cet espace, du plus recent au plus ancien ». L index existant
-- (`agent_tool_calls_session_idx`, sur `(tenant_id, session_id, at)`) ne sert pas cette question : il est
-- ordonne par session. PARTIEL sur les echecs, parce qu ils sont une minorite des appels et que c est la
-- seule chose que cet ecran regarde.
--
-- ⚠️ SON PREDICAT REPREND MOT POUR MOT le `where` de la lecture. En sortir n aurait produit aucune erreur,
-- juste un balayage complet du journal d appels a chaque ouverture de l ecran (lecon des 0120 et 0122).
create index if not exists agent_tool_calls_echecs_idx
  on agent_tool_calls (tenant_id, at desc)
  where status <> 'ok';
