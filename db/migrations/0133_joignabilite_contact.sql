-- 0133 : se souvenir de ce qu'on a appris sur la joignabilité WhatsApp d'un contact.
--
-- 🔴 null N'EST PAS false. Un contact jamais sollicité est INCONNU, pas injoignable. Le compter
-- comme injoignable ferait sauter tout le parc historique au premier étage d'une chaîne de repli.
-- La colonne est donc nullable, et le code distingue trois états, pas deux.
--
-- 🔴 BLOQUANTE. ELLE PASSE AVANT LE DÉPLOIEMENT, SANS EXCEPTION. Une version de ce commentaire
-- annonçait « non bloquante, le code tolère l'absence des colonnes » : c'était FAUX et c'est
-- exactement la croyance qui a coûté 1 h 30 de production le 2026-08-17. Trois `select` de
-- `PgContactStore` les listent désormais (`findByPhone`, `SELECT_ONE`, la liste paginée) : sans ces
-- colonnes, Postgres rend `42703 column does not exist` et la fiche contact, la liste et la
-- recherche par numéro tombent toutes les trois. Le `?? null` du code protège une valeur absente
-- d'un objet, pas une colonne absente d'une table.
alter table contacts add column if not exists whatsapp_joignable boolean;
alter table contacts add column if not exists whatsapp_joignable_le timestamptz;

-- Index partiel, POSÉ POUR UNE REQUÊTE QUI N'EXISTE PAS ENCORE, et il faut le dire.
--
-- ⚠️ Le seul lecteur d'aujourd'hui est le filtre d'audience « sauf les injoignables connus », dont le
-- prédicat est `whatsapp_joignable is not false or ...`, c'est-à-dire le COMPLÉMENT de celui de cet
-- index : Postgres ne peut pas s'en servir pour ça. Il servira le récapitulatif de la chaîne de
-- repli (« combien basculeront à l'étage suivant »), qui demande bien `= false` et non périmé.
-- Le garder coûte une écriture par note ; le retirer pour le remettre dans deux lots coûterait plus.
create index if not exists contacts_whatsapp_injoignable_idx
  on contacts (tenant_id, whatsapp_joignable_le)
  where whatsapp_joignable = false;
