-- 0089_campaign_run_locks.sql — R1-bis : le verrou applicatif qui remplace la déduplication de file inexistante.
-- ADD-only (une table neuve) : à migrer AVANT le déploiement du code neuf.
--
-- POURQUOI. Le dépôt croyait qu'un `singletonKey` empêchait deux jobs `campaign-run` vivants pour la même
-- campagne. Il n'a jamais rien dédupliqué : pg-boss ne déduplique sur `singleton_key` que via des index uniques
-- PARTIELS, tous filtrés sur une policy de file, et nos files sont créées en `standard` (cf. R1, 2026-08-31).
-- Deux runs concurrents ne font recevoir personne deux fois (le claim par destinataire tient), mais chacun a SON
-- limiteur de débit en mémoire : le débit réel est multiplié d'autant, ce qui grille un numéro neuf en palier 250.
-- Et on ne peut pas rattraper en posant une policy : elle est IMMUABLE après création de la file.
--
-- LE BAIL. `expires_at` est ce qui rend le verrou reprenable après un `docker compose up` qui tue le worker en
-- plein envoi (SIGKILL à 10 s, cf. R4) : sans lui la campagne resterait verrouillée pour toujours. Il est
-- dimensionné sur la MÊME estimation que l'expiration du job pg-boss (`campaignJobExpireSeconds`), pour que les
-- deux mécanismes lâchent prise au même moment au lieu de se contredire.
--
-- `holder` est un JETON DE GARDE, pas une décoration : si notre bail a expiré et qu'un autre run a repris le
-- verrou, notre libération ne doit PAS supprimer le sien. Sans ce jeton, l'expiration du bail créerait exactement
-- la concurrence que cette table existe pour empêcher.
--
-- `rerun` coalesce le travail refusé. Un job écarté parce qu'un run tenait le verrou peut porter du travail que
-- le run en cours ne verra pas (il a pris son instantané de destinataires à son démarrage) : un destinataire
-- remis en attente par « Renvoyer », ou par l'auto-relance F6. Sans ce drapeau il resterait `pending` à vie sur
-- une campagne passée `completed`. Le tenant du verrou relance donc UNE fois en sortant.
create table if not exists campaign_run_locks (
  campaign_id  uuid primary key references campaigns(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  holder       text not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  rerun        boolean not null default false
);
