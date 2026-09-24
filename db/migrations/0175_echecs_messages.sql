-- 0175_echecs_messages.sql : l'échec de livraison d'un message LIBRE cesse de n'être écrit nulle part.
--
-- Spec 2026-09-24 (API publique cohérente), § 5, lot 3, « défaut 4 ». Le rapport de smsmode et les statuts
-- de Meta ne mettaient à jour que les destinataires de CAMPAGNE : une réponse de l'Inbox, un RCS libre ou
-- un message de l'API qui n'arrivait pas n'apparaissait ni dans Sécurité > Journal des erreurs, ni ailleurs.
--
-- 🔴 UNE TABLE, ET PAS UNE COLONNE DE STATUT SUR conversation_messages. Seuls les ÉCHECS sont écrits : la
-- table reste petite, sur le modèle des échecs d'avance de scénario (0108), et le fil de l'Inbox, relu toutes
-- les 4 secondes, ne gagne aucune jointure. Ce n'est pas un doublon : ces échecs n'avaient aucun domicile.
--
-- Les colonnes wa_id, canal et origine sont RECOPIÉES du message au moment de l'échec : la ligne reste
-- lisible sans jointure sur conversation_messages, et la lecture du journal n'en fait aucune.
--
-- 🔴 L'INDEX UNIQUE SUR message_id REND L'ÉCRITURE IDEMPOTENTE, et l'écriture en DÉPEND : pg-boss rejoue un
-- job de statuts en entier, et « on conflict (message_id) do nothing » exige une contrainte qui corresponde
-- à la cible du conflit (sans elle, l'insertion LÈVE). L'identifiant d'un message est unique dans toute la
-- base (conversation_messages_wamid_uidx, 0009).
--
-- 🔴 BLOQUANTE, À CAUSE DE LA PURGE RGPD. L'écriture est best-effort chez l'appelant et la lecture du journal
-- rend une liste vide si la table manque, mais PgContactStore.purgeMany efface les échecs de la personne DANS
-- SA transaction : sans la table, TOUTE purge de contact échouerait en entier (42P01), comme pour 0163. Donc
-- AVANT le déploiement, avec la migration précédente. L'ancien code ne la nomme pas et y survit.
--
-- Rétention : la même que les échecs d'avance (AVANCE_ECHECS_RETENTION_DAYS), par le balayage général du
-- worker. C'est de l'exploitation, pas une preuve.

create table if not exists echecs_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  message_id text not null,
  wa_id text not null,
  canal text not null,
  -- La colonne origin du message (humain, api, mcp, scenario, ia, mba). Nullable : un message d'avant 0099
  -- n'en porte pas.
  origine text,
  -- Code numérique de Meta. null pour un échec smsmode, qui n'en donne pas.
  code integer,
  motif text,
  at timestamptz not null default now()
);

create unique index if not exists echecs_messages_message_uidx on echecs_messages (message_id);

-- La lecture est toujours « les plus récents d'un espace » (journal des erreurs) : exactement cet index.
create index if not exists echecs_messages_tenant_at_idx on echecs_messages (tenant_id, at desc);
