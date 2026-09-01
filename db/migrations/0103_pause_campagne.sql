-- 0103_pause_campagne.sql : POURQUOI une campagne est en pause, et JUSQU'A QUAND.
--
-- Constat du contre-audit du 2026-09-01, verifie dans le code. Sur un plafond Meta, le moteur rend bien le
-- destinataire a la file et met la campagne en `paused` (aucun contact perdu, c'est deja bien mieux que de
-- bruler l'audience). Mais AUCUNE routine ne la repasse en `running` : il faut un POST `/run` a la main.
-- Le texte affiche a l'operateur, lui, promettait une reprise automatique. Le texte a ete corrige le jour
-- meme ; cette migration apporte la reprise elle-meme.
--
-- 🔴 LES DEUX RAISONS DE PAUSE NE SE REPRENNENT PAS PAREIL, et c'est tout l'interet de les distinguer :
--   - `debit` (130429, ou un HTTP 429 sans code connu) : une limite de CADENCE. Elle retombe toute seule,
--     donc elle se reessaie apres un delai borne. C'est le seul cas repris automatiquement.
--   - `qualite` (131048) : Meta juge la QUALITE du numero degradee. Relancer sans rien changer aggrave le
--     probleme et peut couter le numero. Cette pause n'est JAMAIS levee automatiquement, `paused_until`
--     reste nul, et c'est un humain qui decide de reprendre.
--
-- `paused_until` nul veut donc dire « pas de reprise automatique », et c'est le defaut : une pause dont on
-- ne sait pas quoi penser ne repart pas toute seule.
--
-- BLOQUANTE : des le deploiement, le moteur ecrit ces deux colonnes a chaque mise en pause.

alter table campaigns add column if not exists pause_reason text
  check (pause_reason in ('debit', 'qualite'));
alter table campaigns add column if not exists paused_until timestamptz;

-- Index partiel sur les SEULES campagnes qui attendent une reprise. Le balayage passe toutes les minutes et
-- ne doit pas parcourir la table des campagnes pour trouver, la plupart du temps, zero ligne.
create index if not exists campaigns_reprise_idx
  on campaigns (paused_until)
  where status = 'paused' and pause_reason = 'debit' and paused_until is not null;
