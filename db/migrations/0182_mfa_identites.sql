-- 0182_mfa_identites.sql : le second facteur des administrateurs d'espace (TOTP et codes de secours).
--
-- POURQUOI SUR identities ET PAS SUR users. Le facteur appartient a la PERSONNE, comme son mot de passe (0072) :
-- une adresse, un mot de passe, un facteur, quel que soit le nombre d'espaces. Une personne admin dans deux
-- espaces s'enrole une fois ; un facteur par compte lui demanderait deux applications et deux lots de codes.
--
-- Les deux secrets sont CHIFFRES (AES-256-GCM, ENCRYPTION_KEY, meme format v1 que les autres secrets). Les codes
-- de secours ne sont jamais stockes en clair : seulement leur empreinte SHA-256, et leur consommation est un
-- update conditionnel sur (identity_id, code_hash), donc atomique.
--
-- ADDITIVE, nullable, SANS defaut : null veut dire « aucun facteur », l'etat de tout le monde aujourd'hui.
-- Elle passe AVANT le deploiement du code : la connexion par mot de passe lit mfa_active_le.

alter table identities add column if not exists mfa_secret_enc text;
alter table identities add column if not exists mfa_active_le timestamptz;
-- Le dernier pas TOTP accepte : un code du meme pas ou d'un pas anterieur est refuse (anti-rejeu).
alter table identities add column if not exists mfa_dernier_pas bigint;
-- Le secret pendant l'enrolement, tant que le premier code n'a pas ete saisi.
alter table identities add column if not exists mfa_secret_attente_enc text;

create table if not exists mfa_codes_secours (
  identity_id uuid not null references identities (id) on delete cascade,
  code_hash   text not null,
  utilise_le  timestamptz,
  primary key (identity_id, code_hash)
);
