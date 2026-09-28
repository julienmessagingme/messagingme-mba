-- 0189 : archiver une publicité, pour la ranger hors de la liste (une création échouée surtout).
-- Additive : l'ancien code ignore la colonne, elle passe AVANT le déploiement. Nullable, SANS défaut : null veut
-- dire « pas archivée ». L'archivage est un rangement d'écran : le routage d'un lead, le suivi et l'entonnoir ne la
-- lisent pas.
alter table publicites add column if not exists archivee_le timestamptz;
