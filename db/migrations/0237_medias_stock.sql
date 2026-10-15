-- 0237 : le stock de la mediatheque (spec docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md, lot B).
--
-- La table garde son nom historique, rcs_media, alors que WhatsApp s'en sert aussi : la renommer toucherait le store,
-- la carte de /ops, la suppression d'un espace et les tests d'integration sans rien apporter.
--
-- supprime_le : la suppression est DOUCE pendant 30 jours. Le fichier sort tout de suite de la mediatheque et ne
-- compte plus dans le quota, mais la route publique /m/ le sert encore : un visuel deja parti en RCS peut etre
-- telecharge tard par l'operateur, et casser une adresse deja distribuee est sans recours. La purge du worker
-- efface la ligne au-dela.
--
-- empreinte : le SHA-256 des octets, en hexadecimal. Deposer a nouveau un fichier identique rend la fiche existante
-- sans rien consommer du quota. Pas d'index UNIQUE : des doublons existent peut-etre deja (la meme image deposee
-- deux fois avant cette migration) et feraient echouer sa creation ; c'est le verrou d'espace du depot qui
-- serialise, et l'index de l'espace (rcs_media_tenant_idx) suffit a la recherche sur une poignee de lignes.
--
-- Les deux colonnes restent NULLABLES : entre cette migration et le deploiement du code, l'ancien code depose encore
-- sans empreinte. Un NOT NULL ici ferait echouer chaque depot pendant cette fenetre.
alter table rcs_media add column if not exists supprime_le timestamptz;
alter table rcs_media add column if not exists empreinte text;

-- Les fichiers deja deposes recoivent leur empreinte, pour qu'un nouveau depot du meme fichier les retrouve.
update rcs_media set empreinte = encode(sha256(bytes), 'hex') where empreinte is null;
