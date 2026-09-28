-- 0185_verrous_courts.sql : les verrous courts, partagés par toutes les copies de l'API.
--
-- POURQUOI. L'API va tourner en plusieurs copies derrière un répartiteur. Deux gardes vivaient dans la mémoire du
-- processus et deviennent fausses dès la deuxième copie : l'anti-rejeu des gestes d'envoi de l'agent de Meta (un
-- rappel de l'outil qui tombe sur une autre copie renvoie un template ou un scénario, facturé) et le verrou de
-- publication du relais (deux publications simultanées se révoquent l'une l'autre la clé du relais). Elles
-- passent ici, sur le modèle de campaign_run_locks (0089).
--
-- LA PRISE est une seule instruction : insert ... on conflict (cle) do update ... where expire_le <= now()
-- returning. Une clé dont l'échéance court ne rend aucune ligne, une clé échue est reprise. Plusieurs clés se
-- prennent dans une transaction, toutes ou aucune, dans l'ordre de la clé (deux prises croisées ne s'interbloquent
-- pas).
--
-- LE JETON est un jeton de garde : une prise ne relâche que les clés qui portent encore le sien. Sans lui, le
-- porteur d'une prise échue effacerait celle de la copie qui l'a reprise.
--
-- L'ÉCHÉANCE est le bail : une copie tuée en pleine prise libère la clé à l'échéance au lieu de la garder pour
-- toujours. L'heure est celle de la base, la même pour toutes les copies.
--
-- AUCUN INDEX sur l'échéance, délibérément : la seule requête qui la lit sans la clé est la purge du worker (toutes
-- les six heures, lignes échues seulement), sur une table qui reste petite ; un index serait payé à chaque prise.
--
-- ADDITIVE (une table neuve que l'ancien code ignore) : elle passe AVANT le déploiement du code qui l'écrit.
create table if not exists verrous_courts (
  cle       text primary key,
  jeton     text not null,
  expire_le timestamptz not null
);
