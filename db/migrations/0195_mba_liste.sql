-- 0195_mba_liste.sql : la memoire de la liste de l'agent de Meta, une ligne par contact que la plateforme lui a
-- confie.
--
-- POURQUOI. L'agent de Meta est desormais toujours en mode liste (ai_audience = ALLOWLISTED_ONLY) : un contact
-- absent de sa liste ne l'entend jamais, meme quand Meta lui a rendu le fil. C'est le seul interrupteur par
-- contact que Meta nous donne, et c'est la plateforme qui le tient : elle ajoute un contact quand elle confie la
-- conversation a l'agent, et le retire avant tout modele et a toute reprise deliberee (src/mba/liste.ts).
--
-- POURQUOI UNE TABLE. Meta ne rend l'identifiant d'une entree qu'a l'ajout, et sans lui on ne peut pas retirer.
-- Relire toute la liste chez Meta avant chaque modele ne tiendrait pas quand elle grossit ; la table repond par
-- sa cle primaire, avant chaque modele et a l'arrivee de chaque message en standby.
--
-- LES COLONNES.
--  - wa_id : chiffres nus, comme conversations.wa_id et le destinataire d'un envoi ramene aux chiffres ;
--  - phone_number_id : le numero sur lequel l'entree a ete creee, celui qu'il faudra nommer pour la retirer ;
--  - entree_id : l'identifiant rendu par Meta a l'ajout.
-- La ligne s'ecrit APRES l'ajout chez Meta : une entree sans ligne serait un contact sur la liste que plus rien ne
-- retire.
--
-- CLE PRIMAIRE (tenant_id, wa_id) ET AUCUN AUTRE INDEX : les deux lectures (avant un modele, a l'arrivee) passent
-- par elle. La cascade depuis l'espace suit la regle des tables par espace ; la purge d'un contact supprime sa
-- ligne dans sa propre transaction et retire l'entree chez Meta ensuite (PgContactStore.purgeMany).
--
-- ADDITIVE, DONC AVANT LE DEPLOIEMENT. Elle cree une table que le code neuf lit sur le chemin chaud (chaque
-- modele, chaque standby) : deploye avant elle, chaque envoi de modele echouerait en 42P01. L'ancien code
-- l'ignore. Elle nait vide, comme la liste du numero chez Meta.
create table if not exists mba_liste (
  tenant_id       uuid not null references tenants (id) on delete cascade,
  wa_id           text not null,
  phone_number_id text not null,
  entree_id       text not null,
  ajoute_le       timestamptz not null default now(),
  primary key (tenant_id, wa_id)
);
