# Refactor des écrans d'agent : un en-tête qui identifie, un sous-menu vertical

**Source** : croquis de Julien du 2026-09-23, plus sept arbitrages pris en deux rondes le même jour.

**But** : les deux écrans de réglage d'agent (l'agent de Meta et un agent IA) portent aujourd'hui une barre
d'onglets horizontale de onze et neuf entrées, sans rien qui dise DE QUEL agent on parle. On leur donne un
en-tête qui identifie l'agent, dit ce qui lui manque et ce qu'il a produit, et on fait descendre les onglets
en colonne à gauche du contenu.

## Ce qui est arbitré, et ne se rediscute pas

| Question | Réponse de Julien |
|---|---|
| Ordre du sous-menu | À plat, ordre actuel. Aucun regroupement, aucun déplacement. |
| Le chiffre de l'en-tête | Les messages échangés sur 30 jours. |
| Périmètre du chiffre | Tous les messages, entrants et sortants, des conversations que l'agent a tenues. |
| Le logo d'un agent IA | Des SVG embarqués, un par fournisseur, dérivés du préfixe de l'identifiant du modèle. |
| Ce que porte l'en-tête | Le logo, l'identité de l'agent, les étapes obligatoires, le chiffre. |
| La liste des agents | Chaque ligne porte aussi le logo de son modèle. |
| Les étapes côté agent IA | Dérivées des manques déjà calculés, pas d'une nouvelle mécanique serveur. |

## L'état actuel, mesuré et non supposé

- `web/app/mba/parametres/page.tsx` : onze onglets (`apercu`, `assistant`, `activation`, `business`, `faq`,
  `competences`, `outils`, `fichiers`, `sites`, `historique`, `test`), largeur `max-w-6xl`, et la barre de
  complétion `MbaCompletion` posée au-dessus des onglets.
- `web/app/agents/page.tsx` : neuf onglets (`construction`, `identite`, `objectif`, `connaissance`,
  `outils`, `perimetre`, `modele`, `historique`, `tester`), largeur `max-w-4xl`, et deux bandeaux au-dessus
  des onglets, « ce qui manque » et « ce qui a changé sans vous ».
- `web/components/MbaTabs.tsx` n'a **que ces deux consommateurs**. C'est ce qui rend le refactor local.
- Les suites e2e s'appuient sur `data-testid="mba-tab-<clé>"` (`apercu`, `business`, `competences`, `faq`,
  `identite`, `modele`, `objectif`, `outils`, `perimetre`).
- `web/public/meta-business-agent.png` existe déjà : rien à fabriquer pour le logo de l'agent de Meta.
- Les identifiants de modèle sont de la forme `fournisseur/modèle` (`src/agent/modeles.ts`). Cinq
  fournisseurs au catalogue aujourd'hui : `zai`, `mistral`, `google`, `openai`, `anthropic`.
- Aucune mesure de messages n'existe, ni pour l'agent de Meta ni par agent IA. `consommationAgent` compte
  des **sessions**, des jetons et un coût sur 30 jours, jamais des messages.

## Architecture : deux composants partagés

🔴 **Un composant par écran serait une copie, et ce dépôt a déjà tranché contre.** Le commentaire de
`MbaTabs` dit pourquoi il existe : ne pas recopier huit fois le même marquage. Deux en-têtes jumeaux
divergeraient au premier ajustement de style, sur les deux écrans les plus denses de la console.

**`web/components/EnteteAgent.tsx`** (nouveau). Purement présentationnel : il ne lit rien, ne sait pas d'où
viennent ses données, et ne connaît ni l'agent de Meta ni les agents IA. Ses props :

```ts
export interface EtapeEntete {
  /** Ce qui manque, dans les mots du client. */
  message: string;
  /** L'onglet où ça se corrige. Absent = l'étape ne se règle pas ici (le moyen de paiement). */
  onglet?: string;
}

export interface EnteteAgentProps {
  /** L'image du logo, ou `null` pour retomber sur la pastille. */
  logo: { src: string; alt: string } | null;
  /** Le repli : deux ou trois lettres, quand aucun logo ne convient. */
  pastille: string;
  /** Le nom de l'agent, en gros. */
  nom: string;
  /** Sous le nom : le numéro pour l'agent de Meta, le modèle pour un agent IA. */
  precision?: string;
  /** L'état, rendu tel quel : la pastille d'activation d'un agent IA, l'état du numéro côté Meta. */
  etat?: React.ReactNode;
  /** Ce qui reste à faire. Liste vide = tout est réglé, et l'en-tête le dit. */
  etapes: EtapeEntete[];
  /** Rendu seulement quand il y a un ratio VRAI à montrer (l'agent de Meta). */
  ratio?: { faites: number; total: number };
  /** `null` = on ne sait pas encore, ou la route n'existe pas encore. On n'affiche alors AUCUN chiffre. */
  messages30j: number | null;
  onOnglet(cle: string): void;
}
```

**`web/components/MbaTabs.tsx`** (modifié) gagne une prop `orientation: 'horizontale' | 'verticale'`, avec
`'horizontale'` par défaut pour que rien d'autre ne bouge. 🔴 **Il garde son `data-testid` mot pour mot** :
c'est ce qui laisse les huit suites e2e passer sans qu'on y touche, et c'est la seule raison pour laquelle ce
refactor est bon marché. Le `role="tablist"` et le `aria-selected` restent, l'orientation n'ajoute qu'un
`aria-orientation="vertical"`.

## La mise en page

En-tête pleine largeur, puis une grille à deux colonnes : le menu à gauche (largeur fixe, 14rem), le
contenu à droite. **Les deux écrans passent à `max-w-6xl`** : la fiche d'agent est à `4xl` aujourd'hui et
perdrait exactement la place que prend la colonne.

⚠️ **Sous `lg`, la colonne redevient la barre horizontale d'aujourd'hui.** Même composant, même identifiants,
`orientation="horizontale"` : une colonne de onze entrées sur un téléphone mangerait l'écran. L'en-tête
s'empile alors, le logo au-dessus du nom.

## L'en-tête, écran par écran

**Agent de Meta** : le logo `meta-business-agent.png`, le nom d'affichage du numéro et le numéro en
précision, l'état du numéro, les étapes issues de `getMbaCompletion` (qui rend déjà `taches`, `faites`,
`total` et la RAISON de chaque manque), et le chiffre. `MbaCompletion` quitte le corps de page ; sa logique
d'affichage part dans l'en-tête, son appel réseau reste identique.

**Agent IA** : le logo du fournisseur, le nom interne de l'agent, le modèle en précision, la pastille
Brouillon / Actif / Désactivé (le composant `Activation` existant, passé en `etat`), les étapes issues de
`lireBandeaux`, et le chiffre. Le bandeau « ce qui manque » quitte le corps.

⚠️ **Le bandeau « Ce qui a changé sans vous » RESTE dans le corps, et ce n'est pas un oubli.** Ces
avertissements (un outil débranché par un rafraîchissement MCP) ne bloquent pas l'activation, délibérément :
un serveur tiers n'a pas de droit de veto sur l'activation d'un agent. Les faire entrer dans un compteur
d'étapes obligatoires rendrait ce compteur faux.

### 🔴 L'écart découvert en écrivant cette spec : « n sur m » n'existe pas côté agent IA

L'arbitrage disait « les cinq contrôles deviennent 3 sur 5 étapes ». En lisant
`src/agent/setup/lint.ts`, il y en a **six, et l'un d'eux est conditionnel** : « la base est remplie mais
l'outil de recherche est inactif » ne s'applique que s'il y a À LA FOIS des fiches et des outils actifs. Le
dénominateur varie donc d'un agent à l'autre, et la route `/manques` ne rend que ce qui MANQUE, jamais la
liste des contrôles appliqués.

**Trois façons d'en sortir, et on prend la troisième :**

1. Figer le dénominateur à 5 ou 6 dans le front. **Refusé** : ce serait un nombre faux la moitié du temps,
   et ce dépôt a une longue liste de chiffres recopiés qui ont dérivé.
2. Faire rendre au serveur la liste complète des contrôles avec leur état, comme le fait la complétion de
   l'agent de Meta. C'est l'option que Julien a écartée pour son coût, et elle reste la bonne à terme.
3. **L'en-tête annonce le nombre d'étapes QUI RESTENT**, pas un ratio : « 2 étapes à finir », et « Tout est
   réglé » à zéro. Aucun dénominateur n'est nécessaire, aucun travail serveur, et le chiffre est vrai.

**Conséquence assumée** : les deux en-têtes ne disent pas tout à fait la même chose. L'agent de Meta montre
en plus son ratio, parce qu'il en a un VRAI (`faites` sur `total`, calculé au serveur). C'est une asymétrie
de DONNÉE, pas de dessin, et la cacher demanderait d'inventer un chiffre d'un côté.

## Le chiffre : ce qu'il compte, et comment

**Définition, la même des deux côtés** : les messages, entrants et sortants, des conversations que cet agent
a tenues au moins une fois au cours des 30 derniers jours, comptés sur cette même fenêtre.

⚠️ **Ce que cette définition emporte, et qui doit être dit à l'écran** : une conversation qu'un opérateur a
reprise en cours de route compte en entier. C'est le sens courant d'« échangé », et l'alternative (ne
compter que ce que l'agent a écrit) donne un chiffre deux fois plus petit qui ne dit rien du client.

**Aucune migration.** Les deux requêtes tiennent sur les tables existantes :

- **Agent de Meta** : les conversations de l'espace dont au moins un message a l'origine effective `mba`
  dans la fenêtre, puis le compte des messages de ces conversations sur la fenêtre. L'origine se lit par
  `ORIGINE_EFFECTIVE_SQL` (`src/inbox/origine.ts`), **jamais par une copie du fragment** : c'est un module
  partagé, et l'agrégat de l'écran quantitatif s'en sert déjà.
- **Agent IA** : les conversations dont le couple `(tenant_id, wa_id)` apparaît dans `agent_sessions` pour
  CET `agent_id` sur la fenêtre, puis le même compte. ⚠️ `agent_sessions` ne porte **pas** de
  `conversation_id` : le rapprochement se fait sur `wa_id`, ce qui est la seule clé disponible et doit être
  écrit dans le code plutôt que redécouvert.

**Deux routes, toutes deux en lecture seule et réservées à l'administrateur comme leurs voisines :**

- `GET /tenants/:tenantId/mba/:phoneNumberId/messages` -> `{ messages: number, jours: 30 }`
- `GET /tenants/:tenantId/agents/:agentId/messages` -> `{ messages: number, jours: 30 }`

`jours` est rendu par le serveur et affiché par l'écran, qui ne l'invente pas : c'est la règle déjà suivie
par `ConsommationAgent`.

⚠️ **Le plan d'exécution se REGARDE avant de poser un index.** Un index partiel est un contrat avec une
requête précise ; on n'en ajoute un que si la mesure le demande, et on écrit alors quelle requête il sert.

### 🔴 La fenêtre de casse au déploiement, et comment on la supprime

Vercel publie la console **à chaque `git push`**, l'API attend sa revue finale et son déploiement. Un écran
qui appelle une route neuve est donc en 404 entre les deux, ce qui est déjà arrivé ici pendant plus d'une
heure.

**La parade est dans le contrat du composant, pas dans l'ordre des gestes** : `messages30j` vaut `null` tant
que la route ne répond pas, et l'en-tête n'affiche **aucun chiffre** plutôt qu'un zéro. Un échec de lecture
ne fait rien tomber. Vide se lit « on ne sait pas », zéro se lirait « cet agent n'a parlé à personne ».
L'écran peut donc partir avant l'API sans que personne ne voie une panne.

## Les logos

`web/public/llm/<fournisseur>.svg`, un par fournisseur du catalogue, plus une fonction de résolution :

```ts
/** Le logo d'un modèle, d'après le préfixe de son identifiant. `null` = on n'en a pas, on met la pastille. */
export function logoDuModele(modele: string): { src: string; alt: string } | null;
```

⚠️ **Le repli n'est pas un cas rare.** Un agent peut porter un modèle « en place, hors liste » (l'écran
Modèle gère déjà ce cas), et un fournisseur peut entrer au catalogue sans que son logo soit ajouté. La
pastille porte alors les premières lettres du fournisseur.

⚠️ **Le dépôt est public, et ce sont des marques tierces.** L'usage est nominatif, il sert à dire quel
modèle fait tourner l'agent, ce qui est l'usage admis d'une marque. Point signalé à Julien avant écriture.

Les mêmes logos apparaissent en petit sur chaque ligne de la liste des agents.

## Ce qui ne bouge pas, et qui doit être vérifié

- L'ordre des onglets, sur les deux écrans.
- `?tab=` dans l'adresse : une fiche reste partageable, un rafraîchissement retrouve son onglet, et les
  liens des étapes continuent d'ouvrir le bon onglet.
- Les panneaux eux-mêmes : aucun contenu d'onglet n'est touché.
- Les `data-testid` des onglets, donc les huit suites e2e.
- L'écran `/mba` (le guide) n'est pas dans le périmètre.

## Rayon de souffle

- `MbaTabs` est modifié et a deux consommateurs, les deux du périmètre. Sa prop nouvelle est **optionnelle
  avec un défaut** : aucun appelant existant ne change de comportement.
- `MbaCompletion` et les bandeaux quittent le corps des pages : vérifier qu'aucun test e2e ne les cherche à
  leur ancienne place, et déplacer l'assertion plutôt que la supprimer.
- La largeur de la fiche d'agent passe de `4xl` à `6xl` : c'est visible sur tout ce que la page rend, pas
  seulement sur le menu.
- Les deux routes neuves entrent dans un module déjà gardé : vérifier qu'elles sont bien montées sous la
  classe d'accès `tenant` et qu'elles apparaissent dans l'inventaire de `tests/scope-tenant.test.ts`.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions qui tranchent : la production
emprunte ce chemin (c'est l'écran qui règle l'agent qui répond aux clients) ; c'est réversible ; les
critères sont **en partie** vérifiables par un test, mais la moitié visuelle demande un oeil ; et le code
touché porte des invariants invisibles (les identifiants e2e, l'onglet dans l'adresse, la tolérance à
l'absence de route).

**L'essai réel qui clôt la feature, et qu'aucun test vert ne remplace** : Julien ouvre les deux écrans, sur
un agent complètement réglé et sur un agent vide, et vérifie trois choses : le bon logo, le bon nombre
d'étapes restantes, et un chiffre de messages qui correspond à ce que montre le Performance Lab.

## Hors périmètre

Le guide `/mba`, le contenu des onglets, la page Crédit, et tout regroupement ou réordonnancement des
onglets.
