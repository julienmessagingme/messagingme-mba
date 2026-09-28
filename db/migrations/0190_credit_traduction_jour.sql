-- 0190_credit_traduction_jour.sql : les traductions d'un jour font UNE ligne du journal de crédit.
--
-- POURQUOI. La traduction des conversations est débitée du crédit prépayé de l'espace, comme un tour d'agent
-- (décision de Julien du 2026-09-28). Une ouverture de fil peut lancer quarante traductions : une ligne par appel
-- noierait l'historique, et le client n'y verrait plus que ça. Le SOLDE bouge à chaque appel ; le JOURNAL garde une
-- ligne par espace et par jour, qui grossit.
--
-- LE JOUR est celui de Paris, posé par l'écriture (PgCreditStore.debiterTraduction). Il reste null sur toutes les
-- autres lignes (conso, recharge, offert), qui gardent une ligne par mouvement.
--
-- L'INDEX UNIQUE PARTIEL EST LE CONTRAT DE L'UPSERT. Le débit est un insert ... on conflict (tenant_id, jour)
-- where raison = 'traduction' do update : si le prédicat de l'index et celui de la clause divergent, Postgres ne
-- trouve plus d'index à inférer (42P10) et chaque traduction échoue à se débiter. Les deux textes sont comparés par
-- tests/migration-0190.test.ts. Aucune ligne existante ne porte la raison traduction : il se construit sans conflit.
--
-- TRANSACTIONNELLE, sans CONCURRENTLY : la table est petite (une ligne par session d'agent, par essai et par
-- recharge), le verrou de construction dure le temps d'un parcours de quelques milliers de lignes.
--
-- ADDITIVE : l'ancien code ignore la colonne et l'index (il n'écrit jamais la raison traduction). Elle passe AVANT
-- le déploiement du code qui l'écrit, sans quoi chaque traduction échouerait à se débiter (42703).
alter table agent_credit_mouvements add column if not exists jour date;

create unique index if not exists agent_credit_mouvements_traduction_jour_uidx
  on agent_credit_mouvements (tenant_id, jour)
  where raison = 'traduction';
