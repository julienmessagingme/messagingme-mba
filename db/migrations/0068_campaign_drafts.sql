-- 0068 : brouillons de campagne, c'est-à-dire une campagne EN COURS DE COMPOSITION.
--
-- Pourquoi une table à part plutôt que `campaigns.status = 'draft'` : ce statut existe déjà, mais il désigne
-- autre chose. Une campagne `draft` est une campagne COMPLÈTE (destinataires résolus, template choisi) qu'on
-- n'a pas encore lancée ; `createCampaign` calcule ses destinataires à la création, et aucune route ne permet
-- de la modifier ensuite. Y écrire un nom seul produirait une campagne à zéro destinataire, impossible à
-- compléter et impossible à lancer, au milieu des vraies.
--
-- Ce brouillon-ci ne connaît ni destinataire ni template résolu : c'est l'état de l'ÉCRAN, conservé pour
-- pouvoir reprendre. Il ne touche donc jamais au moteur d'envoi, et une erreur ici ne peut pas produire un
-- envoi. `state` est volontairement du jsonb libre : le formulaire évolue vite, et figer sa forme en colonnes
-- obligerait une migration à chaque champ ajouté.
--
-- Migration ADDITIVE : à appliquer AVANT le déploiement du code.
create table if not exists campaign_drafts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  state       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- L'écran liste les brouillons d'un tenant, du plus récent au plus ancien : c'est le seul accès.
create index if not exists campaign_drafts_tenant_idx
  on campaign_drafts (tenant_id, updated_at desc);
