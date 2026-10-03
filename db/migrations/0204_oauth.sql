-- 0204_oauth.sql : les autorisations OAuth 2.1 devant le serveur MCP (livraison 2a de
-- docs/superpowers/specs/2026-10-03-oauth-mcp-design.md, decisions de Julien du 2026-10-03).
--
-- Claude (Claude Code, claude.ai) se connecte a /mcp sans cle d'API : la personne s'authentifie, clique
-- "Autoriser" dans un espace ou elle est admin, et Claude recoit un jeton d'acces (mbo_) et un jeton de
-- renouvellement (mbr_). Les cles d'API ne changent pas.
--
-- UNE AUTORISATION = UN PASSAGE DANS LE CONSENTEMENT, POUR UN SEUL ESPACE. Elle porte une seule paire de jetons
-- vivante, remplacee a chaque renouvellement : pas de table de jetons. Deux Claude Code sur deux machines font
-- deux lignes, listees et revocables separement.
--
-- 🔴 SEULES LES EMPREINTES SHA-256 SONT STOCKEES, comme api_keys.key_hash (0035) : un jeton, un code ou un
-- code_verifier n'entre jamais en base, ni dans un journal.
--
-- 🔴 LE JETON DE RENOUVELLEMENT PRECEDENT EST GARDE, et c'est ce qui detecte la fuite (RFC 9700 4.14) : un
-- ancien jeton presente une seconde fois revoque toute l'autorisation (PgOauthStore.renouveler).
--
-- LES CLES ETRANGERES. tenant_id et user_id en cascade : la suppression d'un compte (PgUserStore.deleteUser
-- exige un "on delete" sur toute cle vers users) ou d'un espace revoque ses autorisations. Le role et la
-- desactivation ne sont PAS recopies ici : ils sont relus dans users a chaque appel (resoudreAcces), donc un
-- compte retrograde ou desactive perd l'acces a l'appel suivant.
--
-- Ni adresse IP ni user-agent : la seule donnee personnelle est le lien vers le compte, et des dates. La purge
-- (PgOauthStore.purger, worker) efface les codes echus et les autorisations mortes depuis 30 jours.
--
-- TRANSACTIONNELLE : deux tables neuves et vides, leurs index crees dans la meme transaction, ne bloquent
-- l'ecriture de personne. ADDITIVE : l'ancien code les ignore. Le code neuf les lit sur /mcp (la garde nomme
-- oauth_autorisations pour tout jeton mbo_) et les ecrit au consentement : elle passe AVANT le deploiement.
create table if not exists oauth_autorisations (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id) on delete cascade,
  user_id                 uuid not null references users(id) on delete cascade,
  -- La fiche d'identite du client (Client ID Metadata Document), l'une des deux recopiees dans
  -- src/oauth/clients.ts. Un troisieme client demandera une migration, et c'est voulu : la liste est fermee.
  client_id               text not null,
  -- Les droits accordes, sous-ensemble non vide des deux droits MCP. Jamais un droit de /v1 ni du relais :
  -- c'est ce qui cantonne un jeton OAuth a /mcp, sans code dans les routes /v1 (requireScope les refuse).
  scopes                  text[] not null,
  -- L'adresse de la ressource pour laquelle le jeton a ete emis (RFC 8707), PUBLIC_API_URL suivie de /mcp.
  resource                text not null,
  -- Le jeton d'acces en cours (1 h) et son echeance. Nuls tant que le code n'a pas ete echange.
  acces_hash              text,
  acces_expire_le         timestamptz,
  -- Le jeton de renouvellement en cours, le precedent (pour reconnaitre un rejeu), et ses deux echeances :
  -- 30 jours sans usage (refresh_expire_le, repoussee a chaque renouvellement) et 90 jours au plus apres
  -- l'autorisation (refresh_max_le, fixe).
  refresh_hash            text,
  refresh_precedent_hash  text,
  refresh_expire_le       timestamptz,
  refresh_max_le          timestamptz,
  cree_le                 timestamptz not null default now(),
  -- Ecrit au plus une fois par minute par la garde : une ecriture par appel serait payee sur le chemin chaud.
  dernier_usage_le        timestamptz,
  -- Non nul = revoquee (par un admin, par le client, ou par un rejeu). Jamais remise a null.
  revoque_le              timestamptz,

  constraint oauth_autorisations_client_chk
    check (client_id in (
      'https://claude.ai/oauth/claude-code-client-metadata',
      'https://claude.ai/oauth/mcp-oauth-client-metadata'
    )),
  -- "<@" refuse aussi un element nul (un nul n'est egal a rien), et cardinality ferme le tableau vide, qu'un
  -- "<@" seul accepterait.
  constraint oauth_autorisations_scopes_chk
    check (cardinality(scopes) > 0 and scopes <@ array['mcp:read', 'mcp:write']::text[])
);

-- La garde de /mcp retrouve l'autorisation par l'empreinte du jeton d'acces, a chaque appel. Partiels : une
-- autorisation dont le code n'a pas encore ete echange n'a pas de jeton.
create unique index if not exists oauth_autorisations_acces_uidx
  on oauth_autorisations (acces_hash) where acces_hash is not null;
create unique index if not exists oauth_autorisations_refresh_uidx
  on oauth_autorisations (refresh_hash) where refresh_hash is not null;
-- Le rejeu : "cette empreinte est-elle celle du jeton qu'on vient de remplacer ?". Pas unique : rien ne
-- l'impose, et un doublon ferait echouer un renouvellement pour une ligne de detection.
create index if not exists oauth_autorisations_refresh_precedent_idx
  on oauth_autorisations (refresh_precedent_hash) where refresh_precedent_hash is not null;
-- La liste de la console ("Applications autorisees"), par espace, la plus recente d'abord.
create index if not exists oauth_autorisations_espace_idx
  on oauth_autorisations (tenant_id, cree_le desc);
-- La cascade depuis users : sans index, chaque suppression de compte parcourrait la table (comme 0042 l'a fait
-- pour les autres cles vers users).
create index if not exists oauth_autorisations_user_idx
  on oauth_autorisations (user_id);

-- Les codes de retour : 60 secondes, a usage unique. La consommation est un update conditionnel
-- (utilise_le is null and expire_le > now()), donc deux echanges simultanes du meme code n'en font gagner qu'un.
create table if not exists oauth_codes (
  -- L'empreinte du code (mbc_), jamais le code.
  hash             text primary key,
  autorisation_id  uuid not null references oauth_autorisations(id) on delete cascade,
  -- Le defi PKCE (S256) et l'adresse de retour de la demande : l'echange doit presenter le verificateur et la
  -- MEME adresse.
  code_challenge   text not null,
  redirect_uri     text not null,
  expire_le        timestamptz not null,
  utilise_le       timestamptz
);
-- La cascade depuis oauth_autorisations (revocation purgee, suppression de compte) : sans index, chaque
-- autorisation effacee parcourrait la table des codes.
create index if not exists oauth_codes_autorisation_idx
  on oauth_codes (autorisation_id);
