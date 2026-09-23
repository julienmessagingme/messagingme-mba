-- 0170_pubs_router.sql : lot 3 des publicités Click-to-WhatsApp, premier commit, « Router ».
-- Spec : docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md (§ 2, § 3.3, § 3.4).
-- Plan : docs/superpowers/plans/2026-09-23-pubs-ctwa-lot3-router-creer-suivre.md
--
-- AVANT le déploiement : elle n'AJOUTE que (deux tables, quatre colonnes, un index, deux CHECK posés sur des
-- colonnes qui viennent de naître). Le code déployé ignore tout cela, il y survit ; le code neuf, lui, écrit
-- dans les deux tables et nomme les quatre colonnes dans ses select.

-- ---------------------------------------------------------------------------------------------------------
-- publicites : une ligne par CAMPAGNE connue d'Engage Me.
-- ---------------------------------------------------------------------------------------------------------
-- 🔴 LE LIEN EST PAR CAMPAGNE, PAS PAR PUB, et c'est une décision de Julien (2026-09-22). Une pub se COPIE
-- dans le Gestionnaire de Meta en deux clics, et chaque copie porte un identifiant neuf : router sur
-- l'identifiant de pub ferait perdre le scénario au premier duplicata, sans aucun signe. La campagne, elle,
-- survit aux copies faites à l'intérieur d'elle-même. Une pub créée ici est sa propre campagne.
create table if not exists publicites (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  -- Identifiants Meta. La campagne est la CLÉ MÉTIER (unique par espace) ; les trois autres sont écrits au
  -- fur et à mesure que Meta les rend, pendant la création, et restent nuls si une étape échoue avant eux.
  campagne_id       text not null,
  ensemble_id       text,
  crea_id           text,
  pub_id            text,
  -- 'engage_me' : créée par cet écran. 'importee' : rattachée après coup (lot 4).
  origine           text not null default 'engage_me',
  nom               text not null,
  -- ÉTAT LOCAL, le nôtre, et il ne se confond pas avec celui de Meta juste en dessous :
  --   creation       : les appels à Meta sont en cours.
  --   echec_creation : une étape a échoué ET la campagne n'a pas pu être supprimée chez Meta. La ligne reste
  --                    VISIBLE exprès : une campagne en pause ne dépense rien, mais elle existe, et un client
  --                    qui ne la voit pas ici la découvrira dans le Gestionnaire sans savoir d'où elle vient.
  --   prete          : tout est créé chez Meta, tout est en PAUSE, rien ne dépense, rien ne route.
  --   publiee        : l'automation est allumée et Meta diffuse. Une pause ultérieure ne fait pas revenir en
  --                    arrière : elle se lit sur statut_meta, et l'automation RESTE allumée pour les leads
  --                    tardifs.
  etat              text not null default 'creation',
  -- effective_status de Meta, tel quel (PENDING_REVIEW, ACTIVE, DISAPPROVED, WITH_ISSUES...), et son motif de
  -- refus. Nuls tant que le balayage n'a rien lu : « je ne sais pas encore » n'est pas « tout va bien ».
  statut_meta       text,
  motif_refus       text,
  -- Budget TOTAL et dates, obligatoires côté produit (garde-fou de dépense), mais nullables ici : la ligne
  -- naît avant l'appel qui les pose chez Meta, et le suivi les réécrit avec ce que Meta renvoie.
  budget_total      numeric(12,2),
  debut             timestamptz,
  fin               timestamptz,
  -- QUI RÉPOND AUX LEADS de cette campagne : l'agent de Meta, ou un scénario.
  destination       text not null,
  -- Le scénario visé. on delete set null, JAMAIS cascade : supprimer un scénario ne doit pas faire
  -- disparaître la publicité qui l'utilisait, ni son historique de dépense.
  workflow_id       uuid references workflows(id) on delete set null,
  -- Le tag qui vaut « lead qualifié » pour cette pub. Facultatif : sans lui, l'entonnoir s'arrête aux leads.
  tag_qualification text,
  -- L'automation POSSÉDÉE (automations.possede_par = 'publicite'), créée éteinte et allumée à la publication.
  -- on delete set null pour la même raison que le scénario.
  automation_id     uuid references automations(id) on delete set null,
  -- Ce que la dernière lecture chez Meta a rendu. Nuls = jamais lu, et l'écran le dit ainsi.
  depense           numeric(12,2),
  clics             integer,
  lu_le             timestamptz,
  cree_par          uuid references users(id) on delete set null,
  cree_le           timestamptz not null default now(),
  constraint publicites_campagne_uniq unique (tenant_id, campagne_id),
  constraint publicites_destination_chk check (destination in ('scenario', 'agent_meta')),
  constraint publicites_origine_chk check (origine in ('engage_me', 'importee')),
  constraint publicites_etat_chk check (etat in ('creation', 'echec_creation', 'prete', 'publiee')),
  -- 🔴 UN SEUL SENS, ET C'EST LA LEÇON DE 0144 APPLIQUÉE À L'AVANCE. On interdit « un scénario sur une pub
  -- qui va chez l'agent de Meta », qui serait une incohérence de saisie. On N'INTERDIT PAS « destination
  -- scénario sans scénario » : cet état est ATTEIGNABLE (le scénario supprimé, on delete set null ci-dessus),
  -- et le refuser ferait échouer la suppression d'un scénario sur une contrainte de publicité, c'est-à-dire
  -- rendre 500 sur un geste ordinaire. Le refus lisible vit dans la route de suppression, en 409.
  constraint publicites_scenario_chk check (workflow_id is null or destination = 'scenario')
);

-- Sert le balayage du suivi : les pubs d'un espace qu'il faut encore relire chez Meta. Index PARTIEL, donc
-- CONTRAT AVEC UNE REQUÊTE PRÉCISE : celle qui filtre etat = 'publiee'. Élargir son where sans élargir ce
-- prédicat ne produirait aucune erreur, seulement un balayage complet de la table (leçon de 0122).
create index if not exists publicites_a_suivre_idx on publicites (tenant_id, lu_le) where etat = 'publiee';

-- ---------------------------------------------------------------------------------------------------------
-- pubs_connues : identifiant de PUB vers identifiant de CAMPAGNE, par espace.
-- ---------------------------------------------------------------------------------------------------------
-- 🔴 C'EST CE QUI REND LE LIEN « PAR CAMPAGNE » VRAI POUR LES COPIES. Le webhook de Meta ne porte que
-- referral.source_id, c'est-à-dire la PUB. Sans cette table, retrouver la campagne demanderait un appel à
-- Meta à chaque message entrant : sur le chemin chaud des messages, avec un tiers qui peut être lent ou muet.
--
-- ⚠️ ELLE MÉMORISE AUSSI LES CAMPAGNES QUI NE SONT PAS LES NÔTRES, et c'est délibéré : le routage a besoin
-- de savoir « cette pub appartient à la campagne X », pas « X est à nous ». C'est publicites qui répond à la
-- seconde question. Mémoriser les deux cas évite de rappeler Meta à chaque lead d'une pub qu'on ne pilote pas.
--
-- ⚠️ UN ÉCHEC DE RÉSOLUTION N'EST PAS MÉMORISÉ. Écrire « inconnue » figerait une panne réseau en verdict
-- permanent, et le lead suivant n'aurait aucune chance d'être routé.
create table if not exists pubs_connues (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  ad_id        text not null,
  campagne_id  text not null,
  -- Quand la correspondance a été établie. Sert à comprendre, pas à expirer : chez Meta, une pub ne change
  -- jamais de campagne.
  vu_le        timestamptz not null default now(),
  primary key (tenant_id, ad_id)
);

-- ---------------------------------------------------------------------------------------------------------
-- arrivees_pub : ce que le lot 1 avait laissé au lot 3.
-- ---------------------------------------------------------------------------------------------------------
-- 🔴 campagne_id EST L'IDENTIFIANT META, EN TEXTE, ET SURTOUT PAS UNE CLÉ ÉTRANGÈRE VERS publicites. Une
-- arrivée est un FAIT DATÉ : supprimer la publicité ne doit pas effacer d'où venait le lead. Un
-- on delete set null le ferait en silence, et l'entonnoir d'hier ne rendrait plus le même chiffre aujourd'hui.
alter table arrivees_pub add column if not exists campagne_id text;

-- L'issue du routage, telle que la règle pure l'a décidée. Nulle = arrivée d'avant ce lot, ou routage qui n'a
-- pas pu tourner. Les sept valeurs sont le tableau de la spec § 3.3, mot pour mot.
alter table arrivees_pub add column if not exists issue text;

-- Quand le fil a été repris à l'agent de Meta pour ce lead. C'est la seule mesure du DÉLAI entre l'arrivée et
-- la reprise, et l'essai réel du pilote en a besoin.
alter table arrivees_pub add column if not exists reprise_le timestamptz;

-- Quand ce lead est devenu QUALIFIÉ (le tag de la pub lui a été posé, dans les 28 jours). Nulle = pas encore.
alter table arrivees_pub add column if not exists qualifie_le timestamptz;

alter table arrivees_pub drop constraint if exists arrivees_pub_issue_chk;
alter table arrivees_pub add constraint arrivees_pub_issue_chk check (
  issue is null or issue in ('inchange', 'agent_meta', 'reprise_reussie', 'reprise_refusee', 'desabonne', 'bloque', 'scenario')
);

-- Sert l'entonnoir d'une pub : les arrivées d'une campagne, dans un espace. Index PARTIEL sur
-- campagne_id is not null, ce qui est exactement le domaine de la requête (elle compare campagne_id = $2,
-- donc elle ne voit jamais une ligne nulle) et laisse dehors les arrivées de pubs qu'on ne pilote pas.
create index if not exists arrivees_pub_campagne_idx on arrivees_pub (tenant_id, campagne_id) where campagne_id is not null;

-- ⚠️ AUCUN INDEX AJOUTÉ POUR LA QUALIFICATION, et ce n'est pas un oubli : arrivees_pub_contact_idx
-- (contact_id, arrivee_le desc), créé par 0163, sert déjà « la dernière arrivée de ce contact », qui est
-- exactement la requête de l'attribution. Un second index sur les mêmes colonnes serait une justification
-- fausse inscrite dans le schéma (leçon de 0143).
