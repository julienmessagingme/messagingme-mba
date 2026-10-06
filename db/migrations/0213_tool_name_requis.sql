-- 0213 : `agent_tool_consommateurs.tool_name` devient NOT NULL (lot 2 de
-- docs/superpowers/plans/2026-10-06-nom-unique-par-consommateur.md). 0211 l'a laissée nullable pour que le code
-- d'avant, qui ne l'écrivait pas, survive à la migration ; il n'est plus en production depuis le 2026-10-06.
--
-- 🔴 APRÈS LE `up` DU CODE QUI ÉCRIT LA COLONNE, JAMAIS AVANT : sous l'ancien code, chaque création et chaque
-- rattachement d'outil échouerait en 23502. Et une liaison sans nom échapperait à l'index de 0211 pour toujours :
-- c'est ce que ce `not null` ferme, pour les chemins d'aujourd'hui comme pour ceux qu'on ajoutera.
--
-- 🔴 UN CONTRÔLE D'ABORD, QUI DIT QUOI RENOMMER. Une liaison écrite sans nom pendant la fenêtre du déploiement de 0211
-- échappait à l'index : un doublon a pu s'y glisser, et la reprise heurterait alors l'index sans dire lequel. Le
-- contrôle lit le nom de l'OUTIL, pas sa copie, et nomme chaque consommateur en cause (0127 refusait de même, mais en
-- comptant seulement).
--
-- ⚠️ RETOUR ARRIÈRE : une image antérieure à `2a6c2046` n'écrit pas `tool_name` et échouerait en 23502 à chaque
-- création ou rattachement d'outil. Revenir à une telle image demande d'abord
-- `alter table agent_tool_consommateurs alter column tool_name drop not null`.
set local lock_timeout = '5s';

do $$
declare
  doublons text;
begin
  select string_agg(format('%s / %s : « %s » (%s outils)', d.tenant_id, d.consommateur, d.name, d.n), ' ; ')
    into doublons
    from (select c.tenant_id, c.consommateur, t.name, count(*) as n
            from agent_tool_consommateurs c join agent_tools t on t.id = c.tool_id
           group by c.tenant_id, c.consommateur, t.name
          having count(*) > 1) d;
  if doublons is not null then
    raise exception 'un consommateur porte deux outils du même nom, renommez l''un des deux avant de rejouer 0213 : %',
      doublons;
  end if;
end $$;

-- Les liaisons que l'ancien code a écrites sans nom. Les autres sont tenues justes par la clé étrangère de 0211.
update agent_tool_consommateurs c set tool_name = t.name
  from agent_tools t
 where t.id = c.tool_id and c.tool_name is null;

alter table agent_tool_consommateurs alter column tool_name set not null;
