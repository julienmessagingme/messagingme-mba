-- 0179_hubspot_actif.sql : un interrupteur HubSpot par espace (design valide par Julien le 2026-09-25).
--
-- POURQUOI. Un espace neuf, sans numero WhatsApp, ne voyait aucun bouton pour connecter HubSpot : le bloc de
-- l Accueil ne s affichait que s il y avait un numero. L interrupteur vit desormais dans Parametres >
-- Integrations, et c est lui, pas la presence d un numero, qui fait apparaitre le bloc HubSpot de l Accueil.
--
-- FAUX PAR DEFAUT : un espace qui n a rien choisi ne voit pas HubSpot. Le defaut est une constante, donc
-- l ajout ne reecrit pas la table.
--
-- LA REPRISE ALLUME L INTERRUPTEUR DES ESPACES DEJA RELIES A UN PORTAIL, et seulement eux. Le lien vit dans
-- le schema du connecteur (mmhs.tenant_portals, joint a mmhs.portals : exactement la lecture de
-- PgPhoneStatusStore.getHubspotPortal, pour que la reprise et l ecran disent la meme chose). Ce schema
-- n existe PAS forcement : une base neuve (celle de la CI, une instance sans connecteur) ne le porte pas,
-- d ou la garde to_regclass. Sans elle, la migration echouerait sur toute base sans connecteur.
--
-- LE LIEN EST EN TEXTE DANS mmhs (tenant_id text), NOTRE CLE EST UN uuid : la jointure compare le texte de
-- notre identifiant, elle ne convertit jamais le leur. Une ligne du connecteur qui ne serait pas un uuid
-- ferait echouer une conversion, et avec elle la migration entiere ; comparee en texte, elle ne rejoint
-- simplement aucun espace. Et la jointure sur tenants ecarte un lien vers un espace qui n existe plus, que la
-- cle etrangere de tenant_settings refuserait.
--
-- UPSERT CIBLE : un espace sans ligne de reglages en recoit une, un espace qui en a une ne voit bouger que
-- cette colonne.
--
-- ADDITIVE : l ancien code ne lit ni n ecrit la colonne (la lecture des reglages est un select etoile, qui la
-- ramene sans la nommer). Elle passe AVANT le deploiement du code qui l ECRIT (la route de l interrupteur),
-- sans quoi l ecriture rendrait 42703.

alter table tenant_settings add column if not exists hubspot_actif boolean not null default false;

do $$
begin
  if to_regclass('mmhs.tenant_portals') is not null and to_regclass('mmhs.portals') is not null then
    insert into tenant_settings (tenant_id, hubspot_actif, updated_at)
    select distinct t.id, true, now()
      from mmhs.tenant_portals tp
      join mmhs.portals p on p.hub_id = tp.hub_id
      join tenants t on t.id::text = tp.tenant_id
    on conflict (tenant_id) do update set hubspot_actif = true, updated_at = now();
  end if;
end
$$;
