-- migrate: no-transaction
-- 0196_fiche_analyse.sql : la derniere analyse d un contact, recopiee sur sa fiche (chantier Tout sur la fiche,
-- lot 1, spec docs/superpowers/specs/2026-09-30-fiche-unique-design.md).
--
-- POURQUOI. L analyse vit sur la conversation (conversation_analysis, cle conversation_id, en cascade depuis
-- 0027) et meurt avec elle quand la duree de conservation l efface. Decision de Julien du 2026-09-30 : les
-- constats de l analyse restent sur la fiche. La copie est ecrite dans la transaction de
-- PgConversationAnalysisStore.save, par l analyse seule, et lue par la fiche, le risque, les filtres, les
-- connecteurs et les sorties. Le RESUME n est pas recopie : il porte les propos du client et part avec la
-- conversation.
--
-- NULLABLES ET SANS DEFAUT : null = jamais analyse, jamais 0 ni une chaine vide. C est l etat de toutes les
-- fiches au deploiement (pas de reprise du passe, decision 6), donc aucun comportement ne bouge pour personne
-- tant qu aucune analyse n a tourne. Sans defaut, l ajout ne reecrit pas la table.
--
-- LES CODES SONT FERMES EN BASE, et chaque liste est celle de src/analysis/schema.ts (INTENTS, SENTIMENTS,
-- ACTIONS, HANDLED_BY, NOTE_MIN et NOTE_MAX, SUJET_MAX). tests/fiche-analyse-migration.test.ts compare ce
-- fichier au schema, et tests/intentions-parite.test.ts lit le dernier CHECK de chaque colonne d intention :
-- une valeur que Zod accepte et que ce CHECK refuse ferait echouer TOUTE la transaction de save, analyse
-- comprise, et le job partirait en DLQ. Ajouter une intention demande donc de relacher DEUX CHECK.
--
-- LA COHERENCE EST TENUE EN BASE : une copie est entiere ou absente. analyse_conversation_id en est exclu, parce
-- qu il retombe a null quand sa conversation est effacee alors que les codes restent (c est tout l objet du
-- lot). Les notes et la conversation peuvent etre nulles dans une copie, rien d autre.
--
-- analyse_conversation_id EN on delete set null : il designe la conversation d ou viennent les codes, pour que
-- la fiche lise le resume de la MEME analyse. Une cascade effacerait la fiche avec la conversation. Son index
-- partiel sert l action de la cle etrangere : sans lui, chaque conversation effacee (retention, purge, par lots
-- de 500) parcourrait contacts pour appliquer le set null.
--
-- ADDITIVE : l ancien code ne lit ni n ecrit ces colonnes. Elle passe AVANT le deploiement du code qui les ecrit
-- (save les nomme, et rendrait 42703 sans elles, analyse comprise).
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY), comme 0178 : contacts est sur le chemin de chaque message
-- entrant. Chaque instruction est rejouable : add column if not exists saute une colonne deja la (sa contrainte
-- et sa cle etrangere avec elle), la contrainte de coherence est retiree puis reposee, et l index porte if not
-- exists. La verification apres coup n est pas facultative :
--   select indisvalid from pg_index where indexrelid = 'contacts_analyse_conversation_idx'::regclass;
-- false -> drop index concurrently contacts_analyse_conversation_idx, PUIS rejouer A LA MAIN l instruction
-- create index ci-dessous : si 0196 est deja inscrite dans schema_migrations, migrate ne recree RIEN.
--
-- DEUX TABLES VERROUILLEES, pas une : ajouter la cle etrangere prend aussi un verrou sur conversations. Lire
-- pg_stat_activity avant, pour les DEUX tables. Et lock_timeout : si une transaction longue tient l une d elles,
-- l instruction echoue au bout de 5 s au lieu d attendre en bloquant derriere elle tous les messages entrants.
-- Pose pour la session du runner (hors transaction, un set local n aurait aucun effet), retire a la fin.

set lock_timeout = '5s';

alter table contacts add column if not exists analyse_intention text
  constraint contacts_analyse_intention_check check (analyse_intention in ('demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'));

alter table contacts add column if not exists analyse_sentiment text
  constraint contacts_analyse_sentiment_check check (analyse_sentiment in ('positif', 'neutre', 'negatif'));

alter table contacts add column if not exists analyse_satisfaction smallint
  constraint contacts_analyse_satisfaction_check check (analyse_satisfaction between 0 and 10);

alter table contacts add column if not exists analyse_urgence smallint
  constraint contacts_analyse_urgence_check check (analyse_urgence between 0 and 10);

alter table contacts add column if not exists analyse_resolue boolean;

alter table contacts add column if not exists analyse_sujet text
  constraint contacts_analyse_sujet_check check (char_length(analyse_sujet) between 1 and 120);

alter table contacts add column if not exists analyse_traitee_par text
  constraint contacts_analyse_traitee_par_check check (analyse_traitee_par in ('humain', 'automatise', 'mba'));

alter table contacts add column if not exists analyse_action text
  constraint contacts_analyse_action_check check (analyse_action in ('creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'));

alter table contacts add column if not exists analyse_le timestamptz;

alter table contacts add column if not exists analyse_fenetre_fin timestamptz;

alter table contacts add column if not exists analyse_conversation_id uuid
  references conversations(id) on delete set null;

alter table contacts drop constraint if exists contacts_analyse_coherence_check;

alter table contacts add constraint contacts_analyse_coherence_check check (
  (analyse_le is null and analyse_fenetre_fin is null and analyse_intention is null and analyse_sentiment is null
    and analyse_satisfaction is null and analyse_urgence is null and analyse_resolue is null and analyse_sujet is null
    and analyse_traitee_par is null and analyse_action is null and analyse_conversation_id is null)
  or (analyse_le is not null and analyse_fenetre_fin is not null and analyse_intention is not null
    and analyse_sentiment is not null and analyse_resolue is not null and analyse_sujet is not null
    and analyse_traitee_par is not null and analyse_action is not null)
);

create index concurrently if not exists contacts_analyse_conversation_idx
  on contacts (analyse_conversation_id)
  where analyse_conversation_id is not null;

reset lock_timeout;
