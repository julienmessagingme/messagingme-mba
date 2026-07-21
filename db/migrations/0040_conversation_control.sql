-- 0040_conversation_control.sql : qui DÉTIENT une conversation, et donc qui répond au client.
--
-- Trois détenteurs exclusifs :
--   'app_workflow' = notre côté en automatique (scénario, campagne). C'est le seul état qui autorise
--                    l'avance ou le démarrage d'un scénario.
--   'app_human'    = un opérateur est engagé depuis l'inbox.
--   'mba'          = l'agent de Meta tient le fil. Écrit UNIQUEMENT par un webhook `messaging_handovers`
--                    réellement reçu, jamais déduit d'une de nos propres actions.
--
-- Pourquoi cette colonne : aujourd'hui rien n'empêche un opérateur qui répond dans l'inbox et un scénario
-- qui continue d'écrire au client EN MÊME TEMPS. `processWorkflowAdvance` avance sur tout message entrant
-- sans regarder si un humain a repris la main. C'est un bug de production, indépendant de MBA, que MBA ne
-- ferait qu'aggraver en ajoutant un troisième émetteur.
--
-- DÉFAUT 'app_workflow' : reproduit EXACTEMENT le comportement actuel (le scénario avance toujours), donc
-- la migration seule ne change le sort d'aucune conversation et ne gèle rétroactivement aucun run en
-- attente. Choisir 'app_human' par défaut aurait figé tous les parcours en cours au déploiement.
--
-- ADD-only. Migrer AVANT de déployer le code neuf (le store lit ces colonnes).
alter table conversations
  add column if not exists control_owner text not null default 'app_workflow'
    check (control_owner in ('app_workflow', 'app_human', 'mba'));

-- Instant de la dernière BASCULE de détenteur (pas de la dernière activité). C'est ce que balaie le
-- garde-fou d'inactivité pour rendre la main. Nullable et SANS default : une conversation qui n'a jamais
-- basculé n'a pas de date de bascule, et poser now() mentirait sur des conversations antérieures.
alter table conversations add column if not exists control_changed_at timestamptz;

-- Le balayage doit récupérer TOUT état non rendu, pas seulement 'app_human'. Une conversation passée à
-- 'mba' que rien ne ramènerait serait bloquée définitivement, sans autre remède qu'un UPDATE manuel en
-- production. Règle : tout état dans lequel on entre doit avoir un chemin de sortie.
create index if not exists conversations_control_held_idx
  on conversations (control_changed_at) where control_owner <> 'app_workflow';

-- BACKFILL BORNÉ À 24 H.
--
-- Sans backfill, une conversation actuellement traitée par un humain naît 'app_workflow' : le bug
-- ci-dessus persiste sur elle jusqu'à la prochaine action humaine (qui la corrigera). Avec un backfill
-- total, on gèlerait des scénarios dont un opérateur a écrit il y a six mois et qui tournent très bien
-- depuis. La fenêtre de 24 h vise les conversations où quelqu'un est PROBABLEMENT encore engagé.
--
-- `control_changed_at` reçoit la date du message humain, PAS now() : sinon le garde-fou d'inactivité
-- repartirait de zéro au déploiement et laisserait ces conversations gelées une période complète de plus.
update conversations c
set control_owner = 'app_human',
    control_changed_at = h.last_human_at
from (
  select m.conversation_id, max(m.created_at) as last_human_at
  from conversation_messages m
  where m.direction = 'out'
    and m.sender_user_id is not null
    and m.created_at > now() - interval '24 hours'
  group by m.conversation_id
) h
where c.id = h.conversation_id
  and c.control_owner = 'app_workflow'
  -- Seulement si le CLIENT n'a pas répondu après : dans ce cas l'échange a repris son cours normal et il
  -- n'y a pas lieu de geler.
  --
  -- `direction = 'in'` est essentiel et son absence serait un contresens : sans lui, un message SORTANT
  -- automatisé postérieur au message humain exclurait aussi la conversation du gel. Or ce cas précis est
  -- le symptôme du bug qu'on corrige (un humain répond, le scénario réécrit derrière). On protégerait
  -- alors tout le monde SAUF les conversations où le problème s'est déjà produit.
  and not exists (
    select 1 from conversation_messages m2
    where m2.conversation_id = c.id
      and m2.direction = 'in'
      and m2.created_at > h.last_human_at
  );
