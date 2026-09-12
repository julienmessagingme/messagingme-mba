-- 0133 : se souvenir de ce qu'on a appris sur la joignabilité WhatsApp d'un contact.
--
-- 🔴 null N'EST PAS false. Un contact jamais sollicité est INCONNU, pas injoignable. Le compter
-- comme injoignable ferait sauter tout le parc historique au premier étage d'une chaîne de repli.
-- La colonne est donc nullable, et le code distingue trois états, pas deux.
--
-- ⚠️ NON BLOQUANTE : le code tolère l'absence des colonnes (verdict `inconnu`). Elle passe quand
-- même AVANT le déploiement, parce que le balayage de relance les écrit.
alter table contacts add column if not exists whatsapp_joignable boolean;
alter table contacts add column if not exists whatsapp_joignable_le timestamptz;

-- Index partiel : la seule question posée est « qui sait-on injoignable », jamais « qui sait-on
-- joignable » (cette dernière n'exclut personne). Un index plein coûterait pour rien.
create index if not exists contacts_whatsapp_injoignable_idx
  on contacts (tenant_id, whatsapp_joignable_le)
  where whatsapp_joignable = false;
