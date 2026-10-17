-- migrate: no-transaction
-- 0242_conversations_index_remise_mba.sql : l index qui sert la consommation de la remise a l agent de Meta, jouee
-- pour CHAQUE accuse de Meta (consommerReleaseMba, src/inbox/store.pg.ts, CONSOMMER_REMISE_MBA_SQL).
--
-- POURQUOI. 0149 a pose conversations.release_mba_apres_message sans index, en supposant une ligne deja designee.
-- Or la requete cherche PAR CETTE COLONNE (where release_mba_apres_message = l identifiant du message) : sans index,
-- chaque accuse relit toute la table des conversations. Mesure au banc des accuses du 2026-10-17 (journal technique) :
-- 5 a 8 ms par accuse a 62 000 conversations, 0,013 ms avec cet index, et la file des statuts passe d environ 16
-- numeros a plein debit a au moins 24.
--
-- PARTIEL. Presque toutes les conversations ont la colonne a null (une remise est rare et vite consommee) : l index
-- ne porte que les lignes qui ont une valeur, donc il reste minuscule et ne coute qu a ces rares ecritures. Il sert
-- la requete parce qu une egalite implique que la colonne n est pas nulle : le planificateur le prouve seul. Le test
-- d integration le verifie sur l instruction du code.
--
-- ADDITIVE ET SANS LECTEUR : aucun code ne le nomme, l ancien comme le nouveau survivent avec ou sans lui.
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY), une seule instruction, rejouable (if not exists). Verifier apres coup :
--   select indisvalid from pg_index where indexrelid = 'conversations_release_mba_idx'::regclass;
-- false -> drop index concurrently conversations_release_mba_idx, PUIS rejouer A LA MAIN l instruction ci-dessous :
-- si 0242 est deja inscrite dans schema_migrations, migrate ne recree RIEN.

create index concurrently if not exists conversations_release_mba_idx
  on conversations (release_mba_apres_message)
  where release_mba_apres_message is not null;
