-- 0063 : journal des ÉVÉNEMENTS PAR BLOC d'un scénario, socle de « Analytics > Mes tableaux ».
--
-- Pourquoi une table neuve. Rien ne reliait un message envoyé au bloc qui l'a envoyé :
-- `conversation_messages` ne porte pas d'identifiant de bloc, et `workflow_runs` ne garde que la position
-- COURANTE d'un parcours, sans historique. Compter « combien de contacts ont cliqué le choix 2 du bloc 3 »
-- était donc impossible, quelle que soit la requête. ⚠️ Corollaire assumé : la mesure démarre à la date de
-- cette migration, il n'y a pas de statistique rétroactive.
--
-- `wa_id` (chiffres nus, tel que Meta le renvoie) et NON un contact_id : au moment où l'événement se produit,
-- l'exécuteur ne connaît que le numéro, et résoudre une fiche à chaque message coûterait une requête par
-- envoi. Un numéro inconnu du CRM produit quand même un événement, ce qui est le comportement voulu.
--
-- ⚠️ RGPD : `wa_id` est une donnée personnelle. La purge d'un contact ANONYMISE ces lignes au lieu de les
-- supprimer (`wa_id = 'anonyme'`), exactement comme `campaign_recipients.to_e164`. C'est la décision
-- « on anonymise pour garder le quanti » : les compteurs d'un tableau restent justes après un effacement,
-- et plus personne n'y est reconnaissable.
create table if not exists workflow_node_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  -- Identifiant du bloc DANS le graphe (texte, pas une FK : les blocs vivent dans un jsonb).
  node_id     text not null,
  wa_id       text not null,
  kind        text not null check (kind in ('sent', 'failed', 'delivered', 'read', 'reply_button', 'reply_text')),
  -- Identifiant Meta du message envoyé (kind='sent'). Sert à rattacher un accusé de livraison/lecture à
  -- l'envoi, donc au bloc. null sur les autres natures.
  meta_message_id text,
  -- Pour 'reply_button' : le handle du bouton choisi, celui-là même qui route l'arête du graphe
  -- (`btn:<i>` d'un template, ou le handle carte/bouton d'un carousel). null sur les autres natures.
  handle      text,
  at          timestamptz not null default now()
);

-- Lecture type d'un tableau : « pour CE scénario, sur CETTE période, groupé par bloc et par nature ».
create index if not exists idx_wf_node_events_rapport
  on workflow_node_events (tenant_id, workflow_id, at);

-- Rattachement d'un accusé de livraison à son envoi : recherche par identifiant Meta seul.
create index if not exists idx_wf_node_events_message
  on workflow_node_events (meta_message_id) where meta_message_id is not null;
