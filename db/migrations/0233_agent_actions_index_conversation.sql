-- migrate: no-transaction
-- 0233_agent_actions_index_conversation.sql : l index qui sert la cascade de agent_actions.conversation_id (actions de
-- l agent IA, plan docs/superpowers/plans/2026-10-13-actions-agent.md, relecture de la livraison A).
--
-- POURQUOI. 0232 a pose agent_actions avec une cle etrangere en cascade sur conversations, et un index qui commence par
-- tenant_id : il ne sert pas la cascade. Chaque conversation effacee (retention et purge, par lots) parcourrait alors
-- agent_actions en entier pour y trouver ses lignes. Celui-ci commence par conversation_id.
--
-- ADDITIVE ET SANS LECTEUR : aucun code ne le nomme, l ancien comme le nouveau survivent avec ou sans lui.
--
-- HORS TRANSACTION (CREATE INDEX CONCURRENTLY), une seule instruction, rejouable (if not exists). Verifier apres coup :
--   select indisvalid from pg_index where indexrelid = 'agent_actions_conversation_fk_idx'::regclass;
-- false -> drop index concurrently agent_actions_conversation_fk_idx, PUIS rejouer A LA MAIN l instruction ci-dessous :
-- si 0233 est deja inscrite dans schema_migrations, migrate ne recree RIEN.

create index concurrently if not exists agent_actions_conversation_fk_idx on agent_actions (conversation_id);
