-- 0247 : la filiere « application WhatsApp Business », lot 1 (spec docs/superpowers/specs/2026-10-22-filiere-application-
-- whatsapp-design.md, plan docs/superpowers/plans/2026-10-22-filiere-application-lot-1.md).
--
-- Un espace sans compte Meta Business relie le compte de l application WhatsApp Business de son telephone, comme un
-- appareil lie (QR code). Le service de connexions (mba-application) tient la session et ecrit ici.
--
-- 🔴 UNE TABLE A PART, PAS phone_numbers : phone_numbers.id EST le phone_number_id de Meta, et chaque chemin qui appelle
-- Graph le lit comme tel. Un compte de l application dans phone_numbers serait envoye a Graph sous un faux identifiant ;
-- ici, un lecteur oublie ne voit simplement pas le numero (echoue ferme).
--
-- comptes_application : un par espace (tenant_id unique, une filiere et un numero par espace). numero : les chiffres,
--   indicatif compris. Un numero n est tenu que par UN compte vivant (index unique partiel) : banni ou retire, il se
--   libere pour un autre espace. statut : en_attente (QR pas encore scanne), relie, sommeil (30 jours sans message,
--   coupe par nous et dit), banni (WhatsApp a coupe le numero, 403), deconnecte (l appareil retire depuis le telephone,
--   401), retire (nous avons retire l appareil, fin d abonnement). fourni_id : le numero de la reserve, pour un numero
--   fourni.
-- comptes_application_auth : l etat d authentification de la session (cles de Signal), une ligne par cle, chiffre par
--   ENCRYPTION_KEY (src/crypto/secretbox.ts). Part avec son compte.
--
-- Tables neuves que l ancien code ne lit pas : elles passent AVANT le code. Leurs cles etrangeres prennent un verrou
-- SHARE ROW EXCLUSIVE sur tenants (chemin chaud) et numeros_fournis : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

create table if not exists comptes_application (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null unique references tenants(id) on delete cascade,
  numero              text not null check (numero ~ '^[0-9]{8,15}$'),
  jid                 text check (jid is null or char_length(jid) <= 120),
  statut              text not null default 'en_attente' check (statut in ('en_attente', 'relie', 'sommeil', 'banni', 'deconnecte', 'retire')),
  fourni_id           uuid references numeros_fournis(id) on delete set null,
  relie_le            timestamptz,
  dernier_message_le  timestamptz,
  statut_change_le    timestamptz not null default now(),
  cree_le             timestamptz not null default now()
);

create unique index if not exists comptes_application_numero_vivant_uidx
  on comptes_application (numero) where statut not in ('banni', 'retire');

create table if not exists comptes_application_auth (
  compte_id  uuid not null references comptes_application(id) on delete cascade,
  cle        text not null check (char_length(cle) between 1 and 200),
  valeur     text not null,
  primary key (compte_id, cle)
);
