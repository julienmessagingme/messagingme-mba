-- 0238 : la mediatheque accepte la video MP4 et le PDF (spec docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md, lot C).
--
-- Le CHECK cree en ligne par 0081 s'appelle rcs_media_mime_check : nom LU en base le 2026-10-15 (pg_constraint), pas
-- devine. Un nom devine laisserait l'ancienne contrainte en place, en silence, et chaque depot d'une video echouerait.
--
-- Elargir un CHECK se fait AVANT le code qui ecrit les nouveaux types : l'ancien code n'ecrit que des images, il survit.
-- Le type reste celui DEDUIT de la signature du fichier (src/medias/fichier.ts), jamais celui annonce par le navigateur.
set local lock_timeout = '5s';
alter table rcs_media drop constraint if exists rcs_media_mime_check;
alter table rcs_media add constraint rcs_media_mime_check
  check (mime in ('image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'application/pdf'));
