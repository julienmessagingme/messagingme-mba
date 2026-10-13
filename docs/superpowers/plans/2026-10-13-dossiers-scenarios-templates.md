# Dossiers de scénarios et de templates : le plan

**Spec** : `docs/superpowers/specs/2026-10-13-dossiers-scenarios-templates-design.md`, approuvée par Julien le
2026-10-13. Plan court (règle de Julien) : tâches, interfaces, tests attendus, ordre de déploiement.

## Choix d'exécution, au regard de la spec

- **Tout passe par un module neuf**, `dossiers`, et la console fusionne. La liste des scénarios et celle des templates
  ne changent pas : `GET /dossiers?type=` rend les dossiers ET le rangement (`clé -> dossierId`, la clé étant l'id d'un
  scénario ou le nom d'un template). Les comptes des onglets se calculent dans la console sur la liste réellement
  affichée : un template supprimé chez Meta n'y gonfle aucun compte. Une seule route de rangement,
  `PUT /dossiers/rangement { type, cles, dossierId | null }`, au lieu des deux de la spec : même contrat, un seul
  contrôle d'isolation à tenir.
- **La duplication d'un scénario et la suppression d'un template suivent dans la console** : après « Dupliquer », la
  copie est rangée dans le dossier de l'original ; après « Supprimer » un template, sa clé est rangée dans « Sans
  dossier ». Un échec de ce second geste est sans conséquence (une copie « Sans dossier », une ligne orpheline qui ne
  compte nulle part), et les routes des scénarios et des templates restent intactes.
- **Aucune purge RGPD à toucher** : `dossiers` et `template_dossiers` tombent avec l'espace par cascade, et l'effacement
  d'un contact ne les lit pas.

## Tâches

### Lot A, la migration seule

1. **`db/migrations/<prochain numéro>_dossiers.sql`** (le numéro se lit par `npm run migrations` à l'écriture).
   `dossiers` (`id`, `tenant_id` en cascade, `type` sous `dossiers_type_chk`, `nom` sous `dossiers_nom_chk` par
   `char_length` 1 à 60, `created_at`) ; index unique `dossiers_nom_unique (tenant_id, type, lower(nom))` ;
   `workflows.dossier_id` nullable vers `dossiers(id)` en `on delete set null`, avec un index partiel
   `where dossier_id is not null` (la mise à null d'une suppression de dossier le lit) ; `template_dossiers`
   (`tenant_id` en cascade, `template_name`, `dossier_id` en cascade, clé primaire `(tenant_id, template_name)`, index
   sur `dossier_id`). `lock_timeout` de 5 s (une clé étrangère posée sur `workflows`, table du chemin chaud).

### Lot B, l'API et la console

2. **Le magasin** `src/dossiers/store.ts` (types, interface) et `src/dossiers/store.pg.ts`. Chaque requête filtre
   `tenant_id = $1` ; un dossier n'est accepté que de l'espace ET du type demandé ; le scénario système
   (`systeme is not null`) n'est ni lu ni rangé.
3. **Les routes** `src/http/dossiers.ts` (`registerDossiers`), entrée `dossiers` de classe `tenant` dans
   `modulesDeRoutes` (`src/server.ts`), câblée dans `src/index.ts`. Lecture à toute session de l'espace, écritures aux
   admins (`forbidNonAdmin`). Corps validés par Zod `safeParse`.
4. **La console, socle** : `web/lib/api/dossiers.ts` (appels ; une 404 de la liste rend « aucun dossier », pour la
   fenêtre entre le push et le `up`), `web/components/BarreDossiers.tsx` (onglets « Tous · Sans dossier · <dossiers>
   · + Dossier » avec comptes, menu Renommer / Supprimer de l'onglet actif, onglet retenu par page dans le stockage du
   navigateur) et `web/components/DeplacerVers.tsx` (la liste des dossiers plus « Sans dossier »).
5. **La page Scénarios** (`web/app/workflows/page.tsx`) : la barre, le filtre, « Déplacer vers… » dans le menu ⋯ et
   dans la barre de sélection, la copie rangée avec l'original.
6. **La page Templates** (`web/app/templates/page.tsx`) : la sélection par case à cocher (par NOM : les lignes d'un
   même template dans plusieurs langues se cochent ensemble), la barre, le filtre, « Déplacer vers… », la clé libérée
   après une suppression.
7. **La doc** : `features.md` (sections Automatisations et Templates WhatsApp), les fiches qui les citent et leurs
   empreintes (`creer-un-scenario`, `declencher-un-scenario-automatiquement`, `faire-approuver-un-modele`,
   `modele-ou-scenario`), `documentation.md` (le module, les deux tables, la règle d'isolation).

## Interfaces

- `type TypeDossier = 'scenario' | 'template'` ; `interface Dossier { id: string; nom: string }`.
- `DossierStore` : `lister(tenant, type): Dossier[]` ; `rangement(tenant, type): Record<string, string>` ;
  `creer(tenant, type, nom): Dossier | 'pris' | 'plein'` ; `renommer(tenant, id, nom): Dossier | 'pris' | null` ;
  `supprimer(tenant, id): boolean` ; `ranger(tenant, type, cles, dossierId | null): number | 'dossier_inconnu'`.
- Routes : `GET /tenants/:t/dossiers?type=` -> `{ dossiers, rangement }` ; `POST /tenants/:t/dossiers { type, nom }`
  -> 201 `{ dossier }`, 409 nom pris, 422 au-delà de `MAX_DOSSIERS_PAR_TYPE` (50) ; `PATCH /tenants/:t/dossiers/:id
  { nom }` -> 200, 404, 409 ; `DELETE /tenants/:t/dossiers/:id` -> 200, 404 ; `PUT /tenants/:t/dossiers/rangement
  { type, cles, dossierId }` -> 200 `{ ranges }`, 404 dossier inconnu, 400 au-delà de 500 clés.
- Console : `listerDossiers(tenant, type)`, `creerDossier`, `renommerDossier`, `supprimerDossier`, `ranger(tenant,
  type, cles, dossierId)` ; `<BarreDossiers type dossiers comptes actif admin onChoisir onChange />` ;
  `<DeplacerVers dossiers onChoisir />`.

## Tests attendus

- **Routes** (`tests/http-dossiers.test.ts`, faux magasin) : non-admin refusé sur chaque écriture et admis en
  lecture ; nom vide, d'espaces seuls ou de plus de 60 caractères refusé ; 409 et 422 rendus tels quels ; type inconnu
  refusé ; plus de 500 clés refusées ; un id non uuid rend 404 sans toucher le magasin.
- **Isolation** : `tests/scope-tenant.test.ts` couvre le module par le registre ; un test de route vérifie que le
  magasin reçoit l'espace du JETON, jamais celui du corps.
- **Magasin en base** (`tests/integration/dossiers-store.test.ts`, CI seulement) : un dossier d'un autre espace ou de
  l'autre type est refusé au rangement (`dossier_inconnu`) et invisible au listage ; nom pris sans tenir compte de la
  casse ; borne de 50 ; supprimer un dossier libère ses scénarios (`dossier_id` à null) et ses templates (lignes
  parties) ; le scénario système n'est pas rangé ; un rangement vers « Sans dossier » retire les lignes de templates.
- **Console** (`web/e2e/dossiers.spec.ts`) : sur chaque page, filtrer par onglet, créer, renommer, supprimer (avec
  confirmation), « Déplacer vers… » à l'unité et en masse ; un template à deux langues se range d'un geste ; la copie
  d'un scénario rangé reste dans son dossier ; un non-admin voit les onglets sans aucun geste d'écriture ; une route
  absente (404) laisse la page telle qu'avant.

## Review Focus

- Un nom de dossier qui ne diffère que par la casse ou les espaces de tête et de fin : refusé comme pris (le nom est
  ramené par `trim` avant l'index `lower(nom)`).
- L'onglet actif est supprimé, ou n'existe plus au rechargement (retenu par le navigateur) : retour à « Tous ».
- Une sélection qui mêle un scénario d'un autre espace (id forgé) : il n'est simplement pas rangé, et le compte rendu
  le dit (`ranges` inférieur au nombre de clés).
- Deux admins rangent en même temps vers un dossier que l'un supprime : la clé étrangère refuse, la route rend 404,
  rien n'est rangé à moitié.
- Un template supprimé chez Meta reste rangé en base : il n'apparaît dans aucun onglet ni aucun compte.

## Ordre de déploiement

1. **Lot A** poussé SEUL : CI, image construite, `migrate` (en vérifiant dans l'image que seule cette migration est
   en attente, `pg_stat_activity` lu avant), puis relecture en base (contraintes sous leur nom, `confdeltype` des trois
   clés étrangères, prédicat de l'index partiel). Aucun `up` nécessaire : l'ancien code ne lit rien de neuf.
2. **Lot B** : CI, puis `up` de l'API. La console part au push par Vercel et tolère l'absence de la route jusqu'au
   `up`.

## Méthode de livraison

**En direct, puis une relecture indépendante en fin de lot B** (le lot A, une migration d'objets neufs, est relu en
base point par point) : chemin hors envoi de messages, réversible (supprimer un dossier ne perd rien), critères
vérifiables par test ; la migration et l'isolation entre espaces sont les deux points qui demandent l'œil du relecteur.

**L'essai réel qui clôt le lot** : Julien crée deux dossiers sur la page Scénarios de son espace, y range des
scénarios à l'unité et en masse, renomme puis supprime un dossier ; même chose sur la page Templates avec un template
qui a deux langues ; un membre non admin ne voit que les onglets.
