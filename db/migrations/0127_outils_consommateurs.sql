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
-- ⚠️ ELLE N AJOUTE PAS QUE, ET C EST DELIBERE : elle RELACHE aussi le NOT NULL de `agent_id` (voir plus bas).
-- Relacher est compatible avec l ANCIEN code, qui continue de renseigner la colonne ; RETIRER ne l est pas.
-- C est cette nuance qui rend la fenetre de coexistence possible, et je l avais ratee : sans elle, toute
-- creation d outil echouait en 23502 entre le deploiement et la 0128.
--
-- Le RETRAIT de `agent_id` et des six colonnes de consentement est la migration 0128, qui passe APRES le
-- deploiement. Le TYPE de la migration decide de l ordre, pas la routine.
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

-- 🔴 `agent_id` DEVIENT NULLABLE, PREMIER DES DEUX GESTES QUI RENDENT LA COEXISTENCE POSSIBLE (le second
-- est le retrait de sa cascade, juste en dessous). Cette migration
-- « n ajoute que », disait le plan, et c etait FAUX sur ce point : le nouveau code n ecrit plus `agent_id`
-- (l outil appartient a l espace), or la colonne etait NOT NULL jusqu a 0128. Toute creation d outil aurait
-- echoue en 23502 entre le deploiement et la 0128, c est-a-dire exactement pendant la fenetre censee etre la
-- plus sure. Constate en CI, sur onze tests d integration d un coup.
--
-- ⚠️ RELACHER une contrainte est compatible avec l ANCIEN code, qui continue de renseigner la colonne : c est
-- ce qui distingue ce geste d un RETRAIT, et c est pour ca qu il a sa place ici et non dans 0128. La colonne
-- elle-meme part avec 0128, une fois le nouveau code vu en production.
alter table agent_tools alter column agent_id drop not null;

-- 🔴 ET SA CASCADE DOIT PARTIR AUSSI, sinon supprimer un agent DETRUIT des definitions PARTAGEES. La cle
-- etrangere de 0086 est `on delete cascade` : tant qu elle existe, l outil que trois agents utilisent
-- disparait avec le premier des trois qu on supprime. C est exactement ce que la migration 0127 existe pour
-- empecher, et la colonne survivante l aurait fait dans le dos de tout le monde jusqu a la 0128.
--
-- ⚠️ Le nom de la contrainte est LU en base, jamais devine : nommee automatiquement en 0086, un nom devine a
-- cote laisserait la cascade en place et un `if exists` ne protege que de l absence.
do $$
declare nom text;
begin
  select conname into nom from pg_constraint
   where conrelid = 'agent_tools'::regclass and contype = 'f'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'agent_tools'::regclass and attname = 'agent_id')];
  if nom is not null then
    execute format('alter table agent_tools drop constraint %I', nom);
  end if;
end $$;

-- Le nom expose devient unique par ESPACE, plus par agent. Pas de `lower()` : la contrainte
-- `name ~ '^[a-z0-9_]{1,64}$'` de 0086 garantit deja des minuscules, et un `lower()` inutile ferait croire
-- que la casse est un sujet. L ancien index `(agent_id, name)` reste en place jusqu a 0128.
create unique index if not exists agent_tools_nom_espace_idx on agent_tools (tenant_id, name);
