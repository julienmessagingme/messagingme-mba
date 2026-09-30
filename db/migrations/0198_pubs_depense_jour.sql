-- 0198 : la dépense d'une publicité, JOUR PAR JOUR, relue chez Meta par le balayage de suivi.
-- Le cumul de `publicites.depense` ne se découpe pas : Performance lab chiffre une PÉRIODE, et le coût par engagé
-- des publicités doit suivre la même période que celui des campagnes push, sinon le chiffre « tout confondu »
-- mélangerait une période et toute la vie d'une publicité.
-- Additive : l'ancien code ignore la table, elle passe AVANT le déploiement du code qui l'écrit.
-- `campagne_id` est l'identifiant Meta, en texte, comme `arrivees_pub.campagne_id` (0170) : pas de clé étrangère
-- vers `publicites`. `jour` est dans le fuseau du compte publicitaire, celui dans lequel Meta découpe ses jours.
-- Une ligne n'existe que pour un jour où Meta a rendu une dépense, d'où `not null` : un jour absent n'est pas zéro.
-- La clé primaire sert l'upsert du balayage et la lecture par espace sur une plage de jours.
create table if not exists pubs_depense_jour (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  campagne_id  text not null,
  jour         date not null,
  depense      numeric(12,2) not null,
  primary key (tenant_id, campagne_id, jour)
);
