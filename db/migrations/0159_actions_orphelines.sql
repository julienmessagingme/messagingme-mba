-- 0159 : les définitions d'action héritées s'en vont, celles qui servent sont ADOPTÉES, et le CHECK strict
-- prend leur place.
--
-- 🔴 LA SEULE OPÉRATION IRRÉVERSIBLE DE TOUT CE CHANTIER, et c'est pour ça qu'elle est mesurée, ciblée,
-- et posée en dernier. Arbitrage de Julien, 2026-09-18.
--
-- 🔴 ELLE A ÉTÉ CORRIGÉE PAR LA REVUE FINALE, ET LE DÉFAUT ÉTAIT DANS SA PROPRE MESURE. Elle ne comptait
-- que les lignes qu'elle allait SUPPRIMER, ce qui ne répond pas à la question que pose son CHECK. Le code
-- DÉPLOYÉ aujourd'hui crée une action `origin = 'mba'` SANS `agent_id` et lui écrit UN consommateur : une
-- action créée d'ici au déploiement survit donc au `delete` (elle a un consommateur) ET viole le CHECK
-- (elle n'a pas d'`agent_id`). L'`alter table` échouait, en fin de déploiement, sur une donnée que la
-- requête de contrôle ne montrait pas. D'où TROIS gestes ci-dessous et non un seul : on débarrasse les
-- consentements morts, on supprime ce que plus personne n'utilise, on ADOPTE ce que quelqu'un utilise.
--
-- ⚠️ LES DEUX REQUÊTES À JOUER AVANT DE L'APPLIQUER, et la seconde est celle qui manquait :
--
--   -- 1. ce qui va être SUPPRIMÉ (doit rester des restes d'essais, jamais un outil qui a servi) :
--   select id, name from agent_tools t
--    where t.origin = 'mba' and t.agent_id is null
--      and not exists (select 1 from agent_tool_consommateurs c
--                       where c.tool_id = t.id and c.tenant_id = t.tenant_id);
--
--   -- 2. ce qui BLOQUERAIT le CHECK après les trois gestes, c'est-à-dire les cas AMBIGUS : une définition
--   -- partagée entre deux agents, ou exposée au Meta Business Agent. Les consentements morts sont exclus,
--   -- puisque le premier geste les retire.
--   select t.id, t.name, array_agg(c.consommateur) from agent_tools t
--     join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id
--    where t.origin = 'mba' and t.agent_id is null
--      and (c.consommateur not like 'agent:%'
--           or exists (select 1 from agents a
--                       where a.id = substring(c.consommateur from 7)::uuid and a.tenant_id = c.tenant_id))
--    group by t.id, t.name having count(*) > 1 or bool_or(c.consommateur not like 'agent:%');
--
-- Si la seconde rend des lignes, il faut TRANCHER à la main avant d'appliquer : ces définitions-là n'ont pas
-- de propriétaire évident et la migration se refuse à en inventer un. C'est exactement la raison pour
-- laquelle l'adoption ci-dessous est conservatrice.

-- 🔴 UN CONSOMMATEUR PEUT NOMMER UN AGENT QUI N'EXISTE PLUS, ET RIEN DANS LE SCHÉMA NE L'EN EMPÊCHE.
-- `agent_tool_consommateurs.consommateur` est un TEXTE (`agent:<uuid>` ou `mba:<numero>`), pas une clé
-- étrangère : supprimer un agent laisse donc ses lignes de consentement derrière lui. Deux conséquences, et
-- la CI les a trouvées toutes les deux : une telle ligne fait passer une définition pour « encore utilisée »
-- alors que plus rien ne peut s'en servir, et l'adoption plus bas y lirait un `agent_id` fantôme, qui
-- violerait `agent_tools_agent_id_fkey` et ferait échouer toute la migration.
--
-- ⚠️ ELLE NE TOUCHE QUE LES ACTIONS (`origin = 'mba'`). Un connecteur appartient à l'espace, et le
-- débarrasser ici d'un consentement mort le rendrait supprimable depuis `Tools >`, ce qui déborde de ce que
-- cette migration annonce faire.
delete from agent_tool_consommateurs c
 where c.consommateur like 'agent:%'
   and exists (select 1 from agent_tools t
                where t.id = c.tool_id and t.tenant_id = c.tenant_id and t.origin = 'mba')
   and not exists (select 1 from agents a
                    where a.id = substring(c.consommateur from 7)::uuid and a.tenant_id = c.tenant_id);

-- ⚠️ LE PRÉDICAT EST STRICT, ET CHACUNE DE SES TROIS CONDITIONS PORTE SON POIDS. `origin = 'mba'` épargne
-- les connecteurs, qui appartiennent légitimement à l'espace. `agent_id is null` épargne toutes les actions
-- du nouveau modèle. Et l'absence de consommateur épargne tout ce qu'un agent ou le MBA utilise vraiment :
-- sans elle, on effacerait des outils en service.
delete from agent_tools t
 where t.origin = 'mba'
   and t.agent_id is null
   and not exists (select 1 from agent_tool_consommateurs c
                    where c.tool_id = t.id and c.tenant_id = t.tenant_id);

-- 🔴 L'ADOPTION, ET ELLE N'INVENTE RIEN : C'EST LA LIGNE DE CONSENTEMENT QUI NOMME LE PROPRIÉTAIRE. Une
-- action créée par le code déployé porte exactement UN consommateur, et c'est l'agent depuis l'écran duquel
-- on l'a créée. Lui donner cet `agent_id`, c'est écrire ce qui était déjà vrai, pas choisir à la place du
-- client. C'est aussi ce qui rend la fenêtre de déploiement sûre : tout ce que l'ancien code peut créer
-- entre maintenant et le déploiement tombe dans ce cas-là.
--
-- ⚠️ QUATRE GARDES, ET AUCUNE N'EST DÉCORATIVE :
--   - `count(*) = 1` : deux consommateurs, deux propriétaires possibles, donc on ne tranche pas ;
--   - `consommateur like 'agent:%'` : le Meta Business Agent n'est pas un agent IA, il n'a pas d'`agent_id` ;
--   - l'`exists` sur `agents` : le consentement n'est pas une clé étrangère, donc il peut nommer un agent
--     supprimé. Sans cette garde on écrit un `agent_id` fantôme et `agent_tools_agent_id_fkey` fait échouer
--     la migration entière. Le nettoyage en tête de fichier a déjà retiré ces lignes, et cette garde reste :
--     un invariant qui tient à l'ordre de deux instructions tient mal ;
--   - le `not exists` final : l'agent possède peut-être DÉJÀ une action de ce nom (créée par le code neuf,
--     entre le déploiement et cette migration). L'adopter violerait `agent_tools_nom_agent_uidx` et ferait
--     échouer toute la migration sur un index, ce qui est le pire endroit pour l'apprendre.
update agent_tools t
   set agent_id = proprio.agent_id
  from (
    select c.tool_id, c.tenant_id, substring(min(c.consommateur) from 7)::uuid as agent_id
      from agent_tool_consommateurs c
     group by c.tool_id, c.tenant_id
    having count(*) = 1 and bool_and(c.consommateur like 'agent:%')
  ) as proprio
 where t.id = proprio.tool_id
   and t.tenant_id = proprio.tenant_id
   and t.origin = 'mba'
   and t.agent_id is null
   and exists (select 1 from agents a where a.id = proprio.agent_id and a.tenant_id = t.tenant_id)
   and not exists (select 1 from agent_tools d
                    where d.tenant_id = t.tenant_id and d.name = t.name
                      and d.agent_id = proprio.agent_id);

-- 🔴 LE CHECK STRICT, ET IL NE POUVAIT PAS ÊTRE POSÉ AVANT : c'est la leçon de 0152, appliquée dans l'autre
-- sens. 0157 a délibérément laissé `agent_id` nullable pour que le code DÉPLOYÉ, qui l'ignorait, continue de
-- créer ses définitions sans échouer. Maintenant qu'aucun chemin du code ne crée plus d'action au niveau de
-- l'espace (`ajouter` renseigne toujours `agent_id`, et les deux chemins de connecteur écrivent `http` ou
-- `mcp`), la contrainte peut se fermer.
--
-- 🔴 ELLE DOIT DONC ÊTRE APPLIQUÉE **APRÈS** LE DÉPLOIEMENT DU CODE DE 0157, jamais avant. L'ordre se décide
-- sur « l'ancien code survit-il à ce changement ? », et la réponse est NON : l'ancien `ajouter` écrit
-- `agent_id` à null, donc toute création d'outil échouerait pendant la fenêtre du déploiement.
--
-- Ce qu'elle achète : `Tools >` n'a plus besoin de filtrer quoi que ce soit pour ne montrer que les
-- connecteurs, puisque plus aucune action ne peut y apparaître. Une garantie tenue par la base vaut mieux
-- qu'un `filter` dans un écran, que le prochain écran oubliera.
alter table agent_tools drop constraint if exists agent_tools_action_par_agent_chk;
alter table agent_tools add constraint agent_tools_action_par_agent_chk
  check (origin <> 'mba' or agent_id is not null);
