-- 0227 : l'OAuth ouvert aux autres clients MCP (lot 15, livraison A ; spec
-- docs/superpowers/specs/2026-10-09-oauth-autres-clients-design.md, decisions de Julien du 2026-10-09).
--
-- Jusqu'ici seuls Claude Code et Claude se connectaient (deux client_id recopies dans le code et dans un CHECK). Un
-- autre client se presente desormais par sa FICHE D'IDENTITE (une adresse https, recuperee avec nos gardes) ou par un
-- ENREGISTREMENT DYNAMIQUE (RFC 7591, client_id aleatoire mcl_ suivi de 32 caracteres, garde dans oauth_clients).
--
--  - oauth_clients : les clients enregistres. Aucune cle vers un espace : l'enregistrement est anonyme. Purge par le
--    worker 30 jours apres sa creation si aucune autorisation vivante ne l'utilise.
--  - oauth_autorisations_client_chk : une liste fermee devient un CHECK de FORME (une adresse https, ou mcl_).
--    La longueur se borne par char_length et non par {1,2000} : Postgres refuse une repetition au-dela de 255, et ce
--    refus ne tombe pas a l'application de la migration mais a CHAQUE insertion (vu sur une base jetable).
--  - oauth_autorisations.client_nom, .client_marque, .client_hote : ce que montrent les applications autorisees de la
--    console, ecrit a l'autorisation depuis la demande signee. Nuls pour Claude et Claude Code (leur nom vient du code).
--  - tenants_origine_chk elargi a client_mcp : un espace ne par la connexion d'un autre client (une trace).
--
-- ORDRE : elle AJOUTE et RELACHE ; l'ancien code survit aux quatre (il n'ecrit que les deux client_id de Claude, ne
-- lit pas les colonnes neuves, et ne cree que les origines console et claude_code). Elle passe AVANT le up de l'API.
set local lock_timeout = '5s';

create table if not exists oauth_clients (
  client_id text primary key,
  nom text,
  adresses_de_retour text[] not null,
  type_application text,
  cree_le timestamptz not null default now(),
  constraint oauth_clients_id_chk check (client_id ~ '^mcl_[A-Za-z0-9]{32}$'),
  constraint oauth_clients_adresses_chk check (cardinality(adresses_de_retour) between 1 and 10),
  constraint oauth_clients_nom_chk check (nom is null or char_length(nom) between 1 and 100),
  constraint oauth_clients_type_chk check (type_application is null or type_application in ('web', 'native'))
);

alter table oauth_autorisations drop constraint if exists oauth_autorisations_client_chk;
alter table oauth_autorisations add constraint oauth_autorisations_client_chk
  check ((client_id ~ '^https://[^[:space:]]+$' and char_length(client_id) <= 2000) or client_id ~ '^mcl_[A-Za-z0-9]{32}$');

alter table oauth_autorisations add column if not exists client_nom text;
alter table oauth_autorisations add column if not exists client_marque text;
alter table oauth_autorisations add column if not exists client_hote text;
alter table oauth_autorisations drop constraint if exists oauth_autorisations_marque_chk;
alter table oauth_autorisations add constraint oauth_autorisations_marque_chk
  check (client_marque is null or client_marque in ('domaine', 'declaree'));

alter table tenants drop constraint if exists tenants_origine_chk;
alter table tenants add constraint tenants_origine_chk check (origine in ('console', 'claude_code', 'client_mcp'));
