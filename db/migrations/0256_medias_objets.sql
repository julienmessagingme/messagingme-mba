-- 0256 : les fichiers de la mediatheque sortent de Postgres (lot A, spec docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md).
--
-- La table garde son nom historique, rcs_media, faux depuis que WhatsApp s'en sert : la renommer toucherait le store, la
-- carte de /ops, la suppression d'espace et les tests sans rien apporter.
--
-- AVANT le code, selon la regle du depot (l'ancien code survit-il ?) : relacher bytes et ajouter cle_objet ne gene pas
-- l'ancien code, qui insere toujours bytes et laisse cle_objet nulle, ce que le CHECK accepte. Un fichier est soit EN
-- BASE (bytes), soit AU BUCKET (cle_objet), jamais les deux ni aucun : la recopie pose cle_objet et vide bytes dans la
-- meme instruction. La colonne bytes partira (migration A2) une fois la recopie a zero et plus aucun code pour la lire.
set local lock_timeout = '5s';
alter table rcs_media alter column bytes drop not null;
alter table rcs_media add column if not exists cle_objet text;
alter table rcs_media add constraint rcs_media_bytes_ou_objet check ((bytes is null) <> (cle_objet is null));
