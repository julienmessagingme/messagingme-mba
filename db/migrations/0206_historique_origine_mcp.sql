-- 0206 : l'historique des réglages accepte l'origine `mcp` (lot 8a, docs/superpowers/specs/2026-10-03-mcp-agent-ia-design.md).
-- Une modification de la fiche d'un agent IA faite par Claude Code, par le serveur MCP, se journalise sous son nom de
-- porte, à côté de `assistant` et `formulaire` (src/reglages/historique.ts, ORIGINES).
--
-- 🔴 ELLE RELÂCHE, DONC AVANT LE UP. Les outils MCP de l'agent (livraison B) écrivent `mcp` ; l'ancien code n'écrit
-- que les deux origines d'hier, que le CHECK élargi accepte toujours : il y survit. La livraison A n'écrit encore que
-- `formulaire` (chaque modification de fiche depuis la console), mais la migration part avec elle : le code qui
-- écrira `mcp` ne doit jamais précéder le CHECK qui l'accepte.
--
-- 🔴 LE NOM EST CELUI QUE 0146 A POSÉ, nommé dans son create table (reglages_historique_origine_chk), pas un nom
-- deviné. Un nom à côté laisserait l'ancien CHECK en place ET ajouterait le neuf : `mcp` serait refusé par le premier,
-- en silence jusqu'à la première écriture. Le drop et l'add sont dans la même transaction : aucune fenêtre sans CHECK.
--
-- ⚠️ LE VERROU. add constraint pose un ACCESS EXCLUSIVE sur reglages_historique le temps de relire ses lignes (une
-- table sans purge, mais petite) : les écritures d'historique attendent ce temps-là. Lire pg_stat_activity avant, et
-- lock_timeout : si une transaction tient la table, l'alter échoue au bout de 5 s ; on relance migrate, rien n'a été
-- appliqué.
set local lock_timeout = '5s';
alter table reglages_historique drop constraint if exists reglages_historique_origine_chk;
alter table reglages_historique add constraint reglages_historique_origine_chk
  check (origine in ('assistant', 'formulaire', 'mcp'));
