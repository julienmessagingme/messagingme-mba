# Performance Lab : les coûts et l'analyse des conversations (lot 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** La page de synthèse répond à trois questions de coût en trois chiffres, et l'analyse des
conversations devient lisible à mille conversations comme à quatorze.

**Architecture:** Les calculs de coût restent PURS (`src/stats/cost.ts` et voisins, aucune base, aucun
réseau) et reçoivent une grille de prix par espace. Le front remplace `CoutParCampagneCard` par une carte à
trois lignes dépliables et refond `DetailCampagneModale`. La rétention descend à 90 jours, compensée par une
table d'agrégats journaliers anonymes alimentée par un balayage nocturne.

**Tech Stack:** Fastify + Postgres côté serveur, Next.js App Router + Tailwind côté console, Vitest et
Playwright pour les tests.

**Spec:** [docs/superpowers/specs/2026-09-17-performance-lab-couts-et-analyse-design.md](../specs/2026-09-17-performance-lab-couts-et-analyse-design.md)

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du DIFF à chaque tâche.** Choisi parce que les quatre questions
du `CLAUDE.md` répondent toutes dans le même sens : la production emprunte ces chemins (un coût s'affiche à
un client et lui fait décider d'un budget) ; ce n'est PAS réversible (la rétention à 90 jours supprime des
conversations, et rien ne les ramène) ; les critères ne sont pas tous vérifiables par un test, car un
chiffre peut être plausible ET faux, et seul un œil qui connaît la campagne le voit ; et le code touché
porte des invariants invisibles (deux index partiels, deux fenêtres de 7 jours qui doivent rester la même,
et deux sources de comptage qui doivent tomber d'accord). Le lot 1, lui, est parti en direct, pour la raison
inverse : isolé, réversible, quelques fichiers, et taxer le trivial de cérémonie ferait contourner la règle.

🔴 **L'ESSAI RÉEL QUI CLÔT CE LOT, ET AUCUNE MÉTHODE NE LE REMPLACE.** Une campagne réelle avec scénario est
lancée ; quelqu'un clique et répond depuis un vrai téléphone ; puis on vérifie sur un vrai écran que **cette
personne compte pour 1 engagement**, que **son coût inclut les messages de service** qui lui ont été
envoyés, et que **le funnel node par node montre son parcours**. C'est le seul essai qui prouve que les
trois calculs parlent de la MÊME personne : chacun peut être juste isolément et désigner quelqu'un d'autre.

## Global Constraints

- **Migrations : 0154 et 0155.** La base porte 0152 (relu le 2026-09-17 dans `public.schema_migrations`).
  🔴 **0153 est RÉSERVÉ** à `0153_outil_source_kind_strict.sql`, dû sur le chantier MCP et inscrit dans
  `todo.md`. Le trou est délibéré : le runner applique par ordre de nom sans exiger que la suite soit
  continue. **Relire `schema_migrations` juste après `migrate`, jamais après avoir écrit le fichier SQL.**
- **Les deux migrations AJOUTENT ce que le code écrit, donc elles passent AVANT le déploiement.**
- **Jamais `npm run test:integration` en local** : le `DATABASE_URL` du `.env` pointe sur la PRODUCTION.
- **`git commit --only <chemins>`**, la liste construite depuis ce qu'on a touché soi-même. Les fichiers
  `AUDIT-*.md` et `docs/superpowers/plans/2026-09-10-catalogue-outils-espace.md` appartiennent à une autre
  session et doivent rester hors de chaque commit.
- **Pas de tiret cadratin** dans le code, les commentaires, les libellés ni les commits.
- **Tarifs** : message de service **2,48 cts** en France à partir du **2026-10-01**, franchise **1 000** par
  mois et par espace ; RCS non conversationnel **6 cts**, conversationnel **8 cts**. Ce sont des DÉFAUTS,
  la grille est réglable par espace.
- **Fenêtre d'attribution : 7 jours**, la même que `engagementsParCampagne`. Aucune seconde fenêtre.

---

## File Structure

**Créés**
- `db/migrations/0154_grille_prix_espace.sql` : la grille de prix par espace.
- `db/migrations/0155_analyse_jour.sql` : les agrégats journaliers anonymes.
- `src/stats/prix.ts` : la grille de prix (type, défauts, application). PUR.
- `src/stats/cout-messages.ts` : le coût total des messages, franchise comprise. PUR.
- `src/stats/rcs-conversationnel.ts` : quels RCS ont basculé. PUR.
- `src/stats/analyse-jour.pg.ts` : lecture et écriture des agrégats.
- `src/stats/analyse-jour-sweep.ts` : le balayage nocturne.
- `web/components/CarteCouts.tsx` : la carte à trois lignes dépliables.
- `web/components/FunnelNodes.tsx` : les barres verticales par node.
- `web/lib/cout-moyen.ts` : le calcul du chiffre unique. PUR.
- `web/lib/jours-analyse.ts` : le regroupement jour/semaine. PUR.
- `web/lib/qui-a-repondu.ts` : les badges, dérivés des origines. PUR.

**Modifiés**
- `src/config.ts` : `CONVERSATION_RETENTION_DAYS` passe à 90.
- `src/stats/store.pg.ts` : imputation des messages de service, comptage RCS.
- `src/stats/conversation-stats.pg.ts` : agrégat par jour, topics par intention.
- `src/http/stats.ts` : les routes de la carte et de l'écran d'analyse.
- `src/worker.ts` : la file du balayage nocturne.
- `src/queue/names.ts` : la file entre dans `BASE_QUEUES`.
- `web/app/performance/page.tsx` : la nouvelle colonne de gauche.
- `web/components/DetailCampagneModale.tsx` : refonte.
- `web/components/ConversationAnalysisCard.tsx` : ligne par jour, topics, badges.
- `web/components/NuageQualitatifCard.tsx` : le texte disparaît.
- `web/app/dashboard/quali/page.tsx` : filtre par intention depuis l'adresse.

**Supprimé**
- `web/components/CoutParCampagneCard.tsx`, remplacé par `CarteCouts.tsx`.

---

## Task 1 : la grille de prix par espace

**Files:**
- Create: `db/migrations/0154_grille_prix_espace.sql`, `src/stats/prix.ts`, `tests/prix-grille.test.ts`
- Modify: `src/settings/store.pg.ts`, `src/http/settings.ts`, `web/app/parametres/page.tsx`

**Interfaces:**
- Produces: `GrillePrix` (`{ margeTemplate: number; serviceCentimes: number; serviceFranchise: number;
  serviceDepuis: string; rcsSimpleCentimes: number; rcsConversationnelCentimes: number }`),
  `GRILLE_DEFAUT: GrillePrix`, `prixTemplate(tarifMeta: number, g: GrillePrix): number`.
- Consumes: rien.

- [ ] **Step 1 : écrire la migration**

```sql
-- 0154_grille_prix_espace.sql : ce que l'espace FACTURE, la ou Meta dit ce qu'il COUTE.
--
-- 🔴 DES PRIX DE VENTE, PAS DES COUTS, et c'est la decision qui explique la table. Le tarif des templates
-- est lu chez Meta par API ; le message de service, le RCS simple et le RCS conversationnel ne viennent
-- d'aucune API et doivent etre saisis. Les mettre en variables d'environnement aurait impose le meme tarif
-- a tous les clients et demande un deploiement pour changer un prix, alors que le tarif smsmode se negocie.
--
-- 🔴 UNE MARGE SUR LE TARIF META, PAS UNE GRILLE DE PRIX TEMPLATE. Meta change ses tarifs par pays et par
-- periode : une grille saisie a la main aurait derive en silence, en restant plausible. La marge garde Meta
-- comme source et n'a rien a resynchroniser.
--
-- ⚠️ DES DEFAUTS QUI NE CHANGENT RIEN : marge a 100, donc le prix facture EGALE le tarif Meta tant que
-- personne n'a rien regle. Un defaut qui margerait tout seul ferait bouger un chiffre deja lu par un client.
--
-- ⚠️ `service_depuis` EST UNE DATE D'EFFET, ET ELLE N'EST PAS DECORATIVE. Meta ne facture les messages de
-- service qu'a partir du 2026-10-01 : sans cette borne, rejouer une periode de septembre facturerait des
-- messages qui etaient gratuits.
--
-- 🔴 BLOQUANTE : le code lit ces colonnes des le deploiement. Elle passe AVANT (cf. CLAUDE.md).

alter table tenant_settings add column if not exists prix_marge_template     smallint not null default 100;
alter table tenant_settings add column if not exists prix_service_centimes   numeric(6,2) not null default 2.48;
alter table tenant_settings add column if not exists prix_service_franchise  integer  not null default 1000;
alter table tenant_settings add column if not exists prix_service_depuis     date     not null default date '2026-10-01';
alter table tenant_settings add column if not exists prix_rcs_centimes       numeric(6,2) not null default 6.00;
alter table tenant_settings add column if not exists prix_rcs_conv_centimes  numeric(6,2) not null default 8.00;

-- Une marge de 0 vaudrait « gratuit », une marge negative n'a aucun sens, et au-dela de 1000 % c'est une
-- faute de frappe. Le CHECK dit ces trois choses en une.
alter table tenant_settings drop constraint if exists tenant_settings_marge_chk;
alter table tenant_settings add constraint tenant_settings_marge_chk
  check (prix_marge_template between 1 and 1000);
```

- [ ] **Step 2 : appliquer et RELIRE la base**

```bash
npm run migrate
```

Puis relire `public.schema_migrations` (0154 en tête), `information_schema.columns` (les six colonnes, leurs
défauts exacts) et `pg_constraint` (le CHECK). Vérifier que chaque espace existant porte bien la marge 100 :
aucun comportement ne doit avoir bougé.

- [ ] **Step 3 : écrire le test de la grille, AVANT le module**

```ts
import { describe, it, expect } from 'vitest';
import { GRILLE_DEFAUT, prixTemplate } from '../src/stats/prix';

describe('la grille de prix', () => {
  it('🔴 marge 100 : le prix facture EGALE le tarif Meta', () => {
    // Le defaut ne doit RIEN changer. Un client qui n'a rien regle doit lire le meme chiffre qu'hier.
    expect(prixTemplate(0.0432, GRILLE_DEFAUT)).toBe(0.0432);
  });

  it('marge 150 : une fois et demie le tarif Meta', () => {
    expect(prixTemplate(0.04, { ...GRILLE_DEFAUT, margeTemplate: 150 })).toBe(0.06);
  });

  it('🔴 arrondi a quatre decimales, comme partout ailleurs dans ce fichier', () => {
    // Les ratios de `cost.ts` arrondissent a 1e-4. Un prix unitaire arrondi plus grossierement ferait
    // diverger le total d'un ecran de celui de l'autre sur un gros volume.
    expect(prixTemplate(0.0333, { ...GRILLE_DEFAUT, margeTemplate: 133 })).toBe(0.0443);
  });
});
```

- [ ] **Step 4 : lancer le test, vérifier qu'il ÉCHOUE** (`npx vitest run tests/prix-grille.test.ts`,
      attendu : `Cannot find module '../src/stats/prix'`).

- [ ] **Step 5 : écrire `src/stats/prix.ts`**

```ts
/** Ce qu'un espace FACTURE. Les tarifs Meta, eux, viennent de l'API de Meta. */
export interface GrillePrix {
  /** En POURCENT du tarif Meta. 100 = on facture le tarif Meta, ce qui est le defaut. */
  margeTemplate: number;
  /** Prix d'UN message de service, en centimes. */
  serviceCentimes: number;
  /** Messages de service offerts par mois et par espace. */
  serviceFranchise: number;
  /** Date d'effet de la facturation des messages de service (ISO 'YYYY-MM-DD'). */
  serviceDepuis: string;
  rcsSimpleCentimes: number;
  rcsConversationnelCentimes: number;
}

export const GRILLE_DEFAUT: GrillePrix = {
  margeTemplate: 100,
  serviceCentimes: 2.48,
  serviceFranchise: 1000,
  serviceDepuis: '2026-10-01',
  rcsSimpleCentimes: 6,
  rcsConversationnelCentimes: 8,
};

/**
 * Le prix FACTURE d'un template, a partir du tarif Meta.
 *
 * ⚠️ Arrondi a 1e-4 comme les ratios de `cost.ts` : deux arrondis differents feraient diverger le total de
 * la carte de celui du graphe, sur un volume ou personne ne saurait dire lequel a raison.
 */
export function prixTemplate(tarifMeta: number, g: GrillePrix): number {
  return Math.round(tarifMeta * (g.margeTemplate / 100) * 10000) / 10000;
}
```

- [ ] **Step 6 : relancer, vérifier que les trois tests passent.**

- [ ] **Step 7 : MUTER la marge** (remplacer `g.margeTemplate / 100` par `1`) et vérifier que le cas
      « marge 150 » échoue. Restaurer.

- [ ] **Step 8 : câbler la lecture et l'écriture** dans `src/settings/store.pg.ts` (la grille voyage dans
      un objet IMBRIQUÉ `prix`, jamais en six champs à plat : c'est la règle du `Pick` recopié du
      `CLAUDE.md`, et six champs se désynchronisent), puis exposer le réglage dans `web/app/parametres/page.tsx`.

- [ ] **Step 9 : commit**

```bash
git commit --only db/migrations/0154_grille_prix_espace.sql src/stats/prix.ts tests/prix-grille.test.ts src/settings/store.pg.ts src/http/settings.ts web/app/parametres/page.tsx -m "feat(couts): une grille de prix par espace, avec une marge sur le tarif Meta"
```

---

## Task 2 : quels RCS ont basculé en conversationnel

**Files:**
- Create: `src/stats/rcs-conversationnel.ts`, `tests/rcs-conversationnel.test.ts`

**Interfaces:**
- Consumes: `GrillePrix` (Task 1).
- Produces: `basculesRcs(envois: EnvoiRcs[], reactions: ReactionContact[]): Set<string>` où la clé est
  l'identifiant de l'ÉCHANGE (`conversationId`), et `EnvoiRcs = { id: string; conversationId: string;
  waId: string; at: string }`, `ReactionContact = { waId: string; at: string }`.

- [ ] **Step 1 : écrire le test**

```ts
import { describe, it, expect } from 'vitest';
import { basculesRcs } from '../src/stats/rcs-conversationnel';

const E = (id: string, conv: string, at: string) => ({ id, conversationId: conv, waId: '336', at });

describe('un RCS bascule en conversationnel quand le contact reagit', () => {
  it('🔴 sans reaction, il reste NON conversationnel', () => {
    // La regle de Julien (2026-09-17) : « si le client n'appuie sur rien, cela reste un RCS non
    // conversationnel ». C'est le cas par defaut, et le plus frequent.
    expect(basculesRcs([E('m1', 'c1', '2026-09-01T10:00:00Z')], []).size).toBe(0);
  });

  it('🔴 une reaction fait basculer TOUT l echange, pas le seul message declencheur', () => {
    // Julien : « ce qui passe dans 8 cts = le RCS initial et tous les messages qui suivent ». Deux tarifs
    // dans le meme fil auraient demande une explication a chaque lecture.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z'), E('m2', 'c1', '2026-09-01T10:05:00Z')];
    expect([...basculesRcs(envois, [{ waId: '336', at: '2026-09-01T10:02:00Z' }])]).toEqual(['c1']);
  });

  it('🔴 une reaction au-dela de SEPT JOURS ne fait rien basculer', () => {
    // Sans borne, le total de janvier bougerait encore en juillet. Sept jours est la fenetre deja utilisee
    // par `engagementsParCampagne` : une seule regle pour deux ecrans, pas deux a tenir d'accord.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    expect(basculesRcs(envois, [{ waId: '336', at: '2026-09-09T10:00:00Z' }]).size).toBe(0);
  });

  it('une reaction AVANT l envoi ne compte pas', () => {
    // Elle appartient a un echange anterieur. Sans la borne basse, tout fil actif basculerait pour toujours.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    expect(basculesRcs(envois, [{ waId: '336', at: '2026-08-30T10:00:00Z' }]).size).toBe(0);
  });

  it('⚠️ la reaction d un AUTRE contact ne fait pas basculer cet echange', () => {
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    expect(basculesRcs(envois, [{ waId: '337', at: '2026-09-01T10:02:00Z' }]).size).toBe(0);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec** (module absent).

- [ ] **Step 3 : implémenter `src/stats/rcs-conversationnel.ts`**

```ts
/** La fenetre de bascule. LA MEME que celle des engagements : cf. `engagementsParCampagne`. */
export const FENETRE_BASCULE_MS = 7 * 24 * 60 * 60 * 1000;

export interface EnvoiRcs { id: string; conversationId: string; waId: string; at: string }
export interface ReactionContact { waId: string; at: string }

/**
 * Les ECHANGES RCS devenus conversationnels : ceux dont le contact a reagi dans les sept jours suivant un
 * envoi. Rend des identifiants de conversation, pas de message, parce que la bascule porte sur l'echange
 * entier (decision de Julien du 2026-09-17).
 */
export function basculesRcs(envois: EnvoiRcs[], reactions: ReactionContact[]): Set<string> {
  const parContact = new Map<string, number[]>();
  for (const r of reactions) {
    const l = parContact.get(r.waId) ?? [];
    l.push(Date.parse(r.at));
    parContact.set(r.waId, l);
  }
  const bascules = new Set<string>();
  for (const e of envois) {
    const t = Date.parse(e.at);
    const reacts = parContact.get(e.waId) ?? [];
    if (reacts.some((r) => r >= t && r < t + FENETRE_BASCULE_MS)) bascules.add(e.conversationId);
  }
  return bascules;
}
```

- [ ] **Step 4 : relancer, les cinq tests passent.**

- [ ] **Step 5 : MUTER la borne haute** (retirer `&& r < t + FENETRE_BASCULE_MS`) : le test des sept jours
      doit échouer. Puis **muter la borne basse** (retirer `r >= t`) : le test « avant l'envoi » doit
      échouer. Restaurer après chaque.

- [ ] **Step 6 : commit.**

---

## Task 3 : le coût total des messages, franchise comprise

**Files:**
- Create: `src/stats/cout-messages.ts`, `tests/cout-messages.test.ts`
- Modify: `src/stats/store.pg.ts` (le comptage RCS et des services par mois)

**Interfaces:**
- Consumes: `GrillePrix`, `prixTemplate`, `basculesRcs`.
- Produces: `coutMessages(entree, grille): CoutMessages` avec
  `CoutMessages = { templates: { marketing: number; utility: number }; service: { envoyes: number;
  franchiseMois: { consommes: number; plafond: number }; factures: number; cout: number };
  rcs: { simple: number; conversationnel: number; cout: number }; total: number }`.

- [ ] **Step 1 : écrire les tests**

```ts
import { describe, it, expect } from 'vitest';
import { GRILLE_DEFAUT } from '../src/stats/prix';
import { coutMessages } from '../src/stats/cout-messages';

const BASE = {
  templates: [{ category: 'marketing' as const, count: 100 }],
  rates: { marketing: 0.04, utility: 0.01, currency: 'EUR' },
  serviceDeLaPeriode: 300,
  serviceDuMois: 300,
  rcsSimple: 0,
  rcsConversationnel: 0,
  moisEnCours: '2026-11',
};

describe('le cout total des messages', () => {
  it('🔴 sous la franchise, AUCUN message de service n est facture', () => {
    const r = coutMessages(BASE, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(0);
    expect(r.service.cout).toBe(0);
    // Mais ils sont COMPTES : « 300 envoyes » et « 0 facture » ne disent pas la meme chose.
    expect(r.service.envoyes).toBe(300);
    expect(r.service.franchiseMois).toEqual({ consommes: 300, plafond: 1000 });
  });

  it('🔴 au-dela, seul le DEPASSEMENT est facture', () => {
    const r = coutMessages({ ...BASE, serviceDeLaPeriode: 400, serviceDuMois: 1200 }, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(200);
    expect(r.service.cout).toBe(Math.round(200 * 2.48) / 100);
  });

  it('🔴 LA FRANCHISE EST CELLE DU MOIS, PAS DE LA PERIODE, et c est tout l interet du champ a part', () => {
    // Une periode de 7 jours au sein d'un mois deja a 1200 doit facturer ses 400 messages, pas zero.
    // Proratiser la franchise sur sept jours aurait produit un nombre invente, sur lequel un client
    // construit un budget.
    const r = coutMessages({ ...BASE, serviceDeLaPeriode: 400, serviceDuMois: 1600 }, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(400);
  });

  it('🔴 AVANT la date d effet, un message de service est GRATUIT', () => {
    // Meta ne les facture qu'a partir du 2026-10-01. Rejouer septembre doit rendre zero, sans quoi on
    // facturerait retroactivement des messages qui etaient offerts.
    const r = coutMessages({ ...BASE, moisEnCours: '2026-09', serviceDuMois: 5000 }, GRILLE_DEFAUT);
    expect(r.service.factures).toBe(0);
    expect(r.service.cout).toBe(0);
  });

  it('🔴 le RCS conversationnel est plus cher, et les deux se comptent separement', () => {
    const r = coutMessages({ ...BASE, rcsSimple: 10, rcsConversationnel: 5 }, GRILLE_DEFAUT);
    expect(r.rcs.cout).toBe(Math.round(10 * 6 + 5 * 8) / 100);
  });

  it('🔴 le template suit la MARGE de l espace', () => {
    const r = coutMessages(BASE, { ...GRILLE_DEFAUT, margeTemplate: 200 });
    expect(r.templates.marketing).toBe(8); // 100 x 0,04 x 2
  });

  it('⚠️ un tarif Meta ABSENT ne produit AUCUN cout, il ne vaut pas zero', () => {
    // Meme regle que `chiffrer` dans cost.ts : une categorie sans tarif se compte a part, elle ne
    // s'additionne pas comme si elle etait gratuite.
    const r = coutMessages({ ...BASE, rates: { marketing: null, utility: null, currency: null } }, GRILLE_DEFAUT);
    expect(r.templates.marketing).toBe(0);
    expect(r.total).toBe(0);
  });
});
```

- [ ] **Step 2 : lancer, vérifier l'échec.**
- [ ] **Step 3 : implémenter `coutMessages`**, en réutilisant `chiffrer` de `src/stats/cost.ts` pour la
      règle « chiffrable ou non » (une seconde définition donnerait deux totaux sur deux écrans).
- [ ] **Step 4 : relancer, les sept tests passent.**
- [ ] **Step 5 : MUTER la franchise** (`Math.max(0, mois - plafond)` devient `mois`) : le premier test doit
      échouer. **MUTER la date d'effet** : le quatrième doit échouer. Restaurer.
- [ ] **Step 6 : câbler les comptages** dans `src/stats/store.pg.ts` : les messages de service du MOIS
      (pas seulement de la période) et les RCS par échange. ⚠️ Réutiliser mot pour mot le filtre de service
      existant (sortant, WhatsApp, hors template, hors fil de test) : il a déjà DEUX consommateurs qui
      doivent rester d'accord, celui-ci est le troisième.
- [ ] **Step 7 : commit.**

---

## Task 4 : le coût moyen par engagement, messages de service inclus

**Files:**
- Create: `web/lib/cout-moyen.ts`, `web/lib/cout-moyen.test.ts`
- Modify: `src/stats/store.pg.ts` (imputation des services aux campagnes), `src/stats/cost.ts`

**Interfaces:**
- Produces: `coutMoyenParEngagement(lignes: LigneCoutCampagne[]): { valeur: number | null; campagnes: number;
  ecartees: number }`.

- [ ] **Step 1 : écrire les tests**

```ts
import { describe, it, expect } from 'vitest';
import { coutMoyenParEngagement } from './cout-moyen';

const L = (cout: number | null, engagements: number | null) => ({ cout, engagements });

describe('le chiffre unique de la carte Couts', () => {
  it('🔴 c est le COUT TOTAL divise par les ENGAGES TOTAUX, pas la moyenne des ratios', () => {
    // Decision de Julien du 2026-09-17. Campagne A : 5000 envois, 10 000 euros, 5000 engages (2 euros).
    // Campagne B : 10 envois, 400 euros, 10 engages (40 euros). Le bon chiffre est 2,08, pas 21.
    // La moyenne des ratios ferait peser un essai a 10 envois autant qu'une campagne a 5000.
    const r = coutMoyenParEngagement([L(10000, 5000), L(400, 10)]);
    expect(r.valeur).toBe(2.0759);
  });

  it('🔴 une campagne SANS cout chiffrable sort des DEUX termes, et se compte a part', () => {
    // La garder au denominateur ferait baisser le cout moyen d'une campagne dont on ignore le prix, ce qui
    // est pire que de ne pas la compter : le chiffre baisserait sans qu'aucun euro ne soit economise.
    const r = coutMoyenParEngagement([L(100, 50), L(null, 30)]);
    expect(r.valeur).toBe(2);
    expect(r.ecartees).toBe(1);
    expect(r.campagnes).toBe(1);
  });

  it('🔴 une campagne sans AUCUN engage sort aussi, elle ne vaut pas une division par zero', () => {
    const r = coutMoyenParEngagement([L(100, 50), L(80, 0)]);
    expect(r.valeur).toBe(2);
    expect(r.ecartees).toBe(1);
  });

  it('🔴 aucune campagne chiffrable : `null`, jamais zero', () => {
    // Un « 0 euro par engage » se lirait « c est gratuit ». La carte doit dire qu'elle ne sait pas.
    expect(coutMoyenParEngagement([L(null, 10)]).valeur).toBeNull();
    expect(coutMoyenParEngagement([]).valeur).toBeNull();
  });
});
```

- [ ] **Step 2 : lancer, échec attendu. Step 3 : implémenter. Step 4 : relancer, vert.**
- [ ] **Step 5 : MUTER** en moyenne des ratios : le premier test doit échouer avec 21 contre 2,0759.
- [ ] **Step 6 : imputer les messages de service aux campagnes** dans `src/stats/store.pg.ts`, avec la
      MÊME requête de fenêtre que `engagementsParCampagne` (7 jours après l'envoi reçu par le contact).
      ⚠️ Vérifier que la requête reste dans les prédicats de `conversation_messages_unread_idx` et de
      `conversations_contact_idx` : en sortir ne produit aucune erreur, seulement un balayage des deux
      tables les plus écrites du produit.
- [ ] **Step 7 : commit.**

---

## Task 5 : la carte « Coûts » à trois lignes

**Files:**
- Create: `web/components/CarteCouts.tsx`
- Modify: `web/app/performance/page.tsx`
- Delete: `web/components/CoutParCampagneCard.tsx`
- Test: `web/e2e/performance-cout.spec.ts` (réécrit)

- [ ] **Step 1** : la carte porte trois lignes dépliables, chacune avec son chiffre et rien d'autre.
      Ligne 1 : coût moyen par engagement. Ligne 2 : coût total des messages. Ligne 3 : coût total IA.
- [ ] **Step 2** : l'accordéon de la ligne 1 liste les campagnes en quatre colonnes (nom, envoyés,
      engagés, coût par engagé), triées par coût décroissant, plafonnées à `PLAFOND_CAMPAGNES_SYNTHESE`
      avec la phrase de troncature conservée.
- [ ] **Step 3** : la ligne 2 dépliée montre les quatre postes, et sur une ligne DISTINCTE
      « franchise du mois : X / 1000 consommés ».
- [ ] **Step 4** : la ligne 3 dépliée montre les tours d'agent avec leurs tokens. Quand il n'y en a
      aucun, elle dit « aucune consommation sur la période », jamais un tiret.
- [ ] **Step 5** : la ligne 2 porte un lien vers `/dashboard/couts` pour l'écart estimation / facture.
- [ ] **Step 6** : ⚠️ garder la garde de `CoutParCampagneCard` qui a déjà servi : si la réponse n'est pas
      la forme attendue, la carte affiche une erreur au lieu de jeter en plein rendu et d'emporter la
      colonne de droite avec elle.
- [ ] **Step 7** : réécrire `performance-cout.spec.ts` en CONSERVANT les cas exercés (troncature, absence
      de tarif, cases vides) et commit.

---

## Task 6 : la fiche de campagne refondue

**Files:**
- Create: `web/components/FunnelNodes.tsx`
- Modify: `web/components/DetailCampagneModale.tsx`
- Test: `web/e2e/performance-detail-campagne.spec.ts`

- [ ] **Step 1** : en tête, ce qui a été envoyé (template seul, ou template plus scénario, nommés).
- [ ] **Step 2** : le funnel de la campagne en barres verticales (envoyés, délivrés, lus, répondus, échecs).
- [ ] **Step 3** : `FunnelNodes` rend une barre verticale par node et par nature, dans l'ordre du graphe,
      en comptant des **personnes** (`EtapeCoutCampagne.*.personnes`).
- [ ] **Step 4** : 🔴 la barre des clics sur liens compte des GESTES et le DIT, parce que
      `EtapeCoutCampagne.liens` n'a pas de compte de personnes et n'en aura jamais (les clics s'agrègent par
      code de lien). Afficher un nombre de personnes y serait une invention.
- [ ] **Step 5** : les réserves de l'ancienne carte (template approuvé avant le 2026-09-02, partage de
      compteur entre deux campagnes) descendent ICI, où elles ont leur place.
- [ ] **Step 6** : commit.

---

## Task 7 : la colonne de droite, et l'écran d'analyse

**Files:**
- Create: `web/lib/jours-analyse.ts`, `web/lib/qui-a-repondu.ts`, avec leurs tests
- Modify: `web/components/ConversationAnalysisCard.tsx`, `web/components/NuageQualitatifCard.tsx`,
  `web/app/dashboard/quali/page.tsx`, `src/stats/conversation-stats.pg.ts`, `src/http/stats.ts`

- [ ] **Step 1** : la colonne de droite de `/performance` porte les intentions en barres horizontales,
      chaque barre dépliant ses **topics** classés par fréquence.
- [ ] **Step 2** : la matrice perd TOUT son texte. 🔴 Risque accepté et inscrit au cadrage : elle repose
      sur 2 analyses sur 14, et rien à l'écran ne le dira plus.
- [ ] **Step 3** : cliquer une intention ouvre `/dashboard/quali?intention=<clé>&from=…&to=…`.
- [ ] **Step 4** : `jours-analyse.ts` regroupe par jour, **masque les jours vides**, et bascule en
      **semaines au-delà de 90 jours** de période. L'écran AFFICHE la granularité courante et porte un
      bascule jour/semaine manuel : une granularité qui change toute seule sans le dire empêche de comparer
      deux captures de la même page.
- [ ] **Step 5** : `qui-a-repondu.ts` dérive les badges des ORIGINES des messages sortants du fil
      (`scenario` → Scripté, `humain` → Humain, `mba` → MBA, `ia` → Agent IA). 🔴 **PAS depuis
      `conversation_analysis.handled_by`**, qui ne rend que `humain` ou `automatise` et ne distingue ni le
      scénario, ni le MBA, ni l'agent IA : mesuré en base, zéro ligne ne porte `mba`.
- [ ] **Step 6** : les badges sont en LECTURE SEULE et cliquables (ils montrent la partie de conversation
      concernée), jamais des cases à cocher : un utilisateur qui décocherait ferait mentir les compteurs.
- [ ] **Step 7** : tests des deux modules purs, mutation de chacun, puis commit.

---

## Task 8 : la rétention à 90 jours et les agrégats

**Files:**
- Create: `db/migrations/0155_analyse_jour.sql`, `src/stats/analyse-jour.pg.ts`,
  `src/stats/analyse-jour-sweep.ts`, `tests/analyse-jour.test.ts`
- Modify: `src/config.ts`, `src/worker.ts`, `src/queue/names.ts`

- [ ] **Step 1 : écrire la migration 0155**, une ligne par jour et par espace portant le nombre de
      conversations, les moyennes de satisfaction et d'urgence, la répartition des intentions et celle de
      qui a répondu. 🔴 **AUCUNE donnée personnelle** : ni numéro, ni texte, ni résumé. C'est ce qui permet
      de la garder quand le contenu part.
- [ ] **Step 2 : appliquer et RELIRE la base** (`schema_migrations`, `information_schema`, `pg_indexes`).
- [ ] **Step 3 : `CONVERSATION_RETENTION_DAYS` passe de 365 à 90**, et devient réglable par espace. Le
      commentaire de `src/config.ts` doit dire que 90 est une DÉCISION (le RGPD ne fixe aucune durée) et
      que le stockage n'y entre pas (31 Mo mesurés le 2026-09-17).
- [ ] **Step 4 : le balayage nocturne** écrit la veille. Il entre dans `BASE_QUEUES`
      (`src/queue/names.ts`), faute de quoi il serait invisible de `/ops` et sa DLQ ne serait surveillée
      par personne.
- [ ] **Step 5 : 🔴 LE TEST QUI COMPTE, ET IL EST LA CONTREPARTIE DU CHOIX DE JULIEN.** Les vraies données
      font foi sous 90 jours, les agrégats au-delà : deux sources répondent donc à la même question. Elles
      doivent passer par LA MÊME fonction de calcul, et un test doit prouver qu'elles tombent d'accord sur
      un jour donné. Sans lui, la frontière des 90 jours fera une marche dans le graphe, indiscernable d'un
      vrai creux d'activité.
- [ ] **Step 6 : le résumé en champ système du CRM.** 🔴 **DÉRIVÉ À LA LECTURE, pas recopié dans
      `contacts.fields`** : recopier créerait une seconde vérité à côté de `conversation_analysis.summary`,
      et le jour où les deux divergent c'est la copie, périmée, que la fiche afficherait. Il porte le
      résumé de la DERNIÈRE conversation analysée, avec sa date, et n'est ni renommable ni modifiable.
- [ ] **Step 7 : commit.**

---

## L'essai réel qui clôt le lot

🔴 **AUCUN TEST NE LE REMPLACE, ET LE PLAN NE SE DÉCLARE PAS FINI SANS LUI.** Une campagne réelle avec
scénario est lancée ; quelqu'un clique et répond depuis un vrai téléphone ; puis on vérifie sur l'écran que
**cette personne compte pour 1 engagement**, que **son coût inclut les messages de service** qui lui ont été
envoyés, et que **le funnel node par node montre son parcours**. C'est le seul essai qui prouve que les
trois calculs parlent de la même personne : chacun peut être juste isolément et désigner quelqu'un d'autre.

## Après le lot

- `/revue-finale` sur l'intervalle complet, avant tout déploiement.
- `/sync` : `wip.md` se vide vers `features.md`, et le récit part dans `docs/JOURNAL-TECHNIQUE.md`.
- 🔴 **Le compteur de migrations du `CLAUDE.md` se met à jour APRÈS `migrate`, relu en base.** Il a dérivé
  huit fois, toujours pour avoir été écrit au moment où l'on écrivait le fichier SQL.
