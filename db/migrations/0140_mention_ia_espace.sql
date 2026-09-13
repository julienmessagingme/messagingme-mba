-- 0140 : « l IA se declare comme telle » devient un reglage de l ESPACE, plus une case par agent.
--
-- 🔴 POURQUOI CA MONTE D UN CRAN. L AI Act (article 50) fait peser l obligation d information sur la MARQUE
-- DEPLOYANTE, pas sur chacun de ses robots. Un client qui a trois agents n a pas a repondre trois fois a la
-- meme question de conformite, et surtout : trois reponses differentes seraient trois politiques, ce qui
-- n existe pas juridiquement. Le reglage suit donc l obligation.
--
-- 🔴 CE QUE LA BASE DIT AUJOURD HUI, MESURE AVANT D ECRIRE CETTE MIGRATION (2026-09-13) : UN seul agent
-- existe en production, sur un seul espace, en `session` (le defaut). AUCUN espace n a deux agents, donc
-- aucun ne porte deux politiques divergentes, et la reprise ci-dessous est EXACTE pour tout le monde. Sans
-- cette mesure, la regle de reprise aurait ete un pari.
--
-- 🔴 LA REGLE DE REPRISE, POUR LE JOUR OU LA DIVERGENCE EXISTERA : c est la valeur qui DECLARE LE PLUS qui
-- gagne (`chaque_message` > `session` > `jamais`). Ce n est pas un choix esthetique. Rassembler deux agents
-- sous une politique unique oblige a bouger l un des deux ; le faire vers MOINS de declaration serait une
-- regression de conformite silencieuse sur un espace dont personne ne se serait apercu, quand le faire vers
-- PLUS ne coute qu une phrase de trop. Entre les deux erreurs, une seule se rattrape.
--
-- ⚠️ NULLABLE, ET NULL VEUT DIRE « rien n a jamais ete regle ici » : le code retombe alors sur `session`,
-- exactement le defaut de 0126. Un espace SANS agent reste donc a null, et il n y a aucune ligne inventee.
--
-- ⚠️ LE META BUSINESS AGENT N EST PAS CONCERNE, et il ne faut pas le lui appliquer par symetrie : Meta
-- ecrit deja « IA » sous les messages de son agent. Notre propre declaration en ferait deux. Ce reglage ne
-- gouverne que NOS agents, et l ecran le dit.
--
-- ⚠️ ELLE NE RETIRE RIEN. `agents.mention_ia_frequence` reste en place et reste lue par le code DEPLOYE :
-- la retirer ici casserait la production pendant toute la duree du deploiement. Son retrait est la migration
-- SUIVANTE, appliquee APRES que le nouveau code ait ete vu en production, comme 0128 l a ete apres 0129.
--
-- ⚠️ MIGRATION QUI AJOUTE UNE COLONNE LUE PAR LE CODE : elle passe AVANT le deploiement.

alter table tenant_settings add column if not exists mention_ia_frequence text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenant_settings_mention_ia_frequence_check'
  ) then
    alter table tenant_settings
      add constraint tenant_settings_mention_ia_frequence_check
      check (mention_ia_frequence is null or mention_ia_frequence in ('jamais', 'session', 'chaque_message'));
  end if;
end $$;

-- LA REPRISE. Un espace herite de ce que ses agents faisaient deja, donc rien ne change pour personne.
-- L ordre de « declare le plus » est explicite dans le `case`, pas devine d un tri alphabetique : par ordre
-- alphabetique, `chaque_message` < `jamais` < `session`, c est-a-dire exactement l inverse de ce qu il faut.
insert into tenant_settings (tenant_id, mention_ia_frequence, updated_at)
select a.tenant_id,
       (array_agg(a.mention_ia_frequence order by case a.mention_ia_frequence
          when 'chaque_message' then 0 when 'session' then 1 else 2 end))[1],
       now()
  from agents a
 where a.mention_ia_frequence is not null
 group by a.tenant_id
    on conflict (tenant_id) do update
       set mention_ia_frequence = excluded.mention_ia_frequence,
           updated_at = now()
     -- ⚠️ On n ecrase QUE si personne n a deja regle l espace. La reprise est un rattrapage, pas une remise
     -- a zero : rejouer cette migration apres qu un client a choisi sa politique la lui reprendrait.
     where tenant_settings.mention_ia_frequence is null;
