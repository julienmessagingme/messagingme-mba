-- 0112_agent_tour_en_vol.sql : savoir qu un tour d agent a COMMENCE et n a jamais fini.
--
-- Constat A1 de l audit externe du 2026-09-02, verifie dans le code. `prendreLeTour` incremente `tours`
-- AVANT le travail (c est ce qui rend le verrou optimiste atomique). Si le worker meurt entre les deux,
-- pg-boss rejoue le job avec l ANCIEN numero de tour, la reservation rend `null`, le rejeu est classe
-- « doublon » et sort sans rien faire. Le tour est alors perdu POUR TOUJOURS : la session reste `en_cours`,
-- le run reste `waiting` sur le bloc agent sans echeance, et le contact n a jamais de reponse.
--
-- 🔴 POURQUOI UNE COLONNE, ET PAS UNE DEDUCTION SUR L EXISTANT. On pouvait croire que « session en_cours +
-- run en attente + aucune echeance » suffisait a reconnaitre un tour mort. C est faux, et dangereux : c est
-- EXACTEMENT l etat d un tour qui vient d etre enfile et attend son passage dans la file. Le distinguer
-- demanderait de dater le debut du tour, et `derniere_activite` ne le fait pas (elle porte l instant du
-- tour PRECEDENT, qui peut remonter a des heures si le contact a mis du temps a repondre). Un balayage
-- construit sur cette deduction aurait donc tue des conversations vivantes.
--
-- La colonne dit une seule chose, et sans ambiguite : un tour est EN VOL depuis cet instant. Posee par
-- `prendreLeTour`, effacee des que le tour finit (qu il reponde, qu il perde la main, ou qu il clot).
--
-- 🔴 BLOQUANTE : `prendreLeTour` l ecrit a chaque tour, et c est le chemin chaud du bloc agent. Deployer
-- sans migrer ferait echouer TOUS les tours d agent. A passer AVANT le deploiement.

alter table agent_sessions add column if not exists tour_commence_le timestamptz;

-- Index PARTIEL sur les seules sessions qui portent un tour en vol : elles sont une poignee a tout instant,
-- alors que la table garde toutes les conversations closes. Le balayage n a donc jamais a lire l historique.
create index if not exists agent_sessions_tour_en_vol_idx
  on agent_sessions (tour_commence_le)
  where status = 'en_cours' and tour_commence_le is not null;
