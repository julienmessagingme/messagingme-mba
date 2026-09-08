# Lots B + C + D : l'Inbox devient une boîte mail

> **Pour un exécutant :** ce plan se déroule tâche par tâche. Les étapes sont en cases à cocher (`- [ ]`).

**But :** remplacer les trois boutons de filtre de l'Inbox par un menu de dossiers façon boîte mail, avec des
compteurs justes, un dossier **Archivé** alimenté par un geste, et la charge par collaborateur pour le
manager.

**Architecture :** une seule route de compteurs rend l'objet entier en une requête groupée ; l'archivage est
un horodatage sur la conversation, effacé par le CHEMIN entrant et par lui seul ; le menu est un composant
de l'écran Inbox, pas une barre de navigation (l'onglet Inbox n'en a plus depuis le lot A).

**Stack :** Fastify, Postgres (pg), React, Tailwind, vitest (unitaire + intégration), Playwright.

**Spec :** [../specs/2026-09-08-refonte-menus-design.md](../specs/2026-09-08-refonte-menus-design.md)

## Contraintes globales

- 🔴 **`tenant_id = $1` sur CHAQUE requête neuve.** Le pooler est superuser, la RLS est contournée : c'est le
  seul contrôle d'isolation entre clients.
- 🔴 **La migration 0120 AJOUTE une colonne que le code écrit : elle passe AVANT le déploiement.**
  Séquence sur le VPS : `compose build mba-api`, puis `compose run --rm --no-deps mba-api npm run migrate`,
  puis `up -d --build`. Les migrations vivent DANS L'IMAGE, d'où le build en premier.
- 🔴 **Une erreur destinée à l'utilisateur sort en 4xx, jamais en 5xx** : Cloudflare remplace le corps de
  toute 5xx par sa page d'erreur.
- Pas de tirets longs. Commentaires et libellés en français, anglais via `t('fr', 'en')`.
- `git commit --only <chemins>`, jamais `git add` puis un commit nu.

## Écarts assumés par rapport à la spec

1. **La section « Affectation » est visible par les ADMINS ET LES MANAGERS**, pas par les admins seuls. Le
   dépôt a un rôle `manager`, et c'est déjà lui plus l'admin qui peuvent affecter une conversation
   (`peutAffecter` dans `web/app/inbox/page.tsx`). Montrer le geste sans montrer la charge serait incohérent.
2. **Le compteur « À traiter » change de valeur pour certains espaces**, et c'est une correction : l'actuel
   `countATraiter` ne retire pas les contacts BLOQUÉS alors que la liste les retire. Le compteur et la liste
   se contredisent donc déjà. Le compteur unifié applique le même filtre que la liste, ce qui peut faire
   BAISSER le nombre affiché chez un client qui a des contacts bloqués. C'est le bon sens de la correction.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0120_conversations_archivees.sql` (créer) | `archived_at` + son index partiel |
| `src/inbox/store.pg.ts` (modifier) | Archiver/désarchiver, exclure de la liste, le dossier Archivé, les compteurs en UNE requête |
| `src/http/inbox.ts` (modifier) | `GET /conversations/counts`, `POST /conversations/:id/archive` et `/unarchive` |
| `src/index.ts` (modifier) | Câblage des trois routes |
| `web/lib/api/inbox.ts` (modifier) | Les trois appels |
| `web/components/InboxDossiers.tsx` (créer) | Le menu de dossiers et ses compteurs. UN composant, testable seul |
| `web/app/inbox/page.tsx` (modifier) | Rend le menu, porte la sélection et les deux actions |
| `tests/integration/inbox-archivage.integration.test.ts` (créer) | L'archivage contre un vrai Postgres |
| `tests/integration/inbox-compteurs.integration.test.ts` (créer) | Les cinq compteurs et la charge par membre |
| `web/e2e/inbox-dossiers.spec.ts` (créer) | Le menu, les compteurs, l'archivage vus du navigateur |

---

## Tâche 1 : la colonne d'archivage, et qui l'efface

**Fichiers :**
- Créer : `db/migrations/0120_conversations_archivees.sql`
- Modifier : `src/inbox/store.pg.ts`
- Test : `tests/integration/inbox-archivage.integration.test.ts`

**Interfaces :**
- Produit : `archiverConversation(tenantId, conversationId, archive: boolean): Promise<boolean>`,
  et `ListConversationsOptions` gagne `archivees?: boolean`.

- [ ] **Étape 1 : écrire la migration**

```sql
-- 0120_conversations_archivees.sql : ranger une conversation finie, sans rien effacer.
--
-- 🔴 CE QUE L'ARCHIVAGE FAIT, ET CE QU'IL NE FAIT PAS. Il sort la conversation des dossiers Tout, A traiter
-- et Signale, et la range dans Archive. Rien n'est efface, aucun chiffre d'analytics ne bouge, les messages
-- restent lisibles. C'est un rangement, pas une suppression.
--
-- 🔴 UN MESSAGE DU CONTACT LA DESARCHIVE (decision de Julien, 2026-09-08). Une conversation archivee puis
-- relancee par le client est exactement le cas ou l'oublier coute cher. L'archivage range ce qui est fini,
-- il ne reduit personne au silence.
--
-- Un HORODATAGE et pas un booleen : « depuis quand » se posera (trier le dossier, purger un jour), et une
-- colonne booleenne ne pourra plus repondre.
--
-- IDEMPOTENTE : `if not exists` sur la colonne comme sur l'index.

alter table conversations
  add column if not exists archived_at timestamptz;

-- Le dossier Archive lit « les archivees de cet espace, les plus recentes d'abord ». Les QUATRE autres
-- dossiers lisent l'inverse (`archived_at is null`), qui est le cas de l'immense majorite des lignes : un
-- index partiel sur les archivees sert le premier sans alourdir les seconds.
create index if not exists conversations_archivees_idx
  on conversations (tenant_id, archived_at desc)
  where archived_at is not null;
```

- [ ] **Étape 2 : écrire le test d'intégration qui échoue**

Créer `tests/integration/inbox-archivage.integration.test.ts`, sur le patron de
`tests/integration/automation-possession.integration.test.ts` (même `describe.skipIf(!url)`, même création
d'un tenant jetable). Cas à couvrir :

```ts
it('🔴 archiver sort des dossiers ordinaires et met dans Archivé', async () => {
  expect(await store.archiverConversation(tenantId, convId, true)).toBe(true);
  const ordinaires = await store.listConversations(tenantId);
  expect(ordinaires.map((c) => c.id)).not.toContain(convId);
  const archivees = await store.listConversations(tenantId, { archivees: true });
  expect(archivees.map((c) => c.id)).toEqual([convId]);
});

it('désarchiver la remet dans les dossiers ordinaires', async () => {
  await store.archiverConversation(tenantId, convId, true);
  expect(await store.archiverConversation(tenantId, convId, false)).toBe(true);
  expect((await store.listConversations(tenantId)).map((c) => c.id)).toContain(convId);
});

it('🔴 un MESSAGE DU CONTACT désarchive, dans la même écriture', async () => {
  // C'est la décision de Julien, et le point le plus facile à casser plus tard : une conversation archivée
  // que le client relance doit revenir, sinon on l'a rendue muette.
  await store.archiverConversation(tenantId, convId, true);
  await store.recordInbound(tenantId, { waId, type: 'text', body: 'vous êtes là ?', buttonPayload: null, messageId: 'wamid.desarchive' });
  expect((await store.listConversations(tenantId)).map((c) => c.id)).toContain(convId);
});

it('🔴 preuve inverse : un ENVOI SORTANT automatisé ne désarchive PAS', async () => {
  // `recordInbound` et `recordOutboundByWaId` partagent le MÊME upsert. Sans une décision prise par le
  // CHEMIN appelant, une campagne qui touche un contact archivé le ferait remonter dans l'inbox de tout le
  // monde. Le dépôt a déjà cette règle pour les événements d'automation, pour la même raison.
  await store.archiverConversation(tenantId, convId, true);
  await store.recordOutboundByWaId(tenantId, waId, { body: 'promo', messageId: 'wamid.promo', origine: 'campagne' });
  expect((await store.listConversations(tenantId)).map((c) => c.id)).not.toContain(convId);
});

it('une conversation d’un AUTRE espace ne s’archive pas', async () => {
  expect(await store.archiverConversation(autreTenantId, convId, true)).toBe(false);
});
```

- [ ] **Étape 3 : appliquer la migration sur la base jetable et lancer le test**

```bash
npx vitest run tests/integration/inbox-archivage.integration.test.ts
```
Attendu : ÉCHEC, `archiverConversation is not a function`.

- [ ] **Étape 4 : écrire l'implémentation dans `src/inbox/store.pg.ts`**

```ts
  /**
   * Range une conversation dans Archivé, ou l'en sort.
   *
   * Rend `false` si la conversation est inconnue DANS CET ESPACE : l'appelant en fait un 404, jamais un
   * succès silencieux. Idempotent : archiver deux fois écrase l'horodatage, ce qui est sans conséquence.
   */
  async archiverConversation(tenantId: string, conversationId: string, archive: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update conversations set archived_at = ${archive ? 'now()' : 'null'}
        where id = $1 and tenant_id = $2`,
      [conversationId, tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }
```

Dans `upsertConversationByWaId`, ajouter un paramètre explicite et l'écrire dans le `do update` :

```ts
  private async upsertConversationByWaId(
    tenantId: string, waId: string, preview: string,
    /**
     * 🔴 CE MESSAGE DÉSARCHIVE-T-IL LA CONVERSATION ? Gouverné par le CHEMIN APPELANT, jamais deviné ici.
     *
     * Cet upsert est partagé par l'INBOUND (un message du contact) et par les ENVOIS SORTANTS AUTOMATISÉS
     * (campagne, scénario). Décider dans la dépendance partagée ferait remonter dans l'inbox de tout le
     * monde chaque contact archivé qu'une campagne touche. Le dépôt applique déjà cette règle aux
     * événements d'automation, pour exactement la même raison.
     *
     * Requis et non optionnel : c'est le compilateur qui doit obliger un futur troisième appelant à
     * trancher, plutôt qu'un défaut qui le laisserait hériter d'un choix qu'il n'a pas fait.
     */
    desarchive: boolean,
  ): Promise<string> {
```

et dans le `on conflict ... do update set`, ajouter :

```sql
         archived_at = case when $4::boolean then null else conversations.archived_at end,
```

Les deux appelants passent leur choix : `recordInbound` -> `true`, `recordOutboundByWaId` -> `false`.

Dans `listConversations`, ajouter le filtre, juste après le filtre `blocked_at` :

```ts
    // Les quatre dossiers ordinaires excluent les archivées ; le dossier Archivé ne montre qu'elles.
    where.push(opts.archivees === true ? 'c.archived_at is not null' : 'c.archived_at is null');
```

et déclarer `archivees?: boolean;` dans `ListConversationsOptions`.

- [ ] **Étape 5 : lancer les tests pour les voir PASSER**

```bash
npx vitest run tests/integration/inbox-archivage.integration.test.ts && npx tsc --noEmit
```

- [ ] **Étape 6 : commiter**

```bash
git commit --only db/migrations/0120_conversations_archivees.sql src/inbox/store.pg.ts tests/integration/inbox-archivage.integration.test.ts -m "feat(inbox): archiver une conversation, et la desarchiver au message suivant du contact"
```

---

## Tâche 2 : les compteurs, en une requête

**Fichiers :**
- Modifier : `src/inbox/store.pg.ts`, `src/http/inbox.ts`, `src/index.ts`
- Test : `tests/integration/inbox-compteurs.integration.test.ts`

**Interfaces :**
- Produit : `compterConversations(tenantId): Promise<CompteursInbox>` avec
  `interface CompteursInbox { tout: number; aTraiter: number; signalees: number; archivees: number; nonAffectees: number; parMembre: Array<{ userId: string; nom: string; n: number }> }`
  et la route `GET /tenants/:tenantId/conversations/counts`.

- [ ] **Étape 1 : écrire le test d'intégration qui échoue**

```ts
it('🔴 les cinq compteurs portent sur TOUTE la base, pas sur une page', async () => {
  // C'est déjà la règle du compteur « À traiter » actuel, et elle doit tenir pour les cinq : un compteur
  // calculé sur les lignes chargées descendrait dès qu'on pagine.
  const c = await store.compterConversations(tenantId);
  expect(c.tout).toBe(4);
  expect(c.aTraiter).toBe(2);
  expect(c.signalees).toBe(1);
  expect(c.archivees).toBe(1);
});

it('🔴 « tout » EXCLUT les archivées : sinon deux dossiers compteraient la même conversation', () => { /* couvert ci-dessus : 4 non archivées, 1 archivée */ });

it('🔴 un contact BLOQUÉ ne compte nulle part, comme il n’apparaît nulle part', async () => {
  // L'ancien `countATraiter` ne retirait PAS les bloqués alors que la liste les retire : le compteur et la
  // liste se contredisaient. C'est cette contradiction que le compteur unifié ferme.
  await bloquer(contactId);
  expect((await store.compterConversations(tenantId)).tout).toBe(3);
});

it('la charge par membre, et le non-affecté', async () => {
  const c = await store.compterConversations(tenantId);
  expect(c.nonAffectees).toBe(2);
  expect(c.parMembre).toEqual([
    { userId: jean, nom: 'Jean', n: 2 },
    { userId: marie, nom: 'Marie', n: 0 },
  ]);
});

it('🔴 un membre SANS conversation est listé à zéro', () => { /* couvert : Marie à 0 */ });
```

- [ ] **Étape 2 : lancer le test pour le voir ÉCHOUER**

```bash
npx vitest run tests/integration/inbox-compteurs.integration.test.ts
```

- [ ] **Étape 3 : écrire l'implémentation**

Dans `src/inbox/store.pg.ts` :

```ts
  /**
   * Les compteurs du menu de dossiers, en UNE requête.
   *
   * 🔴 UNE SEULE REQUÊTE, et ce n'est pas de l'optimisation prématurée : six allers-retours pour afficher un
   * menu, ce sont six occasions que deux chiffres lus à deux instants différents ne s'accordent pas, et le
   * menu affiche les deux côte à côte.
   *
   * ⚠️ Les contacts BLOQUÉS sont exclus PARTOUT, comme dans `listConversations`. L'ancien `countATraiter` ne
   * le faisait pas : son chiffre pouvait dépasser le nombre de lignes que la liste montrait, sans que rien
   * ne l'explique.
   */
  async compterConversations(tenantId: string): Promise<CompteursInbox> {
    const base = `from conversations c
                    left join contacts ct on ct.id = c.contact_id
                   where c.tenant_id = $1 and ct.blocked_at is null`;
    const res = await this.pool.query<{
      tout: string; a_traiter: string; signalees: string; archivees: string; non_affectees: string;
    }>(
      `select
         count(*) filter (where c.archived_at is null)::text as tout,
         count(*) filter (where c.archived_at is null and c.control_owner <> 'app_workflow')::text as a_traiter,
         count(*) filter (where c.archived_at is null and exists (
           select 1 from conversation_analysis a where a.conversation_id = c.id and a.abusive))::text as signalees,
         count(*) filter (where c.archived_at is not null)::text as archivees,
         count(*) filter (where c.archived_at is null and c.assigned_to is null)::text as non_affectees
       ${base}`,
      [tenantId],
    );
    // La charge par membre : TOUS les membres de l'espace, y compris à zéro. Un collaborateur à zéro est une
    // information pour un manager, et ne le montrer que lorsqu'il a du travail le rendrait invisible au
    // moment précis où on le cherche.
    const membres = await this.pool.query<{ user_id: string; nom: string | null; email: string; n: string }>(
      `select u.id as user_id, u.name as nom, u.email,
              count(c.id) filter (where c.archived_at is null)::text as n
         from users u
         left join conversations c on c.assigned_to = u.id and c.tenant_id = $1
         left join contacts ct on ct.id = c.contact_id
        where u.tenant_id = $1 and (c.id is null or ct.blocked_at is null)
        group by u.id, u.name, u.email
        order by count(c.id) filter (where c.archived_at is null) desc, coalesce(u.name, u.email) asc`,
      [tenantId],
    );
    const r = res.rows[0];
    return {
      tout: Number(r?.tout ?? 0),
      aTraiter: Number(r?.a_traiter ?? 0),
      signalees: Number(r?.signalees ?? 0),
      archivees: Number(r?.archivees ?? 0),
      nonAffectees: Number(r?.non_affectees ?? 0),
      parMembre: membres.rows.map((m) => ({ userId: m.user_id, nom: m.nom ?? m.email, n: Number(m.n) })),
    };
  }
```

Dans `src/http/inbox.ts`, la route, déclarée **AVANT** `/conversations/:conversationId` (`counts` n'est pas
un identifiant, c'est la même raison qui fait déclarer `todo-count` avant) :

```ts
  app.get('/tenants/:tenantId/conversations/counts', guard, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Absente sur une instance à deps minimales : un menu sans chiffres reste un menu, il ne doit pas
    // rendre l'écran indisponible.
    if (!deps.compterConversations) return reply.code(200).send(COMPTEURS_VIDES);
    // Même cache que `todo-count` : deux mécanismes pour la même donnée dériveraient l'un de l'autre.
    return reply.code(200).send(await compteurs.lire(cleCompteurs(tenant), () => deps.compterConversations!(tenant)));
  });
```

- [ ] **Étape 4 : lancer les tests pour les voir PASSER**

```bash
npx vitest run tests/integration/inbox-compteurs.integration.test.ts && npx tsc --noEmit && npx vitest run
```

- [ ] **Étape 5 : commiter**

```bash
git commit --only src/inbox/store.pg.ts src/http/inbox.ts src/index.ts tests/integration/inbox-compteurs.integration.test.ts -m "feat(inbox): les compteurs du menu de dossiers, en une requete"
```

---

## Tâche 3 : les routes d'archivage

**Fichiers :**
- Modifier : `src/http/inbox.ts`, `src/index.ts`
- Test : `tests/http-inbox.test.ts` (le fichier existant)

**Interfaces :**
- Consomme : `archiverConversation` (tâche 1).
- Produit : `POST /tenants/:tenantId/conversations/:conversationId/archive` et `.../unarchive`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
it('archiver rend 200 et invalide les compteurs', async () => {
  const res = await srv.inject({ method: 'POST', url: `${base}/c1/archive`, ...h(adminTok) });
  expect(res.statusCode).toBe(200);
  expect(cap.archives).toEqual([{ id: 'c1', archive: true }]);
});

it('🔴 une conversation inconnue rend 404, pas un succès silencieux', async () => {
  const res = await srv.inject({ method: 'POST', url: `${base}/inconnue/archive`, ...h(adminTok) });
  expect(res.statusCode).toBe(404);
});

it('🔴 le tenant de l’URL ne peut pas dépasser celui du jeton', async () => {
  expect((await srv.inject({ method: 'POST', url: `/tenants/t2/conversations/c1/archive`, ...h(adminTok) })).statusCode).toBe(403);
});
```

- [ ] **Étape 2 : lancer les tests pour les voir ÉCHOUER**

```bash
npx vitest run tests/http-inbox.test.ts
```

- [ ] **Étape 3 : écrire les deux routes**

```ts
  /**
   * Archiver / désarchiver. Deux routes et non un `PATCH` à drapeau : l'intention se lit dans l'adresse, et
   * un corps mal formé ne peut pas transformer un archivage en désarchivage.
   *
   * Ouvert aux OPÉRATEURS comme aux admins : ranger sa boîte est le geste de celui qui la traite.
   */
  for (const [chemin, archive] of [['archive', true], ['unarchive', false]] as const) {
    app.post(`/tenants/:tenantId/conversations/:conversationId/${chemin}`, guard, async (req, reply) => {
      const tenant = scopeTenant(req);
      if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
      if (!deps.archiverConversation) return reply.code(503).send({ error: 'archivage indisponible sur cette instance' });
      const { conversationId } = req.params as { conversationId: string };
      const ok = await deps.archiverConversation(tenant, conversationId, archive);
      if (!ok) return reply.code(404).send({ error: 'conversation inconnue' });
      invaliderCompteurs(tenant); // le dossier change de contenu : les chiffres du menu aussi.
      return reply.code(200).send({ archived: archive });
    });
  }
```

- [ ] **Étape 4 : lancer les tests, puis commiter**

```bash
npx vitest run tests/http-inbox.test.ts && npx tsc --noEmit
git commit --only src/http/inbox.ts src/index.ts tests/http-inbox.test.ts -m "feat(inbox): les routes d archivage, scopees tenant et 404 sur inconnue"
```

---

## Tâche 4 : le menu de dossiers

**Fichiers :**
- Créer : `web/components/InboxDossiers.tsx`
- Modifier : `web/app/inbox/page.tsx`, `web/lib/api/inbox.ts`

**Interfaces :**
- Consomme : `GET /conversations/counts` (tâche 2).
- Produit : `<InboxDossiers dossier={...} onChange={...} compteurs={...} peutVoirAffectation={...} />`,
  `type DossierInbox = 'toutes' | 'aTraiter' | 'signalees' | 'archivees' | { membre: string } | 'nonAffectees'`.

- [ ] **Étape 1 : écrire le composant**

```tsx
/**
 * Le menu de dossiers de l'Inbox, façon boîte mail.
 *
 * 🔴 CE N'EST PAS UNE BARRE DE NAVIGATION. L'onglet Inbox n'en a plus depuis le lot A : ce menu vit DANS
 * l'écran, il change ce que la liste montre, pas la page où l'on est.
 *
 * ⚠️ Le compteur est TOUJOURS affiché, y compris à zéro, contrairement aux boutons de filtre qu'il remplace.
 * Dans une boîte mail, « Signalé (0) » est une information (« rien à relire ») ; un libellé nu laisse croire
 * que le chiffre n'a pas chargé.
 */
```

Structure : une colonne, deux sections. Section « Conversations » : Tout, À traiter, Signalé, Archivé.
Section « Affectation » (seulement si `peutVoirAffectation`) : Non affecté, puis un membre par ligne.
Chaque entrée porte `data-testid={'dossier-' + cle}` et son compteur `data-testid={'dossier-n-' + cle}`.

- [ ] **Étape 2 : brancher l'écran**

Dans `web/app/inbox/page.tsx`, remplacer l'état `filtre` (`'toutes' | 'aTraiter' | 'signalees'`) par
`dossier: DossierInbox`, et étendre `filtreEnParams` :

```ts
function dossierEnParams(d: DossierInbox): { aTraiter?: boolean; signalees?: boolean; archivees?: boolean; affectee?: string } {
  if (d === 'aTraiter') return { aTraiter: true };
  if (d === 'signalees') return { signalees: true };
  if (d === 'archivees') return { archivees: true };
  if (d === 'nonAffectees') return { affectee: 'aucune' };
  if (typeof d === 'object') return { affectee: d.membre };
  return {};
}
```

⚠️ Retirer les trois anciens boutons de filtre : les laisser ferait deux endroits pour le même choix, et
c'est exactement ce que le dépôt a déjà payé sur le contrôle du fil.

- [ ] **Étape 3 : vérifier au type et au build**

```bash
cd web && npx tsc --noEmit && npm run build
```

- [ ] **Étape 4 : commiter**

```bash
git commit --only web/components/InboxDossiers.tsx web/app/inbox/page.tsx web/lib/api/inbox.ts -m "feat(inbox): le menu de dossiers, avec ses compteurs"
```

---

## Tâche 5 : archiver depuis l'écran

**Fichiers :**
- Modifier : `web/app/inbox/page.tsx`, `web/lib/api/inbox.ts`
- Test : `web/e2e/inbox-dossiers.spec.ts` (créer)

- [ ] **Étape 1 : les cases à cocher et les deux boutons**

Une case par ligne de conversation, un bandeau d'action qui n'apparaît qu'avec au moins une case cochée :
**« Archiver (N) »** dans les dossiers ordinaires, **« Désarchiver (N) »** dans le dossier Archivé.

⚠️ **Le glisser-déposer reste hors périmètre**, comme la spec l'a écrit : la case à cocher rend déjà le
geste, et il coûterait la moitié du lot (clavier, cible de dépôt, retour visuel, annulation).

- [ ] **Étape 2 : écrire l'E2E**

```ts
test('🔴 archiver retire de Tout et fait monter le compteur d’Archivé', async ({ page }) => { /* … */ });
test('🔴 le compteur est affiché même à ZÉRO', async ({ page }) => { /* … */ });
test('la section Affectation n’apparaît PAS pour un opérateur', async ({ page }) => { /* … */ });
test('🔴 preuve inverse : elle apparaît pour un manager', async ({ page }) => { /* … */ });
```

- [ ] **Étape 3 : lancer, puis commiter**

```bash
cd web && npx playwright test e2e/inbox-dossiers.spec.ts --reporter=line
git commit --only web/app/inbox/page.tsx web/lib/api/inbox.ts web/e2e/inbox-dossiers.spec.ts -m "feat(inbox): archiver depuis l ecran, par selection"
```

---

## Tâche 6 : la doc, la revue, la livraison

- [ ] **Étape 1 : `features.md`** — décrire les dossiers, les compteurs, l'archivage et sa réversibilité, la
  charge par collaborateur et qui la voit.
- [ ] **Étape 2 : `CLAUDE.md`** — passer le compteur de migrations à **0120 appliquée, prochaine libre 0121**,
  APRÈS l'avoir appliquée et vérifiée en base (`information_schema` + `pg_indexes`), jamais avant.
- [ ] **Étape 3 : `wip.md`** — cocher B, C, D ; reste E et F.
- [ ] **Étape 4 : la suite complète**

```bash
npx tsc --noEmit && npx vitest run
cd web && npx tsc --noEmit && npx vitest run && npx playwright test --reporter=line
```

- [ ] **Étape 5 : la revue** — `/revue`, corriger 🔴 **et** 🟡 dans la foulée.
- [ ] **Étape 6 : pousser, CI job par job, puis déployer**

```bash
git push origin main
```
Puis, sur le VPS, **dans cet ordre** : `git pull`, `sudo docker compose build mba-api`,
`sudo docker compose run --rm --no-deps mba-api npm run migrate`, `sudo docker compose up -d --build`,
attendre `healthy`, `nginx -s reload`, `node scripts/fumee.mjs`.

## Auto-relecture du plan

**Couverture de la spec :** menu de dossiers → tâche 4 · compteurs toujours affichés, sur toute la base →
tâches 2 et 4 · une seule route de compteurs → tâche 2 · archivage réversible → tâche 1 · désarchivage par
message entrant → tâche 1 (avec sa preuve inverse) · sélection plutôt que glisser-déposer → tâche 5 · charge
par collaborateur, membres à zéro compris → tâches 2 et 4 · RBAC de la section Affectation → tâches 4 et 5.
**Deux écarts écrits en tête** : `manager` en plus d'`admin`, et la correction du compteur « À traiter ».

**Cohérence des noms :** `archiverConversation`, `compterConversations`, `CompteursInbox`, `DossierInbox`,
`dossierEnParams`, `InboxDossiers`, `archivees`, `nonAffectees`, `parMembre` sont employés avec la même
orthographe de la tâche 1 à la tâche 5.
