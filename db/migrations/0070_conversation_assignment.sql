-- 0070 : affectation d'une conversation à un membre de l'équipe.
--
-- 🔴 À NE PAS CONFONDRE AVEC `control_owner` (migration 0040). Ce sont deux dimensions INDÉPENDANTES :
--
--   control_owner  -> QU'EST-CE QUI parle : le scénario, un humain, ou l'agent de Meta.
--   assigned_to    -> QUEL HUMAIN en a la charge.
--
-- Une conversation peut être affectée à quelqu'un ET tenue par le scénario : l'affectation ne prend le fil à
-- personne, elle dit qui s'en occupe. Les mélanger casserait le gel de scénario construit en août.
--
-- `on delete set null` : un membre désactivé puis supprimé ne doit pas emporter la conversation avec lui.
-- Elle redevient simplement non affectée, donc ouverte à tous, ce qui est le comportement le plus sûr : une
-- conversation que plus personne ne peut prendre serait invisible et sans réponse.
--
-- `assigned_by` garde QUI a affecté, et pas seulement à qui : c'est ce qui permet à un manager de savoir si
-- une conversation lui a été confiée ou s'il se l'est attribuée.
--
-- Migration ADDITIVE : à appliquer AVANT le déploiement du code.
alter table conversations
  add column if not exists assigned_to  uuid references users (id) on delete set null,
  add column if not exists assigned_at  timestamptz,
  add column if not exists assigned_by  uuid references users (id) on delete set null;

-- « Les conversations qui me sont affectées » est le filtre le plus consulté d'un agent : il doit être servi
-- par un index dès le premier jour, pas quand la lenteur se verra. Partiel : les conversations non affectées
-- sont la majorité et n'ont rien à faire dans cet index.
create index if not exists conversations_assigned_idx
  on conversations (tenant_id, assigned_to, last_message_at desc)
  where assigned_to is not null;
