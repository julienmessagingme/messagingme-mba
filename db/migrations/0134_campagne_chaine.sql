-- 0134 : une campagne est une CHAÎNE d'étages, pas un canal unique.
--
-- 🔴 BLOQUANTE. ELLE PASSE AVANT LE DÉPLOIEMENT, SANS EXCEPTION, et ce n'est pas une formule de
-- prudence : le code neuf lit ces DEUX TABLES par leur nom, donc sans elles Postgres rend
-- `42P01 relation does not exist`, ce qu'aucun `?? null` ni aucun `coalesce` ne rattrape.
-- Les lecteurs, nommément, pour qu'on n'ait pas à les chercher le jour d'un retour arrière :
--   * `campaign_etages` <- `PgCampaignRepo.getCampaign` (`select ... from campaign_etages`), qui est
--     sur le chemin de CHAQUE run de campagne, et `insertCampaignRow`, sur celui de chaque création ;
--   * `campaign_envois` <- `PgStatsStore.getCampaignFunnel` (route `/stats/campaign-funnel`), et le
--     journal du moteur (`noterEnvoi`).
-- Les colonnes ajoutées à `campaigns` et `campaign_recipients`, elles, ne sont encore lues par
-- personne : elles sont posées maintenant pour que le moteur de bascule les trouve, pas pour ce lot.
--
-- ⚠️ ET DANS L'AUTRE SENS, RIEN NE CHANGE DE VISIBLE. Une chaîne à UN seul étage n'a pas de rang
-- suivant (`rangSuivant` rend null), donc aucune bascule n'est possible, donc le comportement reste
-- exactement celui d'aujourd'hui. C'est ce qui permet de déployer la chaîne avant son moteur.

-- ⚠️ UNE SEULE SOURCE POUR LE CONTENU D'UN ÉTAGE. Les colonnes actuelles de `campaigns`
-- (`template_name`, `template_language`, `rcs_message`, `workflow_id`) décrivent ce qui devient
-- l'étage 1. Elles sont REPRISES ici, puis ne sont plus lues par le code neuf. Leur retrait est une
-- migration ULTÉRIEURE, après le déploiement : une migration qui retire une colonne encore lue par
-- l'ancien code se passe APRÈS.
create table if not exists campaign_etages (
  campaign_id        uuid     not null references campaigns(id) on delete cascade,
  rang               smallint not null check (rang between 1 and 3),
  canal              text     not null check (canal in ('whatsapp', 'rcs', 'email')),
  template_name      text,
  template_language  text,
  rcs_message        jsonb,
  -- 🔴 LES DEUX CLÉS ÉTRANGÈRES SONT LÀ POUR QUE LA CHAÎNE NE DIVERGE PAS DE LA CAMPAGNE. Sans elles,
  -- supprimer un scénario mettrait `campaigns.workflow_id` à null (c'est ce que 0024 a posé) en
  -- laissant l'étage pointer sur un identifiant mort : deux vérités sur le même objet, dont une
  -- fausse, et c'est l'étage que le code neuf lira. `on delete set null` et JAMAIS `on delete
  -- cascade` : une cascade détruirait l'étage, donc la chaîne, pour la suppression d'un contenu.
  -- (`email_templates` est en suppression douce, la clause n'y jouera donc quasiment jamais ; elle
  -- garantit surtout qu'on ne puisse pas écrire un modèle qui n'existe pas.)
  email_template_id  uuid references email_templates(id) on delete set null,
  workflow_id        uuid references workflows(id) on delete set null,
  primary key (campaign_id, rang)
);

-- Reprise des campagnes existantes au rang 1.
-- ⚠️ Le parc est du test et sera effacé, mais parier sur un nettoyage manuel ferait de l'ordre des
-- gestes une condition de correction. La reprise coûte trois lignes.
--
-- ⚠️ LES CINQ COLONNES LUES EXISTENT TOUTES SUR `campaigns`, vérifié dans les migrations qui les ont
-- posées, pas supposé : `channel` (0056, `not null default 'whatsapp'`), `template_name` et
-- `template_language` (0003, rendues nullables par 0024), `rcs_message` (0057), `workflow_id` (0024).
--
-- 🔴 `campaigns.channel` N'A AUCUN CHECK (0056 ne lui en a pas donné), alors que `canal` en a un. Une
-- valeur inattendue en base ferait donc ÉCHOUER cette migration au lieu de se glisser dans la chaîne,
-- et c'est le bon sens de l'échec : on veut le savoir avant d'envoyer, pas après. Le `coalesce` ne
-- protège rien aujourd'hui (la colonne est `not null`), il est écrit comme `getCampaign` lit la même
-- colonne, pour que les deux lectures ne puissent pas diverger de doctrine.
insert into campaign_etages (campaign_id, rang, canal, template_name, template_language, rcs_message, workflow_id)
  select id, 1, coalesce(channel, 'whatsapp'), template_name, template_language, rcs_message, workflow_id
  from campaigns
on conflict (campaign_id, rang) do nothing;

-- Le journal des TENTATIVES, en ajout seul. Grain différent de campaign_recipients (un contact) :
-- 🔴 une ligne par tentative d'envoi. C'est la SEULE source de l'analytics par canal.
--
-- 🔴 ET C'EST PRÉCISÉMENT POURQUOI ON NE TOUCHE PAS À `campaign_recipients`. Son `unique (campaign_id,
-- contact_id)` EST le dédoublonnage des destinataires : c'est sur lui que repose le `on conflict do
-- nothing` de `insertRecipients`, donc la garantie qu'une même personne ne reçoit pas deux fois le
-- même message. Ajouter le rang à cette clé pour y loger les tentatives aurait ouvert cette porte,
-- et le reste du dépôt suppose partout une ligne par contact. Le grain « tentative » vit donc ici.
create table if not exists campaign_envois (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  recipient_id     uuid not null references campaign_recipients(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  rang             smallint not null,
  canal            text not null check (canal in ('whatsapp', 'rcs', 'email')),
  -- `saute` = le destinataire a été ÉCARTÉ (pas de consentement, variable manquante) : aucune
  -- tentative n'est partie, et le confondre avec un échec ferait mentir le taux d'échec par canal.
  statut           text not null check (statut in ('sent', 'failed', 'saute')),
  message_id       text,
  error_code       int,
  error            text,
  -- Le cycle de vie Meta de CETTE tentative, mêmes valeurs que `campaign_recipients.delivery_status`
  -- (0007). ⚠️ Il lui faut son propre exemplaire : `campaign_recipients` n'en porte qu'UN, celui de
  -- la dernière tentative, donc lire la livraison par canal depuis lui attribuerait l'accusé du
  -- second étage au premier, qui a justement échoué.
  delivery_status  text check (delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed')),
  sent_at          timestamptz not null default now()
);

-- L'index sert UNE requête, et la voici, celle du funnel par canal
-- (`PgStatsStore.getCampaignFunnel`) :
--     select e.canal, ... from campaign_envois e
--       join campaigns c on c.id = e.campaign_id
--      where e.campaign_id = $1 and c.tenant_id = $2
--      group by e.canal
-- Sa première colonne porte l'égalité (`campaign_id = $1`), sa seconde rend les lignes DÉJÀ triées
-- par canal, ce qui donne l'agrégation par groupes sans tri intermédiaire.
-- ⚠️ Il n'est PAS couvrant : les compteurs lisent `statut`, `delivery_status`, `sent_at` et
-- `message_id`, qui restent cherchés dans la table. Le dire évite de croire l'index plus fort qu'il
-- ne l'est le jour où quelqu'un mesurera la requête.
create index if not exists campaign_envois_campagne_idx on campaign_envois (campaign_id, canal);

-- L'étage où en est chaque contact. Défaut 1 : tout le parc existant est au premier étage.
-- ⚠️ Personne ne l'écrit encore, et c'est voulu : c'est le moteur de bascule qui la fera avancer.
-- Posée maintenant pour qu'il n'ait pas à migrer une table de destinataires déjà pleine.
alter table campaign_recipients add column if not exists etage_courant smallint not null default 1;

-- Les réglages de l'assistant.
-- 🔴 rattrapage_hors_horaires NE REMPLACE PAS business_hours_only, il le complète : le premier
-- gouverne le moment que l'opérateur CHOISIT (l'envoi initial), le second celui que PERSONNE ne
-- choisit (le réessai ou le repli). Les fusionner ramènerait le défaut que ce lot corrige.
alter table campaigns add column if not exists reessayer boolean not null default true;
alter table campaigns add column if not exists rattrapage_hors_horaires boolean not null default false;
-- ⚠️ CONTRAINTE NOMMÉE À LA MAIN. Une contrainte posée en ligne reçoit un nom AUTOMATIQUE, qu'une
-- migration ultérieure doit aller LIRE en base avant d'oser un `drop constraint` : 0122 a dû le faire
-- pour une contrainte de 0103, et un nom deviné à côté aurait laissé l'ancienne en place tout en
-- ajoutant la nouvelle, donc rejeté en silence la valeur qu'on venait d'autoriser.
alter table campaigns add column if not exists assignation text
  constraint campaigns_assignation_check check (assignation is null or assignation in ('personne', 'tour_de_role'));
-- `on delete set null` : le départ d'un collaborateur ne doit pas emporter la campagne qui lui était
-- assignée, il doit la rendre non assignée.
alter table campaigns add column if not exists assignation_user_id uuid references users(id) on delete set null;
alter table campaigns add column if not exists tour_de_role_rang smallint not null default 0;
