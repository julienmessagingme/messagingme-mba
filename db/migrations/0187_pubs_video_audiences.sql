-- 0187_pubs_video_audiences.sql : la video et les audiences dans les brouillons de publicite.
--
-- POURQUOI. Une publicite Click-to-WhatsApp peut desormais porter une VIDEO au lieu d'une image, et viser les
-- audiences du compte publicitaire (a inclure, a exclure). Le brouillon doit garder les deux, sinon on le rouvre
-- et il manque precisement ce qu'on a mis le plus de temps a preparer.
--
-- LA VIDEO N'EST JAMAIS STOCKEE ICI, seulement son identifiant chez Meta. Elle est deposee chez Meta des qu'elle
-- est choisie (rien n'y est facturable), et ses octets ne transitent par notre API qu'en flux, morceau par
-- morceau. D'ou une colonne DEDIEE, en texte, et pas une valeur de plus dans le CHECK de visuel_type : ce CHECK
-- lie le type a des OCTETS presents, qu'une video n'a pas.
--
-- UN SEUL VISUEL A LA FOIS : une image OU une video. Le store tient cette exclusivite en ecrivant (poser l'une
-- efface l'autre) ; le CHECK en est la ceinture, et il ne refuse rien de ce que l'ancien code ecrit, puisque
-- l'ancien code ne pose jamais de video.
--
-- LES AUDIENCES SONT DES IDENTIFIANTS META, en tableaux de texte, vides par defaut. Pas de table de liaison : ce
-- ne sont pas des objets a nous, et le brouillon ne fait que retenir un choix, relu chez Meta a la creation.
--
-- ADDITIVE : trois colonnes que l'ancien code ignore (deux avec un defaut constant, donc sans reecriture de la
-- table), et un CHECK que toute ligne existante satisfait (video_id y est nul). Elle passe AVANT le deploiement
-- du code qui les ecrit.

alter table pubs_brouillons add column if not exists video_id text;
alter table pubs_brouillons add column if not exists audiences_incluses text[] not null default '{}';
alter table pubs_brouillons add column if not exists audiences_exclues text[] not null default '{}';

alter table pubs_brouillons drop constraint if exists pubs_brouillons_un_visuel_chk;
alter table pubs_brouillons add constraint pubs_brouillons_un_visuel_chk
  check (video_id is null or visuel_octets is null);
