-- 0154_grille_prix_espace.sql : ce que l'espace FACTURE, la ou Meta dit ce qu'il COUTE.
--
-- 🔴 DES PRIX DE VENTE, PAS DES COUTS, et c'est la decision qui explique cette migration (tranchee avec
-- Julien le 2026-09-17). Le tarif des templates est lu chez Meta par API ; le message de service, le RCS
-- simple et le RCS conversationnel ne viennent d'AUCUNE API et doivent etre saisis quelque part. Les mettre
-- en variables d'environnement aurait impose le meme tarif a tous les clients et demande un deploiement
-- pour changer un prix, alors que le tarif smsmode se negocie et qu'un grand compte ne se facture pas
-- comme un petit.
--
-- 🔴 UNE MARGE SUR LE TARIF META, PAS UNE GRILLE DE PRIX DE TEMPLATE. Meta change ses tarifs par pays et par
-- periode : une grille saisie a la main aurait derive en silence, en restant parfaitement plausible, et
-- c'est le pire mode de panne pour un chiffre sur lequel un client construit un budget. La marge garde Meta
-- comme source unique et n'a rien a resynchroniser.
--
-- ⚠️ DES DEFAUTS QUI NE CHANGENT RIEN, ET C'EST LE POINT LE PLUS IMPORTANT DE CETTE MIGRATION. Marge a 100,
-- donc le prix facture EGALE le tarif Meta tant que personne n'a rien regle. Un defaut qui margerait tout
-- seul ferait bouger un chiffre que des clients ont deja lu, sans que personne ne l'ait demande.
--
-- ⚠️ `prix_service_depuis` EST UNE DATE D'EFFET, ET ELLE N'EST PAS DECORATIVE. Meta ne facture les messages
-- de service qu'a partir du 2026-10-01 (2,48 centimes en France, apres une franchise de 1000 par mois).
-- Sans cette borne, rejouer une periode de septembre facturerait des messages qui etaient GRATUITS, et le
-- total d'un mois passe changerait selon le jour ou on le regarde.
--
-- ⚠️ LA FRANCHISE EST PAR ESPACE ET PAS PAR NUMERO, ET C'EST UNE CONTRAINTE DE DONNEE, PAS UN CHOIX DE
-- CONFORT. Chez Meta elle se compte par numero WhatsApp ; ici, NI `conversations` NI
-- `conversation_messages` ne porte de numero d'emission, donc un message de service n'est rattachable a
-- aucun numero. Mesure le 2026-09-17 : chaque espace porte exactement UN numero, donc les deux comptes
-- coincident aujourd'hui. Le jour ou un espace en aura deux, cette colonne SURFACTURERA et il faudra
-- d'abord poser le numero sur le message. Le piege est nomme ici plutot que laisse a decouvrir.
--
-- 🔴 BLOQUANTE : le code lit ces six colonnes des le deploiement. Elle passe donc AVANT (cf. CLAUDE.md,
-- section Deploiement). Elle n'est PAS appliquee au moment ou ce fichier est ecrit : le DATABASE_URL du
-- poste de travail pointe sur la PRODUCTION, et une migration s'applique sur le VPS, image construite
-- d'abord (`compose build mba-api`, puis `compose run --rm --no-deps mba-api npm run migrate`).

-- 🔴 `numeric(6,2)` ET PAS `smallint`, ET LE CHOIX A ETE CORRIGE AVANT L APPLICATION. Un `smallint`
-- interdisait une marge de 120,5 %, c est-a-dire +20,5 %, qui est une marge commerciale banale. Pire : la
-- validation applicative le refusait avec « valeur refusee » sans pouvoir expliquer pourquoi, puisque la
-- valeur EST dans les bornes annoncees (1 a 1000). On retrecissait le produit pour tenir un type choisi
-- sans y penser. La migration n'etant pas encore appliquee, l'elargir ne coute rien. Releve a la quatrieme
-- revue du 2026-09-18.
alter table tenant_settings add column if not exists prix_marge_template     numeric(6,2) not null default 100;
alter table tenant_settings add column if not exists prix_service_centimes   numeric(6,2) not null default 2.48;
alter table tenant_settings add column if not exists prix_service_franchise  integer      not null default 1000;
alter table tenant_settings add column if not exists prix_service_depuis     date         not null default date '2026-10-01';
alter table tenant_settings add column if not exists prix_rcs_centimes       numeric(6,2) not null default 6.00;
alter table tenant_settings add column if not exists prix_rcs_conv_centimes  numeric(6,2) not null default 8.00;

-- Une marge de 0 vaudrait « gratuit », une marge negative n'a aucun sens, et au-dela de 1000 % c'est une
-- faute de frappe qu'on prefere refuser a l'ecriture plutot que de voir sortir sur la facture d'un client.
alter table tenant_settings drop constraint if exists tenant_settings_marge_chk;
alter table tenant_settings add constraint tenant_settings_marge_chk
  check (prix_marge_template between 1 and 1000);

-- Un prix negatif n'existe pas, et un plafond haut attrape la virgule oubliee (248 au lieu de 2,48).
alter table tenant_settings drop constraint if exists tenant_settings_prix_chk;
alter table tenant_settings add constraint tenant_settings_prix_chk
  check (prix_service_centimes >= 0 and prix_service_centimes <= 100
     and prix_rcs_centimes >= 0 and prix_rcs_centimes <= 100
     and prix_rcs_conv_centimes >= 0 and prix_rcs_conv_centimes <= 100
     and prix_service_franchise >= 0);
