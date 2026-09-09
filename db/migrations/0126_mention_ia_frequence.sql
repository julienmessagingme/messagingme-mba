-- 0126_mention_ia_frequence.sql : ANNONCER qu on est une IA devient un REGLAGE, plus une consigne au modele.
--
-- Demande de Julien du 2026-09-09, apres la revue de l agent : « par principe non, on ne demande pas a l IA
-- de dire systematiquement je suis une IA. Dans le questionnement pour construire le bot, deux questions :
-- dois-je dire que je suis une IA, et est-ce que ca apparait a chaque fois ou une fois par session. »
--
-- 🔴 CE QUE LA REVUE A TROUVE, ET QUI RENDAIT LE REGLAGE IMPOSSIBLE. La mention etait obtenue en DEMANDANT au
-- modele de la dire : « Au tout premier message d une conversation, tu annonces que tu es une IA. » Deux
-- consequences, et la seconde est la vraie :
--   1. rien ne garantissait qu elle parte. Un modele peut l oublier, la paraphraser, ou en etre detourne par
--      un message du client ;
--   2. surtout, « le tout premier message d une conversation » est une notion que le MODELE devait deviner
--      depuis un transcript. Il ne sait pas ou commence une session. Un reglage « une fois par session »
--      pose sur cette base n aurait donc jamais pu etre tenu.
-- Desormais c est le CODE qui choisit l instruction avant l appel : dire la phrase maintenant, ou ne rien
-- dire. Le modele n a plus de decision a prendre, seulement une consigne sans ambiguite.
--
-- 🔴 UNE COLONNE AVEC CONTRAINTE, PAS UNE CLE DANS LE JSONB DE LA FICHE. Le jsonb porte ce que l agent DIT
-- (ton, objectif, regles d arret) ; celui-ci est un reglage a portee LEGALE (AI Act, article 50 : informer
-- quand ce n est pas evident du contexte, obligation qui pese sur la marque deployante). Il doit pouvoir se
-- demander en SQL (« quels espaces ont coupe l annonce ? »), et une valeur inattendue doit etre refusee par
-- la base, pas seulement par un schema applicatif.
--
-- DEFAUT `session`, tranche par Julien : la plus prudente des deux options qu il propose, et celle qui ne
-- change RIEN pour les agents existants (aujourd hui la consigne visait deja le premier message). `jamais`
-- reste un choix explicite du client, jamais un defaut qu on lui aurait pose sans qu il le sache.
--
-- NON BLOQUANTE : le code lit la colonne en tolerant son absence (repli sur `session`, donc le comportement
-- d avant). Elle passe AVANT le deploiement parce que la lecture de fiche l attend.

alter table agents
  add column if not exists mention_ia_frequence text not null default 'session';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_mention_ia_frequence_check'
  ) then
    alter table agents
      add constraint agents_mention_ia_frequence_check
      check (mention_ia_frequence in ('jamais', 'session', 'chaque_message'));
  end if;
end $$;
