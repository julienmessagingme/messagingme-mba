-- 0167_pub_connexion.sql : lot 2 des publicités Click-to-WhatsApp, « Connecter ».
-- Spec : docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md (§ 2, § 3.1).
-- Plan : docs/superpowers/plans/2026-09-23-pubs-ctwa-lot2-connecter.md
--
-- AVANT le déploiement : le code neuf écrit cette table, l'ancien l'ignore, donc il y survit.
--
-- ⚠️ Le numéro 0167 et pas 0166 : une autre session tenait déjà un 0166 dans l'arbre partagé quand ce
-- fichier a été écrit, alors que la ligne du CLAUDE.md donnait 0166 pour libre. La base tranche, toujours.

-- UNE ligne par espace : un compte publicitaire, une Page. Le multi-comptes n'est pas au programme, et la
-- clé primaire sur tenant_id est ce qui le dit en base plutôt que dans un commentaire.
--
-- 🔴 La clé primaire sur tenant_id rend la connexion IDEMPOTENTE sans verrou applicatif, comme pour
-- agent_gateway_keys (0124) : deux connexions simultanées ne peuvent pas produire deux lignes, donc deux
-- jetons vivants chez Meta dont un seul serait connu de nous.
create table if not exists pub_connexion (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  -- Le jeton d'utilisateur système rendu par l'échange du code, CHIFFRÉ (encryptSecret, le même chiffrement
  -- que le jeton business de l'inscription WhatsApp). Jamais en clair, jamais dans un journal, jamais dans
  -- une réponse HTTP.
  --
  -- 🔴 NOT NULL, quand tout le reste est nullable, et c'est un choix : une connexion EXISTE dès que le code
  -- est échangé, avant même que l'admin ait choisi son compte. Sans cette ligne intermédiaire, un client qui
  -- ferme l'onglet entre les deux écrans perdrait un jeton que Meta a pourtant bien émis, et qui resterait
  -- vivant chez eux sans que personne ne puisse plus le révoquer.
  jeton_chiffre    text not null,
  -- Identifiants Meta choisis par l'admin, parmi ceux que le jeton accorde. Nuls tant que le choix n'est pas
  -- fait. Le compte publicitaire est stocké SANS le préfixe act_, que les appels ajoutent.
  compte_pub_id    text,
  page_id          text,
  -- Lues chez Meta au moment du choix, jamais saisies : ce sont elles qui décident de la monnaie et des
  -- heures affichées, et un client qui les taperait à la main se tromperait sans que rien ne le signale.
  devise           text,
  fuseau           text,
  -- La Page est-elle liée au numéro WhatsApp de l'espace ? TROIS valeurs, pas deux : « Meta ne sait pas
  -- répondre » n'est pas « la Page n'est pas liée ». Afficher « non liée » sur une ignorance ferait envoyer
  -- un client refaire une liaison qui existe déjà.
  page_liee        text,
  connecte_par     uuid references users(id) on delete set null,
  connecte_le      timestamptz not null default now(),
  -- Quand Meta a refusé ce jeton (expiré, révoqué côté client, permissions retirées). Nul = jamais refusé.
  jeton_rejete_le  timestamptz,
  constraint pub_connexion_page_liee_chk check (page_liee is null or page_liee in ('oui', 'non', 'inconnu'))
);

-- AUCUN index en plus, délibérément : cette table se lit par sa clé primaire, une ligne par espace. Un index
-- qui ne sert aucune requête est une justification fausse inscrite dans le schéma (leçon de 0143).
