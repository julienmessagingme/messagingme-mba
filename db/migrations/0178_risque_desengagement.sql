-- migrate: no-transaction
-- 0178_risque_desengagement.sql : le risque de desengagement d un contact (lot 7 de l API publique, spec du
-- 2026-09-24 section 19).
--
-- POURQUOI. Un balayage de nuit calcule, contact par contact, un niveau (inconnu, faible, moyen, eleve), un
-- score de 0 a 100 et les trois raisons les plus lourdes, a partir des faits des 90 derniers jours
-- (src/engagement/risque.ts, regles pures). Le resultat est lu par la fiche de l API publique
-- (engagementRisk), par la fiche du mini-CRM et par le filtre de la liste des contacts. Il se range sur la
-- fiche parce qu il se LIT fiche par fiche : une table a part ferait une jointure de plus sur la liste.
--
-- NULLABLES ET SANS DEFAUT, sauf les raisons. null = jamais calcule (l API rend engagementRisk: null), ce
-- qui est l etat de toutes les fiches au deploiement : aucun comportement ne bouge pour personne tant que le
-- balayage n a pas tourne. Les raisons sont un tableau VIDE par defaut, jamais null : un tableau null et un
-- tableau vide diraient la meme chose de deux facons. Le defaut est une constante, donc l ajout ne reecrit
-- pas la table.
--
-- LES CODES SONT FERMES EN BASE, niveaux comme raisons (trois au plus) : ce sont des identifiants que l API
-- publique et l outil du client lisent tels quels. Les deux listes sont celles de src/engagement/risque.ts,
-- et tests/risque-migration.test.ts les compare a ce fichier.
--
-- LA COHERENCE EST TENUE EN BASE, parce qu elle porte un invariant du lot (inconnu SANS score) : un niveau
-- mesure porte un score, inconnu n en porte pas, et un niveau ne va jamais sans sa date de calcul. Le seul
-- ecrivain est le balayage (src/engagement/risque.pg.ts), et une ligne incoherente y ferait echouer le lot
-- de fiches en cours plutot que d etre rendue a un integrateur.
--
-- L INDEX EST CELUI DU FILTRE PAR NIVEAU (liste des contacts, construction d une campagne), et il sert aussi
-- la lecture des fiches a reevaluer (risque_niveau is not null). Partiel sur deleted_at is null, comme les
-- autres index de lecture de contacts : une fiche supprimee n est jamais listee.
--
-- ADDITIVE : l ancien code ne lit ni n ecrit ces colonnes. Elle passe AVANT le deploiement du code qui les
-- lit (la fiche de l API les nomme dans son select, et rendrait 42703 sans elles).
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY), comme 0172 : contacts est la plus grosse table, et elle est
-- sur le chemin de chaque message entrant. Chaque instruction est rejouable : add column if not exists saute
-- une colonne deja la (sa contrainte avec elle), la contrainte de coherence est retiree puis reposee, et
-- l index porte if not exists. Les deux CHECK de colonne et celui de coherence balayent la table une fois,
-- sans la reecrire. La verification apres coup n est pas facultative :
--   select indisvalid from pg_index where indexrelid = 'contacts_tenant_risque_idx'::regclass;
-- false -> drop index concurrently contacts_tenant_risque_idx, PUIS rejouer A LA MAIN l instruction create
-- index ci-dessous : si 0178 est deja inscrite dans schema_migrations, migrate repond a jour et ne recree
-- RIEN. Precedents : 0115, 0172.

alter table contacts add column if not exists risque_niveau text
  constraint contacts_risque_niveau_check check (risque_niveau in ('inconnu', 'faible', 'moyen', 'eleve'));

alter table contacts add column if not exists risque_score smallint
  constraint contacts_risque_score_check check (risque_score between 0 and 100);

alter table contacts add column if not exists risque_raisons text[] not null default '{}'
  constraint contacts_risque_raisons_check check (
    cardinality(risque_raisons) <= 3
    and risque_raisons <@ array['stop', 'bloque', 'silence_60j', 'silence_30j', 'sans_reponse', 'non_lu', 'reclamation',
                                'negatif', 'insatisfait', 'injoignable']::text[]
  );

alter table contacts add column if not exists risque_calcule_le timestamptz;

alter table contacts drop constraint if exists contacts_risque_coherence_check;

alter table contacts add constraint contacts_risque_coherence_check check (
  (risque_niveau is null and risque_score is null and risque_calcule_le is null)
  or (risque_niveau = 'inconnu' and risque_score is null and risque_calcule_le is not null)
  or (risque_niveau in ('faible', 'moyen', 'eleve') and risque_score is not null and risque_calcule_le is not null)
);

create index concurrently if not exists contacts_tenant_risque_idx
  on contacts (tenant_id, risque_niveau)
  where deleted_at is null;
