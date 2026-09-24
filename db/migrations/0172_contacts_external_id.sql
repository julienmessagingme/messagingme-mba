-- migrate: no-transaction
-- 0172_contacts_external_id.sql : l'identifiant de l'outil du client, garde sur la fiche (API publique, lot 1).
--
-- POURQUOI. Un outil qui appelle l'API par contact designe ses profils par SON identifiant, et envoie
-- souvent le numero ET cet identifiant dans le meme corps. La fiche doit pouvoir etre retrouvee par lui,
-- et une reponse doit pouvoir le rendre a l'outil qui l'a donne. external_id n'est PAS une adresse : aucun
-- message ne part vers lui.
--
-- UNIQUE PAR ESPACE, ET PARTIEL : null est l'etat de presque toutes les fiches, et deux fiches sans
-- identifiant externe ne sont pas en conflit. C'est un CONTRAT avec la requete de chercherParCles
-- (external_id = $3, dont l'egalite implique is not null) : en sortir ne produirait aucune erreur, seulement
-- un balayage de contacts.
--
-- AUCUNE BORNE DE LONGUEUR EN BASE : la seule ecriture est l'API publique, qui refuse au-dela de 512
-- caracteres (MAX_EXTERNAL_ID, src/api/fiche.ts). Un CHECK sur cette table se paierait d'un balayage pour une
-- garde qui existe deja a la porte.
--
-- ADDITIVE : l'ancien code ne lit pas la colonne. Elle passe AVANT tout deploiement du code qui la lit : les
-- select de contacts la nomment, et sans elle la liste du mini-CRM, la fiche et findByPhone rendraient 42703.
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY) : l'index se construit sans bloquer les ecritures de contacts,
-- qui est sur le chemin de chaque message entrant. Aucun filet : un echec a mi-parcours laisse un index
-- invalid, et la migration rejouee le SAUTE (if not exists). La verification apres coup n'est pas facultative :
--   select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass;
-- false -> drop index concurrently contacts_tenant_external_id_uidx; puis rejouer. Precedent : 0115.
--
-- La purge RGPD remet la colonne a null (PgContactStore.purgeMany) : l'identifiant du client ne survit pas a
-- l'effacement, et il ne bloque pas la recreation d'une fiche avec le meme identifiant.

alter table contacts add column if not exists external_id text;

create unique index concurrently if not exists contacts_tenant_external_id_uidx
  on contacts (tenant_id, external_id)
  where external_id is not null;
