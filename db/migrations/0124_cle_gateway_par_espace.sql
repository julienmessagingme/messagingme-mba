-- 0124_cle_gateway_par_espace.sql : une cle AI Gateway PAR ESPACE, provisionnee chez Vercel.
--
-- Demande de Julien du 2026-09-09 : « creer automatiquement une cle API dans Vercel lorsque le client cree
-- un agent IA, pas la peine de la creer avant ». Objectif : que la depense de modele soit attribuee au
-- client qui la fait, au lieu de tomber dans un pot commun ou plus rien n est separable.
--
-- 🔴 UNE LIGNE PAR ESPACE, PAS PAR AGENT, et la cle primaire le FAIT RESPECTER. Un espace peut avoir
-- plusieurs agents ; ils puisent tous dans le meme credit prepaye (`agent_credits`), donc ils partagent une
-- seule cle. La cle primaire sur `tenant_id` rend le provisionnement IDEMPOTENT sans verrou applicatif :
-- deux creations d agent simultanees ne peuvent pas produire deux cles Vercel, la seconde entre en conflit
-- et relit celle qui existe. Sans cette contrainte, la course serait invisible (deux cles valides, l une
-- orpheline, facturees toutes les deux).
--
-- 🔴 LE SECRET EST CHIFFRE AU REPOS, format `v1.<iv>.<tag>.<data>` de `src/crypto/secretbox.ts` (AES-256-GCM,
-- ENCRYPTION_KEY). C est le meme traitement que les tokens business Embedded Signup et que les secrets
-- Channels Me : un secret de plus en clair dans cette base rendrait discutable le chiffrement des autres.
-- ⚠️ `cle_id` n est PAS un secret : c est l identifiant Vercel de la cle, indispensable pour bouger son
-- plafond ou la revoquer, et Vercel ne rend le secret QU UNE FOIS, a la creation. Perdre `cle_id` rendrait
-- la cle impossible a piloter tout en la laissant facturer.
--
-- 🔴 `plafond_micro_eur` EST CE QU ON A DIT A VERCEL, pas le solde. Les deux se ressemblent et se separent
-- des le premier debit : le solde DESCEND a chaque appel de modele, le plafond ne bouge QU AU RECHARGEMENT.
-- Les confondre ferait un appel a Vercel par tour d agent, pour un plafond qui n a pas change.
-- Le plafond suit la regle tranchee par Julien le 2026-09-09 : « c est bien le credit achete ». Il vaut donc
-- le credit, jamais un nombre que le client saisit, sans quoi il suffirait d y taper 10 000 pour vider le
-- pot commun.
--
-- NON BLOQUANTE dans l autre sens : le code lit la cle en TOLERANT son absence (l espace retombe alors sur
-- la cle maison, exactement comme un espace RCS sans cle propre). Elle passe AVANT le deploiement parce que
-- la route de creation d agent l ecrit.

create table if not exists agent_gateway_keys (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  -- Identifiant Vercel (`key_...`), en clair : sert a piloter le plafond et a revoquer.
  cle_id text not null,
  -- Le secret lui-meme, chiffre. Jamais journalise, jamais rendu au client.
  cle_chiffree text not null,
  -- Dernier plafond POSE chez Vercel, en micro-euros, pour n appeler Vercel que quand il change.
  plafond_micro_eur bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pas d index supplementaire : la seule lecture est « la cle de CET espace », que la cle primaire sert deja.
-- Un index sur `cle_id` serait du poids en ecriture pour une requete que personne n ecrit.
