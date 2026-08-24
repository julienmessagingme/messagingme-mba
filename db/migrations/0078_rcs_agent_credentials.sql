-- 0078_rcs_agent_credentials.sql : la clé d'API du canal RCS vit AVEC l'agent, pas dans l'environnement.
--
-- Jusqu'ici la clé smsmode était une variable d'env unique pour tout le serveur. Ça tient tant qu'il n'y a
-- qu'une marque. Dès le deuxième client, chaque marque a SON agent, SON canal et SA clé : la clé doit donc
-- être portée par le tenant, comme les credentials Meta le sont déjà (account/es-store).
--
-- Chiffrée au repos (src/crypto/secretbox.ts), jamais rendue en clair par l'API. La variable d'env reste un
-- REPLI : un tenant sans clé propre continue d'envoyer avec celle du serveur, donc rien ne casse.

alter table rcs_agents add column if not exists api_key_enc text;

-- Le nom d'affichage réel de l'agent tel que le provider le renvoie (« Messaging Me (TEST) »), et les quotas
-- lus chez le provider. Purement INFORMATIFS : rafraîchis à la vérification, jamais une source de vérité.
alter table rcs_agents add column if not exists display_name text;
alter table rcs_agents add column if not exists checked_at timestamptz;
