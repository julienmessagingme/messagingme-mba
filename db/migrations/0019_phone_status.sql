-- 0019_phone_status.sql — statut de connexion + palier de messagerie par numéro (pull Graph, page Accueil).
-- Nullable = INCONNU (jamais un faux « connecté »). Alimenté par le pull GET /{phone_number_id} au
-- chargement de /accueil ; sert à composer le pastille vert/ambre/rouge/gris du statut compte.
alter table phone_numbers
  add column if not exists status text,               -- CONNECTED / PENDING / FLAGGED / RESTRICTED / ... (Graph), null = inconnu
  add column if not exists messaging_limit_tier text; -- TIER_250 / TIER_1K / TIER_10K / TIER_100K / UNLIMITED, null = inconnu
