-- 0200 : le widget WhatsApp, une bulle que le client pose sur son site (lot 1 de
-- docs/superpowers/specs/2026-10-02-widget-whatsapp-design.md, cadrage de Julien du 2026-10-02).
--
-- Le visiteur clique, WhatsApp s'ouvre avec la PHRASE du widget déjà écrite, il l'envoie : c'est lui qui parle
-- le premier, donc la fenêtre de service s'ouvre sans modèle approuvé. À l'arrivée, la phrase dit par quel
-- widget il est passé, et le DEVENIR de ce widget décide qui prend la conversation, une seule fois.
--
-- 🔴 LE CODE EST UNE PORTE À SENS UNIQUE, comme `/r/:code` (0066). Il est dans l'adresse du script que le
-- client colle chez lui (`/widget/<code>.js`) : dès qu'une balise est posée, cette adresse doit répondre pour
-- toujours. Il est donc OPAQUE (tiré au sort par `newTrackingCode`, le générateur des liens tracés : ni code
-- client ni horodatage lisibles de l'extérieur) et IMMUABLE. L'immuabilité est tenue par le store, seul
-- écrivain, dont aucune requête ne réécrit `code` : un déclencheur qui l'interdirait se testerait mal et ne se
-- verrait pas en lisant le schéma (même raison que la clé étrangère composite de 0152).
--
-- TRANSACTIONNELLE, ET C'EST UN CHOIX : une table neuve, VIDE, et ses index créés dans la même transaction ne
-- bloquent l'écriture de personne. Hors transaction, elle perdrait son filet pour rien.
--
-- ADDITIVE : aucune table existante n'est touchée, l'ancien code l'ignore. Elle passe donc AVANT le déploiement
-- du code qui l'écrit, comme toute table que le code écrit.
create table if not exists widgets (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  -- L'identifiant PUBLIC, celui de l'URL du script. Pas l'`id` : une clé technique n'a pas à circuler chez des
  -- tiers, et ce code ne porte rien d'autre que lui-même.
  code           text not null,
  -- Pour que le client s'y retrouve quand il en a plusieurs (site vitrine, blog, page tarifs). Jamais montré
  -- au visiteur.
  nom            text not null,
  -- Le texte pré-rempli, et la SOURCE : c'est lui qu'on reconnaît dans le message qui arrive. Il est PUBLIC
  -- (lisible dans le script par n'importe qui), donc rien de confidentiel dedans.
  phrase         text not null,
  -- Qui prend la conversation que le widget amène : le motif de `campaign_etages.devenir` (0144), recopié.
  --
  -- 🔴 `null` EST LE CAS QUI ÉVITE LA SECONDE VÉRITÉ. Le réglage « qui répond au client » existe déjà au niveau
  -- de l'espace et gouverne tout le reste du produit. `null` veut dire « ce que l'espace a décidé », ce qui
  -- couvre aussi le cas d'un humain qui répond, que les trois valeurs ne savent pas exprimer. Le widget ne
  -- remplace pas ce réglage, il le surcharge pour les conversations qu'il amène, à l'arrivée seulement.
  devenir        text,
  -- L'agent IA qui prend la main, quand `devenir` vaut 'agent' ; le scénario, quand il vaut 'scenario'.
  --
  -- ⚠️ `on delete set null`, JAMAIS `cascade` : supprimer un agent ou un scénario détruirait le widget, donc
  -- ferait disparaître la bulle du site d'un client, sans qu'il le sache. Ni `restrict` : la suppression d'un
  -- agent échouerait sur une contrainte de widget, en 500. C'est la CEINTURE, comme en 0139 : un refus lisible
  -- en 409, si c'est lui qui est retenu (question encore ouverte dans la spec), appartiendra à la route qui
  -- supprime, pas à cette table.
  agent_id       uuid references agents(id) on delete set null,
  workflow_id    uuid references workflows(id) on delete set null,
  -- L'apparence, BORNÉE par les CHECK plus bas. Pas de CSS libre : la bulle injecte du style dans une page que
  -- nous ne connaissons pas, ce qui s'y affiche mal nous revient en support, et un CSS libre rendrait le badge
  -- trivial à masquer. Le vert par défaut est celui de WhatsApp.
  couleur        text not null default '#25d366',
  position       text not null default 'bas_droite',
  -- null = la bulle seule, sans texte à côté.
  libelle        text,
  avatar_url     text,
  -- « Propulsé par Engage Me ». Vrai par défaut : le retirer est un acte commercial (offre Pro), qui doit se
  -- décider explicitement, jamais par l'oubli d'un champ à la création.
  badge          boolean not null default true,
  -- Le client peut éteindre le widget SANS retirer la balise de son site : le script rend alors une bulle
  -- absente, jamais une erreur. Vrai par défaut, même raison que `webhooks.enabled` (0074) : créer un widget
  -- éteint reviendrait à donner une balise qui n'affiche rien.
  actif          boolean not null default true,
  -- Plafond horaire PROPRE au widget, comme `channelsme_links.max_par_heure` (0114) : une phrase publique peut
  -- être envoyée en rafale, et un envoi de masse involontaire se facture au client. null = plafond global de
  -- l'instance, pas « zéro ».
  max_par_heure  integer,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Les trois valeurs, et rien d'autre.
  constraint widgets_devenir_chk
    check (devenir is null or devenir in ('agent', 'mba', 'scenario')),

  -- 🔴 UN AGENT N'A DE SENS QUE SI C'EST LUI QUI PREND LA MAIN, UN SCÉNARIO QUE SI C'EST LUI QUI DÉCIDE. Sans
  -- ces gardes, un widget pourrait porter `devenir = 'mba'` ET un `agent_id`, et le prochain lecteur ne
  -- saurait pas lequel des deux croire. Le sens inverse n'est PAS contraint : `devenir = 'agent'` avec
  -- `agent_id` à null est un état ATTEIGNABLE, celui d'un agent supprimé après coup (`on delete set null`), et
  -- le refuser ferait échouer la suppression d'un agent sur une contrainte de widget.
  --
  -- 🔴 `coalesce(..., false)` ET PAS `devenir = 'agent'` NU, contrairement à 0144. Un CHECK dont l'expression
  -- vaut NULL est SATISFAIT : avec `devenir` à null, `devenir = 'agent'` vaut null, `false or null` vaut null,
  -- et la ligne (`devenir` null, `agent_id` renseigné) passerait. C'est exactement l'état ambigu que la garde
  -- veut fermer, et ici `null` a un SENS (le réglage de l'espace) : un agent posé à côté le contredirait.
  constraint widgets_agent_sans_devenir_chk
    check (agent_id is null or coalesce(devenir = 'agent', false)),
  constraint widgets_scenario_sans_devenir_chk
    check (workflow_id is null or coalesce(devenir = 'scenario', false)),

  -- Les quatre coins, et aucune coordonnée libre.
  constraint widgets_position_chk
    check (position in ('bas_droite', 'bas_gauche', 'haut_droite', 'haut_gauche')),

  -- 🔴 SIX CHIFFRES HEXADÉCIMAUX, ET RIEN D'AUTRE. La couleur est écrite telle quelle dans le style d'une page
  -- tierce : une valeur libre porterait plus qu'une couleur (`red;display:none` masque le badge, `url(...)`
  -- fait charger une ressource par la page du client). C'est la forme que rend `<input type="color">` ; les
  -- majuscules sont admises parce qu'un appel d'API les écrira, et qu'elles ne changent rien au rendu.
  constraint widgets_couleur_chk
    check (couleur ~ '^#[0-9A-Fa-f]{6}$'),

  -- Même raison que la couleur : l'adresse finit dans la page d'un client. `https://` seul ferme `javascript:`
  -- et `data:`, et un `http://` serait bloqué comme contenu mixte sur tout site servi en https, donc une
  -- image cassée chez le client.
  constraint widgets_avatar_https_chk
    check (avatar_url is null or avatar_url ~ '^https://'),

  -- Même règle que 0181 : un plafond à 0 voudrait dire « aucun plafond » dans la convention du dépôt, le
  -- contraire de ce que veut celui qui le tape. Retirer le réglage, c'est écrire null.
  constraint widgets_max_par_heure_chk
    check (max_par_heure is null or max_par_heure > 0),

  -- 🔴 UNE PHRASE VIDE SERAIT CONTENUE DANS TOUS LES MESSAGES. La reconnaissance de la source se fait par
  -- inclusion : un widget sans phrase capterait chaque conversation de l'espace et lui appliquerait son
  -- devenir. Ce CHECK n'est que le FILET du cas flagrant (aucun caractère visible) : la base ne sait pas
  -- appliquer `normalizeText`, le contrôle complet sera celui de la route d'écriture (lot 4 du plan).
  constraint widgets_phrase_non_vide_chk
    check (phrase ~ '\S')
);

-- Le code est l'unique clé de lecture de la route publique : unique GLOBALEMENT, puisqu'il porte l'espace à lui
-- seul, et c'est cet index qui sert `parCode`.
create unique index if not exists widgets_code_key on widgets (code);

-- 🔴 LA PHRASE EST UNIQUE PAR ESPACE, recopié de `channelsme_links_phrase_key` (0116). Deux widgets de même
-- phrase rendraient la source INDÉCIDABLE à l'arrivée d'un message, donc le mauvais devenir appliqué.
--
-- ⚠️ `lower(btrim(...))` ignore la CASSE et les espaces, PAS les accents, alors que la correspondance réelle
-- (`normalizeText`) les ignore aussi. L'écart est assumé pour la même raison qu'en 0116 : `unaccent` n'est pas
-- installé sur cette base et n'est pas immuable, donc inutilisable dans une expression d'index sans emballage.
-- Le contrôle applicatif (lot 4 du plan, dans la route) jugera par `normalizeText` ET contre les phrases des
-- liens de chaîne : cet index est le FILET contre une course entre deux créations simultanées, pas la
-- définition de « la même phrase ».
--
-- ⚠️ Il commence par `tenant_id`, et c'est voulu : il sert aussi « les widgets de cet espace » (`lister`,
-- `phrasesDesWidgets`). Un espace porte quelques widgets, le tri de la liste ne demande pas d'index à lui.
create unique index if not exists widgets_phrase_key
  on widgets (tenant_id, lower(btrim(phrase)));
