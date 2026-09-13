-- 0138 : QUAND un contact s'est désabonné.
--
-- 🔴 UN OPT-OUT NE SE DEVINE JAMAIS EN SILENCE, et c'est un sujet de conformité, pas de confort. Le dépôt
-- savait déjà QUI l'avait posé (`contacts.opt_in_source` : 'crm', 'scenario', 'flow', 'webhook:<nom>'), et
-- ne savait PAS quand. `updated_at` ne répond pas à la question : il bouge à la moindre modification de la
-- fiche, si bien qu'un contact désabonné en mars et renommé hier paraîtrait s'être désabonné hier. Afficher
-- cette date dans un centre de conformité aurait été pire que de n'en afficher aucune.
--
-- ⚠️ NULLABLE, ET LES LIGNES EXISTANTES RESTENT À NULL. On ne peut pas reconstituer une date qu'on n'a
-- jamais écrite, et la fabriquer depuis `updated_at` serait exactement le mensonge que cette colonne existe
-- pour éviter. L'écran dit « date inconnue » pour ces lignes-là, ce qui est la vérité.
--
-- ⚠️ ELLE SE REMET À NULL SUR UN RETOUR À `opted_in` : la colonne répond à « depuis quand est-il
-- désabonné ? », pas à « quand l'a-t-il été la dernière fois ? ». Garder une date sur un contact réabonné
-- ferait apparaître un refus là où il n'y en a plus.
--
-- ⚠️ MIGRATION QUI AJOUTE UNE COLONNE ÉCRITE PAR LE CODE : elle passe AVANT le déploiement. L'ancien code y
-- survit sans rien faire (il ne l'écrit pas, il ne la lit pas).

alter table contacts add column if not exists opt_out_at timestamptz;

-- L'écran du centre de sécurité liste les désabonnés d'un espace, du plus récent au plus ancien. Index
-- PARTIEL : il ne porte que les lignes `opted_out`, qui sont une petite minorité des contacts. Un index
-- complet aurait coûté sa taille sur toute la table pour servir une page consultée de temps en temps.
create index if not exists contacts_opted_out_idx
  on contacts (tenant_id, opt_out_at desc)
  where opt_in_status = 'opted_out' and deleted_at is null;
