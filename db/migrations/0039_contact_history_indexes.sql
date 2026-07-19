-- 0039_contact_history_indexes.sql — index de l'onglet Historique de la fiche contact.
--
-- `campaign_recipients` n'avait AUCUN index utilisable pour « where contact_id = $1 » : l'unique
-- (campaign_id, contact_id) porte campaign_id en tête, et les autres index sont partiels (pending,
-- message_id, error_code). L'historique d'un contact aurait donc fait un seq scan de la plus grosse table
-- du schéma, à chaque ouverture d'une fiche. `conversations` n'avait rien non plus sur contact_id, son seul
-- unique étant (tenant_id, wa_id).
--
-- ADD-only, ordre de déploiement normal.
-- ⚠️ Montée en charge : sur une grosse table il faudra passer en `create index concurrently` HORS transaction
-- de migration (cf. 0032). Ici les tables sont petites (pilote), l'index en ligne est indolore.
create index if not exists campaign_recipients_contact_idx
  on campaign_recipients (contact_id, sent_at desc);

create index if not exists conversations_contact_idx
  on conversations (contact_id) where contact_id is not null;
