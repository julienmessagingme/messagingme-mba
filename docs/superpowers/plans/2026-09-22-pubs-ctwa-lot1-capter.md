# Pubs Click-to-WhatsApp, lot 1 « Capter » : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** garder à la réception ce qui se perd sinon (chaque arrivée publicitaire avec son `ctwa_clid`, et
le tarif que Meta annonce pour chacun de nos envois), et sortir du coût des messages ceux que Meta ne facture
pas (les 72 h qui suivent un clic sur une pub).

**Architecture :** une migration crée `arrivees_pub` et `tarifs_meta`. Le job webhook gagne deux étapes
isolées : `processArriveesPub` (nouvelle, juste après l'upsert du contact) et la lecture du `pricing` dans
`processStatuses`. Le type `WebhookJobDeps` rend leurs dépendances OBLIGATOIRES dès qu'une file traite des
entrants (`inbox`) ou des accusés (`delivery`), donc le compilateur refuse un câblage qui les oublie. Les
quatre lectures de COÛT excluent les messages `free_entry_point` par un fragment SQL unique ; les courbes de
VOLUME ne bougent pas. La purge RGPD efface `ctwa_clid` et garde la ligne.

**Tech Stack :** TypeScript, Zod 4, Postgres (pg), pg-boss (worker), vitest.

**Spec :** [docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md](../specs/2026-09-22-pubs-ctwa-design.md)
(§ 1 « lot 1 », § 2, § 3.3, § 3.6).

## Global Constraints

- Aucun tiret cadratin ni demi-cadratin, dans le code, les commentaires, la doc et les messages de commit.
- 🔴 Jamais `npm run test:integration` ni `npm run migrate` en local : le `DATABASE_URL` du `.env` local est la
  PRODUCTION. Les tests d'intégration tournent en CI (job `integration`, Postgres jetable) ; leur verdict se
  lit avec `gh run view <id> --json jobs`, job par job, jamais avec `gh run watch`.
- Commits : `git add -- <fichiers neufs>` puis `git commit --only <liste>`, la liste construite depuis ce
  qu'on a touché soi-même, jamais depuis `git status` (une autre session travaille dans le même dossier).
- Zod en `safeParse` sur tout payload de Meta, jamais `parse`, jamais `as` sur un payload externe.
- `tenant_id` filtré sur chaque lecture ; un espace ne se déduit que du numéro Meta (`phone_numbers`).
- Une étape du job webhook ne lève JAMAIS : un throw rejouerait tout le job (accusés et inbox compris).
- `noUncheckedIndexedAccess` est actif et `tests/` est typé : un élément de tableau se lit avec `!` quand on
  sait qu'il existe (`rows[0]!.id`), comme dans les tests existants.
- Le code de ce plan ne contient aucune barre oblique inverse, délibérément : l'outil d'écriture les
  transforme en octets de contrôle. N'en ajoutez pas ; si vous devez en écrire une, relisez l'octet écrit.
- Migration : numéro `0163` si le dernier fichier de `db/migrations/` est `0162_outils_maison_mba.sql` et que
  la ligne « Dernière appliquée » du `CLAUDE.md` dit 0162 ; sinon, demander à Julien de lire la base
  (`select name from public.schema_migrations order by name desc limit 3`). Le compteur du `CLAUDE.md` se met
  à jour APRÈS l'application, pas en écrivant le fichier.
- Aucun journal ne porte de numéro de téléphone ni de `wa_id` : on journalise l'identifiant du message.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions du `CLAUDE.md` global y mènent :
la production emprunte ces chemins (le job webhook de chaque message entrant et de chaque accusé, la purge
RGPD, les chiffres de coût affichés au client) ; une capture ratée est irréversible (`ctwa_clid` n'arrive
qu'une fois) ; une partie des critères ne se voit que sur de vraies données ; et le code touché porte des
règles invisibles (ordre et isolation des étapes du webhook, deux files d'accusés, filtre de service partagé
« mot pour mot » par quatre lectures, purge transactionnelle).

**L'essai réel qui clôt le lot 1** (Task 9) : après déploiement, `tarifs_meta` se remplit avec les accusés
réels de la production, et le coût des messages d'un espace sans pub ne change pas. ⚠️ La capture des
arrivées ne sera ÉPROUVÉE qu'au premier vrai clic sur une pub, pendant l'essai réel du lot 3 : c'est écrit
dans `wip.md` (Task 8), pour que personne ne la compte comme acquise avant.

## Structure des fichiers

| Fichier | Rôle |
|---|---|
| `db/migrations/0163_pubs_capter.sql` (neuf) | Les deux tables et l'index du contact. |
| `src/webhooks/tarif-meta.ts` (neuf) | Pur : lire le `pricing` d'un accusé (Zod), la constante `free_entry_point`, le contrat du puits. |
| `src/webhooks/arrivees-pub.ts` (neuf) | Pur : l'arrivée tirée d'un message, et l'étape `processArriveesPub` du job webhook. |
| `src/pubs/tarifs-meta.pg.ts` (neuf) | Écriture de `tarifs_meta`, espace résolu par le numéro destinataire. |
| `src/pubs/arrivees.pg.ts` (neuf) | Écriture de `arrivees_pub`, contact retrouvé par la règle partagée `MATCH_BY_WAID_SQL`. |
| `src/webhooks/delivery.ts` | `processStatuses` lit le tarif, en best-effort. |
| `src/webhooks/handler.ts` | `WebhookJobDeps` exige `tarifsMeta` avec `delivery` et `arriveesPub` avec `inbox` ; nouvelle étape. |
| `src/worker.ts` | Construit les deux stores ; câble le tarif sur les DEUX files d'accusés, l'arrivée sur `webhook`. |
| `src/crm/contact-store.pg.ts` | `purgeMany` efface `ctwa_clid`. |
| `src/stats/store.pg.ts` | Pose `horsEntreeGratuite` dans ses lectures de coût (le fragment a rejoint `src/stats/entree-gratuite.ts` à la revue, cf. Task 7). |
| `tests/webhook-fixtures.ts` (neuf) | `aucunTarif` et `aucuneArriveePub`, pour les tests qui n'en parlent pas. |
| `tests/pubs-tarif-meta.test.ts`, `tests/pubs-arrivees.test.ts` (neufs) | Unitaires. |
| `tests/integration/pubs-capter.integration.test.ts`, `tests/integration/cout-entree-gratuite.integration.test.ts` (neufs) | Intégration (CI). |
| `tests/integration/purge-rgpd.integration.test.ts`, `tests/delivery.test.ts`, `tests/webhook-triggers.test.ts` | Étendus ou ajustés. |

## Rayon de souffle (à relire avant chaque commit)

- `processStatuses` : appelé par `handleWebhookJob` et par deux fichiers de tests
  (`tests/release-mba-sur-accuse.test.ts`, `tests/workflow-mesure-statuts.test.ts`). Le nouveau paramètre
  est en DERNIÈRE position et optionnel : leurs appels ne changent pas.
- `WebhookJobDeps` : deux appels en production (`queue.work('webhook')` et `queue.work('webhook-status')` dans
  `src/worker.ts`), plus les tests qui passent `delivery` ou `inbox`. `npm run typecheck` les énumère tous.
- `purgeMany` : servie par la suppression d'un contact et l'action en masse du mini-CRM. Elle est
  TRANSACTIONNELLE : si `arrivees_pub` n'existe pas encore, toute suppression de contact échoue en `42P01`.
  D'où la migration AVANT le déploiement, sans exception.
- Les lectures de coût : `getCostVolume` (graphe « Coût estimé »), `getTemplateBreakdown` (détail par
  modèle), `getVolumeParCampagne` (tableau du coût par engagement), `serviceParMois` (ligne « Messages » et
  prix effectif du service), `servicesParCampagne` (imputation aux campagnes). Leurs appelants :
  `getCoutMessages` et `getCoutParCampagne` dans `src/index.ts`, et les routes de `/stats`.
- ⚠️ Le filtre des messages de service est annoncé « mot pour mot » dans quatre docblocks de
  `src/stats/store.pg.ts`. Les deux lectures de VOLUME de `getDashboard` ne reçoivent PAS l'exclusion : un
  message gratuit reste un message envoyé. Les docblocks des lectures de coût le disent (Task 7).

---

### Task 1 : la migration

**Files:**
- Create: `db/migrations/0163_pubs_capter.sql`
- Test: `tests/migration-directives.test.ts` (existant, relit toutes les migrations)

**Interfaces:**
- Produces : les tables `arrivees_pub` (colonnes `tenant_id`, `contact_id`, `meta_message_id`, `ad_id`,
  `source_type`, `titre`, `url`, `ctwa_clid`, `en_standby`, `arrivee_le`, unique `(tenant_id,
  meta_message_id)`) et `tarifs_meta` (clé `(tenant_id, wamid)`, colonnes `type`, `categorie`, `facturable`,
  `modele`, `recu_le`).

- [ ] **Step 1 : vérifier le numéro**

Run : `ls db/migrations | tail -2` et `grep -n "Dernière appliquée" CLAUDE.md`
Expected : `0162_outils_maison_mba.sql` en dernier, et « Dernière appliquée : 0162 ». Sinon, STOP : demander
à Julien de lire la base (Global Constraints).

- [ ] **Step 2 : écrire la migration**

```sql
-- 0163_pubs_capter.sql : lot 1 des publicités Click-to-WhatsApp, « Capter ».
-- Spec : docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md (§ 2).
--
-- AVANT le déploiement : le code neuf écrit dans les deux tables, et la purge RGPD comme le coût des messages
-- les lisent. Déployer d'abord ferait échouer en `42P01` la suppression d'un contact (la purge est une
-- transaction) et les écrans de coût. L'ancien code les ignore : il survit à cette migration.

-- Une ligne par message entrant qui porte un `referral` (le premier message après un clic sur une pub).
-- 🔴 C'est la seule trace de `ctwa_clid` : Meta ne l'envoie qu'une fois, et le corps brut du webhook est
-- purgé à 30 jours (0093).
create table if not exists arrivees_pub (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- ⚠️ La cascade ne joue que pour une suppression RÉELLE de la fiche. La purge RGPD ANONYMISE la fiche
  -- (`PgContactStore.purgeMany`) : c'est elle qui efface `ctwa_clid`, et la ligne reste pour le compte.
  contact_id       uuid not null references contacts(id) on delete cascade,
  -- L'identifiant Meta du message entrant. Unique par espace : un webhook redélivré ne crée pas deux arrivées.
  meta_message_id  text not null,
  -- `referral.source_id` : la pub (ou la publication) cliquée.
  ad_id            text not null,
  source_type      text,
  titre            text,
  url              text,
  -- Parfois VIDE chez Meta : nullable, et jamais une condition.
  ctwa_clid        text,
  -- Arrivé pendant que l'agent de Meta tenait la conversation (`standby`) ? C'est la mesure qui décide si la
  -- reprise à l'arrivée du lot 3 peut marcher.
  en_standby       boolean not null,
  arrivee_le       timestamptz not null default now(),
  constraint arrivees_pub_message_uniq unique (tenant_id, meta_message_id)
);

-- Sert la suppression en cascade d'une fiche, et la qualification du lot 3 (la dernière arrivée d'un contact).
create index if not exists arrivees_pub_contact_idx on arrivees_pub (contact_id, arrivee_le desc);

-- Le tarif que Meta annonce pour chacun de nos messages sortants (objet `pricing` de l'accusé de réception).
-- 🔴 Une table à part plutôt qu'une colonne : nos envois vivent dans DEUX tables (`conversation_messages` et
-- `campaign_recipients`), et le coût lit les deux.
-- ⚠️ AUCUNE PURGE, délibérément : le coût d'un mois passé doit rester le même quel que soit le jour où on le
-- regarde. La ligne part avec l'espace.
create table if not exists tarifs_meta (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  -- L'identifiant Meta du message sortant (wamid).
  wamid       text not null,
  -- `pricing.type` tel quel : 'regular', 'free_customer_service', 'free_entry_point'...
  type        text not null,
  categorie   text,
  facturable  boolean,
  modele      text,
  recu_le     timestamptz not null default now(),
  primary key (tenant_id, wamid)
);
```

- [ ] **Step 3 : vérifier que la garde des directives l'accepte**

Run : `npx vitest run tests/migration-directives.test.ts`
Expected : PASS (aucun `CONCURRENTLY`, donc aucune directive attendue).

- [ ] **Step 4 : commit**

```bash
git add -- db/migrations/0163_pubs_capter.sql
git commit --only db/migrations/0163_pubs_capter.sql -F - <<'EOF'
feat(pubs): migration 0163, arrivees_pub et tarifs_meta

Lot 1 des publicites Click-to-WhatsApp : la seule trace de ctwa_clid, et le
tarif que Meta annonce pour chacun de nos envois. A appliquer AVANT le
deploiement : la purge RGPD et le cout des messages lisent ces tables.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2 : lire le tarif dans les accusés

**Files:**
- Create: `src/webhooks/tarif-meta.ts`
- Modify: `src/webhooks/delivery.ts` (signature et boucle de `processStatuses`)
- Test: `tests/pubs-tarif-meta.test.ts`

**Interfaces:**
- Produces :
  - `export const TYPE_ENTREE_GRATUITE = 'free_entry_point'`
  - `export interface TarifMeta { messageId: string; type: string; categorie: string | null; facturable: boolean | null; modele: string | null }`
  - `export function extraireTarif(data: unknown): TarifMeta | null`
  - `export interface TarifsMetaSink { enregistrer(phoneNumberId: string, t: TarifMeta): Promise<void> }`
  - `processStatuses(events, delivery, nodeEvents?, remiseMba?, tarifs?: TarifsMetaSink)`
  - ⚠️ **CETTE SIGNATURE A ÉTÉ CHANGÉE APRÈS COUP**, le 2026-09-23, sur le jaune 1 de la revue finale du
    déploiement : les trois puits secondaires voyagent désormais dans un objet NOMMÉ (`PuitsAccuses`) où
    `tarifs` est OBLIGATOIRE. Les blocs de code qui suivent montrent la forme d'origine, qui ne compile
    plus : ils disent ce qui a été PLANIFIÉ, pas ce que le dépôt porte aujourd'hui.

- [ ] **Step 1 : écrire les tests qui échouent**

Create `tests/pubs-tarif-meta.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { extraireTarif, TYPE_ENTREE_GRATUITE, type TarifMeta } from '../src/webhooks/tarif-meta';
import { processStatuses } from '../src/webhooks/delivery';
import type { DeliveryStore, DeliveryStatus } from '../src/webhooks/delivery';
import type { WebhookEvent } from '../src/webhooks/parse';

const accuse = (id: string, status: string, pricing?: unknown): unknown =>
  ({ id, status, ...(pricing === undefined ? {} : { pricing }) });

describe('extraireTarif', () => {
  it('lit le tarif de la fenêtre gratuite qui suit un clic sur une pub', () => {
    expect(extraireTarif(accuse('wamid.A', 'sent', { billable: false, pricing_model: 'PMP', type: 'free_entry_point', category: 'referral_conversion' })))
      .toEqual({ messageId: 'wamid.A', type: TYPE_ENTREE_GRATUITE, categorie: 'referral_conversion', facturable: false, modele: 'PMP' });
  });

  it('lit un tarif ordinaire', () => {
    expect(extraireTarif(accuse('wamid.B', 'delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' }))?.type)
      .toBe('regular');
  });

  it('garde tel quel un type que le code ne connaît pas', () => {
    expect(extraireTarif(accuse('wamid.C', 'sent', { type: 'nouveau_type_meta' })))
      .toEqual({ messageId: 'wamid.C', type: 'nouveau_type_meta', categorie: null, facturable: null, modele: null });
  });

  it('sans pricing, sans type ou illisible : null, et le message reste compté comme payant', () => {
    expect(extraireTarif(accuse('wamid.D', 'read'))).toBeNull();
    expect(extraireTarif(accuse('wamid.E', 'sent', { billable: true }))).toBeNull();
    expect(extraireTarif(accuse('wamid.F', 'sent', { type: 'regular', billable: 'oui' }))).toBeNull();
    expect(extraireTarif(accuse('', 'sent', { type: 'regular' }))).toBeNull();
    expect(extraireTarif(null)).toBeNull();
  });
});

class FakeDelivery implements DeliveryStore {
  readonly calls: string[] = [];
  async updateDeliveryByMessageId(messageId: string, status: DeliveryStatus): Promise<number> {
    this.calls.push(`${messageId}:${status}`);
    return 1;
  }
}

const statut = (id: string, status: string, pricing?: unknown, phoneNumberId: string | null = 'pn1'): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `status:${id}:${status}`,
  data: accuse(id, status, pricing),
  ...(phoneNumberId ? { phoneNumberId } : {}),
});

describe('processStatuses : le tarif de Meta', () => {
  const gratuit = { type: 'free_entry_point', category: 'referral_conversion', billable: false };

  it('enregistre le tarif, rattaché au numéro destinataire de l’accusé', async () => {
    const vus: Array<{ pn: string; t: TarifMeta }> = [];
    await processStatuses([statut('wamid.1', 'sent', gratuit)], new FakeDelivery(), undefined, undefined, {
      enregistrer: async (pn, t) => { vus.push({ pn, t }); },
    });
    expect(vus).toEqual([{ pn: 'pn1', t: { messageId: 'wamid.1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false, modele: null } }]);
  });

  it('sans numéro destinataire, rien n’est enregistré (aucun espace à qui rattacher la ligne)', async () => {
    let n = 0;
    await processStatuses([statut('wamid.2', 'sent', gratuit, null)], new FakeDelivery(), undefined, undefined, {
      enregistrer: async () => { n += 1; },
    });
    expect(n).toBe(0);
  });

  it('🔴 un échec d’écriture du tarif ne bloque ni la livraison ni le job', async () => {
    const delivery = new FakeDelivery();
    await expect(processStatuses([statut('wamid.3', 'delivered', gratuit)], delivery, undefined, undefined, {
      enregistrer: async () => { throw new Error('base indisponible'); },
    })).resolves.toBeUndefined();
    expect(delivery.calls).toEqual(['wamid.3:delivered']);
  });

  it('le tarif est lu même sur un statut que la livraison ignore', async () => {
    const vus: string[] = [];
    await processStatuses([statut('wamid.4', 'warning', { type: 'regular' })], new FakeDelivery(), undefined, undefined, {
      enregistrer: async (_pn, t) => { vus.push(t.messageId); },
    });
    expect(vus).toEqual(['wamid.4']);
  });
});
```

- [ ] **Step 2 : vérifier qu'ils échouent**

Run : `npx vitest run tests/pubs-tarif-meta.test.ts`
Expected : FAIL, « Cannot find module '../src/webhooks/tarif-meta' ».

- [ ] **Step 3 : écrire le module pur**

Create `src/webhooks/tarif-meta.ts` :

```ts
import { z } from 'zod';

/**
 * LE TARIF QUE META ANNONCE POUR UN DE NOS MESSAGES SORTANTS (objet `pricing` d'un accusé de réception).
 *
 * 🔴 C'EST LA SEULE SOURCE DE « META NE FACTURE PAS CE MESSAGE ». Un message parti dans les 72 h qui suivent un
 * clic sur une pub Click-to-WhatsApp (« free entry point ») est gratuit, modèles compris, et seul l'accusé le
 * dit. Recalculer la fenêtre nous-mêmes recopierait les conditions de Meta (réponse sous 24 h, clic depuis un
 * téléphone...), et notre chiffre deviendrait faux le jour où elles changent.
 *
 * ⚠️ `safeParse`, jamais `parse` : c'est un payload externe. Un `pricing` illisible rend `null`, et le message
 * reste compté comme payant, c'est-à-dire le comportement d'avant.
 */
export const TYPE_ENTREE_GRATUITE = 'free_entry_point';

const accuseAvecTarif = z.object({
  id: z.string().min(1),
  pricing: z.object({
    type: z.string().min(1),
    category: z.string().min(1).nullish(),
    billable: z.boolean().nullish(),
    pricing_model: z.string().min(1).nullish(),
  }),
});

export interface TarifMeta {
  /** L'identifiant Meta du message sortant (wamid). */
  messageId: string;
  /** `pricing.type`, tel quel : 'regular', 'free_customer_service', 'free_entry_point'... */
  type: string;
  categorie: string | null;
  facturable: boolean | null;
  modele: string | null;
}

export function extraireTarif(data: unknown): TarifMeta | null {
  const r = accuseAvecTarif.safeParse(data);
  if (!r.success) return null;
  const p = r.data.pricing;
  return {
    messageId: r.data.id,
    type: p.type,
    categorie: p.category ?? null,
    facturable: p.billable ?? null,
    modele: p.pricing_model ?? null,
  };
}

/**
 * Garde le tarif d'un message. `phoneNumberId` est le numéro Meta DESTINATAIRE de l'accusé : c'est le seul
 * rattachement à un espace que porte un payload Meta.
 */
export interface TarifsMetaSink {
  enregistrer(phoneNumberId: string, t: TarifMeta): Promise<void>;
}
```

- [ ] **Step 4 : brancher la lecture dans `processStatuses`**

In `src/webhooks/delivery.ts` :

1. Ajouter en tête, sous `import type { WebhookEvent } from './parse';` :

```ts
import { extraireTarif, type TarifsMetaSink } from './tarif-meta';
```

2. Remplacer la signature et le début de la boucle (jusqu'à `const d = extractDelivery(ev.data);` inclus) :

```ts
export async function processStatuses(
  events: WebhookEvent[],
  delivery: DeliveryStore,
  nodeEvents?: NodeStatusSink,
  remiseMba?: RemiseMbaSurAccuse,
  tarifs?: TarifsMetaSink,
): Promise<void> {
  for (const ev of events) {
    if (ev.source !== 'statuses') continue;
    /**
     * LE TARIF DE META (lot 1 des publicités Click-to-WhatsApp, `./tarif-meta.ts`).
     *
     * ⚠️ AVANT la garde de livraison : un statut que la livraison ignore peut porter un tarif.
     * ⚠️ BEST-EFFORT, comme la remise du fil plus bas : une exception ferait rejouer TOUT le job par pg-boss.
     * Un tarif manqué laisse le message compté comme payant, c'est-à-dire le comportement d'avant.
     */
    if (tarifs && ev.phoneNumberId) {
      const t = extraireTarif(ev.data);
      if (t) {
        try {
          await tarifs.enregistrer(ev.phoneNumberId, t);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('tarif Meta non enregistré:', err instanceof Error ? err.message : err);
        }
      }
    }
    const d = extractDelivery(ev.data);
```

La suite de la boucle (`if (!d) continue;` et ce qui suit) ne change pas. Ajouter au docblock de
`processStatuses`, après le paragraphe « BEST-EFFORT sur la mesure » :

```ts
 * `tarifs` (optionnel ici, OBLIGATOIRE pour toute file qui traite des accusés, cf. `WebhookJobDeps`) garde le
 * tarif que Meta annonce : c'est lui qui dit qu'un message est gratuit.
```

- [ ] **Step 5 : vérifier qu'ils passent**

Run : `npx vitest run tests/pubs-tarif-meta.test.ts tests/delivery.test.ts tests/release-mba-sur-accuse.test.ts tests/workflow-mesure-statuts.test.ts`
Expected : PASS.

- [ ] **Step 6 : vérifier l'isolation dans les deux sens**

Retirer temporairement le `try`/`catch` autour de `tarifs.enregistrer`, relancer
`npx vitest run tests/pubs-tarif-meta.test.ts` : le test « 🔴 un échec d’écriture du tarif » doit ÉCHOUER
(promesse rejetée « base indisponible »). Remettre le `try`/`catch`, relancer : PASS.

- [ ] **Step 7 : typecheck et commit**

Run : `npm run typecheck` (Expected : aucune erreur)

```bash
git add -- src/webhooks/tarif-meta.ts tests/pubs-tarif-meta.test.ts
git commit --only src/webhooks/tarif-meta.ts src/webhooks/delivery.ts tests/pubs-tarif-meta.test.ts -F - <<'EOF'
feat(pubs): les accuses gardent le tarif annonce par Meta

extraireTarif lit l'objet pricing d'un accuse (safeParse), et
processStatuses le confie a un puits, en best-effort et avant la garde de
livraison. C'est la seule source de « Meta ne facture pas ce message ».

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3 : l'arrivée publicitaire, étape pure du webhook

**Files:**
- Create: `src/webhooks/arrivees-pub.ts`
- Test: `tests/pubs-arrivees.test.ts`

**Interfaces:**
- Consumes : `extractInbound` et `InboundMessage` (`src/webhooks/inbound.ts`), dont `referral:
  InboundReferral` (`adId: string`, puis `sourceType`, `titre`, `url`, `ctwaClid` en `string | null`) et
  `field` (`'messages'` ou `'standby'`).
- Produces :
  - `export interface ArriveePub { messageId: string; adId: string; sourceType: string | null; titre: string | null; url: string | null; ctwaClid: string | null; enStandby: boolean }`
  - `export type IssueArrivee = 'ecrite' | 'deja_vue' | 'sans_contact'`
  - `export function arriveeDepuisMessage(m: Pick<InboundMessage, 'messageId' | 'field' | 'referral'>): ArriveePub | null`
  - `export interface ArriveesPubDeps { phoneNumberTenant(phoneNumberId: string): Promise<string | null>; enregistrer(tenantId: string, waId: string, a: ArriveePub): Promise<IssueArrivee> }`
  - `export async function processArriveesPub(payload: unknown, deps: ArriveesPubDeps): Promise<void>`

- [ ] **Step 1 : écrire les tests qui échouent**

Create `tests/pubs-arrivees.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { arriveeDepuisMessage, processArriveesPub, type ArriveePub, type IssueArrivee } from '../src/webhooks/arrivees-pub';

const referral = {
  source_url: 'https://fb.me/x', source_id: '120212345678901234', source_type: 'ad',
  headline: 'Offre de rentrée', body: 'Parlez-nous', ctwa_clid: 'clid-1',
};

const payload = (messages: unknown[], field = 'messages') => ({
  entry: [{ changes: [{ field, value: { metadata: { phone_number_id: 'pn1' }, messages } }] }],
});

const message = (id: string, from: string, ref?: unknown) =>
  ({ id, from, type: 'text', text: { body: 'Bonjour' }, ...(ref ? { referral: ref } : {}) });

describe('arriveeDepuisMessage', () => {
  it('traduit le referral en arrivée', () => {
    expect(arriveeDepuisMessage({
      messageId: 'wamid.1', field: 'messages',
      referral: { adId: 'ad1', sourceType: 'ad', titre: 'T', url: 'u', ctwaClid: 'c' },
    })).toEqual({ messageId: 'wamid.1', adId: 'ad1', sourceType: 'ad', titre: 'T', url: 'u', ctwaClid: 'c', enStandby: false });
  });

  it('un message en standby donne une arrivée « en standby »', () => {
    expect(arriveeDepuisMessage({
      messageId: 'wamid.2', field: 'standby',
      referral: { adId: 'ad1', sourceType: null, titre: null, url: null, ctwaClid: null },
    })?.enStandby).toBe(true);
  });

  it('sans referral, pas d’arrivée', () => {
    expect(arriveeDepuisMessage({ messageId: 'wamid.3', field: 'messages' })).toBeNull();
  });
});

describe('processArriveesPub', () => {
  const capte = () => {
    const ecrites: Array<{ tenant: string; waId: string; a: ArriveePub }> = [];
    return {
      ecrites,
      deps: {
        phoneNumberTenant: async () => 't1',
        enregistrer: async (tenant: string, waId: string, a: ArriveePub): Promise<IssueArrivee> => {
          ecrites.push({ tenant, waId, a });
          return 'ecrite';
        },
      },
    };
  };

  it('écrit une arrivée par message qui porte un referral, et ignore les autres', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.a', '33611', referral), message('wamid.b', '33612')]), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]).toMatchObject({
      tenant: 't1', waId: '33611',
      a: { messageId: 'wamid.a', adId: '120212345678901234', ctwaClid: 'clid-1', enStandby: false },
    });
  });

  it('🔴 le STANDBY n’est PAS exclu : c’est la mesure que le lot 3 attend', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.s', '33611', referral)], 'standby'), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]?.a.enStandby).toBe(true);
  });

  it('`ctwa_clid` vide chez Meta : gardé à null, et l’arrivée est quand même écrite', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.v', '33611', { ...referral, ctwa_clid: '' })]), deps);
    expect(ecrites).toHaveLength(1);
    expect(ecrites[0]?.a.ctwaClid).toBeNull();
  });

  it('numéro inconnu : rien n’est écrit', async () => {
    const { ecrites, deps } = capte();
    await processArriveesPub(payload([message('wamid.x', '33611', referral)]), { ...deps, phoneNumberTenant: async () => null });
    expect(ecrites).toHaveLength(0);
  });

  it('🔴 une erreur sur un message n’empêche pas les autres, et ne lève jamais', async () => {
    const ok: string[] = [];
    await expect(processArriveesPub(payload([message('wamid.ko', 'KO', referral), message('wamid.ok', 'OK', referral)]), {
      phoneNumberTenant: async () => 't1',
      enregistrer: async (_t, waId) => {
        if (waId === 'KO') throw new Error('base indisponible');
        ok.push(waId);
        return 'ecrite';
      },
    })).resolves.toBeUndefined();
    expect(ok).toEqual(['OK']);
  });
});
```

- [ ] **Step 2 : vérifier qu'ils échouent**

Run : `npx vitest run tests/pubs-arrivees.test.ts`
Expected : FAIL, « Cannot find module '../src/webhooks/arrivees-pub' ».

- [ ] **Step 3 : écrire l'étape**

Create `src/webhooks/arrivees-pub.ts` :

```ts
import { extractInbound, type InboundMessage } from './inbound';

/**
 * L'ARRIVÉE PUBLICITAIRE : une ligne par message entrant qui porte un `referral` (lot 1 des publicités
 * Click-to-WhatsApp, spec `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md` § 2).
 *
 * 🔴 ICI OU JAMAIS. Meta ne joint le `referral`, donc `ctwa_clid`, qu'au PREMIER message après le clic, et le
 * corps brut du webhook est purgé à 30 jours. Les champs `pub_id` et `pub_titre` de la fiche gardent la
 * DERNIÈRE pub ; cette ligne garde CHAQUE arrivée, et c'est elle que le renvoi des conversions lira.
 *
 * ⚠️ LE STANDBY N'EST PAS EXCLU, contrairement aux étapes voisines. C'est même la mesure qu'on attend : un lead
 * arrivé pendant que l'agent de Meta tenait la conversation porte-t-il son `referral` ? La réponse décide du
 * plan A ou du plan B du lot 3.
 */
export interface ArriveePub {
  messageId: string;
  adId: string;
  sourceType: string | null;
  titre: string | null;
  url: string | null;
  ctwaClid: string | null;
  enStandby: boolean;
}

/** Ce que l'écriture a constaté : écrite, déjà vue (webhook redélivré), ou aucune fiche pour ce `wa_id`. */
export type IssueArrivee = 'ecrite' | 'deja_vue' | 'sans_contact';

export function arriveeDepuisMessage(m: Pick<InboundMessage, 'messageId' | 'field' | 'referral'>): ArriveePub | null {
  if (!m.referral) return null;
  return {
    messageId: m.messageId,
    adId: m.referral.adId,
    sourceType: m.referral.sourceType,
    titre: m.referral.titre,
    url: m.referral.url,
    ctwaClid: m.referral.ctwaClid,
    enStandby: m.field === 'standby',
  };
}

export interface ArriveesPubDeps {
  /** Tenant propriétaire du numéro business. `null` si le numéro nous est inconnu. */
  phoneNumberTenant(phoneNumberId: string): Promise<string | null>;
  /** Écrit l'arrivée, rattachée à la fiche que `waId` désigne (règle partagée `MATCH_BY_WAID_SQL`). */
  enregistrer(tenantId: string, waId: string, a: ArriveePub): Promise<IssueArrivee>;
}

/**
 * Pour chaque message entrant qui porte un `referral`, écrit son arrivée.
 *
 * ⚠️ APRÈS l'upsert du contact (`handleWebhookJob`) : l'écriture retrouve la fiche par son `wa_id`. Si
 * l'auto-création a échoué juste avant, l'arrivée est perdue, et le journal le dit (sans le numéro).
 *
 * ⚠️ ISOLÉE PAR MESSAGE, comme ses voisines, et elle ne lève jamais : Meta groupe plusieurs contacts dans un
 * même webhook, et l'échec de l'un ne doit priver ni les autres, ni les étapes suivantes du job.
 */
export async function processArriveesPub(payload: unknown, deps: ArriveesPubDeps): Promise<void> {
  for (const m of extractInbound(payload)) {
    const a = arriveeDepuisMessage(m);
    if (!a) continue;
    try {
      const tenantId = await deps.phoneNumberTenant(m.phoneNumberId);
      if (!tenantId) continue;
      const issue = await deps.enregistrer(tenantId, m.waId, a);
      if (issue === 'sans_contact') {
        // eslint-disable-next-line no-console
        console.error(`arrivée publicitaire perdue, aucune fiche pour le message ${m.messageId}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('processArriveesPub: arrivée ignorée:', err instanceof Error ? err.message : err);
    }
  }
}
```

- [ ] **Step 4 : vérifier qu'ils passent**

Run : `npx vitest run tests/pubs-arrivees.test.ts`
Expected : PASS.

- [ ] **Step 5 : vérifier le standby dans les deux sens**

Ajouter temporairement `if (m.field && m.field !== 'messages') continue;` en tête de la boucle de
`processArriveesPub` (la garde des étapes voisines), relancer : le test « 🔴 le STANDBY n’est PAS exclu » doit
ÉCHOUER (0 arrivée au lieu de 1). Retirer la ligne, relancer : PASS.

- [ ] **Step 6 : typecheck et commit**

Run : `npm run typecheck` (Expected : aucune erreur)

```bash
git add -- src/webhooks/arrivees-pub.ts tests/pubs-arrivees.test.ts
git commit --only src/webhooks/arrivees-pub.ts tests/pubs-arrivees.test.ts -F - <<'EOF'
feat(pubs): l'arrivee publicitaire, etape pure du webhook

Une arrivee par message entrant qui porte un referral, ctwa_clid compris,
standby compris : c'est la mesure qui decide du plan du lot 3. Isolee par
message, elle ne leve jamais.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4 : les stores Postgres

**Files:**
- Create: `src/pubs/arrivees.pg.ts`, `src/pubs/tarifs-meta.pg.ts`
- Test: `tests/integration/pubs-capter.integration.test.ts`

**Interfaces:**
- Consumes : `ArriveePub`, `IssueArrivee` (Task 3) ; `TarifMeta`, `TarifsMetaSink` (Task 2) ;
  `MATCH_BY_WAID_SQL` (`src/crm/contact-store.pg.ts`, attend `$1` = tenant et `$2` = wa_id, et se termine par
  `order by ... limit 1`).
- Produces : `PgArriveesPubStore.enregistrer(tenantId, waId, a): Promise<IssueArrivee>` et
  `PgTarifsMetaStore implements TarifsMetaSink`.

- [ ] **Step 1 : écrire le test d'intégration**

Create `tests/integration/pubs-capter.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgArriveesPubStore } from '../../src/pubs/arrivees.pg';
import { PgTarifsMetaStore } from '../../src/pubs/tarifs-meta.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du dépôt). La CI monte un Postgres jetable pour ça (job `integration`).
const url = process.env.DATABASE_URL ?? '';

const arrivee = (messageId: string, surcharge: { ctwaClid?: string | null; enStandby?: boolean } = {}) => ({
  messageId, adId: '120212345678901234', sourceType: 'ad', titre: 'Offre itest', url: 'https://fb.me/itest',
  ctwaClid: 'clid-itest', enStandby: false, ...surcharge,
});

describe.skipIf(!url)('lot 1 des pubs : ce qui est capté à la réception (Postgres réel)', () => {
  let pool: Pool;
  let arrivees: PgArriveesPubStore;
  let tarifs: PgTarifsMetaStore;
  let tenantId = '';
  let autreTenantId = '';
  let contactId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    arrivees = new PgArriveesPubStore(pool);
    tarifs = new PgTarifsMetaStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-capter') returning id`)).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-pubs-voisin') returning id`)).rows[0]!.id;
    await pool.query(
      `insert into waba (id, tenant_id, name) values ('itest-waba-pubs', $1, 'w'), ('itest-waba-pubs-v', $2, 'w')`,
      [tenantId, autreTenantId],
    );
    await pool.query(
      `insert into phone_numbers (id, waba_id, tenant_id, display_phone_number) values
         ('itest-pn-pubs', 'itest-waba-pubs', $1, '+33525680401'),
         ('itest-pn-pubs-v', 'itest-waba-pubs-v', $2, '+33525680402')`,
      [tenantId, autreTenantId],
    );
    contactId = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000501') returning id`, [tenantId],
    )).rows[0]!.id;
    await pool.query(`insert into contacts (tenant_id, bsuid) values ($1, 'itest-bsuid-pubs')`, [tenantId]);
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('🔴 retrouve la fiche par son wa_id (chiffres nus contre E.164) et garde tout, ctwa_clid compris', async () => {
    expect(await arrivees.enregistrer(tenantId, '33600000501', arrivee('wamid.itest-a1'))).toBe('ecrite');
    const r = (await pool.query(
      `select contact_id, ad_id, source_type, titre, url, ctwa_clid, en_standby
         from arrivees_pub where tenant_id = $1 and meta_message_id = 'wamid.itest-a1'`,
      [tenantId],
    )).rows[0];
    expect(r).toEqual({
      contact_id: contactId, ad_id: '120212345678901234', source_type: 'ad', titre: 'Offre itest',
      url: 'https://fb.me/itest', ctwa_clid: 'clid-itest', en_standby: false,
    });
  });

  it('une fiche SANS numéro (BSUID seul) est retrouvée aussi', async () => {
    expect(await arrivees.enregistrer(tenantId, 'itest-bsuid-pubs', arrivee('wamid.itest-a2', { enStandby: true, ctwaClid: null })))
      .toBe('ecrite');
  });

  it('🔴 un webhook redélivré ne crée pas une seconde arrivée', async () => {
    expect(await arrivees.enregistrer(tenantId, '33600000501', arrivee('wamid.itest-a1'))).toBe('deja_vue');
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from arrivees_pub where tenant_id = $1 and meta_message_id = 'wamid.itest-a1'`, [tenantId],
    )).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('aucune fiche pour ce wa_id : rien n’est écrit, et on le sait', async () => {
    expect(await arrivees.enregistrer(tenantId, '33699999999', arrivee('wamid.itest-a3'))).toBe('sans_contact');
  });

  it('🔴 cloisonné : le même wa_id chez un AUTRE espace ne trouve pas notre fiche', async () => {
    expect(await arrivees.enregistrer(autreTenantId, '33600000501', arrivee('wamid.itest-a4'))).toBe('sans_contact');
  });

  it('supprimer réellement la fiche supprime ses arrivées', async () => {
    const jetable = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000502') returning id`, [tenantId],
    )).rows[0]!.id;
    expect(await arrivees.enregistrer(tenantId, '33600000502', arrivee('wamid.itest-a5'))).toBe('ecrite');
    await pool.query('delete from contacts where id = $1', [jetable]);
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from arrivees_pub where meta_message_id = 'wamid.itest-a5'`,
    )).rows[0]!.n;
    expect(n).toBe(0);
  });

  it('🔴 le tarif est rattaché à l’espace du numéro destinataire', async () => {
    await tarifs.enregistrer('itest-pn-pubs', { messageId: 'wamid.itest-t1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false, modele: 'PMP' });
    await tarifs.enregistrer('itest-pn-pubs-v', { messageId: 'wamid.itest-t2', type: 'regular', categorie: 'marketing', facturable: true, modele: 'PMP' });
    const rows = (await pool.query(
      `select tenant_id, wamid, type, categorie, facturable from tarifs_meta where wamid like 'wamid.itest-t%' order by wamid`,
    )).rows;
    expect(rows).toEqual([
      { tenant_id: tenantId, wamid: 'wamid.itest-t1', type: 'free_entry_point', categorie: 'referral_conversion', facturable: false },
      { tenant_id: autreTenantId, wamid: 'wamid.itest-t2', type: 'regular', categorie: 'marketing', facturable: true },
    ]);
  });

  it('le PREMIER accusé qui porte un tarif gagne (sent, delivered et read le répètent)', async () => {
    await tarifs.enregistrer('itest-pn-pubs', { messageId: 'wamid.itest-t1', type: 'regular', categorie: null, facturable: true, modele: null });
    const type = (await pool.query<{ type: string }>(`select type from tarifs_meta where wamid = 'wamid.itest-t1'`)).rows[0]!.type;
    expect(type).toBe('free_entry_point');
  });

  it('un numéro inconnu n’écrit rien (aucun espace à qui rattacher la ligne)', async () => {
    await tarifs.enregistrer('itest-pn-inconnu', { messageId: 'wamid.itest-t3', type: 'regular', categorie: null, facturable: null, modele: null });
    const n = (await pool.query<{ n: number }>(
      `select count(*)::int as n from tarifs_meta where wamid = 'wamid.itest-t3'`,
    )).rows[0]!.n;
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2 : vérifier qu'il ne compile pas encore**

Run : `npm run typecheck`
Expected : erreurs « Cannot find module '../../src/pubs/arrivees.pg' » et « '../../src/pubs/tarifs-meta.pg' ».

- [ ] **Step 3 : écrire les deux stores**

Create `src/pubs/arrivees.pg.ts` :

```ts
import type { Pool } from 'pg';
import { MATCH_BY_WAID_SQL } from '../crm/contact-store.pg';
import type { ArriveePub, IssueArrivee } from '../webhooks/arrivees-pub';

/**
 * L'écriture des arrivées publicitaires (`arrivees_pub`, migration 0163).
 *
 * 🔴 LA FICHE SE RETROUVE PAR LA RÈGLE PARTAGÉE `MATCH_BY_WAID_SQL`, JAMAIS PAR UNE COPIE. C'est la règle de
 * routage des messages entrants ; une égalité recopiée (`phone_e164 = wa_id`) ne peut jamais être vraie, le
 * fil portant `33612345678` et la fiche `+33612345678`, et c'est exactement le bug de purge du 2026-08-18.
 *
 * Une seule requête rend les deux constats dont l'appelant a besoin : y avait-il une fiche, et la ligne
 * a-t-elle été écrite. Un `on conflict do nothing` seul ne distingue pas « déjà vue » de « aucune fiche ».
 */
export class PgArriveesPubStore {
  constructor(private readonly pool: Pool) {}

  async enregistrer(tenantId: string, waId: string, a: ArriveePub): Promise<IssueArrivee> {
    const res = await this.pool.query<{ fiches: number; ecrites: number }>(
      `with fiche as (
         select id from contacts where tenant_id = $1
         ${MATCH_BY_WAID_SQL}
       ), ecrite as (
         insert into arrivees_pub (tenant_id, contact_id, meta_message_id, ad_id, source_type, titre, url, ctwa_clid, en_standby)
         select $1, fiche.id, $3, $4, $5, $6, $7, $8, $9 from fiche
         on conflict (tenant_id, meta_message_id) do nothing
         returning 1
       )
       select (select count(*) from fiche)::int as fiches, (select count(*) from ecrite)::int as ecrites`,
      [tenantId, waId, a.messageId, a.adId, a.sourceType, a.titre, a.url, a.ctwaClid, a.enStandby],
    );
    const r = res.rows[0];
    if (!r || r.fiches === 0) return 'sans_contact';
    return r.ecrites > 0 ? 'ecrite' : 'deja_vue';
  }
}
```

Create `src/pubs/tarifs-meta.pg.ts` :

```ts
import type { Pool } from 'pg';
import type { TarifMeta, TarifsMetaSink } from '../webhooks/tarif-meta';

/**
 * L'écriture des tarifs de Meta (`tarifs_meta`, migration 0163).
 *
 * L'espace se résout par le numéro DESTINATAIRE de l'accusé (`phone_numbers`), dans la même requête : un
 * numéro inconnu n'écrit rien. Le PREMIER accusé qui porte un tarif gagne : Meta répète le même `pricing` sur
 * sent, delivered et read.
 */
export class PgTarifsMetaStore implements TarifsMetaSink {
  constructor(private readonly pool: Pool) {}

  async enregistrer(phoneNumberId: string, t: TarifMeta): Promise<void> {
    await this.pool.query(
      `insert into tarifs_meta (tenant_id, wamid, type, categorie, facturable, modele)
       select pn.tenant_id, $2, $3, $4, $5, $6 from phone_numbers pn where pn.id = $1
       on conflict (tenant_id, wamid) do nothing`,
      [phoneNumberId, t.messageId, t.type, t.categorie, t.facturable, t.modele],
    );
  }
}
```

- [ ] **Step 4 : typecheck et unitaires**

Run : `npm run typecheck` puis `npm test`
Expected : aucune erreur, PASS. (Le test d'intégration tourne en CI, Task 9.)

- [ ] **Step 5 : commit**

```bash
git add -- src/pubs/arrivees.pg.ts src/pubs/tarifs-meta.pg.ts tests/integration/pubs-capter.integration.test.ts
git commit --only src/pubs/arrivees.pg.ts src/pubs/tarifs-meta.pg.ts tests/integration/pubs-capter.integration.test.ts -F - <<'EOF'
feat(pubs): stores Postgres des arrivees et des tarifs

L'arrivee retrouve la fiche par MATCH_BY_WAID_SQL et distingue ecrite,
deja vue et sans fiche. Le tarif se rattache a l'espace par le numero
destinataire, et le premier accuse qui en porte un gagne.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5 : le job webhook exige ces deux dépendances, et le worker les câble

**Files:**
- Modify: `src/webhooks/handler.ts`, `src/worker.ts`
- Create: `tests/webhook-fixtures.ts`
- Modify: `tests/delivery.test.ts`, `tests/webhook-triggers.test.ts` (appels existants, guidés par le typecheck)
- Test: `tests/pubs-arrivees.test.ts`, `tests/pubs-tarif-meta.test.ts` (un cas chacun, par `handleWebhookJob`)

**Interfaces:**
- Consumes : `ArriveesPubDeps`, `processArriveesPub` (Task 3) ; `TarifsMetaSink` (Task 2) ;
  `PgArriveesPubStore`, `PgTarifsMetaStore` (Task 4).
- Produces : `export type WebhookJobDeps` où `delivery` exige `tarifsMeta`, et `inbox` exige `arriveesPub`.
  `tests/webhook-fixtures.ts` exporte `aucunTarif: TarifsMetaSink` et `aucuneArriveePub: ArriveesPubDeps`.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à la fin de `tests/pubs-arrivees.test.ts` (et `import { handleWebhookJob } from '../src/webhooks/handler';` en tête) :

```ts
describe('handleWebhookJob : l’arrivée publicitaire', () => {
  it('🔴 elle s’écrit APRÈS l’upsert du contact, qu’elle retrouve par son wa_id', async () => {
    const ordre: string[] = [];
    await handleWebhookJob(payload([message('wamid.h', '33611', referral)]), {
      store: { insertEvent: async () => true },
      inbox: { phoneNumberTenant: async () => 't1', recordInbound: async () => {} },
      inboundContactUpsert: async () => { ordre.push('upsert'); return 'created'; },
      arriveesPub: {
        phoneNumberTenant: async () => 't1',
        enregistrer: async () => { ordre.push('arrivee'); return 'ecrite'; },
      },
    });
    expect(ordre).toEqual(['upsert', 'arrivee']);
  });
});
```

Ajouter à la fin de `tests/pubs-tarif-meta.test.ts` (et `import { handleWebhookJob } from '../src/webhooks/handler';` en tête) :

```ts
describe('handleWebhookJob : le tarif des accusés', () => {
  it('passe le tarif au puits, avec le numéro destinataire du change', async () => {
    const vus: string[] = [];
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pn9' },
        statuses: [{ id: 'wamid.h1', status: 'sent', pricing: { type: 'free_entry_point', category: 'referral_conversion', billable: false } }],
      } }] }],
    }, {
      store: { insertEvent: async () => true },
      delivery: new FakeDelivery(),
      tarifsMeta: { enregistrer: async (pn, t) => { vus.push(`${pn}:${t.messageId}:${t.type}`); } },
    });
    expect(vus).toEqual(['pn9:wamid.h1:free_entry_point']);
  });
});
```

- [ ] **Step 2 : vérifier qu'ils échouent**

Run : `npx vitest run tests/pubs-arrivees.test.ts tests/pubs-tarif-meta.test.ts`
Expected : FAIL sur les deux nouveaux cas (`ordre` vaut `['upsert']`, `vus` vaut `[]`) : `handleWebhookJob`
ignore encore `arriveesPub` et `tarifsMeta`.

- [ ] **Step 3 : typer et brancher dans `handler.ts`**

1. Imports, sous `import { processTestTokens } from './test-token';` :

```ts
import { processArriveesPub, type ArriveesPubDeps } from './arrivees-pub';
import type { TarifsMetaSink } from './tarif-meta';
```

2. Renommer `export interface WebhookJobDeps {` en `interface WebhookJobDepsCommunes {`, et retirer de cette
interface les deux membres `delivery?: DeliveryStore;` et `inbox?: InboxStore;` (tous les autres membres et
leurs docblocks restent tels quels). Juste après l'accolade fermante de l'interface, ajouter :

```ts
/**
 * 🔴 DEUX COUPLES DE DÉPENDANCES OBLIGATOIRES (lot 1 des publicités Click-to-WhatsApp).
 *
 * Une file qui traite des ACCUSÉS (`delivery`) doit garder leur tarif (`tarifsMeta`) : c'est la seule source de
 * « Meta ne facture pas ce message », et les accusés arrivent par DEUX files (`webhook` et `webhook-status`).
 * Une file qui traite des ENTRANTS (`inbox`) doit garder les arrivées publicitaires (`arriveesPub`) : Meta
 * n'envoie `ctwa_clid` qu'une fois. Un oubli ne se verrait nulle part, donc c'est le compilateur qui le refuse.
 * Les tests qui n'en parlent pas passent `aucunTarif` et `aucuneArriveePub` (`tests/webhook-fixtures.ts`), qui
 * DISENT leur hypothèse, comme `jamaisDesabonne`.
 */
export type WebhookJobDeps = WebhookJobDepsCommunes
  & ({ delivery: DeliveryStore; tarifsMeta: TarifsMetaSink } | { delivery?: undefined; tarifsMeta?: undefined })
  & ({ inbox: InboxStore; arriveesPub: ArriveesPubDeps } | { inbox?: undefined; arriveesPub?: undefined });
```

3. Dans `handleWebhookJob`, ajouter `tarifsMeta, arriveesPub,` à la déstructuration de `deps`, puis remplacer :

```ts
  if (delivery) await processStatuses(events, delivery, nodeEvents, remiseMba);
```

par :

```ts
  if (delivery) await processStatuses(events, delivery, nodeEvents, remiseMba, tarifsMeta);
```

4. Juste après la ligne `if (inbox) await processInbound(raw, inbox, upsert, inboundOptOut, inboundAssignation);` :

```ts
  // L'arrivée publicitaire, APRÈS l'upsert du contact qu'elle retrouve par son wa_id. Isolée par message dans
  // `processArriveesPub` : elle ne fait jamais échouer le job.
  if (arriveesPub) await processArriveesPub(raw, arriveesPub);
```

- [ ] **Step 4 : écrire les fixtures**

Create `tests/webhook-fixtures.ts` :

```ts
import type { TarifsMetaSink } from '../src/webhooks/tarif-meta';
import type { ArriveesPubDeps } from '../src/webhooks/arrivees-pub';

/**
 * Les deux dépendances que `WebhookJobDeps` rend obligatoires (lot 1 des publicités Click-to-WhatsApp), pour
 * les tests qui ne parlent ni de coût ni de publicité. Elles DISENT l'hypothèse au lieu de la cacher, comme
 * `jamaisDesabonne` (`tests/consentement.ts`).
 */
export const aucunTarif: TarifsMetaSink = { enregistrer: async () => {} };
export const aucuneArriveePub: ArriveesPubDeps = { phoneNumberTenant: async () => null, enregistrer: async () => 'ecrite' };
```

- [ ] **Step 5 : câbler le worker**

In `src/worker.ts` :

1. Imports, à côté des autres imports de stores :

```ts
import { PgArriveesPubStore } from './pubs/arrivees.pg';
import { PgTarifsMetaStore } from './pubs/tarifs-meta.pg';
```

2. Juste après `const inboxStore = new PgInboxStore(pool);` :

```ts
  // Lot 1 des publicités Click-to-WhatsApp : ce qui se perd si on ne le garde pas à la réception.
  const arriveesPubStore = new PgArriveesPubStore(pool);
  const tarifsMetaStore = new PgTarifsMetaStore(pool);
```

3. Dans `queue.work('webhook', ...)`, sous `remiseMba: remiseMbaSurAccuse,` :

```ts
      // 🔴 SUR LES DEUX FILES qui voient des accusés, pour la raison écrite juste au-dessus : le tarif est la
      // seule source de « Meta ne facture pas ce message ».
      tarifsMeta: tarifsMetaStore,
```

et sous `inbox: inboxStore,` :

```ts
      // L'arrivée publicitaire (`ctwa_clid` compris) : un message ENTRANT n'arrive que par cette file.
      arriveesPub: {
        phoneNumberTenant: (pnid) => inboxStore.phoneNumberTenant(pnid),
        enregistrer: (t, w, a) => arriveesPubStore.enregistrer(t, w, a),
      },
```

4. Dans `queue.work('webhook-status', ...)`, remplacer l'appel par :

```ts
    await handleWebhookJob(data, { store: eventStore, delivery: recipientStore, nodeEvents: nodeEventStore, remiseMba: remiseMbaSurAccuse, tarifsMeta: tarifsMetaStore });
```

- [ ] **Step 6 : laisser le typecheck énumérer les tests à ajuster**

Run : `npm run typecheck`
Expected : des erreurs sur `tests/delivery.test.ts` (un appel avec `delivery`) et sur
`tests/webhook-triggers.test.ts` (chaque appel à `handleWebhookJob` qui passe `inbox`), et plus aucune sur
`src/worker.ts`.

Dans `tests/delivery.test.ts` : ajouter `import { aucunTarif } from './webhook-fixtures';` et `tarifsMeta:
aucunTarif,` sous `delivery,` dans l'appel à `handleWebhookJob`.
Dans `tests/webhook-triggers.test.ts` : ajouter `import { aucuneArriveePub } from './webhook-fixtures';` et
`arriveesPub: aucuneArriveePub,` sous chaque ligne `inbox,` d'un appel à `handleWebhookJob`.

Run : `npm run typecheck`
Expected : aucune erreur.

- [ ] **Step 7 : la garde du compilateur, dans les deux sens**

Retirer temporairement `tarifsMeta: tarifsMetaStore` de l'appel de `webhook-status`, relancer
`npm run typecheck` : il doit ÉCHOUER sur cet appel (aucun membre de l'union ne l'accepte). Remettre. Retirer
temporairement le bloc `arriveesPub: { ... }` de la file `webhook`, relancer : ÉCHEC sur cet appel. Remettre,
relancer : aucune erreur.

- [ ] **Step 8 : les tests, et l'ordre dans les deux sens**

Run : `npx vitest run tests/pubs-arrivees.test.ts tests/pubs-tarif-meta.test.ts tests/delivery.test.ts tests/webhook-triggers.test.ts tests/handler.test.ts`
Expected : PASS.

Déplacer temporairement la ligne `if (arriveesPub) await processArriveesPub(raw, arriveesPub);` AVANT
`if (inbox) await processInbound(...)`, relancer `npx vitest run tests/pubs-arrivees.test.ts` : le test
« 🔴 elle s’écrit APRÈS l’upsert » doit ÉCHOUER (`['arrivee', 'upsert']`). Remettre la ligne, relancer : PASS.

Run : `npm test`
Expected : PASS.

- [ ] **Step 9 : commit**

```bash
git add -- tests/webhook-fixtures.ts
git commit --only src/webhooks/handler.ts src/worker.ts tests/webhook-fixtures.ts tests/delivery.test.ts tests/webhook-triggers.test.ts tests/pubs-arrivees.test.ts tests/pubs-tarif-meta.test.ts -F - <<'EOF'
feat(pubs): le job webhook exige le tarif et l'arrivee, le worker les cable

WebhookJobDeps rend tarifsMeta obligatoire avec delivery, et arriveesPub
avec inbox : un cablage qui les oublie ne compile plus. Le tarif est cable
sur webhook ET webhook-status, l'arrivee sur webhook, apres l'upsert du
contact. Les tests qui n'en parlent pas le DISENT (aucunTarif,
aucuneArriveePub).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6 : la purge RGPD efface `ctwa_clid`

**Files:**
- Modify: `src/crm/contact-store.pg.ts` (`purgeMany`)
- Test: `tests/integration/purge-rgpd.integration.test.ts`

**Interfaces:**
- Consumes : la table `arrivees_pub` (Task 1).

- [ ] **Step 1 : étendre le test d'intégration**

In `tests/integration/purge-rgpd.integration.test.ts`, à la fin du `beforeAll` (après l'insertion dans
`webhook_events`) :

```ts
    // L'ARRIVÉE PUBLICITAIRE (lot 1 des pubs) : `ctwa_clid` est l'identifiant du CLIC, que Meta sait relier à la
    // personne. Il doit partir ; la ligne doit rester (le compte des leads d'une pub survit, comme le quanti).
    await pool.query(
      `insert into arrivees_pub (tenant_id, contact_id, meta_message_id, ad_id, ctwa_clid, en_standby)
       values ($1, $2, 'wam-itest-arrivee', 'ad-itest', 'clid-itest', false)`,
      [tenantId, contactId],
    );
```

Et un cas, juste après le test « 🔴 les mesures par bloc sont ANONYMISEES » :

```ts
  it('🔴 l’arrivée publicitaire RESTE, son ctwa_clid PART (le compte survit, l’identifiant du clic non)', async () => {
    const r = await pool.query<{ ctwa_clid: string | null }>(
      'select ctwa_clid from arrivees_pub where tenant_id = $1 and contact_id = $2', [tenantId, contactId],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]!.ctwa_clid).toBeNull();
  });
```

- [ ] **Step 2 : effacer `ctwa_clid` dans `purgeMany`**

In `src/crm/contact-store.pg.ts`, dans `purgeMany`, juste après la requête `update campaign_recipients set
to_e164 = 'anonyme', resolved_params = '{}'::jsonb ...` et avant `const res = await client.query(` (la mise à
jour de `contacts`) :

```ts
      // L'ARRIVÉE PUBLICITAIRE (lot 1 des pubs Click-to-WhatsApp, migration 0163) : `ctwa_clid` est
      // l'identifiant du CLIC, que Meta sait relier à la personne. La ligne reste, pour que le compte des leads
      // d'une pub survive à l'effacement comme celui des campagnes juste au-dessus ; l'identifiant part.
      // ⚠️ La suppression en cascade de la fiche ne joue JAMAIS ici : cette purge ANONYMISE la fiche, elle ne
      // la supprime pas.
      await client.query(
        `update arrivees_pub set ctwa_clid = null where tenant_id = $1 and contact_id = any($2::uuid[])`,
        [tenantId, ids],
      );
```

- [ ] **Step 3 : typecheck, unitaires, commit**

Run : `npm run typecheck` puis `npm test`
Expected : aucune erreur, PASS. Le test d'intégration tourne en CI (Task 9) ; son sens « rouge » est porté par
le fixture lui-même : sans la requête ajoutée, la ligne garde `clid-itest` et le cas échoue.

```bash
git commit --only src/crm/contact-store.pg.ts tests/integration/purge-rgpd.integration.test.ts -F - <<'EOF'
fix(rgpd): la purge efface le ctwa_clid des arrivees publicitaires

La purge anonymise la fiche sans la supprimer : la cascade de arrivees_pub
ne jouait donc jamais, et l'identifiant du clic, que Meta sait relier a la
personne, aurait survecu a l'effacement. La ligne reste pour le compte.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 7 : le coût exclut les 72 h gratuites

> ⚠️ **Écart constaté à l'exécution (2026-09-22)** : une CINQUIÈME lecture de coût, `envoisDeLaCampagne` (la
> fiche d'une campagne, dont la documentation exige la même population que `getVolumeParCampagne`), reçoit
> aussi l'exclusion, dans ses deux branches, et le test d'intégration la vérifie. Le code ci-dessous décrit les
> quatre lectures prévues ; le commit `feat(cout)` porte les cinq. Puis la relecture indépendante a trouvé une
> lecture de plus, `bilanContact` (`src/crm/contact-history.pg.ts`), et une branche que le test n'exerçait pas :
> corrigées par `fix(cout)`, qui déplace aussi le fragment dans `src/stats/entree-gratuite.ts`.

**Files:**
- Modify: `src/stats/store.pg.ts`
- Test: `tests/integration/cout-entree-gratuite.integration.test.ts`

**Interfaces:**
- Consumes : `TYPE_ENTREE_GRATUITE` (Task 2), la table `tarifs_meta` (Task 1).

- [ ] **Step 1 : écrire le test d'intégration**

Create `tests/integration/cout-entree-gratuite.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgStatsStore } from '../../src/stats/store.pg';
import { TYPE_ENTREE_GRATUITE } from '../../src/webhooks/tarif-meta';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION.
const url = process.env.DATABASE_URL ?? '';
const RANGE = { from: '2026-09-01', to: '2026-09-07' };
const GRATUITS = ['wamid.cg-camp-gratuit', 'wamid.cg-tpl-gratuit', 'wamid.cg-svc-gratuit'];

/**
 * Les messages que Meta ne facture pas (72 h après un clic sur une pub) sortent des QUATRE lectures de coût.
 *
 * 🔴 LE DERNIER CAS PORTE LES DEUX SENS DANS UN SEUL RUN. Les mêmes messages, requalifiés `regular`,
 * redeviennent comptés : c'est l'exclusion, et rien d'autre, qui fait le chiffre. Sans elle, les premiers cas
 * rendraient 4, 2 et 2.
 */
describe.skipIf(!url)('Coût : les 72 h gratuites après un clic sur une pub (Postgres réel)', () => {
  let pool: Pool;
  let store: PgStatsStore;
  let tenantId = '';
  let campaignId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgStatsStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cout-gratuit') returning id`)).rows[0]!.id;
    const contacts: string[] = [];
    for (const num of ['+33600000601', '+33600000602']) {
      contacts.push((await pool.query<{ id: string }>(
        `insert into contacts (tenant_id, phone_e164) values ($1, $2) returning id`, [tenantId, num],
      )).rows[0]!.id);
    }
    campaignId = (await pool.query<{ id: string }>(
      `insert into campaigns (tenant_id, name, category, template_name, channel)
       values ($1, 'itest-cout-gratuit', 'marketing', 'itest_tpl_gratuit', 'whatsapp') returning id`,
      [tenantId],
    )).rows[0]!.id;
    // Deux envois de campagne : l'un dans une fenêtre gratuite, l'autre SANS ligne de tarif (le cas d'avant).
    await pool.query(
      `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, status, sent_at, message_id)
       values ($1, $2, '33600000601', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.cg-camp-gratuit'),
              ($1, $3, '33600000602', '{}'::jsonb, 'sent', timestamptz '2026-09-05 08:00:00+00', 'wamid.cg-camp-payant')`,
      [campaignId, contacts[0], contacts[1]],
    );
    // La conversation du premier contact : deux modèles et deux messages de service, un gratuit et un payant.
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, contact_id, last_message_at, control_owner, is_test)
       values ($1, '33600000601', $2, now(), 'app_workflow', false) returning id`,
      [tenantId, contacts[0]],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, channel, template_name, template_category, created_at, meta_message_id) values
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_scn', 'utility', timestamptz '2026-09-05 09:00:00+00', 'wamid.cg-tpl-gratuit'),
         ($1, 'out', 'template', 'whatsapp', 'itest_tpl_scn', 'utility', timestamptz '2026-09-05 09:01:00+00', 'wamid.cg-tpl-payant'),
         ($1, 'out', 'text', 'whatsapp', null, null, timestamptz '2026-09-05 10:00:00+00', 'wamid.cg-svc-gratuit'),
         ($1, 'out', 'text', 'whatsapp', null, null, timestamptz '2026-09-05 10:01:00+00', 'wamid.cg-svc-payant')`,
      [conv],
    );
    // Ce que Meta a écrit dans ses accusés. `wamid.cg-camp-payant` n'a AUCUNE ligne : absence = payant.
    await pool.query(
      `insert into tarifs_meta (tenant_id, wamid, type) values
         ($1, 'wamid.cg-camp-gratuit', $2), ($1, 'wamid.cg-tpl-gratuit', $2), ($1, 'wamid.cg-svc-gratuit', $2),
         ($1, 'wamid.cg-tpl-payant', 'regular'), ($1, 'wamid.cg-svc-payant', 'regular')`,
      [tenantId, TYPE_ENTREE_GRATUITE],
    );
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const total = (rows: Array<{ count: number }>) => rows.reduce((a, r) => a + r.count, 0);
  const dans = (rows: Array<{ dansLaPeriode: number }>) => rows.reduce((a, r) => a + r.dansLaPeriode, 0);

  it('🔴 les modèles gratuits sortent du coût, un modèle SANS tarif connu y reste', async () => {
    // `cg-camp-payant` (aucune ligne) et `cg-tpl-payant` ('regular') restent ; les deux gratuits sortent.
    expect(total(await store.getCostVolume(tenantId, RANGE, {}))).toBe(2);
  });

  it('le détail par modèle et le volume par campagne disent la MÊME chose que le graphe', async () => {
    expect(total(await store.getTemplateBreakdown(tenantId, RANGE))).toBe(2);
    const parCampagne = (await store.getVolumeParCampagne(tenantId, RANGE)).filter((l) => l.campaignId === campaignId);
    expect(parCampagne.reduce((a, l) => a + l.count, 0)).toBe(1);
  });

  it('🔴 les messages de service gratuits sortent aussi, du mois ET de la campagne', async () => {
    expect(dans(await store.serviceParMois(tenantId, RANGE))).toBe(1);
    expect((await store.servicesParCampagne(tenantId, [campaignId], RANGE)).get(campaignId)).toBe(1);
  });

  it('🔴 LES DEUX SENS : requalifiés « regular », les mêmes messages redeviennent comptés', async () => {
    await pool.query(`update tarifs_meta set type = 'regular' where tenant_id = $1 and wamid = any($2::text[])`, [tenantId, GRATUITS]);
    try {
      expect(total(await store.getCostVolume(tenantId, RANGE, {}))).toBe(4);
      expect(dans(await store.serviceParMois(tenantId, RANGE))).toBe(2);
      expect((await store.servicesParCampagne(tenantId, [campaignId], RANGE)).get(campaignId)).toBe(2);
    } finally {
      await pool.query(`update tarifs_meta set type = $3 where tenant_id = $1 and wamid = any($2::text[])`, [tenantId, GRATUITS, TYPE_ENTREE_GRATUITE]);
    }
  });
});
```

- [ ] **Step 2 : le fragment unique, posé dans les quatre lectures**

In `src/stats/store.pg.ts` :

1. Import en tête, avec les autres imports :

```ts
import { TYPE_ENTREE_GRATUITE } from '../webhooks/tarif-meta';
```

2. Juste après `const SANS_ATTRIBUTION = 'null::uuid';` :

```ts
/**
 * « META NE FACTURE PAS CE MESSAGE » : il est parti dans les 72 h gratuites qui suivent un clic sur une pub
 * Click-to-WhatsApp (lot 1 des pubs, migration 0163). La seule source est l'accusé de Meta, gardé dans
 * `tarifs_meta` ; un message SANS ligne de tarif reste compté comme payant, c'est-à-dire le comportement
 * d'avant.
 *
 * 🔴 UNE SEULE ÉCRITURE, POUR LES QUATRE LECTURES DE COÛT : les deux branches de `envoisTemplateFacturables`,
 * `serviceParMois` et `servicesParCampagne`. ⚠️ Et SEULEMENT elles : les courbes de VOLUME de `getDashboard`
 * comptent des envois, pas des euros, et un message gratuit y reste un message envoyé. L'écart est voulu.
 */
function horsEntreeGratuite(wamid: string, tenant: string): string {
  return `not exists (select 1 from tarifs_meta tg where tg.tenant_id = ${tenant} and tg.wamid = ${wamid} and tg.type = '${TYPE_ENTREE_GRATUITE}')`;
}
```

3. Dans `envoisTemplateFacturables`, première branche, sous
`and (r.delivery_status is null or r.delivery_status <> 'failed')`, ajouter la ligne :

```ts
    and ${horsEntreeGratuite('r.message_id', 'c.tenant_id')}
```

et seconde branche, après la parenthèse fermante du `not exists (...)` anti double-compte (dernière ligne du
fragment, avant le backtick final), ajouter la ligne :

```ts
    and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
```

4. Dans `serviceParMois`, sous `and m.direction = 'out' and m.channel = 'whatsapp' and m.type is distinct from 'template'`, ajouter :

```ts
          and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
```

5. Dans `servicesParCampagne`, CTE `services`, sous la même ligne de filtre, ajouter :

```ts
            and ${horsEntreeGratuite('m.meta_message_id', 'cv.tenant_id')}
```

6. Dans les docblocks de `serviceParMois` et de `servicesParCampagne`, à la fin du paragraphe « LE FILTRE ...
MOT POUR MOT », ajouter :

```ts
   * ⚠️ SAUF l'exclusion des 72 h gratuites (`horsEntreeGratuite`), que seules les lectures de COÛT portent :
   * un message gratuit reste un message envoyé dans les courbes de volume.
```

- [ ] **Step 3 : typecheck, unitaires, relecture du SQL**

Run : `npm run typecheck` puis `npm test`
Expected : aucune erreur, PASS.

Run : `grep -n "horsEntreeGratuite" src/stats/store.pg.ts`
Expected : exactement 5 lignes (la définition et 4 usages), aucune dans `getDashboard`. Relire chaque usage :
`r.` et `c.` dans la branche campagne, `m.` et `cv.` ailleurs.

- [ ] **Step 4 : commit**

```bash
git add -- tests/integration/cout-entree-gratuite.integration.test.ts
git commit --only src/stats/store.pg.ts tests/integration/cout-entree-gratuite.integration.test.ts -F - <<'EOF'
feat(cout): les 72 h gratuites apres un clic sur une pub sortent du cout

Un fragment unique, horsEntreeGratuite, pose l'exclusion dans les quatre
lectures de cout (modeles des deux branches, service par mois, service par
campagne), d'apres le tarif de l'accuse. Les courbes de volume ne bougent
pas : un message gratuit reste un message envoye.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 8 : la documentation

**Files:**
- Modify: `documentation.md`, `features.md`, `todo.md`, `wip.md`, `docs/JOURNAL-TECHNIQUE.md`

- [ ] **Step 1 : `documentation.md`, flux d'un message entrant et accusés**

Dans le bloc du § 4.1, remplacer la ligne `        capture du referral CTWA (premier message seulement)` par :

```
        capture du referral CTWA (premier message seulement) : champs de la fiche,
          puis ligne `arrivees_pub` (ctwa_clid, standby compris), juste après l'upsert
```

À la fin du paragraphe « ⚠️ Le referral d'une publicité Click-to-WhatsApp n'arrive que sur le PREMIER
message », ajouter :

```
Chaque arrivée garde aussi sa ligne dans `arrivees_pub` (migration 0163), `standby` compris : c'est la seule
trace de `ctwa_clid`. La purge RGPD efface `ctwa_clid` et garde la ligne (elle anonymise la fiche sans la
supprimer, donc la cascade ne joue pas). `WebhookJobDeps` rend `arriveesPub` obligatoire avec `inbox`.
```

Après le paragraphe « ⚠️ `webhook-status` est une file SÉPARÉE », ajouter :

```
🔴 **Les accusés gardent le tarif que Meta annonce** (`tarifs_meta`), sur les DEUX files qui voient des
accusés : `WebhookJobDeps` rend `tarifsMeta` obligatoire avec `delivery`. Les quatre lectures de COÛT excluent
les messages `free_entry_point` (les 72 h gratuites qui suivent un clic sur une pub) par un fragment unique,
`horsEntreeGratuite` ; les courbes de VOLUME les comptent, délibérément. Un message sans ligne de tarif reste
compté comme payant.
```

- [ ] **Step 2 : `features.md`**

Après la phrase qui décrit la carte « Coûts » à trois lignes dépliables, ajouter :

```
Le coût des messages ne compte pas ceux que Meta ne facture pas : les messages envoyés dans les 72 h qui
suivent un clic sur une pub Click-to-WhatsApp, d'après l'accusé de Meta.
```

- [ ] **Step 3 : `todo.md`**

Dans « En attente d'une VÉRIFICATION EN VOL », item 2, remplacer les deux phrases qui commencent par
« ⚠️ AVANT la première campagne publicitaire, vérifier la bascule d'attribution » par :

```
⚠️ Le « réglage d'attribution à activer » côté WhatsApp Business n'est attesté que par un fournisseur d'API
non officielle (recherche du 2026-09-22) : la doc Cloud API ne le connaît pas. La preuve viendra de l'essai
réel du lot 3 des pubs (`docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`) : une ligne dans
`arrivees_pub`, la fiche qui porte « Pub (identifiant) », et le scénario qui part.
```

Dans « À faire : renvoyer les conversions publicitaires à Meta », remplacer la dernière phrase (« Le jour où on
referme la boucle d'attribution, il faut donc le recopier sur la fiche contact À LA RÉCEPTION. ») par :

```
C'est fait depuis le lot 1 des pubs : `arrivees_pub.ctwa_clid`, écrit à la réception. Le renvoi attend la
mesure du pilote (spec du 2026-09-22, § 6).
```

- [ ] **Step 4 : `wip.md`**

Ajouter en tête des chantiers en cours :

```
## Publicités Click-to-WhatsApp (spec docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md)

- Lot 1 « Capter » : arrivées publicitaires et tarifs de Meta gardés à la réception, 72 h gratuites exclues
  du coût. ⚠️ La capture des arrivées n'est PAS éprouvée : aucun clic réel n'est encore arrivé. Elle le sera
  pendant l'essai réel du lot 3 (première campagne MessagingMe créée depuis Engage Me).
- Lot 2 « Connecter » : attend les prérequis Meta de la spec, § 11.
```

- [ ] **Step 5 : `docs/JOURNAL-TECHNIQUE.md`**

À la fin de la section « Publicités Click-to-WhatsApp (CTWA) : identifier d'où vient un lead », après le
paragraphe « ⚠️ Rien de tout cela n'a encore été vu en vol », ajouter :

```
⚠️ **Note du 2026-09-22.** Le piège n°3 (la bascule d'attribution) n'est attesté que par un fournisseur d'API
non officielle ; la doc Cloud API ne le connaît pas. Et `ctwa_clid` n'est plus perdu : le lot 1 des pubs le
garde dans `arrivees_pub` (migration 0163).
```

- [ ] **Step 6 : relire et commit**

Relire le diff (`git diff -- documentation.md features.md todo.md wip.md docs/JOURNAL-TECHNIQUE.md`) : aucun
tiret cadratin ni demi-cadratin ajouté, aucun compteur calculable écrit en prose.

```bash
git commit --only documentation.md features.md todo.md wip.md docs/JOURNAL-TECHNIQUE.md -F - <<'EOF'
docs(pubs): lot 1 documente, et le reglage d'attribution requalifie

Le flux entrant et les accuses decrivent arrivees_pub et tarifs_meta, les
quatre lectures de cout et leur ecart voulu avec les courbes de volume. Le
« reglage d'attribution » n'est atteste que par une source non officielle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 9 : vérification, revue, CI, déploiement et essai réel

⚠️ Les étapes 3 à 7 touchent la production ou publient : chacune demande l'accord explicite de Julien.

- [ ] **Step 1 : tout, en local**

Run : `npm run typecheck` puis `npm test`
Expected : aucune erreur, PASS.

- [ ] **Step 2 : revue du lot**

Invoquer la skill `revue` sur le diff du lot (du commit de la Task 1 à `HEAD`), section « Rayon de souffle »
comprise. Corriger 🔴 ET 🟡 dans la foulée, relancer l'étape 1.

- [ ] **Step 3 : pousser et lire la CI (accord de Julien)**

Run : `git push origin main`, puis `gh run list --limit 3` et `gh run view <id> --json jobs`
Expected : jobs `unit` et `integration` en `success`, lus job par job. Les nouveaux fichiers d'intégration
(`pubs-capter`, `cout-entree-gratuite`) et le cas ajouté à `purge-rgpd` apparaissent dans le journal du job.

- [ ] **Step 4 : revue finale et migration (accord de Julien)**

Invoquer la skill `revue-finale` (la garde de déploiement l'exige). Puis, sur le VPS, dans l'ordre de
`DEPLOY.md` et du `CLAUDE.md` : `git pull`, `sudo docker compose build mba-api`,
`sudo docker compose run --rm --no-deps mba-api npm run migrate`.

- [ ] **Step 5 : relire la base JUSTE APRÈS `migrate`**

```sql
select name from public.schema_migrations order by name desc limit 2;
select table_name, column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name in ('arrivees_pub', 'tarifs_meta')
 order by table_name, ordinal_position;
select conrelid::regclass as t, conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid in ('public.arrivees_pub'::regclass, 'public.tarifs_meta'::regclass);
select indexname, indexdef from pg_indexes where tablename in ('arrivees_pub', 'tarifs_meta');
```

Expected : `0163_pubs_capter.sql` en tête ; les colonnes et leur nullabilité exactes de la Task 1 ; les deux
clés étrangères de `arrivees_pub` et celle de `tarifs_meta` en `on delete cascade`, l'unicité
`(tenant_id, meta_message_id)`, la clé primaire `(tenant_id, wamid)` ; l'index `arrivees_pub_contact_idx`. Puis
mettre à jour la ligne « Dernière appliquée » du `CLAUDE.md` (0163, sa date, ce qu'elle porte) et la commiter
seule.

- [ ] **Step 6 : déployer et contrôler (accord de Julien)**

`sudo docker compose up -d --build mba-api mba-worker`, puis le contrôle public de `DEPLOY.md`. Un 502 alors
que les conteneurs sont `healthy` : `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.

- [ ] **Step 7 : l'essai réel du lot 1**

Dans l'heure qui suit, en base :

```sql
select type, count(*) from tarifs_meta group by 1 order by 2 desc;
```

Expected : des lignes `regular` (et d'autres types éventuels) arrivent avec les accusés réels. Le coût des
messages d'un espace sans pub affiche le même total qu'avant le déploiement sur une période passée. Noter le
résultat dans `wip.md`. ⚠️ `arrivees_pub` restera vide tant qu'aucune vraie pub ne tourne : c'est attendu, et
c'est l'essai réel du lot 3 qui l'éprouvera.
