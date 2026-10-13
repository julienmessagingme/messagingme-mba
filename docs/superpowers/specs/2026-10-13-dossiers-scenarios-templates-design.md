# Ranger les scénarios et les templates dans des dossiers

Demande de Julien du 2026-10-13 : « créer des répertoires pour classifier les scénarios ; même chose pour ranger les
templates ». Cadrage par deux rondes de questions, le même jour.

## Ce qui est décidé

- **Un seul niveau de dossiers**, un dossier par élément. Un scénario ou un template est dans un dossier, ou dans
  « Sans dossier ». Ni sous-dossiers, ni étiquettes multiples.
- **Deux listes séparées** : les dossiers de la page Scénarios et ceux de la page Templates vivent chacun de leur côté.
  Créer « Black Friday » dans l'une ne le crée pas dans l'autre.
- **Templates WhatsApp seulement** (la page Templates). Ni les modèles d'e-mail, ni les messages RCS.
- **Une barre d'onglets au-dessus de la liste** : « Tous · Sans dossier · <dossiers> · + Dossier », chaque onglet avec
  son nombre d'éléments. La liste garde toute la largeur ; la barre défile à l'horizontale sur téléphone.
- **On range par « Déplacer vers… »**, dans le menu ⋯ d'une ligne et sur une sélection de plusieurs lignes. Pas de
  glisser-déposer.

## Ce qui en découle (proposé, accepté avec le design)

- **Lire est à toute l'équipe, écrire aux admins** : créer, renommer, supprimer un dossier, et y ranger, comme toute
  écriture de la console.
- **Supprimer un dossier ne supprime rien d'autre** : ses éléments repassent dans « Sans dossier ».
- **Un template se range par son NOM** : toutes ses langues suivent (Meta identifie un template par son nom, la console
  en montre une ligne par langue). Meta ne sait rien des dossiers, qui sont une donnée de notre base.
- **Dupliquer un scénario garde son dossier.**
- **Bornes** : 60 caractères pour un nom de dossier, unique par espace et par type sans tenir compte de la casse ;
  50 dossiers au plus par type et par espace (au-delà, la barre d'onglets ne se lit plus).

## Données

Une migration (son numéro se lit par `npm run migrations` au moment de l'écrire), appliquée AVANT le code qui la lit :
elle n'ajoute que des objets neufs et une colonne nullable, l'ancien code y survit.

- `dossiers` : `id` uuid, `tenant_id` (clé étrangère vers l'espace, `on delete cascade`), `type` (`scenario` ou
  `template`, CHECK), `nom` (CHECK sur `char_length` entre 1 et 60, jamais une regex à répétition, cf. mémoire
  « Regex Postgres : répétition 255 »), `created_at`. Index unique sur `(tenant_id, type, lower(nom))`.
- `workflows.dossier_id` : uuid nullable, clé étrangère vers `dossiers(id)` en `on delete set null`.
- `template_dossiers` : `(tenant_id, template_name)` en clé primaire, `dossier_id` vers `dossiers(id)` en
  `on delete cascade`. Une ligne par template rangé ; « Sans dossier » = aucune ligne.
- Que la purge RGPD d'un espace couvre ces deux tables (par la cascade sur l'espace, ou en les nommant) : à vérifier
  contre `src/` au moment du plan, la règle du projet étant qu'une table que la purge nomme part SEULE et AVANT.

## API

Toutes en module `tenant` du registre (`modulesDeRoutes`), donc sous `etapeEspace` et prouvées par
`tests/scope-tenant.test.ts`. Chaque requête filtre `tenant_id = $1` ; un dossier n'est accepté que s'il est de
l'espace ET du bon type (un dossier de templates ne reçoit pas un scénario).

- `GET /tenants/:t/dossiers?type=scenario|template` : la liste, avec le nombre d'éléments de chacun.
- `POST /tenants/:t/dossiers` `{ type, nom }` : 201, 409 sur un nom pris, 422 au-delà de 50.
- `PATCH /tenants/:t/dossiers/:id` `{ nom }` : renommer.
- `DELETE /tenants/:t/dossiers/:id` : ses éléments repassent dans « Sans dossier ».
- `PUT /tenants/:t/workflows/dossier` `{ ids, dossierId | null }` : ranger une sélection de scénarios. Le scénario
  système du répondeur (`systeme = 'repondeur'`) n'est ni listé ni rangeable.
- `PUT /tenants/:t/templates/dossier` `{ noms, dossierId | null }` : ranger une sélection de templates par leur nom.
- La liste des scénarios (`listResume`) et celle des templates rendent `dossierId` pour chaque élément.
- Supprimer un template (`DELETE .../templates/:name`) retire aussi sa ligne de `template_dossiers`.

Hors champ, délibérément : l'API publique (`/v1`) et les outils MCP ne voient pas les dossiers.

## Écrans

Sur la page Scénarios et la page Templates, la même barre (un composant partagé) :

- les onglets « Tous », « Sans dossier », puis les dossiers par ordre alphabétique, chacun avec son compte ;
  « + Dossier » ouvre la saisie d'un nom ;
- l'onglet choisi reste en mémoire par page (stockage du navigateur, par confort) ;
- sur l'onglet d'un dossier, son menu propose « Renommer » et « Supprimer » (avec confirmation, qui dit que ses
  éléments repassent dans « Sans dossier ») ;
- « Déplacer vers… » dans le menu ⋯ de chaque ligne et dans la barre de sélection : une liste des dossiers, plus
  « Sans dossier ». La page Templates gagne pour cela la sélection par case à cocher de la page Scénarios.

Un membre non admin voit les onglets et filtre, sans « + Dossier », « Renommer », « Supprimer » ni « Déplacer vers… ».

## Tests attendus

- Serveur : isolation (un dossier d'un autre espace, ou de l'autre type, est refusé au rangement comme au listage) ;
  nom pris, borne de 50, renommage, suppression qui libère les éléments ; rangement en masse ; template supprimé qui
  sort de son dossier ; duplication qui garde le dossier ; non-admin refusé en écriture.
- Intégration (CI) : la migration relue en base (contraintes sous leur nom, `confdeltype` des deux clés étrangères).
- Console : e2e de la barre (filtrer, créer, renommer, supprimer), de « Déplacer vers… » à l'unité et en masse sur les
  deux pages, et de l'absence des gestes d'écriture pour un non-admin.

## Ordre de déploiement

1. La migration seule, appliquée sur la base avant tout code qui la lit.
2. L'API et la console dans un même commit : la console ne lit les dossiers que si la route répond, et tolère son
   absence (une barre vide), parce que Vercel publie la console au push, avant le `up` de l'API.

## Méthode de livraison

**En direct, puis une relecture indépendante en fin de lot** : chemin hors envoi de messages, réversible (supprimer un
dossier ne perd rien), critères vérifiables par test ; la migration et l'isolation entre espaces sont les deux points
qui demandent l'œil du relecteur.

**L'essai réel qui clôt le lot** : Julien crée deux dossiers sur la page Scénarios de son espace, y range des scénarios
à l'unité et en masse, renomme puis supprime un dossier ; même chose sur la page Templates avec un template qui a deux
langues ; un membre non admin ne voit que les onglets.
