-- 0184_mfa_blocage.sql : le compteur d'echecs du second facteur, en base.
--
-- POURQUOI EN BASE. Le plafond de 5 essais par minute vit en memoire : il repart a zero a chaque redemarrage et ne
-- borne pas le total, donc qui a le mot de passe d'un admin pouvait essayer environ 7 200 codes par jour. Ici, chaque
-- serie de 5 echecs consecutifs bloque le code de l'application pour une duree qui double (15 min, 30 min, ... 24 h
-- au plus), et un succes remet le compteur a zero. Les codes de secours restent acceptes pendant un blocage : 80 bits
-- ne se devinent pas, et c'est la porte du vrai titulaire.
--
-- ADDITIVE : compteur a 0 et aucun blocage, l'etat de tout le monde. Elle passe AVANT le deploiement du code qui la lit.

alter table identities add column if not exists mfa_echecs integer not null default 0;
alter table identities add column if not exists mfa_bloque_jusqua timestamptz;
