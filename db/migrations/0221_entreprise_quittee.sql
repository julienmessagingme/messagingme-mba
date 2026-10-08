-- Lot 6, livraison C : la date a laquelle un espace quitte l'Entreprise, posee par l'exploitation (/ops) quand
-- l'Entreprise s'eteint (decision de Julien du 2026-10-08).
--
-- La conservation de la Base (30 jours) ne s'applique qu'a partir de 30 jours apres l'entree en Base : la creation,
-- la fin du dernier Pro, ou cette sortie. Sans elle, passer un espace d'Entreprise a Base effacerait tout de suite
-- ses conversations de plus de 30 jours, et changer d'offre ne doit jamais purger sur le coup.
--
-- Nullable, sans defaut. Additive, que seul le code neuf ecrit et lit : l'ancien code y survit, elle passe AVANT le up.
set local lock_timeout = '5s';

alter table tenants add column if not exists entreprise_quittee_le timestamptz;

-- La reprise (jaune 1 de la relecture de C) : 0218 a pose en Entreprise tous les espaces d'alors. Un espace d'avant
-- elle qui n'y est plus en est sorti par /ops, sans date, puisque l'ancien code ne la posait pas. Sans elle, sa grace
-- serait deja ecoulee et le premier balayage effacerait ses conversations de plus de 30 jours. now() est une borne
-- sure : elle ne fait qu'allonger la grace. Un espace ne en Base apres 0218 n'a jamais quitte l'Entreprise.
update tenants set entreprise_quittee_le = now()
 where not offre_entreprise and entreprise_quittee_le is null
   and created_at < (select applied_at from public.schema_migrations where name = '0218_offres.sql');
