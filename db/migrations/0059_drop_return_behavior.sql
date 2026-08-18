-- 0059_drop_return_behavior.sql : retire le choix explicite de destination à la reprise d'un fil.
--
-- POURQUOI la supprimer plutôt que la garder. Ce réglage demandait au client d'arbitrer une question dont la
-- réponse est DÉRIVABLE : après une prise en main humaine, un fil repart au scénario si une étape attend
-- encore un choix du client, sinon il revient à l'agent de Meta. Personne n'a besoin de configurer ça, et deux
-- niveaux de réglage (défaut de l'espace, surcharge par conversation) pour une valeur déductible sont deux
-- occasions de se contredire.
--
-- Ce qui la remplace : un seul réglage, le DÉLAI après lequel l'agent reprend la main
-- (`tenant_settings.control_handback_seconds`, migration 0041), qui existait déjà.
--
-- Le besoin réel qui restait derrière la valeur `inbox` (« ce fil reste à l'humain ») est couvert par le délai
-- réglé à 0, qui signifie déjà « aucune reprise automatique », pour tout l'espace.
--
-- ⚠️ Suppression FERME, décidée explicitement : aucune lecture ne subsiste dans le code au moment de cette
-- migration (le type `ReturnBehavior` et ses neuf lecteurs partent dans le même lot). Revenir à un choix
-- explicite demanderait de refaire la colonne ET les écrans.

alter table tenant_settings drop column if exists return_behavior;
alter table conversations   drop column if exists return_behavior;
