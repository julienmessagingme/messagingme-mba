-- 0125_media_entrant_et_transcription.sql : garder de quoi RETROUVER un media entrant, et ce qu on en a lu.
--
-- Demande de Julien du 2026-09-09 : « quand une marque parle a ses clients sur WhatsApp, souvent les
-- personnes repondent avec un vocal ». Aujourd hui un vocal arrive et il n en reste RIEN : `contentOf`
-- (src/webhooks/inbound.ts) ne garde que la legende s il y en a une, sinon le libelle `[audio]`.
--
-- 🔴 L IDENTIFIANT DU MEDIA EST JETE A LA PORTE, ET C EST LE VRAI SUJET DE CETTE MIGRATION. Meta ne
-- transmet pas le fichier dans le webhook : il transmet un identifiant, avec lequel on va chercher une URL
-- de telechargement (deux appels : `GET /{media-id}` rend une URL courte, puis on telecharge). Sans cet
-- identifiant, le vocal est INATTEIGNABLE pour toujours, et aucune fonctionnalite ne peut le rattraper
-- apres coup. C est pour ca que cette colonne passe MEME si personne ne transcrit encore : ce qui n est pas
-- capte a la reception est perdu, et Meta ne garde les medias que 30 jours.
--
-- `media_mime` vient du meme webhook (`audio.mime_type`). Le garder evite un aller-retour, et surtout c est
-- ce que l API de transcription exige (`mediaType`) : le redemander plus tard ferait dependre une
-- transcription d un appel de plus qui peut echouer.
--
-- 🔴 LA TRANSCRIPTION EST UNE COLONNE A PART, ELLE N ECRASE PAS `body`. Meme raison qu en 0123 pour le
-- signalement : la lecture d un MODELE n est pas ce que le client a ecrit. Trois consequences concretes :
--   1. le vocal reste ECOUTABLE a cote, et un operateur qui reprend une conversation menee par l IA peut
--      verifier ce que le client a reellement dit. Une transcription approximative presentee comme une
--      citation ferait prendre une supposition pour un fait ;
--   2. l ecran peut la MARQUER comme telle (« transcription ») au lieu de la faire passer pour du texte
--      tape ;
--   3. `body` garde `[audio]`, donc tout ce qui lit `body` aujourd hui continue de fonctionner a
--      l identique. Aucune migration de donnee, aucun lecteur a relire.
--
-- `transcription_modele` rend la transcription AUTO-DESCRIPTIVE. Le modele se choisit par espace et peut
-- changer : sans lui, « la transcription est mauvaise » est une question sans reponse.
--
-- Pas d horodatage separe, contrairement a 0120 et 0123 : la, l etat n avait pas de contenu propre et il
-- fallait bien le porter quelque part. Ici la transcription EST son propre etat, presente ou absente.
--
-- Aucun index : les deux seuls chemins de lecture (« transcris CE message », « ce message est-il
-- transcrit ? ») passent par la cle primaire. Un index de plus serait de l ecriture en plus sur la table la
-- plus ecrite du produit, pour une requete que personne n ecrit.
--
-- NON BLOQUANTE : le code lit ces colonnes en les tolerant absentes. Elle passe AVANT le deploiement parce
-- que le chemin d arrivee des messages les ECRIT.

alter table conversation_messages
  add column if not exists media_id text;

alter table conversation_messages
  add column if not exists media_mime text;

alter table conversation_messages
  add column if not exists transcription text;

alter table conversation_messages
  add column if not exists transcription_modele text;
