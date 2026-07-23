-- 0043 : état du token business par WABA (B1 / bloc 4.1).
--
-- La résolution du token Meta PAR TENANT lit désormais waba_credentials.business_token_enc et le déchiffre à
-- l'envoi. Un token peut être révoqué (client qui retire l'app) ou expiré. On persiste son état pour :
--  (a) arrêter d'envoyer sur un token mort (au lieu de brûler des appels Graph),
--  (b) afficher « reconnectez votre numéro » dans la console.
-- Détection RÉACTIVE : au prochain appel Meta qui renvoie 190 / 401 / OAuthException, on marque 'invalid'.
-- ADD-only, ordre de déploiement normal. Rows existantes -> 'active' (le défaut).
alter table waba_credentials
  add column if not exists token_status text not null default 'active'
    check (token_status in ('active', 'invalid'));
alter table waba_credentials
  add column if not exists token_invalid_at timestamptz;
