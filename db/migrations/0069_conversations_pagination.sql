-- 0069 : index de pagination de l'inbox.
--
-- La liste des conversations était plafonnée à 100 SANS pagination, et les filtres de l'écran (« À traiter »,
-- et demain l'affectation) travaillaient en mémoire sur ces 100. Passé la centième conversation, ces filtres
-- ne mentaient pas un peu : ils ignoraient purement et simplement le reste, sans rien signaler.
--
-- L'inbox se lit toujours du message le plus récent au plus ancien, par tenant. `id` complète la clé de tri
-- pour départager deux conversations dont le dernier message porte le même horodatage : sans lui, la
-- pagination par curseur pourrait sauter ou répéter une ligne à la frontière d'une page.
--
-- Migration ADDITIVE : à appliquer AVANT le déploiement du code.
create index if not exists conversations_tenant_recent_idx
  on conversations (tenant_id, last_message_at desc, id desc);
