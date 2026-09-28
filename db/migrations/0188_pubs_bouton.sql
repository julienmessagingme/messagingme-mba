-- 0188_pubs_bouton.sql : le bouton choisi dans un brouillon de publicite.
--
-- POURQUOI. Une publicite Click-to-WhatsApp peut desormais porter un autre bouton que "Envoyer un message
-- WhatsApp" ("En savoir plus", "Obtenir un devis"...). Le brouillon doit garder ce choix, sinon on le rouvre
-- et il retombe sur le bouton par defaut sans que personne ne l'ait decide.
--
-- DU TEXTE, AVEC LE DEFAUT QUE META DOCUMENTE, ET SANS CHECK, deliberement. La liste des boutons est une
-- HYPOTHESE que la premiere creation reelle tranche (seul WHATSAPP_MESSAGE est documente cote API pour cette
-- destination) : elle vit a UN endroit, BOUTONS_PUB dans src/meta/pubs-payloads.ts, et la route la tient en
-- enumeration fermee. Un CHECK en serait une seconde copie, qu'il faudrait migrer en meme temps que le code a
-- chaque retouche ; oublie, il ferait echouer l'enregistrement d'un brouillon en 500. Une valeur que la liste ne
-- connait plus se relit comme le defaut (PgBrouillonsPubStore) : un brouillon ne depense rien.
--
-- ADDITIVE : une colonne a defaut constant (aucune reecriture de la table), que l'ancien code ignore ; ses
-- insertions prennent le defaut. Elle passe AVANT le deploiement du code qui la lit : le select des brouillons
-- la nomme, donc sans elle la liste des brouillons tomberait en 42703.

alter table pubs_brouillons add column if not exists bouton text not null default 'WHATSAPP_MESSAGE';
