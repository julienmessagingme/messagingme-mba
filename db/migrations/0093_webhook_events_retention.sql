-- 0093_webhook_events_retention.sql — rendre `webhook_events` purgeable et attribuable (PLAN.md 5.2).
--
-- Cette table garde le payload COMPLET de chaque événement Meta reçu depuis le premier jour : le texte des
-- messages entrants et le numéro de la personne qui écrit. Elle n'avait aucune purge, aucun index de date, et
-- surtout aucun discriminant d'espace : impossible de dire à qui appartenait une ligne, donc impossible de
-- l'effacer sur demande. Elle était la dernière table du dépôt à garder une trace nominative hors de portée
-- de la purge par contact.
--
-- 🔴 Le discriminant est la partie qui NE SE RATTRAPE PAS. Une ligne écrite sans lui ne pourra jamais être
-- attribuée après coup : le payload de Meta ne porte pas d'identifiant d'espace, seulement le numéro
-- destinataire. D'où cette colonne posée AVANT que la table grossisse, alimentée par
-- `value.metadata.phone_number_id`, que `phone_numbers` rattache à son espace.
alter table webhook_events add column if not exists phone_number_id text;

-- La purge par rétention balaie sur la date : sans index, elle scanne toute la table à chaque passage.
create index if not exists webhook_events_received_idx on webhook_events (received_at);

-- L'effacement par ESPACE (jointure sur phone_numbers) passe par là. Les lignes d'avant cette migration ont
-- la colonne à null : elles ne sont attribuables à personne, et c'est la rétention qui s'en occupe.
create index if not exists webhook_events_phone_idx on webhook_events (phone_number_id)
  where phone_number_id is not null;
