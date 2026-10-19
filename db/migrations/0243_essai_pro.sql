-- 0243_essai_pro.sql : la fin de l'essai de 14 jours du Pro (spec docs/superpowers/specs/2026-10-16-offres-v2-design.md,
-- livraison 6).
--
-- POURQUOI. Le Pro s'essaie 14 jours, carte demandee, une fois par espace. Stripe porte la fin de l'essai (trial_end) sur
-- l'abonnement ; le webhook la recopie ici (customer.subscription.created et .updated) pour que la console et Claude
-- disent « votre essai se termine le ... ». Un Pro paye des le depart la laisse nulle.
--
-- UNE COLONNE NULLABLE, SANS DEFAUT ni contrainte : null = pas d'essai. Rien a recopier, aucun Pro n'existe (sonde en
-- lecture seule du 2026-10-19).
--
-- ADDITIVE, ET ELLE PASSE AVANT LE DEPLOIEMENT DU CODE QUI LA LIT : le code neuf la nomme dans chaque lecture et chaque
-- ecriture de abonnements_offre (l'offre de la console, le webhook du Pro, la fin du Pro) ; sans elle, ces requetes
-- echouent en 42703 et Stripe rejoue ses evenements en boucle. L'ancien code ne la connait pas.
--
-- abonnements_offre est lue par offre_de_l_espace sur les chemins chauds : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

alter table abonnements_offre add column if not exists essai_fin_le timestamptz;
