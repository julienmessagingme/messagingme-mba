# Plan, lot 2 « Connecter » des publicités Click-to-WhatsApp

Spec : `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`, § 3.1 (connexion), § 2 (`pub_connexion`),
§ 3.7 (écrans), § 4 (sécurité). Lot 1 « Capter » est en production depuis le 2026-09-23 vers 9 h 15.

## Ce que le lot fait

Un espace connecte SON compte publicitaire et SA Page à Engage Me, une fois, et le produit garde de quoi
parler à l'API Marketing en son nom. Rien d'autre : aucune pub n'est créée, aucune campagne n'est lue. La
création et le suivi sont le lot 3, et ils ne peuvent pas commencer avant que ce lot existe.

## Ce que le lot ne fait pas

Pas d'import des campagnes existantes (lot 4), pas de création (lot 3), pas de renvoi de conversions
(lot 5). Pas de gestion multi-comptes : **une ligne par espace**, un compte publicitaire, une Page.

## État à l'entrée, vérifié le 2026-09-23

- L'app Meta `988129420727963` porte le cas d'usage « Create & manage ads with Marketing API », ses six
  permissions en « Ready for testing », et le « Marketing API Access Tier » en **Limited**.
- La configuration Facebook Login for Business « pub Meta » existe : variation General, jeton d'utilisateur
  système **sans expiration**, actifs Pages et comptes publicitaires tous deux requis, tâche **ADVERTISE**
  sans `MANAGE`. Son identifiant vit dans `brain/INFRA.md`, hors du dépôt qui est public.
- Restent chez Meta, côté Julien : la vérification d'entreprise (n'empêche pas ce lot), la liaison de la
  Page au numéro WhatsApp (attendue pour l'essai de ce lot), un moyen de paiement (attendu au lot 3).

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, exécuté en direct dans la session. Les quatre
questions du `CLAUDE.md` global :

- **La production emprunte-t-elle ce chemin ?** Oui. Une route publique neuve, un jeton d'un tiers gardé
  chiffré, et un écran dans la console de tous les clients.
- **Est-ce réversible ?** Oui pour nous (la migration ajoute, la déconnexion supprime la ligne), non pour
  ce qui part chez Meta : un jeton échangé est un jeton vivant tant qu'on ne le révoque pas.
- **Les critères sont-ils vérifiables par un test ?** Pas tous. L'échange de code, la lecture des actifs et
  la liaison Page/numéro ne se prouvent que sur un vrai compte, et l'écran demande un œil.
- **Le code touché porte-t-il des invariants invisibles ?** Oui : le chiffrement au repos, le registre des
  modules de routes qui décide de la garde d'isolation, et la fenêtre Vercel (la console se publie à chaque
  `git push`, l'API attend son déploiement).

Deux « oui » en haut, donc revue humaine du diff. `feature-loop` est exclu : ses critères ne sont pas
mécaniquement testables ici, puisque l'essentiel se passe chez Meta.

## Ce qui est MESURÉ avant d'être écrit — RÉPONSES DU 2026-09-23, sur un vrai compte

🔴 **LES DEUX ONT ÉTÉ MESURÉES EN PRODUCTION, et elles ne répondent pas dans le même sens.**

1. **La liaison Page / numéro : NON, Meta ne répond pas.** Le champ `connected_whatsapp_business_account`
   ne revient pas sur la Page d'un client connecté. Le verdict `inconnu` n'est donc pas un cas de repli
   rare : c'est le cas NORMAL aujourd'hui. Conséquence tenue : l'écran annonce une ignorance, jamais un
   refus, et c'est la création de la pub (lot 3) qui tranchera, avec le message de Meta s'il y a lieu.
2. **La devise et le fuseau SANS la permission `MANAGE` : OUI.** Ils arrivent dans
   `GET /me/adaccounts`, avec le nom du compte et son `account_status`. L'arbitrage de ne demander que
   `ADVERTISE` à la configuration est donc validé par la mesure, et aucun client ne verra
   « contrôler les finances » dans sa fenêtre de connexion.

🔴 **ET UNE TROISIÈME RÉPONSE, QUE PERSONNE N'AVAIT PENSÉ À POSER** : un jeton d'utilisateur système
d'intégration **ne déclare pas ses actifs**. `debug_token` rend ses permissions sans aucun `target_ids`,
là où l'inscription WhatsApp y trouve ses WABA. Les actifs se DEMANDENT (`/me/adaccounts`,
`/me/accounts`), ils ne se déduisent pas du jeton. C'est ce qui rendait les deux listes vides alors que
la connexion était parfaite.

### L'énoncé d'origine, gardé pour mémoire


Deux inconnues, et aucune ne se devine. Elles se mesurent sur le vrai compte, avec le vrai jeton, et le
résultat décide du code. Tant qu'elles ne sont pas mesurées, les tâches 4 et 6 restent ouvertes.

1. **Comment lire que la Page est liée au numéro WhatsApp.** La spec dit que la liaison se fait à la main,
   elle ne dit pas comment la VÉRIFIER. Candidat : le champ `connected_whatsapp_business_account` sur le
   noeud Page. S'il répond, l'état « incomplet » est calculé et l'écran l'explique. S'il ne répond pas, le
   repli assumé est : pas d'invention d'un état vérifié, l'écran dit ce qu'il sait, et c'est le refus de
   Meta à la création (lot 3) qui fait foi, affiché mot pour mot.
2. **Si la devise et le fuseau du compte publicitaire se lisent avec la tâche ADVERTISE seule**
   (`GET /act_<id>?fields=currency,timezone_name,name,account_status`). `MANAGE` a été délibérément écarté
   à la création de la configuration. Si Meta refuse, la correction est un réglage de configuration chez
   Meta, pas du code, et elle se fait avant d'écrire la tâche 4.

## Tâche 1 : la table `pub_connexion`

**Fichier** : `db/migrations/0167_pub_connexion.sql`. ⚠️ **Le numéro se RELIT dans
`public.schema_migrations` au moment d'appliquer**, jamais dans un fichier : cette ligne a dérivé neuf fois.
🔴 **Et la dixième a failli arriver en écrivant CE plan** : il annonçait 0166, que le `CLAUDE.md` donne
pour libre, alors qu'une AUTRE session tenait déjà un `0166_origine_api.sql` dans l'arbre partagé, pas
encore commité. Deux migrations auraient porté le même numéro. Ce qui l'a vu n'est pas la vigilance, c'est
d'avoir REGARDÉ l'état réel (`git status`, `ls db/migrations`) avant d'écrire le numéro. 0167 est donc le
numéro de ce plan, et la base tranchera au moment d'appliquer.

Une ligne par espace, clé primaire `tenant_id`, `on delete cascade`. Colonnes : jeton chiffré, identifiant
du compte publicitaire, identifiant de la Page, devise, fuseau, état de la liaison Page et numéro, auteur et
date de la connexion, date de rejet du jeton par Meta.

Deux décisions qui se prennent ici :

- **La clé primaire est `tenant_id`**, comme `agent_gateway_keys` : c'est elle qui rend la connexion
  idempotente sans verrou applicatif, deux connexions simultanées ne pouvant pas produire deux lignes.
- **Le jeton est `text NOT NULL`**, le reste est nullable. Une connexion existe dès qu'un jeton est échangé,
  même si l'admin n'a pas encore choisi son compte : sans ça, un client qui ferme l'onglet entre les deux
  écrans perd son jeton et doit tout refaire, alors que Meta, lui, a bien émis un jeton vivant.

Elle AJOUTE, et aucun code déployé ne la nomme, donc elle passe **avant** le déploiement.

## Tâche 2 : le client Graph des publicités

**Fichiers** : `src/meta/graph.ts` (extraction), `src/meta/pubs.ts` (neuf),
`tests/pubs-client-meta.test.ts`.

L'échange de code et la lecture de `debug_token` existent déjà dans `src/meta/embedded-signup.ts`, à
l'identique de ce dont ce lot a besoin. On ne les recopie pas : on extrait le socle (l'appel Graph avec son
message d'erreur, l'échange de code, la lecture des cibles d'un `granular_scope`) dans `src/meta/graph.ts`,
dont `MetaEmbeddedSignupClient` hérite sans changer aucun de ses comportements.

⚠️ **L'extraction touche le chemin d'inscription WhatsApp, qui est le plus structurant du produit.** Elle se
fait sans modifier une ligne de logique, et les tests existants de l'Embedded Signup sont la preuve : ils
doivent passer **sans être touchés**. Si l'un d'eux doit changer, c'est que l'extraction a changé un
comportement, et on s'arrête.

`MetaPubsClient` ajoute :

- `actifsAccordes(jeton)` : les comptes publicitaires et les Pages, lus dans `debug_token`, par scope
  (`ads_management` pour les comptes, `pages_show_list` pour les Pages). Rend deux listes, jamais une
  exception, une liste vide étant un cas normal que l'appelant traduit.
- `infosCompte(actId, jeton)` : nom, devise, fuseau, statut.
- `pageLieeAuNumero(pageId, jeton)` : rend `true`, `false` ou `inconnu`. Trois valeurs et pas deux, parce
  que « Meta ne sait pas répondre » n'est pas « la Page n'est pas liée » (mesure n°1 ci-dessus).

🔴 **Toute réponse de Meta passe par un `safeParse` Zod**, jamais un `as`. La leçon est écrite dans le
`CLAUDE.md` du dépôt : la documentation de Vercel annonçait `id` à la racine quand le serveur le rendait
ailleurs, et c'est le `safeParse` qui a évité de garder une ligne inutilisable.

## Tâche 3 : le dépôt Postgres

**Fichiers** : `src/pubs/connexion.pg.ts`, `tests/integration/pubs-connexion.integration.test.ts`.

`lire(tenantId)`, `poserJeton(...)`, `choisirActifs(...)`, `marquerJetonRejete(tenantId)`,
`supprimer(tenantId)`. `tenant_id = $1` sur chaque requête, sans exception : le pooler est superuser, donc
la RLS est contournée et le filtrage en code est le SEUL contrôle.

Le test d'intégration vérifie l'idempotence de la connexion (deux `poserJeton` de suite laissent une ligne)
et l'isolation (un espace ne lit jamais la ligne d'un autre), contre un vrai Postgres, en CI.

## Tâche 4 : les routes

**Fichiers** : `src/http/pubs.ts`, `src/server.ts` (registre), `tests/pubs-routes.test.ts`.

| Route | Qui | Ce qu'elle fait |
|---|---|---|
| `GET /tenants/:tenantId/pubs/connexion` | tout membre | l'état : connecté ou non, compte, Page, devise, liaison |
| `POST /tenants/:tenantId/pubs/connexion/echange` | admin | échange le `code`, chiffre le jeton, rend les actifs accordés |
| `POST /tenants/:tenantId/pubs/connexion/choix` | admin | enregistre le compte et la Page choisis, lit devise et fuseau, calcule la liaison |
| `DELETE /tenants/:tenantId/pubs/connexion` | admin | déconnecte, et le dit clairement si une pub tourne encore |

🔴 **ÉCART TROUVÉ EN RELECTURE À FROID, LE 2026-09-23 : LA DÉCONNEXION RÉVOQUE MAINTENANT CHEZ META.**
Le plan d'origine se contentait d'effacer la ligne. Or elle est le seul endroit où ce jeton existe chez
nous, et il est SANS EXPIRATION : l'effacer laissait un accès vivant chez Meta, irrévocable par nous pour
toujours. C'est le piège de la clé Vercel (0124) à l'identique. La route appelle donc
`DELETE /me/permissions/{permission}` AVANT d'effacer, permission par permission (jamais la forme NUE, qui désautoriserait l'application entière, or elle porte aussi le numéro WhatsApp), un test de câblage lit cet ORDRE dans la source, et l'échec du
retrait n'empêche pas de se déconnecter : il remonte à l'écran, qui dit alors au client de retirer
l'application depuis les paramètres de son entreprise.

🔴 **Le jeton n'entre JAMAIS dans la route**, exactement comme dans `EmbeddedSignupRouteDeps` : le câblage
le résout, le chiffre et ne laisse passer que le `tenantId`. Un jeton qui n'entre pas dans une route ne peut
ni fuiter dans un journal ni partir dans un corps de réponse.

🔴 **Aucune dépendance optionnelle.** Le type les exige toutes, garde comprise. Le dépôt a payé ce motif
deux fois (la garde d'authentification, puis `estDesabonne`, qui a écrit à des contacts désabonnés).

Le module entre dans `modulesDeRoutes` avec `acces: 'tenant'`, ce qui le fait couvrir par
`tests/scope-tenant.test.ts` sans qu'on ait à y penser. La route d'échange porte `limiteCouteuse` : elle
appelle Meta.

## Tâche 5 : le câblage

**Fichiers** : `src/config.ts` (`META_ADS_CONFIG_ID`, défaut vide), `src/index.ts`, `.env.example`.

Vide = fonctionnalité éteinte, avec une phrase qui le dit, comme l'inscription WhatsApp. Et la même garde
que pour elle : `META_ADS_CONFIG_ID` non vide exige une `ENCRYPTION_KEY` valide, sans quoi on stockerait un
jeton en clair. Elle se pose dans le même `superRefine` que celui de l'Embedded Signup.

## Tâche 6 : l'écran

**Fichiers** : `web/app/publicites/page.tsx`, `web/lib/nav.ts`, `web/lib/api/pubs.ts`, i18n.

La carte de connexion, et elle seule : état, compte publicitaire, Page, liaison au numéro, bouton
connecter, bouton déconnecter. La liste des pubs et le bouton Créer sont le lot 3, et ils n'apparaissent
pas, même désactivés : le produit s'interdit l'offert-et-inerte.

🔴 **L'écran se pousse APRÈS le déploiement de l'API**, ou il tolère l'absence de ses routes. Vercel publie
la console à chaque `git push` quand l'API attend son `up -d --build` : l'onglet « Outils » de l'agent de
Meta est resté en 404 plus d'une heure pour cette raison, le 2026-09-21. Ce plan choisit la seconde option,
la tolérance, parce qu'elle ne dépend pas de la discipline du jour : une route absente rend « publicités
non configurées », c'est-à-dire exactement l'état d'un espace sans `META_ADS_CONFIG_ID`.

## Tâche 7 : déploiement, puis l'essai qui clôt le lot

Séquence, dans cet ordre, avec la revue finale attestée avant : `gh run list` lu job par job, `git pull` sur
le VPS, `compose build mba-api`, `migrate`, **relecture des TROIS migrations en base point par point** (0166 est un `drop/add constraint`, 0167 la table `pub_connexion`, 0168 la table `grille_prix`) (colonnes, types,
nullabilité, clé primaire, `on delete cascade`), `up -d --build`, contrôle public des portes, rechargement
de NPM si un 502 apparaît.

**L'essai réel qui clôt ce lot** : Julien connecte le compte publicitaire MessagingMe et la Page depuis
l'écran, sur l'espace réel. Ce qui doit être VU, et pas déduit d'une absence d'erreur : une ligne dans
`pub_connexion` avec la devise et le fuseau lus chez Meta, l'état de la liaison Page et numéro, et la
déconnexion qui la fait disparaître. Tant que ce clic n'a pas eu lieu, le lot est vert, pas éprouvé.

## Rayon de souffle

- `src/meta/embedded-signup.ts` : l'extraction du socle Graph. Ses tests ne doivent PAS bouger.
- `src/config.ts` : une variable de plus, et la garde de chiffrement qui la lie à `ENCRYPTION_KEY`.
- `src/server.ts` : un module de routes de plus dans le registre, donc un espace de plus couvert par la
  parité de `tests/scope-tenant.test.ts`.
- `web/lib/nav.ts` : une entrée de menu de plus, visible par tous les clients dès le `git push`.
- Le `.env.prod` du VPS : la variable s'y pose à la main, avant le `up`. Oubliée, la fonctionnalité reste
  éteinte, ce qui est le bon défaut mais silencieux : le contrôle public d'après déploiement le vérifie.

## Tests

- **Unitaires** : l'extraction du socle (les tests existants de l'Embedded Signup, inchangés) ; les trois
  valeurs de `pageLieeAuNumero` ; le refus d'une réponse de Meta malformée par le `safeParse` ; les gardes
  de rôle sur les trois routes d'écriture.
- **Intégration (CI)** : idempotence de la connexion, isolation entre espaces, suppression.
- **Dans les deux sens** : chaque test de non-régression se vérifie en remettant le code fautif et en
  constatant l'échec ET son symptôme, avant de restaurer.
