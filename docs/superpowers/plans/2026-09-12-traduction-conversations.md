# Traduction des conversations : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> ou `superpowers:executing-plans`, tâche par tâche.

**But :** un opérateur lit les entrants dans sa langue, quelle que soit celle du client, et fait
traduire ce qu'il écrit avant de l'envoyer.

**Architecture :** la langue de lecture vient du navigateur et voyage dans la requête (motif déjà en
place pour le bot d'aide). Les entrants se traduisent à l'ouverture d'une conversation et le
résultat est rangé. Les sortants ne se traduisent que sur un bouton qui nomme sa cible. La langue du
contact s'apprend, elle ne se demande pas.

**Spec :** [../specs/2026-09-12-traduction-conversations-cadrage.md](../specs/2026-09-12-traduction-conversations-cadrage.md)

## Contraintes globales

Celles du plan des campagnes s'appliquent à l'identique (`git commit --only`, `tenant_id = $1`,
`safeParse`, 4xx jamais 5xx, pas de tiret cadratin, mutation dans les deux sens, migrations non
auto-appliquées et numéro lu EN BASE, `bg-violet/10` et pas `bg-violet-50`, garde de largeur en
1280 x 800). Elles ne sont pas répétées ici. Deux ajouts propres à ce lot :

- 🔴 **Le libellé d'un bouton de traduction NOMME sa cible** : « Traduire en espagnol », jamais
  « Traduire » nu. Un test vérifie la chaîne.
- 🔴 **La traduction est payée par le CRÉDIT PRÉPAYÉ DU CLIENT** (clé Gateway de l'espace, migration
  0124), contrairement au bot d'aide qui est sur notre clé. Un espace sans crédit ne traduit pas, et
  l'écran le dit à l'activation.

---

### Tâche 1 : le stockage

**Fichiers**
- Créer : `db/migrations/0136_traduction.sql` (numéro à confirmer EN BASE)
- Test : `tests/integration/traduction-stockage.integration.test.ts`

**Produit** : trois colonnes sur `conversation_messages`, une sur `contacts`.

```sql
-- 0136 : garder la traduction A COTE de l'original, jamais a sa place.
--
-- 🔴 EN ENTREE ET EN SORTIE, LE SENS S'INVERSE, et c'est le piege de ce lot.
-- Entrant : `body` garde ce que le client a ECRIT, `traduction` porte notre lecture.
-- Sortant : `body` garde ce qui est PARTI (donc le texte traduit, c'est ce que le client a recu et
-- notre trace doit y correspondre le jour d'un litige), et `redaction_origine` garde ce que
-- l'operateur a ECRIT, sans quoi il ne peut plus se relire.
-- Ne garder qu'un des deux est faux dans les deux sens.
alter table conversation_messages add column if not exists traduction text;
alter table conversation_messages add column if not exists traduction_langue text
  check (traduction_langue is null or traduction_langue in ('fr', 'en'));
alter table conversation_messages add column if not exists redaction_origine text;

-- La langue du contact, APPRISE et jamais demandee. `null` = on ne sait pas encore, et ce n'est
-- pas « francais » : supposer ferait envoyer la mauvaise langue en silence.
-- ⚠️ Pas de contrainte sur les valeurs : un contact peut ecrire dans n'importe quelle langue, ce
-- sont NOS deux langues qui sont bornees, pas les siennes.
alter table contacts add column if not exists langue_detectee text;
alter table contacts add column if not exists langue_detectee_le timestamptz;
```

- [ ] **Étape 1 : confirmer le numéro EN BASE** (`select name from public.schema_migrations order by name desc`)
- [ ] **Étape 2 : écrire la migration ci-dessus**
- [ ] **Étape 3 : le test d'intégration qui prouve les DEUX sens**

```ts
it('un entrant garde l original dans body et la lecture dans traduction', async () => {
  // body = 'Hola, tengo un problema', traduction = 'Bonjour, j ai un problème'
});

// 🔴 LE CAS INVERSE, celui qu'on oublie : en sortie, body porte le TRADUIT.
it('un sortant garde le traduit dans body et l original de l operateur a part', async () => {
  // body = 'Hello, how can I help?', redaction_origine = 'Bonjour, comment puis-je aider ?'
});
```

- [ ] **Étape 4 : appliquer et VÉRIFIER EN BASE** (`information_schema` pour les cinq colonnes,
      `pg_constraint` pour le CHECK de `traduction_langue`)
- [ ] **Étape 5 : commit**

---

### Tâche 2 : le traducteur

**Fichiers**
- Créer : `src/traduction/traduire.ts`, `src/traduction/traduire.pg.ts`
- Test : `tests/traduction.test.ts`

**Produit**
```ts
export type LangueConsole = 'fr' | 'en';
export interface Traduction { texte: string; langueSource: string | null }
export function creerTraducteur(deps: DepsTraduction):
  (tenantId: string, texte: string, cible: string) => Promise<Traduction | null>;
```

🔴 **Le modèle rend AUSSI la langue source**, dans une sortie structurée validée par `safeParse`.
C'est ce qui alimente l'apprentissage de la langue du contact : sans ça, il faudrait un second appel
juste pour détecter.

- [ ] **Étape 1 : le test, avec le cas qui compte**

```ts
it('rend null plutot que d inventer quand la reponse du modele est illisible', async () => {
  const t = creerTraducteur({ completer: async () => ({ texte: 'pas du json' }) });
  expect(await t('t1', 'Hola', 'fr')).toBeNull();
});

// 🔴 Traduire vers la langue qu on a deja est un APPEL POUR RIEN, paye par le client.
it('ne traduit pas quand la source est deja la cible', async () => {
  let appels = 0;
  const t = creerTraducteur({ completer: async () => { appels += 1; return ok(); } });
  await t('t1', 'Bonjour', 'fr', 'fr');
  expect(appels).toBe(0);
});

it('la langue source remonte, c est elle qui alimente la fiche du contact', async () => {
  const r = await t('t1', 'Hola', 'fr');
  expect(r?.langueSource).toBe('es');
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer**
- [ ] **Étape 3 : MUTER** : faire rendre `{ texte: '' }` au lieu de `null` sur une réponse illisible,
      constater que le premier test échoue. Une bulle vide est pire qu'un refus.
- [ ] **Étape 4 : commit**

---

### Tâche 3 : les entrants, à l'ouverture d'une conversation

**Fichiers**
- Modifier : `src/http/inbox.ts` (la route qui sert un fil), `src/inbox/store.pg.ts`
- Test : `tests/traduction-entrants.test.ts`

**Consomme** : `creerTraducteur` (tâche 2).

La route d'ouverture d'un fil accepte `?traduire=fr`. Pour chaque message dont la `traduction` est
absente ou dans une autre langue, elle traduit et range.

- [ ] **Étape 1 : les tests**

```ts
it('ne retraduit pas ce qui est deja traduit dans la bonne langue', async () => {
  // 🔴 Le premier lecteur paie, les suivants lisent. Sans ce test, on paie a chaque ouverture.
  expect(appelsModele).toBe(0);
});

it('retraduit quand la langue demandee differe de celle rangee', async () => {
  // Fil deja traduit en 'fr', un collegue anglophone l ouvre : il faut du 'en'.
});

it('une traduction qui echoue rend l ORIGINAL, pas une bulle vide ni une erreur', async () => {
  const fil = await ouvrir({ traduire: 'fr', traducteur: async () => null });
  expect(fil.messages[0].affiche).toBe('Hola');
  expect(fil.messages[0].traductionEchouee).toBe(true);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (retirer la garde « déjà traduit » et constater que
      le compteur d'appels passe à N)
- [ ] **Étape 3 : la langue du contact s'écrit** depuis `langueSource` du premier message traduit
- [ ] **Étape 4 : commit**

---

### Tâche 4 : les sortants, le bouton qui nomme sa cible

**Fichiers**
- Modifier : `web/app/inbox/page.tsx`, `src/http/inbox.ts`
- Test : `web/e2e/traduction-sortant.spec.ts`

- [ ] **Étape 1 : les tests e2e**

```ts
test('le bouton nomme sa cible', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Traduire en espagnol' })).toBeVisible();
});

test('sans langue connue, il nomme la langue par defaut et ne ment pas', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Traduire en anglais' })).toBeVisible();
});

// 🔴 LE CAS QUI PROTEGE LE CLIENT : rien ne part sans que l operateur ait vu le texte traduit.
test('traduire REMPLACE le texte dans la zone de saisie, il n envoie pas', async ({ page }) => {
  await page.getByRole('button', { name: /Traduire en/ }).click();
  await expect(page.getByRole('textbox')).toHaveValue(/Hello/);
  expect(await messagesEnvoyes()).toHaveLength(0);
});

// 🔴 UN TEMPLATE NE SE TRADUIT PAS : son texte approuve par Meta EST le texte.
test('le bouton est absent sur un envoi de template', async ({ page }) => {
  await ouvrirHorsFenetre24h(page);
  await expect(page.getByRole('button', { name: /Traduire/ })).toBeHidden();
});

test('rien ne deborde en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['zone-saisie', 'bouton-traduire', 'bouton-envoyer']);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (faire envoyer directement après traduction,
      constater l'échec du troisième test)
- [ ] **Étape 3 : commit**

---

### Tâche 5 : les vocaux

**Fichiers**
- Modifier : `src/agent/llm/transcription.ts` (garder la langue), `src/http/inbox.ts`
- Créer : une colonne `transcription_langue` (même migration que la tâche 1 si elle n'est pas encore
  appliquée, sinon la sienne)
- Test : `tests/traduction-vocal.test.ts`

🔴 **La langue détectée est déjà rendue par `transcription.ts` (ligne 94) et personne ne la garde.**

- [ ] **Étape 1 : les tests**

```ts
it('transcrire PUIS traduire, en un seul geste pour l operateur', async () => {
  const r = await transcrireEtTraduire({ media, cible: 'fr' });
  expect(r.transcription).toBe('Hola, tengo un problema'); // ce qui a ete DIT
  expect(r.traduction).toBe('Bonjour, j ai un problème'); // notre lecture
  expect(r.transcriptionLangue).toBe('es');
});

// 🔴 ON NE TRADUIT PAS LE CORPS D UN AUDIO : il vaut « [audio] » ou la legende.
it('la source de la traduction est la TRANSCRIPTION, pas le body', async () => {
  const appels: string[] = [];
  await transcrireEtTraduire({ media, cible: 'fr', traducteur: async (t) => { appels.push(t); return ok(); } });
  expect(appels).toEqual(['Hola, tengo un problema']);
});

it('sans traduction active, la transcription reste seule et intacte', async () => {
  const r = await transcrireEtTraduire({ media, cible: null });
  expect(r.traduction).toBeNull();
  expect(r.transcription).toBe('Hola, tengo un problema');
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (traduire `body` au lieu de la transcription,
      constater que le deuxième test rend `['[audio]']`)
- [ ] **Étape 3 : commit**

---

### Tâche 6 : le toggle et l'écran

**Fichiers**
- Modifier : `web/lib/i18n.tsx` ou un module voisin, l'en-tête de l'Inbox
- Test : `web/e2e/traduction-toggle.spec.ts`

- [ ] **Étape 1 : les tests**

```ts
test('le toggle survit au rechargement', async ({ page }) => {
  await page.getByRole('switch', { name: /Traduire les messages reçus/ }).check();
  await page.reload();
  await expect(page.getByRole('switch', { name: /Traduire les messages reçus/ })).toBeChecked();
});

// ⚠️ Un espace sans credit ne peut pas traduire, et ca se dit MAINTENANT.
test('sans credit, le toggle le dit au lieu de rester muet', async ({ page }) => {
  await expect(page.getByText(/crédit.*épuisé/i)).toBeVisible();
});
```

- [ ] **Étape 2 : implémenter, relancer, commit**

---

## Revue

Revue `/revue` systématique, plus la section rayon de souffle :

- `conversation_messages.body` change de SENS pour les sortants (il porte le traduit). Qui le lit ?
  L'aperçu de l'Inbox, l'historique de l'agent, l'analyse de conversation, l'export. Chacun doit
  être démontré correct, pas supposé.
- 🔴 **L'analyse de conversation lit `body`.** Elle analysera donc le texte TRADUIT d'un sortant et
  l'ORIGINAL d'un entrant. C'est cohérent (les deux sont ce que le client a vu ou écrit), mais il
  faut le vérifier plutôt que l'espérer.
- `transcription` ne change pas de sens, la migration 0125 reste vraie.
