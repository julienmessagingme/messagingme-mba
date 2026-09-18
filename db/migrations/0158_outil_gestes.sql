-- 0158 : les GESTES d'un moment, ce que NOUS faisons sans le demander au modèle.
--
-- 🔴 CE QUE ÇA RÉPARE. « Quand le client veut un rendez-vous », le client veut appeler son ERP ET poser un
-- tag. Aujourd'hui les deux sont des OUTILS, donc deux surfaces exposées au modèle qui décrivent la MÊME
-- situation : il en choisit une, ou les deux, ou aucune. Le moment porte désormais UNE réponse principale,
-- que le modèle appelle, et des GESTES que nous exécutons nous-mêmes. Le modèle ne voit qu'un outil par
-- situation, et les effets de bord cessent de dépendre de son humeur.
--
-- 🔴 ILS SONT INDÉPENDANTS DE LA RÉUSSITE DE LA RÉPONSE (arbitrage de Julien, 2026-09-18) : un geste marque
-- que la SITUATION s'est produite, pas que l'appel a réussi. Le contact a bien demandé un rendez-vous même
-- si l'ERP n'a pas répondu, et c'est ce tag-là qui permet de rattraper à la main.
--
-- Forme, validée par `src/agent/gestes.ts` et jamais par la base :
--   [{"type":"tag","valeur":"rdv_demande"}, {"type":"variable","champ":"origine","valeur":"agent"}]
--
-- ⚠️ AUCUN CHECK SUR LE CONTENU DU JSONB, ET C'EST DÉLIBÉRÉ. Un CHECK qui décrirait la forme d'un geste
-- serait une SECONDE vérité à côté du schéma Zod, et les deux divergeraient au premier type de geste ajouté.
-- La base garantit ce qu'elle sait garantir : que la colonne est un tableau jsonb et qu'elle existe.
-- La lecture, elle, retombe sur AUCUN geste plutôt que de lever : un jsonb corrompu ne doit pas rendre un
-- agent muet sur le chemin de chaque message.
--
-- ⚠️ `'[]'` PAR DÉFAUT ET `NOT NULL` : « aucun geste » est l'état de TOUS les outils existants, et c'est
-- exactement leur comportement d'aujourd'hui. Cette migration ne change donc rien pour personne.
--
-- Migration ADDITIVE, d'une colonne que le code ÉCRIT : à appliquer AVANT le déploiement.
alter table agent_tools
  add column if not exists gestes jsonb not null default '[]'::jsonb;

alter table agent_tools drop constraint if exists agent_tools_gestes_tableau_chk;
alter table agent_tools add constraint agent_tools_gestes_tableau_chk
  check (jsonb_typeof(gestes) = 'array');
