-- Ce que l'assistant et les formulaires ont changé, et ce qu'ils ont effacé.
--
-- 🔴 CE N'EST PAS `audit_log`, ET LA RAISON EST MESURÉE : ce journal-là est PURGÉ
-- (`PgAuditStore.purgeOlderThan`, deux ans par défaut, index `audit_log_purge_idx` créé en 0097). La
-- rétention demandée ici est ILLIMITÉE (tranchée par Julien le 2026-09-14), parce que ces lignes portent le
-- seul exemplaire d'un contenu que Meta ne garde pas : FAQ, compétences et sites vivent CHEZ LUI, sans
-- corbeille ni historique. Y ranger cet historique aurait été une promesse démentie par un `delete` écrit
-- ailleurs.
--
-- ⚠️ AUCUN INDEX SUR `at` SEUL, délibérément. Un tel index ne sert QU'À une purge par date ; son absence est
-- ce qui dit au prochain lecteur que cette table ne se purge pas.
create table if not exists reglages_historique (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- 'mba' ou 'agent'. La surface décide de l'onglet qui affiche la ligne.
  surface     text not null,
  -- L'identifiant de l'agent pour 'agent'. NULL pour 'mba' : il y en a un par espace.
  surface_id  uuid,
  element     text not null,
  operation   text not null,
  -- L'identifiant chez Meta (faq_id, skill_id...) ou la clé du champ modifié. Indicatif : un identifiant
  -- Meta ne survit pas à une suppression, donc il ne sert pas à retrouver, seulement à rapprocher.
  cible       text,
  -- Ce qu'on montre à l'écran, déjà rédigé : « FAQ : horaires du dimanche ».
  libelle     text not null,
  avant       jsonb,
  apres       jsonb,
  origine     text not null,
  -- Dénormalisé, comme `audit_log.actor_email` : le départ d'un collaborateur ne doit pas rendre
  -- l'historique anonyme.
  acteur_email text,
  acteur_id   uuid references users(id) on delete set null,
  at          timestamptz not null default now(),

  constraint reglages_historique_surface_chk
    check (surface in ('mba', 'agent')),
  constraint reglages_historique_operation_chk
    check (operation in ('ajout', 'modification', 'suppression')),
  constraint reglages_historique_origine_chk
    check (origine in ('assistant', 'formulaire')),
  -- 🔴 L'INVARIANT DE LA TABLE : une suppression SANS son contenu serait une ligne qui dit qu'on a perdu
  -- quelque chose sans dire quoi, c'est-à-dire pire qu'aucune ligne. La promesse « on garde ce qui est
  -- effacé » est tenue par le SCHÉMA, parce qu'une promesse tenue par la discipline du développeur se perd
  -- au troisième appelant.
  constraint reglages_historique_suppression_garde
    check (operation <> 'suppression' or avant is not null),
  -- Un agent a un identifiant, le MBA n'en a pas : les deux formes sont exclusives.
  constraint reglages_historique_surface_id_chk
    check ((surface = 'agent' and surface_id is not null) or (surface = 'mba' and surface_id is null))
);

-- L'index de LECTURE, et c'est le seul. Il sert exactement la requête de l'onglet : les lignes d'une
-- surface, les plus récentes d'abord.
create index if not exists reglages_historique_lecture_idx
  on reglages_historique (tenant_id, surface, surface_id, at desc);

-- Le compteur de NOTRE dépense d'assistant, par espace et par mois calendaire.
--
-- 🔴 PAR ESPACE, PAS PAR ASSISTANT (tranché par Julien le 2026-09-14). Un plafond par assistant
-- multiplierait notre exposition par le nombre d'agents, c'est-à-dire par un chiffre que le client contrôle
-- lui-même.
--
-- ⚠️ Ce n'est PAS `credits` : cette table-là porte le crédit PRÉPAYÉ du client, qui paie ses tours d'agent
-- et son bac à sable. Ici c'est NOTRE argent (les deux assistants passent par la clé maison), et mélanger
-- les deux ferait apparaître notre coût de support comme une consommation du client.
create table if not exists assistant_depense_mois (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- Le premier jour du mois, en UTC. Une date et pas un texte : la comparaison est alors totale.
  mois        date not null,
  micro_euros bigint not null default 0,
  primary key (tenant_id, mois)
);
