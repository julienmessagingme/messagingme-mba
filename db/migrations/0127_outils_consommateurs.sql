-- 0127 : le CONSENTEMENT d un outil descend dans une table de liaison, la DEFINITION reste sur l outil.
--
-- POURQUOI. `agent_tools` porte aujourd hui les deux : ce qu un outil EST (nom, description, parametres,
-- liaison, risque, plafonds) et QUI a le droit de s en servir (`actif`, `autonome`, et qui les a coches). Le
-- premier appartient a l ESPACE, le second au couple (outil, consommateur). Les laisser ensemble obligeait a
-- redecrire le meme outil pour chaque agent, donc a corriger ses mots a N endroits, et rendait impossible de
-- l exposer au Meta Business Agent sans lui inventer une fiche d agent.
--
-- 🔴 UNE REMONTEE NAIVE AURAIT RENDU UN OUTIL ACTIF POUR TOUS LES AGENTS D UN COUP. La migration 0086 dit
-- pourquoi ce serait grave, dans ses propres termes : « la spec MCP exige un consentement humain avant l
-- invocation d un outil ; notre agent n a pas d humain au runtime, donc on deplace le consentement du
-- runtime vers la CONFIGURATION, et on le rend incontournable EN BASE ». Ses deux CHECK sont donc RECOPIES
-- ici. Les perdre en chemin viderait 0086 de son contenu sans que rien ne le signale.
--
-- ⚠️ ELLE N AJOUTE QUE. Le retrait de `agent_id` et des six colonnes de consentement est la migration 0128,
-- qui passe APRES le deploiement : entre les deux, les deux formes coexistent et le retour arriere reste
-- possible. Le TYPE de la migration decide de l ordre, pas la routine.
--
-- MESURE QUI REND CE LOT FAISABLE MAINTENANT (2026-09-10) : 2 outils au total, 1 agent, 1 espace, 0 actif,
-- 0 doublon de nom, 0 source declaree. Aucune fusion de donnees a arbitrer. Ce ne sera jamais moins cher.

create table if not exists agent_tool_consommateurs (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  tool_id      uuid not null references agent_tools(id) on delete cascade,
  -- 'agent:<uuid>' ou 'mba:<phone_number_id>'. Cle TEXTE assumee : un consommateur n est pas toujours une
  -- ligne de notre base. Fabriquee par `src/agent/consommateur.ts`, jamais concatenee ailleurs.
  consommateur text not null,
  actif        boolean not null default false,
  active_par   uuid references users(id) on delete set null,
  active_le    timestamptz,
  autonome     boolean not null default false,
  autonome_par uuid references users(id) on delete set null,
  autonome_le  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tool_id, consommateur)
);

-- Les deux CHECK de 0086, recopies A L IDENTIQUE : un outil n est actif que si un humain l a active, et
-- l autonomie porte le nom de qui l a cochee. C est ce qui rend un incident instruisable.
alter table agent_tool_consommateurs drop constraint if exists atc_actif_humain_chk;
alter table agent_tool_consommateurs add constraint atc_actif_humain_chk
  check (actif = false or active_par is not null);
alter table agent_tool_consommateurs drop constraint if exists atc_autonome_humain_chk;
alter table agent_tool_consommateurs add constraint atc_autonome_humain_chk
  check (autonome = false or autonome_par is not null);

-- La FORME de la cle, verrouillee en base. Recopiee VERBATIM depuis `FORME_CONSOMMATEUR`
-- (`src/agent/consommateur.ts`) ; `tests/agent-consommateur.test.ts` verifie que les deux ne divergent pas.
-- Sans ce CHECK, une faute de frappe produirait une ligne MUETTE : aucun consommateur ne la lirait, et
-- l outil paraitrait simplement inactif, ce qui est le pire des symptomes (rien a diagnostiquer).
alter table agent_tool_consommateurs drop constraint if exists atc_consommateur_chk;
alter table agent_tool_consommateurs add constraint atc_consommateur_chk
  check (consommateur ~ '^(agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mba:[0-9]{1,32})$');

-- 🔴 CONTRAT AVEC UNE REQUETE PRECISE : c est l index du CHEMIN CHAUD, celui que `listActifs` et `byName`
-- empruntent a chaque tour d agent, sur chaque message entrant. Elargir leur `where` sans elargir ce
-- predicat ne produit AUCUNE erreur, juste un parcours de table a chaque message.
create index if not exists agent_tool_consommateurs_actifs_idx
  on agent_tool_consommateurs (tenant_id, consommateur) where actif;

-- La reprise de l existant : une ligne par outil, pour SON agent, avec son consentement TRANSPORTE. Un outil
-- actif reste actif et garde le nom de qui l a active ; perdre `active_par` ferait echouer le CHECK ci-dessus,
-- ce qui est le bon comportement (mieux vaut refuser la migration que fabriquer un consentement sans auteur).
insert into agent_tool_consommateurs
  (tenant_id, tool_id, consommateur, actif, active_par, active_le, autonome, autonome_par, autonome_le)
select tenant_id, id, 'agent:' || agent_id, actif, active_par, active_le, autonome, autonome_par, autonome_le
  from agent_tools
on conflict (tool_id, consommateur) do nothing;

-- La precondition du nouvel index, VERIFIEE plutot que supposee, et avec un message qui dit QUOI FAIRE.
-- Mesure du 2026-09-10 : zero doublon. Mais une migration se rejoue des mois plus tard, sur d autres bases.
do $$
declare doublons int;
begin
  select count(*) into doublons from (
    select tenant_id, name from agent_tools group by 1, 2 having count(*) > 1
  ) d;
  if doublons > 0 then
    raise exception 'migration 0127 impossible : % nom(s) d outil porte(s) par plusieurs agents du meme espace. Renommer les doublons avant de rejouer : select tenant_id, name, count(*) from agent_tools group by 1,2 having count(*) > 1;', doublons;
  end if;
end $$;

-- Le nom expose devient unique par ESPACE, plus par agent. Pas de `lower()` : la contrainte
-- `name ~ '^[a-z0-9_]{1,64}$'` de 0086 garantit deja des minuscules, et un `lower()` inutile ferait croire
-- que la casse est un sujet. L ancien index `(agent_id, name)` reste en place jusqu a 0128.
create unique index if not exists agent_tools_nom_espace_idx on agent_tools (tenant_id, name);
