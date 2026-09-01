-- migrate: no-transaction
--
-- 0096_index_chemins_chauds.sql — les index des deux chemins les plus chauds (programme II, lot 1).
--
-- 🔴 HORS TRANSACTION, et c'est la première migration du dépôt à l'être : `CREATE INDEX CONCURRENTLY` est
-- interdit dans un bloc de transaction. Chaque instruction ci-dessous est donc idempotente, parce qu'un échec
-- à mi-parcours n'annule rien et que la migration sera REJOUÉE depuis le début (cf. `db/migrate.ts`).
--
-- ⚠️ CE QUE CETTE MIGRATION NE CHANGE PAS AUJOURD'HUI. Mesuré le 2026-09-01 sur la production : 12 contacts,
-- 51 destinataires de campagne. À cette taille Postgres préfère un seq scan et IGNORERA ces index, à raison.
-- On les pose à froid, exactement pour la raison que Julien a donnée le 2026-08-31 à propos du quota par
-- numéro : construire un index d'expression sur une table de plusieurs millions de lignes, sous charge, est
-- une opération à cœur ouvert. Ici elle coûte quelques millisecondes.
--
-- ⚠️ CE QUE ÇA CHANGERA. Mesuré le 2026-09-01 dans un Postgres 16 jetable, 200 000 lignes, plans réels :
--   - résolution `wa_id` -> contact : 54,96 ms -> 0,20 ms (270x). Le plan passe d'un balayage qui écarte
--     40 000 lignes à un BitmapOr des trois branches, chacune sur son index.
--   - `reclaimStale` : 16,01 ms -> 0,17 ms (94x). Seq scan parallèle -> Index Scan.
--   - le préfixe téléphone du mini-CRM : Index Scan, y compris en plan GÉNÉRIQUE (paramètre lié).

-- 1) La branche « chiffres nus » du prédicat de routage des entrants (`matchWaIdPredicat`). Elle est
-- NON INDEXABLE telle quelle : sans index d'expression, aucun index ne peut la servir, quelle que soit la
-- taille de la table. C'est le seul des trois index qui débloque quelque chose d'impossible, et pas seulement
-- de lent.
--
-- 🔴 L'EXPRESSION DOIT ÊTRE ÉCRITE À L'IDENTIQUE dans la requête, sinon l'index est payé à chaque écriture et
-- jamais lu. La requête vient d'UN seul endroit (`matchWaIdPredicat`, src/crm/contact-store.pg.ts) et
-- `tests/integration/schema-indexes.integration.test.ts` vérifie que le planificateur le CHOISIT vraiment.
create index concurrently if not exists contacts_tenant_waid_digits_idx
  on contacts (tenant_id, regexp_replace(phone_e164, '[^0-9]', '', 'g'));

-- 2) Le préfixe téléphone du mini-CRM et de la source de campagne (`phone_e164 like '+336%'`).
--
-- 🔴 `text_pattern_ops` est TOUT le sujet. Le code affirmait en commentaire que le `like` ancré « utilise
-- l'index unique sur phone_e164 » : c'est FAUX hors collation C, et la mesure du 2026-09-01 sur la production
-- le montre (le `like` y apparaît en Filter, jamais en Index Cond). Un btree ordinaire ordonne selon la
-- collation, pas octet par octet, donc il ne sait pas borner un préfixe.
--
-- Partiel `where deleted_at is null` : les fiches supprimées ne sont jamais listées, et l'index sert AUSSI la
-- branche « égalité » du prédicat de routage, où il s'est révélé plus sélectif que l'unique existant.
create index concurrently if not exists contacts_tenant_phone_prefix_idx
  on contacts (tenant_id, phone_e164 text_pattern_ops) where deleted_at is null;

-- 3) La récupération des destinataires bloqués en `sending` (`reclaimStale`), qui balaye la table entière
-- toutes les 5 minutes. Index PARTIEL : `sending` est un état transitoire, donc l'index reste minuscule par
-- construction, quelle que soit la taille de la table.
create index concurrently if not exists campaign_recipients_stale_idx
  on campaign_recipients (claimed_at) where status = 'sending';

-- ⚠️ CE QU'ON NE POSE PAS, ET POURQUOI. L'audit du 25 août réclame aussi un index pour le `NOT EXISTS`
-- corrélé du funnel de campagne (`src/stats/store.pg.ts`). Le banc du 2026-09-01 dit non : avec un index sur
-- `(to_e164, sent_at)`, le plan ne change pas et le temps non plus (186 ms -> 184 ms). Postgres a raison, un
-- Hash Anti Join complet bat 200 000 remontées d'index. Le coût du funnel est ailleurs (il recalcule tout à
-- chaque affichage), c'est le lot 6. Poser un index « au cas où » se paie à chaque écriture.
