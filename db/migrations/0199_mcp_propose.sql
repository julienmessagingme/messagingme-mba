-- 0199 : un outil MCP importé est-il PROPOSÉ aux agents de l'espace ? (Julien, 2026-10-02)
-- Deux étages désormais : sur Tools > Connecteurs MCP, on choisit quels outils du serveur sont proposés ; sur chaque
-- agent (l'agent de Meta, un agent IA), on choisit parmi cette liste. Un outil importé est proposé d'office, on
-- décoche ce qu'on ne veut pas. Décocher un outil qu'un agent utilise est refusé (`PgMcpStore.proposer`), et le
-- rattachement d'un outil non proposé aussi (`PgToolCatalog.rattacherConsommateur`).
-- La colonne vit sur toutes les lignes d'`agent_tools` et ne veut rien dire hors de `origin = 'mcp'` : un CHECK qui
-- la lierait à l'origine compliquerait chaque insertion d'outil maison ou de connecteur pour une valeur qu'on ne lit
-- jamais là.
-- Additive, défaut constant (instantané en Postgres 11 et plus) : l'ancien code l'ignore, elle passe AVANT le `up`.
alter table agent_tools add column if not exists mcp_propose boolean not null default true;
