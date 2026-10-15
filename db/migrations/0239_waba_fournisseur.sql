-- 0239 : le fournisseur d'un compte WhatsApp (360dialog, lot 2, livraison A ; plan
-- docs/superpowers/plans/2026-10-15-360dialog-lot2-envoi.md).
--
--  - waba_credentials.fournisseur : 'meta' (Embedded Signup, le jeton business parle à graph.facebook.com) ou
--    '360dialog' (business_token_enc porte alors la cle d'API du NUMERO, qui parle a waba-v2.360dialog.io). Le
--    resolveur refuse de rendre une cle 360dialog a qui parle a Meta : la confondre avec un jeton ferait partir un
--    appel Graph qui echoue, et un 401 invaliderait la cle.
--
-- ELLE AJOUTE SEULEMENT, AVEC UN DEFAUT, DONC AVANT LE UP : l'ancien code ne la lit pas, et toutes les lignes
-- existantes valent 'meta'. Colonne a defaut constant : aucune reecriture de la table.
set local lock_timeout = '5s';

alter table waba_credentials
  add column if not exists fournisseur text not null default 'meta'
    constraint waba_credentials_fournisseur_chk check (fournisseur in ('meta', '360dialog'));
