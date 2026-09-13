# Chaîne de repli des campagnes : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> (recommandé) ou `superpowers:executing-plans`, tâche par tâche. Les étapes utilisent des cases
> à cocher (`- [ ]`).

**But :** une campagne peut enchaîner WhatsApp, RCS et e-mail. Un envoi qui échoue techniquement
repart sur le canal suivant, dès le premier échec, sans double envoi. Et le parcours de création
devient un assistant à cinq étapes.

**Architecture :** deux tables à deux grains (`campaign_recipients` garde son grain « un contact »,
`campaign_envois` en ajout seul porte le grain « une tentative »), une chaîne d'étages dans
`campaign_etages`, et la bascule réutilise le mécanisme de relance existant en changeant de canal au
lieu de clore.

**Pile :** TypeScript, Fastify, Postgres (pooler Supabase), pg-boss, Next.js, vitest, Playwright.

**Spec :** [docs/superpowers/specs/2026-09-12-campagnes-chaine-de-repli-design.md](../specs/2026-09-12-campagnes-chaine-de-repli-design.md)

---

## Méthode de livraison

**Retenue : implémenteur par lot, puis revue humaine sur le DIFF, CI job par job, déploiement avec
vérification en base.** Cinq lots, un point d'arrêt entre chaque.

**Pourquoi celle-là et pas feature-loop** : les quatre questions du `CLAUDE.md` global répondent oui
aux deux premières. Ce chantier touche le chemin d'envoi, le webhook de livraison, deux migrations
et les chiffres affichés à l'écran ; et rien n'y est réversible, un message parti ne se rappelle pas
et un chiffre faux fait condamner un canal. Il porte en plus des invariants qu'un relecteur générique
ne connaît pas : un contrat d'unicité qui EST le dédoublonnage des destinataires, un index partiel
créé en 0007 pour une requête précise, deux horloges différentes sur la même notion d'instant.

**Ce que ça a effectivement coûté et rapporté** (mesuré, pas supposé) : la revue a trouvé un index
manquant sur le chemin des accusés, deux commentaires qui affirmaient du faux, et une dette à
échéance. La CI sur un vrai Postgres a trouvé le défaut d'attribution, qu'aucune des deux méthodes
n'aurait vu en local. Les exécutants eux-mêmes ont trouvé le trou du plan, une colonne absente et une
instruction impossible, parce que la consigne leur disait de s'arrêter plutôt que de deviner.

🔴 **L'essai RÉEL qui clôt la feature, et qu'aucun test ne remplace** : une campagne à deux étages
lancée sur le numéro de Julien, avec un destinataire volontairement injoignable en WhatsApp, et on
regarde ce qui part. Personne n'a encore cliqué sur l'assistant, et la bascule n'a jamais tourné : à
ce jour elle est verte, pas éprouvée.

## Contraintes globales

Elles s'appliquent à **toutes** les tâches, sans être répétées dans chacune.

- **Git** : `git commit --only <chemins>`, JAMAIS `git add` puis commit nu. Rester sur `main`,
  pousser sur `origin`.
- **Isolation tenant** : `tenant_id = $1` sur CHAQUE requête. Le pooler est superuser, la RLS est
  contournée, le filtrage en code est le seul contrôle.
- **Validation** : `safeParse`, jamais `parse`, jamais `as` sur une charge externe.
- **Erreurs utilisateur** : 4xx (422 / 409), jamais 5xx. Cloudflare remplace le corps des 5xx par sa
  page d'erreur.
- **Rédaction** : pas de tiret cadratin ni demi-cadratin, dans le code comme dans la doc.
- **Tests** : chaque test est vérifié **par mutation dans les deux sens**. Remettre le code fautif,
  constater l'échec ET son symptôme, restaurer. Un test qui passe dans les deux sens ne prouve rien.
- **Migrations** : NON auto-appliquées. Une migration qui AJOUTE une colonne écrite par le code passe
  AVANT le déploiement. Le numéro se lit **en base**
  (`select name from public.schema_migrations order by name desc`), jamais dans un fichier. Les
  numéros ci-dessous (0133, 0134, 0135) sont une **hypothèse à confirmer** au moment d'écrire.
- **Suites** : `npx vitest run tests/` à la racine, `cd web && npx vitest run` pour le front.
  ⚠️ **Ne JAMAIS lancer `npm run test:integration` en local** : le `DATABASE_URL` du `.env` pointe
  sur la base de PRODUCTION. Les tests d'intégration ne tournent qu'en CI.
- **Vérifier la CI job par job** : `gh run view <id> --json jobs`. `gh run watch --exit-status` a
  déjà rendu 0 sur un run en échec.
- **Copie** : le libellé porte le mot **réessayer**, jamais **relancer** (relancer veut dire autre
  chose en marketing).
- **Palette Tailwind maison** : `sky` et `violet` sont des couleurs SIMPLES (`sky: '#3A8BD8'`).
  `bg-violet-50` N'EXISTE PAS et ne produit aucune erreur. Utiliser `bg-violet/10`.
- 🔴 **LARGEUR : RIEN NE DÉBORDE NI NE SE CHEVAUCHE SUR UN 13 POUCES** (demande de Julien,
  2026-09-12). L'écran de référence est **1280 x 800**, moins la barre latérale de la console, donc
  environ **1000 px utiles**. « Je ferai attention » n'est pas vérifiable : la garde est MÉCANIQUE,
  cf. la section « La garde de largeur » ci-dessous, et chaque tâche d'interface la porte.

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
|---|---|
| `db/migrations/0133_joignabilite_contact.sql` | Les deux colonnes de joignabilité WhatsApp |
| `db/migrations/0134_campagne_chaine.sql` | `campaign_etages`, `campaign_envois`, `etage_courant`, les colonnes de `campaigns` |
| `src/contacts/joignabilite.ts` | Le point de passage unique « ce contact est-il joignable sur ce canal » |
| `src/contacts/joignabilite.pg.ts` | Sa lecture et son écriture en base |
| `src/campaign/bascule.ts` | La règle PURE : un échec, une chaîne, un réglage -> quel geste |
| `src/campaign/etages.ts` | Le type d'une chaîne et sa résolution (quel canal au rang N) |
| `src/campaign/envois.pg.ts` | Le journal des tentatives, en ajout seul |
| `web/components/campagne/AssistantCampagne.tsx` | La coquille de l'assistant, l'état et la navigation |
| `web/components/campagne/EtapeCanal.tsx` | Étape 2 : canal, repli, réessai, horaire du rattrapage |
| `web/components/campagne/EtapeContenu.tsx` | Étape 3 : un cadre par étage, devenir de la conversation |
| `web/components/campagne/EtapeRecap.tsx` | Étape 5 : la répartition prévue |

**Modifiés**

| Fichier | Changement |
|---|---|
| `src/meta/errors.ts:65` | 131026 sort de `RETRYABLE_CODES` |
| `src/campaign/retry-sweep.ts` | La bascule remplace la clôture quand une chaîne existe ; garde d'horaire |
| `src/worker.ts:962` | Le balayage cesse d'être conditionné à HubSpot |
| `src/campaign/store.pg.ts` | Lecture et écriture de la chaîne, de l'étage, des envois |
| `src/campaign/engine.ts` | Le débit se résout par canal ; l'envoi écrit dans `campaign_envois` |
| `src/campaign/pacing.ts` | `resolveRatePerMinute` prend le canal |
| `src/stats/store.pg.ts:450` | `getCampaignFunnel` lit `campaign_envois` et groupe par canal |
| `web/components/CampaignCreateForm.tsx` | Remplacé par l'assistant ; le fichier disparaît en T12 |

---

## La garde de largeur

🔴 **Un écran qui déborde ne se voit pas sur l'écran de celui qui l'écrit.** Le développeur travaille
en 1920 de large, l'utilisateur ouvre la console sur un portable 13 pouces, et le chevauchement
n'apparaît que chez lui. Le dépôt a déjà payé ça : un `ml-3` posé sur un `w-full` ajoutait 12 px et
faisait déborder un textarea, trouvé en MESURANT dans le navigateur, pas en relisant le code.

**Le helper, écrit une fois, utilisé par chaque tâche d'interface.**

Créer `web/e2e/aide/largeur.ts` :

```ts
import { expect, type Page } from '@playwright/test';

/** L'écran de référence : un portable 13 pouces. Pas une supposition, la demande de Julien. */
export const TREIZE_POUCES = { width: 1280, height: 800 };

/**
 * Aucun débordement horizontal, et aucun chevauchement entre les blocs nommés.
 *
 * 🔴 LES DEUX CONTRÔLES SONT NÉCESSAIRES ET DIFFÉRENTS. Un `overflow-hidden` supprime le
 * débordement du document en MASQUANT le contenu qui dépasse : la page ne scrolle plus
 * horizontalement, et pourtant la moitié d'un bouton est coupée. Seul le second contrôle le voit.
 */
export async function pasDeDebordement(page: Page): Promise<void> {
  const debord = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(debord, 'la page déborde horizontalement').toBeLessThanOrEqual(0);
}

/**
 * Deux éléments ne se recouvrent pas, et aucun ne sort de son parent.
 * `cles` sont des `data-testid`.
 */
export async function pasDeChevauchement(page: Page, cles: string[]): Promise<void> {
  const boites = [];
  for (const cle of cles) {
    const b = await page.getByTestId(cle).boundingBox();
    expect(b, `introuvable : ${cle}`).not.toBeNull();
    boites.push({ cle, ...b! });
  }
  for (let i = 0; i < boites.length; i += 1) {
    for (let j = i + 1; j < boites.length; j += 1) {
      const a = boites[i]!;
      const b = boites[j]!;
      const seRecouvrent =
        a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
      expect(seRecouvrent, `${a.cle} chevauche ${b.cle}`).toBe(false);
    }
  }
}
```

⚠️ **Chaque tâche d'interface (10, 11, 12, et l'étape 4 de la tâche 9) ouvre son écran en
`TREIZE_POUCES` et appelle les deux fonctions.** Un test qui ne fixe pas la taille de la fenêtre
mesure celle de la machine qui l'exécute, donc il passe chez nous et rate chez le client.

⚠️ **Vérification par MUTATION, comme partout** : poser une largeur fixe absurde (`w-[1600px]`) sur
un cadre de l'étape, constater que `pasDeDebordement` échoue, retirer. Un garde-fou de mise en page
qu'on n'a jamais vu échouer n'est pas un garde-fou.

**Le point de conception qui évite le problème plutôt que de le détecter** : à l'étape 3, les cadres
d'étage sont **empilés verticalement**, jamais côte à côte. Trois cadres à 320 px avec leurs
gouttières ne tiennent pas dans 1000 px utiles, et une grille qui se réorganise en dessous d'un
seuil produit exactement les chevauchements que Julien décrit. Un seul cadre est déplié à la fois.

---

## Phase 1 : les fondations, sans changement visible

### Tâche 1 : 131026 sort de `RETRYABLE_CODES`

**Fichiers**
- Modifier : `src/meta/errors.ts:65`
- Test : `tests/meta-errors.test.ts` (créer s'il n'existe pas)

**Interfaces**
- Consomme : rien.
- Produit : `classify(httpStatus, body)` rend `false` pour le code 131026.

**Pourquoi.** 131026 veut dire chez Meta « le numéro n'est pas un numéro WhatsApp », ou « la personne
n'a pas accepté les conditions ». Aucune de ces causes ne change dans la seconde qui suit. Le rejeu
est donc du gaspillage sur chaque numéro sans WhatsApp, et il contredit la règle de campagne
décidée dans la spec.

🔴 **Cette constante n'est pas propre aux campagnes.** Elle est lue par tout ce qui appelle Meta :
envoi d'un message rapide depuis l'Inbox, tour d'agent IA, scénario. Le retrait supprime ce rejeu
PARTOUT, ce qui est voulu (le code veut dire la même chose sur tous les chemins), mais la liste des
appelants se vérifie AVANT.

- [ ] **Étape 1 : énumérer les appelants avant de toucher à la constante**

```bash
grep -rn "RETRYABLE_CODES\|classify(\|\.retryable" src/ --include=*.ts | grep -v node_modules
```

Écrire la liste dans le message de commit. Pour chacun, répondre à : « un 131026 rejoué y
apportait-il quelque chose ? ». La réponse attendue est non partout ; si un appelant fait exception,
S'ARRÊTER et le signaler.

- [ ] **Étape 2 : écrire le test qui échoue**

```ts
import { describe, expect, it } from 'vitest';
import { classify } from '../src/meta/errors';

describe('classify', () => {
  it('131026 n est PAS rejouable : le numero n est pas un numero WhatsApp', () => {
    expect(classify(400, { code: 131026 })).toBe(false);
  });

  // 🔴 SANS CE SECOND TEST, on peut retirer 131026 en cassant le rejeu des incidents.
  it('les incidents de transport restent rejouables', () => {
    expect(classify(429, null)).toBe(true);
    expect(classify(408, null)).toBe(true);
    expect(classify(425, null)).toBe(true);
    expect(classify(503, null)).toBe(true);
  });

  it('un code inconnu en 4xx reste terminal', () => {
    expect(classify(400, { code: 999999 })).toBe(false);
  });
});
```

- [ ] **Étape 3 : lancer, vérifier l'échec**

Run : `npx vitest run tests/meta-errors.test.ts`
Attendu : ÉCHEC sur le premier cas, `expected true to be false`.

- [ ] **Étape 4 : retirer 131026**

Dans `src/meta/errors.ts`, retirer `131026` du `Set` et écrire la raison juste au-dessus :

```ts
// Premier jeu de codes (extensible, à affiner avec la doc Meta live).
// Transitoires : rejouables tels quels.
// 🔴 131026 N'EST PAS ICI, ET C'EST DÉLIBÉRÉ (2026-09-12). Meta dit textuellement que ce code veut
// dire que le numéro n'est pas un numéro WhatsApp, ou que la personne n'a pas accepté les
// conditions. Aucune de ces causes ne change dans la seconde : le rejouer double les appels sur
// chaque numéro sans WhatsApp, sans aucune chance de succès. Son rattrapage vit au niveau
// campagne (bascule d'étage ou joignabilité mémorisée), pas au niveau transport.
const RETRYABLE_CODES = new Set<number>([1, 2, 4, 130429, 131016, 131048, 131056, 133016]);
```

- [ ] **Étape 5 : lancer, vérifier le vert, puis MUTER**

Run : `npx vitest run tests/meta-errors.test.ts` -> PASS.
Mutation : remettre `131026` dans le `Set`, relancer, constater l'échec du premier cas ET son
symptôme. Retirer de nouveau.

- [ ] **Étape 6 : la suite entière**

Run : `npx vitest run tests/` -> aucun nouvel échec par rapport à la base.

- [ ] **Étape 7 : commit**

```bash
git commit --only src/meta/errors.ts tests/meta-errors.test.ts -m "fix(meta): 131026 n est pas rejouable, et il l etait sur TOUS les chemins d envoi"
```

---

### Tâche 2 : la joignabilité mémorisée

**Fichiers**
- Créer : `db/migrations/0133_joignabilite_contact.sql`
- Créer : `src/contacts/joignabilite.ts`, `src/contacts/joignabilite.pg.ts`
- Modifier : `src/campaign/retry-sweep.ts`, `src/worker.ts`
- Test : `tests/contacts-joignabilite.test.ts`, `tests/integration/joignabilite.integration.test.ts`

**Interfaces**
- Consomme : `Reachability` de `src/rcs/reachability.ts` (méthode
  `isReachable(tenantId, agentId, e164): Promise<boolean>`).
- Produit :
  - `type Verdict = 'oui' | 'non' | 'inconnu'`
  - `PEREMPTION_WHATSAPP_MS = 90 * 86_400_000`
  - `verdictWhatsApp(valeur: boolean | null, mesureLe: Date | null, maintenant: Date): Verdict`
  - `noterJoignabiliteWhatsApp(tenantId, contactId, joignable: boolean): Promise<void>`

**Pourquoi.** Le verdict est DÉJÀ calculé (second échec 131026 de `retry-sweep`) et part uniquement
dans HubSpot. La table `contacts` n'en garde rien.

- [ ] **Étape 1 : confirmer le numéro de migration EN BASE**

Ne pas déduire du contenu de `db/migrations/`. Interroger
`select name from public.schema_migrations order by name desc limit 3`. Si le résultat contredit
0133, renuméroter tout le plan.

- [ ] **Étape 2 : écrire la migration**

```sql
-- 0133 : se souvenir de ce qu'on a appris sur la joignabilité WhatsApp d'un contact.
--
-- 🔴 null N'EST PAS false. Un contact jamais sollicité est INCONNU, pas injoignable. Le compter
-- comme injoignable ferait sauter tout le parc historique au premier étage d'une chaîne de repli.
-- La colonne est donc nullable, et le code distingue trois états, pas deux.
--
-- ⚠️ NON BLOQUANTE : le code tolère l'absence des colonnes (verdict `inconnu`). Elle passe quand
-- même AVANT le déploiement, parce que le balayage de relance les écrit.
alter table contacts add column if not exists whatsapp_joignable boolean;
alter table contacts add column if not exists whatsapp_joignable_le timestamptz;

-- Index partiel : la seule question posée est « qui sait-on injoignable », jamais « qui sait-on
-- joignable » (cette dernière n'exclut personne). Un index plein coûterait pour rien.
create index if not exists contacts_whatsapp_injoignable_idx
  on contacts (tenant_id, whatsapp_joignable_le)
  where whatsapp_joignable = false;
```

- [ ] **Étape 3 : écrire le test de la règle pure, qui échoue**

```ts
import { describe, expect, it } from 'vitest';
import { PEREMPTION_WHATSAPP_MS, verdictWhatsApp } from '../src/contacts/joignabilite';

const MAINTENANT = new Date('2026-09-12T10:00:00Z');
const ilYA = (jours: number) => new Date(MAINTENANT.getTime() - jours * 86_400_000);

describe('verdictWhatsApp', () => {
  // 🔴 LE CAS QUI COMPTE : un contact jamais sollicité n'est PAS injoignable.
  it('sans mesure, le verdict est inconnu et non non', () => {
    expect(verdictWhatsApp(null, null, MAINTENANT)).toBe('inconnu');
  });

  it('une mesure recente est lue', () => {
    expect(verdictWhatsApp(false, ilYA(89), MAINTENANT)).toBe('non');
    expect(verdictWhatsApp(true, ilYA(89), MAINTENANT)).toBe('oui');
  });

  // 🔴 SANS PÉREMPTION, on exclut quelqu'un pour toujours sur un constat vieux de deux ans.
  it('une mesure perimee redevient inconnue', () => {
    expect(verdictWhatsApp(false, ilYA(91), MAINTENANT)).toBe('inconnu');
    expect(verdictWhatsApp(true, ilYA(91), MAINTENANT)).toBe('inconnu');
  });

  it('une valeur sans date est inconnue : une mesure sans instant n est pas une mesure', () => {
    expect(verdictWhatsApp(false, null, MAINTENANT)).toBe('inconnu');
  });

  it('la peremption vaut 90 jours', () => {
    expect(PEREMPTION_WHATSAPP_MS).toBe(90 * 86_400_000);
  });
});
```

- [ ] **Étape 4 : lancer, vérifier l'échec**

Run : `npx vitest run tests/contacts-joignabilite.test.ts`
Attendu : ÉCHEC, « Failed to resolve import ».

- [ ] **Étape 5 : écrire le module pur**

```ts
/**
 * « Ce contact est-il joignable sur ce canal ? », le point de passage UNIQUE.
 *
 * 🔴 IL LIT DEUX SOURCES, IL N'EN CRÉE PAS UNE TROISIÈME. Le RCS a déjà son cache
 * (`src/rcs/reachability.ts`, TTL 7 jours, indexé par agent) ; WhatsApp gagne deux colonnes sur
 * `contacts`. Écrire une seconde définition de « joignable » garantirait qu'elles divergent.
 *
 * ⚠️ L'ASYMÉTRIE DES DEUX PÉREMPTIONS EST VOULUE. Le RCS dépend du terminal et de l'opérateur, il
 * est volatil, d'où 7 jours. Un numéro qui GAGNE WhatsApp est rare mais réel, d'où 90 jours : assez
 * long pour servir à quelque chose, assez court pour ne pas exclure quelqu'un à vie.
 */
export type Verdict = 'oui' | 'non' | 'inconnu';

/** 90 jours. Au-delà, on retente : le coût d'un essai est un message raté, celui d'un faux
 *  définitif est un contact exclu pour toujours sans que personne ne puisse le voir. */
export const PEREMPTION_WHATSAPP_MS = 90 * 86_400_000;

/**
 * PURE, donc testable sans base ni horloge.
 *
 * 🔴 `null` rend `inconnu`, jamais `non`. Un contact jamais sollicité n'a pas été jugé.
 * ⚠️ Une valeur SANS date rend `inconnu` aussi : une mesure sans instant ne peut pas se périmer,
 * donc elle vaudrait pour toujours, ce qui est exactement ce que la péremption interdit.
 */
export function verdictWhatsApp(
  valeur: boolean | null,
  mesureLe: Date | null,
  maintenant: Date,
): Verdict {
  if (valeur === null || mesureLe === null) return 'inconnu';
  if (maintenant.getTime() - mesureLe.getTime() > PEREMPTION_WHATSAPP_MS) return 'inconnu';
  return valeur ? 'oui' : 'non';
}
```

- [ ] **Étape 6 : lancer, vérifier le vert, puis MUTER**

Run : `npx vitest run tests/contacts-joignabilite.test.ts` -> PASS.
Mutation : remplacer `if (valeur === null || mesureLe === null) return 'inconnu';` par
`if (valeur === null) return 'non';`, relancer, constater que le premier cas échoue avec
`expected 'non' to be 'inconnu'`. Restaurer.

- [ ] **Étape 7 : l'écriture en base**

Créer `src/contacts/joignabilite.pg.ts` avec `noterJoignabiliteWhatsApp(pool)` :

```ts
/**
 * Écrit ce qu'on vient d'apprendre. ⚠️ `tenant_id = $1` comme partout : le pooler est superuser,
 * la RLS est contournée, ce filtre est le seul contrôle d'isolation.
 */
export function creerNoteurJoignabilite(pool: Pool) {
  return async (tenantId: string, contactId: string, joignable: boolean): Promise<void> => {
    await pool.query(
      `update contacts set whatsapp_joignable = $3, whatsapp_joignable_le = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, contactId, joignable],
    );
  };
}
```

- [ ] **Étape 8 : brancher l'écriture aux DEUX endroits**

Dans `src/campaign/retry-sweep.ts`, ajouter une dépendance
`noterJoignabilite(tenantId, contactId, joignable): Promise<void>` et l'appeler au second échec
131026, **à côté** de `flagUnreachable` et non à sa place.

🔴 **Et l'appeler AUSSI sur un envoi WhatsApp réussi** (dans `src/campaign/engine.ts`, au point où
l'envoi est marqué `sent`). Sans ça, le champ n'est qu'une liste noire : il ne saura jamais dire
« oui », donc le récapitulatif ne pourra jamais annoncer une couverture, seulement une exclusion.

- [ ] **Étape 9 : dégater le balayage de HubSpot**

🔴 **`src/worker.ts:962` monte le balayage sous `if (config.HUBSPOT_SERVICE_URL)`**, parce que
`flagUnreachable` en dépend. Conséquence actuelle : **un espace sans HubSpot n'a AUCUNE relance
automatique**. La chaîne de repli ne peut pas hériter de cette condition.

Le balayage se monte désormais toujours. Seul l'appel HubSpot reste conditionnel : quand
`HUBSPOT_SERVICE_URL` est absente, `flagUnreachable` devient une fonction qui ne fait rien et rend
`resolve()`, et l'ordre « flag PUIS terminal » reste vrai (un flag qui ne fait rien réussit).

- [ ] **Étape 10 : le test d'intégration**

```ts
it('le second echec 131026 ecrit la joignabilite CHEZ NOUS, pas seulement dans HubSpot', async () => {
  // ... insérer tenant, contact, campagne, destinataire en error_code 131026 retry_count 1
  await runRetrySweep({ /* deps réelles sur le pool de test */ });
  const { rows } = await pool.query(
    `select whatsapp_joignable, whatsapp_joignable_le from contacts where tenant_id = $1 and id = $2`,
    [tenantId, contactId],
  );
  expect(rows[0].whatsapp_joignable).toBe(false);
  expect(rows[0].whatsapp_joignable_le).not.toBeNull();
});
```

- [ ] **Étape 11 : appliquer la migration, et VÉRIFIER EN BASE**

Pas « aucune erreur au déploiement ». Interroger `information_schema.columns` pour les deux
colonnes, `pg_indexes` pour le prédicat exact de l'index partiel, puis exécuter la requête du chemin
chaud PAR LE VRAI CODE et constater qu'elle rend `inconnu` et non `undefined`.

- [ ] **Étape 12 : commit**

```bash
git commit --only db/migrations/0133_joignabilite_contact.sql src/contacts/joignabilite.ts src/contacts/joignabilite.pg.ts src/campaign/retry-sweep.ts src/campaign/engine.ts src/worker.ts tests/contacts-joignabilite.test.ts tests/integration/joignabilite.integration.test.ts -m "feat(contacts): garder la joignabilite WhatsApp qu on calculait deja et qu on jetait"
```

---

### Tâche 3 : la joignabilité visible

**Fichiers**
- Modifier : `web/components/ContactDetail.tsx`, `src/crm/contact-filters.ts`,
  `web/components/ContactFilters.tsx`
- Test : `tests/crm-contact-filters.test.ts`, `web/e2e/contact-joignabilite.spec.ts`

**Interfaces**
- Consomme : `Verdict`, `verdictWhatsApp` et `PEREMPTION_WHATSAPP_MS` de la tâche 2.
- Produit : un nouveau membre de l'union `ContactFilter` de `src/crm/contact-filters.ts` :
  `{ kind: 'joignabilite'; canal: 'whatsapp' | 'rcs'; op: 'connu_injoignable' }`, traduit par la
  fonction de construction SQL existante de ce fichier (repérer son nom exact avant d'écrire le
  test ; le plan l'appelle `construireFiltre` ci-dessous, à remplacer par le nom réel).

- [ ] **Étape 1 : le test du filtre, qui échoue**

```ts
it('le filtre exclut les injoignables CONNUS, jamais les inconnus', () => {
  const sql = construireFiltre({ kind: 'joignabilite', canal: 'whatsapp', op: 'connu_injoignable' });
  // Le SQL doit exclure whatsapp_joignable = false NON PÉRIMÉ, et laisser passer null.
  expect(sql.text).toContain('whatsapp_joignable is not false');
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer, MUTER**

Mutation : remplacer `is not false` par `is not true`, constater qu'un contact `null` est alors
exclu à tort.

- [ ] **Étape 3 : la fiche contact**

Afficher la joignabilité par canal avec sa date, en clair, et **« Jamais testé »** quand le verdict
est `inconnu`. ⚠️ Ne pas écrire « Injoignable » pour un inconnu : c'est le même défaut que
confondre `null` et `false`, transposé à l'écran.

- [ ] **Étape 4 : commit**

```bash
git commit --only web/components/ContactDetail.tsx src/crm/contact-filters.ts web/components/ContactFilters.tsx tests/crm-contact-filters.test.ts web/e2e/contact-joignabilite.spec.ts -m "feat(crm): la joignabilite par canal sur la fiche, et un filtre d audience"
```

---

## Phase 2 : la chaîne en base, sans changement de comportement

### Tâche 4 : `campaign_etages`

**Fichiers**
- Créer : `db/migrations/0134_campagne_chaine.sql`, `src/campaign/etages.ts`
- Modifier : `src/campaign/store.pg.ts`, `src/campaign/types.ts`
- Test : `tests/campagne-etages.test.ts`, `tests/integration/campagne-chaine.integration.test.ts`

**Interfaces**
- Produit :
  - `type CanalEtage = 'whatsapp' | 'rcs' | 'email'`
  - `interface Etage { rang: number; canal: CanalEtage; templateName?: string; templateLanguage?: string; rcsMessage?: unknown; emailTemplateId?: string; workflowId?: string }`
  - `etageAuRang(chaine: Etage[], rang: number): Etage | null`
  - `rangSuivant(chaine: Etage[], rangCourant: number): number | null`

**Pourquoi cette tâche ne change RIEN de visible.** Une chaîne à un seul étage produit exactement le
comportement actuel. C'est ce qui permet de la livrer et de la déployer avant d'écrire le moteur.

- [ ] **Étape 1 : le test de résolution, qui échoue**

```ts
import { describe, expect, it } from 'vitest';
import { etageAuRang, rangSuivant, type Etage } from '../src/campaign/etages';

const CHAINE: Etage[] = [
  { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
  { rang: 2, canal: 'rcs' },
  { rang: 3, canal: 'email', emailTemplateId: 'mod-1' },
];

describe('la chaine d etages', () => {
  it('resout le canal d un rang', () => {
    expect(etageAuRang(CHAINE, 2)?.canal).toBe('rcs');
  });

  it('rend null au-dela du dernier rang, ce qui veut dire terminal', () => {
    expect(rangSuivant(CHAINE, 3)).toBeNull();
    expect(etageAuRang(CHAINE, 4)).toBeNull();
  });

  // 🔴 LE CAS MONO-CANAL : une chaine a un seul etage n a pas de suivant, donc aucune bascule.
  it('une chaine a un seul etage ne bascule jamais', () => {
    expect(rangSuivant([{ rang: 1, canal: 'whatsapp' }], 1)).toBeNull();
  });

  // ⚠️ Une chaine dont les rangs sautent (1 puis 3) ne doit pas rendre 2 : le rang suivant est le
  // prochain qui EXISTE, pas rang + 1.
  it('le rang suivant est le prochain qui existe, pas rang + 1', () => {
    expect(rangSuivant([{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }], 1)).toBe(3);
  });
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer, MUTER**

Mutation : remplacer l'implémentation de `rangSuivant` par `rangCourant + 1`, constater l'échec du
dernier cas.

- [ ] **Étape 3 : la migration**

```sql
-- 0134 : une campagne est une CHAÎNE d'étages, pas un canal unique.
--
-- ⚠️ UNE SEULE SOURCE POUR LE CONTENU D'UN ÉTAGE. Les colonnes actuelles de `campaigns`
-- (template_name, workflow_id, rcs_message) décrivent ce qui devient l'étage 1. Elles sont REPRISES
-- ici, puis ne sont plus lues par le code neuf. Leur retrait est une migration ULTÉRIEURE, après le
-- déploiement : une migration qui retire une colonne encore lue par l'ancien code se passe APRÈS.
create table if not exists campaign_etages (
  campaign_id        uuid     not null references campaigns(id) on delete cascade,
  rang               smallint not null check (rang between 1 and 3),
  canal              text     not null check (canal in ('whatsapp', 'rcs', 'email')),
  template_name      text,
  template_language  text,
  rcs_message        jsonb,
  email_template_id  uuid,
  workflow_id        uuid,
  primary key (campaign_id, rang)
);

-- Reprise des campagnes existantes au rang 1.
-- ⚠️ Le parc est du test et sera effacé, mais parier sur un nettoyage manuel ferait de l'ordre des
-- gestes une condition de correction. La reprise coûte trois lignes.
insert into campaign_etages (campaign_id, rang, canal, template_name, template_language, rcs_message, workflow_id)
  select id, 1, coalesce(channel, 'whatsapp'), template_name, template_language, rcs_message, workflow_id
  from campaigns
on conflict (campaign_id, rang) do nothing;

-- Le journal des TENTATIVES, en ajout seul. Grain différent de campaign_recipients (un contact) :
-- 🔴 une ligne par tentative d'envoi. C'est la SEULE source de l'analytics par canal.
create table if not exists campaign_envois (
  id               uuid primary key default gen_random_uuid(),
  campaign_id      uuid not null references campaigns(id) on delete cascade,
  recipient_id     uuid not null references campaign_recipients(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  rang             smallint not null,
  canal            text not null check (canal in ('whatsapp', 'rcs', 'email')),
  statut           text not null check (statut in ('sent', 'failed', 'saute')),
  message_id       text,
  error_code       int,
  error            text,
  delivery_status  text,
  sent_at          timestamptz not null default now()
);
create index if not exists campaign_envois_campagne_idx on campaign_envois (campaign_id, canal);

-- L'étage où en est chaque contact. Défaut 1 : tout le parc existant est au premier étage.
alter table campaign_recipients add column if not exists etage_courant smallint not null default 1;

-- Les réglages de l'assistant.
-- 🔴 rattrapage_hors_horaires NE REMPLACE PAS business_hours_only, il le complète : le premier
-- gouverne le moment que l'opérateur CHOISIT (l'envoi initial), le second celui que PERSONNE ne
-- choisit (le réessai ou le repli). Les fusionner ramènerait le défaut que ce lot corrige.
alter table campaigns add column if not exists reessayer boolean not null default true;
alter table campaigns add column if not exists rattrapage_hors_horaires boolean not null default false;
alter table campaigns add column if not exists assignation text
  check (assignation is null or assignation in ('personne', 'tour_de_role'));
alter table campaigns add column if not exists assignation_user_id uuid references users(id) on delete set null;
alter table campaigns add column if not exists tour_de_role_rang smallint not null default 0;
```

- [ ] **Étape 4 : le store lit et écrit la chaîne**

`getCampaign` charge `campaign_etages` et rend `chaine: Etage[]`. `createCampaign` écrit la chaîne.
⚠️ Une campagne créée par l'ancien formulaire (qui existe encore à ce stade) écrit une chaîne à UN
étage : le comportement ne bouge pas.

- [ ] **Étape 5 : le test d'intégration de la reprise**

```ts
it('la reprise place les campagnes existantes au rang 1 avec leur canal', async () => {
  // La migration a tourné sur la base de test. Vérifier qu'une campagne RCS préexistante
  // a bien un étage 1 en canal 'rcs', pas en 'whatsapp'.
});
```

- [ ] **Étape 6 : appliquer la migration et vérifier EN BASE**

`information_schema` pour les tables et colonnes, `pg_constraint` pour les trois CHECK, puis compter
les lignes reprises et comparer au nombre de campagnes.

- [ ] **Étape 7 : commit**

```bash
git commit --only db/migrations/0134_campagne_chaine.sql src/campaign/etages.ts src/campaign/store.pg.ts src/campaign/types.ts tests/campagne-etages.test.ts tests/integration/campagne-chaine.integration.test.ts -m "feat(campagne): une campagne est une chaine d etages, a un seul etage pour l instant"
```

---

### Tâche 5 : le journal des tentatives

**Fichiers**
- Créer : `src/campaign/envois.pg.ts`
- Modifier : `src/campaign/engine.ts`
- Test : `tests/integration/campagne-envois.integration.test.ts`

**Interfaces**
- Consomme : `CanalEtage` de la tâche 4.
- Produit : `noterEnvoi(input: { campaignId, recipientId, contactId, rang, canal, statut, messageId?, errorCode?, error? }): Promise<void>`

**Pourquoi séparément de la tâche 6.** Le journal se remplit AVANT que quoi que ce soit ne le lise.
Ça permet de déployer, de laisser des données réelles s'accumuler, et de vérifier sur du vrai
trafic que le journal dit la même chose que `campaign_recipients` avant de basculer l'analytics
dessus.

- [ ] **Étape 1 : test d'intégration qui échoue**

```ts
it('un envoi reussi ecrit UNE ligne de journal, et le destinataire reste UNIQUE', async () => {
  await lancerCampagne(campaignId);
  const envois = await pool.query(`select * from campaign_envois where campaign_id = $1`, [campaignId]);
  const destinataires = await pool.query(`select * from campaign_recipients where campaign_id = $1`, [campaignId]);
  expect(envois.rowCount).toBe(1);
  expect(destinataires.rowCount).toBe(1);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER**

Mutation : retirer l'appel à `noterEnvoi` dans l'engine, constater `expected 0 to be 1`.

- [ ] **Étape 3 : commit**

```bash
git commit --only src/campaign/envois.pg.ts src/campaign/engine.ts tests/integration/campagne-envois.integration.test.ts -m "feat(campagne): journaliser chaque tentative d envoi, en ajout seul"
```

---

### Tâche 6 : le funnel par canal

**Fichiers**
- Modifier : `src/stats/store.pg.ts:450`, `src/stats/types.ts`,
  `web/components/analytics/cartes.tsx`
- Test : `tests/integration/stats-funnel-canal.integration.test.ts`

**Interfaces**
- Produit : `CampaignFunnel` gagne `parCanal: Array<{ canal: CanalEtage; envois: number; reussis: number; delivres: number; lus: number; repondus: number; sansAccuse: number }>`.

- [ ] **Étape 1 : le test qui échoue, dans la forme exacte demandée**

```ts
it('un contact passe par deux canaux donne DEUX lignes de funnel, pas une', async () => {
  // Destinataire : échec WhatsApp (131026) puis succès RCS.
  const f = await store.getCampaignFunnel(tenantId, campaignId);
  expect(f.parCanal).toEqual([
    { canal: 'whatsapp', envois: 1, reussis: 0, delivres: 0, lus: 0, repondus: 0, sansAccuse: 0 },
    { canal: 'rcs', envois: 1, reussis: 1, delivres: 1, lus: 1, repondus: 1, sansAccuse: 0 },
  ]);
  // 🔴 La ligne de tête reste au grain CONTACT : un seul humain a été visé.
  expect(f.contactsVises).toBe(1);
});
```

- [ ] **Étape 2 : implémenter le `group by canal` sur `campaign_envois`**

⚠️ **Conserver la distinction « zéro » contre « on ne sait pas »** (`sansAccuse`, posée le
2026-09-11) et l'appliquer PAR CANAL. Un canal sans aucun accusé affiche « — », jamais « 0 ».

- [ ] **Étape 3 : relancer, MUTER**

Mutation : remplacer `group by canal` par une agrégation globale, constater que le test rend une
seule ligne.

- [ ] **Étape 4 : l'écran**

La carte de campagne montre la ventilation par canal. ⚠️ Palette : `bg-violet/10`, pas
`bg-violet-50` qui n'existe pas.

- [ ] **Étape 5 : commit**

```bash
git commit --only src/stats/store.pg.ts src/stats/types.ts web/components/analytics/cartes.tsx tests/integration/stats-funnel-canal.integration.test.ts -m "feat(analytics): le funnel compte par canal, un contact pouvant passer par deux"
```

---

## Phase 3 : le moteur

### Tâche 7 : la règle de bascule

**Fichiers**
- Créer : `src/campaign/bascule.ts`
- Modifier : `src/campaign/retry-sweep.ts`, `src/worker.ts`
- Test : `tests/campagne-bascule.test.ts`, `tests/campaign-retry-sweep.test.ts`

**Interfaces**
- Consomme : `Etage`, `rangSuivant` (tâche 4).
- Produit :

```ts
export type Geste =
  | { type: 'bascule'; rang: number }
  | { type: 'reessai' }
  | { type: 'reessai_demain_matin' }
  | { type: 'terminal'; motif: string };

export function decider(entree: {
  codeErreur: number | null;
  chaine: Etage[];
  rangCourant: number;
  reessayer: boolean;
  dejaReessaye: boolean;
  /** Adresse du contact. ⚠️ DANS LA SIGNATURE DÈS MAINTENANT, même si l'étage e-mail n'arrive qu'en
   *  tâche 13 : l'ajouter plus tard changerait la signature d'une fonction déjà testée, et c'est
   *  exactement la dérive que ce plan doit éviter. Vaut `null` tant qu'aucun étage e-mail n'existe. */
  emailDuContact: string | null;
}): Geste;
```

⚠️ **Les tests de cette tâche passent `emailDuContact: null`** : l'étage e-mail n'existe pas encore,
et la tâche 13 ajoutera SES cas sans toucher à cette signature.

- [ ] **Étape 1 : le test, qui couvre les trois cas de la spec et l'indépendance des réglages**

```ts
import { describe, expect, it } from 'vitest';
import { decider } from '../src/campaign/bascule';
import type { Etage } from '../src/campaign/etages';

const CHAINE: Etage[] = [{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }];
const SEUL: Etage[] = [{ rang: 1, canal: 'whatsapp' }];
const base = { rangCourant: 1, reessayer: true, dejaReessaye: false, emailDuContact: null };

describe('decider', () => {
  // 🔴 AVEC CHAÎNE : TOUT code bascule au PREMIER échec, sans exception.
  it('avec chaine, 131026 bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });
  it('avec chaine, 131049 bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 131049, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });
  it('avec chaine, un code quelconque bascule des le premier echec', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: CHAINE })).toEqual({ type: 'bascule', rang: 2 });
  });

  // 🔴 SANS CHAÎNE : 131026 est terminal MÊME si l'option de réessai est cochée.
  it('sans chaine, 131026 est terminal meme avec l option cochee', () => {
    expect(decider({ ...base, codeErreur: 131026, chaine: SEUL, reessayer: true }))
      .toEqual({ type: 'terminal', motif: 'numero sans WhatsApp' });
  });

  it('sans chaine, 131049 reessaie le lendemain matin', () => {
    expect(decider({ ...base, codeErreur: 131049, chaine: SEUL })).toEqual({ type: 'reessai_demain_matin' });
  });

  it('sans chaine, un autre code reessaie si l option est cochee', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL })).toEqual({ type: 'reessai' });
  });

  it('sans chaine et option decochee, terminal du premier coup', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL, reessayer: false }))
      .toEqual({ type: 'terminal', motif: 'reessai desactive' });
  });

  it('un reessai deja consomme devient terminal', () => {
    expect(decider({ ...base, codeErreur: 133016, chaine: SEUL, dejaReessaye: true }))
      .toEqual({ type: 'terminal', motif: 'reessai deja consomme' });
  });

  // ⚠️ Au dernier étage d'une chaîne, il n'y a plus rien après.
  it('au dernier etage, terminal', () => {
    expect(decider({ ...base, rangCourant: 2, codeErreur: 131026, chaine: CHAINE }))
      .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
  });
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer**

- [ ] **Étape 3 : MUTER, trois fois**

1. Rendre `{ type: 'reessai' }` pour 131026 sans chaîne : le test « terminal même avec l'option
   cochée » doit échouer.
2. Faire basculer au SECOND échec (`dejaReessaye` requis) : les trois premiers cas doivent échouer.
3. Utiliser `rangCourant + 1` au lieu de `rangSuivant` : le cas « au dernier étage » doit échouer.

- [ ] **Étape 4 : brancher dans `retry-sweep`**

La bascule écrit `etage_courant = rang`, remet en `pending`, ré-enfile. ⚠️ **Le cas actuel « clôt en
injoignable » doit être CONSERVÉ** pour les campagnes sans chaîne, pas remplacé : son test existant
reste vert.

- [ ] **Étape 5 : commit**

```bash
git commit --only src/campaign/bascule.ts src/campaign/retry-sweep.ts src/worker.ts tests/campagne-bascule.test.ts tests/campaign-retry-sweep.test.ts -m "feat(campagne): la bascule d etage remplace la cloture quand une chaine existe"
```

---

### Tâche 8 : l'horaire du rattrapage

**Fichiers**
- Modifier : `src/campaign/retry-sweep.ts`, `src/worker.ts`
- Test : `tests/campagne-rattrapage-horaires.test.ts`

**Interfaces**
- Consomme : `Geste` (tâche 7), `withinBusinessHours` de `src/campaign/engine.ts`.
- Produit : `RetrySweepDeps` gagne
  `fenetreOuverte(tenantId: string): Promise<boolean>`.

**Pourquoi une garde à part et pas la mise en pause de la campagne.** Un rattrapage se présente
souvent quand la campagne est **terminée** depuis longtemps. La mettre en pause n'aurait aucun sens.
Le balayage teste la fenêtre avant de ré-enfiler et ne fait rien sinon, exactement comme
`isMorningWindow()` le fait déjà pour 131049.

- [ ] **Étape 1 : le test, dans les DEUX sens et sur l'indépendance des réglages**

```ts
it('rattrapage hors horaires interdit et il est 22h : le destinataire est TOUJOURS LA au tour suivant', async () => {
  const res = await runRetrySweep({ ...deps, fenetreOuverte: async () => false });
  expect(res.retried).toBe(0);
  // 🔴 NE PAS se contenter de vérifier qu'il n'est pas parti : un destinataire PERDU passerait
  // aussi ce test. On vérifie qu'il est encore réclamable.
  expect(await deps.list131026()).toHaveLength(1);
});

it('rattrapage hors horaires autorise et il est 22h : il part', async () => {
  const res = await runRetrySweep({ ...deps, fenetreOuverte: async () => false, horsHoraires: true });
  expect(res.retried).toBe(1);
});

// 🔴 LA COMBINAISON QUI PROUVE QUE LA SÉPARATION EST RÉELLE ET PAS DÉCORATIVE.
it('une campagne qui envoie la nuit peut refuser de rattraper la nuit', async () => {
  // business_hours_only = false (l'envoi initial part la nuit)
  // rattrapage_hors_horaires = false (le rattrapage attend le matin)
  const res = await runRetrySweep({ ...deps, fenetreOuverte: async () => false });
  expect(res.retried).toBe(0);
});

it('un espace sans heures d ouverture rattrape quand meme', async () => {
  const res = await runRetrySweep({ ...deps, fenetreOuverte: async () => true /* aucune heure posée */ });
  expect(res.retried).toBe(1);
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer, MUTER**

Mutation : retirer la garde `fenetreOuverte`, constater que le premier test rend `retried: 1`.

- [ ] **Étape 3 : commit**

```bash
git commit --only src/campaign/retry-sweep.ts src/worker.ts tests/campagne-rattrapage-horaires.test.ts -m "feat(campagne): l horaire du rattrapage est distinct de celui de l envoi initial"
```

---

### Tâche 9 : le débit par canal

**Fichiers**
- Modifier : `src/campaign/pacing.ts`, `src/config.ts`, `src/campaign/engine.ts`
- Test : `tests/campaign-pacing.test.ts`

**Interfaces**
- Produit : `resolveRatePerMinute(stored, serverDefault, canal)` et
  `RCS_RATE_PER_MINUTE_MAX` (défaut 60).

- [ ] **Étape 1 : le test qui échoue**

```ts
it('une campagne RCS n herite PAS du plafond WhatsApp', () => {
  // Le plafond WhatsApp vient de Meta (80). Le RCS a le sien, 60 pour commencer.
  expect(plafondDuCanal('whatsapp', config)).toBe(80);
  expect(plafondDuCanal('rcs', config)).toBe(60);
});
```

- [ ] **Étape 2 : ajouter la configuration**

```ts
/**
 * Plafond de débit du canal RCS, en messages par minute.
 *
 * ⚠️ 60 EST UN POINT DE DÉPART, PAS UNE MESURE (2026-09-12). smsmode ne publie aucun chiffre : leur
 * documentation répond que l'infrastructure « s'ajuste automatiquement au volume ». La valeur vit
 * donc en configuration pour se corriger sans déploiement, et ne doit JAMAIS être recopiée en dur.
 * 🔴 Elle n'a rien à voir avec PHONE_RATE_PER_MINUTE_MAX, qui vient de Meta : les confondre est
 * exactement le défaut que ce lot corrige.
 */
RCS_RATE_PER_MINUTE_MAX: z.coerce.number().int().min(0).max(600).default(60),
```

- [ ] **Étape 3 : implémenter, relancer, MUTER**

Mutation : faire retomber `plafondDuCanal('rcs')` sur `PHONE_RATE_PER_MINUTE_MAX`, constater
l'échec.

- [ ] **Étape 4 : l'écran cesse de demander un nombre de messages par minute**

🔴 **Un marketeur ne peut pas choisir ce nombre correctement**, il n'a aucun moyen de connaître les
plafonds des opérateurs. La jauge « 1 à 80 messages / min » est remplacée par une intention :

```tsx
// Trois choix, et l'écran affiche la DURÉE estimée sous celui qui est retenu.
// Le plafond technique (Meta ou smsmode, selon le canal) reste en coulisse : c'est une contrainte
// de fournisseur, pas une décision de l'utilisateur.
const CADENCES = [
  { cle: 'vite',    libelle: 'Au plus vite' },
  { cle: 'etale',   libelle: 'Étalé sur la journée' },
  { cle: 'ouvres',  libelle: 'Heures ouvrées seulement' }, // existant depuis 0122
] as const;
```

⚠️ `ouvres` pose `business_hours_only = true`, la colonne existante. Ne pas créer un second réglage
qui dirait la même chose.

- [ ] **Étape 5 : le test e2e du nouvel écran**

```ts
test('l ecran ne demande plus un nombre de messages par minute', async ({ page }) => {
  await expect(page.getByText(/messages \/ min/)).toBeHidden();
  await page.getByRole('radio', { name: 'Au plus vite' }).check();
  await expect(page.getByText(/environ .* pour 1 000 messages/)).toBeVisible();
});
```

- [ ] **Étape 6 : commit**

```bash
git commit --only src/campaign/pacing.ts src/config.ts src/campaign/engine.ts web/components/campagne/EtapeCanal.tsx tests/campaign-pacing.test.ts web/e2e/campagne-cadence.spec.ts -m "fix(campagne): une campagne RCS se voyait imposer le plafond de debit de Meta"
```

---

## Phase 4 : l'assistant

### 🔴 DEUX DETTES À SOLDER AVANT QUE L'ASSISTANT RENDE UNE CHAÎNE CRÉABLE

Relevées aux lots 2 et 3 du 2026-09-12. Les deux sont **inoffensives tant qu'aucune campagne ne peut
avoir plus d'un étage**, et les deux deviennent des défauts visibles le jour où la tâche 10 livre
l'écran qui permet d'en créer une. Elles se soldent donc **dans la phase 4, avant la mise en
service**, pas « plus tard ».

1. **Le moteur d'envoi ne lit pas `etage_courant`.** La bascule marque l'étage, personne ne s'en sert
   pour choisir le contenu. Une bascule renverrait aujourd'hui le contenu de l'étage 1 sur le canal
   de l'étage 1, c'est-à-dire exactement le message qui vient d'échouer.
2. **Le funnel GLOBAL sous-compte les réponses arrivées sur un canal de repli.** `entrantAttribue`
   filtre sur `m.channel = c.channel`, le canal DÉCLARÉ de la campagne. Le funnel par canal, lui, est
   juste. Le premier client à utiliser un repli lirait donc deux chiffres qui se contredisent sur le
   même écran.

### Tâche 10 : la coquille et l'étape Canal

**Fichiers**
- Créer : `web/components/campagne/AssistantCampagne.tsx`, `web/components/campagne/EtapeCanal.tsx`
- Test : `web/e2e/campagne-assistant-canal.spec.ts`

⚠️ **Le choix de cadence (« Au plus vite », « Étalé sur la journée », « Heures ouvrées seulement »)
appartient à CETTE tâche, pas à la tâche 9.** Le plan le rangeait en tâche 9, dont le moteur est fait,
mais le composant qui doit le porter est créé ici : l'exécutant du lot 3 s'est arrêté dessus plutôt
que de créer le fichier en avance, et il a eu raison. Reste à trancher ici : quel débit signifie
« Étalé sur la journée ».

**Interfaces**
- Produit : `AssistantCampagne` porte l'état `{ nom, chaine, reessayer, rattrapageHorsHoraires, ... }`
  et le passe aux étapes.

- [ ] **Étape 1 : les tests e2e, avant l'écran**

```ts
test('les trois entrees de canal, et la sous-question du premier canal', async ({ page }) => {
  await page.getByLabel('Nom de la campagne').fill('Essai');
  await page.getByRole('button', { name: 'Suivant' }).click();
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await expect(page.getByText('Lequel part en premier ?')).toBeVisible();
});

test('un canal non configure est grise AVEC SA RAISON, pas masque', async ({ page }) => {
  // Espace sans agent RCS.
  const entree = page.getByRole('radio', { name: 'RCS' });
  await expect(entree).toBeDisabled();
  await expect(page.getByText(/aucun agent RCS/i)).toBeVisible();
});

test('la question du rattrapage n apparait QUE quand il y a un reessai ou une chaine', async ({ page }) => {
  await page.getByRole('radio', { name: 'WhatsApp' }).check();
  await page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' }).uncheck();
  await expect(page.getByText(/en dehors des heures d.ouverture/i)).toBeHidden();
  await page.getByRole('checkbox', { name: 'Réessayer les envois qui échouent' }).check();
  await expect(page.getByText(/en dehors des heures d.ouverture/i)).toBeVisible();
});

test('SMS est visible et non selectionnable', async ({ page }) => {
  await expect(page.getByRole('radio', { name: /SMS/ })).toBeDisabled();
  await expect(page.getByText('bientôt')).toBeVisible();
});

test('un espace sans heures d ouverture le DIT au moment ou on coche', async ({ page }) => {
  await page.getByRole('checkbox', { name: /heures d.ouverture/i }).check();
  await expect(page.getByText(/aucune heure d.ouverture n.est réglée/i)).toBeVisible();
});

// 🔴 LA GARDE DE LARGEUR, sur l'etape la plus chargee : trois entrees de canal, deux
// sous-questions, une case a cocher et un encart d'avertissement.
test('rien ne deborde ni ne se chevauche en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await page.getByRole('radio', { name: 'WhatsApp et RCS, avec repli' }).check();
  await page.getByRole('radio', { name: 'RCS en premier' }).check();
  await page.getByRole('radio', { name: 'E-mail' }).check(); // troisieme niveau, l'ecran est plein
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['choix-canal', 'choix-ordre', 'choix-troisieme', 'bloc-rattrapage']);
});
```

- [ ] **Étape 2 : lancer, constater l'échec (aucun écran), implémenter, relancer**

Run : `cd web && npx playwright test e2e/campagne-assistant-canal.spec.ts`

⚠️ **Le libellé porte « Réessayer », jamais « Relancer ».** Un test vérifie la chaîne exacte.

- [ ] **Étape 3 : commit**

```bash
git commit --only web/components/campagne/AssistantCampagne.tsx web/components/campagne/EtapeCanal.tsx web/e2e/campagne-assistant-canal.spec.ts -m "feat(campagne): l assistant, etapes Nom et Canal"
```

---

### Tâche 11 : l'étape Contenu

**Fichiers**
- Créer : `web/components/campagne/EtapeContenu.tsx`
- Test : `web/e2e/campagne-assistant-contenu.spec.ts`

- [ ] **Étape 1 : les tests e2e**

```ts
test('un cadre par etage, dans l ordre de la chaine', async ({ page }) => {
  await expect(page.getByRole('group', { name: /Étage 1 . WhatsApp/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /Étage 2 . RCS/ })).toBeVisible();
});

test('le devenir de la conversation est demande UNE SEULE FOIS, pas par etage', async ({ page }) => {
  await expect(page.getByText('Que se passe-t-il quand le contact répond ?')).toHaveCount(1);
});

// 🔴 Il vaut pour les DEUX formules, modèle seul comme modèle plus scénario.
test('le devenir est demande aussi quand un scenario est choisi', async ({ page }) => {
  await page.getByRole('radio', { name: 'Modèle et scénario' }).check();
  await expect(page.getByText('Que se passe-t-il quand le contact répond ?')).toBeVisible();
});

test('l assignation a une personne affiche le NOMBRE avant de valider', async ({ page }) => {
  await page.getByRole('radio', { name: 'Assignée à une personne' }).check();
  await expect(page.getByText(/conversations lui seront attribuées/)).toBeVisible();
});

test('le RCS garde ses suggestions, il ne se reduit pas a un lien', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Ajouter une suggestion' })).toBeVisible();
});

// 🔴 L'ÉTAPE LA PLUS EXPOSÉE AU DÉBORDEMENT : trois cadres d'étage, un éditeur de modèle, un
// éditeur de suggestions RCS et le bloc du devenir de la conversation.
test('les cadres d etage sont EMPILES, jamais cote a cote, et rien ne deborde en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await page.getByTestId('etage-1').click(); // deplie le premier
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['etage-1', 'etage-2', 'etage-3', 'bloc-devenir']);

  // Les cadres sont empiles : chacun commence SOUS le precedent, jamais a sa droite.
  const un = (await page.getByTestId('etage-1').boundingBox())!;
  const deux = (await page.getByTestId('etage-2').boundingBox())!;
  expect(deux.y).toBeGreaterThanOrEqual(un.y + un.height);
});

// ⚠️ L'editeur de suggestions RCS est le composant le plus large de l'ecran : un cadre deplie
// avec onze suggestions est le pire cas realiste.
test('onze suggestions RCS ne font pas deborder le cadre', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await page.getByTestId('etage-2').click();
  for (let i = 0; i < 11; i += 1) {
    await page.getByRole('button', { name: 'Ajouter une suggestion' }).click();
  }
  await pasDeDebordement(page);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER**

Mutation : afficher la question du devenir dans chaque cadre d'étage, constater l'échec de
`toHaveCount(1)`.

- [ ] **Étape 3 : commit**

```bash
git commit --only web/components/campagne/EtapeContenu.tsx web/e2e/campagne-assistant-contenu.spec.ts -m "feat(campagne): l assistant, etape Contenu et devenir de la conversation"
```

---

### 🔴 Tâche 11bis : ÉCRIRE la chaîne à la création (trou du plan, relevé au lot 4)

**Fichiers**
- Modifier : `src/campaign/store.pg.ts` (`insertCampaignRow`), `src/http/campaigns.ts`,
  `web/lib/api/campaigns.ts`
- Test : `tests/campagne-creation-chaine.test.ts`,
  `tests/integration/campagne-chaine-creation.integration.test.ts`

🔴 **SANS ELLE, LE PLAN NE LIVRE PAS SA PROMESSE, et personne ne s'en apercevrait avant la recette.**
`insertCampaignRow` est le SEUL écrivain de `campaign_etages` et il n'écrit que le rang 1 (vérifié :
un seul `insert into campaign_etages` dans tout `src/`). Les tâches 10 et 11 construisent un écran
qui SAIT décrire une chaîne, les tâches 7 et 8 un moteur qui SAIT la parcourir, et rien entre les
deux ne sait l'ENREGISTRER. Toute la phase 4 se terminerait sur un assistant qui affiche trois
étages et crée une campagne à un seul.

⚠️ **Elle passe AVANT la tâche 12**, qui retire l'ancien formulaire : retirer le seul chemin de
création qui fonctionne avant que le nouveau sache écrire ce qu'il promet laisserait la console sans
création de campagne du tout.

- [ ] **Étape 1 : le test qui échoue, et il porte l'invariant que la migration 0134 a posé**

```ts
it('une chaine a trois etages ecrit TROIS lignes, dans leur ordre', async () => {
  const id = await repo.insertCampaign({ ...base, chaine: [
    { rang: 1, canal: 'whatsapp', templateName: 'promo', templateLanguage: 'fr' },
    { rang: 2, canal: 'rcs', rcsMessage: { kind: 'text', text: 'coucou' } },
    { rang: 3, canal: 'email', emailTemplateId: modeleId },
  ] });
  const r = await pool.query('select rang, canal from campaign_etages where campaign_id = $1 order by rang', [id]);
  expect(r.rows).toEqual([
    { rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }, { rang: 3, canal: 'email' },
  ]);
});

// 🔴 LE CAS QUI PROTÈGE L'EXISTANT : une création SANS chaîne doit continuer à écrire exactement
// un étage, comme aujourd'hui. C'est ce test qui casserait si quelqu'un rendait `chaine` obligatoire.
it('une creation sans chaine ecrit UN etage, comme avant', async () => {
  const id = await repo.insertCampaign({ ...base });
  const r = await pool.query('select count(*)::int as n from campaign_etages where campaign_id = $1', [id]);
  expect(r.rows[0].n).toBe(1);
});

// ⚠️ Les rangs viennent du client : ils se NORMALISENT, ils ne se croient pas.
it('des rangs trous ou desordonnes sont renumerotes 1, 2, 3', async () => {
  const id = await repo.insertCampaign({ ...base, chaine: [
    { rang: 3, canal: 'rcs' }, { rang: 1, canal: 'whatsapp' },
  ] });
  const r = await pool.query('select rang, canal from campaign_etages where campaign_id = $1 order by rang', [id]);
  expect(r.rows).toEqual([{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }]);
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter**

⚠️ **L'écriture des étages et celle de la campagne sont dans la MÊME transaction.** Une campagne
enregistrée sans ses étages est une campagne qu'aucun run ne peut servir (`getCampaign` lit la
chaîne) : mieux vaut aucune campagne qu'une campagne morte.

⚠️ **Le CHECK `rang between 1 and 3` de la migration est la borne**, et la validation d'entrée doit
refuser en **422** avant d'y arriver, pas laisser Postgres rendre une 5xx que Cloudflare remplacerait
par sa page d'erreur.

- [ ] **Étape 3 : MUTER** : écrire les étages hors transaction et faire échouer le second insert,
      constater qu'une campagne orpheline subsiste. Restaurer.
- [ ] **Étape 4 : commit**

```bash
git commit --only src/campaign/store.pg.ts src/http/campaigns.ts web/lib/api/campaigns.ts tests/campagne-creation-chaine.test.ts tests/integration/campagne-chaine-creation.integration.test.ts -m "feat(campagne): la creation sait enfin ECRIRE une chaine, pas seulement l afficher"
```

---

### Tâche 12 : Audience, Récapitulatif, et retrait de l'ancien formulaire

**Fichiers**
- Créer : `web/components/campagne/EtapeRecap.tsx`
- Supprimer : `web/components/CampaignCreateForm.tsx`
- Test : `web/e2e/campagne-assistant-recap.spec.ts`

🔴 **Le récapitulatif rachète l'ordre choisi.** L'audience arrivant après le contenu, l'opérateur a
configuré ses étages sans savoir combien de monde chacun couvre. Cet écran n'est pas un résumé,
c'est la répartition prévue.

- [ ] **Étape 1 : les tests e2e**

```ts
test('le recap montre la repartition par etage, pas un resume', async ({ page }) => {
  await expect(page.getByText('1 000 contacts retenus')).toBeVisible();
  await expect(page.getByText(/940 partiront en WhatsApp/)).toBeVisible();
  await expect(page.getByText(/60 basculeront en RCS/)).toBeVisible();
  await expect(page.getByText(/12 n.ont pas d.adresse e-mail/)).toBeVisible();
});

test('chaque ligne ramene a son etape', async ({ page }) => {
  await page.getByRole('link', { name: /contacts retenus/ }).click();
  await expect(page.getByRole('heading', { name: 'Audience' })).toBeVisible();
});

// 🔴 LE RÉCAP PORTE UN TABLEAU DE RÉPARTITION, donc le risque n'est pas le chevauchement mais la
// coupe. Un tableau large scrolle DANS SON PROPRE conteneur, la page ne scrolle jamais de côté.
test('la repartition ne fait pas deborder la page en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['repartition', 'bloc-cout', 'bouton-lancer']);
});

// ⚠️ Un nombre à sept chiffres (1 000 000 de contacts) est le pire cas de largeur d'une cellule.
test('des grands nombres ne cassent pas la mise en page', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  // Audience gonflée à 1 000 000 dans la fixture.
  await pasDeDebordement(page);
});
```

- [ ] **Étape 2 : implémenter**

Le comptage lit `joignabilite()` (tâche 2) pour l'étage 2 et la présence d'une adresse e-mail pour
l'étage 3.

⚠️ **Le récapitulatif ne peut PAS prédire 131049** : ce plafond est par utilisateur et vit chez
Meta. Ne rien annoncer à ce sujet plutôt que d'annoncer un chiffre faux.

- [ ] **Étape 3 : retirer l'ancien formulaire et vérifier qu'il n'a plus d'appelant**

```bash
grep -rn "CampaignCreateForm" web/ --include=*.tsx --include=*.ts | grep -v node_modules
```

Zéro résultat attendu avant suppression.

- [ ] **Étape 4 : commit**

```bash
git commit --only web/components/campagne/EtapeRecap.tsx web/components/CampaignCreateForm.tsx web/e2e/campagne-assistant-recap.spec.ts -m "feat(campagne): l assistant, Audience et Recapitulatif, et retrait de l ancien formulaire"
```

---

### Tâche 13 : l'étage e-mail

**Fichiers**
- Créer : une migration pour `contacts.email` (numéro à lire EN BASE)
- Modifier : `src/campaign/engine.ts`, `src/campaign/bascule.ts`
- Test : `tests/campagne-etage-email.test.ts`

🔴 **`contacts` N'A PAS DE COLONNE `email`, relevé au lot 3 du 2026-09-12.** Le cadrage tenait pour
acquis que « le destinataire sera l'adresse e-mail présente sur la fiche du mini-CRM » : cette
adresse n'existe pas en tant que colonne. Vérifier d'abord si elle vit dans le jsonb `fields` comme
champ personnalisé, auquel cas il n'y a **pas** de migration à faire mais une convention de clé à
respecter, et le filtre « a une adresse » à écrire sur le jsonb. `emailDuContact` de la tâche 7 vaut
`null` en attendant, ce qui rend l'étage e-mail terminal, donc inoffensif.

**Interfaces**
- Consomme : le chemin d'envoi d'e-mail existant (`sendEmail` de `src/workflow/engine.ts`,
  `{ emailAccountId, templateId, to }`), et les boîtes e-mail de l'espace.

- [ ] **Étape 1 : le test**

```ts
it('un contact sans adresse e-mail est terminal AVEC SA RAISON, pas un envoi vide', () => {
  expect(decider({ ...base, rangCourant: 2, chaine: CHAINE_AVEC_EMAIL, codeErreur: 131026, emailDuContact: null }))
    .toEqual({ type: 'terminal', motif: 'pas d adresse e-mail' });
});

it('le dernier etage ne reessaie pas, meme si l option de reessai est cochee', () => {
  expect(decider({ ...base, rangCourant: 3, chaine: CHAINE_AVEC_EMAIL, codeErreur: 500, reessayer: true }))
    .toEqual({ type: 'terminal', motif: 'plus d etage disponible' });
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER, commit**

```bash
git commit --only src/campaign/engine.ts src/campaign/bascule.ts tests/campagne-etage-email.test.ts -m "feat(campagne): l etage e-mail, dernier maillon de la chaine"
```

---

### Tâche 14 : l'assignation à l'arrivée de la conversation

**Fichiers**
- Créer : `src/inbox/assignation-campagne.ts`
- Modifier : le point où une réponse entrante crée ou rouvre une conversation rattachée à une
  campagne (à localiser depuis `src/campaign/webhook-feed.ts`)
- Test : `tests/campagne-assignation.test.ts`,
  `tests/integration/campagne-assignation.integration.test.ts`

**Interfaces**
- Consomme : `campaigns.assignation`, `assignation_user_id`, `tour_de_role_rang` (tâche 4).
- Produit : `prochainAssigne(membres: string[], rang: number): string | null`

🔴 **LE TOUR DE RÔLE SE JOUE À L'ARRIVÉE DE LA RÉPONSE, PAS AU LANCEMENT.** Répartir cinq mille
conversations d'avance attribuerait des conversations qui **n'existeront jamais** (la plupart des
destinataires ne répondent pas) et fausserait tous les compteurs de charge de l'équipe. Le rang vit
sur la campagne et avance quand une conversation devient réelle.

- [ ] **Étape 1 : le test de la règle pure**

```ts
import { describe, expect, it } from 'vitest';
import { prochainAssigne } from '../src/inbox/assignation-campagne';

describe('prochainAssigne', () => {
  it('tourne sur les membres', () => {
    expect(prochainAssigne(['a', 'b', 'c'], 0)).toBe('a');
    expect(prochainAssigne(['a', 'b', 'c'], 1)).toBe('b');
    expect(prochainAssigne(['a', 'b', 'c'], 3)).toBe('a');
  });

  // ⚠️ Une equipe VIDE ne doit pas planter ni assigner a personne en silence : la conversation
  // tombe dans « À traiter », comme si aucune assignation n'avait été demandée.
  it('sans membre, rend null', () => {
    expect(prochainAssigne([], 0)).toBeNull();
  });

  // 🔴 Le rang peut depasser la taille de l'equipe apres un depart de collaborateur.
  it('un rang plus grand que l equipe ne sort pas du tableau', () => {
    expect(prochainAssigne(['a', 'b'], 99)).toBe('b');
  });
});
```

- [ ] **Étape 2 : lancer, constater l'échec, implémenter, relancer, MUTER**

Mutation : remplacer le modulo par un accès direct `membres[rang]`, constater que le troisième cas
rend `undefined` au lieu de `'b'`.

- [ ] **Étape 3 : l'incrément atomique**

```sql
-- Une seule requête : lire ET incrémenter. Deux réponses qui arrivent en même temps sur la même
-- campagne liraient sinon le même rang et tomberaient sur la même personne.
update campaigns set tour_de_role_rang = tour_de_role_rang + 1
 where tenant_id = $1 and id = $2
 returning tour_de_role_rang - 1 as rang
```

- [ ] **Étape 4 : le test d'intégration de la concurrence**

```ts
it('deux reponses simultanees tombent sur deux personnes differentes', async () => {
  const [a, b] = await Promise.all([assigner(tenantId, campaignId), assigner(tenantId, campaignId)]);
  expect(a).not.toBe(b);
});
```

Mutation : remplacer par un `select` puis un `update` séparés, constater que les deux rendent la
même personne.

- [ ] **Étape 5 : commit**

```bash
git commit --only src/inbox/assignation-campagne.ts src/campaign/webhook-feed.ts tests/campagne-assignation.test.ts tests/integration/campagne-assignation.integration.test.ts -m "feat(campagne): l assignation a tour de role, jouee a l arrivee de la reponse"
```

---

## Phase 5 : ce qui rend la chaîne RÉELLEMENT fonctionnelle (lot 6)

🔴 **À la fin de la phase 4, tout est déployé et RIEN ne marche de bout en bout.** Deux manques, et
deux seulement, séparent la plomberie d'une fonctionnalité utilisable. Les sept autres capacités
absentes de l'assistant (aperçu, sélection fine, « Plus tard », fil de l'eau, brouillons, visuel RCS,
débit fin) ne servent qu'au RETRAIT de l'ancien formulaire : elles sont réelles, elles ne sont pas
sur ce chemin critique, et elles forment le lot 7.

### Tâche 15 : les variables de template dans l'assistant

**Fichiers**
- Modifier : `web/components/campagne/EtapeContenu.tsx`, `web/lib/campagne-creation.ts`
- Test : `web/lib/campagne-creation.test.ts`, `web/e2e/campagne-assistant-variables.spec.ts`

🔴 **C'EST LE BLOCAGE, ET IL EST BINAIRE.** L'assistant n'envoie aucun `paramMapping` : un template
portant `{{1}}` part avec zéro paramètre de corps et Meta refuse la **campagne entière** sur le
compte de paramètres (`resolveHintParams`, `src/crm/template.ts`). Tant que cette tâche n'est pas
faite, l'assistant ne sait créer que des campagnes à template sans variable, c'est-à-dire le cas rare.

⚠️ **L'ancien formulaire porte déjà cette association**, et c'est lui la référence : on reprend sa
sémantique (variable reliée à un champ de contact, avec repli sur l'exemple du template), on n'en
invente pas une seconde. Lire `CampaignCreateForm.tsx` avant d'écrire.

- [ ] **Étape 1 : le test qui échoue, et il porte le cas qui casse en production**

```ts
it('un template a variables produit un paramMapping complet', () => {
  const c = corpsDeCreation({ ...base, template: { name: 'promo', params: ['{{1}}', '{{2}}'] },
    associations: { 1: { source: 'champ', cle: 'prenom' }, 2: { source: 'constante', valeur: 'Paris' } } });
  expect(c.paramMapping).toHaveLength(2);
});

// 🔴 LE CAS QUI PROTEGE LE CLIENT : une variable non associee ne part PAS en silence.
it('une variable laissee vide empeche la creation, avec sa raison', () => {
  const v = validerContenu({ template: { name: 'promo', params: ['{{1}}'] }, associations: {} });
  expect(v.ok).toBe(false);
  expect(v.raison).toMatch(/variable/i);
});

it('un template SANS variable ne produit aucun mapping, et reste creable', () => {
  const c = corpsDeCreation({ ...base, template: { name: 'simple', params: [] } });
  expect(c.paramMapping).toEqual([]);
});
```

- [ ] **Étape 2 : lancer, implémenter, relancer, MUTER** (rendre `paramMapping: []` sur un template à
      variables : le premier test doit échouer, et le second reste la garde d'écran)
- [ ] **Étape 3 : l'e2e en 1280 x 800**, `pasDeDebordement` + `pasDeChevauchement` : l'association des
      variables est une liste qui grandit, c'est un candidat au débordement.
- [ ] **Étape 4 : commit**

### Tâche 16 : le moteur envoie sur le canal de l'étage

**Fichiers**
- Modifier : `src/campaign/engine.ts`, `src/campaign/run-job.ts`, `src/worker.ts`
- Test : `tests/campagne-envoi-multicanal.test.ts`,
  `tests/integration/campagne-bascule-envoi.integration.test.ts`

🔴 **SANS ELLE, LA CHAÎNE EST DÉCORATIVE.** La bascule marque `etage_courant`, le journal
l'enregistre, et l'envoi reste mono-canal : un run ne sait envoyer que par le canal de SA campagne.
Sept branches en dépendent, relevées au lot 4 : le sender, le plafond de débit, la porte de qualité,
les pré-lectures de template, le journal du fil, la joignabilité, et le choix du contenu.

⚠️ **Le moteur REFUSE déjà proprement** (lot 4) : il ne renvoie pas le message qui vient d'échouer,
il s'arrête avec sa raison. Le point de départ est donc sûr, pas cassé.

- [ ] **Étape 1 : les tests, et le premier est celui qu'on oublie**

```ts
// 🔴 CHAQUE ETAGE PREND LE PLAFOND DE SON CANAL, pas celui de la campagne. Un etage RCS sous le
// plafond WhatsApp est exactement le defaut que la tache 9 a corrige : ne pas le rouvrir par le bas.
it('l etage 2 en RCS prend le plafond RCS, pas celui de la campagne WhatsApp', async () => { /* ... */ });

it('l etage 2 envoie le contenu de l ETAGE 2, pas celui de l etage 1', async () => { /* ... */ });

it('le journal note le canal REELLEMENT utilise, pas celui de la campagne', async () => { /* ... */ });

// ⚠️ La joignabilite ne s ecrit que pour WhatsApp : un envoi RCS reussi ne dit RIEN de WhatsApp.
it('un etage RCS reussi n ecrit aucune joignabilite WhatsApp', async () => { /* ... */ });
```

- [ ] **Étape 2 : énumérer les sept branches AVANT d'écrire**, et dire pour chacune si elle lit le
      canal de la campagne ou celui de l'étage. C'est la liste qui fait le travail, pas le code.
- [ ] **Étape 3 : implémenter, relancer, MUTER** (faire lire `campaign.channel` à une branche :
      le test du plafond ou celui du contenu doit rougir)
- [ ] **Étape 4 : commit**

---

## Phase 6 : les trois retours du PREMIER essai réel (lot 7)

🔴 **CE SONT LES TROIS PREMIERS RETOURS D'UN ŒIL HUMAIN SUR L'ASSISTANT, et deux sur trois sont des
erreurs de PÉRIMÈTRE, pas d'exécution.** Julien a ouvert l'écran le 2026-09-12 au soir. Aucun des
trois n'était visible d'un test : le premier demandait un espace avec des invitations en attente, les
deux autres demandaient de se souvenir de ce qui avait été DEMANDÉ.

### Tâche 17 : les membres non activés se GRISENT, ils ne disparaissent pas

**Fichiers** : `web/app/campaigns/nouvelle/page.tsx`, `web/components/campagne/EtapeContenu.tsx`

**Le constat** : trois comptes dans l'espace, un seul dans la liste. Mesuré en base, les deux autres
ont `password_hash is null`, donc une **invitation en attente**. Le filtre `!u.disabled && !u.pending`
fait exactement ce qu'il annonce, et c'est juste : assigner à quelqu'un qui ne peut pas se connecter
range les conversations là où personne ne les lira.

🔴 **Le défaut n'est pas le filtre, c'est le SILENCE.** Le produit s'interdit ailleurs de masquer une
option indisponible (« un canal non configuré est grisé AVEC SA RAISON, pas masqué ») et c'est
exactement le même cas : ici l'empêchement est levable par celui qui le voit, il suffit que la
personne accepte son invitation. Les trois membres s'affichent, les deux non activés sont grisés avec
la mention « invitation en attente ».

- [ ] Test : trois membres dont deux en attente -> **trois** entrées, deux désactivées, la mention visible
- [ ] Mutation : remettre le filtre silencieux, constater qu'il n'y a plus qu'une entrée

### Tâche 18 : la cadence redevient la jauge, et une seule question horaire

**Fichiers** : `web/components/campagne/EtapeCanal.tsx`, `web/lib/campagne-creation.ts`

🔴 **LES TROIS INTENTIONS DE CADENCE N'ONT JAMAIS ÉTÉ DEMANDÉES.** Elles viennent d'une
recommandation que j'ai écrite dans la spec (« l'écran cesse de demander un nombre de messages par
minute ») et que Julien n'a jamais validée. Sur ce sujet il n'a tranché qu'une chose : le débit RCS à
60 par minute. Retirer une capacité que le client utilisait sur la foi d'une recommandation non
validée est une régression déguisée en amélioration.

**Ce qu'il veut, dit le 2026-09-12** : « je veux juste une seule question : envoyer ou pas hors des
business hours. C'est tout ! et après on shoote au rythme du canon que le client choisit ».

- **Une seule question horaire** à l'étape Canal : hors heures d'ouverture, oui ou non.
- **La jauge de débit revient**, telle qu'elle est dans `CampaignCreateForm`, et elle vit **à la fin**
  du parcours, avec la durée estimée que l'audience connue permet enfin de calculer.
- ⚠️ **Le plafond reste résolu PAR CANAL** (tâche 9) : c'est le seul acquis de ce sujet, et il est
  invisible de l'écran. Une campagne RCS ne doit pas se voir imposer le plafond de Meta.

### Tâche 19 : l'audience redevient CELLE D'AVANT

**Fichiers** : `web/components/campagne/EtapeAudience.tsx` et ses dépendances

🔴 **UN ÉCRAN QUI SAIT FAIRE MOINS QUE CELUI QU'IL REMPLACE N'EST PAS UN REMPLAÇANT.** L'étape
Audience a été livrée réduite, et le plan classait la sélection fine en « capacité manquante n°2 »,
à traiter plus tard. C'est une erreur de découpage : pour l'utilisateur ce n'est pas une capacité
absente, c'est une régression.

Ce qui doit revenir, à l'identique de `CampaignCreateForm` (le lire, ne pas réinventer) :

- les **filtres du mini-CRM** (tags, champs, consentement, dates) et les exclusions ;
- l'**upload d'un fichier** de contacts ;
- la **sélection parmi les contacts** du mini-CRM, cases à cocher comprises ;
- les **listes HubSpot**.

⚠️ **Ce n'est PAS une réécriture.** Le panneau de filtres est déjà un composant partagé
(`ContactFilterPanel`), et `contactIdsForTarget` passe déjà par le même `buildContactWhere`. Le
travail est de RÉUTILISER, et toute ligne réécrite ici est une seconde définition de l'audience.

---

## Phase 7 : ce qui reste avant de RETIRER l'ancien formulaire (lot 8) : FAIT le 2026-09-13

🔴 **LE RETRAIT A EU LIEU.** `web/components/CampaignCreateForm.tsx` et `web/lib/use-campagne-references.ts`
(devenu orphelin avec lui) sont supprimés, et `grep -rn "CampaignCreateForm" web/` rend zéro. La liste
« ce qui manque encore » de `AssistantCampagne.tsx` a disparu avec, remplacée par les LIMITES connues,
qui ne sont pas des capacités perdues.

⚠️ **LA SEULE LIGNE RESTANTE DE CETTE LISTE N'ÉTAIT PAS UNE CAPACITÉ DE L'ÉCRAN RETIRÉ**, et c'est ce
qui a permis de conclure : l'association des variables sur un étage de REPLI. Vérifié avant de retirer,
pas supposé : le constructeur de requête de l'ancien formulaire n'envoyait JAMAIS de `chaine`, il ne
savait donc créer qu'une campagne à UN étage, donc il n'avait jamais eu de repli à paramétrer.

⚠️ **ONZE SPÉCIFICATIONS E2E ONT CHANGÉ D'ÉCRAN LE MÊME JOUR**, et elles ont été PORTÉES, pas
supprimées : chacune gardait un cas réel (heures ouvrées, aperçu carousel, cible par filtre, brouillons,
webhook, RCS, modèle à la volée, colonne étroite, scénarios éligibles, réponses dégradées, enchaînement).
Elles vivent maintenant dans sept fichiers `campagne-assistant-*`, sur un faux backend partagé
(`web/e2e/aide/assistant.ts`) : il y en avait onze copies, il n'y en a plus qu'une.

Six capacités, inventoriées dans `AssistantCampagne.tsx` et tenues à jour par chaque lot. ⚠️ **Deux
lignes ont quitté cette liste le 2026-09-13** et ce n'étaient pas des capacités manquantes mais des
**régressions** (la sélection fine des contacts et la jauge de débit) : elles sont revenues au lot 7.

### Tâche 20 : l'aperçu du template, le carousel et l'en-tête média

**Fichiers** : `web/components/campagne/EtapeContenu.tsx`, plus le composant d'aperçu de
`CampaignCreateForm` (à RÉUTILISER, pas à recopier)

⚠️ **C'est la capacité qui manque le plus à l'usage** : sans aperçu, l'opérateur valide un envoi de
masse sur un nom de modèle. Elle vient donc en premier.

### Tâche 21 : « Plus tard » et la campagne au fil de l'eau

**Fichiers** : `web/components/campagne/EtapeRecap.tsx`, `web/lib/campagne-creation.ts`

Deux façons de ne pas partir tout de suite, et elles sont différentes : `scheduledAt` programme un
départ unique, le fil de l'eau alimente la campagne par un webhook au fur et à mesure.

### Tâche 22 : le visuel RCS et ses médias, et la création de modèle à la volée

**Fichiers** : `web/components/campagne/EtapeContenu.tsx` et les briques RCS existantes

⚠️ La création d'un modèle à la volée existe déjà dans l'écran en service, **avec son parcours de
soumission à Meta**. Le refaire produirait une seconde façon de soumettre un modèle.

### Tâche 23 : les brouillons, puis le RETRAIT de l'ancien formulaire

**Fichiers** : `web/components/campagne/AssistantCampagne.tsx`, suppression de
`web/components/CampaignCreateForm.tsx`, `web/app/campaigns/page.tsx`

🔴 **LE RETRAIT EST LA DERNIÈRE ÉTAPE DE CE LOT, ET IL A UNE CONDITION VÉRIFIABLE** : la liste
« CE QUI MANQUE ENCORE » de `AssistantCampagne.tsx` doit être **vide**. Tant qu'elle porte une ligne,
retirer l'écran en service retire une capacité que quelqu'un utilise.

⚠️ **Les brouillons en dernier, et pour une raison de FORMAT** : ils sont écrits dans un `state`
opaque que seul l'ancien formulaire relit. Un brouillon écrit par l'ancien écran doit rester lisible
par le nouveau, sinon le retrait détruit le travail en cours de quelqu'un.

- [x] Étape finale : `grep -rn "CampaignCreateForm" web/` rend **zéro** résultat. Les mentions en
      commentaire ont été réécrites en « l'ancien formulaire » plutôt que laissées au présent : un nom
      de fichier qui n'existe plus, conjugué au présent, est une piste morte pour le prochain lecteur.

---

## Revue et rayon de souffle, avant déploiement

🔴 **La revue `/revue` est systématique et ne se demande pas.** Elle inclut la section « Rayon de
souffle » de la spec, dont chaque point se vérifie un par un :

- `campaigns.channel` cesse d'être la vérité du canal. Lecteurs à vérifier : `src/stats/cost.ts`,
  `src/campaign/build.ts`, `src/campaign/sender.ts`, et l'étanchéité des canaux du 2026-08-25.
- `campaign_recipients.status` ne veut plus dire « résultat de l'envoi » mais « état du contact dans
  la chaîne ».
- `src/campaign/plafond.ts` compte des CONTACTS : vérifier qu'il ne s'est pas mis à compter des
  envois.
- `src/stats/cost.ts` : un contact passé par deux canaux coûte deux fois, et c'est correct. Le
  récapitulatif doit le dire AVANT l'envoi.
- `campaign_recipients_pending_idx` est un index PARTIEL (`where status = 'pending'`). Une bascule
  remet en `pending` : vérifier que le prédicat couvre toujours la requête de réclamation, avec un
  plan d'exécution, pas par raisonnement.
- `src/crm/contact-history.pg.ts` et le bilan par niveau du 2026-09-11 comptent des départs de
  campagne : vérifier qu'une bascule ne crée pas un second départ.
- `RETRYABLE_CODES` a perdu 131026 pour TOUS les chemins d'envoi, pas seulement les campagnes.

## Déploiement

Ordre imposé par le type de migration : **0133 et 0134 AJOUTENT des colonnes que le code écrit,
donc elles passent AVANT le déploiement.**

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@146.59.233.252
cd /home/ubuntu/mba && git pull
sudo docker compose build mba-api
sudo docker compose run --rm --no-deps mba-api npm run migrate
sudo docker compose up -d --build
sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload
node scripts/fumee.mjs
```

⚠️ **Contrôler l'appel PUBLIC après le `up --build`**, même quand les conteneurs sont `healthy` : le
502 « NPM tient l'ancienne IP » est INTERMITTENT, et le `nginx -s reload` ci-dessus est là pour ça.

⚠️ **`gh run list` et `gh run view <id> --json jobs` AVANT de déployer.** Un `npm test` vert en local
ne prouve que la moitié : les tests d'intégration ne tournent qu'en CI.
