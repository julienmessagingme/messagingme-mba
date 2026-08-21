-- 0072 : une adresse mail, un mot de passe, PLUSIEURS espaces.
--
-- ⚠️ Cette migration revient sur une décision prise en connaissance de cause. La migration 0010 disait :
-- « Login = un email = un compte : unicité GLOBALE […] Rend findByEmail déterministe : plus de "même email
-- dans deux tenants" à départager par ORDER BY. » Le problème qu'on rouvre est donc celui qu'on avait fermé,
-- et la réponse à « lequel ouvre-t-on ? » est désormais explicite : on DEMANDE, via un écran de choix.
--
-- Pourquoi une table `identities` plutôt que de dupliquer le hash sur chaque compte : l'invariant voulu est
-- « une adresse = UN mot de passe ». Une table l'EXPRIME (une ligne par adresse) ; le dupliquer sur N lignes
-- ne ferait que le simuler, et produirait tôt ou tard le bug « mon mot de passe marche sur un compte et pas
-- sur l'autre », qui est indébogable pour l'utilisateur.
--
-- ADDITIVE et SANS effet : elle ne retire pas l'index d'unicité (migration 0073) et ne touche pas
-- `users.password_hash`, qui reste en place le temps de la transition. Tant que 0073 n'est pas appliquée,
-- le comportement est strictement inchangé, et revenir en arrière ne demande qu'à ignorer ces colonnes.
create table if not exists identities (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  -- `null` = identité créée par invitation, dont le mot de passe n'a pas encore été choisi. Un compte sans
  -- mot de passe ne peut pas se connecter : c'est déjà la règle aujourd'hui (`password_hash is null`).
  password_hash text,
  created_at    timestamptz not null default now()
);

-- L'unicité vit désormais ICI, sur l'adresse, et non plus sur le compte : c'est exactement le déplacement
-- que fait cette migration. Insensible à la casse, comme l'index qu'elle remplace.
create unique index if not exists identities_email_lower_unique on identities (lower(email));

-- Reprise des comptes existants. `distinct on (lower(email))` est ici une PRÉCAUTION et non un besoin :
-- l'index unique de 0010 garantit qu'il n'y a pas de doublon aujourd'hui. Il protège le cas où cette
-- migration serait rejouée après que 0073 a ouvert la porte aux doublons.
insert into identities (email, password_hash, created_at)
select distinct on (lower(u.email)) u.email, u.password_hash, u.created_at
  from users u
 order by lower(u.email), (u.password_hash is null), u.created_at
on conflict do nothing;

alter table users add column if not exists identity_id uuid references identities (id) on delete restrict;

update users u set identity_id = i.id
  from identities i
 where lower(i.email) = lower(u.email) and u.identity_id is null;

-- Retrouver les comptes d'une adresse après la saisie du mot de passe : c'est la requête du nouvel écran
-- de choix, faite à chaque connexion.
create index if not exists users_identity_idx on users (identity_id);
