-- Le graphe JOUÉ par un parcours de test, figé à son démarrage.
--
-- 🔴 ELLE RÉPARE UN DÉFAUT EXISTANT, ET PAS SEULEMENT LA NOUVELLE FONCTIONNALITÉ. Le test DÉMARRE sur le
-- brouillon (`startTestRun` passe `grapheEditable(wf)`) mais il REPRENAIT sur le publié : les trois points de
-- reprise de l'exécuteur (`resume`, `runEnAttenteSur`, `advance`) appellent `getGraph`, que le câblage résout
-- en `row.graph`. Un test qui atteignait un bloc d'attente et recevait une réponse changeait donc de version
-- EN SILENCE, et si son bloc courant n'existait pas dans le publié, le parcours se figeait sans un mot.
--
-- 🔴 NULLABLE, ET LE DÉFAUT EST `null`. Un parcours réel n'en porte AUCUN : figer le graphe de chaque
-- destinataire d'une campagne de 5 000 personnes recopierait 5 000 fois le même objet. `null` = on lit le
-- publié, c'est-à-dire exactement le comportement d'aujourd'hui pour tout ce qui n'est pas un test.
--
-- ⚠️ AUCUN INDEX, délibérément : cette colonne ne sert jamais un `where`, elle se lit par la clé primaire du
-- parcours qu'on vient de trouver. Un index dessus ne servirait aucune requête, et son absence dit au
-- prochain lecteur que personne ne cherche par ce champ.
--
-- ⚠️ RIEN À PURGER EN PLUS : `purgeTerminesOlderThan` supprime les parcours terminés, et le graphe figé part
-- avec eux. L'effacement d'un contact (`contact-store.pg.ts`) supprime déjà ses parcours par `wa_id`.

alter table workflow_runs add column if not exists graphe_fige jsonb;
