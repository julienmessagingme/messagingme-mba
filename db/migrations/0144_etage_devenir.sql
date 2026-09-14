-- CE QUI SE PASSE QUAND LE CONTACT RÉPOND, ÉTAGE PAR ÉTAGE.
--
-- 🔴 LA QUESTION EXISTAIT DÉJÀ À L'ÉCRAN, ET DEUX DE SES TROIS RÉPONSES N'ALLAIENT NULLE PART. Mesuré le
-- 2026-09-14 et décrit dans `todo.md` : seul « la conversation arrive dans l'Inbox » avait une traduction
-- serveur (`campaigns.assignation`). « L'agent de Meta prend la main » et « Un agent IA prend la main »
-- ne quittaient pas le navigateur, alors que le second fait CHOISIR un agent précis dans une liste. Le
-- produit s'interdit ce motif ailleurs (un canal sans agent RCS est grisé AVEC sa raison plutôt que
-- d'accepter un choix sans effet).
--
-- 🔴 PAR ÉTAGE ET PAS PAR CAMPAGNE, demandé par Julien le 2026-09-14 : « si la personne dit Modèle +
-- scénario, tu ne fais pas apparaître cette question, et si elle choisit modèle tu fais apparaître la
-- question, qui s'appliquera alors QUE pour le WhatsApp, et ensuite tu passes à l'étage 2 ». Une chaîne de
-- repli peut donc servir un modèle seul en WhatsApp (dont les réponses vont à l'équipe) et un scénario en
-- RCS (qui décide lui-même). Porter le devenir sur `campaigns` ne saurait pas exprimer ça.
--
-- ⚠️ L'ASSIGNATION RESTE SUR LA CAMPAGNE, et ce n'est pas une inconséquence. « Qui, dans l'équipe » est une
-- politique de campagne, et le tour de rôle compte ses réponses sur un rang unique
-- (`campaigns.tour_de_role_rang`) : un rang par étage ferait tourner deux roulements indépendants sur la
-- même équipe, donc servirait deux fois la même personne. Ce qui devient propre à l'étage, c'est QUI
-- répond ; à qui la conversation revient ensuite reste propre à la campagne.
alter table campaign_etages
  add column if not exists devenir text,
  -- L'agent IA qui prend la main, quand `devenir` vaut 'agent'.
  --
  -- ⚠️ `on delete set null` et JAMAIS `on delete cascade` : supprimer un agent ne doit pas détruire
  -- l'étage, donc la chaîne, d'une campagne peut-être déjà partie. Même raison que `workflow_id` et
  -- `email_template_id` juste au-dessus (migration 0134). La lecture retombe alors sur « personne ne prend
  -- la main », ce que le code doit traiter comme 'mba'.
  add column if not exists agent_id uuid references agents(id) on delete set null;

-- Les trois valeurs, et rien d'autre. `null` = campagne d'avant cette migration : le code retombe alors sur
-- l'ancien comportement (l'assignation si elle existe, sinon l'agent de Meta), sans reprise de données.
--
-- 🔴 PAS DE REPRISE, ET C'EST DÉLIBÉRÉ. Écrire 'inbox' sur les étages des campagnes existantes qui portent
-- une assignation paraîtrait plus propre, mais ça inventerait une intention : ces campagnes sont parties
-- SANS que personne ne prenne le fil à l'agent de Meta, et leur donner rétroactivement un devenir qui
-- change ce comportement ferait diverger ce qui s'est réellement passé de ce que la fiche annonce.
alter table campaign_etages
  drop constraint if exists campaign_etages_devenir_chk;
alter table campaign_etages
  add constraint campaign_etages_devenir_chk
  check (devenir is null or devenir in ('mba', 'agent', 'inbox'));

-- 🔴 UN AGENT N'A DE SENS QUE SI C'EST LUI QUI PREND LA MAIN. Sans cette garde, un étage pourrait porter
-- `devenir = 'inbox'` ET un `agent_id`, et le prochain lecteur ne saurait pas lequel des deux croit. Le
-- sens inverse n'est PAS contraint : `devenir = 'agent'` avec `agent_id` à null est un état ATTEIGNABLE,
-- celui d'un agent supprimé après coup (`on delete set null`), et le refuser ferait échouer la suppression
-- d'un agent sur une contrainte de campagne.
alter table campaign_etages
  drop constraint if exists campaign_etages_agent_sans_devenir_chk;
alter table campaign_etages
  add constraint campaign_etages_agent_sans_devenir_chk
  check (agent_id is null or devenir = 'agent');
