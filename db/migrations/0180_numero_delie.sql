-- 0180_numero_delie.sql : DÉLIER le numéro WhatsApp d'un espace, sans rien toucher chez Meta.
--
-- Demande de Julien du 2026-09-25 (bloc « Canaux et services » de l'Accueil, plan
-- docs/superpowers/plans/2026-09-25-accueil-canaux-et-services.md). Éteindre le numéro depuis l'Accueil le
-- DÉLIE de l'espace. Ce n'est PAS une suppression : la ligne `phone_numbers` reste, avec son compte WhatsApp et
-- le jeton chiffré de `waba_credentials`, et c'est ce qui rend la reconnexion d'un clic possible. L'historique
-- (conversations, campagnes, contacts) n'est pas touché non plus.
--
-- Deux changements :
--   1. `phone_numbers.delie_le` : QUAND le numéro a été délié. null = relié, c'est le cas de tous les numéros
--      existants, donc rien ne bouge pour personne. Une date plutôt qu'un booléen : l'écran dit depuis quand.
--   2. le CHECK `campaigns_pause_reason_check` accepte `numero_delie`. Son nom a été LU dans 0122, qui l'a posé
--      sous ce nom après que 0103 l'eut créé en ligne ; un nom deviné à côté laisserait l'ancien CHECK en place
--      ET ajouterait le nouveau, donc la mise en pause échouerait à l'écriture, en silence pour le client.
--
-- 🔴 L'INDEX PARTIEL `campaigns_reprise_idx` NE BOUGE PAS, ET C'EST LA GARDE QUI COMPTE. Son prédicat (0122) est
-- `status = 'paused' and pause_reason in ('debit', 'hors_horaires') and paused_until is not null`, le contrat
-- exact du WHERE de `reprendreCampagnesDues`. Une pause `numero_delie` a `paused_until` NUL et un motif hors de
-- cette liste : le balayage de reprise ne la voit donc jamais, et elle ne repart QUE par le geste « Relier ».
-- Élargir ce prédicat ferait repartir une campagne vers un numéro délié (le point de passage des envois la
-- remettrait aussitôt en pause, mais ce serait une boucle, pas une garde).
--
-- 🔴 BLOQUANTE, DONC AVANT LE DÉPLOIEMENT. Le code NOMME `delie_le` dans la lecture du numéro de l'Accueil
-- (`PgPhoneStatusStore.getPhoneNumber`), dans la garde de TOUS les envois (`PgNumeroDelieStore.estDelie`) et dans
-- l'écart des entrants du webhook : déployer d'abord rendrait `42703` sur l'Accueil et sur chaque envoi, comme le
-- 2026-08-17. Et l'ancien code y survit : il ignore la colonne, et le CHECK élargi accepte tout ce qu'il écrit.
--
-- ⚠️ AUCUN INDEX, délibérément. `delie_le` se lit par la clé primaire (`id`, la garde des envois et le webhook) ou
-- par l'espace (`phone_numbers_tenant_created_idx`, 0042, pour délier et relier), et la table porte une ligne
-- par numéro du parc.

alter table phone_numbers add column if not exists delie_le timestamptz;

alter table campaigns drop constraint if exists campaigns_pause_reason_check;
alter table campaigns add constraint campaigns_pause_reason_check
  check (pause_reason in ('debit', 'qualite', 'hors_horaires', 'numero_delie'));
