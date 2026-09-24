-- 0176_intentions_commerce.sql : trois intentions de plus pour l'analyse des conversations.
--
-- POURQUOI. Les six intentions de 0027 sont celles des services et de l'assurance : aucune ne dit « le
-- client veut acheter », ni « ou en est ma commande », ni « je veux renvoyer ce produit ». Chez un client de
-- commerce en ligne, ces conversations tombaient en `information`, `sav` ou `autre`, et le signal le plus
-- commercial de tous se perdait. Spec du 2026-09-24 (API publique coherente), paragraphe 7 : `achat`,
-- `suivi_commande`, `retour`.
--
-- 🔴 ELLE RELACHE, DONC L'ANCIEN CODE Y SURVIT, et elle passe AVANT le deploiement. La question n'est pas
-- « ajoute ou retire » mais « l'ancien code survit-il a ce changement ? » (regle corrigee au lot 0128) : le
-- code deploye continue d'ecrire les six valeurs d'hier, que le CHECK elargi accepte toujours. L'inverse
-- serait BLOQUANT et PAYANT : deployer d'abord ferait echouer en 23514 l'INSERT de toute analyse classee dans
-- une valeur neuve, et le job `analyze-conversation` la rejouerait, appel au modele compris, jusqu'a la DLQ.
--
-- 🔴 LE NOM DE LA CONTRAINTE A ETE LU EN BASE, pas devine (lecon de 0122, deja appliquee en 0166) :
-- `pg_constraint` sur `conversation_analysis` ne porte qu'UN CHECK sur l'intention,
-- `conversation_analysis_intent_check`, cree EN LIGNE par 0027 avec ses six valeurs. Un nom a cote
-- laisserait l'ancienne contrainte en place ET ajouterait la neuve, donc refuserait `achat` en silence : un
-- `if exists` ne protege que de l'absence, jamais de l'erreur de nom.
--
-- ⚠️ MESURE AVANT D'ECRIRE (2026-09-24 vers 22 h UTC, production, lecture seule) : 16 analyses, en
-- information (11), autre (4), prise_rdv (1). Le CHECK elargi contient l'ancien, donc aucune ligne ne peut
-- faire echouer son ajout, et la validation qu'il declenche parcourt une table minuscule.
--
-- ⚠️ AUCUNE LIGNE N'EST TOUCHEE : les analyses passees gardent leur intention d'origine (meme paragraphe
-- de la spec). La liste fait foi dans `INTENTS` (`src/analysis/schema.ts`), et
-- `tests/intentions-parite.test.ts` exige que le DERNIER CHECK ecrit dans ce dossier porte exactement ses
-- valeurs.

alter table conversation_analysis drop constraint if exists conversation_analysis_intent_check;
alter table conversation_analysis add constraint conversation_analysis_intent_check
  check (intent in ('demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'achat', 'suivi_commande', 'retour', 'autre'));
