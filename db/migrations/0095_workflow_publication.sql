-- 0095_workflow_publication.sql — brouillon / publié des scénarios (lot 7).
--
-- CE QUI CHANGE. Jusqu'ici, l'éditeur écrivait dans `graph`, et `graph` est ce que l'exécuteur lit : toute
-- retouche partait EN PRODUCTION dans la seconde, y compris pour les contacts déjà en cours de parcours.
-- Désormais l'éditeur écrit `draft_graph`, et `graph` ne bouge QUE sur un clic « Publier ».
--
-- 🔴 POURQUOI `graph` RESTE LE PUBLIÉ, et pourquoi c'est le point important de cette migration. Une bonne
-- douzaine d'endroits lisent `graph` pour EXÉCUTER (exécuteur, campagnes, automations, API publique par code,
-- lien de test, comptage des blocs). Nommer le brouillon `graph` et le publié autrement aurait fait basculer
-- tous ces chemins d'un coup, et le moindre oubli aurait mis un brouillon en ligne sans que rien ne le dise.
-- Dans ce sens-ci, un oubli lit le publié : le pire cas est de ne pas voir une modification, pas d'en envoyer
-- une qui n'était pas prête.
--
-- `draft_graph` NULL = aucun brouillon en attente, le publié fait foi (c'est l'état de TOUTES les lignes
-- existantes au moment de la migration : rien ne change pour elles, ce qui est en ligne y reste).
alter table workflows add column if not exists draft_graph jsonb;

-- Date de la dernière mise en ligne. NULL sur les scénarios antérieurs : on ne l'invente pas à partir de
-- `updated_at`, qui bouge à chaque frappe et daterait la publication d'un brouillon jamais publié.
-- QUI a publié n'est pas ici : c'est le journal d'audit (`audit_log`, action `workflow.published`) qui le
-- porte, comme pour toutes les autres actions humaines de l'espace.
alter table workflows add column if not exists published_at timestamptz;
