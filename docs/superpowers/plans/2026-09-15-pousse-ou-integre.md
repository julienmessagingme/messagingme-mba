# « Ça pousse ou ça intègre » : ce que l'agent fait de la réponse d'un connecteur

> **Pour un exécutant :** ce plan se lit avec la spec ci-dessous, qui est la conversation de cadrage du
> 2026-09-15 résumée en tête. Les lots sont ordonnés : le 1 et le 2 vont ensemble (la base et le résolveur),
> le 3 est l'écran qui motive tout, le 4 défait proprement ce qui devient faux, le 5 ouvre un chemin neuf.

**But :** un appel de connecteur déclare ce que l'agent fait de sa réponse. S'il POUSSE, l'agent reçoit
seulement de quoi dire « c'est fait » ou « ça a raté ». S'il INTÈGRE, l'agent lit les champs que le client a
choisis pour LUI.

**Architecture :** la décision passe de l'APPEL (partagé) au couple (agent, appel). La colonne
`agent_tools.output_paths` existe déjà depuis la migration 0086 et n'était pas remplie ; elle devient la
source de vérité du résolveur. L'appel garde ses champs comme DÉFAUT de pré-remplissage.

**Stack :** Postgres (une migration), Fastify, React/Next.

**Spec :** cadrage par questions du 2026-09-15 avec Julien, reporté en § « Ce qui a été tranché ».

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine sur le DIFF entre chaque lot**, et c'est la raison qui l'impose :
les quatre questions du CLAUDE.md global répondent oui deux fois en haut de liste.

1. **La production emprunte-t-elle ce chemin ?** Oui. Un appel de connecteur part vers le système d'un
   client, déclenché par un modèle, en pleine conversation avec un contact.
2. **Est-ce réversible ?** Non pour la moitié qui compte. Un appel qui POUSSE agit pour de vrai : l'essai de
   `add-tag` pose vraiment l'étiquette sur un abonné.
3. **Testable mécaniquement, ou faut-il un œil ?** Les deux. Les gardes et le résolveur se tiennent par des
   tests ; l'enchaînement des deux questions à l'écran demande quelqu'un qui clique.
4. **Invariants invisibles ?** Oui, et c'est le plus sérieux : `outputPaths` gouverne **ce qui part chez le
   fournisseur du modèle**. Déplacer ce filtre d'une table à une autre déplace un contrôle de fuite de
   données, et un filtre lu au mauvais endroit ne produit aucune erreur, juste plus de données envoyées.

⚠️ **feature-loop est écarté** parce que sa porte est la complétude mécanique, et qu'aucun critère mécanique
ne dit si l'enchaînement « ça pousse ou ça intègre ? » puis « quoi ? » se comprend. **Workflow est écarté**
sans discussion : pas de lancement multi-agents sans le oui explicite de Julien.

🔴 **L'ESSAI RÉEL QUI CLÔT LA FEATURE, sur un vrai compte et un vrai système** (aucune méthode ne le
remplace) :

1. Julien ouvre son appel `testadd` (`POST https://ai.messagingme.app/api` + `/subscriber/add-tag`), le donne
   à un agent IA en répondant **« ça pousse »**, et le teste depuis le bac à sable de l'agent.
2. Il vérifie **dans UChat** que l'étiquette est réellement posée sur l'abonné de test, et que l'agent a
   répondu « c'est fait » sans inventer de contenu.
3. Il crée un second appel qui **INTÈGRE** (une lecture sur la même API), coche un champ, et vérifie que la
   valeur remonte dans la réponse de l'agent, mot pour mot.
4. Il refait l'essai depuis le **bac à sable** et vérifie que ce qui s'affiche est bien ce que l'agent
   recevra, ce qui est FAUX aujourd'hui (voir la découverte 2 ci-dessous).

---

## Global Constraints

- `tenant_id = $1` sur CHAQUE requête. Le pooler est superuser, la RLS est contournée, le filtrage en code
  est le seul contrôle.
- `safeParse`, jamais `parse` ni `as`, sur toute entrée externe.
- Un message destiné au client sort en **4xx**, jamais en 5xx : Cloudflare remplace le corps des 5xx.
- Migration qui AJOUTE une colonne écrite par le code : elle passe **AVANT** le déploiement.
- Pas de tiret cadratin ni demi-cadratin dans la doc et les messages.
- Tout test de non-régression est vérifié **par MUTATION dans les deux sens**.
- `git commit --only <chemins>`, jamais `git add` puis commit nu.

---

## Ce qui a été tranché (le 2026-09-15, par questions)

| Décision | Choix | Ce qui l'a emporté |
|---|---|---|
| La case « C'est bien ce que je veux envoyer » | **retirée** | Elle transforme une information en formalité. Le résumé de ce qui PART reste, sans case. |
| Où vit « ça pousse ou ça intègre » | **sur le couple (agent, appel)** | Ce que l'agent lit est une propriété de son usage, pas de l'endpoint. |
| Où vit le choix des champs | **idem**, avec l'onglet Réponse de l'appel comme **défaut** | Un seul endroit décide, un autre pré-remplit. |
| Changer le défaut | **ne touche aucun agent en service** | Personne ne doit voir un agent changer de comportement sans l'avoir demandé. |
| Retour d'un appel qui POUSSE | `ok` + statut HTTP + message d'erreur du système | Un agent qui ne reçoit rien invente. |
| Bouton Essayer côté agent | **oui**, avec les valeurs de test déjà saisies sur l'appel | Julien l'a choisi en connaissant le coût (voir Risques). |
| Côté Meta | **rien n'est affiché** | Choix de Julien. Le trou assumé est écrit dans `todo.md` (lot 4). |
| Badge « à finir » | **retiré** | Un appel est complet dès qu'il a un chemin. La garde se déplace dans l'écran de l'agent. |
| Chemin MBA direct | **oui**, créer un outil depuis Tools > Outils sans agent IA | Inventer un agent dont on n'a pas besoin pour exposer à Meta est une corvée sans objet. |
| Reprise des données | **aucune** | Mesuré en base le 2026-09-15 : 1 appel déclaré, **0 outil issu d'un appel**. |

### Deux découvertes faites en préparant ce plan

🔴 **1. LA COLONNE EXISTE DÉJÀ, ET ELLE EST DÉLIBÉRÉMENT VIDE.** `agent_tools.output_paths` est créée par la
migration 0086, et `PgCatalogStore.ajouterConnecteur` y écrit `'{}'::text[]` avec ce commentaire : « `binding`
reste vide et `output_paths` aussi, parce que la REQUÊTE les porte. Les remplir en double créerait deux
vérités. » Le raisonnement était juste pour l'ancienne conception ; il s'inverse ici. **La migration ne porte
donc qu'une colonne neuve, `nature`.**

🔴 **2. LE BAC À SABLE MONTRE UNE RÉPONSE VIDE POUR TOUT OUTIL DE CONNECTEUR, ET IL PROMET LE CONTRAIRE.**
`connecteurSimule` (`src/agent/resolvers/simulation.ts`) boucle sur `outil.outputPaths`, c'est-à-dire sur la
colonne toujours vide : il rend `{}`. Or son commentaire affirme « le client voit exactement ce que l'agent
recevra, sans l'appel ». Deux vérités existaient donc bel et bien, et c'est celle que personne ne lisait qui
s'affichait dans le bac à sable. **Ce défaut se répare tout seul au lot 1**, dès que la colonne est remplie,
et le lot 2 le verrouille par un test.

---

## Structure des fichiers

| Fichier | Responsabilité après ce chantier |
|---|---|
| `db/migrations/0150_outil_nature.sql` | **créer** : `agent_tools.nature`, CHECK à deux valeurs |
| `src/agent/catalog.ts` | `OutilComplet.nature`, et `nature` + `outputPaths` dans l'entrée de `ajouterConnecteur` |
| `src/agent/catalog.pg.ts` | écrire `nature` et `output_paths` à la création, les relire, les modifier |
| `src/agent/resolvers/http.ts` | lire `outil.outputPaths` ; brancher le retour d'un POUSSE |
| `src/agent/resolvers/simulation.ts` | rien à changer, elle devient juste vraie (test de garde) |
| `src/http/agent-tools.ts` | accepter `nature` et `outputPaths` au rattachement ; garde de cohérence |
| `src/http/agent-requetes.ts` | retirer la garde 409 et la garde anti-vidage du 2026-09-15 |
| `web/components/AgentConnecteurs.tsx` | les deux questions, le bouton Essayer, le résumé sans case |
| `web/components/RequetesConnecteur.tsx` | onglet Réponse libellé « défaut », nature par défaut, badge retiré |
| `web/components/BibliothequeOutils.tsx` | création directe d'un outil pour Meta (lot 5) |

---

## Task 1 : la base et le magasin

**Files**
- Create: `db/migrations/0150_outil_nature.sql`
- Modify: `src/agent/catalog.ts`, `src/agent/catalog.pg.ts`
- Test: `tests/integration/outil-nature.integration.test.ts`

**Interfaces**
- Produit : `OutilComplet.nature: 'pousse' | 'integre'` ; `ajouterConnecteur(..., { nature, outputPaths })`.
- Consommé par : les tâches 2, 3 et 5.

- [ ] **Étape 1 : la migration**

```sql
-- L'outil dit ce que l'agent fait de la réponse. `integre` par défaut : c'est le comportement de tous les
-- outils existants (ils lisent des champs), et un défaut qui change le comportement serait une reprise
-- déguisée. ⚠️ Mesuré avant d'écrire : ZÉRO outil issu d'un appel en base, donc ce défaut ne touche rien.
alter table agent_tools
  add column if not exists nature text not null default 'integre'
  check (nature in ('pousse', 'integre'));
```

- [ ] **Étape 2 : le type** — ajouter `nature` à `OutilComplet` et à l'entrée de `ajouterConnecteur`.
      🔴 Le champ est OBLIGATOIRE dans l'entrée, pas optionnel : un `nature?:` laisserait un appelant futur
      l'oublier et retomber sur `integre` en silence, c'est-à-dire sur le filtre vide donc sur un outil muet.

- [ ] **Étape 3 : l'écriture** — dans `ajouterConnecteur`, remplacer `'{}'::text[]` par `$N::text[]` et
      ajouter `nature`. **Réécrire le commentaire** qui justifie le vide : il devient faux, et une
      justification fausse est pire qu'aucune parce qu'elle sera recopiée.

- [ ] **Étape 4 : le test d'intégration**, vérifié par mutation

```ts
it('🔴 les champs de sortie sont écrits SUR L OUTIL, pas laissés vides', async () => {
  const outil = await store.ajouterConnecteur(t, agent, { ...base, nature: 'integre', outputPaths: ['statut'] });
  expect(outil!.outputPaths).toEqual(['statut']);
  // Mutation à vérifier : remettre '{}'::text[] -> ce test tombe, et le bac à sable redevient muet.
});

it('🔴 un outil qui POUSSE garde une liste vide, et c est un état valide', async () => {
  const outil = await store.ajouterConnecteur(t, agent, { ...base, nature: 'pousse', outputPaths: [] });
  expect(outil!.nature).toBe('pousse');
  expect(outil!.outputPaths).toEqual([]);
});
```

- [ ] **Étape 5 : commit** `feat(outils): un outil dit ce qu il fait de la reponse, et porte ses champs`

---

## Task 2 : le résolveur

**Files**
- Modify: `src/agent/resolvers/http.ts`
- Test: `tests/agent-resolveur-http-nature.test.ts`

**Interfaces**
- Consomme : `OutilComplet.nature` et `outil.outputPaths` (tâche 1).
- Produit : pour un POUSSE, `{ contenu: { ok, statut, erreur? }, httpStatus }`.

- [ ] **Étape 1 : écrire les tests d'abord**, ils décrivent les quatre cas

```ts
it('🔴 un outil qui INTÈGRE lit les champs de L OUTIL, pas ceux de l appel', async () => {
  // L appel en déclare trois, l outil un seul : c est l outil qui gagne. Sans ça, un client qui restreint
  // pour un agent verrait l autre agent tout recevoir.
  const r = await appel({ outil: { nature: 'integre', outputPaths: ['statut'] }, requete: { outputPaths: ['statut', 'email', 'interne'] } });
  expect(Object.keys(r.contenu)).toEqual(['statut']);
});

it('🔴 un outil qui POUSSE ne renvoie AUCUN champ du corps, seulement le verdict', async () => {
  const r = await appel({ outil: { nature: 'pousse', outputPaths: [] }, reponse: { statut: 'ok', email: 'a@b.c' } });
  expect(r.contenu).toEqual({ ok: true, statut: 200 });
  expect(JSON.stringify(r.contenu)).not.toContain('a@b.c');
});

it('🔴 un POUSSE qui échoue dit POURQUOI, sinon l agent annonce un succès qui n a pas eu lieu', async () => {
  const r = await appel({ outil: { nature: 'pousse' }, httpStatus: 422, corps: '{"error":"tag inconnu"}' });
  expect(r.contenu).toMatchObject({ ok: false, statut: 422 });
  expect(JSON.stringify(r.contenu)).toContain('tag inconnu');
});

it('🔴 un INTÈGRE sans aucun champ reste un REFUS : c est une déclaration incomplète', async () => {
  const r = await appel({ outil: { nature: 'integre', outputPaths: [] } });
  expect(r.ok).toBe(false);
});
```

- [ ] **Étape 2 : lancer, constater l'échec** (`outil.nature` n'est pas encore lu).

- [ ] **Étape 3 : l'implémentation.** Le filtre de sortie de l'étape 2 du résolveur devient :

```ts
// 🔴 LE FILTRE VIENT DE L OUTIL, PAS DE L APPEL (2026-09-15). Un appel est partagé ; ce que CET agent lit
// ne l est pas. Lire celui de l appel ferait recevoir à un agent ce qu un autre a choisi.
if (outil.nature === 'integre' && outil.outputPaths.length === 0) {
  return { ok: false, contenu: { erreur: 'cet outil ne déclare aucun champ à lire' }, erreur: 'outputPaths vide' };
}
```

et le filtre final (étape 9) se dédouble :

```ts
if (outil.nature === 'pousse') {
  // ⚠️ LE CORPS N EST PAS LU DU TOUT, et c est le point : il peut contenir la fiche entière du client.
  // On rend le VERDICT, plus le message d erreur quand il y en a un, jamais le contenu d un succès.
  const ok = res.status >= 200 && res.status < 300;
  return { contenu: ok ? { ok, statut: res.status } : { ok, statut: res.status, erreur: messageErreur(brut) }, httpStatus: res.status };
}
```

- [ ] **Étape 4 : la garde du bac à sable**, qui répare la découverte 2

```ts
it('🔴 le bac à sable montre EXACTEMENT ce que l agent recevra', () => {
  // Il le PROMETTAIT et ne le faisait pas : il bouclait sur `outil.outputPaths`, toujours vide.
  const simule = connecteurSimule({ binding: {}, outputPaths: ['statut'], nature: 'integre' });
  expect(Object.keys(simule.contenu)).toEqual(['statut']);
});
it('⚠️ et pour un POUSSE il montre le verdict, pas des champs inventés', () => {
  expect(connecteurSimule({ binding: {}, outputPaths: [], nature: 'pousse' }).contenu).toMatchObject({ ok: true });
});
```

- [ ] **Étape 5 : mutation dans les deux sens** sur les quatre tests, puis commit.

---

## Task 3 : l'écran de l'agent, celui qui motive tout

**Files**
- Modify: `web/components/AgentConnecteurs.tsx`, `web/lib/api-agent-tools.ts`, `src/http/agent-tools.ts`
- Test: `web/e2e/agents-connecteurs.spec.ts`, `tests/http-agent-tools.test.ts`

**Interfaces**
- Consomme : `nature` + `outputPaths` (tâches 1 et 2), la route d'essai de brouillon existante
  (`POST /tenants/:t/agent-requetes/test`), qui accepte déjà un appel NON enregistré.
- Produit : `POST .../tools/connecteur` accepte `nature` et `outputPaths`.

- [ ] **Étape 1 : la route accepte les deux champs, et garde leur cohérence**

```ts
nature: z.enum(['pousse', 'integre']),
outputPaths: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
```

```ts
// 🔴 UNE GARDE DE COHÉRENCE, PAS DEUX CHAMPS INDÉPENDANTS. « Intègre » sans champ produit un outil qui
// refusera chaque appel en conversation : le refuser ICI, c est le dire là où le client peut corriger.
if (d.nature === 'integre' && d.outputPaths.length === 0) {
  return reply.code(400).send({ error: 'choisissez au moins un champ à lire, ou déclarez que cet appel pousse seulement' });
}
// ⚠️ L INVERSE AUSSI : des champs cochés sur un « pousse » seraient ignorés en silence par le résolveur.
if (d.nature === 'pousse' && d.outputPaths.length > 0) {
  return reply.code(400).send({ error: 'un appel qui pousse ne lit aucun champ' });
}
```

- [ ] **Étape 2 : l'écran.** Retirer la case de confirmation ; **garder le résumé** de ce qui part. Enchaîner :
  1. un choix à deux branches, « ça pousse » / « ça intègre », rien de pré-coché au-delà du défaut de l'appel ;
  2. si « ça intègre » : le bouton **Essayer** (valeurs de test de l'appel, modifiables) puis les chemins de la
     réponse en cases à cocher, pré-cochés avec le défaut de l'appel.
  Le bouton final reste gris tant qu'il manque quelque chose, et **dit quoi**, à côté de lui (le mécanisme
  `manque` posé le 2026-09-15 est étendu, pas réécrit).

- [ ] **Étape 3 : les E2E**, qui sont ici la seule preuve que l'enchaînement se comprend

```ts
test('🔴 « ça pousse » : aucune question de plus, et on peut donner l appel', async ({ page }) => { /* ... */ });
test('🔴 « ça intègre » : Essayer, puis cocher, et le bouton dit ce qui manque en attendant', async ({ page }) => { /* ... */ });
test('🔴 les défauts de l appel PRÉ-REMPLISSENT, ils ne verrouillent pas', async ({ page }) => { /* ... */ });
test('⚠️ le résumé de ce qui PART reste affiché, sans case à cocher', async ({ page }) => { /* ... */ });
```

- [ ] **Étape 4 : commit.**

---

## Task 4 : défaire ce qui devient faux

**Files**
- Modify: `src/http/agent-requetes.ts`, `web/components/RequetesConnecteur.tsx`, `features.md`, `todo.md`
- Test: `tests/http-agent-requetes.test.ts`, `web/e2e/connecteurs-requetes.spec.ts`

🔴 **CE LOT RETIRE DU CODE ÉCRIT LE MATIN MÊME, et c'est voulu.** Le badge « à finir », le refus 409 au
rattachement et la garde anti-vidage répondaient au bon problème avec l'ancienne structure. Les laisser en
place ferait exister deux endroits qui refusent la même chose, dont un qui ne sait plus pourquoi.

- [ ] **Étape 1** : retirer la garde 409 de `agent-tools.ts` (elle est remplacée par la garde de cohérence de
      la tâche 3, qui est meilleure : elle vit dans l'écran où l'on peut corriger).
- [ ] **Étape 2** : retirer la garde anti-vidage de `agent-requetes.ts`. Vider le défaut d'un appel ne casse
      plus rien, puisque les agents portent leur propre copie.
- [ ] **Étape 3** : retirer le badge « à finir » et son test.
- [ ] **Étape 4** : renommer l'onglet Réponse en disant ce qu'il est devenu : « Réponse (valeur par défaut) »,
      avec une phrase qui dit que chaque agent recoche pour lui.
- [ ] **Étape 5** : mettre à jour `features.md` (les trois entrées du 2026-09-15 sur le brouillon deviennent
      partiellement fausses) et **rafraîchir l'empreinte de la fiche d'aide** concernée (`tests/aide-proposer.test.ts`
      rend la CI rouge sinon).
- [ ] **Étape 6** : écrire dans `todo.md` le trou assumé côté Meta : « un client qui restreint les champs pour
      son agent IA peut croire que ça vaut aussi pour Meta ; Meta appelle le système en direct et lit tout ».
- [ ] **Étape 7 : commit.**

---

## Task 5 : le chemin direct vers Meta

**Files**
- Modify: `web/components/BibliothequeOutils.tsx`, `src/http/agent-catalogue.ts`, `src/agent/catalog.pg.ts`
- Test: `tests/http-agent-catalogue.test.ts`, `web/e2e/outils-espace.spec.ts`

**Interfaces**
- Consomme : `ajouterConnecteur` (tâche 1), qui exige aujourd'hui un `agentId`.

- [ ] **Étape 1 : le magasin sait créer un outil SANS agent.** `agent_tools.agent_id` est `not null` (0086) :
      vérifier en base si une colonne nullable est nécessaire, ou si le consommateur suffit. 🔴 **Mesurer
      avant d'écrire la migration**, ne pas déduire du type TypeScript.
- [ ] **Étape 2 : la route** de création d'outil depuis la bibliothèque, réservée aux admins.
- [ ] **Étape 3 : l'écran** : « + un outil pour Meta » dans Tools > Outils, qui demande l'appel, les mots, et
      **aucune question de nature** (Meta lit tout).
- [ ] **Étape 4 : les tests**, dont celui qui garde l'absence de question :

```ts
it('🔴 un outil créé pour Meta ne demande PAS « pousse ou intègre » : Meta lit toute la réponse', ...);
```

- [ ] **Étape 5 : commit.**

---

## Ordre de déploiement

🔴 **La migration 0150 AJOUTE une colonne que le code écrit : elle passe AVANT le déploiement.** Séquence sur
le VPS, dans cet ordre exact : `git pull`, `compose build mba-api`, `compose run --rm --no-deps mba-api npm
run migrate`, PUIS `up -d --build`. **Relire `schema_migrations` juste après `migrate`**, et mettre à jour le
compteur de `CLAUDE.md` à ce moment-là, jamais en écrivant le fichier SQL.

⚠️ **Le front et l'API se déploient séparément** (Vercel automatique au push, VPS à la main) : entre les deux,
le produit est incohérent. Les tâches 1 et 2 vont donc en production **avant** la tâche 3, et jamais l'inverse.

⚠️ **Contrôle public après CHAQUE `up --build`**, et `nginx -s reload` si 502 : il est intermittent.

---

## Risques, nommés

| Risque | Ce qui le borne |
|---|---|
| Le filtre lu au mauvais endroit envoie plus de données au modèle, **sans erreur** | Le test du lot 2 qui vérifie que l'outil gagne sur l'appel, muté dans les deux sens |
| Le bouton Essayer côté agent tape sur le système du client à chaque rattachement | Choix explicite de Julien. Les valeurs de test viennent de l'appel, donc pas d'un vrai contact |
| Deux endroits cochent les mêmes champs et divergent | L'appel ne PRÉ-REMPLIT que ; changer le défaut ne touche aucun agent en service, et c'est testé |
| Côté Meta, la restriction ne s'applique pas et l'écran se tait | Trou assumé, écrit dans `todo.md` au lot 4 |
| `agent_tools.agent_id` est `not null` et bloque le lot 5 | Mesuré en base avant d'écrire la migration, pas déduit |
