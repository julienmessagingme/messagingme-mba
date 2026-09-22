-- 0163_pubs_capter.sql : lot 1 des publicités Click-to-WhatsApp, « Capter ».
-- Spec : docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md (§ 2).
--
-- AVANT le déploiement : le code neuf écrit dans les deux tables, et la purge RGPD comme le coût des messages
-- les lisent. Déployer d'abord ferait échouer en `42P01` la suppression d'un contact (la purge est une
-- transaction) et les écrans de coût. L'ancien code les ignore : il survit à cette migration.

-- Une ligne par message entrant qui porte un `referral` (le premier message après un clic sur une pub).
-- 🔴 C'est la seule trace de `ctwa_clid` : Meta ne l'envoie qu'une fois, et le corps brut du webhook est
-- purgé à 30 jours (0093).
create table if not exists arrivees_pub (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- ⚠️ La cascade ne joue que pour une suppression RÉELLE de la fiche. La purge RGPD ANONYMISE la fiche
  -- (`PgContactStore.purgeMany`) : c'est elle qui efface `ctwa_clid`, et la ligne reste pour le compte.
  contact_id       uuid not null references contacts(id) on delete cascade,
  -- L'identifiant Meta du message entrant. Unique par espace : un webhook redélivré ne crée pas deux arrivées.
  meta_message_id  text not null,
  -- `referral.source_id` : la pub (ou la publication) cliquée.
  ad_id            text not null,
  source_type      text,
  titre            text,
  url              text,
  -- Parfois VIDE chez Meta : nullable, et jamais une condition.
  ctwa_clid        text,
  -- Arrivé pendant que l'agent de Meta tenait la conversation (`standby`) ? C'est la mesure qui décide si la
  -- reprise à l'arrivée du lot 3 peut marcher.
  en_standby       boolean not null,
  arrivee_le       timestamptz not null default now(),
  constraint arrivees_pub_message_uniq unique (tenant_id, meta_message_id)
);

-- Sert la suppression en cascade d'une fiche, et la qualification du lot 3 (la dernière arrivée d'un contact).
create index if not exists arrivees_pub_contact_idx on arrivees_pub (contact_id, arrivee_le desc);

-- Le tarif que Meta annonce pour chacun de nos messages sortants (objet `pricing` de l'accusé de réception).
-- 🔴 Une table à part plutôt qu'une colonne : nos envois vivent dans DEUX tables (`conversation_messages` et
-- `campaign_recipients`), et le coût lit les deux.
-- ⚠️ AUCUNE PURGE, délibérément : le coût d'un mois passé doit rester le même quel que soit le jour où on le
-- regarde. La ligne part avec l'espace.
create table if not exists tarifs_meta (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- L'identifiant Meta du message sortant (wamid).
  wamid       text not null,
  -- `pricing.type` tel quel : 'regular', 'free_customer_service', 'free_entry_point'...
  type        text not null,
  categorie   text,
  facturable  boolean,
  modele      text,
  recu_le     timestamptz not null default now(),
  primary key (tenant_id, wamid)
);
