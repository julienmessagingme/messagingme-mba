-- 0123_conversation_signalee_main.sql : signaler une conversation A LA MAIN, sans ecraser le constat de l IA.
--
-- Demande de Julien du 2026-09-09 : depuis la conversation ouverte, pouvoir la ranger dans n importe quel
-- dossier, et pas seulement dans les archivees.
--
-- 🔴 POURQUOI UNE COLONNE A PART, ET PAS `conversation_analysis.abusive`. Ce champ-la est un CONSTAT pose par
-- un MODELE (il repere une injure dans un fil clos) ; le signalement demande ici est une DECISION HUMAINE.
-- Les ecrire au meme endroit couterait trois choses, toutes silencieuses :
--   1. on ne saurait plus si un signalement vient d un humain ou d un modele, alors que ca change tout ce
--      qu on en fait (un constat s explique au client, une decision s assume) ;
--   2. une RE-ANALYSE de la conversation ecraserait le signalement manuel, `abusive` etant recalcule a
--      chaque passage. Un operateur verrait son signalement disparaitre sans cause visible ;
--   3. c est exactement la separation que le depot fait deja tenir entre `conversation_analysis.abusive`
--      (constat, ne declenche rien) et `contacts.blocked_at` (decision, a des effets). La casser ici la
--      rendrait discutable la-bas.
-- Le dossier « Signale » montre donc l UNION des deux sources, et chacune reste lisible pour elle-meme.
--
-- UN HORODATAGE PORTE L ETAT, pas un booleen : « depuis quand » se posera (trier, purger), et c est le meme
-- choix que `archived_at` en 0120. L AUTEUR est une colonne separee et NULLABLE : `on delete set null` fait
-- disparaitre le nom d un collaborateur parti sans effacer le signalement lui-meme. Confondre les deux
-- ferait qu un depart d equipe designalerait des conversations.
--
-- NON BLOQUANTE : le code lit `signalee_le` en le tolerant absent (l union retombe alors sur le seul constat
-- de l analyse), donc l ordre migration/deploiement est libre. Elle est passee AVANT par prudence, la
-- requete du dossier etant sur le chemin d affichage de l Inbox.

alter table conversations
  add column if not exists signalee_le timestamptz;

alter table conversations
  add column if not exists signalee_par uuid references users(id) on delete set null;

-- Index PARTIEL sur les seules signalees a la main : elles sont rarissimes par rapport au reste de la table,
-- et le dossier « Signale » est le seul a les lire. Meme raisonnement que `conversations_archivees_idx`
-- (0120) : servir la requete rare sans alourdir les quatre dossiers qui lisent l inverse.
create index if not exists conversations_signalees_main_idx
  on conversations (tenant_id, signalee_le desc)
  where signalee_le is not null;
