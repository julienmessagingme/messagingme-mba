-- 0159 : les définitions d'action héritées s'en vont, et le CHECK strict prend leur place.
--
-- 🔴 LA SEULE OPÉRATION IRRÉVERSIBLE DE TOUT CE CHANTIER, et c'est pour ça qu'elle est mesurée, ciblée,
-- et posée en dernier. Arbitrage de Julien, 2026-09-18.
--
-- CE QU'ELLE SUPPRIME, ET POURQUOI CE N'EST PAS DU TRAVAIL DU CLIENT. Avant la migration 0157, « Ajouter un
-- outil » créait une DÉFINITION D'ESPACE plus une ligne de consentement. L'espace de production porte
-- 7 définitions `origin = 'mba'` sans AUCUN consommateur et sans AUCUNE activation : ce sont des créations
-- qui ont échoué à mi-chemin ou des restes d'essais, jamais un outil qui a servi. Mesuré en base avant
-- d'écrire cette migration, et re-mesurable par la requête ci-dessous avant de l'appliquer.
--
--   select count(*) from agent_tools t
--    where t.origin = 'mba' and t.agent_id is null
--      and not exists (select 1 from agent_tool_consommateurs c
--                       where c.tool_id = t.id and c.tenant_id = t.tenant_id);
--
-- ⚠️ LE PRÉDICAT EST STRICT, ET CHACUNE DE SES TROIS CONDITIONS PORTE SON POIDS. `origin = 'mba'` épargne
-- les connecteurs, qui appartiennent légitimement à l'espace. `agent_id is null` épargne toutes les actions
-- du nouveau modèle. Et l'absence de consommateur épargne tout ce qu'un agent ou le MBA utilise vraiment :
-- sans elle, on effacerait des outils en service.
delete from agent_tools t
 where t.origin = 'mba'
   and t.agent_id is null
   and not exists (select 1 from agent_tool_consommateurs c
                    where c.tool_id = t.id and c.tenant_id = t.tenant_id);

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
