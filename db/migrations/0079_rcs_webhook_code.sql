-- 0079 : allonge le code d'URL des rappels RCS.
--
-- Ce code est ce qui AUTORISE un rappel smsmode : leur fournisseur ne signe pas ses appels (ni HMAC, ni
-- jeton d'en-tete), donc l'adresse elle-meme porte le secret, exactement comme les webhooks entrants de
-- Tools (0074, 130 bits). Les codes emis jusqu'ici faisaient 48 bits, choisis quand cette colonne n'etait
-- qu'un identifiant reserve a un usage futur.
--
-- Rotation SANS RISQUE : aucune adresse de rappel n'a encore ete remise a smsmode (l'endpoint n'existait
-- pas), et l'URL est reconstruite a CHAQUE envoi depuis cette colonne. Rien en circulation ne casse.
update rcs_agents
set webhook_code = 'rcs-' || encode(gen_random_bytes(16), 'hex')
where webhook_code !~ '^rcs-[0-9a-f]{32}$';
