-- 0099_message_origine.sql : d'OU vient un message sortant.
--
-- Demande de Julien du 2026-09-01 : l'ecran quantitatif doit compter les messages de service en trois
-- themes, l'IA, le scripte et l'humain. La reconnaissance a montre que ce n'etait PAS derivable : les
-- envois d'un scenario (`wiring.ts`) et ceux de l'agent IA (`envoyerTexteAgent`) ecrivent tous les deux
-- `type = 'text'` avec `sender_user_id = null`. Seuls l'humain (`sender_user_id`) et l'agent de Meta
-- (`type = 'mba'`) se distinguaient. Il faut donc enregistrer l'origine au moment de l'ecriture.
--
-- NULLABLE, et sans defaut. Un defaut mentirait sur l'historique, et un `not null` ferait echouer une
-- insertion sur le chemin chaud du webhook le jour ou un appelant oublierait de le poser : c'est
-- exactement l'incident du 2026-08-17. La garde contre l'oubli est mise ailleurs, la ou elle ne coute
-- rien en production : le parametre est OBLIGATOIRE dans la signature TypeScript, donc un chemin
-- d'ecriture oublie ne compile pas.
--
-- L'historique se lit par une derivation bornee dans le temps (`src/inbox/origine.ts`), pas par un
-- remplissage : un remplissage aurait fige une deduction dans la base, sans moyen de la distinguer plus
-- tard d'une valeur reellement enregistree.
--
-- 🔴 BLOQUANTE : des le deploiement, les quatre chemins d'ecriture posent cette colonne. La migration
-- passe AVANT (cf. CLAUDE.md, section Deploiement).

alter table conversation_messages add column if not exists origin text
  check (origin in ('humain', 'scenario', 'ia', 'mba', 'campagne'));

-- Index partiel sur les seuls SORTANTS : l'agregat de l'ecran quantitatif ne regarde jamais les entrants
-- (un message recu n'a pas d'origine de ce genre), et la table est dominee par eux.
create index if not exists conversation_messages_origin_idx
  on conversation_messages (conversation_id, created_at)
  where direction = 'out';
