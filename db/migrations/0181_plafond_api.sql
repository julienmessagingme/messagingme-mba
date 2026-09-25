-- 0181_plafond_api.sql : le plafond de l'API publique PAR ESPACE, reglable espace par espace (decision de Julien
-- du 2026-09-25).
--
-- POURQUOI. Le plafond etait compte PAR CLE (60 appels par minute) : un espace qui creait dix cles avait dix fois
-- le debit. Il est desormais COMMUN a toutes les cles d'un espace (/v1 et /mcp), sur deux fenetres qui
-- s'appliquent ensemble, 60 appels par minute ET 1 000 par heure par defaut. La cle du relais du Meta Business
-- Agent n'y entre pas (elle garde son compteur par cle) : aucune colonne ici ne la concerne.
--
-- DEUX COLONNES NULLABLES, SANS DEFAUT : null = le defaut de la configuration (API_PLAFOND_MINUTE et
-- API_PLAFOND_HEURE). Un defaut ecrit en base figerait la valeur du jour dans chaque ligne, et relever le
-- plafond de tous les espaces demanderait alors une reprise de donnees au lieu d'une variable.
--
-- UN CHECK > 0 PAR COLONNE : un plafond a 0 voudrait dire « aucun plafond » dans la configuration, et un
-- reglage d'espace ne doit pas pouvoir ouvrir l'API en grand par une faute de frappe. Retirer un reglage, c'est
-- ecrire null. Les contraintes sont posees AVEC la colonne : if not exists saute le tout quand la colonne existe
-- deja, donc la migration se rejoue sans erreur.
--
-- ADDITIVE, ET ELLE PASSE AVANT LE DEPLOIEMENT DU CODE QUI LA LIT. L'ancien code ne la connait pas (la lecture
-- des reglages est un select etoile, qui la ramene sans la nommer). Le code neuf la NOMME dans deux requetes :
-- la lecture du plafond (sur le chemin de chaque appel, mais qui retombe sur le defaut si la colonne manque) et
-- la route d'exploitation qui la regle (qui rendrait 42703 sans elle).

alter table tenant_settings add column if not exists api_plafond_minute integer
  constraint tenant_settings_api_plafond_minute_positif check (api_plafond_minute > 0);

alter table tenant_settings add column if not exists api_plafond_heure integer
  constraint tenant_settings_api_plafond_heure_positif check (api_plafond_heure > 0);
