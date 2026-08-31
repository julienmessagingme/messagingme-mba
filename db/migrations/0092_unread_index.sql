-- 0092_unread_index.sql — index dédié au calcul des non-lus (AUDIT-SCALE-2026-08-25.md, R7).
--
-- `UNREAD_SQL` (src/inbox/store.pg.ts) demande, pour CHAQUE conversation d'un espace : « existe-t-il un
-- message ENTRANT postérieur à la dernière lecture ? ». L'index historique
-- `conversation_messages_conv_idx (conversation_id, created_at)` sait déjà borner sur la date, mais il
-- rapporte aussi tout ce qui est SORTANT dans cet intervalle, que le moteur doit ensuite écarter ligne à
-- ligne. Sur un contact qui vient de recevoir une campagne, cet intervalle est justement plein de sortants.
--
-- Cet index-ci ne contient que les entrants : la question devient une recherche sur la première ligne de la
-- plage, et le volume de sortants n'y change plus rien. Il ne remplace PAS l'index historique, qui sert au
-- chargement du fil (les deux directions, dans l'ordre).
--
-- ⚠️ Pas de `concurrently` : le runner de migrations enveloppe chaque fichier dans une transaction, ce qui
-- l'interdit. La table est petite (quelques centaines de lignes en production au 2026-08-31), la prise de
-- verrou est instantanée. Si elle grossit d'un ordre de grandeur, créer les prochains index à la main, en
-- `concurrently`, hors du runner.
create index if not exists conversation_messages_unread_idx
  on conversation_messages (conversation_id, created_at)
  where direction = 'in';
