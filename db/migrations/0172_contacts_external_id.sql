-- migrate: no-transaction
-- 0172_contacts_external_id.sql : l'identifiant de l'outil du client, garde sur la fiche (API publique, lot 1).
--
-- POURQUOI. Un outil qui appelle l'API par contact designe ses profils par SON identifiant, et envoie
-- souvent le numero ET cet identifiant dans le meme corps. La fiche doit pouvoir etre retrouvee par lui,
-- et une reponse doit pouvoir le rendre a l'outil qui l'a donne. external_id n'est PAS une adresse : aucun
-- message ne part vers lui.
--
-- UNIQUE PAR ESPACE PARMI LES FICHES ACTIVES, ET PARTIEL : null est l'etat de presque toutes les fiches, et
-- deux fiches sans identifiant externe ne sont pas en conflit. Une fiche SUPPRIMEE ne retient plus son
-- identifiant (revue finale du 2026-09-24) : sinon elle le bloquerait pour toujours, invisible a toute lecture,
-- et une autre fiche portant ce meme identifiant serait refusee sans raison lisible. Ressusciter une fiche
-- supprimee dont l'identifiant a ete repris par une fiche active viole l'index : l'API le rend en conflit
-- d'identite. C'est un CONTRAT avec la recherche de fiche par cles du lot 1 (taches 4 et 6 de son plan :
-- external_id = $3 and deleted_at is null) : en sortir ne produirait aucune erreur, seulement un balayage.
--
-- AUCUNE BORNE DE LONGUEUR EN BASE : la seule ecriture est l'API publique (lot 1), qui refuse au-dela de 512
-- caracteres. Un CHECK sur cette table se paierait d'un balayage pour une garde qui existe deja a la porte.
--
-- ADDITIVE : l'ancien code ne lit pas la colonne. Elle passe AVANT tout deploiement du code qui la lit : les
-- select de contacts la nomment, et sans elle la liste du mini-CRM, la fiche et findByPhone rendraient 42703.
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY) : l'index se construit sans bloquer les ecritures de contacts,
-- qui est sur le chemin de chaque message entrant. Aucun filet : un echec a mi-parcours laisse un index
-- invalid, et la migration rejouee le SAUTE (if not exists). La verification apres coup n'est pas facultative :
--   select indisvalid from pg_index where indexrelid = 'contacts_tenant_external_id_uidx'::regclass;
-- false -> drop index concurrently contacts_tenant_external_id_uidx; PUIS rejouer A LA MAIN l'instruction
-- create unique index ci-dessous : si 0172 est deja inscrite dans schema_migrations, migrate repond a jour et
-- ne recree RIEN, on resterait sans index. Precedent : 0115.
--
-- La purge RGPD remettra la colonne a null (lot 1, tache 4) : l'identifiant du client ne survivra pas a
-- l'effacement.

alter table contacts add column if not exists external_id text;

create unique index concurrently if not exists contacts_tenant_external_id_uidx
  on contacts (tenant_id, external_id)
  where external_id is not null and deleted_at is null;
