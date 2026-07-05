-- 0004_phone_quality.sql — quality rating par numéro (source de PgQualityProvider).
-- Alimentation par webhook (account/phone_number_quality_update) : à câbler plus tard.

alter table phone_numbers
  add column if not exists quality_rating text not null default 'UNKNOWN'
    check (quality_rating in ('GREEN', 'YELLOW', 'RED', 'UNKNOWN'));
