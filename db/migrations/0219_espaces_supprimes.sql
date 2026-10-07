-- 0219 : la trace des espaces supprimes (RC8, plan docs/superpowers/plans/2026-10-06-rc8-supprimer-un-espace.md).
--
-- L'exploitation supprime DEFINITIVEMENT un espace depuis /ops (DELETE /ops/espaces/:tenantId, src/ops/suppression-espace.ts).
-- Une ligne par espace supprime, ecrite DANS la transaction de la purge, apres le delete from tenants :
--  - tenant_id : l'identifiant de l'espace disparu, cle primaire. AUCUNE cle etrangere, deliberement : l'espace n'existe
--    plus, et une cle vers tenants ferait echouer la purge elle-meme.
--  - nom, cree_le : ce que l'espace etait, pour qu'un humain s'y retrouve.
--  - supprime_le, par : quand, et l'adresse de l'exploitant (la meme signature que les autres ecritures de /ops).
--  - etapes : le deroule des etapes chez les tiers (cle Vercel, agent de Meta, compte WhatsApp, Salesforce, HubSpot,
--    numero fourni) et leur resultat. comptes : les nombres de lignes purgees. AUCUNE donnee client : ni adresse, ni
--    numero, ni contenu de message.
--
-- 🔴 ELLE SERT AUSSI DE PIERRE TOMBALE. Un job de file d'un espace supprime (campagne, tour d'agent, analyse) qui echoue
-- apres la purge est abandonne en silence s'il nomme un espace de cette table (PgBossQueue.work, src/queue/pgboss.ts) :
-- sans elle, chacun finirait dans la file des morts. Ecrite dans la meme transaction que la purge, elle existe des que
-- l'espace a disparu, jamais avant.
--
-- Une table NEUVE que seul le code neuf ecrit et lit : AVANT le up de l'API et des deux workers, sans risque pour
-- l'ancien code. Aucune table existante n'est nommee, donc aucun verrou a craindre.
create table if not exists espaces_supprimes (
  tenant_id   uuid primary key,
  nom         text not null,
  cree_le     timestamptz,
  supprime_le timestamptz not null default now(),
  par         text not null,
  etapes      jsonb not null,
  comptes     jsonb not null
);
