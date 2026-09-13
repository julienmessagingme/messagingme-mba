-- 0141 : retire `agents.mention_ia_frequence`, dont 0140 a deplace le contenu vers l ESPACE.
--
-- 🔴 ELLE S APPLIQUE APRES LE DEPLOIEMENT, ET C EST L INVERSE DE LA ROUTINE. La regle du depot n est pas
-- « ajoute avant, retire apres » : elle est « l ancien code survit-il a ce changement ? ». Ici non. Tant que
-- le code deploye lit encore cette colonne, la retirer ferait tomber CHAQUE lecture de fiche d agent en
-- `42703`, donc chaque tour d agent, pendant toute la duree du deploiement. Meme sequence que 0128, qui a
-- suivi 0129 pour la meme raison.
--
-- 🔴 ET LA QUESTION « QUI ECRIT ENCORE CECI ? » A ETE POSEE AVANT D ECRIRE CE FICHIER, pas apres l avoir
-- applique. C est la lecon de 0128, ou deux lecteurs restants (`PgUserStore.deleteUser` et trois fixtures
-- d integration) auraient fait tomber un chemin qu on n emprunte qu au depart d un collaborateur. Balayage
-- du 2026-09-13 sur `src/`, `db/`, `tests/` et `scripts/` : plus AUCUNE lecture ni ecriture de
-- `agents.mention_ia_frequence`. Les occurrences restantes du nom portent toutes sur `tenant_settings`, ou
-- sur la jointure qui y lit la politique de l espace. Aucune fixture n insere la colonne.
--
-- ⚠️ LA VALEUR N EST PAS PERDUE : 0140 l a reprise espace par espace, dans `tenant_settings`, avant que quoi
-- que ce soit ne cesse de la lire.

alter table agents drop constraint if exists agents_mention_ia_frequence_check;
alter table agents drop column if exists mention_ia_frequence;
