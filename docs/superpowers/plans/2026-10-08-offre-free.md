# L'offre gratuite s'appelle « Free »

Décision de Julien du 2026-10-08 : l'offre gratuite ne s'appelle plus « Base » mais « Free », partout où elle se lit,
**valeur de l'API comprise** (`GET /tenants/:tenantId/offre` et l'outil MCP `get_plan` rendent `offre: "free"`, et la
grille `free`, `pro`, `entreprise`). La base de données garde `base` : la valeur interne ne change pas, la traduction se
fait à la sortie, en un seul endroit.

## Méthode de livraison

En direct, sans agent, puis UNE relecture : un renommage réversible, quelques points de passage, dont un seul sur un
chemin que la production emprunte (la vue de l'offre), tenu par la tolérance de la console aux deux valeurs.
L'essai réel qui clôt le lot : la page de l'offre d'un espace en Free, et `get_plan` appelé depuis Claude Code, disent « Free ».

## Tâches

1. **Serveur, la sortie** (`src/offres/vue.ts`) : `OffrePublique` (`free`, `pro`, `entreprise`) et `offrePublique(o)`,
   appliquées à `VueOffre.offre` et aux clés de la grille. Rien d'autre ne change de nom côté serveur (`Offre`, `DROITS`,
   `offre_de_l_espace`). Tests : `offre-route`, `offres-console-parite`, la vue.
2. **Textes du serveur** : la description de `get_plan`, le refus des scénarios hors offre, les alertes du Pro.
3. **Console** (`web/lib/offre.ts`) : `NOMS_OFFRES` en `free`, le nom affiché « Free », et la LECTURE qui accepte
   encore `base` (offre et clés de la grille) d'une API d'avant ce lot, ramené à `free`. `web/app/offre/page.tsx`.
   Tests : `web/lib/offre.test.ts` (les deux valeurs), e2e de la page de l'offre.
4. **Docs vues par le client** : `features.md`, les fiches d'aide (`choisir-mon-offre`, `recharger-le-credit-ia`) et
   leurs empreintes, `documentation.md` (la valeur interne et la valeur publique).

## Ordre de déploiement

Aucune migration. La console tolère les deux valeurs, donc l'ordre ne casse rien : push (Vercel publie la console),
CI lue, puis `up` de l'API, des deux workers ET de `mba-web` (il sert encore la console entière sur
`mba.messagingme.app` : construit avant ce lot, il lirait `free` comme une offre inconnue), puis
`npm run aide:charger` (le bot d'aide sert les fiches depuis la table `aide_fiches`). Essai réel : `/offre` d'un espace en Free et `get_plan` depuis Claude Code
disent « Free ».
