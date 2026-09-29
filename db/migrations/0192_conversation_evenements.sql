-- 0192 : le journal des evenements d'une conversation, pour le panneau Detail de l'Inbox (cadrage du 2026-09-28).
--
-- Ce qui est arrive a une conversation, et par qui : assignee, desassignee, prise a l'agent de Meta, rendue a
-- l'agent, passee a l'equipe par l'agent, traitee, archivee, signalee et leurs inverses, rouverte par un
-- message du contact. Ecrit par PgInboxStore, et par lui seul, dans la MEME requete que le changement qu'il
-- decrit et seulement si la valeur a vraiment change (regles dans src/inbox/evenements.ts).
--
-- 🔴 BLOQUANTE, DONC AVANT LE UP. Le code neuf ecrit cette table sur le chemin de CHAQUE message entrant
-- (l'upsert qui rouvre une conversation archivee ou traitee) : deploye avant elle, chaque message recu
-- echouerait en 42P01. Elle est ADDITIVE : l'ancien code l'ignore, elle passe sans risque avant lui.
--
-- ⚠️ LE VERROU QU'ELLE POSE. Les cles etrangeres vers conversations et users prennent un verrou SHARE ROW
-- EXCLUSIVE sur ces deux tables jusqu'a la fin de la transaction, amorcage compris : les ecritures de l'Inbox
-- (et chaque message entrant) attendent pendant ce temps. L'amorcage ne lit conversations qu'une fois ; compter
-- les conversations avant de l'appliquer, et lire pg_stat_activity (aucune transaction longue ouverte).
--
-- ⚠️ PAS DE CONCURRENTLY, et c'est delibere : l'index porte sur une table NEUVE, creee vide dans cette meme
-- transaction. Il n'y a rien a construire, et CONCURRENTLY retirerait le filet de la transaction pour rien.
--
-- Retention : celle de la conversation (on delete cascade), purge par anciennete et effacement RGPD compris.
-- Un collaborateur supprime : on delete set null, et l'ecran dit « ancien collaborateur ». Une ligne porte un
-- acteur OU une cause : un acteur nul sans cause est donc un collaborateur supprime depuis.
--
-- id en identite (bigint) et non en uuid : il departage deux evenements de la meme seconde dans l'ordre ou ils
-- ont ete ecrits, ce que la frise et la lecture d'une reassignation supposent.
create table if not exists conversation_evenements (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references tenants (id) on delete cascade,
  conversation_id  uuid not null references conversations (id) on delete cascade,
  type             text not null,
  acteur_id        uuid references users (id) on delete set null,
  cible_id         uuid references users (id) on delete set null,
  cause            text,
  at               timestamptz not null default now(),
  constraint conversation_evenements_type_check check (type in (
    'assignee', 'desassignee', 'prise_mba', 'rendue_mba', 'passee_par_mba',
    'traitee', 'non_traitee', 'archivee', 'desarchivee', 'signalee', 'designalee', 'rouverte'
  ))
);

-- La seule lecture : les derniers evenements d'UNE conversation, du plus recent au plus ancien, et la
-- derniere assignation qui precede chacune (reassignation). L'ordre de l'index est celui de la requete.
create index if not exists conversation_evenements_conv_idx
  on conversation_evenements (conversation_id, at desc, id desc);

-- AMORCAGE depuis l'etat actuel, qui est reel : une ligne par fait constate, datee par sa propre colonne. Rien
-- n'est invente : pas de date, pas de ligne. La cause est celle de src/inbox/evenements.ts (CAUSE_AMORCAGE).
--  - l'assignation en cours : sa cible, son auteur (null = routage automatique), sa date ;
--  - traitee, archivee : leur date, sans auteur (la colonne n'en garde pas) ;
--  - signalee : sa date et son auteur ;
--  - le fil tenu par l'equipe (app_human) : depuis control_changed_at. Type prise_mba, que l'ecran lit
--    « tenue par l'equipe » sur une ligne amorcee : on ne sait pas a qui elle a ete prise.
insert into conversation_evenements (tenant_id, conversation_id, type, acteur_id, cible_id, cause, at)
select c.tenant_id, c.id, 'assignee', c.assigned_by, c.assigned_to, 'état au déploiement', c.assigned_at
  from conversations c
 where c.assigned_to is not null and c.assigned_at is not null
union all
select c.tenant_id, c.id, 'traitee', null, null, 'état au déploiement', c.traitee_le
  from conversations c
 where c.traitee_le is not null
union all
select c.tenant_id, c.id, 'archivee', null, null, 'état au déploiement', c.archived_at
  from conversations c
 where c.archived_at is not null
union all
select c.tenant_id, c.id, 'signalee', c.signalee_par, null, 'état au déploiement', c.signalee_le
  from conversations c
 where c.signalee_le is not null
union all
select c.tenant_id, c.id, 'prise_mba', null, null, 'état au déploiement', c.control_changed_at
  from conversations c
 where c.control_owner = 'app_human' and c.control_changed_at is not null;
