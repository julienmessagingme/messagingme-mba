-- 0251_hubspot_choix_des_fonctions.sql : le client choisit ce qu il branche entre Messaging Me et HubSpot (lot 1bis
-- de la reprise humaine, cadrage valide par Julien le 2026-10-23, mm-hubspot docs/2026-10-23-choix-des-fonctions-*).
--
-- QUATRE INTERRUPTEURS PAR ESPACE, plus la date du choix :
--   hubspot_analyse      la fiche contact et l analyse de chaque conversation (job push-analysis)       defaut VRAI
--   hubspot_passage      la tache immediate quand un client demande un humain (job push-handoff)        defaut VRAI
--   hubspot_injoignable  le contact signale injoignable sur WhatsApp (second echec 131026)              defaut VRAI
--   hubspot_reponse      repondre aux clients depuis HubSpot (lot 2, lu par ses routes)                  defaut FAUX
--   hubspot_choix_valide_le  le client a valide l etape de choix (nul : l ecran la lui propose)
-- Ce qui ecrit dans HubSpot sans rien ouvrir est allume ; ce qui ouvre une porte d envoi est eteint. Les defauts
-- sont des constantes : l ajout ne reecrit pas la table.
--
-- LES ESPACES EXISTANTS GARDENT EXACTEMENT LEUR COMPORTEMENT : les trois chemins deja vivants restent allumes
-- (defaut vrai), et la reprise pose la date du choix pour tout espace ou HubSpot sert VRAIMENT (un numero synchronise :
-- des donnees partent deja), pour que l etape de choix ne s impose pas a eux. L ancien interrupteur hubspot_actif ne
-- prouve rien (il ne gouvernait que l affichage, et s allumait sans portail) : un espace qui ne l avait qu allume verra
-- l etape de choix a sa connexion, et sa validation allumera la synchro (relecture du lot 1bis). On ne lit PAS le schema
-- du connecteur (mmhs), qui vit sur sa propre base depuis le 2026-10-15.
--
-- UPSERT CIBLE : un espace sans ligne de reglages en recoit une, un espace qui en a une ne voit bouger que la date.
--
-- ADDITIVE : l ancien code ne nomme aucune de ces colonnes (la lecture des reglages est un select etoile). Elle passe
-- AVANT le code qui les lit et les ecrit.

alter table tenant_settings add column if not exists hubspot_analyse boolean not null default true;
alter table tenant_settings add column if not exists hubspot_passage boolean not null default true;
alter table tenant_settings add column if not exists hubspot_injoignable boolean not null default true;
alter table tenant_settings add column if not exists hubspot_reponse boolean not null default false;
alter table tenant_settings add column if not exists hubspot_choix_valide_le timestamptz;

insert into tenant_settings (tenant_id, hubspot_choix_valide_le, updated_at)
select t.id, now(), now()
  from tenants t
 where exists (select 1 from phone_numbers p where p.tenant_id = t.id and p.hubspot_connected)
on conflict (tenant_id) do update
   set hubspot_choix_valide_le = coalesce(tenant_settings.hubspot_choix_valide_le, excluded.hubspot_choix_valide_le),
       updated_at = now();
