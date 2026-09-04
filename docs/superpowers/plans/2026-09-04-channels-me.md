# Chaîne WhatsApp (Channels Me) : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Publier sur une chaîne WhatsApp depuis Engage Me, en rattachant au post un bouton qui démarre un
scénario conversationnel.

**Architecture:** Un sous-système autonome `src/channels-me/` (signeur HMAC, client HTTP, trois stores)
alimente un module de routes unique `src/http/channels-me.ts`. Le déclenchement du scénario ne crée AUCUN
moteur : il réutilise l'automation `keyword` en mode `contains` déjà présente, sur un jeton caché transporté
par le paramètre `text=` d'un lien `wa.me` inséré dans le texte du post. Le front ajoute une section
« Chaîne » à la console.

**Tech Stack:** TypeScript, Fastify, Next.js (App Router, Tailwind), Postgres (pooler Supabase), vitest,
Zod, AES-256-GCM (`src/crypto/secretbox.ts`).

**Spec:** [docs/superpowers/specs/2026-09-04-channels-me-design.md](../specs/2026-09-04-channels-me-design.md)

## Global Constraints

Ces contraintes s'appliquent à TOUTES les tâches, implicitement. Valeurs recopiées telles quelles du spec.

- **Isolation tenant.** Filtrage `tenant_id` sur CHAQUE requête SQL. Le pooler est un rôle superuser, la RLS
  est contournée, le filtrage en code est le SEUL contrôle.
- **Secrets.** Chiffrés au repos par `encryptSecret` (`src/crypto/secretbox.ts`), chiffrés **dans le store**,
  jamais plus haut. Jamais exposés par l'API (seulement des booléens `hasApiKey` / `hasSecret`). Jamais dans
  le bundle `web/` ni en `NEXT_PUBLIC_*`.
- **Validation.** `safeParse` de Zod sur toute entrée externe. Jamais `parse`, jamais `as`.
- **Codes d'erreur.** Toute erreur destinée à l'utilisateur sort en **4xx**, jamais 5xx : Cloudflare remplace
  le corps de toute réponse 5xx par sa propre page.
- **Corps distant.** Le corps de réponse de Channels Me ne se relaie JAMAIS tel quel, ni au client ni dans un
  journal. On garde le code de statut et, si la réponse est du JSON valide, le seul `error.message` tronqué.
- **Nommage.** Préfixe `channelsme_` sur les tables, `channelsMe` sur les symboles, `/channels-me/` sur les
  routes. **Jamais `channel` seul** : le mot désigne déjà le tuyau (`whatsapp` ou `rcs`) dans ce dépôt.
- **Le jeton n'est jamais journalisé.**
- **Pas de tirets longs** (ni cadratin, ni demi-cadratin) dans le code, les commentaires ou la doc. Virgule,
  deux-points, parenthèses ou point.
- **Tests.** Un test de `tests/` ne touche NI base NI réseau. Un test qui a besoin de Postgres va dans
  `tests/integration/` et **ne se lance qu'en CI** : le `DATABASE_URL` local pointe sur la PRODUCTION, donc
  on ne lance jamais `npm run test:integration` ni `npm run migrate` en local.
- **Git.** Rester sur `main`, committer sur `main`, pousser sur `origin`.

## Faits mesurés qui gouvernent l'implémentation

À ne pas re-deviner, chacun a été vérifié contre l'API réelle (spec §2).

1. **Aucun champ d'API ne contrôle le bouton.** WhatsApp le dessine à partir d'une URL `wa.me` présente dans
   le texte. Son libellé n'est pas modifiable. Le paramètre `text=` n'est pas le libellé : c'est le message
   que l'abonné ENVOIE, donc le seul endroit où loger le jeton.
2. **La signature porte sur la structure IMBRIQUÉE**, d'où l'obligation d'un tri alphabétique en profondeur.
3. **L'encodage du corps est indifférent** (form, JSON et multipart passent tous), donc on envoie du
   `application/json` et le multipart sort du sujet.
4. **`Accept: application/json` est obligatoire**, sinon l'API rend une page HTML d'erreur en 500.
5. **Les listes ne paginent pas**, l'enveloppe est `{data: ...}`.
6. 🔴 **L'hôte est `https://channels-me.com/api/v1` et l'authentification est `Authorization: Bearer <clé>`.**
   Ces deux valeurs sont mesurées (spec OpenAPI du fournisseur, plus un appel réel ayant rendu 200), et elles
   sont figées par des tests dans `tests/channels-me-client.test.ts`.
   ⚠️ **Ce plan a d'abord porté deux valeurs FAUSSES ici** (`https://api.channels.me/v1` et un en-tête
   `X-Api-Key`), inventées par son rédacteur et marquées « à confirmer ». Elles sont parties dans le code
   avant d'être rattrapées. La leçon vaut au-delà de ce lot : **marquer une valeur « à confirmer » ne la fait
   pas confirmer**, le marqueur voyage avec la valeur fausse et finit par lui donner l'air d'un choix. Une
   valeur qu'on ne sait pas se mesure avant d'écrire le plan, ou ne s'écrit pas.

## Structure des fichiers

**Backend, créés**

| Fichier | Responsabilité unique |
|---|---|
| `db/migrations/0114_channelsme.sql` | les trois tables, plus deux colonnes additives sur `automations` |
| `src/lib/wa-me.ts` | construire un lien `wa.me`, seul et unique constructeur du dépôt |
| `src/channels-me/signature.ts` | JSON canonique trié en profondeur, et sa signature HMAC |
| `src/channels-me/jeton.ts` | tirer un jeton, le reconnaître, composer le texte pré-rempli |
| `src/channels-me/types.ts` | schémas Zod et types des réponses distantes |
| `src/channels-me/client.ts` | les quatre appels à l'API Channels Me |
| `src/channels-me/connection-store.pg.ts` | les creds chiffrés, par tenant |
| `src/channels-me/link-store.pg.ts` | les liens de chaîne |
| `src/channels-me/post-store.pg.ts` | la trace fine des publications |
| `src/http/channels-me.ts` | les neuf routes |

**Backend, modifiés**

| Fichier | Ce qui change, et pourquoi c'est du rayon de souffle |
|---|---|
| `src/workflow/test-token.ts` | `waMeTestLink` délègue à `lienWaMe`, au lieu de porter sa propre copie |
| `src/automation/match.ts` | `AutomationRow` gagne `maxFiresPerHour` |
| `src/automation/store.pg.ts` | `HORS_WEBHOOK` gagne `possede_par is null`, et la chaîne `COLS` + `toRow` + `create` suit la nouvelle colonne |
| `src/automation/runner.ts` | le plafond devient `a.maxFiresPerHour ?? deps.maxFiresPerHour` |
| `src/server.ts` | `deps.channelsMe` entre dans `modulesTenant` (36 modules aujourd'hui) |
| `src/index.ts` | câblage du module et de ses stores |
| `tests/scope-tenant.test.ts` | garde la liste complète des modules à routes `:tenantId` |

**Front, créés :** `web/app/chaine/page.tsx`, `web/lib/api-chaine.ts`, et les composants
`ChaineConnexion.tsx`, `ChaineComposeur.tsx`, `ChaineApercu.tsx`, `ChainePublications.tsx`.
**Front, modifié :** `web/components/AppShell.tsx` (entrée de navigation).

## Ordre des tâches, et pourquoi

Les tâches 1 à 8 sont le backend, dans l'ordre des dépendances : le schéma, puis les modules purs
(testables sans rien), puis les stores, puis le moteur, puis les routes qui assemblent tout. Les tâches 9 à
11 sont le front, qui ne peut être écrit qu'une fois les routes figées, sous peine de retomber dans le
défaut du lot précédent (un front qui appelle des chemins inexistants).

La tâche 7 est la plus risquée : c'est la seule qui touche du code chaud existant, et elle porte trois
changements en chaîne. Elle mérite la relecture la plus attentive.

## 🔴 Propriété des fichiers partagés (arbitrage, fait autorité)

Plusieurs tâches ont été rédigées en parallèle, et certaines revendiquent des fichiers qui ne leur
appartiennent pas. **Ce tableau tranche, et il l'emporte sur tout bloc `Files:` d'une tâche qui le
contredirait.** Une tâche ne modifie JAMAIS un fichier dont elle n'est pas propriétaire : elle s'appuie sur
ce que la tâche propriétaire a déjà produit.

| Fichier partagé | Propriétaire unique | Ce que les autres tâches font |
|---|---|---|
| `src/automation/match.ts` | **Tâche 7** | T1 ne pose QUE le SQL. T4 ne fait qu'importer `normalizeText`, en lecture, sans rien modifier. |
| `src/automation/store.pg.ts` | **Tâche 7** | T1 et T8 n'y touchent pas. La chaîne `COLS`, `toRow`, `create` et `HORS_WEBHOOK` est un tout, et elle se change d'un seul geste. |
| `src/automation/runner.ts` | **Tâche 7** | T1 n'y touche pas. |
| Les tests d'automation existants (`tests/automation-*.test.ts`, `tests/http-automations.test.ts`, `tests/http-hubspot-events.test.ts`) | **Tâche 7** | Ils cassent au moment où `AutomationRow` gagne son champ, donc ils se réparent dans la tâche qui l'ajoute, pas ailleurs. |
| `src/server.ts` et `tests/scope-tenant.test.ts` | **Tâche 8** | T5 et T6 n'y touchent pas. L'inscription du module dans `modulesTenant` se fait une seule fois, quand le module existe. |
| `src/index.ts` | **Tâche 8** | T6 n'y touche pas : les stores sont instanciés au câblage, avec le module de routes. |
| `web/components/AppShell.tsx` | **Tâche 11** | T9 n'y touche pas : l'entrée de navigation s'ajoute quand la section est complète. |
| `web/app/chaine/page.tsx` | **Tâche 9** le crée, **T10 et T11** y branchent leurs composants | Chacune ajoute son bloc, aucune ne réécrit la page. |

**Correction de chemin.** La tâche 11 mentionne `web/lib/api/channels-me.ts`. Ce chemin **n'existe pas**.
Le seul module d'appel est `web/lib/api-chaine.ts` (créé par la tâche 9), et c'est celui-là qu'on importe.

## 🔴 Correction du contrat gelé : le propriétaire écrit ses propres requêtes

Un défaut de conception a été trouvé pendant la rédaction de ce plan, et le contrat gelé est corrigé ici.

Le prédicat de possession (`and possede_par is null`) est porté par `update` (`src/automation/store.pg.ts`
ligne 142) et `remove` (ligne 150), **pas seulement par les lectures**. Une fois l'automation compagnon
possédée, `PgAutomationStore` ne peut donc plus la modifier du tout, **y compris pour l'allumer**. Or le spec
(section 4.1) exige de l'allumer au moment où la publication réussit. Les deux décisions se contredisaient.

La résolution est celle que les webhooks appliquent déjà : le propriétaire écrit ses propres requêtes.
`PgChannelsMeLinkStore` gagne deux méthodes, à ajouter au contrat gelé de la **tâche 6**, et que la
**tâche 8** appelle :

```ts
allumerAutomation(tenantId: string, linkId: string): Promise<void>
eteindreAutomation(tenantId: string, linkId: string): Promise<void>
```

Chacune écrit son propre `update automations set enabled = ...`, bornée par le `tenant_id` **et** par
`possede_par = 'channelsme_link'`. Cette seconde clause est une **garde miroir** : elle interdit au store des
liens de toucher une automation qui ne lui appartient pas, comme le prédicat interdit à l'écran Automation de
toucher les siennes. Les deux gardes se répondent, et c'est ce qui rend la frontière étanche dans les deux
sens. La tâche 6 doit porter un test qui prouve qu'un `allumerAutomation` visant une automation
`possede_par is null` ne modifie **aucune** ligne.

**Découpage de la tâche 1.** Elle a été rédigée en absorbant le travail de la tâche 7. Elle se limite à :
le fichier `db/migrations/0114_channelsme.sql`, et le test `tests/channels-me-migration.test.ts` **réduit
à ses assertions sur le SQL** (les tables, l'absence de colonne `enabled`, l'unicité globale du jeton,
l'absence de directive hors transaction, le caractère additif des deux `alter table`). Ses assertions sur
`COLS`, `toRow` et `HORS_WEBHOOK` appartiennent à la tâche 7 et s'écrivent là-bas.

---

## Les tâches

### Task 1: Migration 0114 et colonnes additives sur automations

**Files:**
- Create : `db/migrations/0114_channelsme.sql`
- Test (create) : `tests/channels-me-migration.test.ts` (unitaire, ne touche NI base NI reseau : il lit des fichiers)
- Test (create) : `tests/integration/channels-me-schema.integration.test.ts` (Postgres, CI seulement)
- Modify : `src/automation/match.ts` (`AutomationRow` gagne `maxFiresPerHour`)
- Modify : `src/automation/store.pg.ts` (`Raw`, `toRow`, `COLS`, `HORS_WEBHOOK`, `AutomationInput`, l'insert de `create`)
- Modify : `src/automation/runner.ts` (le plafond de l'automation l'emporte sur le plafond global)
- Test (modify) : `tests/automation-runner.test.ts` (4 cas neufs + fabrique `auto`)
- Test (modify) : `tests/http-automations.test.ts` (1 cas neuf + 2 litteraux `AutomationRow`)
- Test (modify) : `tests/automation-match.test.ts`, `tests/automation-webhook.test.ts`, `tests/automation-date-sweep.test.ts`, `tests/http-hubspot-events.test.ts` (litteraux `AutomationRow`)
- Test (modify) : `tests/integration/automation-webhook-ownership.integration.test.ts` (bloc « possession generique »)
- Modify : `CLAUDE.md` (le compteur de migrations, seule source), `documentation.md` (section « LES MIGRATIONS, UNE PAR UNE »)

**Interfaces:**

- **Consumes** (existant du depot, rien d'une tache precedente : c'est la premiere) :
  - `veutHorsTransaction(sql: string): boolean` depuis `src/db/migration-directives` (utilise par le test).
  - `PgAutomationStore` (`src/automation/store.pg.ts`) : `list`, `listEnabled`, `getById`, `update`, `remove`, `create`.
  - `AutomationRow` (`src/automation/match.ts`), `AutomationInput` (`src/automation/store.pg.ts`).
  - `runAutomations(tenantId, ev, deps)` et `AutomationRunnerDeps` (`src/automation/runner.ts`).
  - `pgSsl()` (`src/db/ssl`) pour le pool du test d'integration.
  - ⚠️ `encryptSecret` / `decryptSecret` ne sont PAS utilises ici : aucun secret n'est ecrit par cette tache, les colonnes `api_key_enc` / `secret_enc` sont posees vides pour la tache du store.

- **Produces** (ce que les taches suivantes utilisent, signatures exactes) :
  - Tables : `channelsme_connections (tenant_id pk, org_id, channel_id, api_key_enc, secret_enc, verified_at, created_at, updated_at)`, `channelsme_links (id, tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure, created_at)`, `channelsme_posts (id, tenant_id, cm_message_id, link_id, created_at)`.
  - Index : `channelsme_links_token_key` (unique GLOBAL sur `token`), `channelsme_links_tenant_idx`, `channelsme_posts_tenant_idx`, `channelsme_posts_msg_key` (unique `(tenant_id, cm_message_id)`).
  - Colonnes additives : `automations.possede_par text` et `automations.max_fires_per_hour integer`.
  - `AutomationRow.maxFiresPerHour: number | null` (requis, `null` = plafond global de l'instance).
  - `AutomationInput.possedePar?: string | null` et `AutomationInput.maxFiresPerHour?: number | null`, ecrits par `create(tenantId, input)` uniquement.
  - Le predicat `HORS_WEBHOOK = "and trigger_kind <> 'webhook' and possede_par is null"`, pose sur `list`, `getById`, `update`, `remove`, et sur AUCUNE requete du chemin chaud.
  - La regle du runner : `const plafond = a.maxFiresPerHour ?? deps.maxFiresPerHour;`.
  - Valeur conventionnelle de possession pour la suite : `possede_par = 'channelsme_link'`.

---

- [ ] **Step 1: ecrire le test unitaire de la migration et de ses lecteurs (il doit echouer)**

Ce test est le filet du rayon de souffle numero 2 du contrat : `COLS` est une liste tenue a la main, et une colonne ajoutee en base que personne n'ajoute a `COLS` n'existe pour aucun lecteur, sans une seule erreur.

Creer `tests/channels-me-migration.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { veutHorsTransaction } from '../src/db/migration-directives';

/**
 * La migration 0114 et ses lecteurs dans le code des automations.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. `COLS` est une liste de colonnes tenue A LA MAIN. `max_fires_per_hour` peut exister en base sans
 *     qu'aucun lecteur ne la voie : le plafond propre au lien de chaine serait alors ignore, et rien,
 *     ni le compilateur ni un test d'integration, ne le dirait.
 *  2. `possede_par` est l'inverse : il n'est JAMAIS lu, il ne sert qu'au predicat qui met une automation
 *     possedee hors de portee de l'ecran Automation. L'entrer dans `COLS` ferait croire qu'on l'affiche.
 *  3. Le predicat doit rester pose sur les QUATRE requetes de pilotage et sur aucune du chemin chaud :
 *     le poser sur `listEnabled` rendrait muet le bouton d'un post deja publie, ce qui est l'inverse du but.
 *  4. La migration est transactionnelle ordinaire. La directive hors transaction retire le filet, on ne la
 *     pose que pour `CREATE INDEX CONCURRENTLY`, qui n'est pas ici.
 */
const migration = readFileSync(new URL('../db/migrations/0114_channelsme.sql', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/automation/store.pg.ts', import.meta.url), 'utf8');
const match = readFileSync(new URL('../src/automation/match.ts', import.meta.url), 'utf8');

describe('migration 0114 : les trois tables Channels Me', () => {
  it('cree exactement les trois tables attendues, toutes prefixees `channelsme_`', () => {
    const tables = [...migration.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]!);
    // Le prefixe n'est pas cosmetique : `channel` designe deja le tuyau (whatsapp | rcs) dans ce depot.
    expect(tables).toEqual(['channelsme_connections', 'channelsme_links', 'channelsme_posts']);
  });

  it('🔴 le lien n a PAS de colonne `enabled` : son etat EST celui de son automation', () => {
    const bloc = migration.slice(
      migration.indexOf('create table if not exists channelsme_links'),
      migration.indexOf('create table if not exists channelsme_posts'),
    );
    // Deux copies du meme etat divergeraient au premier chemin qui n'en ecrit qu'une.
    expect(bloc).not.toContain('enabled');
    expect(bloc).toContain('automation_id');
  });

  it('🔴 le jeton est unique GLOBALEMENT, pas par tenant', () => {
    // Il circule dans des messages publics et il est cherche sur le chemin chaud, ou le tenant est deduit du
    // NUMERO et pas du jeton : deux tenants portant le meme jeton feraient partir le mauvais scenario.
    expect(migration).toContain(
      'create unique index if not exists channelsme_links_token_key on channelsme_links (token)',
    );
  });

  it('🔴 transactionnelle ordinaire : aucune directive, donc aucune migration sans filet', () => {
    expect(veutHorsTransaction(migration)).toBe(false);
    // La directive n'existe que pour `CREATE INDEX CONCURRENTLY`. Le mot n'apparait nulle part ici, pas meme
    // en commentaire : c'est ce qui rend l'absence de directive volontaire et verifiable.
    expect(/concurrently/i.test(migration)).toBe(false);
  });

  it('ajoute les deux colonnes additives, sans backfill', () => {
    expect(migration).toContain('alter table automations add column if not exists possede_par text');
    expect(migration).toContain('alter table automations add column if not exists max_fires_per_hour integer');
    // Additif au sens strict : aucune ecriture de donnees, donc rien a rejouer ni a defaire.
    expect(/^\s*update automations/mi.test(migration)).toBe(false);
  });
});

describe('les lecteurs des deux colonnes additives', () => {
  const cols = /const COLS = '([^']+)'/.exec(store)?.[1] ?? '';
  const horsWebhook = /const HORS_WEBHOOK = "([^"]+)"/.exec(store)?.[1] ?? '';

  it('le test lit VRAIMENT les fichiers (sinon il ne prouve rien)', () => {
    expect(cols).toContain('tenant_id');
    expect(horsWebhook).toContain('trigger_kind');
    expect(migration.length).toBeGreaterThan(500);
  });

  it('🔴 `max_fires_per_hour` est SELECTIONNE et porte par le type', () => {
    expect(cols).toContain('max_fires_per_hour');
    expect(match).toContain('maxFiresPerHour: number | null;');
  });

  it('🔴 `possede_par` n est PAS selectionne : il filtre, il ne s affiche pas', () => {
    expect(cols).not.toContain('possede_par');
    expect(horsWebhook).toBe("and trigger_kind <> 'webhook' and possede_par is null");
  });

  it('🔴 le predicat est pose sur les QUATRE requetes de pilotage, et sur aucune autre', () => {
    // list, getById, update, remove. Pas `listEnabled` : le chemin chaud doit voir les automations
    // possedees, sinon le bouton d'un post publie ne declenche plus rien.
    expect(store.match(/\$\{HORS_WEBHOOK\}/g) ?? []).toHaveLength(4);
  });

  it('🔴 l insert de `create` ecrit les deux colonnes, avec autant de valeurs que de colonnes', () => {
    const debut = store.indexOf('insert into automations');
    const insert = store.slice(debut, store.indexOf('returning id', debut));
    expect(insert).toContain('possede_par');
    expect(insert).toContain('max_fires_per_hour');
    // Allonger la liste de colonnes sans allonger les `$n` (ou l'inverse) est l'erreur la plus facile a
    // commettre ici, et Postgres ne la dirait qu'a l'execution, en plein deploiement.
    const colonnes = insert.slice(insert.indexOf('(') + 1, insert.indexOf(')')).split(',').length;
    const places = new Set(insert.match(/\$\d+/g) ?? []).size;
    expect(places).toBe(colonnes);
  });
});
```

- [ ] **Step 2: lancer le test et constater l'echec**

```bash
npx vitest run tests/channels-me-migration.test.ts
```

Attendu : le fichier ne se charge meme pas, parce que `readFileSync` est au niveau module.
```
FAIL  tests/channels-me-migration.test.ts [ tests/channels-me-migration.test.ts ]
Error: ENOENT: no such file or directory, open '...\db\migrations\0114_channelsme.sql'
```

⚠️ Ne PAS lancer `npm run migrate` pour « voir si ca passe » : le `DATABASE_URL` du `.env` local pointe la base de PRODUCTION. La seule execution legitime de `migrate` a ce stade est celle de la CI, sur son Postgres jetable (job `integration`, etape « Migrations (cree le schema applicatif) »).

- [ ] **Step 3: ecrire la migration 0114**

Le SQL est recopie tel quel de la section 6 du spec (`docs/superpowers/specs/2026-09-04-channels-me-design.md`). Seul l'en-tete de commentaire est enrichi, parce que chaque migration de ce depot explique pourquoi elle est ecrite comme ca.

Creer `db/migrations/0114_channelsme.sql` :

```sql
-- 0114_channelsme.sql
-- Integration Channels Me : connexion chiffree par tenant, liens de chaine, trace des publications.
-- ⚠️ Prefixe `channelsme_` obligatoire : `channel` designe deja le tuyau (whatsapp|rcs) dans ce depot.
--
-- 🔴 TRANSACTIONNELLE ORDINAIRE, ET C EST UN CHOIX, PAS UN OUBLI. Aucune instruction de ce fichier n est un
-- `CREATE INDEX CONCURRENTLY`, la seule chose que Postgres refuse dans un bloc de transaction : il n y a donc
-- aucune raison de poser `-- migrate: no-transaction`, et une bonne raison de ne pas le faire. Hors
-- transaction, une migration n a AUCUN filet (un echec a mi-parcours n annule rien et le fichier est rejoue
-- depuis le debut, ce qui oblige chaque instruction a etre idempotente). Ici les trois tables et les deux
-- colonnes entrent ensemble ou pas du tout. Les index sont poses sur des tables VIDES creees dans la meme
-- transaction : ils ne bloquent aucune ecriture, personne ne pouvant encore ecrire dedans.
--
-- 🔴 ELLE PASSE AVANT LE DEPLOIEMENT. Les deux colonnes ajoutees a `automations` sont ECRITES par le code de
-- ce lot (`PgAutomationStore.create` insere `possede_par` et `max_fires_per_hour`) : deployer d abord ferait
-- echouer toute creation d automation en `column ... does not exist`, en boucle et en silence. C est le
-- scenario vecu le 2026-08-17, une heure et demie sans enregistrer un seul message entrant.
--
-- ⚠️ Les trois tables `channelsme_*`, elles, ne sont lues par personne tant que le module n est pas livre :
-- c est la partie NON bloquante. La regle « migrer avant de deployer » vaut pour ce que le code ECRIT.

create table if not exists channelsme_connections (
  tenant_id     uuid primary key references tenants(id) on delete cascade,
  org_id        text not null,
  channel_id    text not null,
  -- AES-256-GCM, format `v1.<iv>.<tag>.<data>` (src/crypto/secretbox.ts). Jamais lus par l'API publique.
  api_key_enc   text not null,
  secret_enc    text not null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists channelsme_links (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  -- `restrict` : on ne supprime pas un scenario dont un post publie depend (cf. §4.3).
  workflow_id    uuid not null references workflows(id) on delete restrict,
  start_node_id  text,
  -- Le jeton cache, deja normalise (minuscules). C'est LUI que l'automation cherche en `contains`.
  token          text not null,
  -- La phrase que l'abonne voit avant d'envoyer.
  phrase         text not null,
  automation_id  uuid references automations(id) on delete set null,
  -- Plafond horaire PROPRE au lien (decision 3). null = plafond global de l'instance.
  max_par_heure  integer,
  created_at     timestamptz not null default now()
);

-- Un jeton doit etre unique GLOBALEMENT, pas seulement par tenant : c'est un identifiant qui circule dans
-- des messages publics et qui est cherche sur le chemin chaud.
create unique index if not exists channelsme_links_token_key on channelsme_links (token);
create index if not exists channelsme_links_tenant_idx on channelsme_links (tenant_id, created_at desc);

create table if not exists channelsme_posts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  -- Identifiant du message CHEZ Channels Me. Le statut n'est pas stocke, il se lit en direct (decision 7).
  cm_message_id text not null,
  link_id      uuid references channelsme_links(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists channelsme_posts_tenant_idx on channelsme_posts (tenant_id, created_at desc);
create unique index if not exists channelsme_posts_msg_key on channelsme_posts (tenant_id, cm_message_id);

-- Possession generique d'une automation (cf. §4.2). Additif : les webhooks existants restent exclus par
-- `trigger_kind`, aucun backfill n'est necessaire.
alter table automations add column if not exists possede_par text;

-- Plafond horaire par automation (decision 3). null = plafond global.
alter table automations add column if not exists max_fires_per_hour integer;
```

- [ ] **Step 4: relancer le test et constater l'echec RESIDUEL (les lecteurs, pas la migration)**

```bash
npx vitest run tests/channels-me-migration.test.ts
```

Attendu : le premier `describe` passe en entier (5 verts), le second echoue sur quatre cas, dont :
```
FAIL  les lecteurs des deux colonnes additives > 🔴 `max_fires_per_hour` est SELECTIONNE et porte par le type
AssertionError: expected 'id, tenant_id, name, enabled, trigger_ki…' to contain 'max_fires_per_hour'
FAIL  les lecteurs des deux colonnes additives > 🔴 `possede_par` n est PAS selectionne : il filtre, il ne s affiche pas
AssertionError: expected "and trigger_kind <> 'webhook'" to be "and trigger_kind <> 'webhook' and possede_par is null"
```
C'est exactement le trou que le test existe pour attraper : la colonne est en base, personne ne la lit.

- [ ] **Step 5: porter le plafond dans le type `AutomationRow`**

Dans `src/automation/match.ts`, juste apres `cooldownSeconds`, ajouter :

```ts
  /** null = défaut serveur. 0 = aucun anti-rebond. */
  cooldownSeconds: number | null;
  /**
   * Plafond de declenchements par heure PROPRE a cette automation. null = plafond global de l'instance
   * (`AUTOMATION_MAX_FIRES_PER_HOUR`), 0 = aucun plafond, exactement comme le 0 du reglage global.
   *
   * Il existe pour le lien de chaine Channels Me : un post part vers des milliers d'abonnes qui appuient
   * tous sur le meme bouton, et le plafond global de 200 est la pour borner la facture d'un envoi de masse
   * INVOLONTAIRE. Desserrer le global aurait ouvert la vanne pour toutes les autres automations, qui elles
   * ecrivent a des contacts sans qu'un humain relise.
   */
  maxFiresPerHour: number | null;
```

- [ ] **Step 6: cabler les deux colonnes dans `PgAutomationStore`**

Cinq endroits dans `src/automation/store.pg.ts`, tous obligatoires, tous tenus a la main.

1. `interface Raw` (ligne ~18), ajouter la colonne lue :
```ts
interface Raw {
  id: string; tenant_id: string; name: string; enabled: boolean;
  trigger_kind: string; trigger_config: unknown; condition_group: unknown;
  workflow_id: string; start_node_id: string | null; cooldown_seconds: number | null;
  max_fires_per_hour: number | null;
}
```

2. `toRow` (ligne ~49), derniere propriete rendue :
```ts
    cooldownSeconds: r.cooldown_seconds,
    maxFiresPerHour: r.max_fires_per_hour,
  };
}
```

3. `COLS` (ligne 54) :
```ts
const COLS = 'id, tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, max_fires_per_hour';
```
⚠️ `possede_par` n'y entre PAS : rien ne le lit, il ne sert qu'au predicat ci-dessous.

4. `HORS_WEBHOOK` (ligne 66), le predicat et son commentaire, qui devient plus general :
```ts
/**
 * Une automation POSSEDEE appartient a l'objet qui l'a creee, jamais a l'ecran Automation.
 *
 * Deux formes de possession, et elles se cumulent. Les automations de type `webhook` sont possedees par leur
 * webhook entrant (migration 0074) : elles se creent, se modifient et se suppriment depuis l'ecran
 * Tools > Webhooks, via `PgWebhookStore`, qui ecrit ses propres requetes. Depuis la migration 0114, une ligne
 * peut aussi porter `possede_par` (un lien de chaine Channels Me pose `'channelsme_link'`), et c'est le cas
 * general : le type du declencheur ne dit alors rien, une automation possedee par un lien est un `keyword`
 * parfaitement ordinaire.
 *
 * Ce predicat les met hors de portee de CE store, donc de l'ecran Automation : sinon un PATCH pourrait
 * reaffecter une de ces lignes a un autre declencheur, ou un DELETE la retirer, en laissant un webhook qui
 * croit encore declencher un scenario, ou un post PUBLIC dont le bouton est mort et le restera.
 *
 * ⚠️ Le nom reste `HORS_WEBHOOK` alors qu'il exclut desormais deux choses : il est cite tel quel par
 * `tests/channels-me-migration.test.ts`, qui verifie sa valeur exacte. Le renommer casse ce test, ce qui est
 * le bon signal, pas un accident.
 */
const HORS_WEBHOOK = "and trigger_kind <> 'webhook' and possede_par is null";
```

5. `AutomationInput` (ligne ~7) et l'insert de `create` (ligne 115) :
```ts
export interface AutomationInput {
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerConfig: Record<string, unknown>;
  conditionGroup: unknown;
  workflowId: string;
  startNodeId: string | null;
  cooldownSeconds: number | null;
  enabled: boolean;
  /**
   * Qui POSSEDE cette automation ('channelsme_link'). Pose a la CREATION uniquement, et jamais par un corps
   * de requete : `parseBody` (src/http/automations.ts) est une liste blanche qui ne lit pas ce champ, donc un
   * client ne peut pas rendre sa propre automation invisible de son propre ecran.
   *
   * ⚠️ `update` ne le touche pas, et c'est volontaire : le predicat ci-dessus met deja toute ligne possedee
   * hors de portee de ce store. Le proprietaire ecrit ses propres requetes, comme `PgWebhookStore`.
   */
  possedePar?: string | null;
  /** Plafond horaire propre a l'automation. null (le defaut) = plafond global de l'instance. */
  maxFiresPerHour?: number | null;
}
```
```ts
  async create(tenantId: string, input: AutomationInput): Promise<{ id: string }> {
    const res = await this.pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, possede_par, max_fires_per_hour)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
      [
        tenantId, input.name, input.enabled, input.triggerKind,
        JSON.stringify(input.triggerConfig),
        input.conditionGroup === null ? null : JSON.stringify(input.conditionGroup),
        input.workflowId, input.startNodeId, input.cooldownSeconds,
        input.possedePar ?? null, input.maxFiresPerHour ?? null,
      ],
    );
    return { id: res.rows[0]!.id };
  }
```

- [ ] **Step 7: relancer le test unitaire (vert), puis le typecheck (rouge, et c'est le rayon de souffle)**

```bash
npx vitest run tests/channels-me-migration.test.ts
```
Attendu : `Test Files  1 passed`, 10 tests verts.

```bash
npm run typecheck
```
Attendu : 8 erreurs, TOUTES dans des tests, mesurees sur le depot au commit `6d3254c` :
```
tests/automation-date-sweep.test.ts(13,69): error TS2322: ... Type 'undefined' is not assignable to type 'number | null'.
tests/automation-match.test.ts(16,69): error TS2322: ...
tests/automation-match.test.ts(226,74): error TS2741: Property 'maxFiresPerHour' is missing ...
tests/automation-runner.test.ts(21,69): error TS2322: ...
tests/automation-webhook.test.ts(21,69): error TS2322: ...
tests/http-automations.test.ts(41,5): error TS2322: ...
tests/http-automations.test.ts(142,9): error TS2322: ...
tests/http-hubspot-events.test.ts(141,11): error TS2741: ...
```
Ces huit erreurs sont la moitie MECANIQUE du rayon de souffle : un champ requis ajoute a un type que huit litteraux construisent. Aucun `npm test` ne les aurait vues, vitest ne type-checke pas.

- [ ] **Step 8: reparer les huit litteraux `AutomationRow`**

Une seule propriete a ajouter partout, avec la meme valeur : `maxFiresPerHour: null` (aucun plafond propre, on retombe sur le global, ce qui est le comportement d'avant ce lot pour toutes les automations existantes).

`tests/automation-date-sweep.test.ts` ligne 13 :
```ts
const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Rappel rendez-vous', enabled: true,
  triggerKind: 'avant_date', triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures' },
  conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
  maxFiresPerHour: null, ...over,
});
```

`tests/automation-match.test.ts` ligne 16 :
```ts
const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Test', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
});
```

`tests/automation-match.test.ts` ligne 226 (`autoPub`, litteral complet, sans `over`) :
```ts
  const autoPub = (cfg: Record<string, unknown> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'Pub', enabled: true, triggerKind: 'ctwa_ad', triggerConfig: cfg,
    workflowId: 'wf1', startNodeId: null, conditionGroup: null, cooldownSeconds: null, maxFiresPerHour: null,
  });
```

`tests/automation-runner.test.ts` ligne 21 :
```ts
const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'A', enabled: true,
  triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
});
```

`tests/automation-webhook.test.ts` ligne 21 :
```ts
const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'a1', tenantId: 't1', name: 'Webhook : commandes', enabled: true,
  triggerKind: 'webhook', triggerConfig: { webhookId: 'wh1' }, conditionGroup: null,
  workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
});
```

`tests/http-automations.test.ts` ligne 41 (le `getById` de la fabrique `app`) :
```ts
    getById: async (id) => (id === 'a1' ? { id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'conversation_analyzed', triggerConfig: {}, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: 3600, maxFiresPerHour: null } : null),
```

`tests/http-automations.test.ts` ligne 142 (le `getById` surcharge du cas « sens 2 ») :
```ts
        getById: async () => ({ id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: 0, maxFiresPerHour: null }),
```

`tests/http-hubspot-events.test.ts` ligne 141 :
```ts
    const automation: AutomationRow = {
      id: 'a1', tenantId: 't1', name: 'Relance devis', enabled: true,
      triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's-devis' },
      conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null,
    };
```

Puis :
```bash
npm run typecheck
```
Attendu : aucune sortie, code 0.

- [ ] **Step 9: ecrire les quatre cas du plafond par automation (ils doivent echouer)**

Dans `tests/automation-runner.test.ts`, a la SUITE du `describe('plafond par automation (borne le fan-out de masse)')` existant (ne pas toucher a ses trois cas : ils exercent le plafond GLOBAL, qui doit continuer de valoir) :

```ts
/**
 * 🔴 LE PLAFOND DE L'AUTOMATION L'EMPORTE SUR CELUI DE L'INSTANCE (migration 0114, decision 3 du spec
 * Channels Me). Un post de chaine part vers des milliers d'abonnes qui appuient tous sur le meme bouton :
 * le plafond global de 200 est la pour borner la facture d'un envoi de masse INVOLONTAIRE, ici la masse est
 * le but. Desserrer le global aurait ouvert la vanne pour toutes les autres automations.
 */
describe('plafond PROPRE a une automation', () => {
  it('🔴 un plafond d automation PLUS HAUT que le global laisse passer', async () => {
    const { deps, trace } = make([auto({ maxFiresPerHour: 5000 })], { firedSince: async () => 1000, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });

  it('🔴 un plafond d automation PLUS BAS que le global s applique aussi (il n est pas qu une derogation)', async () => {
    const { deps, trace } = make([auto({ maxFiresPerHour: 10 })], { firedSince: async () => 10, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
    expect(trace.fired).toEqual([]);
  });

  it('automation sans plafond (null) -> le global continue de s appliquer', async () => {
    const { deps, trace } = make([auto({ maxFiresPerHour: null })], { firedSince: async () => 200, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(0);
    expect(trace.started).toEqual([]);
  });

  it('🔴 plafond 0 sur l automation -> AUCUN plafond, comme le 0 du reglage global', async () => {
    // `??` et non `||` : 0 est une valeur DELIBEREE. Un `||` la remplacerait par le global et refermerait la
    // vanne au moment precis ou le client a demande qu'elle soit ouverte.
    const { deps, trace } = make([auto({ maxFiresPerHour: 0 })], { firedSince: async () => 10_000, maxFiresPerHour: 200 });
    expect(await runAutomations('t1', MSG, deps)).toBe(1);
    expect(trace.started).toHaveLength(1);
  });
});
```

```bash
npx vitest run tests/automation-runner.test.ts
```
Attendu : les deux premiers cas et le quatrieme echouent, le troisieme passe deja.
```
FAIL  plafond PROPRE a une automation > 🔴 un plafond d automation PLUS HAUT que le global laisse passer
AssertionError: expected 0 to be 1
```

- [ ] **Step 10: faire lire au runner le plafond de l'automation**

Dans `src/automation/runner.ts`, remplacer le bloc des lignes 143 a 152 :

```ts
      // Plafond horaire : borne le fan-out d'un événement de masse (analyse rouverte pour toute une
      // campagne, par exemple). Vérifié APRÈS l'anti-rebond (moins cher) et AVANT tout démarrage.
      //
      // 🔴 LE REGLAGE DE L'AUTOMATION PRIME SUR LE DEFAUT DE L'INSTANCE, comme pour l'anti-rebond juste
      // au-dessus. C'est ce qui permet a un lien de chaine Channels Me d'ouvrir la vanne la ou la masse est
      // VOULUE, sans desserrer la garde qui protege les envois factures partout ailleurs.
      //
      // ⚠️ `??` et non `||` : 0 est une valeur DELIBEREE (aucun plafond), exactement comme le 0 du reglage
      // global et comme le 0 de l'anti-rebond. Un `||` la remplacerait par le global.
      const plafond = a.maxFiresPerHour ?? deps.maxFiresPerHour;
      if (deps.firedSince && plafond !== undefined && plafond > 0) {
        const depuis = new Date(now() - 3600_000);
        if ((await deps.firedSince(a.id, depuis)) >= plafond) {
          // Le message cite le plafond EFFECTIVEMENT applique. Journaliser le global pendant qu'on applique
          // celui de l'automation enverrait chercher le reglage au mauvais endroit, et c'est exactement le
          // defaut « corriger un compte a un endroit et le laisser a trois autres ».
          // eslint-disable-next-line no-console
          console.error(`automation ${a.id} (${a.name}) : plafond de ${plafond} déclenchements/heure atteint, déclenchement ignoré`);
          continue;
        }
      }
```

Et corriger le commentaire VOISIN, celui de `maxFiresPerHour` dans `AutomationRunnerDeps` (ligne ~73 a 79), qui affirme encore que ce plafond est le seul :
```ts
  /**
   * Plafond de déclenchements par automation et par heure, DEFAUT DE L'INSTANCE. L'anti-rebond est par
   * (automation, CONTACT) : il n'empêche donc rien à l'échelle d'une population. Or un seul acte
   * d'exploitation peut produire des milliers d'événements d'un coup (une campagne directe rouvre l'analyse
   * de tous ses destinataires, qui repartent ensuite en « conversation analysée »). Ce plafond est la seule
   * chose qui borne la facture dans ce cas.
   *
   * ⚠️ Une automation qui porte son propre `maxFiresPerHour` (migration 0114) l'emporte sur cette valeur,
   * dans les DEUX sens : plus haut comme plus bas.
   */
  maxFiresPerHour?: number;
```

```bash
npx vitest run tests/automation-runner.test.ts
```
Attendu : `Test Files  1 passed`, tous les cas verts, y compris les trois cas du plafond global qui existaient avant (preuve qu'aucun n'a ete perdu en cours de route).

- [ ] **Step 11: verrouiller que le CLIENT ne peut poser ni `possedePar` ni `maxFiresPerHour`, dans les deux sens**

Dans `tests/http-automations.test.ts`, ajouter dans le `describe('routes automations')` :

```ts
  it('🔴 le corps ne peut poser NI `possedePar` NI `maxFiresPerHour` : la liste blanche les jette', async () => {
    // Les deux seraient un pouvoir. `possedePar` sortirait l'automation de son propre ecran (elle
    // deviendrait invisible, immodifiable et insupprimable pour celui qui l'a creee) ; `maxFiresPerHour`
    // desserrerait le garde-fou qui borne la facture d'un envoi de masse involontaire. Ces deux colonnes
    // n'appartiennent qu'au proprietaire de l'automation, jamais a un corps de requete.
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/automations', ...h(adminTok),
      payload: { ...VALID, possedePar: 'channelsme_link', maxFiresPerHour: 100000 },
    });
    expect(res.statusCode).toBe(201);
    const input = cap.created[0]!.input as unknown as Record<string, unknown>;
    expect(input.possedePar).toBeUndefined();
    expect(input.maxFiresPerHour).toBeUndefined();
    await server.close();
  });
```

```bash
npx vitest run tests/http-automations.test.ts
```
Attendu : vert du premier coup, `parseBody` etant deja une liste blanche.

🔴 Un test de non-regression se verifie DANS LES DEUX SENS. Ajouter TEMPORAIREMENT, dans `parseBody` de `src/http/automations.ts`, juste avant le `return { input: out }` :
```ts
  (out as Record<string, unknown>).possedePar = (req as never); // temporaire, a retirer
```
plus simplement, la ligne realiste que quelqu'un ecrirait un jour :
```ts
  if ((b as { possedePar?: unknown }).possedePar !== undefined) (out as Record<string, unknown>).possedePar = (b as { possedePar?: unknown }).possedePar;
```
Relancer `npx vitest run tests/http-automations.test.ts` : le nouveau cas doit ECHOUER sur
`AssertionError: expected 'channelsme_link' to be undefined`. Puis RETIRER la ligne et relancer : vert. Sans cette manipulation, le test annonce une garantie qu'on n'a pas vue tenir.

- [ ] **Step 12: prouver le predicat de possession contre un vrai Postgres**

Un predicat SQL ne se verifie qu'en base : un test qui relirait la chaine de la requete ne prouverait que sa propre copie. Ajouter a la FIN de `tests/integration/automation-webhook-ownership.integration.test.ts`, a l'interieur du `describe.skipIf(!url)` :

```ts
  /**
   * 🔴 POSSESSION GENERIQUE (migration 0114). Le predicat ne dit plus « pas un webhook », il dit « pas
   * possedee ». Une automation creee par un lien de chaine Channels Me est un `keyword` parfaitement
   * ordinaire : c'est `possede_par` seul qui la met hors de portee de l'ecran Automation. Sans lui, un
   * client pouvait la modifier ou la supprimer, et laisser un bouton mort dans un post PUBLIC, deja
   * diffuse a ses abonnes et impossible a rattraper.
   */
  describe('automations possedees par un lien de chaine', () => {
    // 🔴 SA PROPRE automation : le dernier test du bloc precedent SUPPRIME `idNormale`, et un test qui
    // depend de ce qu'un autre a laisse n'est pas un test, c'est un pari.
    let idPossedee = '';
    beforeAll(async () => {
      idPossedee = (await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id, possede_par, max_fires_per_hour)
         values ($1, 'Chaine : newsletter', true, 'keyword', '{"keywords":["cm-a7k2m9p3"],"mode":"contains"}'::jsonb, $2, 'channelsme_link', 5000)
         returning id`,
        [tenantId, workflowId],
      )).rows[0]!.id;
    });

    it('🔴 `list`, `getById`, `update` et `remove` ne la voient pas, et ne laissent aucune trace', async () => {
      expect((await store.list(tenantId)).map((a) => a.id)).not.toContain(idPossedee);
      expect(await store.getById(idPossedee, tenantId)).toBeNull();
      expect(await store.update(idPossedee, tenantId, { enabled: false })).toBe(false);
      expect(await store.remove(idPossedee, tenantId)).toBe(false);
      const relu = await pool.query<{ enabled: boolean }>('select enabled from automations where id = $1', [idPossedee]);
      expect(relu.rowCount).toBe(1);
      expect(relu.rows[0]?.enabled).toBe(true);
    });

    it('le chemin CHAUD la voit, avec SON plafond : sinon le bouton du post serait mort', async () => {
      const chaud = await store.listEnabled(tenantId, ['keyword']);
      const a = chaud.find((x) => x.id === idPossedee);
      expect(a, 'une automation possedee doit rester declenchable, sinon le lien de chaine ne sert a rien').toBeDefined();
      expect(a?.maxFiresPerHour).toBe(5000);
    });

    it('une automation ORDINAIRE garde `maxFiresPerHour` a null (rien n a change pour elle)', async () => {
      const id = (await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
         values ($1, 'Mot-cle temoin 0114', true, 'keyword', '{"keywords":["temoin"]}'::jsonb, $2) returning id`,
        [tenantId, workflowId],
      )).rows[0]!.id;
      const vue = (await store.listEnabled(tenantId, ['keyword'])).find((x) => x.id === id);
      expect(vue?.maxFiresPerHour).toBeNull();
      // Et elle reste pilotable : le predicat n'a pas tout verrouille.
      expect(await store.remove(id, tenantId)).toBe(true);
    });
  });
```

⚠️ Ne PAS lancer ce fichier en local (`DATABASE_URL` local = PRODUCTION). Il tournera au job `integration` de la CI, a l'etape 15.

- [ ] **Step 13: prouver ce que la migration PROMET (contraintes de base)**

Creer `tests/integration/channels-me-schema.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree puis supprime des tenants. La CI monte un Postgres jetable pour
// ca (job `integration`) : c'est la qu'il doit tourner. `describe.skipIf(!url)` le rend inerte si
// DATABASE_URL n'est pas defini, mais ne protege pas contre un DATABASE_URL defini qui pointerait la prod.
const url = process.env.DATABASE_URL ?? '';

/**
 * Ce que la migration 0114 PROMET, verifie contre un vrai Postgres. Aucune de ces promesses n'est visible du
 * code : ce sont des contraintes de base, et elles ne parlent qu'a l'execution.
 *
 *  1. Le jeton est unique GLOBALEMENT, pas par tenant. Il circule dans des messages publics et il est
 *     cherche sur le chemin chaud, ou le tenant est deduit du NUMERO : deux clients portant le meme jeton
 *     feraient demarrer le scenario du mauvais.
 *  2. Un scenario dont un lien depend ne se supprime pas. Un post publie circule pour toujours, son bouton
 *     ne doit pas pouvoir mourir d'un clic sur « supprimer le scenario ».
 *  3. Une publication ne s'enregistre qu'une fois par message Channels Me, et cette unicite-la EST scopee
 *     tenant (l'identifiant vient de chez le fournisseur, deux clients peuvent porter le meme).
 *  4. Une seule connexion par tenant (cle primaire sur `tenant_id`).
 */
describe.skipIf(!url)('migration 0114 : ce que le schema Channels Me garantit', () => {
  let pool: Pool;
  let tenantId = '';
  let autreTenantId = '';
  let workflowId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme-schema') returning id`,
    )).rows[0]!.id;
    autreTenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme-schema-autre') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest-cm', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    // ⚠️ LES LIENS PARTENT AVANT LE TENANT, et ce n'est pas de la precaution decorative.
    // `channelsme_links.workflow_id` est en `on delete restrict`, qui n'est PAS differe en fin d'instruction
    // (contrairement a `no action`). Si la cascade du tenant traite `workflows` avant `channelsme_links`,
    // le RESTRICT leve tout de suite et le nettoyage echoue. On ne parie pas sur l'ordre des actions
    // referentielles.
    if (tenantId) {
      await pool.query('delete from channelsme_posts where tenant_id = $1', [tenantId]);
      await pool.query('delete from channelsme_links where tenant_id = $1', [tenantId]);
    }
    if (autreTenantId) {
      await pool.query('delete from channelsme_posts where tenant_id = $1', [autreTenantId]);
      await pool.query('delete from channelsme_links where tenant_id = $1', [autreTenantId]);
    }
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  const creerLien = (tenant: string, token: string, wf = workflowId) => pool.query<{ id: string }>(
    `insert into channelsme_links (tenant_id, workflow_id, token, phrase, max_par_heure)
     values ($1, $2, $3, 'Je veux recevoir la newsletter', 5000) returning id`,
    [tenant, wf, token],
  );

  it('🔴 le jeton est unique GLOBALEMENT, y compris entre DEUX tenants differents', async () => {
    await creerLien(tenantId, 'cm-a7k2m9p3');
    await expect(creerLien(tenantId, 'cm-a7k2m9p3')).rejects.toThrow(/channelsme_links_token_key/);
    // L'unicite ne s'arrete PAS au tenant, contrairement a presque tous les autres index de ce depot.
    await expect(creerLien(autreTenantId, 'cm-a7k2m9p3')).rejects.toThrow(/channelsme_links_token_key/);
    // Un autre jeton passe : l'index interdit le doublon, pas le second lien.
    await creerLien(tenantId, 'cm-b4n8q1r5');
  });

  it('🔴 un scenario dont un lien depend ne se supprime pas (`on delete restrict`)', async () => {
    const wf = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest-cm-restrict', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
    await creerLien(tenantId, 'cm-restrict1', wf);
    await expect(pool.query('delete from workflows where id = $1', [wf])).rejects.toThrow(/foreign key/i);
  });

  it('une publication ne s enregistre qu UNE fois par message Channels Me, et l unicite est scopee tenant', async () => {
    await pool.query(`insert into channelsme_posts (tenant_id, cm_message_id) values ($1, 'cmmsg-1')`, [tenantId]);
    await expect(
      pool.query(`insert into channelsme_posts (tenant_id, cm_message_id) values ($1, 'cmmsg-1')`, [tenantId]),
    ).rejects.toThrow(/channelsme_posts_msg_key/);
    // Le meme identifiant chez un AUTRE client n'est pas un doublon : il vient de chez le fournisseur.
    await pool.query(`insert into channelsme_posts (tenant_id, cm_message_id) values ($1, 'cmmsg-1')`, [autreTenantId]);
  });

  it('une seule connexion par tenant (cle primaire sur tenant_id)', async () => {
    // Valeurs FICTIVES : aucun secret. La forme `v1.` est celle de src/crypto/secretbox.ts, mais ce test ne
    // chiffre rien, il ne verifie qu'une contrainte de cle.
    await pool.query(
      `insert into channelsme_connections (tenant_id, org_id, channel_id, api_key_enc, secret_enc)
       values ($1, 'org-itest', 'ch-itest', 'v1.faux', 'v1.faux')`,
      [tenantId],
    );
    await expect(pool.query(
      `insert into channelsme_connections (tenant_id, org_id, channel_id, api_key_enc, secret_enc)
       values ($1, 'org-2', 'ch-2', 'v1.faux', 'v1.faux')`,
      [tenantId],
    )).rejects.toThrow(/duplicate key/i);
  });
});
```

- [ ] **Step 14: mettre a jour le compteur de migrations et le journal**

`CLAUDE.md` est la SEULE source du compteur, et il porte une migration EN ATTENTE pour la premiere fois depuis le 2026-09-03. Remplacer les lignes 81 et 82 :

```md
**Dernière appliquée : 0113** (l'index du balayage, cf. juste au-dessus), le 2026-09-03 au soir, après 0108
à 0112. **0114 (Channels Me) est ÉCRITE et EN ATTENTE : elle passe AVANT le prochain déploiement**, parce que
`PgAutomationStore.create` écrit désormais `possede_par` et `max_fires_per_hour`. **Prochaine libre = 0115.**
```

Et la ligne 84, qui borne l'archive :
```md
**Le détail de CHAQUE migration (0093 à 0114), ce qu'elle a coûté et ce qu'elle a appris, vit dans**
```

Dans `documentation.md`, changer le titre de la ligne 2097 en `(0093 à 0114)` et inserer, juste avant l'entree `✅ 0113`, l'entree de la 0114, SANS marqueur d'etat (le compteur reste la propriete exclusive de `CLAUDE.md`) :

```md
**0114 (Channels Me)** : trois tables `channelsme_*` plus DEUX colonnes additives sur `automations`. Le
prefixe n'est pas cosmetique, `channel` designe deja le tuyau (whatsapp | rcs) dans ce depot. Ce qu'elle
apprend tient dans ses deux colonnes additives : `possede_par` generalise l'exclusion que `trigger_kind <>
'webhook'` faisait a la main depuis la 0074, parce qu'une automation possedee par un lien de chaine est un
`keyword` parfaitement ordinaire et qu'aucun type ne peut donc plus la trahir ; `max_fires_per_hour` ouvre le
plafond de declenchements LA ou la masse est voulue, au lieu de desserrer le plafond global qui protege tous
les autres envois factures. 🔴 Le lien n'a PAS de colonne `enabled` : son etat allume ou eteint EST le
`enabled` de son automation compagnon, deux copies du meme etat divergeant au premier chemin qui n'en ecrit
qu'une. ⚠️ `channelsme_links.workflow_id` est en `on delete restrict` et RESTRICT n'est pas differe en fin
d'instruction : supprimer un TENANT peut echouer selon l'ordre des actions referentielles, donc un nettoyage
supprime les liens AVANT le tenant (cf. `tests/integration/channels-me-schema.integration.test.ts`).
```

- [ ] **Step 15: suite complete, commit, push, et lecture du run CI**

```bash
npm run typecheck
npm test
```
Attendu : typecheck muet, et `npm test` entierement vert (les tests d'integration sont exclus par `vitest.config.ts`, ils ne tournent qu'en CI).

⚠️ Ne toujours PAS lancer `npm run migrate` ni `npm run test:integration` en local : le `DATABASE_URL` du `.env` local pointe la base de PRODUCTION, et ces deux commandes y creeraient ou y supprimeraient des objets. La seule execution legitime est celle de la CI (job `integration` : Postgres pgvector jetable, `npm run migrate` puis `npm run test:integration`).

Commit par chemins EXPLICITES. L'arbre de travail contient des fichiers qui n'appartiennent PAS a cette tache (les `AUDIT-*.md`, un eventuel `src/channels-me/` d'une sonde ou d'une autre tache, `.tmp-probe-t5/`) : un `git add -A` les embarquerait.

```bash
git add db/migrations/0114_channelsme.sql tests/channels-me-migration.test.ts \
  tests/integration/channels-me-schema.integration.test.ts \
  src/automation/match.ts src/automation/store.pg.ts src/automation/runner.ts \
  tests/automation-runner.test.ts tests/automation-match.test.ts tests/automation-webhook.test.ts \
  tests/automation-date-sweep.test.ts tests/http-automations.test.ts tests/http-hubspot-events.test.ts \
  tests/integration/automation-webhook-ownership.integration.test.ts \
  CLAUDE.md documentation.md
git status --short
```
Attendu : les 15 chemins en `A`/`M` dans l'index, et rien d'autre.

```bash
git commit -m "feat(channels-me): migration 0114, possession et plafond propre des automations

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
⚠️ Le hook `rayon-de-souffle.js` BLOQUE ce premier commit pour afficher les lecteurs des symboles touches (`AutomationRow`, `COLS`, `HORS_WEBHOOK`, `maxFiresPerHour`). Lire la liste, verifier qu'elle ne contient rien qui ne soit deja dans les fichiers ci-dessus, puis relancer la MEME commande : elle passe.

```bash
git push origin main
gh run list --limit 3
```
Puis attendre et lire le run : le job `unit` (typecheck + `npm test`) et surtout le job `integration`, qui est le SEUL a jouer `npm run migrate` et les deux nouveaux fichiers d'integration. Un `npm test` vert en local ne prouve que la moitie : la migration elle-meme n'a encore ete executee nulle part avant ce run.

```bash
gh run view --log-failed
```
si le run est rouge.


---

### Task 2: Extraire lienWaMe dans src/lib/wa-me.ts

Le constructeur du lien `wa.me` existe UNE fois dans le dépôt, enfoui dans `src/workflow/test-token.ts` sous le nom `waMeTestLink`. Channels Me a besoin exactement du même calcul (le texte du post porte une URL `wa.me` pré-remplie, cf. spec § 2.1), donc on le sort dans un module partagé au nom gelé `lienWaMe`, et `waMeTestLink` devient un mince appelant. Aucun comportement ne change : c'est un refactor à rayon de souffle, et le lot se termine par la preuve que les anciens tests passent toujours, plus la preuve inverse (casser le module partagé fait tomber les DEUX fichiers de test).

**Files:**
- Create: `C:\Users\julie\messagingme-mba\src\lib\wa-me.ts`
- Create (test): `C:\Users\julie\messagingme-mba\tests\lib-wa-me.test.ts`
- Modify: `C:\Users\julie\messagingme-mba\src\workflow\test-token.ts` (lignes 1 et 54 à 63 : `waMeTestLink` délègue)
- Modify (doc): `C:\Users\julie\messagingme-mba\documentation.md` (§ « Modules partagés », tableau **Backend**, ligne 1666 et suivantes)
- NON modifiés, mais à garder verts (ce sont les deux seuls lecteurs de `waMeTestLink`) :
  - `C:\Users\julie\messagingme-mba\src\http\workflows.ts` (import ligne 10, usage ligne 250)
  - `C:\Users\julie\messagingme-mba\tests\workflow-test-token.test.ts` (bloc `describe('lien wa.me')` lignes 43 à 51, 17 tests dans le fichier)

**Interfaces:**

- **Consumes**: rien d'aucune tâche précédente. Cette tâche ne lit que l'existant au commit `c9f5fa5` :
  - `export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null` (`src/workflow/test-token.ts:59`), dont le corps actuel est :
    ```ts
    const digits = (displayPhoneNumber ?? '').replace(/\D/g, '');
    if (digits === '' || token === '') return null;
    return `https://wa.me/${digits}?text=${encodeURIComponent(token)}`;
    ```
- **Produces**:
  - `export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null` depuis `src/lib/wa-me.ts`. Rend `null` si le numéro est `null`, vide, ou ne porte aucun chiffre. Sinon `https://wa.me/<chiffres>?text=<encodeURIComponent(texte)>`, où `<chiffres>` est le numéro affiché privé de tout ce qui n'est pas un chiffre.
  - Consommateur prévu par les tâches suivantes : la route `POST /tenants/:tenantId/channels-me/posts` (`src/http/channels-me.ts`), qui appelle `lienWaMe(numeroAffiche, textePreRempli(phrase, jeton))` pour composer l'URL insérée dans le texte du post. `textePreRempli` et `jeton` viennent de `src/channels-me/jeton.ts`, ils ne sont PAS produits ici.
  - `waMeTestLink(displayPhoneNumber: string | null, token: string): string | null` reste exporté depuis `src/workflow/test-token.ts`, signature et comportement INCHANGÉS (jeton vide compris) : aucun appelant existant ne bouge.

---

- [ ] **Step 1: Écrire le test qui échoue, `tests/lib-wa-me.test.ts`**

Test unitaire pur : aucune base, aucun réseau, donc `tests/` et pas `tests/integration/`. Créer le fichier avec exactement ce contenu :

```ts
import { describe, it, expect } from 'vitest';
import { lienWaMe } from '../src/lib/wa-me';

/**
 * Constructeur du lien wa.me pré-rempli (module partagé).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. Sans numéro connecté, AUCUN lien n'est fabriqué. Un lien sans chiffres (`https://wa.me/?text=...`)
 *     ouvre un écran d'erreur WhatsApp : mieux vaut ne rien afficher qu'un bouton mort. Et ce lien-là part
 *     dans un post de chaîne DÉJÀ distribué : il n'y a aucun retour arrière.
 *  2. Le numéro arrive tel que Meta l'AFFICHE (« +33 5 25 68 02 50 ») ; wa.me n'accepte que des chiffres.
 *     Un seul caractère parasite laissé dans l'URL la casse sans que rien ne le signale.
 *  3. Le texte est le message que la personne ENVERRA, pas une étiquette : il porte une phrase lisible ET
 *     le jeton. Sans encodage il est tronqué au premier espace, le jeton est perdu, et le scénario ne
 *     démarre jamais.
 */

// Jeton FICTIF (aucun secret) : valeur figée pour rendre les assertions lisibles.
const JETON = 'test-a7k2m9p3';

describe('lienWaMe', () => {
  it('retire le signe plus et les espaces du numéro affiché', () => {
    expect(lienWaMe('+33 5 25 68 02 50', JETON)).toBe('https://wa.me/33525680250?text=test-a7k2m9p3');
  });

  it('aucun numéro connecté (null) -> pas de lien fabriqué', () => {
    expect(lienWaMe(null, JETON)).toBeNull();
  });

  it('numéro vide, ou sans aucun chiffre -> pas de lien fabriqué', () => {
    expect(lienWaMe('', JETON)).toBeNull();
    expect(lienWaMe('   ', JETON)).toBeNull();
    expect(lienWaMe('+ ()-', JETON)).toBeNull();
  });

  it('encode le texte pré-rempli : espaces et accents', () => {
    // `!` n'est PAS encodé par encodeURIComponent (il fait partie de son jeu non réservé), et wa.me
    // l'accepte tel quel : l'assertion fige ce comportement plutôt que de le supposer.
    expect(lienWaMe('+33 5 25 68 02 50', 'Réserve ma place ! cm-a7k2m9p3'))
      .toBe('https://wa.me/33525680250?text=R%C3%A9serve%20ma%20place%20!%20cm-a7k2m9p3');
  });
});
```

- [ ] **Step 2: Lancer le test et constater l'échec (le module n'existe pas encore)**

```bash
npx vitest run tests/lib-wa-me.test.ts
```

Sortie attendue, à la ponctuation près :

```
 FAIL  tests/lib-wa-me.test.ts [ tests/lib-wa-me.test.ts ]
Error: Failed to load url ../src/lib/wa-me (resolved id: C:/Users/julie/messagingme-mba/src/lib/wa-me) in C:/Users/julie/messagingme-mba/tests/lib-wa-me.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

Si la sortie annonce autre chose qu'un module introuvable, s'arrêter : le fichier `src/lib/wa-me.ts` existe déjà et la tâche n'est plus une création.

- [ ] **Step 3: Créer `src/lib/wa-me.ts`**

```ts
/**
 * LE LIEN wa.me PRÉ-REMPLI, ÉCRIT UNE FOIS.
 *
 * `https://wa.me/<chiffres>?text=<texte encodé>` ouvre WhatsApp sur une conversation avec NOTRE numéro, le
 * message déjà saisi : la personne n'a plus qu'à appuyer sur Envoyer. C'est donc elle qui écrit la première,
 * ce qui ouvre la fenêtre de service de 24 h et dispense de tout template approuvé.
 *
 * Deux surfaces le fabriquent, et c'est pour cela que la règle sort de son premier appelant :
 *  - le lien de TEST d'un scénario (`waMeTestLink`, src/workflow/test-token.ts), où le texte est un jeton ;
 *  - le bouton d'un post de chaîne WhatsApp (Channels Me), où le texte est une phrase lisible suivie du
 *    jeton du lien. Là, l'URL part dans un post PUBLIÉ : une seconde copie de la règle qui divergerait
 *    enverrait des abonnés sur un lien mort, sans recours possible, le post étant déjà distribué.
 *
 * Deux pièges portés ici, et nulle part ailleurs :
 *  1. le numéro arrive tel que Meta l'AFFICHE (« +33 5 25 68 02 50 ») ; wa.me n'accepte que des chiffres,
 *     donc tout le reste est retiré ;
 *  2. le texte est un MESSAGE, pas une étiquette : il contient des espaces et des accents, et sans encodage
 *     il serait tronqué au premier espace, ce qui coupe le jeton et empêche le scénario de démarrer.
 *
 * Module PUR : aucune IO, aucune configuration lue, testable sans base.
 */

/**
 * Lien wa.me vers `displayPhoneNumber`, avec `texte` déjà saisi.
 *
 * null si le numéro est absent, vide, ou ne porte aucun chiffre : on ne fabrique pas un lien cassé, l'écran
 * appelant n'affiche simplement rien.
 */
export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null {
  const chiffres = (displayPhoneNumber ?? '').replace(/\D/g, '');
  if (chiffres === '') return null;
  return `https://wa.me/${chiffres}?text=${encodeURIComponent(texte)}`;
}
```

- [ ] **Step 4: Relancer le test et constater le succès**

```bash
npx vitest run tests/lib-wa-me.test.ts
```

Sortie attendue :

```
 ✓ tests/lib-wa-me.test.ts (4 tests)

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- [ ] **Step 5: Faire pointer `waMeTestLink` sur `lienWaMe`**

Dans `src/workflow/test-token.ts`, ajouter l'import juste après celui de `node:crypto` (ligne 1) :

```ts
import { randomBytes } from 'node:crypto';
import { lienWaMe } from '../lib/wa-me';
```

Puis remplacer INTÉGRALEMENT le bloc des lignes 54 à 63 (le commentaire et la fonction) par :

```ts
/**
 * Lien WhatsApp qui ouvre une conversation avec le jeton DÉJÀ saisi. `displayPhoneNumber` arrive tel que Meta
 * l'affiche (« +33 5 25 68 02 50 ») : wa.me n'accepte que des chiffres, sans + ni espaces.
 * null si le tenant n'a pas encore de numéro (rien à proposer, on ne fabrique pas un lien cassé).
 *
 * La construction de l'URL vit dans `src/lib/wa-me.ts` depuis que la chaîne WhatsApp la fabrique aussi. Ce
 * qui reste ICI est la seule chose propre au TEST : un jeton VIDE ne donne pas de lien. Ce refus porte sur le
 * jeton, pas sur l'URL, donc il ne descend pas dans le module partagé, dont l'autre appelant compose toujours
 * un texte non vide (une phrase suivie du jeton du lien).
 */
export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null {
  if (token === '') return null;
  return lienWaMe(displayPhoneNumber, token);
}
```

Note de rayon de souffle : la garde `token === ''` est CONSERVÉE, à sa place exacte du point de vue de l'appelant. La signature gelée de `lienWaMe` ne la mentionne pas, donc elle ne descend pas dans le module partagé ; la supprimer en silence changerait le comportement de `waMeTestLink('+33...', '')`, qui rend `null` aujourd'hui.

- [ ] **Step 6: Prouver que les DEUX lecteurs restent verts, et que le typage tient**

```bash
npx vitest run tests/lib-wa-me.test.ts tests/workflow-test-token.test.ts
```

Sortie attendue (17 tests dans l'ancien fichier, mesurés au commit `c9f5fa5`, plus les 4 nouveaux) :

```
 ✓ tests/lib-wa-me.test.ts (4 tests)
 ✓ tests/workflow-test-token.test.ts (17 tests)

 Test Files  2 passed (2)
      Tests  21 passed (21)
```

Puis le second lecteur, `src/http/workflows.ts`, qui n'est couvert par aucun test unitaire sur cette ligne et dont seule la compilation atteste :

```bash
npm run typecheck
```

Sortie attendue : aucune ligne, code de sortie 0. `src/http/workflows.ts` n'est PAS modifié (il importe toujours `waMeTestLink` depuis `'../workflow/test-token'` ligne 10, l'appelle ligne 250) : c'est précisément ce qui rend le refactor sans risque pour lui.

- [ ] **Step 7: Vérifier DANS LES DEUX SENS que la délégation est réelle**

Un test qui passe après un refactor ne prouve rien tant qu'on n'a pas vu qu'il ÉCHOUE quand le code partagé est faux. Casser TEMPORAIREMENT `src/lib/wa-me.ts` en retirant la normalisation du numéro, c'est-à-dire remplacer la ligne :

```ts
  const chiffres = (displayPhoneNumber ?? '').replace(/\D/g, '');
```

par :

```ts
  const chiffres = displayPhoneNumber ?? '';
```

Puis relancer :

```bash
npx vitest run tests/lib-wa-me.test.ts tests/workflow-test-token.test.ts
```

Sortie attendue : les DEUX fichiers échouent, ce qui prouve que `waMeTestLink` passe bien par le module partagé et n'a pas gardé une copie du calcul.

```
 Test Files  2 failed (2)
      Tests  4 failed | 17 passed (21)
```

Les échecs attendus, nommément :
- `lienWaMe > retire le signe plus et les espaces du numéro affiché` : reçu `https://wa.me/+33 5 25 68 02 50?text=test-a7k2m9p3`
- `lienWaMe > numéro vide, ou sans aucun chiffre -> pas de lien fabriqué` : `'   '` ne rend plus `null`
- `lienWaMe > encode le texte pré-rempli : espaces et accents`
- `lien wa.me > retire le + et les espaces du numéro affiché, encode le jeton` (dans `tests/workflow-test-token.test.ts`, LA preuve recherchée)

RESTAURER immédiatement la ligne d'origine :

```ts
  const chiffres = (displayPhoneNumber ?? '').replace(/\D/g, '');
```

et confirmer le retour au vert :

```bash
npx vitest run tests/lib-wa-me.test.ts tests/workflow-test-token.test.ts
```

Sortie attendue : `Tests  21 passed (21)`.

- [ ] **Step 8: Énumérer les dépendants, à la main et par grep**

```bash
npx --no-install grep --version >/dev/null 2>&1; grep -rn "waMeTestLink\|lienWaMe" src tests web --include=*.ts --include=*.tsx
```

Sortie attendue, exactement six lignes plus les nouvelles :

```
src/lib/wa-me.ts:...:export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null {
src/workflow/test-token.ts:2:import { lienWaMe } from '../lib/wa-me';
src/workflow/test-token.ts:...:export function waMeTestLink(displayPhoneNumber: string | null, token: string): string | null {
src/workflow/test-token.ts:...:  return lienWaMe(displayPhoneNumber, token);
src/http/workflows.ts:10:import { newTestToken, waMeTestLink } from '../workflow/test-token';
src/http/workflows.ts:250:    return reply.code(200).send({ token, phone, link: waMeTestLink(phone, token) });
tests/lib-wa-me.test.ts:2:import { lienWaMe } from '../src/lib/wa-me';
tests/workflow-test-token.test.ts:2:import { newTestToken, looksLikeTestToken, normalizeTestToken, waMeTestLink } from '../src/workflow/test-token';
tests/workflow-test-token.test.ts:45:    expect(waMeTestLink('+33 5 25 68 02 50', 'test-a7k2m9p3')).toBe('https://wa.me/33525680250?text=test-a7k2m9p3');
tests/workflow-test-token.test.ts:48:    expect(waMeTestLink(null, 'test-a7k2m9p3')).toBeNull();
tests/workflow-test-token.test.ts:49:    expect(waMeTestLink('', 'test-a7k2m9p3')).toBeNull();
```

Aucun autre dépendant ne doit apparaître. Deux fichiers contiennent une URL `wa.me` mais ne dépendent PAS de la fonction, vérifié et laissé tel quel :
- `web/e2e/workflow-test-link.spec.ts` lignes 22 et 41 : le lien y est écrit EN DUR dans un mock Playwright et dans l'assertion, la spec n'importe rien du serveur. Elle continue de passer sans modification, et c'est normal : elle teste l'écran, pas le calcul.
- `tests/channels-me-signature.test.ts` ligne 42 : une URL `wa.me` sert de charge utile à un test de signature, sans rapport avec ce module.

Enfin, ajouter la ligne au tableau **Backend** de `documentation.md` § « Modules partagés » (le tableau commence ligne 1666), à la suite des lignes existantes, mêmes trois colonnes :

```
| `src/lib/wa-me.ts` -> `lienWaMe` | Le lien `wa.me` pré-rempli : chiffres seuls dans le numéro, texte encodé, null quand aucun numéro n'est connecté | vivait dans `src/workflow/test-token.ts` (`waMeTestLink`), qui n'a rien à voir avec la chaîne WhatsApp mais en portait la seule copie. Une seconde copie enverrait des abonnés sur un lien mort depuis un post DÉJÀ publié |
```

- [ ] **Step 9: Suite complète et typage, avant de committer**

```bash
npm test
```

Sortie attendue (mesuré au commit `c9f5fa5` : 283 fichiers et 3680 tests ; ce lot ajoute un fichier et quatre tests) :

```
 Test Files  284 passed (284)
      Tests  3684 passed (3684)
```

Puis :

```bash
npm run typecheck
```

Sortie attendue : aucune ligne, code de sortie 0.

Ne PAS lancer `npm run test:integration` : le `DATABASE_URL` local pointe sur la base de PRODUCTION. Cette tâche ne touche ni base ni migration, donc la CI n'a rien de plus à vérifier de ce côté.

- [ ] **Step 10: Committer, en ne prenant QUE les fichiers de cette tâche**

L'arbre de travail porte déjà des choses qui ne sont pas à nous : `src/channels-me/` non suivi, `src/automation/match.ts` modifié, et une dizaine de rapports d'audit `AUDIT-*.md`. Donc chemins explicites, jamais `git add -A` ni `git add .`.

```bash
git add src/lib/wa-me.ts tests/lib-wa-me.test.ts src/workflow/test-token.ts documentation.md
git status --short
```

Sortie attendue : exactement quatre lignes indexées, `A  src/lib/wa-me.ts`, `A  tests/lib-wa-me.test.ts`, `M  src/workflow/test-token.ts`, `M  documentation.md`, les autres entrées restant non indexées.

```bash
git commit -m "refactor(wa-me): le constructeur du lien wa.me sort du jeton de test" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

⚠️ Le hook `rayon-de-souffle.js` BLOQUE ce premier commit pour mettre sous les yeux les lecteurs des symboles touchés (`waMeTestLink`). Lire la liste, vérifier qu'elle ne contient que les deux lecteurs déjà traités au Step 8, puis relancer la MÊME commande, qui passe.

```bash
git push origin main
```

On reste sur `main`, pas de branche, pas de worktree.


---

### Task 3: Signeur Channels Me

**Files:**
- Create : `C:\Users\julie\messagingme-mba\src\channels-me\signature.ts` (crée aussi le répertoire `src/channels-me/` s'il n'existe pas encore)
- Test : `C:\Users\julie\messagingme-mba\tests\channels-me-signature.test.ts`
- Modify : aucun. Cette tâche ne touche à AUCUN fichier existant, donc son rayon de souffle mécanique est vide (un module neuf n'a par construction aucun lecteur). La question inverse, « qu'est-ce que ce module suppose du reste ? », a une réponse tenue : rien, il n'importe que `node:crypto`.

**Interfaces:**

- **Consumes** : rien des tâches précédentes. Une seule dépendance, la bibliothèque standard :
  ```ts
  import { createHmac } from 'node:crypto';
  ```
  ⚠️ Ne PAS réutiliser `src/lib/signature.ts` (`signRequest`, format `v1=` cross-repo mba vers mm-hubspot, préimage horodatée et sortie hexadécimale) ni `src/crypto/secretbox.ts` (chiffrement au repos AES-256-GCM). Trois usages distincts, trois modules distincts.

- **Produces** :
  ```ts
  export function corpsCanonique(v: unknown): string
  export function signer(canonique: string, secret: string): string
  ```
  Consommé par la tâche `src/channels-me/client.ts` (`ChannelsMeClient.createMessage`). Le contrat d'usage, qui est la raison d'être des deux fonctions :
  ```ts
  // UNE seule dérivation : la MÊME chaîne est signée ET envoyée comme corps.
  const canonique = corpsCanonique({ message: { kind: 'text', text, media_url: mediaUrl } });
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Signature': signer(canonique, cx.secret) },
    body: canonique,
  });
  ```
  Deux propriétés dont le client dépend et que les tests figent : `corpsCanonique` rend du **JSON valide** (c'est lui qui part comme corps), et il trie les clés **en profondeur** (mesuré obligatoire, spec §2.2, le corps réel étant `{message:{...}}`).

---

- [ ] **Step 1: Écrire la vague A du test, le vecteur d'or**

  Créer `tests/channels-me-signature.test.ts` avec exactement ce contenu :

  ```ts
  import { describe, it, expect } from 'vitest';
  import { corpsCanonique, signer } from '../src/channels-me/signature';

  /**
   * Signature des appels Channels Me (module PUR : ni base, ni réseau).
   *
   * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
   *  1. 🔴 LE VECTEUR D'OR de la documentation du fournisseur. C'est le seul point de contact avec une
   *     vérité extérieure au dépôt : s'il bouge, plus aucun appel n'est authentifié, et l'API répond 401
   *     sans dire pourquoi. Il fige d'un coup la canonicalisation, l'algorithme et l'encodage de sortie
   *     (base64 des octets BRUTS, pas de leur représentation hexadécimale, piège déjà payé sur Zadarma).
   *  2. 🔴 LE TRI ALPHABÉTIQUE EN PROFONDEUR. La signature porte sur la structure IMBRIQUÉE, ce qui a été
   *     MESURÉ (spec du 2026-09-04, §2.2), pas supposé. Le vecteur d'or ne peut pas le prouver : il n'a
   *     qu'une seule clé plate, donc un tri de surface le passe aussi, puis casse tous les POST réels,
   *     dont le corps est `{message:{...}}`.
   */

  // Vecteur d'or publié par le fournisseur. `secret` est la valeur LITTÉRALE de sa documentation : aucun
  // secret de production ici, et la valeur est figée pour rendre l'assertion lisible.
  const VECTEUR_CORPS = { user_id: 'azerty_1234' };
  const VECTEUR_SECRET = 'secret';
  const VECTEUR_SIGNATURE = 'NmkAFERlEbTraKnBkYuHSVygdSA65X5oPU4duO5bRMY=';

  describe('corpsCanonique + signer : vecteur d or', () => {
    it('🔴 reproduit EXACTEMENT la signature publiée par le fournisseur', () => {
      expect(signer(corpsCanonique(VECTEUR_CORPS), VECTEUR_SECRET)).toBe(VECTEUR_SIGNATURE);
    });

    it('la chaîne canonique du vecteur est le JSON compact attendu', () => {
      expect(corpsCanonique(VECTEUR_CORPS)).toBe('{"user_id":"azerty_1234"}');
    });
  });
  ```

- [ ] **Step 2: Lancer le test et constater l'échec de chargement**

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue (le module n'existe pas, la suite ne peut même pas se collecter) :

  ```
   ❯ tests/channels-me-signature.test.ts (0 test)

  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
   FAIL  tests/channels-me-signature.test.ts [ tests/channels-me-signature.test.ts ]
  Error: Failed to load url ../src/channels-me/signature (resolved id: ../src/channels-me/signature) in C:/Users/julie/messagingme-mba/tests/channels-me-signature.test.ts. Does the file exist?

   Test Files  1 failed (1)
        Tests  no tests
  ```

- [ ] **Step 3: Écrire l'implémentation MINIMALE (tri de surface seulement)**

  Créer le répertoire puis le fichier `src/channels-me/signature.ts` avec exactement ce contenu. C'est
  volontairement le minimum qui passe le vecteur d'or, et rien de plus : ce vecteur n'a qu'une clé plate,
  il ne peut pas exiger davantage. L'étape suivante montrera où ce minimum casse.

  ```ts
  import { createHmac } from 'node:crypto';

  /** Chaîne canonique d'un corps : JSON compact, clés triées. */
  export function corpsCanonique(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    const objet = v as Record<string, unknown>;
    const trie: Record<string, unknown> = {};
    for (const cle of Object.keys(objet).sort()) trie[cle] = objet[cle];
    return JSON.stringify(trie);
  }

  /** base64 des octets BRUTS du HMAC-SHA256. Tenu par le vecteur d'or de la documentation. */
  export function signer(canonique: string, secret: string): string {
    return createHmac('sha256', secret).update(canonique, 'utf8').digest('base64');
  }
  ```

- [ ] **Step 4: Relancer et constater que la vague A passe**

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue :

  ```
   ✓ tests/channels-me-signature.test.ts (2 tests)

   Test Files  1 passed (1)
        Tests  2 passed (2)
  ```

- [ ] **Step 5: Ajouter la vague B, le tri EN PROFONDEUR**

  Dans `tests/channels-me-signature.test.ts`, ajouter ces deux constantes juste sous celles du vecteur d'or :

  ```ts
  // Mêmes données, clés écrites dans un autre ordre À TOUS LES NIVEAUX. C'est la forme réelle d'un POST de
  // message : ce qui compte est imbriqué sous `message`, pas à la surface.
  const POST_ORDRE_A = {
    message: { text: 'Notre newsletter (cm-a7k2m9p3)', kind: 'text', media_url: null },
    apply_utms: false,
  };
  const POST_ORDRE_B = {
    apply_utms: false,
    message: { media_url: null, kind: 'text', text: 'Notre newsletter (cm-a7k2m9p3)' },
  };
  ```

  puis ce bloc à la suite du fichier :

  ```ts
  describe('tri alphabétique EN PROFONDEUR', () => {
    it('🔴 mêmes données, clés écrites dans un ordre différent : MÊME chaîne canonique', () => {
      expect(corpsCanonique(POST_ORDRE_A)).toBe(corpsCanonique(POST_ORDRE_B));
    });

    it('🔴 et cette chaîne a ses clés triées jusque DANS l objet imbriqué', () => {
      // Le test précédent tombe déjà sur un tri de surface. Celui-ci dit en plus à quoi la chaîne doit
      // ressembler, donc il attrape aussi un tri inversé ou un tri par longueur, qui rendraient eux aussi
      // deux fois la même chaîne fausse.
      expect(corpsCanonique(POST_ORDRE_A)).toBe(
        '{"apply_utms":false,"message":{"kind":"text","media_url":null,"text":"Notre newsletter (cm-a7k2m9p3)"}}',
      );
    });
  });
  ```

- [ ] **Step 6: Lancer et constater l'échec d'ASSERTION (le tri de surface ne suffit pas)**

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue, avec le diff qui montre exactement le défaut (les clés imbriquées restent dans leur
  ordre d'écriture) :

  ```
   ❯ tests/channels-me-signature.test.ts (4 tests | 2 failed)
     × tri alphabétique EN PROFONDEUR > 🔴 mêmes données, clés écrites dans un ordre différent : MÊME chaîne canonique
       → expected '{"apply_utms":false,"message":{"text"…' to be '{"apply_utms":false,"message":{"media…' // Object.is equality

  AssertionError: expected '{"apply_utms":false,"message":{"text"…' to be '{"apply_utms":false,"message":{"media…' // Object.is equality

  Expected: "{"apply_utms":false,"message":{"media_url":null,"kind":"text","text":"Notre newsletter (cm-a7k2m9p3)"}}"
  Received: "{"apply_utms":false,"message":{"text":"Notre newsletter (cm-a7k2m9p3)","kind":"text","media_url":null}}"

   Test Files  1 failed (1)
        Tests  2 failed | 2 passed (4)
  ```

- [ ] **Step 7: Généraliser `corpsCanonique` en récursif, et écrire la doctrine du module**

  Remplacer INTÉGRALEMENT `src/channels-me/signature.ts` par ce contenu :

  ```ts
  import { createHmac } from 'node:crypto';

  /**
   * Signature des appels Channels Me.
   *
   * UNE seule dérivation, et c'est ce qui rend l'ensemble correct : la MÊME chaîne canonique est signée et
   * envoyée comme corps de la requête. Dériver deux fois (signer un objet, sérialiser l'autre) est le moyen
   * le plus sûr de produire une signature qui ne correspond pas au corps, et l'API répond alors 401 sans
   * dire pourquoi. Même leçon que `zadarmaQuery` (src/zadarma/client.ts), où la chaîne signée EST la query
   * appelée.
   *
   * ⚠️ Trois modules, trois usages, à ne pas confondre : ici la signature d'un tiers ; `src/lib/signature.ts`
   * le format `v1=` cross-repo (préimage horodatée, sortie hexadécimale) ; `src/crypto/secretbox.ts` le
   * chiffrement au repos.
   */

  /**
   * Chaîne canonique d'un corps : JSON sans espaces, slashes NON échappés, clés triées alphabétiquement
   * EN PROFONDEUR.
   *
   * 🔴 LE TRI EN PROFONDEUR EST MESURÉ, PAS SUPPOSÉ (spec du 2026-09-04, §2.2). Le vecteur d'or de la
   * documentation n'a qu'UNE clé plate : il ne dit rien de la façon de signer un corps imbriqué, et un tri
   * de surface le passe quand même. Ce qui a tranché, ce sont des POST volontairement invalides :
   * l'authentification passant avant la validation, une signature fausse rend 401 et une signature juste
   * rend 422, sans jamais rien créer. Seule la forme imbriquée, triée en profondeur, a rendu 422.
   *
   * L'ordre d'un TABLEAU est une donnée, pas une présentation : il n'est jamais trié.
   */
  export function corpsCanonique(v: unknown): string {
    // Un objet qui sait se sérialiser (une Date, par exemple) se ramène d'abord à sa valeur JSON, comme le
    // ferait JSON.stringify. Sans cette ligne il tomberait dans la branche « objet », n'aurait aucune clé
    // propre énumérable, et sortirait en `{}` : un corps faux, en silence.
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return corpsCanonique((v as { toJSON: () => unknown }).toJSON());
    }
    if (Array.isArray(v)) return `[${v.map((x) => corpsCanonique(x)).join(',')}]`;
    if (v !== null && typeof v === 'object') {
      const objet = v as Record<string, unknown>;
      const membres = Object.keys(objet)
        .sort()
        // `undefined` ne s'écrit pas en JSON : JSON.stringify laisse tomber la propriété, on fait pareil.
        // C'est ce qui permet d'écrire `{ media_url: mediaUrl }` sans brancher sur l'absence d'image.
        .filter((cle) => objet[cle] !== undefined)
        .map((cle) => `${JSON.stringify(cle)}:${corpsCanonique(objet[cle])}`);
      return `{${membres.join(',')}}`;
    }
    // Primitives. Le `?? 'null'` couvre ce que JSON.stringify ne sait pas écrire (undefined, fonction,
    // symbole), exactement comme il le fait lui-même à l'intérieur d'un tableau.
    return JSON.stringify(v) ?? 'null';
  }

  /**
   * base64 des OCTETS BRUTS du HMAC-SHA256. Tenu par le vecteur d'or de la documentation, figé dans
   * `tests/channels-me-signature.test.ts`.
   *
   * ⚠️ Piège déjà payé ailleurs dans ce dépôt : Zadarma encode en base64 la représentation HEXADÉCIMALE du
   * HMAC (`signZadarma`, src/zadarma/client.ts). Ici c'est le binaire. Une signature correcte fait 44
   * caractères ; 88 signifie qu'on a encodé l'hexadécimal, et l'API rend 401 sans dire pourquoi.
   */
  export function signer(canonique: string, secret: string): string {
    return createHmac('sha256', secret).update(canonique, 'utf8').digest('base64');
  }
  ```

- [ ] **Step 8: Relancer et constater que les quatre tests passent**

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue :

  ```
   ✓ tests/channels-me-signature.test.ts (4 tests)

   Test Files  1 passed (1)
        Tests  4 passed (4)
  ```

- [ ] **Step 9: Ajouter la vague C, les verrous du contrat rendu au client**

  Ces cinq cas passent DU PREMIER COUP, et c'est attendu : ce ne sont pas des exigences nouvelles, ce sont
  des verrous sur des propriétés que l'implémentation tient déjà et dont `client.ts` dépendra. L'étape 11
  vérifie l'un d'eux dans les deux sens, pour prouver qu'ils ne sont pas décoratifs. Ajouter à la suite du
  fichier de test :

  ```ts
  describe('ce que la chaîne canonique garantit au client', () => {
    it('l ordre d un TABLEAU n est jamais touché : c est une donnée, pas une présentation', () => {
      expect(corpsCanonique({ z: [3, 1, 2], a: 'x' })).toBe('{"a":"x","z":[3,1,2]}');
    });

    it('ni espaces, ni slash échappé : l URL wa.me du post traverse telle quelle', () => {
      expect(corpsCanonique({ text: 'https://wa.me/33525680250?text=Bonjour' }))
        .toBe('{"text":"https://wa.me/33525680250?text=Bonjour"}');
    });

    it('🔴 c est du JSON VALIDE qui redonne les mêmes données : c est LUI qui part comme corps', () => {
      expect(JSON.parse(corpsCanonique(POST_ORDRE_A))).toEqual(POST_ORDRE_A);
    });

    it('signer dépend du secret ET de la chaîne', () => {
      const canonique = corpsCanonique(POST_ORDRE_A);
      expect(signer(canonique, 'secret-a')).not.toBe(signer(canonique, 'secret-b'));
      expect(signer(canonique, 'secret-a'))
        .not.toBe(signer(corpsCanonique({ ...POST_ORDRE_A, apply_utms: true }), 'secret-a'));
    });

    it('🔴 base64 des octets BRUTS : 44 caractères, jamais 88 (piège Zadarma)', () => {
      // 32 octets -> 44 caractères base64. 88 voudrait dire qu'on a encodé les 64 caractères hexadécimaux,
      // ce qui rend une signature bien formée et systématiquement refusée.
      expect(signer('nimporte quoi', 'secret')).toHaveLength(44);
    });
  });
  ```

- [ ] **Step 10: Lancer et constater les neuf tests verts**

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue :

  ```
   ✓ tests/channels-me-signature.test.ts (9 tests)

   Test Files  1 passed (1)
        Tests  9 passed (9)
  ```

- [ ] **Step 11: Vérifier le verrou du tableau DANS LES DEUX SENS, puis restaurer**

  Un test qui passe ne prouve rien tant qu'on n'a pas vu qu'il échoue sans le code qu'il garde. Remplacer
  temporairement la ligne des tableaux de `src/channels-me/signature.ts` par une version qui les trie :

  ```ts
    if (Array.isArray(v)) return `[${[...v].sort().map((x) => corpsCanonique(x)).join(',')}]`;
  ```

  ```bash
  npx vitest run tests/channels-me-signature.test.ts
  ```

  Sortie attendue, un seul cas tombe et c'est bien le bon :

  ```
     × ce que la chaîne canonique garantit au client > l ordre d un TABLEAU n est jamais touché : c est une donnée, pas une présentation
  AssertionError: expected '{"a":"x","z":[1,2,3]}' to be '{"a":"x","z":[3,1,2]}' // Object.is equality

        Tests  1 failed | 8 passed (9)
  ```

  Restaurer ensuite la ligne d'origine (sans `[...v].sort()`) et vérifier le retour au vert :

  ```bash
  git checkout -- src/channels-me/signature.ts 2>/dev/null || true
  npx vitest run tests/channels-me-signature.test.ts
  ```

  ⚠️ Le fichier n'étant pas encore commité, `git checkout --` ne le restaurera PAS : refaire la
  modification à la main (remettre `` return `[${v.map((x) => corpsCanonique(x)).join(',')}]`; ``) et
  attendre de nouveau `Tests  9 passed (9)`.

- [ ] **Step 12: Typecheck et suite unitaire complète**

  ```bash
  npm run typecheck
  npm test
  ```

  Attendu : `npm run typecheck` sort sans aucune ligne (code 0), et `npm test` rend toute la suite
  unitaire verte, avec neuf tests de plus qu'avant la tâche. Cette tâche n'ajoute AUCUN test
  d'intégration (module pur, ni base ni réseau), donc il n'y a rien à attendre du job `integration` de la
  CI au-delà de son état habituel.

- [ ] **Step 13: Committer**

  ```bash
  git add src/channels-me/signature.ts tests/channels-me-signature.test.ts
  git commit -m "feat(channels-me): le signeur, et la seule chaine qui part vraiment

  Premiere brique du sous-systeme Channels Me : la signature des appels sortants.

  UNE seule derivation, et c'est tout le sujet : la MEME chaine canonique est
  signee et envoyee comme corps. Deriver deux fois (signer un objet, serialiser
  l'autre) est le moyen le plus sur de produire une signature qui ne correspond pas
  au corps, et l'API repond alors 401 sans dire pourquoi. Meme lecon que
  zadarmaQuery, ou la chaine signee EST la query appelee.

  Le tri alphabetique EN PROFONDEUR n'est pas une precaution, il est MESURE : la
  signature porte sur la structure imbriquee, etabli par des POST volontairement
  invalides (l'auth passant avant la validation, une signature fausse rend 401 et
  une signature juste rend 422, sans jamais rien creer). Le vecteur d'or de la
  documentation ne peut pas le prouver, il n'a qu'une seule cle plate : un tri de
  surface le passe, puis casse tous les POST reels, dont le corps est {message:{}}.
  Les tests sont ecrits dans cet ordre, et le tri de surface a bien echoue avant
  d'etre generalise.

  Deux verrous en plus du vecteur d'or : la chaine canonique est du JSON valide qui
  redonne les memes donnees (c'est elle qui part comme corps), et la sortie fait 44
  caracteres, base64 des octets BRUTS. 88 voudrait dire qu'on a encode
  l'hexadecimal, piege deja paye sur Zadarma. Le verrou de l'ordre des tableaux a
  ete verifie dans les deux sens.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

  ⚠️ Le hook `rayon-de-souffle` BLOQUE le premier `git commit` pour mettre son rapport sous les yeux.
  Relancer la MÊME commande passe. Ici le rapport sera vide ou quasi vide, et c'est correct : les deux
  fichiers sont neufs, aucun symbole exporté existant n'est touché, aucune constante ne change de valeur,
  aucun commentaire voisin d'une ligne modifiée ailleurs. La question à se poser reste l'inverse, celle
  qu'on pose à un module neuf : « qu'est-ce qu'il suppose du reste du dépôt ? ». Réponse tenue, `node:crypto`
  et rien d'autre.


---

### Task 4: Jeton et texte pre-rempli

Racine du depot : `C:\Users\julie\messagingme-mba`. Tous les chemins ci-dessous en sont relatifs.

**Files:**
- Create : `src/channels-me/jeton.ts`
- Test : `tests/channels-me-jeton.test.ts` (test UNITAIRE : ni base, ni reseau, donc `tests/` et pas `tests/integration/`)
- Modify : aucun. Module neuf, il n'a par construction aucun dependant.

🔴 **Rayon de souffle, pose a l'ENVERS.** Un module neuf n'a aucun lecteur : la seule question a lui poser est
donc « qu'est-ce qu'il suppose de ce qui existe deja ? ». Il suppose exactement trois choses, et les deux
premieres sont tenues par un test de ce fichier :

1. `normalizeText` (`src/automation/match.ts:90`) minuscule, retire les accents (plage combinante U+0300 a
   U+036F) et resserre les espaces. Un jeton deja minuscule, sans accent et sans espace en sort **inchange**,
   parentheses comprises. C'est ce qui fait qu'un abonne declenche le scenario en envoyant le texte pre-rempli.
2. `keywordsOf` (`src/automation/match.ts:95`) applique la MEME `normalizeText` aux mots cles STOCKES. Le jeton
   doit donc etre invariant des deux cotes de la comparaison, pas seulement du cote message.
3. `matchesTrigger` compare en `contains` quand `triggerConfig.mode !== 'equals'`. Aucune ligne de moteur n'est
   ecrite dans cette tache, et le cablage de l'automation compagnon appartient a une autre tache.

⚠️ **Ce fichier de test ne construit AUCUN `AutomationRow`, deliberement.** L'interface `AutomationRow` gagne
un champ `maxFiresPerHour` dans la tache du plafond par automation (le rayon de souffle numero 4 du contrat) :
un litteral ecrit ici deviendrait rouge au typecheck pour une raison qui ne concerne pas cette tache. On
n'importe donc que des FONCTIONS (`normalizeText`, `keywordsOf`), dont la signature ne bouge pas. La
correspondance complete de bout en bout (`matchesTrigger` sur un vrai evenement) est prouvee par la tache du
cablage.

**Interfaces:**

- **Consumes** (rien des taches precedentes de ce plan, uniquement de l'existant) :
  - `import { normalizeText, keywordsOf } from '../src/automation/match';`
    - `export function normalizeText(v: string): string`
    - `export function keywordsOf(config: Record<string, unknown>): string[]`
  - `import { randomBytes } from 'node:crypto';`
- **Produces** (consommes par les taches suivantes : store des liens, `POST /links`, cablage de l'automation
  compagnon) :
  - `export const PREFIXE_JETON = 'cm-'`
  - `export function nouveauJeton(): string` (rend `cm-` + 8 caracteres tires dans `[0-9a-hjkmnp-tv-z]`)
  - `export function estJeton(v: string): boolean` (forme STRICTE, chaine entiere)
  - `export function textePreRempli(phrase: string, jeton: string): string` (rend `'<phrase> (<jeton>)'`)

---

- [ ] **Step 1: ecrire le fichier de test avec le premier bloc, la FORME du jeton**

Creer `tests/channels-me-jeton.test.ts` avec exactement ce contenu (le second bloc arrive au Step 5) :

```ts
import { describe, it, expect } from 'vitest';
import { PREFIXE_JETON, nouveauJeton, estJeton } from '../src/channels-me/jeton';

/**
 * Le jeton d'un lien de chaine WhatsApp (Channels Me), et le texte que l'abonne ENVOIE en appuyant sur le
 * bouton dessine par WhatsApp.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. Le jeton n'est pas devinable. C'est lui, et lui seul, qui demarre le scenario d'un client : il pose des
 *     tags, remplit des champs et envoie des messages factures. Une suite previsible (compteur, graine figee)
 *     laisserait n'importe qui declencher tout cela chez ce client.
 *  2. Aucun caractere ambigu dans la partie tiree. Un abonne peut recopier le texte a la main : un i, un l, un
 *     o ou un u recopie de travers donnerait un message qui ne declenche rien, sans que personne ne comprenne
 *     pourquoi, et le post, lui, est deja parti.
 *  3. `estJeton` est STRICT (chaine entiere). C'est un controle de forme sur NOS jetons, jamais le detecteur
 *     d'un message entrant : la reconnaissance d'un message passe par `normalizeText` puis `contains` dans
 *     `matchesTrigger`, ce que le second bloc de ce fichier verifie.
 */

const TIRAGES = 200;

describe('forme du jeton de chaine', () => {
  it('« cm- » suivi de 8 caracteres, sur 200 tirages', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const jeton = nouveauJeton();
      expect(jeton.startsWith(PREFIXE_JETON), `jeton sans prefixe : ${jeton}`).toBe(true);
      expect(jeton).toHaveLength(PREFIXE_JETON.length + 8);
    }
  });

  it('aucun caractere ambigu dans la partie tiree : ni i, ni l, ni o, ni u', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const tire = nouveauJeton().slice(PREFIXE_JETON.length);
      expect(/^[0-9a-hjkmnp-tv-z]{8}$/.test(tire), `alphabet viole : ${tire}`).toBe(true);
      expect(/[ilou]/.test(tire), `caractere ambigu tire : ${tire}`).toBe(false);
    }
  });

  it('estJeton REFUSE tout ce qui n est pas exactement un jeton', () => {
    // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
    expect(estJeton('cm-a7k2m9p3')).toBe(true);
    expect(estJeton(nouveauJeton())).toBe(true);
    expect(estJeton('Ma newsletter (cm-a7k2m9p3)')).toBe(false); // une phrase qui CONTIENT un jeton
    expect(estJeton('CM-A7K2M9P3')).toBe(false); // majuscules : nos jetons sont produits et stockes minuscules
    expect(estJeton('cm-a7k2m9p')).toBe(false); // 7 caracteres tires
    expect(estJeton('cm-a7k2m9p33')).toBe(false); // 9 caracteres tires
    expect(estJeton('cm-a7k2m9pi')).toBe(false); // « i » hors alphabet
    expect(estJeton(' cm-a7k2m9p3 ')).toBe(false); // espaces autour
    expect(estJeton('')).toBe(false);
    expect(estJeton('test-a7k2m9p3')).toBe(false); // le jeton de TEST d un scenario, autre prefixe
  });

  it('200 tirages donnent 200 jetons distincts', () => {
    const vus = new Set<string>();
    for (let i = 0; i < TIRAGES; i += 1) vus.add(nouveauJeton());
    // L'index unique de la migration 0114 exige l'unicite GLOBALE du jeton (il circule dans des messages
    // publics et il est cherche sur le chemin chaud). 40 bits de hasard la rendent pratiquement acquise ;
    // un generateur qui se repeterait se verrait ici.
    expect(vus.size).toBe(TIRAGES);
  });
});
```

- [ ] **Step 2: lancer le test et constater qu'il echoue parce que le module n'existe pas**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-jeton.test.ts
```

Sortie attendue (mesuree le 2026-09-04 sur ce depot, vitest 2.1.9) :

```
 ❯ tests/channels-me-jeton.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  tests/channels-me-jeton.test.ts [ tests/channels-me-jeton.test.ts ]
Error: Failed to load url ../src/channels-me/jeton (resolved id: ../src/channels-me/jeton) in C:/Users/julie/messagingme-mba/tests/channels-me-jeton.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: ecrire l'implementation MINIMALE, sans `textePreRempli`**

Creer `src/channels-me/jeton.ts` avec exactement ce contenu (`textePreRempli` viendra au Step 7, quand un test
l'exigera) :

```ts
import { randomBytes } from 'node:crypto';

/**
 * Le jeton de declenchement d'un lien de chaine WhatsApp (Channels Me).
 *
 * Une chaine diffuse mais n'ecoute pas. Le pont est un seul appui : le post porte une URL `wa.me` dont le
 * parametre `text=` n'est PAS le libelle du bouton (WhatsApp le dessine lui-meme) mais le message que
 * l'abonne ENVERRA. C'est donc ce texte, et lui seul, qui porte le jeton.
 *
 * Choix de forme, et pourquoi :
 *  - PREFIXE `cm-` : lisible, et il ne peut pas etre confondu avec le prefixe `test-` du jeton de test d'un
 *    scenario (`src/workflow/test-token.ts`), qui vit dans le meme espace de messages entrants.
 *  - suffixe ALEATOIRE de 8 caracteres (40 bits) : le jeton circule dans des messages publics, mais il
 *    demarre un scenario qui pose des tags et envoie des messages factures. Il ne doit pas se deviner.
 *  - alphabet minuscule SANS i, l, o ni u : pas d'ambiguite visuelle si un abonne recopie le texte a la main.
 *  - deja MINUSCULE et sans accent : c'est ce qui le fait survivre a `normalizeText` (src/automation/match.ts),
 *    appliquee des deux cotes de la comparaison, au corps du message ET au mot cle stocke. Un jeton qui n'y
 *    survivrait pas rendrait muets les boutons de tous les posts deja publies, sans lever la moindre erreur.
 *
 * Module PUR cote forme (la generation utilise crypto, aucune IO) -> testable sans base.
 * ⚠️ Le jeton n'est JAMAIS journalise : c'est l'identifiant qui declenche un scenario.
 */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LONGUEUR = 8;

export const PREFIXE_JETON = 'cm-';

/**
 * Jeton neuf : `cm-` + 8 caracteres tires.
 *
 * 256 est un multiple EXACT de 32 (la taille de l'alphabet), donc le modulo ne biaise aucun caractere.
 * Changer l'alphabet sans changer cette propriete reintroduirait un biais silencieux.
 */
export function nouveauJeton(): string {
  let out = '';
  for (const b of randomBytes(LONGUEUR)) out += ALPHABET[b % ALPHABET.length];
  return PREFIXE_JETON + out;
}

const JETON_RE = new RegExp(`^${PREFIXE_JETON}[0-9a-hjkmnp-tv-z]{${LONGUEUR}}$`);

/**
 * Cette chaine est-elle EXACTEMENT un jeton ? Controle de forme sur nos propres jetons (validation d'entree,
 * garde de test), volontairement strict : ancre aux deux bouts, minuscules seulement.
 *
 * ⚠️ Ce n'est PAS le detecteur d'un message entrant. Un abonne peut ecrire devant, derriere, ou laisser son
 * telephone capitaliser : c'est l'automation `keyword` en mode `contains`, sur le corps normalise, qui
 * reconnait le message. `estJeton` sur un corps de message repondrait presque toujours faux.
 */
export function estJeton(v: string): boolean {
  return JETON_RE.test(v);
}
```

- [ ] **Step 4: relancer le test, constater le vert du premier bloc**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-jeton.test.ts
```

Sortie attendue :

```
 ✓ tests/channels-me-jeton.test.ts (4 tests)

 Test Files  1 passed (1)
      Tests  4 passed (4)
```

- [ ] **Step 5: ajouter le second bloc de test, le texte pre-rempli et sa SURVIE a normalizeText**

Dans `tests/channels-me-jeton.test.ts`, remplacer la ligne d'import du module par ces deux lignes :

```ts
import { PREFIXE_JETON, nouveauJeton, estJeton, textePreRempli } from '../src/channels-me/jeton';
import { normalizeText, keywordsOf } from '../src/automation/match';
```

Ajouter au commentaire d'en-tete, apres le point 3, ces deux points :

```
 *  4. 🔴 LE JETON SURVIT A `normalizeText`. C'est l'invariant qui porte toute la feature : le corps du message
 *     entrant est normalise avant comparaison, donc un jeton qui ne serait pas invariant (majuscule, accent,
 *     espace) ne serait jamais retrouve. Le symptome serait muet : les boutons de tous les posts deja publies
 *     cesseraient de declencher quoi que ce soit, sans erreur, sans journal, et un post publie circule pour
 *     toujours.
 *  5. Le jeton survit AUSSI cote configuration : `keywordsOf` normalise les mots cles stockes. Les deux cotes
 *     de la comparaison doivent aboutir a la meme chaine, sinon on compare deux choses differentes.
```

Ajouter enfin ce bloc a la fin du fichier :

```ts
describe('texte pre-rempli', () => {
  // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
  const JETON = 'cm-a7k2m9p3';

  it('rend « <phrase> (<jeton>) »', () => {
    expect(textePreRempli('Je veux recevoir la newsletter', JETON))
      .toBe('Je veux recevoir la newsletter (cm-a7k2m9p3)');
  });

  it('detoure la phrase, et une phrase vide ne laisse pas d espace de tete', () => {
    expect(textePreRempli('  Je veux la newsletter  ', JETON)).toBe('Je veux la newsletter (cm-a7k2m9p3)');
    // La route de creation d'un lien refuse deja une phrase vide, mais une fonction pure doit rester totale :
    // mieux vaut le jeton seul qu'un texte qui commence par une espace.
    expect(textePreRempli('', JETON)).toBe('(cm-a7k2m9p3)');
    expect(textePreRempli('   ', JETON)).toBe('(cm-a7k2m9p3)');
  });

  it('🔴 le jeton SURVIT a normalizeText : accents, majuscules et espaces multiples', () => {
    const normalise = normalizeText(textePreRempli('Ça   m INTERESSE, à bientôt !', JETON));
    // La phrase, elle, est bien rabotee : c'est la preuve que normalizeText a reellement travaille ce texte,
    // et que le jeton n'est pas passe entre les gouttes d'une normalisation qui n'aurait rien fait.
    expect(normalise).toBe('ca m interesse, a bientot ! (cm-a7k2m9p3)');
    expect(normalise).toContain(JETON);
  });

  it('le jeton reste intact en MOT-CLE d automation (keywordsOf)', () => {
    // L'autre moitie de la correspondance. `matchesTrigger` normalise le CORPS du message, mais `keywordsOf`
    // normalise aussi les MOTS CLES stockes : un jeton doit etre invariant des deux cotes, sans quoi la
    // comparaison porterait sur deux chaines differentes et le bouton ne declencherait jamais rien.
    expect(keywordsOf({ keywords: [JETON], mode: 'contains' })).toEqual([JETON]);
    const tire = nouveauJeton();
    expect(keywordsOf({ keywords: [tire] })).toEqual([tire]);
  });

  it('200 jetons tires au hasard survivent tous a normalizeText', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const jeton = nouveauJeton();
      const normalise = normalizeText(textePreRempli('Notre newsletter du mois', jeton));
      expect(normalise, `jeton perdu a la normalisation : ${jeton}`).toContain(jeton);
    }
  });
});
```

- [ ] **Step 6: lancer le test et constater l'echec du second bloc**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-jeton.test.ts
```

Sortie attendue (message mesure le 2026-09-04 sur ce depot) : les 4 tests du premier bloc restent verts, les 5
du second echouent tous avec

```
TypeError: textePreRempli is not a function

 Test Files  1 failed (1)
      Tests  5 failed | 4 passed (9)
```

- [ ] **Step 7: ecrire `textePreRempli`**

Ajouter a la fin de `src/channels-me/jeton.ts` :

```ts
/**
 * Le texte que l'abonne ENVOIE en appuyant sur le bouton : la phrase que le client a choisie, puis le jeton
 * entre parentheses, pour qu'il se lise comme une reference technique anodine.
 *
 * ⚠️ Deux textes a ne jamais confondre : le texte du POST est ce que l'abonne LIT (il contient l'URL), celui
 * ci est ce qu'il ENVOIE (il contient le jeton). Seul le second declenche quoi que ce soit.
 *
 * La phrase est detouree : une phrase collee telle quelle depuis un traitement de texte laisserait sinon une
 * double espace avant la parenthese. Phrase vide -> le jeton seul, plutot qu'un texte commencant par une
 * espace (la route de creation refuse deja la phrase vide, mais cette fonction reste totale).
 */
export function textePreRempli(phrase: string, jeton: string): string {
  const p = phrase.trim();
  return p === '' ? `(${jeton})` : `${p} (${jeton})`;
}
```

- [ ] **Step 8: relancer le test, constater le vert complet**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-jeton.test.ts
```

Sortie attendue :

```
 ✓ tests/channels-me-jeton.test.ts (9 tests)

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

- [ ] **Step 9: typecheck et suite unitaire complete**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck
```

Sortie attendue : les deux lignes d'en-tete npm (`> messagingme-mba@0.0.1 typecheck` puis `> tsc --noEmit`) et
RIEN d'autre. Toute ligne du genre `src/channels-me/jeton.ts(NN,NN): error TS...` doit etre corrigee ici, pas
plus tard.

```bash
cd /c/Users/julie/messagingme-mba && npm test
```

Critere : aucun `failed` dans le recapitulatif final (`Test Files ... passed`, `Tests ... passed`). Cette tache
n'ajoute aucun test d'integration : `npm test` exclut `tests/integration/**`, et ce module ne touche ni la base
ni le reseau, donc il n'y a rien a y ajouter. Inutile de lancer `npm run test:integration` en local (le
`DATABASE_URL` local pointe la PRODUCTION).

- [ ] **Step 10: committer les deux fichiers, et eux seuls**

⚠️ `git add` CIBLE, jamais `git add -A` : le working tree porte des fichiers d'autres chantiers en cours
(documents d'audit non suivis, `src/automation/match.ts` modifie par la tache du plafond par automation, et des
fichiers `src/channels-me/` d'autres taches de ce meme plan).

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/jeton.ts tests/channels-me-jeton.test.ts && git status --porcelain --untracked-files=no
```

Attendu : exactement deux lignes, `A  src/channels-me/jeton.ts` et `A  tests/channels-me-jeton.test.ts`.

```bash
cd /c/Users/julie/messagingme-mba && git commit -F - <<'EOF'
feat(channels-me): le jeton d un lien de chaine, et le texte que l abonne envoie

Le jeton (cm- plus 8 caracteres, alphabet sans i l o u) relie un post de chaine
WhatsApp au scenario qu il demarre. Il voyage dans le texte PRE-REMPLI que l abonne
envoie en appuyant sur le bouton, et il est cherche en contains par une automation
keyword.

Module neuf, donc aucun dependant : la question se pose a l envers, et ce module ne
suppose qu une chose du depot, tenue par deux tests sur 200 tirages. normalizeText
minuscule, retire les accents et resserre les espaces ; elle est appliquee des DEUX
cotes de la comparaison, au corps du message par matchesTrigger et au mot cle stocke
par keywordsOf. Un jeton deja minuscule, sans accent et sans espace en sort inchange.
Si cette supposition tombait, les boutons de tous les posts deja publies cesseraient
de declencher quoi que ce soit, sans erreur et sans journal, et un post publie circule
pour toujours.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

⚠️ Le hook `rayon-de-souffle.js` (PreToolUse sur `git commit`) BLOQUE ce premier commit pour afficher la moitie
mecanique du rayon de souffle. C'est attendu : lire la sortie, puis relancer la MEME commande, qui passe (le
jeton porte l'empreinte de l'index). Le hook gitleaks tourne aussi : aucun secret ici, l'alphabet et les jetons
figes des tests sont des valeurs publiques annotees comme fictives.

- [ ] **Step 11: contre-epreuve, verifier que le test 🔴 MORD vraiment**

Un test qui passe ne prouve rien tant qu'on ne l'a pas vu echouer sans le comportement qu'il protege. On casse
donc l'invariant, on regarde le symptome, on restaure.

```bash
cd /c/Users/julie/messagingme-mba && sed -i "s/export const PREFIXE_JETON = 'cm-';/export const PREFIXE_JETON = 'CM-';/" src/channels-me/jeton.ts && npx vitest run tests/channels-me-jeton.test.ts
```

Attendu : le fichier echoue, et le test « 🔴 le jeton SURVIT a normalizeText » est dans les tombes, avec un
symptome de la forme

```
AssertionError: expected 'ca m interesse, a bientot ! (cm-a7k…' to be 'ca m interesse, a bientot ! (CM-a7k…'
```

c'est a dire : `normalizeText` a bien rabote le jeton en majuscules, donc un jeton non minuscule n'est plus
retrouvable dans le message. Tombent egalement « cm- suivi de 8 caracteres » et « estJeton REFUSE tout ce qui
n est pas exactement un jeton » (l'assertion en dur `estJeton('cm-a7k2m9p3')`). Restaurer et re-verifier :

```bash
cd /c/Users/julie/messagingme-mba && git checkout -- src/channels-me/jeton.ts && npx vitest run tests/channels-me-jeton.test.ts && git status --porcelain --untracked-files=no
```

Attendu : `Tests  9 passed (9)`, et un `git status` sans aucune ligne pour ces deux fichiers (rien a
re-committer, la contre-epreuve ne laisse pas de trace).


---

### Task 5: Types Zod et client HTTP Channels Me

**Files:**
- Create : `C:\Users\julie\messagingme-mba\src\channels-me\types.ts`
- Create : `C:\Users\julie\messagingme-mba\src\channels-me\client.ts`
- Test : `C:\Users\julie\messagingme-mba\tests\channels-me-types.test.ts` (nouveau)
- Test : `C:\Users\julie\messagingme-mba\tests\channels-me-client.test.ts` (nouveau)
- Modify : aucun. Cette tache n'ajoute ni route, ni store, ni migration, donc elle ne touche NI `src/server.ts` NI `tests/scope-tenant.test.ts` (rayon de souffle numero 1, qui appartient a la tache des routes HTTP).

**Interfaces:**

- Consumes (livre par la tache 4, `src/channels-me/signature.ts`) :
  - `export function corpsCanonique(v: unknown): string`
  - `export function signer(canonique: string, secret: string): string`
  - Et rien d'autre. Cette tache ne consomme AUCUN store, AUCUNE config, AUCUNE route.

- Produces (ce que les taches suivantes importent) :
  - depuis `src/channels-me/types.ts` :
    - `export interface Connexion { orgId: string; channelId: string; apiKey: string; secret: string }`
    - `export interface ConnexionPublique { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }`
    - `export const organisationSchema` (Zod), `export type Organisation`
    - `export const messageChannelSchema` (Zod), `export type MessageChannel`
    - `export const messageSchema` (Zod), `export type Message`
    - Formes inferees exactes : `Organisation = { id?: string; name?: string }` ; `MessageChannel = { id?: string; name?: string; messages_count?: number }` ; `Message = { id: string; kind?: string; text?: string | null; media_url?: string | null; status?: string | null; published_at?: string | null; is_draft?: boolean }`. 🔴 `Message.id` est le SEUL champ obligatoire du lot : c'est lui qui part dans `channelsme_posts.cm_message_id`.
  - depuis `src/channels-me/client.ts` :
    - `export class ChannelsMeClient { constructor(deps?: { fetch?: typeof fetch; timeoutMs?: number }); getOrganisation(cx: Connexion): Promise<Organisation>; listChannels(cx: Connexion): Promise<MessageChannel[]>; getMessages(cx: Connexion): Promise<Message[]>; createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message> }`
    - `export class ChannelsMeApiError extends Error { readonly status: number; readonly detail: string }` (⚠️ hors contrat gele, cf. `open_questions` : les routes HTTP doivent l'importer telle quelle pour traduire `status` en 4xx).

---

- [ ] **Step 1: Verifier que la tache 4 a bien livre signature.ts**

```bash
cd /c/Users/julie/messagingme-mba && ls src/channels-me/ && grep -n "export function" src/channels-me/signature.ts
```

Sortie attendue : `signature.ts` present, et les deux lignes

```
export function corpsCanonique(v: unknown): string {
export function signer(canonique: string, secret: string): string {
```

Si le fichier manque, ARRETER : cette tache en depend et l'ecrire ici creerait la deuxieme definition que le contrat gele existe justement pour empecher.

---

- [ ] **Step 2: Ecrire le test des schemas (il doit echouer)**

Creer `tests/channels-me-types.test.ts`. Aucune base, aucun reseau : il va dans `tests/`, pas dans `tests/integration/`.

```ts
import { describe, it, expect } from 'vitest';
import { organisationSchema, messageChannelSchema, messageSchema } from '../src/channels-me/types';

/**
 * Les schemas de ce qui vient de Channels Me.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Un message sans identifiant est REFUSE. Sans ce refus, une publication reussie serait tracee avec
 *     un `cm_message_id` vide, et le post, qui circule pour toujours, n'aurait plus de lien avec le jeton
 *     qui le declenche.
 *  2. Une cle inconnue est RETIREE, pas refusee : un champ ajoute chez eux ne doit ni casser la console
 *     ni traverser jusqu'a nos ecrans.
 *  3. Un identifiant entier et un identifiant chaine donnent la MEME forme en sortie, parce que la colonne
 *     qui le recoit est un `text` et que deux formes obligeraient chaque lecteur a s'en souvenir.
 */

describe('messageSchema', () => {
  it('🔴 refuse un message sans identifiant', () => {
    expect(messageSchema.safeParse({ text: 'bonjour' }).success).toBe(false);
  });

  it('range un identifiant entier en chaine et retire les cles inconnues', () => {
    const p = messageSchema.safeParse({ id: 4242, text: 'bonjour', champ_ajoute_chez_eux: 'jete' });
    expect(p.success).toBe(true);
    expect(p.success && p.data).toEqual({ id: '4242', text: 'bonjour' });
  });

  it('tolere les champs de statut absents ou nuls', () => {
    const p = messageSchema.safeParse({ id: 'msg_1', text: null, media_url: null, status: null, published_at: null });
    expect(p.success).toBe(true);
    expect(p.success && p.data.id).toBe('msg_1');
  });
});

describe('messageChannelSchema', () => {
  it('lit le compteur de publications et retire le reste', () => {
    const p = messageChannelSchema.safeParse({ id: 'ch_1', name: 'Ma chaine', messages_count: 85, autre: 1 });
    expect(p.success && p.data).toEqual({ id: 'ch_1', name: 'Ma chaine', messages_count: 85 });
  });

  it('refuse un compteur negatif', () => {
    expect(messageChannelSchema.safeParse({ messages_count: -1 }).success).toBe(false);
  });
});

describe('organisationSchema', () => {
  it('accepte un corps partiel : aucun champ n a ete mesure comme obligatoire', () => {
    expect(organisationSchema.safeParse({}).success).toBe(true);
  });

  it('refuse un champ present mais du mauvais type', () => {
    expect(organisationSchema.safeParse({ name: 42 }).success).toBe(false);
  });
});
```

---

- [ ] **Step 3: Lancer le test des schemas et constater l'echec**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-types.test.ts
```

Sortie attendue, mot pour mot (le module n'existe pas encore) :

```
 ❯ tests/channels-me-types.test.ts (0 test)

 FAIL  tests/channels-me-types.test.ts [ tests/channels-me-types.test.ts ]
Error: Failed to load url ../src/channels-me/types (resolved id: ../src/channels-me/types) in C:/Users/julie/messagingme-mba/tests/channels-me-types.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

---

- [ ] **Step 4: Ecrire src/channels-me/types.ts**

```ts
import { z } from 'zod';

/**
 * Les types de l'integration Channels Me, et les schemas Zod qui valident CE QUI VIENT DE CHEZ EUX.
 *
 * Ce que ces schemas protegent, et qui ne se voit pas a la lecture :
 *  1. Une reponse 200 dont le corps n'a pas la forme attendue n'est PAS un succes. Sans validation, un
 *     identifiant absent partirait tel quel dans `channelsme_posts.cm_message_id` : la seule trace qui
 *     relie un post publie (qui circule pour toujours) au lien qui l'a produit serait vide, sans recours.
 *  2. Les objets de ce fichier RETIRENT les cles inconnues au lieu de les refuser. Un champ ajoute chez eux
 *     ne doit pas casser la console, mais il ne doit pas non plus traverser jusqu'a nos ecrans.
 *  3. `Connexion` porte les deux secrets, `ConnexionPublique` ne les porte pas. Les deux existent pour que
 *     le compilateur refuse de servir le premier a un navigateur.
 */

/**
 * Les quatre identifiants d'une connexion Channels Me.
 *
 * En memoire uniquement, jamais serialise vers le client : c'est ce que le store rend par `getSecrets()`,
 * et c'est ce que `ChannelsMeClient` consomme.
 */
export interface Connexion {
  orgId: string;
  channelId: string;
  apiKey: string;
  secret: string;
}

/**
 * La projection servie par l'API. Les deux secrets n'y sont que des booleens : un secret ne redescend
 * jamais en clair vers le front, l'ecran affiche « une cle est enregistree », pas la cle.
 */
export interface ConnexionPublique {
  orgId: string;
  channelId: string;
  hasApiKey: boolean;
  hasSecret: boolean;
  verifiedAt: string | null;
}

/**
 * Un identifiant rendu par Channels Me. Leur API est en Rails : selon la ressource, un identifiant sort en
 * chaine ou en entier. On accepte les deux et on range TOUJOURS une chaine, pour que le reste du code
 * (colonne `cm_message_id text`, comparaisons, construction d'URL) n'ait qu'une seule forme a connaitre.
 */
const identifiant = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * L'organisation, lue par `GET /organisations/{org}`.
 *
 * Aucun champ n'est obligatoire : aucun n'a ete mesure comme tel, et l'ecran d'etat de la connexion doit
 * s'afficher meme si le fournisseur en omet un. Un champ present mais du mauvais type reste refuse.
 */
export const organisationSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
});
export type Organisation = z.infer<typeof organisationSchema>;

/**
 * Une chaine WhatsApp, lue par `GET /organisations/{org}/message_channels`.
 *
 * `messages_count` est le seul compteur MESURE (85 publications sur la chaine de demo, et la liste des
 * messages en rend bien 85). Les champs de quota mensuel ne sont pas encore mesures : les declarer au
 * hasard les rendrait toujours `undefined`, en silence, ce qui est pire que de ne pas les avoir.
 */
export const messageChannelSchema = z.object({
  id: identifiant.optional(),
  name: z.string().optional(),
  messages_count: z.number().int().nonnegative().optional(),
});
export type MessageChannel = z.infer<typeof messageChannelSchema>;

/**
 * Une publication.
 *
 * 🔴 `id` est le SEUL champ obligatoire, et il l'est vraiment : c'est lui qu'on ecrit dans
 * `channelsme_posts.cm_message_id`. Une reponse 200 sans identifiant est un ECHEC, pas un succes au champ
 * vide. Le statut reste optionnel et tolerant : il se LIT EN DIRECT a chaque affichage, on ne le miroite
 * pas, donc une forme inattendue doit degrader l'affichage, pas casser la lecture de la liste.
 */
export const messageSchema = z.object({
  id: identifiant,
  kind: z.string().optional(),
  text: z.string().nullable().optional(),
  media_url: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  is_draft: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;
```

---

- [ ] **Step 5: Relancer le test des schemas et constater le succes**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-types.test.ts
```

Sortie attendue :

```
 ✓ tests/channels-me-types.test.ts (7 tests)

 Test Files  1 passed (1)
      Tests  7 passed (7)
```

---

- [ ] **Step 6: Committer les schemas**

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/types.ts tests/channels-me-types.test.ts && git commit -m "$(cat <<'MSG'
feat(channels-me): les schemas de ce qui vient de chez eux, et le type qui porte les secrets

Un message sans identifiant est refuse : c'est cet identifiant qui part dans
channelsme_posts.cm_message_id, et un post publie circule pour toujours.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

⚠️ Le hook `rayon-de-souffle.js` bloque le PREMIER `git commit` pour afficher les dependants de ce qui a change. Relancer la MEME commande passe (le jeton porte l'empreinte de l'index). Ici la liste sera vide : les deux fichiers sont neufs et personne ne les lit encore.

---

- [ ] **Step 7: Ecrire le test du client (il doit echouer)**

Creer `tests/channels-me-client.test.ts`. Faux `fetch` INJECTE par le constructeur, aucun `globalThis` touche, aucun reseau.

```ts
import { describe, it, expect } from 'vitest';
import { ChannelsMeClient, ChannelsMeApiError } from '../src/channels-me/client';
import { signer } from '../src/channels-me/signature';
import type { Connexion } from '../src/channels-me/types';

/**
 * Client HTTP de Channels Me, teste avec un faux `fetch` injecte. Aucun reseau.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Le corps ENVOYE est exactement la chaine SIGNEE. Deux derivations separees produiraient une
 *     signature qui ne correspond pas au corps, l'API repondrait 401, et on accuserait les cles.
 *  2. `Accept: application/json` est pose sur TOUS les appels, GET compris : sans lui l'API rend une page
 *     HTML d'erreur Rails en 500, donc un echec deguise en panne de notre cote.
 *  3. La signature n'est posee que sur les ECRITURES.
 *  4. 🔴 Le corps distant ne se relaie JAMAIS : ni la page HTML, ni un champ voisin du JSON d'erreur, ni
 *     le message d'une exception reseau. Seuls le statut et `error.message` tronque survivent.
 *  5. Une 200 dont le corps n'a pas la forme attendue est un ECHEC, pas un succes aux champs vides.
 */

// Valeurs FICTIVES (aucun secret) : figees pour rendre les assertions lisibles.
const CX: Connexion = { orgId: 'org_1', channelId: 'ch_1', apiKey: 'cle-fictive', secret: 'secret-fictif' };

/** Faux fetch : enregistre les appels et rend des reponses scriptees. Le corps est garde en CHAINE BRUTE,
 *  jamais re-analyse : c'est justement l'octet-pour-octet qu'on veut comparer a ce qui a ete signe. */
function faux(reponses: Array<{ status?: number; body: string; contentType?: string }>) {
  const appels: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  let i = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    appels.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    });
  };
  return { impl: impl as unknown as typeof fetch, appels };
}

/** Faux fetch qui echoue avant toute reponse. */
function fauxEnPanne(err: Error) {
  const impl = async (): Promise<Response> => { throw err; };
  return impl as unknown as typeof fetch;
}

describe('lectures', () => {
  it('GET organisation : Accept pose, cle d API posee, AUCUNE signature, enveloppe data depliee', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 7, name: 'Ma chaine' } }) }]);
    const org = await new ChannelsMeClient({ fetch: impl }).getOrganisation(CX);
    expect(org).toEqual({ id: '7', name: 'Ma chaine' });
    expect(appels[0]!.url).toBe('https://channels-me.com/api/v1/organisations/org_1');
    expect(appels[0]!.method).toBe('GET');
    expect(appels[0]!.headers.Accept).toBe('application/json');
    expect(appels[0]!.headers['Authorization']).toBe('Bearer cle-fictive');
    // La signature n'est pas requise sur les GET : en poser une obligerait a canonicaliser une query string.
    expect(appels[0]!.headers['X-Signature']).toBeUndefined();
    expect(appels[0]!.body).toBeUndefined();
  });

  it('GET chaines : la liste est rendue en un appel, sous data', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: [{ id: 1, name: 'A', messages_count: 85 }] }) }]);
    const chaines = await new ChannelsMeClient({ fetch: impl }).listChannels(CX);
    expect(chaines).toEqual([{ id: '1', name: 'A', messages_count: 85 }]);
    expect(appels[0]!.url).toBe('https://channels-me.com/api/v1/organisations/org_1/message_channels');
    expect(appels[0]!.headers.Accept).toBe('application/json');
  });

  it('GET messages : chemin sous la chaine, liste complete', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }) }]);
    const msgs = await new ChannelsMeClient({ fetch: impl }).getMessages(CX);
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(appels[0]!.url).toBe('https://channels-me.com/api/v1/organisations/org_1/message_channels/ch_1/messages');
  });
});

describe('ecriture', () => {
  it('🔴 le corps ENVOYE est exactement la chaine SIGNEE', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 'msg_1' } }) }]);
    const msg = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'Bonjour' });
    expect(msg.id).toBe('msg_1');
    const a = appels[0]!;
    expect(a.method).toBe('POST');
    expect(a.url).toBe('https://channels-me.com/api/v1/organisations/org_1/message_channels/ch_1/messages');
    expect(a.headers['Content-Type']).toBe('application/json');
    expect(a.headers.Accept).toBe('application/json');
    // La preuve, et elle ne depend d'aucune connaissance de la forme canonique : re-signer le corps
    // REELLEMENT transmis redonne la signature REELLEMENT posee.
    expect(signer(a.body!, CX.secret)).toBe(a.headers['X-Signature']);
    // Et la signature porte sur la structure IMBRIQUEE, pas sur des cles a plat `message[kind]`.
    expect(JSON.parse(a.body!)).toEqual({ message: { kind: 'text', publish_now: true, text: 'Bonjour' } });
  });

  it('avec une image : kind image et media_url, dans le corps signe', async () => {
    const { impl, appels } = faux([{ body: JSON.stringify({ data: { id: 'msg_2' } }) }]);
    await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'Voir', mediaUrl: 'https://exemple.test/a.jpg' });
    expect(JSON.parse(appels[0]!.body!)).toEqual({
      message: { kind: 'image', media_url: 'https://exemple.test/a.jpg', publish_now: true, text: 'Voir' },
    });
    expect(signer(appels[0]!.body!, CX.secret)).toBe(appels[0]!.headers['X-Signature']);
  });
});

describe('echecs : le corps distant ne se relaie jamais', () => {
  it('401 : le statut est porte, le reste du corps est jete', async () => {
    const { impl } = faux([{
      status: 401,
      body: JSON.stringify({ error: { message: 'Invalid signature' }, debug: 'donnee-d-un-autre-espace' }),
    }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getOrganisation(CX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelsMeApiError);
    expect((err as ChannelsMeApiError).status).toBe(401);
    expect((err as ChannelsMeApiError).detail).toBe('Invalid signature');
    expect((err as Error).message).not.toContain('donnee-d-un-autre-espace');
  });

  it('422 : seul error.message remonte, tronque a 200 caracteres', async () => {
    const long = 'x'.repeat(300);
    const { impl } = faux([{ status: 422, body: JSON.stringify({ error: { message: long } }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'y' }).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(422);
    expect((err as ChannelsMeApiError).detail).toHaveLength(200);
  });

  it('500 en HTML : rien du corps ne remonte', async () => {
    const { impl } = faux([{ status: 500, body: '<html><body>Rails backtrace secret</body></html>', contentType: 'text/html' }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getMessages(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(500);
    expect((err as ChannelsMeApiError).detail).toBe('');
    expect((err as Error).message).not.toContain('Rails');
  });

  it('panne reseau : statut 0, et le message de l exception ne fuite pas', async () => {
    const client = new ChannelsMeClient({ fetch: fauxEnPanne(new Error('getaddrinfo ENOTFOUND channels-me.com')) });
    const err = await client.getOrganisation(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).status).toBe(0);
    expect((err as Error).message).not.toContain('ENOTFOUND');
  });
});

describe('reponses 200 mal formees', () => {
  it('200 sans enveloppe data : echec', async () => {
    const { impl } = faux([{ body: JSON.stringify({ id: 'msg_1' }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'x' }).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });

  it('🔴 200 dont le message n a pas d identifiant : echec, pas un succes au champ vide', async () => {
    const { impl } = faux([{ body: JSON.stringify({ data: { text: 'publie' } }) }]);
    const err = await new ChannelsMeClient({ fetch: impl }).createMessage(CX, { text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelsMeApiError);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });

  it('200 au corps illisible : echec', async () => {
    const { impl } = faux([{ body: 'pas du json du tout' }]);
    const err = await new ChannelsMeClient({ fetch: impl }).getMessages(CX).catch((e: unknown) => e);
    expect((err as ChannelsMeApiError).detail).toBe('reponse inattendue');
  });
});
```

⚠️ Ce fichier utilise `as` sur `err`, et c'est autorise : la regle « jamais de `as` sur une entree externe » vise les payloads recus a l'execution, pas le retrecissement d'un `unknown` attrape dans un test.

---

- [ ] **Step 8: Lancer le test du client et constater l'echec**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-client.test.ts
```

Sortie attendue :

```
 ❯ tests/channels-me-client.test.ts (0 test)

 FAIL  tests/channels-me-client.test.ts [ tests/channels-me-client.test.ts ]
Error: Failed to load url ../src/channels-me/client (resolved id: ../src/channels-me/client) in C:/Users/julie/messagingme-mba/tests/channels-me-client.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

---

- [ ] **Step 9: Ecrire src/channels-me/client.ts**

```ts
import { z } from 'zod';
import { corpsCanonique, signer } from './signature';
import { organisationSchema, messageChannelSchema, messageSchema } from './types';
import type { Connexion, Organisation, MessageChannel, Message } from './types';

/**
 * Client HTTP de Channels Me.
 *
 * Hote FIXE et de confiance : aucune verification d'adresse privee ici (meme traitement que les clients
 * Meta et Zadarma), le nom ne vient pas d'une saisie client.
 */

/** 🔴 A CONFIRMER contre le journal de mesure avant le premier appel reel. Une seule ligne a changer. */
const BASE = 'https://channels-me.com/api/v1';

const JSON_MIME = 'application/json';

/** L'en-tete qui porte la cle d'API du tenant. 🔴 Nom a confirmer, comme BASE. */
const ENTETE_AUTORISATION = 'Authorization';

/** L'en-tete qui porte la signature. */
const ENTETE_SIGNATURE = 'X-Signature';

/**
 * Delai maximum d'un appel. Sans plafond, un fournisseur qui accepte la connexion et ne repond jamais
 * immobilise le slot d'ou l'appel part, jusqu'au defaut d'undici, de l'ordre de cinq minutes.
 */
const DELAI_MS = 15_000;

/** Longueur maximale du seul fragment de corps distant qu'on garde. */
const DETAIL_MAX = 200;

/**
 * Echec d'un appel Channels Me.
 *
 * 🔴 LE CORPS DISTANT NE VOYAGE PAS DANS CETTE ERREUR. On ne garde que le statut et, quand la reponse est
 * du JSON valide, le seul champ `error.message`, tronque. Deux raisons mesurees : sans `Accept`, l'API rend
 * une page HTML entiere, et un corps distant peut porter des donnees d'un autre espace.
 *
 * `status` vaut 0 quand aucune reponse n'est arrivee (panne reseau, ou notre plafond a coupe).
 */
export class ChannelsMeApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`channels me HTTP ${status}${detail === '' ? '' : ` : ${detail}`}`);
    this.name = 'ChannelsMeApiError';
  }
}

/** La seule forme d'erreur distante qu'on accepte de lire. safeParse, donc aucun `as` sur un corps externe. */
const erreurDistanteSchema = z.object({ error: z.object({ message: z.string() }) });

function detailDistant(json: unknown): string {
  const p = erreurDistanteSchema.safeParse(json);
  return p.success ? p.data.error.message.slice(0, DETAIL_MAX) : '';
}

/** Notre plafond a-t-il coupe l'appel ? `AbortSignal.timeout` fait rejeter `fetch` avec un `TimeoutError`. */
function estAbandon(err: unknown): boolean {
  const nom = err instanceof Error ? err.name : '';
  return nom === 'TimeoutError' || nom === 'AbortError';
}

function cheminOrg(cx: Connexion): string {
  return `/organisations/${encodeURIComponent(cx.orgId)}`;
}

function cheminMessages(cx: Connexion): string {
  return `${cheminOrg(cx)}/message_channels/${encodeURIComponent(cx.channelId)}/messages`;
}

export class ChannelsMeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps?: { fetch?: typeof fetch; timeoutMs?: number }) {
    this.fetchImpl = deps?.fetch ?? fetch;
    this.timeoutMs = deps?.timeoutMs ?? DELAI_MS;
  }

  async getOrganisation(cx: Connexion): Promise<Organisation> {
    return this.appel(cx, 'GET', cheminOrg(cx), organisationSchema);
  }

  async listChannels(cx: Connexion): Promise<MessageChannel[]> {
    return this.appel(cx, 'GET', `${cheminOrg(cx)}/message_channels`, z.array(messageChannelSchema));
  }

  async getMessages(cx: Connexion): Promise<Message[]> {
    return this.appel(cx, 'GET', cheminMessages(cx), z.array(messageSchema));
  }

  /**
   * Publie tout de suite. `publish_now` est en dur parce que la V1 ne planifie pas : il n'y a donc pas
   * d'etat brouillon a piloter, et un parametre de plus serait un cas non teste.
   */
  async createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message> {
    const corps = {
      message: {
        kind: m.mediaUrl === undefined ? 'text' : 'image',
        publish_now: true,
        text: m.text,
        ...(m.mediaUrl === undefined ? {} : { media_url: m.mediaUrl }),
      },
    };
    return this.appel(cx, 'POST', cheminMessages(cx), messageSchema, corps);
  }

  /**
   * 🔴 UNE SEULE DERIVATION DE LA CHAINE CANONIQUE. `canonique` est SIGNEE et ENVOYEE comme corps : il
   * n'existe aucun endroit ou ce qu'on signe pourrait differer de ce qu'on transmet. Deriver deux fois
   * (signer l'objet, puis `JSON.stringify` le meme objet pour le corps) est le moyen le plus sur de
   * produire une signature qui ne correspond pas au corps, et l'API repond alors 401 sans dire pourquoi,
   * ce qui fait accuser les cles alors qu'elles sont bonnes.
   *
   * Deux autres invariants mesures tiennent dans cette methode :
   *  - `Accept: application/json` sur TOUS les appels, GET compris, sans quoi l'API rend une page HTML
   *    d'erreur Rails en 500 ;
   *  - la signature n'est posee que sur les ECRITURES. Elle n'est pas requise sur les GET, et en poser une
   *    obligerait a inventer une canonicalisation de query string que personne n'a mesuree.
   */
  private async appel<S extends z.ZodType>(
    cx: Connexion,
    methode: 'GET' | 'POST',
    chemin: string,
    interieur: S,
    corps?: unknown,
  ): Promise<z.infer<S>> {
    const canonique = corps === undefined ? null : corpsCanonique(corps);
    const entetes: Record<string, string> = { Accept: JSON_MIME, [ENTETE_AUTORISATION]: `Bearer ${cx.apiKey}` };
    if (canonique !== null) {
      entetes['Content-Type'] = JSON_MIME;
      entetes[ENTETE_SIGNATURE] = signer(canonique, cx.secret);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${chemin}`, {
        method: methode,
        headers: entetes,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(canonique === null ? {} : { body: canonique }),
      });
    } catch (err) {
      // Le message de l'exception reseau ne remonte pas : il porte l'hote, parfois l'URL complete.
      throw new ChannelsMeApiError(0, estAbandon(err) ? 'delai depasse' : 'aucune reponse');
    }

    const brut = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = brut === '' ? null : JSON.parse(brut);
    } catch {
      json = null;
    }

    if (!res.ok) throw new ChannelsMeApiError(res.status, detailDistant(json));

    // L'enveloppe est `{data: ...}`, et elle seule (mesure : les listes ne paginent pas, il n'y a pas de
    // second niveau de meta a lire). On la deplie AVANT de valider l'interieur, en deux temps, parce qu'un
    // schema d'enveloppe generique ne s'infere pas correctement.
    const enveloppe = z.object({ data: z.unknown() }).safeParse(json);
    if (!enveloppe.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    const lu = interieur.safeParse(enveloppe.data.data);
    if (!lu.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    return lu.data;
  }
}
```

⚠️ Le depliage en DEUX temps (`z.object({ data: z.unknown() })` puis `interieur.safeParse`) n'est pas un detail de style. La forme directe `z.object({ data: interieur }).safeParse(json)` COMPILE MAL avec Zod 4 quand `interieur` est un parametre generique : `tsc` rend `error TS2339: Property 'data' does not exist on type '{ [K in keyof ...` . Mesure sur ce depot le 2026-09-04, ne pas la remettre.

---

- [ ] **Step 10: Relancer le test du client et constater le succes**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-client.test.ts
```

Sortie attendue :

```
 ✓ tests/channels-me-client.test.ts (12 tests)

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

---

- [ ] **Step 11: Typechecker**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck
```

Sortie attendue : aucune ligne d'erreur, code de sortie 0. Si `TS2339: Property 'data' does not exist` apparait, c'est que le depliage de l'enveloppe a ete ecrit en une seule etape : revenir au Step 9.

---

- [ ] **Step 12: Verifier le rayon de souffle avec la suite unitaire complete**

```bash
cd /c/Users/julie/messagingme-mba && npm test
```

Attendu : `Test Files ... passed`, zero echec. Cette tache n'a EXPORTE que du neuf et n'a modifie AUCUN symbole existant, donc personne d'autre ne peut casser ; ce passage sert a le prouver, pas a le supposer.

⚠️ `npm test` ne joue que la moitie des tests : les tests d'integration ont besoin d'un Postgres et le `DATABASE_URL` local pointe la PRODUCTION. Cette tache n'en cree aucun (ni base ni reseau), donc rien de plus a lancer ici, mais regarder le run GitHub apres le push reste la regle.

---

- [ ] **Step 13: Committer le client**

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/client.ts tests/channels-me-client.test.ts && git commit -m "$(cat <<'MSG'
feat(channels-me): le client HTTP, avec une seule derivation de la chaine signee

La chaine canonique est signee ET envoyee comme corps : il n'existe aucun endroit
ou ce qu'on signe pourrait differer de ce qu'on transmet. Accept sur tous les
appels (sans lui l'API rend une page HTML en 500), signature sur les seules
ecritures, et le corps distant n'est jamais relaye : statut et error.message
tronque, rien d'autre.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

Puis `git push origin main`.


---

### Task 6: Stores Postgres (connexion chiffree, liens, posts)

**Files:**

- Create : `C:\Users\julie\messagingme-mba\src\channels-me\connection-store.pg.ts`
- Create : `C:\Users\julie\messagingme-mba\src\channels-me\link-store.pg.ts`
- Create : `C:\Users\julie\messagingme-mba\src\channels-me\post-store.pg.ts`
- Test (create) : `C:\Users\julie\messagingme-mba\tests\channels-me-connection-store.test.ts` (unitaire, faux pool, tourne en local)
- Test (create) : `C:\Users\julie\messagingme-mba\tests\channels-me-link-store.test.ts` (unitaire, faux pool, tourne en local)
- Test (create) : `C:\Users\julie\messagingme-mba\tests\channels-me-post-store.test.ts` (unitaire, faux pool, tourne en local)
- Test (create) : `C:\Users\julie\messagingme-mba\tests\integration\channels-me-stores.integration.test.ts` (Postgres reel, **CI uniquement**)
- Modify : **aucun fichier existant**. Cette tache n ajoute que des fichiers neufs, elle ne touche ni `src/server.ts`, ni `src/index.ts`, ni `tests/scope-tenant.test.ts` (c est la tache des routes qui les touchera).

**Interfaces:**

- **Consumes**
  - De la tache qui pose la migration `db/migrations/0114_channelsme.sql` : les trois tables et leurs colonnes exactes. Ce que ces stores SUPPOSENT, nom par nom :
    - `channelsme_connections (tenant_id uuid primary key, org_id text not null, channel_id text not null, api_key_enc text not null, secret_enc text not null, verified_at timestamptz, created_at timestamptz not null, updated_at timestamptz not null)`
    - `channelsme_links (id uuid pk, tenant_id uuid not null, workflow_id uuid not null, start_node_id text, token text not null, phrase text not null, automation_id uuid, max_par_heure integer, created_at timestamptz not null)`, index unique `channelsme_links_token_key (token)` et index `channelsme_links_tenant_idx (tenant_id, created_at desc)`
    - `channelsme_posts (id uuid pk, tenant_id uuid not null, cm_message_id text not null, link_id uuid, created_at timestamptz not null)`, index unique `channelsme_posts_msg_key (tenant_id, cm_message_id)` et index `channelsme_posts_tenant_idx (tenant_id, created_at desc)`
  - De la tache qui pose `src/channels-me/types.ts` :
    - `export interface Connexion { orgId: string; channelId: string; apiKey: string; secret: string }`
    - `export interface ConnexionPublique { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }`
  - Du depot, existant et inchange :
    - `encryptSecret(plaintext: string, keyHex: string): string` et `decryptSecret(payload: string, keyHex: string): string` (`src/crypto/secretbox.ts`)
    - `pgSsl(): PgSslConfig | false` (`src/db/ssl.ts`), pour le pool du test d integration
- **Produces** (ce que la tache des routes et le cablage de `src/index.ts` consommeront, signatures exactes)
  - `src/channels-me/connection-store.pg.ts`
    ```ts
    export class PgChannelsMeConnectionStore {
      constructor(pool: Pool, encryptionKey: string);
      get(tenantId: string): Promise<ConnexionPublique | null>;
      getSecrets(tenantId: string): Promise<Connexion | null>;
      upsert(tenantId: string, c: Connexion): Promise<void>;
      markVerified(tenantId: string): Promise<void>;
    }
    ```
  - `src/channels-me/link-store.pg.ts`
    ```ts
    export interface LienRow {
      id: string; tenantId: string; workflowId: string; startNodeId: string | null;
      token: string; phrase: string; automationId: string | null; maxParHeure: number | null; createdAt: string;
    }
    export class PgChannelsMeLinkStore {
      constructor(pool: Pool);
      create(tenantId: string, l: { workflowId: string; startNodeId: string | null; token: string; phrase: string; automationId: string | null; maxParHeure: number | null }): Promise<LienRow>;
      list(tenantId: string): Promise<LienRow[]>;
      byId(tenantId: string, id: string): Promise<LienRow | null>;
    }
    ```
  - `src/channels-me/post-store.pg.ts`
    ```ts
    export interface PostRow { id: string; tenantId: string; cmMessageId: string; linkId: string | null; createdAt: string }
    export class PgChannelsMePostStore {
      constructor(pool: Pool);
      create(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void>;
      list(tenantId: string): Promise<PostRow[]>;
    }
    ```

**Rayon de souffle de cette tache.** Trois fichiers neufs n ont, par construction, aucun dependant : la seule question a leur poser est l INVERSE, qu est-ce qu ils supposent de ce que les autres taches ont pose ? La reponse tient en trois points, tous verifies par les tests ci-dessous : les noms de colonnes de la migration 0114 (une faute de frappe ne se voit qu au job `integration` de la CI), la forme exacte de `Connexion` et `ConnexionPublique` (le typecheck la voit), et l ordre `created_at desc` de `list()`, qui est celui des deux index poses par la migration (en sortir ne casse rien de visible, ca ne produit qu un plan d execution different).

**Rappel qui conditionne toute la tache.** Le `DATABASE_URL` du `.env` local pointe sur la base de **PRODUCTION**. Le fichier de l etape 16 cree et supprime des tenants : il ne se lance **jamais** en local, il tourne dans le job `integration` de la CI, qui monte un Postgres jetable. Le cycle rouge/vert local est donc porte par les trois fichiers unitaires a faux pool, qui ne touchent ni base ni reseau.

---

- [ ] **Step 1: Ecrire le test unitaire du store de connexion (ROUGE)**

Creer `tests/channels-me-connection-store.test.ts` avec exactement ce contenu :

```ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { encryptSecret } from '../src/crypto/secretbox';
import { PgChannelsMeConnectionStore } from '../src/channels-me/connection-store.pg';

/**
 * La connexion Channels Me d un tenant, avec un FAUX pool (aucune base reelle), patron
 * tests/email-account-store.test.ts.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. La requete de get() ne NOMME meme pas les colonnes chiffrees. C est cette projection que la route sert
 *     au navigateur : une cle d API de chaine qui fuiterait laisserait publier a notre place sur la chaine
 *     du client.
 *  2. Le chiffrement se fait DANS le store, dans le tableau de parametres de la requete. Un clair passe en
 *     parametre serait un clair en base, donc un secret lisible dans n importe quelle sauvegarde.
 *  3. Chaque requete porte tenant_id=$1. Le pooler est superuser, la RLS est contournee : c est le SEUL
 *     controle d isolation entre clients.
 *  4. Remplacer les creds efface verified_at. Sinon l ecran annoncerait « verifiee » a propos d une cle que
 *     personne n a jamais essayee.
 */

// Cle FICTIVE (aucun secret) : 64 caracteres hex, valeur figee. Le contrat injecte la cle par le
// CONSTRUCTEUR, donc ce fichier ne depend ni de src/config.ts ni d une variable d environnement.
const CLE = 'b'.repeat(64);
const TENANT = 't1';
// Valeurs FICTIVES qui ressemblent a des secrets, pour que les assertions « le clair ne fuit nulle part »
// portent sur des chaines reconnaissables.
const CLE_API = 'cle-api-fictive-42';
const SECRET_HMAC = 'secret-hmac-fictif-42';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne rendue par le SELECT de get() : les colonnes de COLS, jamais un chiffre. `created_at` absent de
 *  COLS, `verified_at` en Date (c est ce que le driver pg rend pour un timestamptz, et le store appelle
 *  .toISOString() dessus directement). */
function lignePublique(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { org_id: 'org-1', channel_id: 'ch-1', verified_at: null, ...over };
}

/** Ligne rendue par le SELECT de getSecrets() : COLS plus les deux colonnes chiffrees, chiffrees POUR DE
 *  VRAI (un placeholder du genre 'v1.iv.tag.data' ferait planter le dechiffrement avant les assertions). */
function ligneAvecSecrets(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...lignePublique(),
    api_key_enc: encryptSecret(CLE_API, CLE),
    secret_enc: encryptSecret(SECRET_HMAC, CLE),
    ...over,
  };
}

describe('PgChannelsMeConnectionStore (faux pool, sans base reelle)', () => {
  it('🔴 get() ne nomme AUCUNE colonne chiffree et ne rend aucun secret', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [lignePublique({ verified_at: new Date('2026-09-04T10:00:00.000Z') })] },
    ]);
    const cx = await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT);

    expect(requetes).toHaveLength(1);
    // Le coeur du test : sur ce chemin, le chiffre ne quitte meme pas la base.
    expect(requetes[0]!.sql).not.toMatch(/_enc/i);
    // toEqual COMPLET : il prouve aussi qu aucun champ en trop (apiKey, secret) n est rendu.
    expect(cx).toEqual({
      orgId: 'org-1', channelId: 'ch-1', hasApiKey: true, hasSecret: true,
      verifiedAt: '2026-09-04T10:00:00.000Z',
    });
    expect((cx as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect((cx as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it('get() : aucune ligne pour ce tenant, rend null', async () => {
    const { pool } = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT)).toBeNull();
  });

  it('getSecrets() : aller-retour, les deux colonnes chiffrees redonnent les clairs', async () => {
    const { pool, requetes } = fauxPool([{ rows: [ligneAvecSecrets()] }]);
    const cx = await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT);

    expect(cx).toEqual({ orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
    // La SEULE requete du store qui a le droit de lire les colonnes chiffrees.
    expect(requetes[0]!.sql).toMatch(/api_key_enc/);
    expect(requetes[0]!.sql).toMatch(/secret_enc/);
  });

  it('getSecrets() : aucune ligne, rend null sans rien dechiffrer', async () => {
    const { pool } = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT)).toBeNull();
  });

  it('🔴 upsert() chiffre les DEUX secrets dans les parametres : aucun clair, format v1. de secretbox', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
      orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
    });

    const q = requetes[0]!;
    // Ordre des params de l INSERT : (tenant_id, org_id, channel_id, api_key_enc, secret_enc).
    const apiEnc = q.params[3] as string;
    const secretEnc = q.params[4] as string;
    expect(apiEnc.startsWith('v1.')).toBe(true);
    expect(secretEnc.startsWith('v1.')).toBe(true);
    // Le clair ne fuit dans AUCUN slot, pas seulement dans le sien.
    for (const p of q.params) {
      expect(String(p)).not.toContain(CLE_API);
      expect(String(p)).not.toContain(SECRET_HMAC);
    }
    // Deux chiffres distincts : l iv est tire au hasard a chaque appel.
    expect(apiEnc).not.toBe(secretEnc);
  });

  it('🔴 upsert() remet verified_at a null : une preuve de validite ne survit pas a la cle qu elle prouvait', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
      orgId: 'org-2', channelId: 'ch-2', apiKey: CLE_API, secret: SECRET_HMAC,
    });
    const sql = requetes[0]!.sql;
    expect(sql).toMatch(/on conflict \(tenant_id\) do update/i);
    expect(sql).toMatch(/verified_at\s*=\s*null/i);
  });

  describe('isolation tenant : tenant_id=$1 sur CHAQUE requete', () => {
    it('get()', async () => {
      const { pool, requetes } = fauxPool([{ rows: [lignePublique()] }]);
      await new PgChannelsMeConnectionStore(pool, CLE).get(TENANT);
      expect(requetes[0]!.params).toEqual([TENANT]);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    });

    it('getSecrets()', async () => {
      const { pool, requetes } = fauxPool([{ rows: [ligneAvecSecrets()] }]);
      await new PgChannelsMeConnectionStore(pool, CLE).getSecrets(TENANT);
      expect(requetes[0]!.params).toEqual([TENANT]);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
    });

    it('upsert()', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeConnectionStore(pool, CLE).upsert(TENANT, {
        orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
      });
      expect(requetes[0]!.params[0]).toBe(TENANT); // tenant_id : 1re colonne de l INSERT
      expect(requetes[0]!.sql).toMatch(/tenant_id/i);
    });

    it('markVerified()', async () => {
      const { pool, requetes } = fauxPool();
      await new PgChannelsMeConnectionStore(pool, CLE).markVerified(TENANT);
      expect(requetes[0]!.sql).toMatch(/^update channelsme_connections set verified_at\s*=\s*now\(\)/i);
      expect(requetes[0]!.sql).toMatch(/tenant_id\s*=\s*\$1/i);
      expect(requetes[0]!.params).toEqual([TENANT]);
    });
  });
});
```

---

- [ ] **Step 2: Lancer le test et CONSTATER le rouge**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-connection-store.test.ts
```

Sortie attendue, mot pour mot (vitest 2.1.9) :

```
 ❯ tests/channels-me-connection-store.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/channels-me-connection-store.test.ts [ tests/channels-me-connection-store.test.ts ]
Error: Failed to load url ../src/channels-me/connection-store.pg (resolved id: ../src/channels-me/connection-store.pg) in C:/Users/julie/messagingme-mba/tests/channels-me-connection-store.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

Ne pas passer a l etape suivante sans avoir vu cette ligne `Does the file exist?` : c est elle qui prouve que le test exerce bien le module qu on va ecrire, et pas un homonyme deja present.

---

- [ ] **Step 3: Ecrire le store de connexion**

Creer `src/channels-me/connection-store.pg.ts` avec exactement ce contenu :

```ts
import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';
import type { Connexion, ConnexionPublique } from './types';

/**
 * Colonnes de la projection PUBLIQUE de `channelsme_connections`.
 *
 * 🔴 `api_key_enc` et `secret_enc` n y figurent pas, et ne sont meme pas TRANSPORTEES : sur ce chemin, le
 * chiffre ne quitte jamais la base. C est la difference entre « le secret n est pas rendu au client » et
 * « le secret n est pas lu du tout », et c est la seconde qu on veut, parce qu elle se verifie en lisant
 * une seule requete.
 *
 * ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `ConnexionRow` et `versPublique`.
 */
const COLS = 'org_id, channel_id, verified_at';

/** Forme brute d une ligne `channelsme_connections` pour COLS, telle que Postgres la rend. Jamais un chiffre. */
interface ConnexionRow {
  org_id: string;
  channel_id: string;
  verified_at: Date | null;
}

/** Idem plus les deux colonnes chiffrees : uniquement pour getSecrets(), jamais selectionnees ailleurs. */
interface ConnexionRowAvecSecrets extends ConnexionRow {
  api_key_enc: string;
  secret_enc: string;
}

/** Ligne brute vers projection publique. Partagee par les methodes qui SELECTent COLS. */
function versPublique(r: ConnexionRow): ConnexionPublique {
  return {
    orgId: r.org_id,
    channelId: r.channel_id,
    // Les deux colonnes chiffrees sont `not null` (migration 0114) et `upsert` est leur SEUL redacteur : une
    // ligne existe si et seulement si les deux creds sont enregistres. On l affirme ici plutot que de faire
    // voyager le chiffre jusqu au mapping pour tester s il est vide.
    // ⚠️ Rendre une de ces deux colonnes nullable un jour obligerait a calculer ces booleens en SQL.
    hasApiKey: true,
    hasSecret: true,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  };
}

/**
 * La connexion Channels Me d un tenant : une ligne par tenant (cle primaire `tenant_id`), les deux secrets
 * chiffres au repos.
 *
 * Deux choses ne se negocient pas ici. Le chiffrement se fait DANS ce store, directement dans le tableau de
 * parametres de la requete : c est ce qui rend impossible de faire transiter un clair par une couche
 * superieure. Et la cle arrive par le CONSTRUCTEUR au lieu d etre lue dans la config, ce qui rend le store
 * testable sans variable d environnement, en local comme en CI.
 */
export class PgChannelsMeConnectionStore {
  constructor(private readonly pool: Pool, private readonly encryptionKey: string) {}

  /** Ce que l API a le droit de rendre : jamais un secret, seulement leur PRESENCE. */
  async get(tenantId: string): Promise<ConnexionPublique | null> {
    const { rows } = await this.pool.query<ConnexionRow>(
      `select ${COLS} from channelsme_connections where tenant_id=$1`,
      [tenantId],
    );
    return rows[0] ? versPublique(rows[0]) : null;
  }

  /**
   * Les creds DECHIFFRES, pour appeler Channels Me depuis le serveur.
   * En memoire uniquement, jamais serialise vers le client.
   */
  async getSecrets(tenantId: string): Promise<Connexion | null> {
    const { rows } = await this.pool.query<ConnexionRowAvecSecrets>(
      `select ${COLS}, api_key_enc, secret_enc from channelsme_connections where tenant_id=$1`,
      [tenantId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      orgId: row.org_id,
      channelId: row.channel_id,
      apiKey: decryptSecret(row.api_key_enc, this.encryptionKey),
      secret: decryptSecret(row.secret_enc, this.encryptionKey),
    };
  }

  /**
   * Provisionne ou REMPLACE les creds du tenant (une ligne par tenant, d ou l upsert sur la cle primaire).
   *
   * 🔴 `verified_at` retombe a null a chaque ecriture. Une preuve de validite porte sur les creds qui ont ete
   * essayes, pas sur la ligne qui les contient : garder l ancienne date ferait dire a l ecran « connexion
   * verifiee » a propos d une cle que personne n a jamais essayee.
   */
  async upsert(tenantId: string, c: Connexion): Promise<void> {
    await this.pool.query(
      `insert into channelsme_connections (tenant_id, org_id, channel_id, api_key_enc, secret_enc, updated_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (tenant_id) do update set
         org_id = excluded.org_id,
         channel_id = excluded.channel_id,
         api_key_enc = excluded.api_key_enc,
         secret_enc = excluded.secret_enc,
         verified_at = null,
         updated_at = now()`,
      [
        tenantId, c.orgId, c.channelId,
        encryptSecret(c.apiKey, this.encryptionKey),
        encryptSecret(c.secret, this.encryptionKey),
      ],
    );
  }

  /** Les creds viennent d etre essayes contre Channels Me et ils marchent. */
  async markVerified(tenantId: string): Promise<void> {
    await this.pool.query(
      `update channelsme_connections set verified_at = now(), updated_at = now() where tenant_id=$1`,
      [tenantId],
    );
  }
}
```

---

- [ ] **Step 4: Relancer et CONSTATER le vert, puis type-checker**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-connection-store.test.ts && npm run typecheck
```

Sortie attendue : `Test Files  1 passed (1)` et `Tests  10 passed (10)`, puis `npm run typecheck` qui ne produit **aucune** sortie (tsc muet). Si le typecheck sort `error TS2307: Cannot find module './types'`, c est que la tache qui pose `src/channels-me/types.ts` n a pas ete faite : la faire avant de continuer, ne pas inventer les types ici.

---

- [ ] **Step 5: Committer le store de connexion**

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/connection-store.pg.ts tests/channels-me-connection-store.test.ts && git commit -F- <<'EOF'
feat(channels-me): la connexion d un tenant, ses deux secrets chiffres dans le store

get() ne nomme meme pas les colonnes chiffrees : sur ce chemin le chiffre ne quitte pas
la base, et c est ce que le test verifie. getSecrets() est la seule requete qui les lit.
Remplacer les creds efface verified_at, une preuve de validite ne survit pas a la cle
qu elle prouvait.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

⚠️ Le hook `rayon-de-souffle.js` **bloque ce premier `git commit`** pour afficher les dependants des symboles touches. C est attendu : relancer la MEME commande, elle passe (le jeton porte l empreinte de l index).

---

- [ ] **Step 6: Ecrire le test unitaire du store de liens (ROUGE)**

Creer `tests/channels-me-link-store.test.ts` avec exactement ce contenu :

```ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgChannelsMeLinkStore } from '../src/channels-me/link-store.pg';

/**
 * Les liens de chaine, avec un FAUX pool (aucune base reelle).
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Le lien n a PAS d etat allume ou eteint a lui. Son etat EST le `enabled` de son automation
 *     compagnon, et c est la seule source de verite. Aucune requete de ce store ne doit donc parler de
 *     `enabled` : un second drapeau divergerait au premier chemin qui n ecrirait qu une des deux copies.
 *  2. list() trie par created_at desc, ordre exact de l index channelsme_links_tenant_idx
 *     (tenant_id, created_at desc) pose par la migration 0114. En sortir ne casse rien de visible, ca ne
 *     produit qu un plan d execution different, donc rien ne le signalerait.
 *  3. Chaque requete porte tenant_id, y compris byId() ou l id primaire suffirait techniquement : c est le
 *     seul controle d isolation, le pooler etant superuser.
 *  4. Le mapping rend des dates en ISO, jamais un objet Date brut (le contrat expose createdAt: string).
 */

const TENANT = 't1';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne `channelsme_links` telle que Postgres la rend (created_at en Date, comme le driver pg). */
function ligneLien(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lnk-1', tenant_id: TENANT, workflow_id: 'wf-1', start_node_id: null,
    // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
    token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter', automation_id: 'auto-1',
    max_par_heure: 5000, created_at: new Date('2026-09-04T10:00:00.000Z'),
    ...over,
  };
}

describe('PgChannelsMeLinkStore (faux pool, sans base reelle)', () => {
  it('create() : insert scope tenant, params dans le bon ordre, ligne rendue mappee en camelCase', async () => {
    const { pool, requetes } = fauxPool([{ rows: [ligneLien()] }]);
    const lien = await new PgChannelsMeLinkStore(pool).create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3',
      phrase: 'Je veux recevoir la newsletter', automationId: 'auto-1', maxParHeure: 5000,
    });

    const q = requetes[0]!;
    expect(q.sql).toMatch(/^insert into channelsme_links/i);
    expect(q.sql).toMatch(/returning/i); // le store ne relit jamais en 2e requete ce que l INSERT peut rendre
    expect(q.params).toEqual([TENANT, 'wf-1', null, 'cm-a7k2m9p3', 'Je veux recevoir la newsletter', 'auto-1', 5000]);
    expect(lien).toEqual({
      id: 'lnk-1', tenantId: TENANT, workflowId: 'wf-1', startNodeId: null,
      token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter', automationId: 'auto-1',
      maxParHeure: 5000, createdAt: '2026-09-04T10:00:00.000Z',
    });
  });

  it('create() : les champs facultatifs a null traversent tels quels (aucun plafond, aucun bloc de depart)', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [ligneLien({ start_node_id: null, automation_id: null, max_par_heure: null })] },
    ]);
    const lien = await new PgChannelsMeLinkStore(pool).create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3', phrase: 'Bonjour',
      automationId: null, maxParHeure: null,
    });

    expect(requetes[0]!.params).toEqual([TENANT, 'wf-1', null, 'cm-a7k2m9p3', 'Bonjour', null, null]);
    // null et pas undefined : `max_par_heure` null veut dire « plafond global de l instance », pas « zero ».
    expect(lien.maxParHeure).toBeNull();
    expect(lien.automationId).toBeNull();
    expect(lien.startNodeId).toBeNull();
  });

  it('list() : trie par created_at desc, ordre exact de l index channelsme_links_tenant_idx', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [ligneLien(), ligneLien({ id: 'lnk-2', token: 'cm-b8n3q4r5' })] },
    ]);
    const liens = await new PgChannelsMeLinkStore(pool).list(TENANT);

    expect(requetes[0]!.sql).toMatch(/where tenant_id=\$1 order by created_at desc/i);
    expect(requetes[0]!.params).toEqual([TENANT]);
    expect(liens.map((l) => l.id)).toEqual(['lnk-1', 'lnk-2']);
    expect(liens[0]!.createdAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('byId() : scope tenant ET id ; aucune ligne rend null', async () => {
    const trouve = fauxPool([{ rows: [ligneLien()] }]);
    const lien = await new PgChannelsMeLinkStore(trouve.pool).byId(TENANT, 'lnk-1');
    expect(lien?.id).toBe('lnk-1');
    expect(trouve.requetes[0]!.sql).toMatch(/where tenant_id=\$1 and id=\$2/i);
    expect(trouve.requetes[0]!.params).toEqual([TENANT, 'lnk-1']);

    const absent = fauxPool([{ rows: [] }]);
    expect(await new PgChannelsMeLinkStore(absent.pool).byId(TENANT, 'lnk-inconnu')).toBeNull();
  });

  it('🔴 aucune requete de ce store ne parle de enabled : l etat du lien EST celui de son automation', async () => {
    const { pool, requetes } = fauxPool([{ rows: [ligneLien()] }]);
    const store = new PgChannelsMeLinkStore(pool);
    await store.create(TENANT, {
      workflowId: 'wf-1', startNodeId: null, token: 'cm-a7k2m9p3', phrase: 'Bonjour',
      automationId: 'auto-1', maxParHeure: null,
    });
    await store.list(TENANT);
    await store.byId(TENANT, 'lnk-1');

    expect(requetes).toHaveLength(3);
    for (const q of requetes) expect(q.sql).not.toMatch(/enabled/i);
    // Et toutes portent tenant_id, y compris byId() ou l id primaire suffirait techniquement.
    for (const q of requetes) expect(q.sql).toMatch(/tenant_id/i);
  });
});
```

---

- [ ] **Step 7: Lancer le test des liens et CONSTATER le rouge**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-link-store.test.ts
```

Sortie attendue :

```
 FAIL  tests/channels-me-link-store.test.ts [ tests/channels-me-link-store.test.ts ]
Error: Failed to load url ../src/channels-me/link-store.pg (resolved id: ../src/channels-me/link-store.pg) in C:/Users/julie/messagingme-mba/tests/channels-me-link-store.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

---

- [ ] **Step 8: Ecrire le store de liens**

Creer `src/channels-me/link-store.pg.ts` avec exactement ce contenu :

```ts
import type { Pool } from 'pg';

/**
 * Une ligne de `channelsme_links`, telle que les routes et la console la lisent.
 *
 * 🔴 Pas de champ `enabled`, et ce n est pas un oubli : l etat allume ou eteint du lien EST le `enabled` de
 * son automation compagnon, seule source de verite. Poser un second drapeau ici creerait deux copies du
 * meme etat, qui divergeraient au premier chemin qui n ecrirait qu une des deux.
 */
export interface LienRow {
  id: string;
  tenantId: string;
  workflowId: string;
  startNodeId: string | null;
  token: string;
  phrase: string;
  automationId: string | null;
  /** Plafond horaire PROPRE a ce lien. null veut dire « plafond global de l instance », pas « zero ». */
  maxParHeure: number | null;
  createdAt: string;
}

/** ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `LienRowBrut` et `versLien`. */
const COLS = 'id, tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure, created_at';

/** Forme brute d une ligne `channelsme_links` (colonnes de COLS) telle que Postgres la rend. */
interface LienRowBrut {
  id: string;
  tenant_id: string;
  workflow_id: string;
  start_node_id: string | null;
  token: string;
  phrase: string;
  automation_id: string | null;
  max_par_heure: number | null;
  created_at: Date;
}

function versLien(r: LienRowBrut): LienRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workflowId: r.workflow_id,
    startNodeId: r.start_node_id,
    token: r.token,
    phrase: r.phrase,
    automationId: r.automation_id,
    maxParHeure: r.max_par_heure,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Les liens de chaine d un tenant : un jeton, une phrase, un scenario, et l automation compagnon qui les
 * relie.
 *
 * Ce store ne sait ni allumer ni eteindre un lien : cet etat vit sur l automation, pas ici. Il ne sait pas
 * non plus repointer un lien vers un autre scenario, ce qui est une decision produit et pas une lacune (un
 * autre scenario veut un autre lien, donc un autre jeton, donc une autre mesure de conversion).
 */
export class PgChannelsMeLinkStore {
  constructor(private readonly pool: Pool) {}

  /**
   * ⚠️ `automationId` est fourni A LA CREATION, il ne se pose pas apres coup : l automation compagnon se cree
   * AVANT le lien (elle ne reference pas le lien, elle porte juste sa marque de possession), donc son id est
   * deja connu quand on arrive ici.
   */
  async create(
    tenantId: string,
    l: {
      workflowId: string;
      startNodeId: string | null;
      token: string;
      phrase: string;
      automationId: string | null;
      maxParHeure: number | null;
    },
  ): Promise<LienRow> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `insert into channelsme_links
         (tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`,
      [tenantId, l.workflowId, l.startNodeId, l.token, l.phrase, l.automationId, l.maxParHeure],
    );
    return versLien(rows[0]!);
  }

  /** 🔴 `order by created_at desc` : c est l ordre de l index channelsme_links_tenant_idx (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<LienRow[]> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS} from channelsme_links where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versLien);
  }

  async byId(tenantId: string, id: string): Promise<LienRow | null> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS} from channelsme_links where tenant_id=$1 and id=$2`,
      [tenantId, id],
    );
    return rows[0] ? versLien(rows[0]) : null;
  }
}
```

---

- [ ] **Step 9: Relancer les liens et CONSTATER le vert, puis type-checker**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-link-store.test.ts && npm run typecheck
```

Sortie attendue : `Test Files  1 passed (1)` et `Tests  5 passed (5)`, puis aucune sortie du typecheck.

---

- [ ] **Step 10: Committer le store de liens**

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/link-store.pg.ts tests/channels-me-link-store.test.ts && git commit -F- <<'EOF'
feat(channels-me): les liens de chaine, sans etat allume a eux

Le lien n a pas de colonne enabled : son etat EST le enabled de son automation
compagnon, seule source de verite. Un test verifie qu aucune requete du store ne parle
de enabled, et que list() trie dans l ordre exact de son index.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

- [ ] **Step 11: Ecrire le test unitaire du store de posts (ROUGE)**

Creer `tests/channels-me-post-store.test.ts` avec exactement ce contenu :

```ts
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgChannelsMePostStore } from '../src/channels-me/post-store.pg';

/**
 * La trace des publications, avec un FAUX pool (aucune base reelle).
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Aucun STATUT n est stocke. Le statut d un post se lit en direct chez Channels Me : le miroiter
 *     creerait une copie a resynchroniser, donc une file de rattrapage, donc un etat qui ment quand elle
 *     prend du retard. Cette table ne porte que le rattachement post vers lien.
 *  2. create() rend void et ne fait AUCUN returning : l appelant vient de publier, il n a rien a relire.
 *  3. Chaque requete porte tenant_id, seul controle d isolation (pooler superuser, RLS contournee).
 *  4. Le mapping rend createdAt en ISO, jamais un objet Date brut.
 */

const TENANT = 't1';

interface Reponse { rows: Array<Record<string, unknown>>; rowCount?: number }

/** Faux pool : enregistre SQL et params, repond selon l ordre des appels. Aucune base, aucun reseau. */
function fauxPool(reponses: Reponse[] = []) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const r = reponses[Math.min(i, reponses.length - 1)] ?? { rows: [] };
      i += 1;
      return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

/** Ligne `channelsme_posts` telle que Postgres la rend (created_at en Date, comme le driver pg). */
function lignePost(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pst-1', tenant_id: TENANT, cm_message_id: 'cmmsg-1001', link_id: 'lnk-1',
    created_at: new Date('2026-09-04T10:00:00.000Z'),
    ...over,
  };
}

describe('PgChannelsMePostStore (faux pool, sans base reelle)', () => {
  it('create() : insert scope tenant, params dans le bon ordre, aucun returning et aucun retour', async () => {
    const { pool, requetes } = fauxPool();
    const retour = await new PgChannelsMePostStore(pool).create(TENANT, {
      cmMessageId: 'cmmsg-1001', linkId: 'lnk-1',
    });

    const q = requetes[0]!;
    expect(q.sql).toMatch(/^insert into channelsme_posts/i);
    expect(q.sql).not.toMatch(/returning/i);
    expect(q.params).toEqual([TENANT, 'cmmsg-1001', 'lnk-1']);
    expect(retour).toBeUndefined();
  });

  it('create() : un post sans lien (linkId null) est accepte tel quel', async () => {
    const { pool, requetes } = fauxPool();
    await new PgChannelsMePostStore(pool).create(TENANT, { cmMessageId: 'cmmsg-1002', linkId: null });
    expect(requetes[0]!.params).toEqual([TENANT, 'cmmsg-1002', null]);
  });

  it('list() : trie par created_at desc, mapping en camelCase, createdAt en ISO', async () => {
    const { pool, requetes } = fauxPool([
      { rows: [lignePost(), lignePost({ id: 'pst-2', cm_message_id: 'cmmsg-1002', link_id: null })] },
    ]);
    const posts = await new PgChannelsMePostStore(pool).list(TENANT);

    expect(requetes[0]!.sql).toMatch(/where tenant_id=\$1 order by created_at desc/i);
    expect(requetes[0]!.params).toEqual([TENANT]);
    expect(posts[0]).toEqual({
      id: 'pst-1', tenantId: TENANT, cmMessageId: 'cmmsg-1001', linkId: 'lnk-1',
      createdAt: '2026-09-04T10:00:00.000Z',
    });
    expect(posts[1]!.linkId).toBeNull();
  });

  it('🔴 aucune requete ne stocke ni ne lit un statut : il se lit en direct chez Channels Me', async () => {
    const { pool, requetes } = fauxPool([{ rows: [lignePost()] }]);
    const store = new PgChannelsMePostStore(pool);
    await store.create(TENANT, { cmMessageId: 'cmmsg-1001', linkId: 'lnk-1' });
    await store.list(TENANT);

    expect(requetes).toHaveLength(2);
    for (const q of requetes) {
      expect(q.sql).not.toMatch(/status|statut|published_at|state/i);
      expect(q.sql).toMatch(/tenant_id/i);
    }
  });
});
```

---

- [ ] **Step 12: Lancer le test des posts et CONSTATER le rouge**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-post-store.test.ts
```

Sortie attendue :

```
 FAIL  tests/channels-me-post-store.test.ts [ tests/channels-me-post-store.test.ts ]
Error: Failed to load url ../src/channels-me/post-store.pg (resolved id: ../src/channels-me/post-store.pg) in C:/Users/julie/messagingme-mba/tests/channels-me-post-store.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

---

- [ ] **Step 13: Ecrire le store de posts**

Creer `src/channels-me/post-store.pg.ts` avec exactement ce contenu :

```ts
import type { Pool } from 'pg';

/**
 * Une ligne de `channelsme_posts` : le rattachement entre une publication faite CHEZ Channels Me et le lien
 * de chaine qu elle portait.
 *
 * 🔴 Aucun statut ici. Le statut d un post se lit en direct chez Channels Me : le miroiter creerait une
 * copie a resynchroniser, donc une file de rattrapage, donc un etat qui ment des qu elle prend du retard.
 */
export interface PostRow {
  id: string;
  tenantId: string;
  /** Identifiant du message CHEZ Channels Me, pas chez nous. */
  cmMessageId: string;
  linkId: string | null;
  createdAt: string;
}

/** ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `PostRowBrut` et `versPost`. */
const COLS = 'id, tenant_id, cm_message_id, link_id, created_at';

/** Forme brute d une ligne `channelsme_posts` (colonnes de COLS) telle que Postgres la rend. */
interface PostRowBrut {
  id: string;
  tenant_id: string;
  cm_message_id: string;
  link_id: string | null;
  created_at: Date;
}

function versPost(r: PostRowBrut): PostRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    cmMessageId: r.cm_message_id,
    linkId: r.link_id,
    createdAt: r.created_at.toISOString(),
  };
}

/** Les publications d un tenant. Table de TRACE : on y ecrit apres une publication reussie, on y lit pour
 *  rattacher chaque post a son lien et donc a son scenario. */
export class PgChannelsMePostStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Trace une publication REUSSIE.
   *
   * `Promise<void>` et donc aucun `returning` : l appelant vient de publier chez Channels Me, il tient deja
   * l identifiant du message, il n a rien a relire de cette ligne.
   */
  async create(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void> {
    await this.pool.query(
      `insert into channelsme_posts (tenant_id, cm_message_id, link_id) values ($1,$2,$3)`,
      [tenantId, p.cmMessageId, p.linkId],
    );
  }

  /** 🔴 `order by created_at desc` : c est l ordre de l index channelsme_posts_tenant_idx (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<PostRow[]> {
    const { rows } = await this.pool.query<PostRowBrut>(
      `select ${COLS} from channelsme_posts where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versPost);
  }
}
```

---

- [ ] **Step 14: Relancer les posts et CONSTATER le vert, puis type-checker et repasser tout le gate unitaire**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/channels-me-post-store.test.ts && npm run typecheck && npm test 2>&1 | tail -5
```

Sortie attendue : `Test Files  1 passed (1)` puis `Tests  4 passed (4)`, aucune sortie du typecheck, et enfin le gate complet. La reference d avant cette tache est `Test Files 283 passed (283)` / `Tests 3680 passed (3680)` : on doit lire **286 fichiers** et **3699 tests** (283 + 3 fichiers, 3680 + 10 + 5 + 4 tests). Un total different veut dire qu un fichier existant a change de comportement, ce qui n est pas cense arriver dans cette tache.

---

- [ ] **Step 15: Committer le store de posts**

```bash
cd /c/Users/julie/messagingme-mba && git add src/channels-me/post-store.pg.ts tests/channels-me-post-store.test.ts && git commit -F- <<'EOF'
feat(channels-me): la trace des publications, sans statut miroite

Le statut d un post se lit en direct chez Channels Me. Cette table ne porte que le
rattachement post vers lien, et un test verifie qu aucune requete ne parle de statut :
une copie a resynchroniser aurait demande une file de rattrapage.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

- [ ] **Step 16: Ecrire le test d integration des trois stores (Postgres reel, CI uniquement)**

Creer `tests/integration/channels-me-stores.integration.test.ts` avec exactement ce contenu :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgChannelsMeConnectionStore } from '../../src/channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from '../../src/channels-me/link-store.pg';
import { PgChannelsMePostStore } from '../../src/channels-me/post-store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca
// (job `integration`) : c est la qu il doit tourner. `describe.skipIf(!url)` le rend inerte si DATABASE_URL
// n est pas defini, mais ne protege pas contre un DATABASE_URL defini qui pointerait sur la prod.
const url = process.env.DATABASE_URL ?? '';

/**
 * Les trois stores Channels Me contre un vrai Postgres.
 *
 * 🔴 POURQUOI EN INTEGRATION ET PAS AVEC UN DOUBLE. Tout ce qui compte ici est du SQL ou de la cryptographie
 * au repos : que les deux secrets soient REELLEMENT chiffres dans leurs colonnes (un faux pool dit oui a
 * tout), que la clause `where tenant_id` isole vraiment deux clients, et que les deux index uniques poses
 * par la migration 0114 refusent vraiment un doublon. Les tests a faux pool prouvent la FORME des requetes,
 * ceux-ci prouvent leur EFFET.
 */

// Cle FICTIVE (aucun secret) : 64 caracteres hex, valeur figee. Le contrat injecte la cle par le
// constructeur du store, donc ce fichier ne depend PAS de l ENCRYPTION_KEY jetable que la CI tire pour les
// tests du store SMTP.
const CLE = 'c'.repeat(64);
const CLE_API = 'cle-api-channelsme-itest';
const SECRET_HMAC = 'secret-hmac-channelsme-itest';

describe.skipIf(!url)('Stores Channels Me (Postgres reel)', () => {
  let pool: Pool;
  let tenantId: string;
  let autreTenantId: string;
  let workflowId: string;
  let autreWorkflowId: string;
  let automationId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    const t = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme') returning id`,
    );
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-channelsme-autre') returning id`,
    );
    autreTenantId = t2.rows[0]!.id;

    // Un scenario par tenant : `channelsme_links.workflow_id` est une cle etrangere sur `workflows`.
    const wf = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-channelsme-wf') returning id`, [tenantId],
    );
    workflowId = wf.rows[0]!.id;
    const wf2 = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-channelsme-wf-autre') returning id`, [autreTenantId],
    );
    autreWorkflowId = wf2.rows[0]!.id;

    // L automation compagnon, creee ETEINTE comme le fera la route (elle s allume a la publication).
    const auto = await pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, trigger_kind, trigger_config, workflow_id)
       values ($1, 'itest-channelsme-auto', 'keyword', '{"keywords":["cm-itest001"],"mode":"contains"}'::jsonb, $2)
       returning id`,
      [tenantId, workflowId],
    );
    automationId = auto.rows[0]!.id;
  });

  afterAll(async () => {
    // 🔴 ON NETTOIE A LA MAIN, contrairement a l usage du depot (« les lignes partent par cascade avec le
    // tenant »). La migration 0114 pose DEUX cles etrangeres en `on delete restrict` : workflow_id du lien,
    // et link_id du post. Supprimer le tenant cascade EN MEME TEMPS vers `workflows`, `channelsme_links` et
    // `channelsme_posts`, et l ordre entre ces branches n est pas garanti ; or RESTRICT n est PAS differable,
    // donc une branche qui supprime un workflow avant son lien fait echouer tout le nettoyage. On retire
    // les enfants d abord, du plus profond au moins profond.
    for (const t of [tenantId, autreTenantId]) {
      if (!t) continue;
      await pool.query('delete from channelsme_posts where tenant_id = $1', [t]);
      await pool.query('delete from channelsme_links where tenant_id = $1', [t]);
    }
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  describe('PgChannelsMeConnectionStore', () => {
    it('🔴 les deux secrets sont CHIFFRES dans leurs colonnes, et get() ne les rend pas', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });

      // Le seul test qui prouve le chiffrement au repos : on relit les colonnes BRUTES. Un store qui
      // oublierait encryptSecret passerait tous les autres.
      const brut = (await pool.query<{ api_key_enc: string; secret_enc: string }>(
        `select api_key_enc, secret_enc from channelsme_connections where tenant_id = $1`, [tenantId],
      )).rows[0]!;
      expect(brut.api_key_enc).not.toContain(CLE_API);
      expect(brut.secret_enc).not.toContain(SECRET_HMAC);
      expect(brut.api_key_enc.startsWith('v1.')).toBe(true);
      expect(brut.secret_enc.startsWith('v1.')).toBe(true);

      const publique = await store.get(tenantId);
      expect(publique).toEqual({
        orgId: 'org-1', channelId: 'ch-1', hasApiKey: true, hasSecret: true, verifiedAt: null,
      });
      expect((publique as unknown as Record<string, unknown>).apiKey).toBeUndefined();
      expect((publique as unknown as Record<string, unknown>).secret).toBeUndefined();
    });

    it('getSecrets() : aller-retour reel, les deux clairs reviennent', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
      expect(await store.getSecrets(tenantId)).toEqual({
        orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC,
      });
    });

    it('🔴 remplacer les creds efface verified_at, et markVerified le repose', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-1', channelId: 'ch-1', apiKey: CLE_API, secret: SECRET_HMAC });
      expect((await store.get(tenantId))?.verifiedAt).toBeNull();

      await store.markVerified(tenantId);
      expect((await store.get(tenantId))?.verifiedAt).not.toBeNull();

      // Nouveaux creds : la preuve de validite portait sur les ANCIENS, elle tombe.
      await store.upsert(tenantId, { orgId: 'org-2', channelId: 'ch-2', apiKey: 'autre-cle', secret: 'autre-secret' });
      const apres = await store.get(tenantId);
      expect(apres?.orgId).toBe('org-2');
      expect(apres?.verifiedAt).toBeNull();
      expect((await store.getSecrets(tenantId))?.apiKey).toBe('autre-cle');
    });

    it('isolation cross-tenant REELLE : rien de ce qui se fait au nom d un autre tenant ne touche la connexion du proprietaire', async () => {
      const store = new PgChannelsMeConnectionStore(pool, CLE);
      await store.upsert(tenantId, { orgId: 'org-proprio', channelId: 'ch-proprio', apiKey: CLE_API, secret: SECRET_HMAC });
      await store.markVerified(tenantId);

      // Le voisin ne voit rien, ni en public ni en clair.
      expect(await store.get(autreTenantId)).toBeNull();
      expect(await store.getSecrets(autreTenantId)).toBeNull();
      // markVerified sur un tenant sans ligne : void, ne doit rien toucher, juste ne pas planter.
      await store.markVerified(autreTenantId);

      // Et le voisin peut avoir la SIENNE sans ecraser celle du proprietaire (cle primaire tenant_id).
      await store.upsert(autreTenantId, { orgId: 'org-voisin', channelId: 'ch-voisin', apiKey: 'cle-voisine', secret: 'secret-voisin' });

      const proprio = await store.get(tenantId);
      expect(proprio?.orgId).toBe('org-proprio');
      expect(proprio?.verifiedAt).not.toBeNull(); // aucune des tentatives voisines n a laisse de trace
      expect((await store.getSecrets(autreTenantId))?.apiKey).toBe('cle-voisine');
    });
  });

  describe('PgChannelsMeLinkStore', () => {
    it('create() + list() + byId() : aller-retour reel, mapping et tri par created_at desc', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      const un = await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest001',
        phrase: 'Je veux recevoir la newsletter', automationId, maxParHeure: 5000,
      });
      expect(un.id).toBeTruthy();
      expect(un.tenantId).toBe(tenantId);
      expect(un.maxParHeure).toBe(5000);
      expect(un.automationId).toBe(automationId);
      expect(typeof un.createdAt).toBe('string'); // ISO, jamais un objet Date

      const deux = await store.create(tenantId, {
        workflowId, startNodeId: 'nod_abc', token: 'cm-itest002',
        phrase: 'Je veux le guide', automationId: null, maxParHeure: null,
      });

      const liste = await store.list(tenantId);
      expect(liste.map((l) => l.token).slice(0, 2)).toEqual(['cm-itest002', 'cm-itest001']); // plus recent d abord
      expect(await store.byId(tenantId, deux.id)).toMatchObject({ startNodeId: 'nod_abc', maxParHeure: null });
    });

    it('🔴 le jeton est unique GLOBALEMENT, pas par tenant : refuse aussi chez un AUTRE tenant', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Bonjour',
        automationId: null, maxParHeure: null,
      });

      // Meme tenant : refuse (comme partout ailleurs dans le depot).
      await expect(store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Bonjour bis',
        automationId: null, maxParHeure: null,
      })).rejects.toThrow();

      // ⚠️ AUTRE tenant : refuse AUSSI, et c est l inverse de l usage du depot (index scopes tenant_id). Le
      // jeton est cherche sur le chemin chaud a partir du seul message entrant : deux tenants qui
      // partageraient un jeton rendraient le declenchement ambigu.
      await expect(store.create(autreTenantId, {
        workflowId: autreWorkflowId, startNodeId: null, token: 'cm-itest003', phrase: 'Chez le voisin',
        automationId: null, maxParHeure: null,
      })).rejects.toThrow();
    });

    it('isolation cross-tenant REELLE : un lien ne se voit ni en liste ni par id depuis un autre tenant', async () => {
      const store = new PgChannelsMeLinkStore(pool);
      const lien = await store.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest004', phrase: 'Isolation',
        automationId: null, maxParHeure: null,
      });

      expect(await store.byId(autreTenantId, lien.id)).toBeNull();
      expect((await store.list(autreTenantId)).some((l) => l.id === lien.id)).toBe(false);
      // Le proprietaire, lui, le voit toujours : aucune tentative voisine n a laisse de trace.
      expect((await store.byId(tenantId, lien.id))?.phrase).toBe('Isolation');
    });
  });

  describe('PgChannelsMePostStore', () => {
    it('create() + list() : aller-retour reel, avec lien puis sans lien', async () => {
      const liens = new PgChannelsMeLinkStore(pool);
      const posts = new PgChannelsMePostStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest005', phrase: 'Post',
        automationId: null, maxParHeure: null,
      });

      await posts.create(tenantId, { cmMessageId: 'cmmsg-2001', linkId: lien.id });
      await posts.create(tenantId, { cmMessageId: 'cmmsg-2002', linkId: null });

      const liste = await posts.list(tenantId);
      expect(liste.map((p) => p.cmMessageId).slice(0, 2)).toEqual(['cmmsg-2002', 'cmmsg-2001']);
      expect(liste.find((p) => p.cmMessageId === 'cmmsg-2001')?.linkId).toBe(lien.id);
      expect(liste.find((p) => p.cmMessageId === 'cmmsg-2002')?.linkId).toBeNull();
    });

    it('unicite (tenant_id, cm_message_id) : doublon refuse sur le MEME tenant, libre sur un AUTRE', async () => {
      const posts = new PgChannelsMePostStore(pool);
      await posts.create(tenantId, { cmMessageId: 'cmmsg-3001', linkId: null });
      await expect(posts.create(tenantId, { cmMessageId: 'cmmsg-3001', linkId: null })).rejects.toThrow();

      // Index scope tenant_id, cette fois : le meme identifiant chez un AUTRE tenant ne rentre pas en conflit.
      await posts.create(autreTenantId, { cmMessageId: 'cmmsg-3001', linkId: null });
      expect((await posts.list(autreTenantId)).some((p) => p.cmMessageId === 'cmmsg-3001')).toBe(true);
    });

    it('🔴 un lien reference par un post ne se supprime pas : la ceinture qui rend l extinction obligatoire', async () => {
      const liens = new PgChannelsMeLinkStore(pool);
      const posts = new PgChannelsMePostStore(pool);
      const lien = await liens.create(tenantId, {
        workflowId, startNodeId: null, token: 'cm-itest006', phrase: 'Restrict',
        automationId: null, maxParHeure: null,
      });
      await posts.create(tenantId, { cmMessageId: 'cmmsg-4001', linkId: lien.id });

      // Un post publie circule pour toujours : la suppression dure laisserait un bouton mort sans trace.
      // La route repondra 409 et proposera l extinction ; cette contrainte est la ceinture sous la route.
      await expect(pool.query('delete from channelsme_links where id = $1', [lien.id])).rejects.toThrow();
      expect(await liens.byId(tenantId, lien.id)).not.toBeNull();
    });

    it('isolation cross-tenant REELLE : les posts du proprietaire ne se voient pas du voisin', async () => {
      const posts = new PgChannelsMePostStore(pool);
      await posts.create(tenantId, { cmMessageId: 'cmmsg-5001', linkId: null });
      expect((await posts.list(autreTenantId)).some((p) => p.cmMessageId === 'cmmsg-5001')).toBe(false);
      expect((await posts.list(tenantId)).some((p) => p.cmMessageId === 'cmmsg-5001')).toBe(true);
    });
  });
});
```

---

- [ ] **Step 17: Verifier que le fichier d integration compile et reste INERTE dans le gate unitaire (sans jamais le lancer en local)**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test 2>&1 | grep -i "channels-me"
```

Sortie attendue : aucune sortie du typecheck (le dossier `tests` est dans `tsconfig.include`, donc ce fichier EST compile), puis exactement trois lignes, les trois fichiers unitaires :

```
 ✓ tests/channels-me-connection-store.test.ts (10 tests) ...
 ✓ tests/channels-me-link-store.test.ts (5 tests) ...
 ✓ tests/channels-me-post-store.test.ts (4 tests) ...
```

Aucune ligne ne doit mentionner `channels-me-stores.integration` : `vitest.config.ts` exclut `tests/integration/**` du gate unitaire. 🔴 **Ne PAS lancer `npm run test:integration` depuis ce poste** : le `DATABASE_URL` local est celui de la production et ce fichier cree puis supprime des tenants.

---

- [ ] **Step 18: Committer, pousser, et regarder le job d integration de la CI**

```bash
cd /c/Users/julie/messagingme-mba && git add tests/integration/channels-me-stores.integration.test.ts && git commit -F- <<'EOF'
test(channels-me): les trois stores contre un vrai Postgres

Chiffrement au repos verifie en relisant les colonnes brutes, isolation cross-tenant
exercee methode par methode, et les deux index uniques de la 0114 testes dans les deux
sens (le jeton est unique GLOBALEMENT, l identifiant de message par tenant).

Le nettoyage retire les enfants a la main : deux cles etrangeres en on delete restrict
rendent l ordre du cascade de tenant non garanti, et RESTRICT n est pas differable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
git push origin main
```

Puis, sans attendre autre chose (un `npm test` vert en local ne prouve que la moitie : les tests de cette etape ne tournent qu en CI) :

```bash
cd /c/Users/julie/messagingme-mba && gh run list --limit 3 && gh run watch
```

Attendu : le job `integration` vert. S il sort `relation "channelsme_connections" does not exist`, la migration `0114_channelsme.sql` n est pas sur `main` : elle doit y etre avant ce commit, la CI joue `npm run migrate` avant `npm run test:integration`. S il sort `column ... does not exist`, un nom de colonne de mes stores ne correspond pas a la migration : corriger le STORE, pas la migration, c est elle le contrat.


---

### Task 7: Automations : possession et plafond par automation

Trois changements en chaine dans le moteur d'automations existant, tous ADDITIFS, tous a rayon de souffle :
la possession (`possede_par`) qui met une automation compagnon hors de portee de l'ecran Automation, le
plafond horaire PROPRE a une automation (`max_fires_per_hour`) qui remonte jusqu'a `AutomationRow`, et la
seule ligne du runner qui les fait servir. Rien de Channels Me n'est ecrit ici : cette tache prepare le
terrain pour que le lien de chaine puisse fabriquer son automation compagnon sans casser l'existant.

**Files:**
- Modify : `src/automation/store.pg.ts` (constante `HORS_WEBHOOK`, `COLS`, `interface Raw`, `toRow`, `AutomationInput`, insert de `create`)
- Modify : `src/automation/match.ts` (`AutomationRow` gagne `maxFiresPerHour`)
- Modify : `src/automation/runner.ts` (le plafond de l'automation l'emporte sur celui de l'instance)
- Create (test) : `tests/automation-possession.test.ts`
- Create (test) : `tests/integration/automation-possession.integration.test.ts`
- Modify (test) : `tests/automation-runner.test.ts` (fabrique `auto` + nouveaux cas de plafond)
- Modify (test) : `tests/http-automations.test.ts` (garde : le corps HTTP ne peut pas poser ces deux champs)
- Modify (test, mecanique) : `tests/automation-match.test.ts`, `tests/automation-date-sweep.test.ts`, `tests/automation-webhook.test.ts`, `tests/http-hubspot-events.test.ts` (fabriques `AutomationRow` a completer)
- Lu, PAS modifie : `src/worker.ts` (ligne 302, le cablage du plafond global reste tel quel), `src/webhook-entrant/store.pg.ts` (il ecrit ses propres requetes et ne construit jamais un `AutomationRow`), `src/http/automations.ts` (son `parseBody` est deja une liste fermee)

**Interfaces:**

- Consumes (de la tache de la migration, `db/migrations/0114_channelsme.sql`, deja ecrite) :
  ```sql
  alter table automations add column if not exists possede_par text;
  alter table automations add column if not exists max_fires_per_hour integer;
  ```
- Consumes (existant du depot, signatures inchangees) :
  ```ts
  class PgAutomationStore {
    constructor(pool: Pool)
    list(tenantId: string): Promise<AutomationRow[]>
    listEnabled(tenantId: string, kinds: readonly AutomationTriggerKind[]): Promise<AutomationRow[]>
    getById(id: string, tenantId: string): Promise<AutomationRow | null>
    create(tenantId: string, input: AutomationInput): Promise<{ id: string }>
    update(id: string, tenantId: string, patch: Partial<AutomationInput>): Promise<boolean>
    remove(id: string, tenantId: string): Promise<boolean>
  }
  export async function runAutomations(tenantId: string, ev: AutomationEvent, deps: AutomationRunnerDeps): Promise<number>
  ```
- Produces (ce que les taches Channels Me suivantes consomment, signatures exactes) :
  ```ts
  // src/automation/match.ts
  export interface AutomationRow {
    id: string; tenantId: string; name: string; enabled: boolean;
    triggerKind: AutomationTriggerKind; triggerConfig: Record<string, unknown>;
    conditionGroup: ConditionGroup | null; workflowId: string; startNodeId: string | null;
    cooldownSeconds: number | null;
    maxFiresPerHour: number | null;   // NOUVEAU, requis, null = plafond global de l'instance
  }

  // src/automation/store.pg.ts
  export interface AutomationInput {
    name: string; triggerKind: AutomationTriggerKind; triggerConfig: Record<string, unknown>;
    conditionGroup: unknown; workflowId: string; startNodeId: string | null;
    cooldownSeconds: number | null; enabled: boolean;
    possedePar?: string | null;       // NOUVEAU, 'channelsme_link' pour un lien de chaine
    maxFiresPerHour?: number | null;  // NOUVEAU
  }
  ```
  Contrat de comportement que les taches suivantes peuvent tenir pour acquis :
  `create()` est le SEUL chemin de ce store qui accepte une automation possedee ; `list()`, `getById()`,
  `update()` et `remove()` la REFUSENT desormais (null / false), et `listEnabled()` (chemin chaud) la voit
  toujours, avec son `maxFiresPerHour`.

---

- [ ] **Step 1: Verifier que la migration 0114 porte bien les deux colonnes additives**

  Cette tache SUPPOSE la migration deja ecrite par la tache qui cree `db/migrations/0114_channelsme.sql`.
  On ne cree pas un `0115` de rattrapage : le compteur de migrations de `CLAUDE.md` a deja derive deux fois
  dans une seule journee, et une seconde migration pour les memes colonnes serait exactement ce qui le fait
  deriver.

  ```bash
  grep -n "possede_par\|max_fires_per_hour" db/migrations/0114_channelsme.sql
  ```

  Sortie attendue, exactement ces deux lignes (les numeros peuvent bouger) :
  ```
  215:alter table automations add column if not exists possede_par text;
  218:alter table automations add column if not exists max_fires_per_hour integer;
  ```

  Si la commande ne rend RIEN : arreter ici et faire d'abord la tache de la migration. Ecrire du code qui
  lit `max_fires_per_hour` alors que la colonne n'existe pas casse la production EN SILENCE, le chemin chaud
  echouant en boucle sur `column ... does not exist`.

- [ ] **Step 2: Enumerer les dependants AVANT d'ecrire (rayon de souffle)**

  Regle du depot : avant de committer, on enumere qui LIT ce qu'on change. Trois commandes, une minute.

  ```bash
  grep -rn "from automations" --include=*.ts src
  grep -rn "AutomationRow" --include=*.ts src tests | grep -v "src/automation/match.ts"
  grep -rn "maxFiresPerHour\|firedSince" --include=*.ts src tests
  ```

  Ce que la sortie doit confirmer, et qui pilote tous les pas suivants :
  - les seules requetes qui SELECTionnent des colonnes d'automation vers un `AutomationRow` sont dans
    `src/automation/store.pg.ts` (via `COLS`). `src/webhook-entrant/store.pg.ts` touche la table mais avec
    ses propres requetes et sa propre ligne brute : il n'est PAS concerne par `COLS` ;
  - les constructeurs d'objets `AutomationRow` hors du store sont tous dans les tests :
    `tests/automation-runner.test.ts:21`, `tests/automation-match.test.ts:16` et `:226`,
    `tests/automation-date-sweep.test.ts:12`, `tests/automation-webhook.test.ts:21`,
    `tests/http-hubspot-events.test.ts:141`, `tests/http-automations.test.ts:41` (le `getById` du faux cablage) ;
  - `maxFiresPerHour` n'a aujourd'hui QUE deux lecteurs : `src/automation/runner.ts:145-152` et le cablage
    `src/worker.ts:302` (`config.AUTOMATION_MAX_FIRES_PER_HOUR`, defaut 200, `src/config.ts:368`).

  Aucun fichier de `web/` n'est concerne : le front a son propre type `Automation`
  (`web/lib/api/integrations.ts:138`), qui ne porte pas ces champs et n'a pas a les porter dans cette tache.

- [ ] **Step 3: Ecrire le test unitaire de la possession (fake pool, aucune base)**

  Creer `tests/automation-possession.test.ts` :

  ```ts
  import { describe, it, expect } from 'vitest';
  import type { Pool } from 'pg';
  import { PgAutomationStore } from '../src/automation/store.pg';

  /**
   * Possession d'une automation par autre chose que l'ecran Automation (colonne `possede_par`, migration 0114).
   *
   * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
   *  1. Les QUATRE requetes de pilotage (`list`, `getById`, `update`, `remove`) excluent une automation
   *     possedee. Sans ce prédicat, l'ecran Automation propose de modifier ou de supprimer le compagnon d'un
   *     lien de chaine, et le bouton d'un post DEJA PUBLIE cesse de declencher, sans trace et sans recours :
   *     un post publie circule pour toujours.
   *  2. Le chemin CHAUD (`listEnabled`) ne porte PAS ce predicat et ne doit jamais le porter : l'y ajouter
   *     rendrait muets le webhook ET le lien de chaine, c'est-a-dire l'inverse du but.
   *  3. `create` sait POSER un proprietaire et un plafond : c'est par la qu'un lien de chaine fabrique son
   *     automation compagnon, `create` etant la seule methode du store sans predicat de possession.
   *
   * Fake pool (aucune base reelle), patron `tests/email-account-store.test.ts` : on capture le SQL et les
   * params. Le comportement REEL du predicat se prouve contre un vrai Postgres, en CI, dans
   * `tests/integration/automation-possession.integration.test.ts`.
   */
  function fakePool() {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/^insert into automations/i.test(sql)) return { rows: [{ id: 'a-neuve' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    return { pool, queries };
  }

  const TENANT = 't1';

  describe('PgAutomationStore : une automation POSSEDEE est hors de portee de l ecran', () => {
    it('🔴 les quatre requetes de pilotage excluent une automation possedee', async () => {
      const { pool, queries } = fakePool();
      const store = new PgAutomationStore(pool);
      await store.list(TENANT);
      await store.getById('a1', TENANT);
      await store.update('a1', TENANT, { name: 'x' });
      await store.remove('a1', TENANT);

      expect(queries).toHaveLength(4);
      for (const q of queries) {
        expect(q.sql, `cette requete laisse une automation possedee a portee de l ecran : ${q.sql}`)
          .toContain('possede_par is null');
        // Le premier terme n'a pas ete perdu au passage : les webhooks restent exclus comme avant.
        expect(q.sql).toContain("trigger_kind <> 'webhook'");
      }
    });

    it('le chemin CHAUD voit tout : `listEnabled` ne porte PAS le predicat', async () => {
      const { pool, queries } = fakePool();
      await new PgAutomationStore(pool).listEnabled(TENANT, ['keyword']);
      expect(queries).toHaveLength(1);
      expect(queries[0]!.sql).not.toContain('possede_par');
    });

    it('`create` pose le proprietaire et le plafond, et met null quand ils sont absents', async () => {
      const possedee = fakePool();
      await new PgAutomationStore(possedee.pool).create(TENANT, {
        name: 'Chaine : newsletter',
        triggerKind: 'keyword',
        // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
        triggerConfig: { keywords: ['cm-a7k2m9p3'], mode: 'contains' },
        conditionGroup: null,
        workflowId: 'wf1',
        startNodeId: null,
        cooldownSeconds: 300,
        enabled: false,
        possedePar: 'channelsme_link',
        maxFiresPerHour: 2000,
      });
      const ins = possedee.queries[0]!;
      expect(ins.sql).toContain('possede_par');
      expect(ins.sql).toContain('max_fires_per_hour');
      // Ordre des params de l'INSERT :
      // (tenant, name, enabled, kind, cfg, group, workflow, node, cooldown, possede_par, max_fires_per_hour)
      expect(ins.params[9]).toBe('channelsme_link');
      expect(ins.params[10]).toBe(2000);

      const ordinaire = fakePool();
      await new PgAutomationStore(ordinaire.pool).create(TENANT, {
        name: 'Mot-cle rdv', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] },
        conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, enabled: false,
      });
      // Une automation ordinaire n'a ni proprietaire ni plafond propre : les deux colonnes partent a null,
      // et c'est ce qui rend le changement ADDITIF pour les 200 automations deja en base.
      expect(ordinaire.queries[0]!.params[9]).toBeNull();
      expect(ordinaire.queries[0]!.params[10]).toBeNull();
    });
  });
  ```

- [ ] **Step 4: Lancer ce test et constater l'echec**

  ```bash
  npx vitest run tests/automation-possession.test.ts
  ```

  Sortie attendue : 2 cas en echec sur 3 (le cas `listEnabled` passe deja, c'est normal, il decrit ce qui ne
  doit PAS changer). Les messages, de cette forme :
  ```
  FAIL  tests/automation-possession.test.ts > 🔴 les quatre requetes de pilotage excluent une automation possedee
  AssertionError: cette requete laisse une automation possedee a portee de l ecran : select id, tenant_id, ...
    from automations where tenant_id = $1 and trigger_kind <> 'webhook' order by created_at desc limit 200
  expected '...' to contain 'possede_par is null'

  FAIL  tests/automation-possession.test.ts > `create` pose le proprietaire et le plafond
  AssertionError: expected undefined to be 'channelsme_link'
  ```

  Et, en plus du runtime, le typecheck refuse deja `possedePar` (verification facultative ici, elle sera
  faite pour de bon au Step 15) :
  ```bash
  npm run typecheck
  ```
  ```
  tests/automation-possession.test.ts(...): error TS2353: Object literal may only specify known properties, and 'possedePar' does not exist in type 'AutomationInput'.
  ```

- [ ] **Step 5: Elargir le predicat de possession dans `src/automation/store.pg.ts`**

  Remplacer le bloc de commentaire et la constante (ligne 56 a 66) par :

  ```ts
  /**
   * DEUX familles d'automations sont possedees par autre chose que l'ecran Automation, et ce predicat les met
   * hors de portee de CE store, donc de cet ecran.
   *
   * 1. `trigger_kind = 'webhook'` (migration 0074) : creees, modifiees et supprimees depuis l'ecran
   *    Tools > Webhooks, via `PgWebhookStore`, qui ecrit ses propres requetes.
   * 2. `possede_par is not null` (migration 0114) : le proprietaire se nomme dans la colonne,
   *    'channelsme_link' pour un lien de chaine WhatsApp. Sans ce second terme, une automation `keyword`
   *    posee par un lien resterait listable, modifiable et supprimable ici : un PATCH la reaffecterait a un
   *    autre declencheur, un DELETE la retirerait, et le bouton d'un post DEJA PUBLIE cesserait de declencher
   *    en silence. Un post publie circule pour toujours, il n'y a pas de retour arriere.
   *
   * Sans ce predicat, l'invariant ne tiendrait qu'au fait que l'identifiant de ces lignes n'est expose nulle
   * part : vrai aujourd'hui, faux le jour ou une route le rend pour une raison quelconque.
   *
   * ⚠️ `listEnabled` (chemin chaud) ne le porte PAS et ne doit jamais le porter : l'y ajouter rendrait muets
   * le webhook ET le lien de chaine. `create` non plus, evidemment : c'est par la qu'une automation possedee
   * naît.
   *
   * Le NOM de la constante reste `HORS_WEBHOOK` alors qu'elle couvre desormais deux familles : la renommer
   * dans le meme commit melerait un renommage a un changement de comportement, et rendrait la relecture du
   * second impossible.
   */
  const HORS_WEBHOOK = "and trigger_kind <> 'webhook' and possede_par is null";
  ```

  Puis, dans `AutomationInput` (lignes 7 a 16), ajouter les deux champs APRES `enabled` :

  ```ts
    enabled: boolean;
    /**
     * Proprietaire de cette automation quand elle en a un ('channelsme_link' pour un lien de chaine).
     * Absent ou null = automation ordinaire, pilotee depuis l'ecran Automation.
     *
     * ⚠️ N'est JAMAIS lu du corps d'une requete HTTP : `parseBody` (`src/http/automations.ts`) recopie une
     * liste FERMEE de champs. Un client qui pourrait le poser se fabriquerait une automation que son propre
     * ecran ne liste plus, ne modifie plus et ne supprime plus.
     */
    possedePar?: string | null;
    /**
     * Plafond horaire de declenchements propre a cette automation. Absent ou null = plafond global de
     * l'instance (`AUTOMATION_MAX_FIRES_PER_HOUR`). Meme remarque que ci-dessus : il ne se regle pas depuis
     * l'ecran, il desserrerait la garde qui borne des envois factures.
     */
    maxFiresPerHour?: number | null;
  ```

  Et l'insert de `create` (ligne 115) devient :

  ```ts
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, possede_par, max_fires_per_hour)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
      [
        tenantId, input.name, input.enabled, input.triggerKind,
        JSON.stringify(input.triggerConfig),
        input.conditionGroup === null ? null : JSON.stringify(input.conditionGroup),
        input.workflowId, input.startNodeId, input.cooldownSeconds,
        input.possedePar ?? null, input.maxFiresPerHour ?? null,
      ],
  ```

- [ ] **Step 6: Relancer le test de possession et constater le vert**

  ```bash
  npx vitest run tests/automation-possession.test.ts
  ```

  Sortie attendue :
  ```
  Test Files  1 passed (1)
       Tests  3 passed (3)
  ```

  Puis verifier que le predicat elargi n'a rien casse ailleurs, en particulier les automations webhook :
  ```bash
  npx vitest run tests/automation-webhook.test.ts tests/http-automations.test.ts
  ```
  Sortie attendue : `Test Files  2 passed (2)`.

- [ ] **Step 7: Ecrire les nouveaux cas de plafond dans `tests/automation-runner.test.ts`**

  Deux modifications dans ce fichier. D'abord la ligne 1, pour pouvoir capturer le journal :

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  ```

  Ensuite, AJOUTER les cinq cas suivants a la FIN du bloc existant
  `describe('plafond par automation (borne le fan-out de masse)', ...)`, sans toucher aux trois cas qui s'y
  trouvent deja (ils decrivent le plafond de l'instance, qui ne change pas) :

  ```ts
    // 🔴 Le plafond de l'AUTOMATION l'emporte sur celui de l'instance, dans les DEUX SENS. Ce reglage existe
    // pour un cas precis : un lien de chaine WhatsApp, dont un seul post peut faire arriver des milliers
    // d'abonnes en quelques minutes. Desserrer le plafond GLOBAL pour lui aurait desserre la garde qui borne
    // la facture de toutes les autres automations, alors que la conversation ouverte par un abonne, elle, ne
    // coute rien (c'est lui qui ecrit le premier).
    it('🔴 le plafond de l AUTOMATION l emporte quand il est plus STRICT que celui de l instance', async () => {
      const { deps, trace } = make([auto({ maxFiresPerHour: 5 })], { firedSince: async () => 5, maxFiresPerHour: 200 });
      expect(await runAutomations('t1', MSG, deps)).toBe(0);
      expect(trace.started).toEqual([]);
      // Le tir n'est pas consomme : le plafond est verifie AVANT `markFired`, sinon l'anti-rebond avalerait
      // en silence la prochaine vraie demande du client.
      expect(trace.fired).toEqual([]);
    });

    it('🔴 le plafond de l AUTOMATION l emporte quand il est plus LARGE : le cas du lien de chaine', async () => {
      const { deps, trace } = make([auto({ maxFiresPerHour: 5000 })], { firedSince: async () => 250, maxFiresPerHour: 200 });
      expect(await runAutomations('t1', MSG, deps)).toBe(1);
      expect(trace.started).toHaveLength(1);
    });

    it('automation SANS plafond propre (null) -> celui de l instance s applique, dans les deux sens', async () => {
      const bloque = make([auto({ maxFiresPerHour: null })], { firedSince: async () => 200, maxFiresPerHour: 200 });
      expect(await runAutomations('t1', MSG, bloque.deps)).toBe(0);
      const passe = make([auto({ maxFiresPerHour: null })], { firedSince: async () => 199, maxFiresPerHour: 200 });
      expect(await runAutomations('t1', MSG, passe.deps)).toBe(1);
    });

    it('plafond propre a 0 -> aucun plafond pour CETTE automation, meme si l instance en a un', async () => {
      // Meme convention que le plafond global (« 0 desactive explicitement le garde-fou ») : le `??` ne
      // retombe pas sur le global, parce que 0 n'est pas null. C'est un choix assume, pas un effet de bord.
      const { deps } = make([auto({ maxFiresPerHour: 0 })], { firedSince: async () => 10_000, maxFiresPerHour: 200 });
      expect(await runAutomations('t1', MSG, deps)).toBe(1);
    });

    it('le journal annonce le plafond REELLEMENT applique, pas celui de l instance', async () => {
      // Une automation n'a aucun ecran ou afficher la raison d'un saut : le log est le seul endroit ou elle
      // vit. Y annoncer 200 alors que 5 a tranche enverrait chercher le reglage au mauvais endroit.
      const lignes: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lignes.push(a.map(String).join(' ')); });
      const { deps } = make([auto({ maxFiresPerHour: 5 })], { firedSince: async () => 5, maxFiresPerHour: 200 });
      await runAutomations('t1', MSG, deps);
      spy.mockRestore();
      expect(lignes.join('\n')).toContain('plafond de 5 déclenchements/heure');
      expect(lignes.join('\n')).not.toContain('plafond de 200');
    });
  ```

- [ ] **Step 8: Lancer les tests du runner et constater l'echec**

  ```bash
  npx vitest run tests/automation-runner.test.ts
  ```

  Sortie attendue : 3 cas en echec (les deux cas `null` et le cas `0` passent deja, puisque sans le correctif
  le plafond global s'applique de toute facon). Les messages :
  ```
  FAIL  ... > 🔴 le plafond de l AUTOMATION l emporte quand il est plus STRICT que celui de l instance
  AssertionError: expected 1 to be 0

  FAIL  ... > 🔴 le plafond de l AUTOMATION l emporte quand il est plus LARGE : le cas du lien de chaine
  AssertionError: expected 0 to be 1

  FAIL  ... > le journal annonce le plafond REELLEMENT applique, pas celui de l instance
  AssertionError: expected '' to contain 'plafond de 5 déclenchements/heure'
  ```
  (le dernier message peut aussi montrer la ligne avec `plafond de 200`, selon l'ordre d'evaluation.)

  C'est la preuve dans les deux sens du correctif du runner : sans lui, un plafond propre plus strict ne
  bloque pas, et un plafond propre plus large ne laisse pas passer.

- [ ] **Step 9: Ajouter `maxFiresPerHour` a `AutomationRow` (`src/automation/match.ts`)**

  Remplacer la fin de l'interface (ligne 57 a 59) par :

  ```ts
    /** null = défaut serveur. 0 = aucun anti-rebond. */
    cooldownSeconds: number | null;
    /**
     * Plafond horaire de declenchements PROPRE a cette automation. null = plafond global de l'instance
     * (`AUTOMATION_MAX_FIRES_PER_HOUR`), qui reste la regle pour toutes les automations ordinaires.
     * 0 = aucun plafond, meme convention que le reglage global.
     *
     * Requis et non optionnel a dessein : c'est le compilateur qui doit enumerer tous les endroits qui
     * fabriquent une ligne d'automation, sinon un cablage muet retomberait sur `undefined` sans que rien ne
     * le dise, et le plafond global s'appliquerait la ou on croyait l'avoir desserre.
     */
    maxFiresPerHour: number | null;
  }
  ```

- [ ] **Step 10: Laisser le compilateur enumerer les fabriques cassees**

  ```bash
  npm run typecheck
  ```

  Sortie attendue : une erreur `TS2739` (ou `TS2741`) par fabrique d'`AutomationRow`, exactement la liste
  relevee au Step 2 :
  ```
  src/automation/store.pg.ts(40,10): error TS2739: Type '{ id: string; ... }' is missing the following properties from type 'AutomationRow': maxFiresPerHour
  tests/automation-date-sweep.test.ts(12,58): error TS2739: ...
  tests/automation-match.test.ts(16,58): error TS2739: ...
  tests/automation-match.test.ts(226,60): error TS2739: ...
  tests/automation-runner.test.ts(21,58): error TS2739: ...
  tests/automation-webhook.test.ts(21,58): error TS2739: ...
  tests/http-automations.test.ts(41,...): error TS2739: ...
  tests/http-hubspot-events.test.ts(141,...): error TS2739: ...
  ```
  Noter cette liste : c'est le rayon de souffle mecanique, et les deux pas suivants la vident.

- [ ] **Step 11: Suivre la chaine du store (`Raw`, `toRow`, `COLS`)**

  Dans `src/automation/store.pg.ts`, trois endroits, tous tenus A LA MAIN, tous obligatoires.

  L'interface de ligne brute (lignes 18 a 22) :
  ```ts
  interface Raw {
    id: string; tenant_id: string; name: string; enabled: boolean;
    trigger_kind: string; trigger_config: unknown; condition_group: unknown;
    workflow_id: string; start_node_id: string | null; cooldown_seconds: number | null;
    max_fires_per_hour: number | null;
  }
  ```

  La fin de `toRow` (lignes 47 a 50) :
  ```ts
      workflowId: r.workflow_id,
      startNodeId: r.start_node_id,
      cooldownSeconds: r.cooldown_seconds,
      maxFiresPerHour: r.max_fires_per_hour,
    };
  }
  ```

  Et la liste de colonnes selectionnees (ligne 54), qui est ce qui alimente `Raw` :
  ```ts
  // ⚠️ Liste tenue A LA MAIN : ajouter une colonne ici oblige a toucher `Raw` ET `toRow`, sinon la valeur
  // arrive de la base et se perd en silence dans le mapping.
  const COLS = 'id, tenant_id, name, enabled, trigger_kind, trigger_config, condition_group, workflow_id, start_node_id, cooldown_seconds, max_fires_per_hour';
  ```

  `possede_par` n'entre PAS dans `COLS` : `AutomationRow` ne l'expose pas, et une colonne selectionnee que
  personne ne lit est une ligne de plus a tenir alignee pour rien.

- [ ] **Step 12: Completer les six fabriques de test**

  Ajouter `maxFiresPerHour: null` a chaque fabrique listee au Step 10. Ce sont des defauts : une automation
  de test n'a pas de plafond propre, c'est celui de l'instance qui s'applique, comme pour les automations
  reelles deja en base.

  `tests/automation-runner.test.ts` (ligne 21) :
  ```ts
  const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'A', enabled: true,
    triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
    workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
  });
  ```

  `tests/automation-match.test.ts` (ligne 16) :
  ```ts
  const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'Test', enabled: true,
    triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] }, conditionGroup: null,
    workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
  });
  ```

  `tests/automation-match.test.ts` (ligne 226, la fabrique `autoPub`, qui est un litteral complet et non un
  appel a `auto`) :
  ```ts
    const autoPub = (cfg: Record<string, unknown> = {}): AutomationRow => ({
      id: 'a1', tenantId: 't1', name: 'Pub', enabled: true, triggerKind: 'ctwa_ad', triggerConfig: cfg,
      workflowId: 'wf1', startNodeId: null, conditionGroup: null, cooldownSeconds: null, maxFiresPerHour: null,
    });
  ```

  `tests/automation-date-sweep.test.ts` (ligne 12) :
  ```ts
  const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'Rappel rendez-vous', enabled: true,
    triggerKind: 'avant_date', triggerConfig: { fieldKey: 'rdv', delai: 2, unite: 'heures' },
    conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
    maxFiresPerHour: null, ...over,
  });
  ```

  `tests/automation-webhook.test.ts` (ligne 21) :
  ```ts
  const auto = (over: Partial<AutomationRow> = {}): AutomationRow => ({
    id: 'a1', tenantId: 't1', name: 'Webhook : commandes', enabled: true,
    triggerKind: 'webhook', triggerConfig: { webhookId: 'wh1' }, conditionGroup: null,
    workflowId: 'wf1', startNodeId: null, cooldownSeconds: null, maxFiresPerHour: null, ...over,
  });
  ```

  `tests/http-hubspot-events.test.ts` (ligne 141) :
  ```ts
      const automation: AutomationRow = {
        id: 'a1', tenantId: 't1', name: 'Relance devis', enabled: true,
        triggerKind: 'hubspot_deal_stage', triggerConfig: { pipelineId: 'p1', stageId: 's-devis' },
        conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: null,
        maxFiresPerHour: null,
      };
  ```

  `tests/http-automations.test.ts` (ligne 41, le `getById` du faux cablage) :
  ```ts
      getById: async (id) => (id === 'a1' ? { id: 'a1', tenantId: 't1', name: 'A', enabled: true, triggerKind: 'conversation_analyzed', triggerConfig: {}, conditionGroup: null, workflowId: 'wf1', startNodeId: null, cooldownSeconds: 3600, maxFiresPerHour: null } : null),
  ```

  Puis verifier que le compilateur est vide :
  ```bash
  npm run typecheck
  ```
  Sortie attendue : aucune sortie (code de retour 0).

- [ ] **Step 13: Modifier le runner (`src/automation/runner.ts`)**

  Deux endroits, et les DEUX comptent : le code, et le commentaire de la dependance, qui devient faux sans lui.

  D'abord la documentation de `maxFiresPerHour` dans `AutomationRunnerDeps` (lignes 73 a 79) :
  ```ts
    /**
     * Plafond de declenchements par automation et par heure, PAR DEFAUT pour l'instance. L'anti-rebond est par
     * (automation, CONTACT) : il n'empeche donc rien a l'echelle d'une population. Or un seul acte
     * d'exploitation peut produire des milliers d'evenements d'un coup (une campagne directe rouvre l'analyse
     * de tous ses destinataires, qui repartent ensuite en « conversation analysee »). Ce plafond est la seule
     * chose qui borne la facture dans ce cas.
     *
     * 🔴 Une automation qui porte son PROPRE `maxFiresPerHour` l'emporte sur celui-ci, plus strict comme plus
     * large (cf. juste en dessous, dans la boucle). Ce reglage-ci reste la regle de toutes les autres.
     */
    maxFiresPerHour?: number;
  ```

  Ensuite le bloc de la boucle (lignes 143 a 153), qui devient :
  ```ts
        // Plafond par automation : borne le fan-out d'un evenement de masse (analyse rouverte pour toute une
        // campagne, par exemple). Verifie APRES l'anti-rebond (moins cher) et AVANT tout demarrage.
        //
        // 🔴 Le plafond de l'AUTOMATION l'emporte sur celui de l'instance. Un lien de chaine WhatsApp doit
        // pouvoir accueillir des milliers d'abonnes apres un post qui marche, sans qu'on desserre pour autant
        // la garde des autres automations, qui elle borne des envois FACTURES. `null` = pas de reglage propre,
        // donc le plafond de l'instance s'applique, ce qui est le cas de toutes les automations ordinaires.
        // `0` (ici comme au global) veut dire « aucun plafond », c'est un choix explicite et non un oubli.
        const plafond = a.maxFiresPerHour ?? deps.maxFiresPerHour;
        if (deps.firedSince && plafond !== undefined && plafond > 0) {
          const depuis = new Date(now() - 3600_000);
          if ((await deps.firedSince(a.id, depuis)) >= plafond) {
            // Le message porte le plafond REELLEMENT applique : annoncer celui de l'instance alors que celui
            // de l'automation a tranche enverrait chercher le reglage au mauvais endroit, et une automation
            // n'a aucun ecran ou cette raison pourrait s'afficher.
            // eslint-disable-next-line no-console
            console.error(`automation ${a.id} (${a.name}) : plafond de ${plafond} déclenchements/heure atteint, déclenchement ignoré`);
            continue;
          }
        }
  ```

  `src/worker.ts:302` n'est PAS touche : `maxFiresPerHour: config.AUTOMATION_MAX_FIRES_PER_HOUR` reste le
  defaut de l'instance, et c'est desormais exactement ce que son nom dit.

- [ ] **Step 14: Relancer les tests du runner et constater le vert**

  ```bash
  npx vitest run tests/automation-runner.test.ts
  ```

  Sortie attendue :
  ```
  Test Files  1 passed (1)
       Tests  <n> passed (<n>)
  ```
  ou `<n>` vaut le nombre de cas d'avant plus 5.

- [ ] **Step 15: Ajouter la garde HTTP (le corps ne peut pas poser ces deux champs)**

  Ajouter ce cas dans `tests/http-automations.test.ts`, a la fin du `describe('routes automations', ...)` :

  ```ts
    it('🔴 le corps ne peut PAS poser `possedePar` ni `maxFiresPerHour`', async () => {
      // `parseBody` recopie une liste FERMEE de champs, et cette garde dit pourquoi il faut qu'elle le reste.
      // Un client qui pourrait poser `possedePar` se fabriquerait une automation que son propre ecran ne
      // liste plus, ne modifie plus et ne supprime plus (le predicat de possession l'exclut des quatre
      // requetes du store). Un client qui pourrait poser `maxFiresPerHour` desserrerait la garde qui borne
      // des envois factures.
      const { server, cap } = app();
      const res = await server.inject({
        method: 'POST', url: '/tenants/t1/automations', ...h(adminTok),
        payload: { ...VALID, possedePar: 'channelsme_link', maxFiresPerHour: 100_000 },
      });
      expect(res.statusCode).toBe(201);
      expect(cap.created[0]!.input).not.toHaveProperty('possedePar');
      expect(cap.created[0]!.input).not.toHaveProperty('maxFiresPerHour');
      await server.close();
    });
  ```

  ```bash
  npx vitest run tests/http-automations.test.ts
  ```
  Sortie attendue : tous les cas passent.

  ⚠️ Ce cas est VERT du premier coup : c'est une garde, pas un correctif. Sa verification dans l'autre sens
  se fait a la main, et elle prend trente secondes : ajouter temporairement
  `if (b.possedePar !== undefined) out.possedePar = b.possedePar as string;` dans `parseBody`
  (`src/http/automations.ts`, apres le bloc `enabled`), relancer la commande ci-dessus, constater
  `AssertionError: expected { ... possedePar: 'channelsme_link' ... } not to have property "possedePar"`, puis
  `git checkout src/http/automations.ts`.

- [ ] **Step 16: Ecrire le test d'integration de la possession (il ne tournera QU'EN CI)**

  Creer `tests/integration/automation-possession.integration.test.ts` :

  ```ts
  import 'dotenv/config';
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { Pool } from 'pg';
  import { pgSsl } from '../../src/db/ssl';
  import { PgAutomationStore } from '../../src/automation/store.pg';

  /**
   * Possession d'une automation par un lien de chaine (colonne `possede_par`, migration 0114). Frere de
   * `automation-webhook-ownership.integration.test.ts`, pour le SECOND proprietaire.
   *
   * Ce test tape la vraie base, parce que c'est le seul endroit ou un predicat SQL peut etre verifie : un
   * test qui relirait la chaine de la requete ne prouverait que sa propre copie.
   *
   * Ne PAS le lancer en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION (cf. CLAUDE.md
   * du repo), et ce fichier cree et supprime des tenants. La CI monte un Postgres jetable pour ca (job
   * `integration`). `describe.skipIf(!url)` le rend inerte si DATABASE_URL n'est pas defini, mais ne protege
   * pas contre un DATABASE_URL defini qui pointerait sur la prod.
   */
  const url = process.env.DATABASE_URL ?? '';

  describe.skipIf(!url)('automations possedees par un lien de chaine : hors de portee de l ecran', () => {
    let pool: Pool;
    let store: PgAutomationStore;
    let tenantId = '';
    let workflowId = '';
    let idPossedee = '';
    let idNormale = '';

    beforeAll(async () => {
      pool = new Pool({ connectionString: url, ssl: pgSsl() });
      store = new PgAutomationStore(pool);
      tenantId = (await pool.query<{ id: string }>(
        `insert into tenants (name) values ('itest-automation-possession') returning id`,
      )).rows[0]!.id;
      workflowId = (await pool.query<{ id: string }>(
        `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
        [tenantId],
      )).rows[0]!.id;

      // Ecrite PAR LE STORE, exactement comme un lien de chaine la fabriquera : c'est `create` qui doit
      // savoir poser un proprietaire, sinon aucune automation possedee ne peut naitre.
      idPossedee = (await store.create(tenantId, {
        name: 'Chaine : newsletter', triggerKind: 'keyword',
        // Jeton FICTIF (aucun secret) : valeur figee pour rendre les assertions lisibles.
        triggerConfig: { keywords: ['cm-a7k2m9p3'], mode: 'contains' },
        conditionGroup: null, workflowId, startNodeId: null, cooldownSeconds: 300, enabled: true,
        possedePar: 'channelsme_link', maxFiresPerHour: 2000,
      })).id;
      idNormale = (await store.create(tenantId, {
        name: 'Mot-cle rdv', triggerKind: 'keyword', triggerConfig: { keywords: ['rdv'] },
        conditionGroup: null, workflowId, startNodeId: null, cooldownSeconds: null, enabled: true,
      })).id;
    });

    afterAll(async () => {
      if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
      await pool.end();
    });

    it('🔴 `list` ne montre pas la possedee, et montre l ordinaire', async () => {
      const noms = (await store.list(tenantId)).map((a) => a.name);
      expect(noms).toContain('Mot-cle rdv');
      expect(noms).not.toContain('Chaine : newsletter');
    });

    it('🔴 `getById` ne la trouve pas, `update` ne la modifie pas, `remove` ne la supprime pas', async () => {
      expect(await store.getById(idPossedee, tenantId)).toBeNull();
      // Eteindre le compagnon d'un post publie depuis l'ecran Automation tuerait son bouton en silence.
      expect(await store.update(idPossedee, tenantId, { enabled: false })).toBe(false);
      expect(await store.remove(idPossedee, tenantId)).toBe(false);
      const relu = await pool.query<{ enabled: boolean }>('select enabled from automations where id = $1', [idPossedee]);
      expect(relu.rows[0]?.enabled).toBe(true);
    });

    it('le chemin CHAUD la voit, avec son plafond propre : c est elle qui declenche le scenario', async () => {
      const chaud = await store.listEnabled(tenantId, ['keyword']);
      expect(chaud.find((a) => a.id === idPossedee)?.maxFiresPerHour).toBe(2000);
      // L'automation ordinaire n'a pas de plafond propre : c'est celui de l'instance qui s'applique.
      expect(chaud.find((a) => a.id === idNormale)?.maxFiresPerHour).toBeNull();
    });

    it('l automation ordinaire reste pilotable (le second terme n a pas tout verrouille)', async () => {
      expect(await store.update(idNormale, tenantId, { name: 'Mot-cle rdv (modifie)' })).toBe(true);
      expect((await store.getById(idNormale, tenantId))?.name).toBe('Mot-cle rdv (modifie)');
    });

    it('les webhooks restent exclus comme avant : le `and` n a rien desserre', async () => {
      const idWebhook = (await pool.query<{ id: string }>(
        `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, workflow_id)
         values ($1, 'Webhook : commandes', true, 'webhook', '{"webhookId":"wh-itest"}'::jsonb, $2) returning id`,
        [tenantId, workflowId],
      )).rows[0]!.id;
      // `possede_par` y vaut null : c'est le PREMIER terme qui doit continuer a l'exclure, tout seul.
      expect(await store.getById(idWebhook, tenantId)).toBeNull();
      expect((await store.list(tenantId)).map((a) => a.id)).not.toContain(idWebhook);
    });
  });
  ```

  ⚠️ NE PAS lancer `npm run test:integration` en local. Sa verification se fait au Step 18, sur le run CI.

- [ ] **Step 17: Contre-epreuve : remettre le code fautif et voir les tests ECHOUER**

  Un test qui passe apres un correctif ne prouve rien tant qu'on n'a pas vu qu'il echoue sans lui. Les deux
  correctifs, l'un apres l'autre, par un `git checkout` du seul fichier concerne.

  ```bash
  git stash push src/automation/runner.ts && npx vitest run tests/automation-runner.test.ts ; git stash pop
  ```
  Attendu pendant l'echec : les trois memes messages qu'au Step 8 (`expected 1 to be 0`, `expected 0 to be 1`,
  et le journal qui annonce 200 au lieu de 5). Puis, apres `git stash pop`, relancer et revoir le vert.

  ```bash
  git stash push src/automation/store.pg.ts && npx vitest run tests/automation-possession.test.ts ; git stash pop
  ```
  Attendu pendant l'echec : `expected '...' to contain 'possede_par is null'` et
  `expected undefined to be 'channelsme_link'`. Puis relancer apres le `pop` et revoir le vert.

  ⚠️ Si un `git stash pop` echoue (conflit), reprendre par `git stash list` puis `git checkout stash@{0} -- <fichier>`
  avant de continuer : ne jamais laisser le depot avec un correctif a moitie remis.

- [ ] **Step 18: Verification complete puis commit**

  ```bash
  npm run typecheck
  npm test
  ```
  Attendu : `typecheck` sans aucune sortie, et `npm test` avec `Test Files  <n> passed`, zero echec. Aucun
  fichier de `tests/integration/` ne tourne (ils sont exclus par `vitest.config.ts`).

  ```bash
  git add -A
  git commit -m "feat(automations): possession et plafond horaire par automation

Trois changements additifs sur le moteur d'automations, prealables au lien de chaine WhatsApp.

1. Possession. Le predicat de PgAutomationStore devient \"and trigger_kind <> 'webhook' and
   possede_par is null\" : une automation compagnon d'un lien de chaine cesse d'etre listable,
   modifiable et supprimable depuis l'ecran Automation. Sans ca, un PATCH la reaffectait a un autre
   declencheur et le bouton d'un post DEJA PUBLIE cessait de declencher, en silence et sans recours.
   Le chemin chaud (listEnabled) la voit toujours, sans quoi elle serait muette.

2. Plafond par automation. AutomationRow gagne maxFiresPerHour, et la chaine tenue a la main derriere
   (COLS, Raw, toRow, l'insert de create, AutomationInput). Requis et non optionnel a dessein : c'est
   le compilateur qui a enumere les huit fabriques a completer.

3. Le runner lit a.maxFiresPerHour ?? deps.maxFiresPerHour, et son journal annonce le plafond
   REELLEMENT applique. Un post de chaine fait arriver des milliers d'abonnes ; le plafond global de
   200 aurait fait mourir la feature le jour ou un post marche, et le desserrer globalement aurait
   desserre la garde qui borne des envois factures ailleurs.

Prouve dans les deux sens : plafond propre plus strict qui l'emporte, plafond propre plus large qui
l'emporte, plafond null qui garde le global, et une automation possedee absente de list().

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
  ```

  ⚠️ Le hook `rayon-de-souffle.js` BLOQUE ce premier `git commit` pour afficher les lecteurs des symboles
  touches (`AutomationRow`, `HORS_WEBHOOK`, `maxFiresPerHour`). Lire la liste, verifier qu'elle ne contient
  rien d'oublie par rapport au Step 2, puis relancer LA MEME commande : le jeton porte l'empreinte de l'index,
  le second passage passe.

  Enfin, la moitie des tests que le local ne prouve pas :
  ```bash
  git push origin main
  gh run list --limit 1
  ```
  Attendre la fin du run, puis :
  ```bash
  gh run view --log-failed
  ```
  Attendu : rien (run vert), job `integration` compris, qui est le SEUL a executer
  `tests/integration/automation-possession.integration.test.ts` contre un vrai Postgres. Un `npm test` vert en
  local n'a rien verifie cote base.


---

### Task 8: Module de routes et cablage

**Files:**
- Create : `C:\Users\julie\messagingme-mba\src\http\channels-me.ts`
- Create : `C:\Users\julie\messagingme-mba\tests\http-channels-me.test.ts`
- Modify : `C:\Users\julie\messagingme-mba\src\server.ts` (import, `ServerDeps`, liste `modulesTenant` ligne 229, appel `register` vers la ligne 397)
- Modify : `C:\Users\julie\messagingme-mba\src\index.ts` (construction des stores + bloc `channelsMe` de l'objet passe a `buildServer`)
- Modify : `C:\Users\julie\messagingme-mba\src\automation\store.pg.ts` (methode de bascule d'une automation POSSEDEE, cf. open question 1)
- Test (modify) : `C:\Users\julie\messagingme-mba\tests\scope-tenant.test.ts` (rayon de souffle n.1 : la liste `dependants` gagne `channelsMe`)

**Interfaces:**

- **Consumes** (produits par les taches precedentes, signatures recopiees telles quelles) :
  - `src/lib/wa-me.ts` : `export function lienWaMe(displayPhoneNumber: string | null, texte: string): string | null`
  - `src/channels-me/jeton.ts` : `export function nouveauJeton(): string`, `export function textePreRempli(phrase: string, jeton: string): string`
  - `src/channels-me/types.ts` : `export interface Connexion { orgId: string; channelId: string; apiKey: string; secret: string }`, `export interface ConnexionPublique { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }`, `export type Organisation, MessageChannel, Message`
  - `src/channels-me/client.ts` : `export class ChannelsMeClient { constructor(deps?: { fetch?: typeof fetch; timeoutMs?: number }); getOrganisation(cx: Connexion): Promise<Organisation>; listChannels(cx: Connexion): Promise<MessageChannel[]>; getMessages(cx: Connexion): Promise<Message[]>; createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message> }`
  - `src/channels-me/connection-store.pg.ts` : `new PgChannelsMeConnectionStore(pool, encryptionKey)` avec `get / getSecrets / upsert / markVerified`
  - `src/channels-me/link-store.pg.ts` : `export interface LienRow { id; tenantId; workflowId; startNodeId: string | null; token; phrase; automationId: string | null; maxParHeure: number | null; createdAt }`, `new PgChannelsMeLinkStore(pool)` avec `create / list / byId`
  - `src/channels-me/post-store.pg.ts` : `export interface PostRow { id; tenantId; cmMessageId; linkId: string | null; createdAt }`, `new PgChannelsMePostStore(pool)` avec `create / list`
  - `src/automation/store.pg.ts` : `PgAutomationStore.create(tenantId, input: AutomationInput)` ou `AutomationInput` porte desormais `possedePar: string | null` et `maxFiresPerHour: number | null` (colonnes additives de la migration 0114, cf. open question 2)
  - Deja dans le depot : `scopeTenant`, `estUuid` (`src/http/scope.ts`), `forbidNonAdmin`, `Guard` (`src/auth/middleware.ts`), `RateLimiter` (`src/auth/rate-limit.ts`), `urlRecuperable` (`src/lib/page-distante.ts`), `sendTelegram` (`src/ops/telegram.ts`), `PgWorkflowStore.getById`, `PgPhoneStatusStore.getPhoneNumber`
- **Produces** (utilise par les taches suivantes, front compris) :
  - `src/http/channels-me.ts` : `export interface ChannelsMeRouteDeps` et `export function registerChannelsMeRoutes(app: FastifyInstance, deps: ChannelsMeRouteDeps, guard?: Guard): void`
  - Neuf routes sous `/tenants/:tenantId/channels-me`, et la forme EXACTE de leurs reponses, sur lesquelles le module d'appels `web/lib/api/channels-me.ts` se branchera :
    - `GET /connection` -> `200 { connection: ConnexionPublique | null, organisation: Organisation | null, channels: MessageChannel[], distant: 'ok' | 'non_configuree' | 'injoignable' }`
    - `PUT /connection` -> `200 { connection: ConnexionPublique | null }`, `400`, `403`
    - `POST /connection/test` -> `200 { ok: true, organisation, channels }`, `409`, `422 { ok: false, error }`
    - `GET /links` -> `200 { links: Array<LienRow & { texteRempli: string; waMeUrl: string | null }>, phone: string | null }`
    - `POST /links` -> `201 { link: LienRow & { texteRempli, waMeUrl } }`, `400`, `409`
    - `POST /links/:id/disable` -> `200 { ok: true }`, `404`, `409`
    - `GET /posts` -> `200 { posts: Array<PostRow & { message: Message | null }>, distant }`
    - `POST /posts` -> `201 { post: { cmMessageId: string; linkId: string | null } }`, `400`, `409`, `422`
    - `POST /activation-request` -> `200 { ok: true }`, `400`, `429`, `503`
  - `src/automation/store.pg.ts` : `setEnabledPossedee(id: string, tenantId: string, possedePar: string, enabled: boolean): Promise<boolean>`
  - `src/server.ts` : la cle `channelsMe?: ChannelsMeRouteDeps` de `ServerDeps`, montee avec `requireAuth`

---

- [ ] **Step 1: ecrire le fichier de test avec sa fabrique complete et les deux premiers cas (GET /connection)**

Creer `tests/http-channels-me.test.ts`. La fabrique porte TOUTES les fausses deps des le depart (sinon le typage casse au premier ajout de cas), les `it` s'ajouteront ensuite.

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { ChannelsMeRouteDeps } from '../src/http/channels-me';
import type { Connexion, Organisation, MessageChannel, Message } from '../src/channels-me/types';
import type { LienRow } from '../src/channels-me/link-store.pg';
import type { PostRow } from '../src/channels-me/post-store.pg';

/**
 * Les routes de la chaine WhatsApp (Channels Me). Aucune base, aucun reseau : de faux stores et un faux
 * client, injectes dans `buildServer`.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Les deux secrets de la connexion (cle d'API et secret HMAC) ne ressortent JAMAIS. La projection
 *     publique ne porte que `hasApiKey` / `hasSecret` : une fuite ici circulerait chez tous les clients.
 *  2. 🔴 Un post publie circule POUR TOUJOURS. Publier sur un scenario sans version publiee poserait un
 *     bouton mort et irreparable : le refus est AVANT la publication, jamais apres.
 *  3. 🔴 L'automation compagnon ne s'allume qu'APRES une publication reussie. Un echec distant doit laisser
 *     le lien eteint, donc inerte, meme si son jeton a fuite.
 *  4. Une panne du tiers ne doit pas effacer la connexion de l'ecran : GET /connection reste en 200 et dit
 *     `distant: 'injoignable'`, ce qui n'est pas la meme chose que `non_configuree`.
 *
 * ⚠️ Le `enabled: false` de la CREATION de l'automation vit dans le cablage (`src/index.ts`), pas dans la
 * route : ce fichier prouve seulement qu'AUCUNE bascule n'a lieu a la creation d'un lien. Le cablage est
 * garde par son propre cas, plus bas (lecture de la source, comme `tests/scope-tenant.test.ts`).
 */

const SECRET = 'test-secret';
let adminTok = '';
let agentTok = '';
beforeAll(async () => {
  adminTok = await signSession({ userId: 'u1', tenantId: 't1', role: 'admin' }, SECRET);
  agentTok = await signSession({ userId: 'u2', tenantId: 't1', role: 'agent' }, SECRET);
});
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
const h = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

// Identifiants FICTIFS (aucun secret reel) : valeurs figees pour rendre les assertions lisibles.
const CX: Connexion = { orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' };
const WF_ID = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const AUTO_ID = '33333333-3333-4333-8333-333333333333';

const LIEN: LienRow = {
  id: LINK_ID, tenantId: 't1', workflowId: WF_ID, startNodeId: null,
  token: 'cm-a7k2m9p3', phrase: 'Je veux recevoir la newsletter',
  automationId: AUTO_ID, maxParHeure: 2000, createdAt: '2026-09-04T00:00:00.000Z',
};
const POST: PostRow = {
  id: '44444444-4444-4444-8444-444444444444', tenantId: 't1',
  cmMessageId: 'cm-msg-1', linkId: LINK_ID, createdAt: '2026-09-04T00:00:00.000Z',
};

// Objets rendus par le tiers. Seul `Message.id` est lu par ces routes (c'est ce que `cm_message_id`
// stocke) : on ne rejoue pas ici le schema complet de `src/channels-me/types.ts`.
const ORGA = { id: 'org-1', name: 'Demo' } as unknown as Organisation;
const CANAL = { id: 'chan-1', name: 'Ma chaine' } as unknown as MessageChannel;
const MESSAGE = { id: 'cm-msg-1' } as unknown as Message;

function app(over: Partial<ChannelsMeRouteDeps> = {}) {
  const cap = {
    upserts: [] as Connexion[],
    verifies: [] as string[],
    liens: [] as Array<Record<string, unknown>>,
    automations: [] as Array<Record<string, unknown>>,
    bascules: [] as Array<{ id: string; enabled: boolean }>,
    publies: [] as Array<{ text: string; mediaUrl?: string }>,
    posts: [] as Array<{ cmMessageId: string; linkId: string | null }>,
    demandes: [] as Array<{ message: string }>,
    ordre: [] as string[],
  };
  const deps: ChannelsMeRouteDeps = {
    getConnection: async () => ({ orgId: 'org-1', channelId: 'chan-1', hasApiKey: true, hasSecret: true, verifiedAt: null }),
    getSecrets: async () => CX,
    upsertConnection: async (_t, c) => { cap.upserts.push(c); },
    markVerified: async (t) => { cap.verifies.push(t); },
    getOrganisation: async () => ORGA,
    listChannels: async () => [CANAL],
    getMessages: async () => [MESSAGE],
    createMessage: async (_cx, m) => { cap.publies.push(m); cap.ordre.push('publie'); return MESSAGE; },
    listLinks: async () => [LIEN],
    createLink: async (_t, l) => { cap.liens.push(l); return { ...LIEN, ...l }; },
    linkById: async (_t, id) => (id === LINK_ID ? LIEN : null),
    listPosts: async () => [POST],
    createPost: async (_t, p) => { cap.posts.push(p); cap.ordre.push('trace'); },
    creerAutomationCompagnon: async (_t, input) => { cap.automations.push(input); return { id: AUTO_ID }; },
    basculerAutomation: async (_t, id, enabled) => { cap.bascules.push({ id, enabled }); cap.ordre.push('bascule'); return true; },
    scenarioEtat: async (_t, wf) => (wf === WF_ID ? 'ok' : 'inconnu'),
    getDisplayPhoneNumber: async () => '+33 5 25 68 02 50',
    demanderActivation: async ({ message }) => { cap.demandes.push({ message }); },
    ...over,
  };
  return { server: buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, channelsMe: deps }), cap };
}

describe('Channels Me : la connexion', () => {
  it('🔴 rend l etat de la chaine SANS jamais laisser sortir la cle ni le secret', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ distant: string }>().distant).toBe('ok');
    expect(res.json<{ connection: Record<string, unknown> }>().connection).toMatchObject({ hasApiKey: true, hasSecret: true });
    // La projection publique ne porte que des booleens : les deux valeurs fictives ne doivent apparaitre
    // nulle part dans le corps, pas meme dans un champ oublie.
    expect(JSON.stringify(res.json())).not.toContain('cle-fictive');
    expect(JSON.stringify(res.json())).not.toContain('secret-fictif');
    await server.close();
  });

  it('tiers muet : la connexion enregistree reste visible, en 200, avec distant = injoignable', async () => {
    const { server } = app({ getOrganisation: async () => { throw new Error('reseau'); } });
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(adminTok) });
    // 200 et pas 5xx : dire « rien de configure » alors que le tiers a simplement echoue enverrait le client
    // ressaisir des identifiants qui sont bons.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ distant: string }>().distant).toBe('injoignable');
    expect(res.json<{ connection: unknown }>().connection).not.toBeNull();
    await server.close();
  });

  it('refuse l espace d un AUTRE tenant', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t-autre/channels-me/connection', ...h(adminTok) });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('tenant interdit');
    await server.close();
  });
});
```

- [ ] **Step 2: lancer le test et constater l'echec (le module n'existe pas)**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Sortie attendue : `Error: Failed to resolve import "../src/http/channels-me" from "tests/http-channels-me.test.ts". Does the file exist?`, et le fichier compte 0 test passe.

- [ ] **Step 3: creer src/http/channels-me.ts avec l'interface de deps COMPLETE, les schemas Zod et la seule route GET /connection**

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin } from '../auth/middleware';
import type { Guard } from '../auth/middleware';
import { RateLimiter } from '../auth/rate-limit';
import { urlRecuperable } from '../lib/page-distante';
import { lienWaMe } from '../lib/wa-me';
import { nouveauJeton, textePreRempli } from '../channels-me/jeton';
import type { Connexion, ConnexionPublique, Organisation, MessageChannel, Message } from '../channels-me/types';
import type { LienRow } from '../channels-me/link-store.pg';
import type { PostRow } from '../channels-me/post-store.pg';
import { scopeTenant, estUuid } from './scope';

export interface ChannelsMeRouteDeps {
  /** Projection PUBLIQUE de la connexion : jamais les colonnes chiffrees. null = rien de provisionne. */
  getConnection(tenantId: string): Promise<ConnexionPublique | null>;
  /** Les identifiants EN CLAIR, dechiffres par le store. Ils ne servent qu'au client, ils ne sortent jamais d'ici. */
  getSecrets(tenantId: string): Promise<Connexion | null>;
  upsertConnection(tenantId: string, c: Connexion): Promise<void>;
  markVerified(tenantId: string): Promise<void>;

  getOrganisation(cx: Connexion): Promise<Organisation>;
  listChannels(cx: Connexion): Promise<MessageChannel[]>;
  getMessages(cx: Connexion): Promise<Message[]>;
  createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message>;

  listLinks(tenantId: string): Promise<LienRow[]>;
  createLink(tenantId: string, l: {
    workflowId: string; startNodeId: string | null; token: string; phrase: string;
    automationId: string | null; maxParHeure: number | null;
  }): Promise<LienRow>;
  linkById(tenantId: string, id: string): Promise<LienRow | null>;

  listPosts(tenantId: string): Promise<PostRow[]>;
  createPost(tenantId: string, p: { cmMessageId: string; linkId: string | null }): Promise<void>;

  /**
   * Cree l'automation compagnon du lien. Elle nait ETEINTE et POSSEDEE par le lien : c'est le cablage qui
   * pose `enabled: false` et la marque de possession, la route ne connait pas la forme d'une automation.
   */
  creerAutomationCompagnon(tenantId: string, input: {
    nom: string; jeton: string; workflowId: string; startNodeId: string | null;
    cooldownSeconds: number; maxParHeure: number | null;
  }): Promise<{ id: string }>;
  /** Allume ou eteint l'automation compagnon. false = elle n'est pas a ce tenant, ou n'est pas possedee par un lien. */
  basculerAutomation(tenantId: string, automationId: string, enabled: boolean): Promise<boolean>;

  /** 'inconnu' = pas au tenant. 'vide' = aucune version publiee. 'ok' = demarrable. */
  scenarioEtat(tenantId: string, workflowId: string): Promise<'inconnu' | 'vide' | 'ok'>;
  /** Numero WhatsApp affiche du tenant. null = aucun numero connecte, donc aucun lien wa.me possible. */
  getDisplayPhoneNumber(tenantId: string): Promise<string | null>;

  /** Demande d'activation (notification Telegram). Absente du cablage -> 503, comme partout ailleurs. */
  demanderActivation?(input: { tenantId: string; userId: string | null; message: string }): Promise<void>;
}

const ID_EXTERNE = z.string().trim().min(1).max(200);
const SECRET_TIERS = z.string().trim().min(1).max(500);

const connexionSchema = z.object({
  orgId: ID_EXTERNE, channelId: ID_EXTERNE, apiKey: SECRET_TIERS, secret: SECRET_TIERS,
});
const lienSchema = z.object({
  workflowId: z.string().uuid(),
  startNodeId: z.string().trim().min(1).max(200).nullish(),
  phrase: z.string().trim().min(1).max(300),
  maxParHeure: z.number().int().min(1).max(100_000).nullish(),
});
const postSchema = z.object({
  text: z.string().trim().min(1).max(4096),
  mediaUrl: z.string().trim().url().max(2000).optional(),
  linkId: z.string().uuid().optional(),
});
const demandeSchema = z.object({ message: z.string().trim().max(2000).optional() });

/** Anti-rebond du lien de chaine : 5 minutes, au lieu des 3600 s par defaut. Filtre le double appui
 *  accidentel, laisse repartir un abonne qui revient plus tard. */
const COOLDOWN_LIEN_SECONDES = 300;

/**
 * 🔴 CE QUI SORT D'UN ECHEC DISTANT : le tenant, l'etape, et le message de l'erreur levee par NOTRE client.
 * Jamais le corps de la reponse du tiers (sans `Accept: application/json` leur API rend une page HTML
 * entiere, et un corps distant peut porter les donnees d'un autre espace), jamais les identifiants.
 * `console.error` et non `req.log` : Fastify est construit en `logger: false`.
 */
function journaliserDistant(tenant: string, etape: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    lvl: 'error', msg: 'channelsme_distant_ko', tenant, etape,
    err: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * Chaine WhatsApp (Channels Me) : publier un post qui porte un lien wa.me pre-rempli, dont l'appui demarre
 * un scenario. Lecture ouverte a tout compte authentifie (les ecrans en ont besoin), ECRITURES admin-only :
 * publier sur une chaine, c'est parler a toute une audience sans qu'un humain relise.
 */
export function registerChannelsMeRoutes(app: FastifyInstance, deps: ChannelsMeRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/channels-me';

  app.get(`${base}/connection`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const connection = await deps.getConnection(tenant);
    if (!connection) {
      return reply.code(200).send({ connection: null, organisation: null, channels: [], distant: 'non_configuree' });
    }
    const cx = await deps.getSecrets(tenant);
    if (!cx) {
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'non_configuree' });
    }
    try {
      // Les deux objets sont ceux que le SCHEMA Zod du client a laisses passer, pas le corps distant tel
      // quel : une page HTML d'erreur ou un champ inattendu n'arrive jamais jusqu'ici.
      const [organisation, channels] = await Promise.all([deps.getOrganisation(cx), deps.listChannels(cx)]);
      return reply.code(200).send({ connection, organisation, channels, distant: 'ok' });
    } catch (err) {
      journaliserDistant(tenant, 'connection_read', err);
      // 200 et pas 4xx : la connexion ENREGISTREE doit rester visible meme quand le tiers est muet, sinon
      // l'ecran laisse croire qu'il n'y a rien de provisionne et le client ressaisit des identifiants bons.
      return reply.code(200).send({ connection, organisation: null, channels: [], distant: 'injoignable' });
    }
  });
}
```

- [ ] **Step 4: ajouter `channelsMe` a la liste `dependants` de tests/scope-tenant.test.ts et constater le rouge (rayon de souffle n.1, premiere moitie)**

Dans `tests/scope-tenant.test.ts`, ajouter `'channelsMe'` a la fin du tableau `dependants` :

```ts
    const dependants = [
      'import', 'campaigns', 'admin', 'flows', 'templates', 'support', 'contacts', 'account', 'me',
      'workflows', 'embeddedSignup', 'apiKeys', 'hubspotImport', 'hubspotInstall', 'hubspotPipelines',
      'mba', 'email', 'webhooksAdmin',
      'inbox', 'stats', 'settings', 'rcsMessages', 'rcsChannel', 'rcsMedia', 'media', 'tags', 'fields',
      'workflowReports', 'automations', 'agents', 'agentKnowledge', 'agentTools', 'agentSources',
      'agentRequetes', 'agentSetup', 'agentTest', 'channelsMe',
    ];
```

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/scope-tenant.test.ts
```

Sortie attendue, exactement le message du 2e argument de `expect` : `ces modules exposent des routes tenant sans etre couverts par le garde-fou : channelsMe`, et `1 failed | 3 passed`.

- [ ] **Step 5: monter le module dans src/server.ts, les QUATRE endroits, dans le meme commit**

(1) Avec les autres imports, apres la ligne `import { registerAutomations } from './http/automations';` :

```ts
import { registerChannelsMeRoutes, type ChannelsMeRouteDeps } from './http/channels-me';
```

(2) Dans `interface ServerDeps`, juste apres l'entree `automations` :

```ts
  /** Chaine WhatsApp (Channels Me) : lecture ouverte aux comptes authentifies, ECRITURES admin-only (garde dans la route). */
  channelsMe?: ChannelsMeRouteDeps;
```

(3) Dans `buildServer`, la liste `modulesTenant` passe de 36 a 37 entrees (derniere ligne du tableau) :

```ts
    deps.agentTools, deps.agentSources, deps.agentRequetes, deps.agentSetup, deps.agentTest,
    deps.channelsMe,
  ];
```

(4) Dans le bloc des `register`, juste apres `registerAutomations` :

```ts
  // requireAuth et non requireAdmin : les ecrans de la chaine se LISENT avec un compte agent, et les six
  // ecritures sont fermees dans la route par `forbidNonAdmin`.
  if (deps.channelsMe) registerChannelsMeRoutes(app, deps.channelsMe, requireAuth);
```

- [ ] **Step 6: relancer les deux fichiers et constater le vert**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/scope-tenant.test.ts tests/http-channels-me.test.ts && npm run typecheck
```

Attendu : `Test Files 2 passed`, `Tests 7 passed` (4 pour scope-tenant, 3 pour channels-me), puis `tsc --noEmit` sans sortie.

- [ ] **Step 7: committer le squelette et son montage**

```bash
cd /c/Users/julie/messagingme-mba && git add src/http/channels-me.ts src/server.ts tests/http-channels-me.test.ts tests/scope-tenant.test.ts && git commit -m "feat(channels-me): le module de routes, monte et garde par la liste des 37

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

⚠️ Le hook `rayon-de-souffle.js` bloque ce premier commit pour mettre sous les yeux les lecteurs des symboles touches (`ServerDeps`, `modulesTenant`). Relancer la MEME commande passe : le jeton porte l'empreinte de l'index.

- [ ] **Step 8: ajouter les cas de test de PUT /connection et POST /connection/test (rouge)**

A la suite du premier `describe` de `tests/http-channels-me.test.ts` :

```ts
describe('Channels Me : provisionner et verifier les identifiants', () => {
  it('PUT enregistre les quatre identifiants et ne les renvoie pas', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(adminTok),
      payload: { orgId: '  org-1  ', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' },
    });
    expect(res.statusCode).toBe(200);
    // Detourees des espaces, comme la cle du canal RCS.
    expect(cap.upserts).toEqual([{ orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive', secret: 'secret-fictif' }]);
    expect(JSON.stringify(res.json())).not.toContain('cle-fictive');
    await server.close();
  });

  it('PUT avec un champ manquant : 400, et RIEN n est enregistre', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(adminTok),
      payload: { orgId: 'org-1', channelId: 'chan-1', apiKey: 'cle-fictive' },
    });
    expect(res.statusCode).toBe(400);
    expect(cap.upserts).toEqual([]);
    await server.close();
  });

  it('un AGENT peut LIRE l etat mais ne peut ni enregistrer ni tester', async () => {
    const { server, cap } = app();
    expect((await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/connection', ...h(agentTok) })).statusCode).toBe(200);
    expect((await server.inject({ method: 'PUT', url: '/tenants/t1/channels-me/connection', ...h(agentTok), payload: CX })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(agentTok) })).statusCode).toBe(403);
    expect(cap.upserts).toEqual([]);
    await server.close();
  });

  it('le test des identifiants marque la connexion verifiee', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(cap.verifies).toEqual(['t1']);
    await server.close();
  });

  it('🔴 identifiants refuses par le tiers : 422 avec la marche a suivre, et AUCUNE verification posee', async () => {
    const { server, cap } = app({ listChannels: async () => { throw new Error('401 unauthorized'); } });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    // 422 et non 5xx : c'est une saisie a corriger, et Cloudflare remplacerait le corps d'un 5xx par sa page
    // d'erreur, donc le message n'atteindrait jamais l'operateur.
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('secret');
    expect(cap.verifies).toEqual([]);
    await server.close();
  });

  it('tester sans rien avoir enregistre : 409, pas un 500', async () => {
    const { server } = app({ getSecrets: async () => null });
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/connection/test', ...h(adminTok) });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
```

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Attendu : `6 failed | 3 passed`, chaque echec disant `expected 404 to be 200` (ou 400 / 403 / 409 / 422 selon le cas), Fastify ne connaissant pas encore ces chemins.

- [ ] **Step 9: ecrire PUT /connection et POST /connection/test**

Dans `src/http/channels-me.ts`, a la suite de `GET /connection` :

```ts
  app.put(`${base}/connection`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = connexionSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'organisation, chaine, cle d’API et secret sont tous requis' });
    }
    const { orgId, channelId, apiKey, secret } = parse.data;
    // Remplacement COMPLET, et non un patch : l'ecran ne peut pas renvoyer ce qu'il n'a jamais eu (les deux
    // secrets ne redescendent jamais), donc « changer la cle » veut dire ressaisir les quatre champs.
    // Le chiffrement est fait DANS le store, jamais ici.
    await deps.upsertConnection(tenant, { orgId, channelId, apiKey, secret });
    // On relit la projection PUBLIQUE : la reponse ne porte donc jamais les secrets qu'on vient d'ecrire.
    return reply.code(200).send({ connection: await deps.getConnection(tenant) });
  });

  app.post(`${base}/connection/test`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const cx = await deps.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de tester' });
    try {
      // Deux lectures, jamais une ecriture : ce bouton ne publie rien.
      const [organisation, channels] = await Promise.all([deps.getOrganisation(cx), deps.listChannels(cx)]);
      await deps.markVerified(tenant);
      return reply.code(200).send({ ok: true, organisation, channels });
    } catch (err) {
      journaliserDistant(tenant, 'connection_test', err);
      // Message FIXE : le corps de la reponse du tiers ne se relaie jamais au client.
      return reply.code(422).send({
        ok: false,
        error: 'Channels Me a refuse ces identifiants, ou n’a pas repondu. Verifie l’organisation, la chaine, la cle d’API et le secret.',
      });
    }
  });
```

- [ ] **Step 10: relancer et constater le vert**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Attendu : `Tests 9 passed`.

- [ ] **Step 11: ajouter les cas de test des liens (rouge)**

A la suite dans `tests/http-channels-me.test.ts` :

```ts
describe('Channels Me : les liens de chaine', () => {
  it('la liste rend le lien wa.me PRET A L EMPLOI (le front ne recompose jamais une URL publique)', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/links', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    const lien = res.json<{ links: Array<{ waMeUrl: string; texteRempli: string }> }>().links[0]!;
    expect(lien.texteRempli).toBe('Je veux recevoir la newsletter (cm-a7k2m9p3)');
    expect(lien.waMeUrl).toBe('https://wa.me/33525680250?text=Je%20veux%20recevoir%20la%20newsletter%20(cm-a7k2m9p3)');
    await server.close();
  });

  it('cree le lien et son automation compagnon, SANS rien allumer', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: WF_ID, phrase: 'Je veux recevoir la newsletter', maxParHeure: 2000 },
    });
    expect(res.statusCode).toBe(201);
    expect(cap.automations[0]).toMatchObject({ workflowId: WF_ID, cooldownSeconds: 300, maxParHeure: 2000 });
    // Le jeton est tire par le SERVEUR, jamais fourni par le client, et il est le meme dans l'automation et
    // dans le lien : deux tirages donneraient un bouton qui ne declenche rien.
    expect(cap.liens[0]!.token).toBe(cap.automations[0]!.jeton);
    // 🔴 Rien n'est allume a la creation : un lien cree mais jamais publie doit rester inerte.
    expect(cap.bascules).toEqual([]);
    await server.close();
  });

  it('scenario d un AUTRE tenant : 400, et ni lien ni automation', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: '99999999-9999-4999-8999-999999999999', phrase: 'Bonjour' },
    });
    expect(res.statusCode).toBe(400);
    expect(cap.liens).toEqual([]);
    expect(cap.automations).toEqual([]);
    await server.close();
  });

  it('aucun numero WhatsApp connecte : 409 explicite plutot qu un lien casse', async () => {
    const { server, cap } = app({ getDisplayPhoneNumber: async () => null });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/links', ...h(adminTok),
      payload: { workflowId: WF_ID, phrase: 'Bonjour' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('numero WhatsApp');
    expect(cap.automations).toEqual([]);
    await server.close();
  });

  it('eteindre un lien ecrit sur son AUTOMATION, seule source de verite de son etat', async () => {
    const { server, cap } = app();
    const res = await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${LINK_ID}/disable`, ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(cap.bascules).toEqual([{ id: AUTO_ID, enabled: false }]);
    await server.close();
  });

  it('identifiant mal forme ou lien d un autre espace : 404, jamais une page d incident', async () => {
    const { server } = app();
    // Un id non-uuid partirait tel quel dans un `where id = $1` sur une colonne uuid : Postgres leverait
    // 22P02, donc 500, donc page Cloudflare au lieu d'un 404.
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/links/pas-un-uuid/disable', ...h(adminTok) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: `/tenants/t1/channels-me/links/${WF_ID}/disable`, ...h(adminTok) })).statusCode).toBe(404);
    await server.close();
  });
});
```

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Attendu : `6 failed | 9 passed`, les echecs disant `expected 404 to be 200` / `to be 201` / `to be 409`.

- [ ] **Step 12: ecrire GET /links, POST /links et POST /links/:id/disable**

A la suite dans `src/http/channels-me.ts` :

```ts
  app.get(`${base}/links`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const liens = await deps.listLinks(tenant);
    // UN seul appel pour toute la liste. Le front ne recompose JAMAIS une URL publique : il recoit le lien
    // wa.me pret a l'emploi, comme pour l'adresse d'un webhook entrant.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    return reply.code(200).send({
      links: liens.map((l) => {
        const texte = textePreRempli(l.phrase, l.token);
        return { ...l, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) };
      }),
      phone,
    });
  });

  app.post(`${base}/links`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = lienSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'workflowId (uuid) et phrase sont requis' });
    const { workflowId, phrase } = parse.data;
    const startNodeId = parse.data.startNodeId ?? null;
    const maxParHeure = parse.data.maxParHeure ?? null;
    // Un tenant ne peut cibler QUE ses propres scenarios (meme garde que la campagne workflow).
    if ((await deps.scenarioEtat(tenant, workflowId)) === 'inconnu') {
      return reply.code(400).send({ error: 'workflowId inconnu pour ce tenant' });
    }
    // Sans numero connecte il n'y a aucune URL wa.me a mettre dans le post : on refuse la creation plutot
    // que de fabriquer un lien casse que rien ne rattraperait une fois le post parti.
    const phone = await deps.getDisplayPhoneNumber(tenant);
    if (phone === null) {
      return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : connecte un numero avant de creer un lien de chaine' });
    }
    // Le jeton est tire par le SERVEUR. Il n'est jamais journalise : il circule dans des messages publics,
    // mais c'est lui qui declenche un scenario.
    const token = nouveauJeton();
    // L'automation nait ETEINTE et ne s'allume qu'a la publication reussie : un lien cree mais jamais
    // publie ne declenche rien, donc un jeton qui fuiterait avant publication est inerte.
    const { id: automationId } = await deps.creerAutomationCompagnon(tenant, {
      nom: `Chaine : ${phrase}`.slice(0, 200),
      jeton: token,
      workflowId,
      startNodeId,
      cooldownSeconds: COOLDOWN_LIEN_SECONDES,
      maxParHeure,
    });
    const lien = await deps.createLink(tenant, { workflowId, startNodeId, token, phrase, automationId, maxParHeure });
    const texte = textePreRempli(phrase, token);
    return reply.code(201).send({ link: { ...lien, texteRempli: texte, waMeUrl: lienWaMe(phone, texte) } });
  });

  app.post(`${base}/links/:id/disable`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'lien inconnu' });
    const lien = await deps.linkById(tenant, id);
    if (!lien) return reply.code(404).send({ error: 'lien inconnu' });
    // 🔴 L'etat d'un lien EST le `enabled` de son automation : il n'y a pas de second drapeau a ecrire, et
    // en poser un creerait deux copies du meme etat, qui divergeraient au premier chemin qui n'ecrit qu'une
    // des deux. On eteint plutot qu'on ne supprime : un post publie circule pour toujours, l'extinction est
    // reversible, la suppression laisserait un bouton mort sans trace.
    if (lien.automationId === null) {
      return reply.code(409).send({ error: 'ce lien n’a plus d’automation compagnon : il ne declenche deja plus rien' });
    }
    await deps.basculerAutomation(tenant, lien.automationId, false);
    return reply.code(200).send({ ok: true });
  });
```

- [ ] **Step 13: relancer, constater le vert, committer les liens**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts && npm run typecheck
```

Attendu : `Tests 15 passed`, puis `tsc --noEmit` muet.

```bash
cd /c/Users/julie/messagingme-mba && git add src/http/channels-me.ts tests/http-channels-me.test.ts && git commit -m "feat(channels-me): connexion et liens de chaine, le lien s eteint par son automation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 14: ajouter les cas de test des publications et de la demande d'activation (rouge)**

A la suite dans `tests/http-channels-me.test.ts` :

```ts
describe('Channels Me : publier', () => {
  it('publie, PUIS allume l automation, PUIS trace : l ordre est ce qui compte', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(201);
    // Le lien wa.me est AJOUTE au texte du post par le serveur : c'est lui qui fait apparaitre le bouton
    // que WhatsApp dessine, le client ne le colle pas a la main.
    expect(cap.publies[0]!.text).toContain('https://wa.me/33525680250?text=');
    expect(cap.publies[0]!.text.startsWith('Notre newsletter arrive')).toBe(true);
    // 🔴 Publier d'abord : une automation allumee avant une publication qui echoue laisserait un jeton
    // vivant sans post. Allumer ensuite : sinon le bouton du post est mort. Tracer en dernier.
    expect(cap.ordre).toEqual(['publie', 'bascule', 'trace']);
    expect(cap.bascules).toEqual([{ id: AUTO_ID, enabled: true }]);
    expect(cap.posts).toEqual([{ cmMessageId: 'cm-msg-1', linkId: LINK_ID }]);
    await server.close();
  });

  it('🔴 scenario sans version publiee : 409 AVANT toute publication, rien ne part et rien ne s allume', async () => {
    const { server, cap } = app({ scenarioEtat: async () => 'vide' });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    // Un post publie circule POUR TOUJOURS : un bouton qui demarre un scenario vide ne se rattrape pas.
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('publiee');
    expect(cap.publies).toEqual([]);
    expect(cap.bascules).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  it('🔴 publication refusee par le tiers : 422, et le lien reste ETEINT', async () => {
    const { server, cap } = app({ createMessage: async () => { throw new Error('422 text too long'); } });
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
      payload: { text: 'Notre newsletter arrive', linkId: LINK_ID },
    });
    expect(res.statusCode).toBe(422);
    expect(cap.bascules).toEqual([]);
    expect(cap.posts).toEqual([]);
    await server.close();
  });

  it('mediaUrl non https ou interne : 400, et rien n est publie', async () => {
    const { server, cap } = app();
    for (const mediaUrl of ['http://exemple.fr/a.jpg', 'https://169.254.169.254/a.jpg', 'https://localhost/a.jpg']) {
      const res = await server.inject({
        method: 'POST', url: '/tenants/t1/channels-me/posts', ...h(adminTok),
        payload: { text: 'Bonjour', mediaUrl },
      });
      expect(res.statusCode, `${mediaUrl} aurait du etre refusee`).toBe(400);
    }
    expect(cap.publies).toEqual([]);
    await server.close();
  });

  it('la liste des publications joint le statut LU EN DIRECT chez le tiers', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'GET', url: '/tenants/t1/channels-me/posts', ...h(adminTok) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ posts: Array<{ message: unknown }> }>().posts[0]!.message).not.toBeNull();
    // Rien n'est miroite en base, donc rien a resynchroniser : un tiers muet rend un statut absent, pas une
    // erreur, et surtout pas une liste vide.
    const { server: s2 } = app({ getMessages: async () => { throw new Error('reseau'); } });
    const r2 = await s2.inject({ method: 'GET', url: '/tenants/t1/channels-me/posts', ...h(adminTok) });
    expect(r2.statusCode).toBe(200);
    expect(r2.json<{ distant: string }>().distant).toBe('injoignable');
    expect(r2.json<{ posts: Array<{ message: unknown }> }>().posts[0]!.message).toBeNull();
    await server.close();
    await s2.close();
  });

  it('la demande d activation part, et un agent n y a pas droit', async () => {
    const { server, cap } = app();
    const res = await server.inject({
      method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok),
      payload: { message: 'On voudrait une chaine pour la rentree' },
    });
    expect(res.statusCode).toBe(200);
    expect(cap.demandes).toEqual([{ message: 'On voudrait une chaine pour la rentree' }]);
    expect((await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(agentTok), payload: {} })).statusCode).toBe(403);
    await server.close();
  });

  it('demande d activation non cablee : 503 explicite, pas une page d incident', async () => {
    const { server } = app();
    const sans = buildServer({
      queue: new FakeQueue(),
      auth: { users: noUsers, secret: SECRET },
      channelsMe: { ...app().server, ...{} } as never,
    });
    await sans.close();
    await server.close();
  });
});
```

⚠️ Le dernier `it` ci-dessus est volontairement remplace a l'ecriture par la forme correcte, qui construit des deps SANS `demanderActivation` :

```ts
  it('demande d activation non cablee : 503 explicite, pas une page d incident', async () => {
    const { server } = app();
    const res = await server.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok), payload: {} });
    expect(res.statusCode).toBe(200);
    await server.close();

    // Le meme montage, prive de la dependance optionnelle : c'est ce qui permet a un cablage de test de
    // monter le module sans notification.
    const { server: nu, cap } = app({ demanderActivation: undefined });
    const r = await nu.inject({ method: 'POST', url: '/tenants/t1/channels-me/activation-request', ...h(adminTok), payload: {} });
    expect(r.statusCode).toBe(503);
    expect(cap.demandes).toEqual([]);
    await nu.close();
  });
```

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Attendu : `7 failed | 15 passed`, les echecs disant `expected 404 to be 201` / `to be 200` / `to be 409`.

- [ ] **Step 15: ecrire GET /posts, POST /posts et POST /activation-request**

A la suite dans `src/http/channels-me.ts`. Le limiteur se declare en tete du corps de `registerChannelsMeRoutes`, juste apres `const base = ...` :

```ts
  // Un limiteur PROPRE a cet endpoint (jamais l'instance d'un autre : regle deja posee dans
  // src/auth/routes.ts). Cle = userId, PAS req.ip : la route est authentifiee, et Fastify n'est pas
  // construit en `trustProxy`, donc derriere le proxy `req.ip` est le meme pour tout le monde.
  const limiteurDemande = new RateLimiter(3, 60_000);
```

Puis les trois routes :

```ts
  app.get(`${base}/posts`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const posts = await deps.listPosts(tenant);
    const cx = await deps.getSecrets(tenant);
    const sansStatut = (distant: string) =>
      reply.code(200).send({ posts: posts.map((p) => ({ ...p, message: null })), distant });
    if (!cx) return sansStatut('non_configuree');
    if (posts.length === 0) return reply.code(200).send({ posts: [], distant: 'ok' });
    try {
      // Le statut se LIT EN DIRECT : rien n'est miroite en base, donc il n'y a rien a resynchroniser et
      // aucune file de rattrapage. Une seule lecture sert toute la liste (le tiers ne pagine pas).
      const messages = await deps.getMessages(cx);
      const parId = new Map(messages.map((m) => [String(m.id), m]));
      return reply.code(200).send({
        posts: posts.map((p) => ({ ...p, message: parId.get(p.cmMessageId) ?? null })),
        distant: 'ok',
      });
    } catch (err) {
      journaliserDistant(tenant, 'posts_read', err);
      return sansStatut('injoignable');
    }
  });

  app.post(`${base}/posts`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const parse = postSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'text requis (1 a 4096 caracteres) ; mediaUrl doit etre une adresse' });
    }
    const { text, mediaUrl } = parse.data;
    // 🔴 Nous ne recuperons JAMAIS ce media (c'est Channels Me qui le fait), donc pas de resolution DNS ici,
    // qui n'aurait aucun sens : la verification TEXTUELLE existante suffit a refuser un hote interne, et on
    // exige https en plus.
    if (mediaUrl !== undefined && (!urlRecuperable(mediaUrl) || new URL(mediaUrl).protocol !== 'https:')) {
      return reply.code(400).send({ error: 'mediaUrl doit etre une adresse https publique' });
    }
    const cx = await deps.getSecrets(tenant);
    if (!cx) return reply.code(409).send({ error: 'aucune connexion enregistree : renseigne les identifiants avant de publier' });

    let lien: LienRow | null = null;
    let texteDuPost = text;
    if (parse.data.linkId !== undefined) {
      lien = await deps.linkById(tenant, parse.data.linkId);
      if (!lien) return reply.code(400).send({ error: 'linkId inconnu pour ce tenant' });
      // 🔴 UN POST PUBLIE CIRCULE POUR TOUJOURS. Un bouton qui demarre un scenario sans version publiee ne
      // se rattrape pas : on refuse AVANT de publier, jamais apres.
      const etat = await deps.scenarioEtat(tenant, lien.workflowId);
      if (etat !== 'ok') {
        return reply.code(409).send({
          error: etat === 'inconnu'
            ? 'le scenario de ce lien n’existe plus'
            : 'ce scenario n’a aucune version publiee : publie-le avant de publier le post',
        });
      }
      const url = lienWaMe(await deps.getDisplayPhoneNumber(tenant), textePreRempli(lien.phrase, lien.token));
      if (url === null) {
        return reply.code(409).send({ error: 'aucun numero WhatsApp connecte : impossible de fabriquer le lien du post' });
      }
      texteDuPost = `${text}\n\n${url}`;
    }

    let publie: Message;
    try {
      publie = await deps.createMessage(cx, { text: texteDuPost, ...(mediaUrl !== undefined ? { mediaUrl } : {}) });
    } catch (err) {
      journaliserDistant(tenant, 'post_create', err);
      return reply.code(422).send({ error: 'Channels Me a refuse la publication. Verifie le texte et l’image, puis reessaie.' });
    }

    // 🔴 A PARTIR D'ICI LE POST CIRCULE, plus rien n'est annulable. On allume D'ABORD (sinon le bouton du
    // post est mort des sa diffusion), on trace ENSUITE (la trace n'a aucun effet sur l'abonne).
    if (lien?.automationId) await deps.basculerAutomation(tenant, lien.automationId, true);
    const cmMessageId = String(publie.id);
    await deps.createPost(tenant, { cmMessageId, linkId: lien?.id ?? null });
    return reply.code(201).send({ post: { cmMessageId, linkId: lien?.id ?? null } });
  });

  app.post(`${base}/activation-request`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const userId = req.auth?.userId ?? null;
    // Le 403 tenant reste prioritaire (il ne coute rien et ne doit pas consommer de quota).
    if (!limiteurDemande.take(userId ?? req.ip)) {
      return reply.code(429).send({ error: 'trop de demandes, reessaie plus tard' });
    }
    if (!deps.demanderActivation) return reply.code(503).send({ error: 'demande d’activation indisponible sur cette instance' });
    const parse = demandeSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'message trop long (2000 caracteres maximum)' });
    await deps.demanderActivation({ tenantId: tenant, userId, message: parse.data.message ?? '' });
    return reply.code(200).send({ ok: true });
  });
```

- [ ] **Step 16: relancer, constater le vert, committer les publications**

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts && npm run typecheck
```

Attendu : `Tests 22 passed`, puis `tsc --noEmit` muet.

```bash
cd /c/Users/julie/messagingme-mba && git add src/http/channels-me.ts tests/http-channels-me.test.ts && git commit -m "feat(channels-me): publier, puis allumer, puis tracer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 17: ecrire le test d'integration de la bascule d'une automation POSSEDEE (rouge)**

Creer `tests/integration/channels-me-automation-compagnon.integration.test.ts`. La bascule ne peut pas passer par `update`, dont le predicat porte desormais `and possede_par is null` : c'est justement ce qui met la ligne hors de portee de l'ecran Automation.

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAutomationStore } from '../../src/automation/store.pg';

// Ne PAS lancer ce fichier en local : le DATABASE_URL du .env local pointe sur la base de PRODUCTION
// (cf. CLAUDE.md du repo), et ce fichier cree/supprime des tenants. La CI monte un Postgres jetable pour ca
// (job `integration`) : c'est la qu'il doit tourner.
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('automation POSSEDEE par un lien de chaine (Postgres reel)', () => {
  let pool: Pool;
  let store: PgAutomationStore;
  let tenantId: string;
  let autreTenantId: string;
  let workflowId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgAutomationStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cm-automation') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-cm-automation-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const w = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    );
    workflowId = w.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  const input = () => ({
    name: 'Chaine : test', triggerKind: 'keyword' as const,
    triggerConfig: { keywords: ['cm-a7k2m9p3'], mode: 'contains' },
    conditionGroup: null, workflowId, startNodeId: null, cooldownSeconds: 300,
    enabled: false, possedePar: 'channelsme_link', maxFiresPerHour: 2000,
  });

  it('🔴 une automation possedee est INVISIBLE de l ecran Automation et immodifiable par lui', async () => {
    const { id } = await store.create(tenantId, input());
    expect((await store.list(tenantId)).map((a) => a.id)).not.toContain(id);
    expect(await store.getById(id, tenantId)).toBeNull();
    // Sans ces deux refus, l'ecran Automation casserait le lien en silence : le post resterait en ligne avec
    // un bouton qui ne declenche plus rien.
    expect(await store.update(id, tenantId, { enabled: true })).toBe(false);
    expect(await store.remove(id, tenantId)).toBe(false);
  });

  it('son PROPRIETAIRE la bascule, et lui seul', async () => {
    const { id } = await store.create(tenantId, input());
    expect(await store.setEnabledPossedee(id, tenantId, 'channelsme_link', true)).toBe(true);
    const vue = await pool.query<{ enabled: boolean }>('select enabled from automations where id = $1', [id]);
    expect(vue.rows[0]!.enabled).toBe(true);
    // Un AUTRE proprietaire, ou un autre espace, ne touche rien.
    expect(await store.setEnabledPossedee(id, tenantId, 'webhook', false)).toBe(false);
    expect(await store.setEnabledPossedee(id, autreTenantId, 'channelsme_link', false)).toBe(false);
    const apres = await pool.query<{ enabled: boolean }>('select enabled from automations where id = $1', [id]);
    expect(apres.rows[0]!.enabled).toBe(true);
  });
});
```

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck
```

Attendu : `error TS2339: Property 'setEnabledPossedee' does not exist on type 'PgAutomationStore'.`

- [ ] **Step 18: ajouter setEnabledPossedee a src/automation/store.pg.ts**

Juste apres la methode `remove` :

```ts
  /**
   * Allume ou eteint une automation POSSEDEE par un autre objet (aujourd'hui un lien de chaine).
   *
   * 🔴 Pourquoi elle ne passe pas par `update`. Le predicat de ce store porte desormais
   * `and possede_par is null` : c'est ce qui met ces lignes hors de portee de l'ecran Automation, qui les
   * casserait en silence. Leur proprietaire, lui, doit pouvoir les basculer, et il est le SEUL : le
   * `possede_par = $3` de cette requete est ce qui l'y autorise, et il interdit a un proprietaire d'eteindre
   * l'automation d'un autre. Meme doctrine que `PgWebhookStore`, qui ecrit lui aussi ses propres requetes
   * sur `automations` pour sa ligne compagnon.
   */
  async setEnabledPossedee(id: string, tenantId: string, possedePar: string, enabled: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update automations set enabled = $4, updated_at = now()
        where id = $1 and tenant_id = $2 and possede_par = $3`,
      [id, tenantId, possedePar, enabled],
    );
    return (res.rowCount ?? 0) > 0;
  }
```

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck
```

Attendu : `tsc --noEmit` muet. Le fichier d'integration ne tourne PAS ici (`DATABASE_URL` local = production) : il tournera en CI, job `integration`.

- [ ] **Step 19: cabler le module dans src/index.ts (construction des stores)**

Avec les autres imports en tete de `src/index.ts` :

```ts
import { PgChannelsMeConnectionStore } from './channels-me/connection-store.pg';
import { PgChannelsMeLinkStore } from './channels-me/link-store.pg';
import { PgChannelsMePostStore } from './channels-me/post-store.pg';
import { ChannelsMeClient } from './channels-me/client';
```

Avec les autres constructions de stores, apres `const automationStore = new PgAutomationStore(pool);` :

```ts
  // Chaine WhatsApp (Channels Me). La cle de chiffrement est INJECTEE au store (contrat du sous-systeme),
  // elle n'est pas relue depuis la config a l'interieur : les deux secrets sont chiffres la, jamais plus haut.
  const channelsMeConnections = new PgChannelsMeConnectionStore(pool, config.ENCRYPTION_KEY);
  const channelsMeLinks = new PgChannelsMeLinkStore(pool);
  const channelsMePosts = new PgChannelsMePostStore(pool);
  // Hote FIXE et de confiance : aucune verification d'adresse privee, meme traitement que les clients Meta
  // et Zadarma.
  const channelsMeClient = new ChannelsMeClient();
```

- [ ] **Step 20: cabler le bloc channelsMe dans l'objet passe a buildServer**

Dans `src/index.ts`, dans l'objet litteral de `buildServer({ ... })`, apres le bloc `automations` :

```ts
    // Chaine WhatsApp (Channels Me) : publier un post dont le bouton demarre un scenario.
    channelsMe: {
      getConnection: (tenant) => channelsMeConnections.get(tenant),
      getSecrets: (tenant) => channelsMeConnections.getSecrets(tenant),
      upsertConnection: (tenant, c) => channelsMeConnections.upsert(tenant, c),
      markVerified: (tenant) => channelsMeConnections.markVerified(tenant),
      getOrganisation: (cx) => channelsMeClient.getOrganisation(cx),
      listChannels: (cx) => channelsMeClient.listChannels(cx),
      getMessages: (cx) => channelsMeClient.getMessages(cx),
      // 🔴 `m` DOIT ETRE RELAYE ENTIER. Une fleche a un parametre est parfaitement assignable a un contrat
      // qui en declare deux : le second serait avale EN SILENCE, l'image du post disparaitrait sans que le
      // typecheck ne dise rien. Defaut deja paye en production le 2026-09-03.
      createMessage: (cx, m) => channelsMeClient.createMessage(cx, m),
      listLinks: (tenant) => channelsMeLinks.list(tenant),
      createLink: (tenant, l) => channelsMeLinks.create(tenant, l),
      linkById: (tenant, id) => channelsMeLinks.byId(tenant, id),
      listPosts: (tenant) => channelsMePosts.list(tenant),
      createPost: (tenant, p) => channelsMePosts.create(tenant, p),
      // L'automation compagnon du lien. Trois choses se decident ICI et nulle part ailleurs :
      //  - `enabled: false`, parce qu'un lien cree mais jamais publie ne doit rien declencher ;
      //  - `possedePar`, qui met la ligne hors de portee de l'ecran Automation (predicat du store) ;
      //  - `mode: 'contains'`, qui laisse passer un abonne ayant ajoute un mot devant ou derriere la phrase.
      creerAutomationCompagnon: (tenant, input) => automationStore.create(tenant, {
        name: input.nom,
        triggerKind: 'keyword',
        triggerConfig: { keywords: [input.jeton], mode: 'contains' },
        conditionGroup: null,
        workflowId: input.workflowId,
        startNodeId: input.startNodeId,
        cooldownSeconds: input.cooldownSeconds,
        enabled: false,
        possedePar: 'channelsme_link',
        maxFiresPerHour: input.maxParHeure,
      }),
      basculerAutomation: (tenant, id, enabled) => automationStore.setEnabledPossedee(id, tenant, 'channelsme_link', enabled),
      scenarioEtat: async (tenant, wfId) => {
        const wf = await workflowStore.getById(wfId, tenant);
        if (!wf) return 'inconnu';
        // « Aucune version publiee » se lit sur le graphe PUBLIE, le seul que l'executeur lise : un scenario
        // dont il est vide ne demarrerait rien, meme si un brouillon existe a cote.
        return wf.graph.nodes.length > 0 ? 'ok' : 'vide';
      },
      getDisplayPhoneNumber: async (tenant) => (await phoneStatusStore.getPhoneNumber(tenant))?.displayPhoneNumber ?? null,
      // Notification best-effort : `sendTelegram` ne leve jamais et est un no-op si Telegram n'est pas
      // configure. Le jeton d'un lien n'apparait nulle part dans ce message.
      demanderActivation: async ({ tenantId, userId, message }) => {
        await sendTelegram(`[engage-me] demande d’activation Channels Me\nespace ${tenantId}\nutilisateur ${userId ?? 'inconnu'}\n${message.slice(0, 500)}`);
      },
    },
```

- [ ] **Step 21: ajouter le garde-fou qui lit le cablage (rouge puis vert)**

Le `enabled: false` de la creation vit dans `src/index.ts`, qu'aucun type ne contraint. Ajouter ce cas a la fin de `tests/http-channels-me.test.ts`, avec `import { readFileSync } from 'node:fs';` en tete du fichier :

```ts
describe('Channels Me : le cablage', () => {
  it('🔴 l automation compagnon est creee ETEINTE, en `contains`, et POSSEDEE', () => {
    // Ce test lit la source parce qu'aucun type ne peut exprimer « cette automation nait eteinte ». Les
    // routes ne voient qu'une dependance : si le cablage la creait allumee, un lien jamais publie
    // declencherait des scenarios, et rien dans les tests de routes ne le verrait.
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const debut = src.indexOf('channelsMe: {');
    expect(debut).toBeGreaterThan(0);
    const bloc = src.slice(debut, src.indexOf('\n    },', debut));
    expect(bloc).toContain('enabled: false');
    expect(bloc).toContain("possedePar: 'channelsme_link'");
    expect(bloc).toContain("triggerKind: 'keyword'");
    expect(bloc).toContain("mode: 'contains'");
  });
});
```

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/http-channels-me.test.ts
```

Attendu si le bloc de cablage a ete mal recopie : `expected -1 to be greater than 0`. Avec le cablage du step 20 : `Tests 23 passed`.

- [ ] **Step 22: verification complete, dans les deux sens**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test
```

Attendu : `tsc --noEmit` muet, puis la suite unitaire entiere au vert (`tests/integration/**` est exclu par `vitest.config.ts`).

Puis prouver que le garde-fou du montage echoue bien SANS le montage : retirer temporairement `deps.channelsMe` de la liste `modulesTenant` de `src/server.ts`, lancer

```bash
cd /c/Users/julie/messagingme-mba && npx vitest run tests/scope-tenant.test.ts
```

et constater `ces modules exposent des routes tenant sans etre couverts par le garde-fou : channelsMe`, puis remettre la ligne et relancer pour revoir le vert. Un test de non-regression ne prouve rien tant qu'on n'a pas vu qu'il echoue sans le correctif.

- [ ] **Step 23: committer le cablage**

```bash
cd /c/Users/julie/messagingme-mba && git add src/index.ts src/automation/store.pg.ts tests/http-channels-me.test.ts tests/integration/channels-me-automation-compagnon.integration.test.ts && git commit -m "feat(channels-me): le cablage, et la bascule reservee au proprietaire de l automation

L automation compagnon d un lien de chaine nait eteinte et n est allumee que par une
publication reussie. Elle est POSSEDEE : l ecran Automation ne la voit plus, ne la modifie
plus et ne la supprime plus, et seul son proprietaire la bascule (setEnabledPossedee).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Puis, avant de considerer la tache finie :

```bash
cd /c/Users/julie/messagingme-mba && git push origin main && gh run list --limit 3
```

Un `npm test` vert en local ne prouve que la moitie : les tests d'integration (dont
`tests/integration/channels-me-automation-compagnon.integration.test.ts`, qui est le seul a prouver le
predicat `possede_par`) ne tournent qu'en CI, sur un Postgres jetable. Regarder le run avant de conclure.


---

### Task 9: Front : module d appel et carte de connexion

La console gagne sa section **Chaîne** : un module d'appel qui fige les huit chemins gelés du serveur, la
carte de connexion en données réelles (nom de la chaîne, publications, quota du mois) et l'état vide avec le
bouton de demande d'activation. Le composeur et la liste des publications de la maquette arrivent à la tâche
suivante, sur la même page.

🔴 **Ce que cette tâche ferme.** Au lot précédent, le front tapait `/connexion` quand le serveur montait
`/connection`. Rien ne le signale : pas le compilateur (un chemin est une chaîne de caractères), pas un test
de composant, seulement un 404 découvert à l'écran. Les huit chemins sont donc écrits **une seule fois**,
dérivés d'un `base()`, et un test les compare un par un aux routes du contrat gelé, méthode comprise.

**Files:**
- Create : `C:\Users\julie\messagingme-mba\web\lib\api-chaine.ts`
- Create : `C:\Users\julie\messagingme-mba\web\components\ChaineConnexion.tsx`
- Create : `C:\Users\julie\messagingme-mba\web\app\chaine\page.tsx`
- Modify : `C:\Users\julie\messagingme-mba\web\components\AppShell.tsx` (type `Tab` ligne 14, objet `icons` ligne 25, tableau `NAV_ADMIN` ligne 77)
- Test : `C:\Users\julie\messagingme-mba\web\lib\api-chaine.test.ts` (vitest front, ni base ni réseau, faux `fetch` injecté)
- Test : `C:\Users\julie\messagingme-mba\web\e2e\chaine-connexion.spec.ts` (Playwright, toutes les requêtes interceptées)

⚠️ `web/lib/api.ts` (le barrel) n'est **pas** touché : il ne réexporte que les modules de domaine de
`lib/api/`. Le contrat gèle le chemin `web/lib/api-chaine.ts`, qui appartient donc à l'autre famille du
dépôt, celle de `lib/api-agent-sources.ts`, `lib/api-agent-tools.ts` et `lib/api-mba.ts` : ces modules
s'importent en direct (`@/lib/api-chaine`). Ajouter une ligne au barrel pour un fichier hors de `lib/api/`
mélangerait les deux conventions.

**Interfaces:**

- **Consumes** (de l'existant et des tâches précédentes, signatures exactes) :
  - `request<T>(path: string, init?: RequestInit): Promise<T>` de `web/lib/http.ts`. Elle pose déjà
    `content-type: application/json`, le `Bearer` de la session, le retry GET/HEAD sur 5xx et la purge de
    session sur 401. `BASE` vaut `/api/backend` tant que `NEXT_PUBLIC_API_URL` est absente.
  - `useT(): (fr: string, en?: string) => string` et `useLocale(): { locale: Locale }` de `web/lib/i18n`.
  - `fmtNum(n: number, locale: Locale): string` de `web/lib/format`.
  - `cardCls` de `web/lib/ui`.
  - `AppShell({ active, children })` de `web/components/AppShell`, `Session` de `web/lib/session`.
  - Les routes gelées, montées sous `/tenants/:tenantId/channels-me` : `GET /connection`, `PUT /connection`,
    `POST /connection/test`, `GET /links`, `POST /links`, `POST /links/:id/disable`, `GET /posts`,
    `POST /posts`, `POST /activation-request`.
  - Les enveloppes de réponse attendues, **à tenir identiques côté serveur** (cf. open questions) :
    `GET /connection` rend `{ connection, chaine, erreurDistante? }` ; `GET /links` rend `{ links: [...] }` ;
    `POST /links` rend `{ link }` ; `GET /posts` rend `{ posts: [...] }` ; `POST /posts` rend `{ post }` ;
    `POST /connection/test` rend `{ ok, channelName?, erreur? }` ; `PUT /connection`,
    `POST /links/:id/disable` et `POST /activation-request` ne rendent rien que l'écran lise.

- **Produces** (ce que les tâches suivantes utilisent) :
  ```ts
  // web/lib/api-chaine.ts
  export interface ConnexionPublique { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }
  export interface EtatChaine { orgName: string; channelName: string; messagesCount: number; monthlyUsed: number; monthlyLimit: number | null }
  export interface ReponseConnexionChaine { connection: ConnexionPublique | null; chaine: EtatChaine | null; erreurDistante?: string | null }
  export interface ResultatTestChaine { ok: boolean; channelName?: string; erreur?: string }
  export interface LienChaine { id: string; workflowId: string; startNodeId: string | null; phrase: string; waLink: string | null; enabled: boolean; maxParHeure: number | null; createdAt: string }
  export interface EntreeLienChaine { workflowId: string; startNodeId?: string | null; phrase: string; maxParHeure?: number | null }
  export interface PostChaine { id: string; cmMessageId: string; linkId: string | null; status: string; text: string; phrase: string | null; workflowName: string | null; conversations: number | null; createdAt: string }
  export interface EntreePostChaine { text: string; mediaUrl?: string; linkId: string | null }

  export function getConnexionChaine(tenantId: string): Promise<ReponseConnexionChaine>
  export function enregistrerConnexionChaine(tenantId: string, c: { orgId: string; channelId: string; apiKey: string; secret: string }): Promise<void>
  export function testerConnexionChaine(tenantId: string): Promise<ResultatTestChaine>
  export function listerLiensChaine(tenantId: string): Promise<LienChaine[]>
  export function creerLienChaine(tenantId: string, input: EntreeLienChaine): Promise<LienChaine>
  export function eteindreLienChaine(tenantId: string, id: string): Promise<void>
  export function listerPostsChaine(tenantId: string): Promise<PostChaine[]>
  export function publierPostChaine(tenantId: string, input: EntreePostChaine): Promise<PostChaine>
  export function demanderActivationChaine(tenantId: string, message?: string): Promise<void>

  // web/components/ChaineConnexion.tsx
  export type EtatDemande = 'idle' | 'envoi' | 'envoyee' | 'erreur';
  export interface ChaineConnexionProps {
    reponse: ReponseConnexionChaine | null;   // null = chargement en cours
    erreur: string | null;                    // le chargement a echoue (distinct de « aucune chaine »)
    scenarios?: number | null;                // nombre de liens, mesure masquee tant qu il vaut null
    demande: EtatDemande;
    onDemanderActivation: () => void;
  }
  export function ChaineConnexion(props: ChaineConnexionProps): React.ReactElement

  // web/components/AppShell.tsx : le type Tab accepte desormais 'chaine', et NAV_ADMIN porte
  // { key: 'chaine', href: '/chaine', label: t('Chaîne', 'Channel'), d: icons.chaine } juste apres Campagnes.
  ```
  La page `web/app/chaine/page.tsx` **détient le chargement** de la connexion et le passe en props : le
  composeur et la liste de la tâche suivante vivent sur la même page et ont besoin de la même réponse, la
  charger deux fois enverrait deux appels identiques à chaque ouverture.

  🔴 **Le front ne fabrique jamais un jeton ni une URL `wa.me`.** `LienChaine.waLink` arrive **composé par le
  serveur** (même règle que l'adresse d'un webhook entrant) : le jeton est tiré côté serveur, le numéro
  WhatsApp du tenant vit côté serveur, et une recomposition au navigateur divergerait en silence du jeton
  réellement cherché sur le chemin chaud.

  **Sélecteurs E2E produits** (à réutiliser tels quels par la tâche suivante) : `chaine-carte`, `chaine-nom`,
  `chaine-publications`, `chaine-quota`, `chaine-scenarios`, `chaine-vide`, `chaine-demander`,
  `chaine-demande-ok`, `chaine-demande-erreur`, `chaine-injoignable`, `chaine-erreur`.

---

- [ ] **Step 1: écrire le test qui échoue, `web/lib/api-chaine.test.ts`**

Créer `C:\Users\julie\messagingme-mba\web\lib\api-chaine.test.ts` :

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getConnexionChaine, enregistrerConnexionChaine, testerConnexionChaine,
  listerLiensChaine, creerLienChaine, eteindreLienChaine,
  listerPostsChaine, publierPostChaine, demanderActivationChaine,
} from './api-chaine';

/**
 * Les appels de la section Chaîne (Channels Me).
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. 🔴 LES CHEMINS. Au lot précédent, le front tapait `/connexion` quand le serveur montait
 *     `/connection` : aucune erreur de compilation, aucun test rouge, juste un 404 découvert à l'écran.
 *     Les neuf appels sont donc comparés aux routes gelées, méthode comprise.
 *  2. Une liste absente de la réponse doit rendre un tableau vide : posé tel quel dans un état typé
 *     tableau, `undefined` démonterait l'écran au premier `.map`.
 *  3. 🔴 AUCUN SECRET NE REDESCEND. La clé d'API et le secret partent en PUT, la lecture n'en rend que des
 *     booléens. Le jour où la projection publique fuirait, ce test le dit.
 *  4. Le front n'invente rien : il envoie ce que l'écran a saisi, il ne fabrique ni jeton ni lien wa.me.
 */

interface Appel { url: string; method: string; body: unknown }

const appels: Appel[] = [];
let corpsRendu: unknown = {};
const vraiFetch = globalThis.fetch;

beforeEach(() => {
  appels.length = 0;
  corpsRendu = {};
  // Faux `fetch` posé sur le global : `request` (lib/http.ts) n'offre pas d'injection, et ce module ne doit
  // toucher aucun réseau. Toutes les réponses sont en 200, donc ni retry ni purge de session ici.
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    appels.push({
      url: String(url),
      method: (init.method ?? 'GET').toUpperCase(),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(corpsRendu), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = vraiFetch; });

describe('module d’appel de la Chaîne', () => {
  it('🔴 les chemins tapés sont EXACTEMENT les routes gelées du serveur', async () => {
    corpsRendu = { links: [], posts: [], link: { id: 'l1' }, post: { id: 'p1' } };
    await getConnexionChaine('t1');
    await enregistrerConnexionChaine('t1', { orgId: 'o', channelId: 'c', apiKey: 'k', secret: 's' });
    await testerConnexionChaine('t1');
    await listerLiensChaine('t1');
    await creerLienChaine('t1', { workflowId: 'wf1', phrase: 'Je veux en savoir plus' });
    await eteindreLienChaine('t1', 'l1');
    await listerPostsChaine('t1');
    await publierPostChaine('t1', { text: 'coucou', linkId: 'l1' });
    await demanderActivationChaine('t1');

    // Le préfixe `/api/backend` est posé par `BASE` (lib/http.ts) : un chemin qui le porterait déjà partirait
    // en double. Et c'est `channels-me` côté API, `chaine` seulement dans l'URL de l'écran.
    expect(appels.map((a) => `${a.method} ${a.url}`)).toEqual([
      'GET /api/backend/tenants/t1/channels-me/connection',
      'PUT /api/backend/tenants/t1/channels-me/connection',
      'POST /api/backend/tenants/t1/channels-me/connection/test',
      'GET /api/backend/tenants/t1/channels-me/links',
      'POST /api/backend/tenants/t1/channels-me/links',
      'POST /api/backend/tenants/t1/channels-me/links/l1/disable',
      'GET /api/backend/tenants/t1/channels-me/posts',
      'POST /api/backend/tenants/t1/channels-me/posts',
      'POST /api/backend/tenants/t1/channels-me/activation-request',
    ]);
  });

  it('une liste absente de la réponse rend un tableau vide, jamais undefined', async () => {
    corpsRendu = {};
    expect(await listerLiensChaine('t1')).toEqual([]);
    expect(await listerPostsChaine('t1')).toEqual([]);
  });

  it('🔴 le PUT porte les deux secrets, la lecture n’en rend que des booléens', async () => {
    // Valeurs FICTIVES (aucun secret réel) : figées pour rendre les assertions lisibles.
    await enregistrerConnexionChaine('t1', { orgId: 'org_1', channelId: 'chan_1', apiKey: 'cle-FICTIVE', secret: 'secret-FICTIF' });
    expect(appels[0]!.body).toEqual({ orgId: 'org_1', channelId: 'chan_1', apiKey: 'cle-FICTIVE', secret: 'secret-FICTIF' });

    corpsRendu = {
      connection: { orgId: 'org_1', channelId: 'chan_1', hasApiKey: true, hasSecret: true, verifiedAt: null },
      chaine: null,
    };
    const r = await getConnexionChaine('t1');
    expect(JSON.stringify(r)).not.toContain('cle-FICTIVE');
    expect((r.connection as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect((r.connection as unknown as Record<string, unknown>).secret).toBeUndefined();
  });

  it('la création d’un lien n’envoie que le scénario et la phrase, aucun jeton fabriqué ici', async () => {
    // Le jeton est tiré par le SERVEUR et le lien wa.me composé par lui : un jeton fabriqué au navigateur
    // divergerait de celui que l'automation cherche, et le bouton du post serait mort.
    corpsRendu = { link: { id: 'l1' } };
    await creerLienChaine('t1', { workflowId: 'wf1', phrase: 'Je veux en savoir plus' });
    expect(appels[0]!.body).toEqual({ workflowId: 'wf1', phrase: 'Je veux en savoir plus' });
  });

  it('la demande d’activation part avec un corps vide, ou avec le mot du client', async () => {
    await demanderActivationChaine('t1');
    expect(appels[0]!.body).toEqual({});
    await demanderActivationChaine('t1', 'On aimerait une chaîne pour la rentrée');
    expect(appels[1]!.body).toEqual({ message: 'On aimerait une chaîne pour la rentrée' });
  });
});
```

- [ ] **Step 2: lancer le test et constater l'échec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/api-chaine.test.ts
```

Sortie attendue (le module n'existe pas encore) :

```
 ❯ lib/api-chaine.test.ts (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  lib/api-chaine.test.ts [ lib/api-chaine.test.ts ]
Error: Failed to load url ./api-chaine (resolved id: ./api-chaine) in C:/Users/julie/messagingme-mba/web/lib/api-chaine.test.ts. Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: écrire `web/lib/api-chaine.ts`**

Créer `C:\Users\julie\messagingme-mba\web\lib\api-chaine.ts` :

```ts
'use client';

/**
 * Les appels de la section Chaîne (Channels Me).
 *
 * 🔴 CE FICHIER EST LA SEULE COPIE DES CHEMINS. Au lot précédent, le front appelait `/connexion` quand le
 * serveur montait `/connection` : rien ne le signale avant le 404, parce qu'un chemin est une chaîne de
 * caractères et qu'aucun type ne la relie à la route montée. Les huit chemins sont donc dérivés du seul
 * `base()` ci-dessous, et `api-chaine.test.ts` les compare aux routes gelées, méthode comprise.
 *
 * ⚠️ DEUX VOCABULAIRES, ET C'EST VOULU. L'écran vit à `/chaine` (côté Next), l'API à `/channels-me` (côté
 * Fastify) : le mot `channel` désigne déjà le tuyau (`whatsapp` | `rcs`) dans ce dépôt, le préfixe
 * `channels-me` évite de faire porter deux sens au même mot.
 *
 * 🔴 AUCUN SECRET NE REDESCEND. `ConnexionPublique` ne porte que `hasApiKey` et `hasSecret` : la clé d'API et
 * le secret HMAC sont chiffrés en base et ne sortent jamais de l'API. Un champ laissé vide dans le formulaire
 * de connexion veut donc dire « inchangé », l'écran ne peut pas renvoyer ce qu'il n'a jamais eu.
 */

import { request } from './http';

/** Projection publique de la connexion : exactement ce que le store rend, jamais les colonnes chiffrées. */
export interface ConnexionPublique {
  orgId: string;
  channelId: string;
  hasApiKey: boolean;
  hasSecret: boolean;
  verifiedAt: string | null;
}

/**
 * Ce que le serveur est allé LIRE EN DIRECT chez Channels Me. Jamais miroité en base : ces chiffres sont ceux
 * de l'instant, pas une copie qui vieillirait sans que personne ne s'en aperçoive.
 */
export interface EtatChaine {
  orgName: string;
  channelName: string;
  /** Nombre de publications de la chaîne. */
  messagesCount: number;
  /** Quota du mois : consommé, et plafond quand le fournisseur l'annonce. */
  monthlyUsed: number;
  monthlyLimit: number | null;
}

/**
 * Réponse de `GET /connection`, et le seul endroit où l'écran sépare TROIS situations qui n'ont pas la même
 * conduite à tenir. `connection` null : aucun identifiant, il faut demander l'activation. `connection`
 * présente et `chaine` null : les identifiants sont là, le fournisseur n'a pas répondu. Les deux présentes :
 * tout va bien. Afficher « connectez votre compte » sur une panne distante enverrait chercher le problème au
 * mauvais endroit.
 */
export interface ReponseConnexionChaine {
  connection: ConnexionPublique | null;
  chaine: EtatChaine | null;
  /** Motif distant, déjà tronqué par le serveur (jamais le corps brut du tiers). Absent s'il n'y a rien à dire. */
  erreurDistante?: string | null;
}

/** Épreuve des identifiants sans rien publier. Un échec est une information, pas une panne de la console. */
export interface ResultatTestChaine {
  ok: boolean;
  channelName?: string;
  erreur?: string;
}

/**
 * Un lien de chaîne : le pont entre un post et un scénario.
 *
 * 🔴 `waLink` ARRIVE COMPOSÉ PAR LE SERVEUR, et le front ne le recompose jamais (même règle que l'adresse
 * d'un webhook entrant). Le jeton est tiré côté serveur et le numéro WhatsApp du tenant vit côté serveur : un
 * lien fabriqué au navigateur divergerait en silence du jeton réellement cherché sur le chemin chaud. null
 * quand aucun numéro WhatsApp n'est connecté.
 *
 * `enabled` est celui de l'automation compagnon, seule source de vérité de l'état allumé ou éteint : le lien
 * n'a pas de drapeau à lui, deux copies du même état finiraient par diverger.
 */
export interface LienChaine {
  id: string;
  workflowId: string;
  startNodeId: string | null;
  phrase: string;
  waLink: string | null;
  enabled: boolean;
  maxParHeure: number | null;
  createdAt: string;
}

export interface EntreeLienChaine {
  workflowId: string;
  startNodeId?: string | null;
  phrase: string;
  maxParHeure?: number | null;
}

/**
 * Une publication. `status` est LU EN DIRECT chez Channels Me : son vocabulaire appartient au fournisseur,
 * donc il reste une chaîne libre et l'écran retombe sur une pastille neutre pour une valeur inconnue.
 * `conversations` est le nombre de scénarios démarrés depuis ce post, null quand aucun lien n'est rattaché.
 */
export interface PostChaine {
  id: string;
  cmMessageId: string;
  linkId: string | null;
  status: string;
  text: string;
  phrase: string | null;
  workflowName: string | null;
  conversations: number | null;
  createdAt: string;
}

export interface EntreePostChaine {
  text: string;
  mediaUrl?: string;
  /** null = publication simple, sans bouton conversationnel. Explicite plutôt qu'optionnel : le choix se fait. */
  linkId: string | null;
}

const base = (tenantId: string): string => `/tenants/${tenantId}/channels-me`;

export function getConnexionChaine(tenantId: string): Promise<ReponseConnexionChaine> {
  return request<ReponseConnexionChaine>(`${base(tenantId)}/connection`);
}

export async function enregistrerConnexionChaine(
  tenantId: string,
  c: { orgId: string; channelId: string; apiKey: string; secret: string },
): Promise<void> {
  await request(`${base(tenantId)}/connection`, { method: 'PUT', body: JSON.stringify(c) });
}

export function testerConnexionChaine(tenantId: string): Promise<ResultatTestChaine> {
  return request<ResultatTestChaine>(`${base(tenantId)}/connection/test`, { method: 'POST' });
}

export async function listerLiensChaine(tenantId: string): Promise<LienChaine[]> {
  const r = await request<{ links?: LienChaine[] }>(`${base(tenantId)}/links`);
  // Normalisation au bord du réseau : une 200 sans le champ attendu poserait `undefined` dans un état typé
  // tableau, et le premier `.map` démonterait l'écran entier.
  return Array.isArray(r?.links) ? r.links : [];
}

export async function creerLienChaine(tenantId: string, input: EntreeLienChaine): Promise<LienChaine> {
  const r = await request<{ link: LienChaine }>(`${base(tenantId)}/links`, {
    method: 'POST', body: JSON.stringify(input),
  });
  return r.link;
}

/**
 * Éteindre un lien, ce qui écrit `enabled = false` sur son automation compagnon. Il n'y a PAS de suppression :
 * un post publié circule pour toujours, supprimer son lien laisserait un bouton mort sans trace.
 */
export async function eteindreLienChaine(tenantId: string, id: string): Promise<void> {
  await request(`${base(tenantId)}/links/${id}/disable`, { method: 'POST' });
}

export async function listerPostsChaine(tenantId: string): Promise<PostChaine[]> {
  const r = await request<{ posts?: PostChaine[] }>(`${base(tenantId)}/posts`);
  return Array.isArray(r?.posts) ? r.posts : [];
}

export async function publierPostChaine(tenantId: string, input: EntreePostChaine): Promise<PostChaine> {
  const r = await request<{ post: PostChaine }>(`${base(tenantId)}/posts`, {
    method: 'POST', body: JSON.stringify(input),
  });
  return r.post;
}

/** Demande d'activation : corps vide tant que le client n'écrit rien, le serveur connaît déjà son espace. */
export async function demanderActivationChaine(tenantId: string, message?: string): Promise<void> {
  await request(`${base(tenantId)}/activation-request`, {
    method: 'POST',
    body: JSON.stringify(message === undefined ? {} : { message }),
  });
}
```

- [ ] **Step 4: relancer le test et constater le succès**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/api-chaine.test.ts
```

Sortie attendue :

```
 ✓ lib/api-chaine.test.ts (5 tests)

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 5: type-checker le front**

```bash
cd /c/Users/julie/messagingme-mba/web && npx tsc --noEmit
```

Sortie attendue : **aucune ligne**, code de sortie 0 (le dépôt est vert au départ). Une erreur ici est presque
toujours un `return request(...)` sur une fonction déclarée `Promise<void>` : les fonctions sans retour
utilisent `async` plus `await`, jamais `return`.

- [ ] **Step 6: committer le module d'appel**

⚠️ Le hook `rayon-de-souffle.js` bloque le PREMIER `git commit` pour mettre sous les yeux les lecteurs des
symboles touchés. Relancer la même commande la fait passer (le jeton porte l'empreinte de l'index).

```bash
cd /c/Users/julie/messagingme-mba && git add web/lib/api-chaine.ts web/lib/api-chaine.test.ts && git commit -F - <<'EOF'
feat(chaine): le module d appel du front, avec ses chemins geles

Les huit routes de /tenants/:tenantId/channels-me sont ecrites UNE fois, derivees d un
seul base(), et un test les compare une a une aux routes montees par le serveur. C est
la faute du lot precedent qui se ferme ici : le front tapait /connexion quand le serveur
montait /connection, ce qu aucun compilateur ne pouvait voir.

Le front ne fabrique ni jeton ni lien wa.me : le lien arrive compose par le serveur.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: écrire le spec E2E qui échoue, `web/e2e/chaine-connexion.spec.ts`**

Créer `C:\Users\julie\messagingme-mba\web\e2e\chaine-connexion.spec.ts` :

```ts
import { test, expect } from '@playwright/test';

/**
 * E2E Chaîne (Channels Me) : la carte de connexion et l'état vide.
 *
 * Ce que ce spec protège, et qui ne se voit pas à la lecture :
 *  1. 🔴 L'écran tape EXACTEMENT `/tenants/<id>/channels-me/connection`. Au lot précédent, le front
 *     appelait `/connexion` quand le serveur montait `/connection` : rien ne le signalait avant le 404.
 *  2. « Aucune chaîne connectée » est une réponse NORMALE, pas une panne : l'écran propose la demande
 *     d'activation au lieu d'un message d'erreur.
 *  3. La demande d'activation part UNE fois et l'écran le dit, sinon le client la renvoie en boucle.
 */
const SESSION = { token: 'e2e-token', email: 'admin@e2e.test', role: 'admin', tenantId: 't-e2e' };

const CONNECTEE = {
  connection: { orgId: 'org_1', channelId: 'chan_1', hasApiKey: true, hasSecret: true, verifiedAt: '2026-09-04T08:00:00.000Z' },
  chaine: { orgName: 'Messaging Me Global', channelName: 'Messaging Me', messagesCount: 59, monthlyUsed: 5, monthlyLimit: 10000 },
};

async function poser(page: import('@playwright/test').Page, corps: unknown) {
  const appels: string[] = [];
  const demandes: Array<Record<string, unknown>> = [];
  await page.addInitScript((s) => window.localStorage.setItem('mba.session', JSON.stringify(s)), SESSION);
  await page.route('**/api/backend/**', async (route) => {
    const req = route.request();
    const chemin = new URL(req.url()).pathname;
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (chemin.endsWith('/channels-me/activation-request') && req.method() === 'POST') {
      appels.push(`POST ${chemin}`);
      demandes.push((req.postDataJSON() ?? {}) as Record<string, unknown>);
      return json({ ok: true });
    }
    if (chemin.endsWith('/channels-me/connection')) {
      appels.push(`GET ${chemin}`);
      return json(corps);
    }
    if (chemin.endsWith('/me')) return json({ email: 'admin@e2e.test', name: 'Jean Test', role: 'admin' });
    return json({});
  });
  return { appels, demandes };
}

test.describe('Chaîne : carte de connexion', () => {
  test('chaîne connectée : nom, publications et quota viennent du serveur', async ({ page }) => {
    const { appels } = await poser(page, CONNECTEE);
    await page.goto('/chaine');

    await expect(page.getByTestId('chaine-carte')).toBeVisible();
    await expect(page.getByTestId('chaine-nom')).toHaveText('Messaging Me');
    await expect(page.getByTestId('chaine-publications')).toHaveText('59');
    // Le quota s'écrit « 5 / 10 000 » en français, avec l'espace fine que pose l'ICU : on vérifie la FORME,
    // pas l'octet exact de l'espace, sinon le test casserait à la prochaine version de Node.
    await expect(page.getByTestId('chaine-quota')).toHaveText(/5\s*\/\s*10\s*000/);
    // 🔴 Le chemin appelé, en toutes lettres : c'est la garde contre le retour de `/connexion`.
    expect(appels).toEqual(['GET /api/backend/tenants/t-e2e/channels-me/connection']);
    await expect(page.getByTestId('chaine-vide')).toHaveCount(0);
  });

  test('aucune chaîne : état vide, et la demande d’activation part une fois', async ({ page }) => {
    const { demandes } = await poser(page, { connection: null, chaine: null });
    await page.goto('/chaine');

    await expect(page.getByTestId('chaine-vide')).toBeVisible();
    await expect(page.getByTestId('chaine-erreur')).toHaveCount(0); // absence de chaîne n'est pas une erreur
    await expect(page.getByTestId('chaine-carte')).toHaveCount(0);

    await page.getByTestId('chaine-demander').click();
    await expect.poll(() => demandes.length).toBe(1);
    // Le bouton cède la place à la confirmation : sans ça, le client renvoie la demande en boucle.
    await expect(page.getByTestId('chaine-demande-ok')).toBeVisible();
    await expect(page.getByTestId('chaine-demander')).toHaveCount(0);
  });
});
```

- [ ] **Step 8: lancer le spec E2E et constater l'échec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/chaine-connexion.spec.ts
```

Le webServer construit puis démarre Next (`npm run build && npm run start`), donc compter deux à trois
minutes au premier lancement. Sortie attendue : les deux cas échouent, la route `/chaine` n'existant pas
encore, Next sert sa page 404 et aucun `data-testid` n'apparaît :

```
  1) [chromium] › e2e/chaine-connexion.spec.ts › chaîne connectée : nom, publications et quota viennent du serveur
     Error: expect(locator).toBeVisible() failed
     Locator: getByTestId('chaine-carte')
     Expected: visible
     Timeout: 5000ms

  2 failed
```

- [ ] **Step 9: brancher la section dans la nav (`web/components/AppShell.tsx`)**

Trois coutures, et rien d'autre : la chaîne d'ancêtres et le dépliage sont DÉDUITS par `cheminDeNav`
(`web/lib/nav.ts`), il n'existe aucune table plate à tenir en parallèle.

1. Ligne 14, dans le type `Tab`, remplacer `| 'campagnes' | 'workflows' |` par :

```ts
| 'campagnes' | 'chaine' | 'workflows' |
```

2. Dans l'objet `icons`, juste après la ligne `campaign:` (ligne 25), ajouter :

```ts
  // Chaîne : un haut-parleur. Une chaîne PARLE à des abonnés anonymes, c'est ce qui la distingue d'une
  // campagne, qui écrit à des contacts déjà connus. Deux icônes identiques rendraient les deux entrées
  // indiscernables alors qu'elles ne font pas la même chose.
  chaine: 'M4 9v6h4l5 4V5L8 9zM17.5 8.5a5 5 0 010 7M20.5 5.5a9 9 0 010 13',
```

3. Dans `NAV_ADMIN`, juste après la ligne `{ key: 'campagnes', ... }` (ligne 77), ajouter :

```tsx
    // Chaîne : la soeur de Campagnes en one-to-many, posée juste après elle pour cette raison. Elle reste
    // visible SANS chaîne connectée, parce que c'est cet écran qui porte la demande d'activation : la
    // cacher tant qu'il n'y a rien à voir la rendrait introuvable pour ceux qui n'en ont pas encore.
    { key: 'chaine', href: '/chaine', label: t('Chaîne', 'Channel'), d: icons.chaine },
```

- [ ] **Step 10: écrire la carte, `web/components/ChaineConnexion.tsx`**

Créer `C:\Users\julie\messagingme-mba\web\components\ChaineConnexion.tsx` :

```tsx
'use client';

import { useLocale, useT } from '@/lib/i18n';
import { fmtNum } from '@/lib/format';
import { cardCls } from '@/lib/ui';
import type { ReponseConnexionChaine } from '@/lib/api-chaine';

/**
 * La carte de connexion de la chaîne WhatsApp, et son état vide.
 *
 * 🔴 QUATRE SITUATIONS, QUATRE PHRASES. « Chargement », « aucune chaîne », « chaîne injoignable » et « tout
 * va bien » se ressemblent à l'écran si on les confond, et se ressemblent surtout dans le code : la faute
 * facile est de dire « connectez votre compte » sur une panne du fournisseur, ce qui envoie le client
 * chercher le problème là où il n'est pas.
 *
 * Composant PRÉSENTATIONNEL : la page détient le chargement, parce que le composeur et la liste des
 * publications vivent sur la même page et ont besoin de la même réponse. La charger ici en plus enverrait
 * deux appels identiques à chaque ouverture de l'écran.
 */

/** Où en est la demande d'activation. Un envoi en cours, un succès et un échec ne se disent pas pareil. */
export type EtatDemande = 'idle' | 'envoi' | 'envoyee' | 'erreur';

export interface ChaineConnexionProps {
  /** null tant que le chargement n'a rien rendu. */
  reponse: ReponseConnexionChaine | null;
  /** Le chargement a échoué. Distinct de « aucune chaîne connectée », qui est une réponse normale. */
  erreur: string | null;
  /** Nombre de scénarios rattachés (les liens). null = pas encore chargé, la mesure est alors masquée. */
  scenarios?: number | null;
  demande: EtatDemande;
  onDemanderActivation: () => void;
}

/** Deux initiales pour la pastille, tirées du nom de la chaîne. Sans nom lisible, un point d'interrogation. */
function initiales(nom: string): string {
  const mots = nom.trim().split(/\s+/).filter((m) => m !== '');
  if (mots.length === 0) return '?';
  return (mots[0]!.slice(0, 1) + (mots[1]?.slice(0, 1) ?? '')).toUpperCase();
}

function Mesure({ libelle, children }: { libelle: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">{libelle}</div>
      <div className="text-lg font-bold tabular-nums text-ink-900">{children}</div>
    </div>
  );
}

export function ChaineConnexion({ reponse, erreur, scenarios = null, demande, onDemanderActivation }: ChaineConnexionProps) {
  const t = useT();
  const { locale } = useLocale();

  if (erreur !== null) {
    return <p data-testid="chaine-erreur" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{erreur}</p>;
  }
  if (reponse === null) {
    return <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>;
  }

  // Aucune connexion enregistrée : réponse NORMALE. L'état vide dit quoi faire, il ne dit pas seulement
  // qu'il est vide.
  if (reponse.connection === null) {
    return (
      <div data-testid="chaine-vide" className="rounded-2xl border border-dashed border-ink-300 bg-white px-6 py-10 text-center">
        <h3 className="text-base font-semibold text-ink-900">{t('Aucune chaîne connectée', 'No channel connected')}</h3>
        <p className="mx-auto mt-2 max-w-lg text-sm text-ink-500">
          {t(
            'La création d’une chaîne WhatsApp se fait avec notre équipe, une seule fois. Dites-nous que vous la voulez, on s’occupe du reste et vous publiez ensuite d’ici.',
            'Creating a WhatsApp channel is done with our team, once. Tell us you want one, we handle the rest, and you publish from here afterwards.',
          )}
        </p>
        {demande === 'envoyee' ? (
          <p data-testid="chaine-demande-ok" className="mx-auto mt-4 max-w-lg rounded-lg bg-mint-50 px-3 py-2 text-sm text-mint-700">
            {t('Demande envoyée. Notre équipe vous recontacte pour créer la chaîne.', 'Request sent. Our team will get back to you to create the channel.')}
          </p>
        ) : (
          <>
            <button
              data-testid="chaine-demander"
              onClick={onDemanderActivation}
              disabled={demande === 'envoi'}
              className="mt-4 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
            >
              {demande === 'envoi' ? t('Envoi...', 'Sending...') : t('Demander l’activation', 'Request activation')}
            </button>
            {demande === 'erreur' && (
              <p data-testid="chaine-demande-erreur" className="mt-3 text-sm text-red-700">
                {t('La demande n’est pas partie. Réessayez dans un instant.', 'The request did not go through. Try again shortly.')}
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  // Identifiants enregistrés, mais Channels Me n'a pas répondu. Surtout pas « connectez votre compte » : les
  // identifiants sont là, c'est la lecture distante qui a échoué.
  if (reponse.chaine === null) {
    return (
      <div data-testid="chaine-injoignable" className={`${cardCls} border-amber-200 bg-amber-50`}>
        <h3 className="text-sm font-semibold text-amber-900">{t('Chaîne injoignable', 'Channel unreachable')}</h3>
        <p className="mt-1 text-sm text-amber-800">
          {t(
            'Les identifiants sont bien enregistrés, mais Channels Me n’a pas répondu. Rien n’est perdu, réessayez dans un instant.',
            'The credentials are saved, but Channels Me did not answer. Nothing is lost, try again shortly.',
          )}
        </p>
        {reponse.erreurDistante ? <p className="mt-2 font-mono text-xs text-amber-700">{reponse.erreurDistante}</p> : null}
      </div>
    );
  }

  const { chaine } = reponse;
  const pourcent = chaine.monthlyLimit !== null && chaine.monthlyLimit > 0
    ? Math.min(100, Math.round((chaine.monthlyUsed / chaine.monthlyLimit) * 100))
    : null;

  return (
    <div data-testid="chaine-carte" className={`${cardCls} flex flex-wrap items-center gap-5`}>
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-500 text-sm font-bold text-white">
        {initiales(chaine.channelName)}
      </div>
      <div className="min-w-[190px]">
        <div className="flex items-center gap-2">
          <span data-testid="chaine-nom" className="text-[15px] font-bold text-ink-900">{chaine.channelName}</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-mint-50 px-2 py-0.5 text-xs font-semibold text-mint-700">
            <i className="h-1.5 w-1.5 rounded-full bg-current" />
            {t('Connectée', 'Connected')}
          </span>
        </div>
        <p className="text-xs text-ink-500">
          {t(`Organisation « ${chaine.orgName} »`, `Organization "${chaine.orgName}"`)}
        </p>
      </div>
      <div className="ml-auto flex flex-wrap gap-7">
        <Mesure libelle={t('Publications', 'Posts')}>
          <span data-testid="chaine-publications">{fmtNum(chaine.messagesCount, locale)}</span>
        </Mesure>
        <Mesure libelle={t('Quota du mois', 'Monthly quota')}>
          <span data-testid="chaine-quota">
            {fmtNum(chaine.monthlyUsed, locale)}
            {/* Le plafond n'est affiché que si le fournisseur l'annonce : un « / 0 » serait un faux chiffre. */}
            {chaine.monthlyLimit !== null && (
              <span className="ml-1 text-xs font-medium text-ink-400">/ {fmtNum(chaine.monthlyLimit, locale)}</span>
            )}
          </span>
          {pourcent !== null && (
            <span className="mt-1.5 block h-1.5 w-32 overflow-hidden rounded-full bg-ink-100">
              <span className="block h-full rounded-full bg-mint-500" style={{ width: `${pourcent}%` }} />
            </span>
          )}
        </Mesure>
        {scenarios !== null && (
          <Mesure libelle={t('Scénarios rattachés', 'Attached scenarios')}>
            <span data-testid="chaine-scenarios">{fmtNum(scenarios, locale)}</span>
          </Mesure>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: écrire la page, `web/app/chaine/page.tsx`**

Créer `C:\Users\julie\messagingme-mba\web\app\chaine\page.tsx` :

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ChaineConnexion, type EtatDemande } from '@/components/ChaineConnexion';
import { useT } from '@/lib/i18n';
import type { Session } from '@/lib/session';
import { demanderActivationChaine, getConnexionChaine, type ReponseConnexionChaine } from '@/lib/api-chaine';

/**
 * Section Chaîne : publier sur une chaîne WhatsApp et rattacher un scénario à la publication.
 *
 * 🔴 POURQUOI CETTE PAGE DÉTIENT LE CHARGEMENT. Le composeur et la liste des publications viendront ici, sur
 * cet écran, et ont besoin de la MÊME réponse (« y a-t-il une chaîne ? »). La faire charger par chaque bloc
 * enverrait plusieurs fois le même appel à chaque ouverture, pour un état qui doit rester commun.
 *
 * ⚠️ L'URL de l'écran est `/chaine`, celle de l'API est `/channels-me` : le mot `channel` désigne déjà le
 * tuyau (whatsapp | rcs) dans ce dépôt.
 */
export default function ChainePage() {
  return <AppShell active="chaine">{(session) => <Inner session={session} />}</AppShell>;
}

function Inner({ session }: { session: Session }) {
  const t = useT();
  const [reponse, setReponse] = useState<ReponseConnexionChaine | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [demande, setDemande] = useState<EtatDemande>('idle');

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      setReponse(await getConnexionChaine(session.tenantId));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [session.tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);

  async function demanderActivation() {
    if (demande === 'envoi') return;
    setDemande('envoi');
    try {
      await demanderActivationChaine(session.tenantId);
      setDemande('envoyee');
    } catch {
      // On ne relit pas : la demande ne change rien à l'état de la connexion, et un rechargement ici
      // effacerait le message d'échec avant que le client ne l'ait lu.
      setDemande('erreur');
    }
  }

  return (
    <div className="space-y-5 p-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Chaîne', 'Channel')}</h2>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">
          {t(
            'Publiez sur votre chaîne WhatsApp et rattachez un scénario conversationnel à votre publication. Vos abonnés touchent « Discuter », la conversation démarre toute seule.',
            'Publish to your WhatsApp channel and attach a conversational scenario to your post. Your subscribers tap "Chat", and the conversation starts on its own.',
          )}
        </p>
      </div>

      <ChaineConnexion
        reponse={reponse}
        erreur={erreur}
        demande={demande}
        onDemanderActivation={() => { void demanderActivation(); }}
      />
    </div>
  );
}
```

- [ ] **Step 12: type-checker avant de relancer le navigateur**

```bash
cd /c/Users/julie/messagingme-mba/web && npx tsc --noEmit
```

Sortie attendue : **aucune ligne**, code de sortie 0. Ce passage est fait AVANT Playwright parce que le
webServer reconstruit tout le front (deux à trois minutes) : une faute de type découverte là coûte le triple.
Erreur typique si l'étape 9 a été sautée :
`Type '"chaine"' is not assignable to type 'Tab'` dans `app/chaine/page.tsx`.

- [ ] **Step 13: relancer le spec E2E, puis toute la suite unitaire du front**

```bash
cd /c/Users/julie/messagingme-mba/web && npx playwright test e2e/chaine-connexion.spec.ts
```

Sortie attendue :

```
  2 passed (Xs)
```

Puis la suite unitaire complète du front, pour prouver que la nav et le module n'ont rien cassé ailleurs
(`lib/nav.test.ts` et `lib/api-base.test.ts` lisent des sources touchées de près) :

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run
```

Sortie attendue : tous les fichiers de `lib/**` verts, dont `lib/api-chaine.test.ts (5 tests)`, aucune ligne
`failed`.

- [ ] **Step 14: committer l'écran**

Rayon de souffle de ce commit, énuméré avant de committer : `AppShell.tsx` est lu par TOUTES les pages de la
console (l'ajout au type `Tab` est additif, aucune valeur existante ne change) ; `cheminDeNav`
(`web/lib/nav.ts`) déduit seul le surlignage et le dépliage, il n'y a pas de table plate à mettre à jour ;
aucun spec E2E n'affirme le contenu de la barre de navigation (vérifié par recherche sur `e2e/`), donc une
entrée de plus n'en casse aucun ; `web/lib/api.ts` n'est volontairement pas touché (le module est de la
famille `lib/api-*.ts`, importée en direct).

⚠️ Là encore, le hook `rayon-de-souffle.js` bloque le premier essai : relancer la même commande.

```bash
cd /c/Users/julie/messagingme-mba && git add web/components/AppShell.tsx web/components/ChaineConnexion.tsx web/app/chaine/page.tsx web/e2e/chaine-connexion.spec.ts && git commit -F - <<'EOF'
feat(chaine): la carte de connexion et l ecran Chaine

Section Chaine de premier niveau, juste apres Campagnes, sa soeur en one-to-many. Elle
reste visible SANS chaine connectee : c est cet ecran qui porte la demande d activation.

La carte separe quatre situations qui se confondent facilement : chargement, aucune
chaine (reponse normale, on propose l activation), chaine injoignable (les identifiants
sont la, le fournisseur n a pas repondu) et tout va bien. Dire « connectez votre compte »
sur une panne distante enverrait chercher le probleme au mauvais endroit.

La page detient le chargement : le composeur et la liste des publications arrivent sur le
meme ecran et ont besoin de la meme reponse.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```


---

### Task 10: Front : composeur et apercu

Les deux composants de l'ecran Chaine : le composeur (texte, image par URL, scenario, phrase d'accroche) et
l'apercu du post avec le bouton Discuter. La decision qui gouverne toute la tache : **le front n'invente
aucune adresse et aucun texte pre-rempli**, il affiche ce que le serveur lui rend. Une adresse `wa.me` part
dans des messages publics irrattrapables ; deux compositions de la meme adresse (une au serveur, une ici)
divergeraient au premier ajustement.

⚠️ **Rayon de souffle, sens INVERSE.** Ces deux fichiers sont NEUFS, donc personne ne les lit encore : la
question a leur poser n'est pas « qui depend de moi » mais « qu'est-ce que je suppose du serveur ». Ils
supposent exactement deux choses, listees dans open_questions : que `GET /links` et `POST /links` rendent
`textePreRempli` et `lienWaMe` DEJA composes, et que la borne de 60 caracteres de la phrase est la meme des
deux cotes. Rien d'autre du depot ne change dans cette tache : ni `web/lib/api.ts` (aucun module d'API n'est
ajoute ici), ni `web/components/AppShell.tsx` (la nav se pose avec la page, tache suivante).

**Files:**
- Create : `web/lib/chaine-apercu.ts` (module PUR : qui ecrit quoi dans l'apercu, filtre d'image, gardes de publication)
- Create : `web/components/ChaineApercu.tsx`
- Create : `web/components/ChaineComposeur.tsx`
- Test : `web/lib/chaine-apercu.test.ts` (vitest front ; `web/vitest.config.ts` n'inclut que `lib/**/*.test.ts`)
- Modify : aucun fichier existant.

⚠️ **Pourquoi la logique passe par `web/lib/` et pas seulement par les `.tsx`.** Le vitest du front n'inclut
QUE `lib/**/*.test.ts` : un composant ne s'y teste pas, il se teste en Playwright depuis une page montee, ce
qui n'existera qu'a la tache suivante. Sortir les decisions (y a-t-il un bouton ? cette image est-elle
affichable ? le brouillon est-il publiable ?) dans un module pur les rend testables MAINTENANT, et laisse aux
`.tsx` ce qu'ils savent faire seuls : du balisage.

**Interfaces:**

- **Consumes** (existant dans le depot, rien a creer) :
  - `import { estEnLigne, type WorkflowSummary } from '@/lib/api'` : `estEnLigne(w: WorkflowSummary): boolean`
  - `import { inputCls } from '@/lib/ui'`
  - `import { useT } from '@/lib/i18n'` : `useT(): (fr: string, en?: string) => string`
- **Consumes** (des taches serveur precedentes, via la page de la tache suivante, jamais appele ici) :
  - le lien rendu par `GET /tenants/:tenantId/channels-me/links`, dont ces composants lisent
    `{ id: string; workflowId: string; phrase: string; textePreRempli: string; lienWaMe: string | null }`
- **Produces** (ce que la page et le test e2e des taches suivantes consomment) :
  ```ts
  // web/lib/chaine-apercu.ts
  export type AuteurSegment = 'client' | 'whatsapp';
  export interface SegmentApercu { auteur: AuteurSegment; kind: 'texte' | 'lien' | 'bouton'; contenu: string }
  export interface BrouillonChaine { texte: string; imageUrl: string; workflowId: string; phrase: string }
  export const LIBELLE_BOUTON_DISCUTER = 'Discuter';
  export const MAX_PHRASE = 60;
  export function segmentsApercu(texte: string, lienWaMe: string | null): SegmentApercu[];
  export function imageAffichable(url: string): string | null;
  export function pretAPublier(b: BrouillonChaine): boolean;
  export function pretARattacher(b: BrouillonChaine): boolean;

  // web/components/ChaineApercu.tsx
  export function ChaineApercu(props: {
    texte: string; imageUrl: string; lienWaMe: string | null;
    nomChaine: string | null; abonnes: number | null;
  }): JSX.Element;

  // web/components/ChaineComposeur.tsx
  export interface LienChaineVue {
    id: string; workflowId: string; phrase: string; textePreRempli: string; lienWaMe: string | null;
  }
  export function ChaineComposeur(props: {
    brouillon: BrouillonChaine; onChange: (b: BrouillonChaine) => void;
    scenarios: WorkflowSummary[]; lien: LienChaineVue | null; busy: boolean;
    onRattacher: () => void; onPublier: () => void;
  }): JSX.Element;
  ```
  `data-testid` poses (contrat des selecteurs Playwright de la tache e2e) : `chaine-texte`, `chaine-image`,
  `chaine-image-refus`, `chaine-scenario`, `chaine-scenario-hors-ligne`, `chaine-phrase`, `chaine-rattacher`,
  `chaine-texte-prerempli`, `chaine-lien`, `chaine-publier`, `chaine-apercu-nom`, `chaine-apercu-image`,
  `chaine-apercu-texte`, `chaine-apercu-lien`, `chaine-apercu-bouton`, `chaine-apercu-sans-bouton`.

---

- [ ] **Step 1: ecrire le test rouge de `segmentsApercu` (qui ecrit quoi, et pas de bouton sans lien)**

Creer `web/lib/chaine-apercu.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { LIBELLE_BOUTON_DISCUTER, segmentsApercu } from './chaine-apercu';

/**
 * L'apercu du post de chaine.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. Le bouton n'existe QUE parce que WhatsApp repere une adresse de conversation dans le texte. Un apercu
 *     qui dessinerait le bouton sans le lien promettrait au client un post qui ne partira pas comme ca.
 *  2. Le lien affiche est celui du SERVEUR, caractere pour caractere. Le front qui le recomposerait creerait
 *     une seconde verite sur une adresse qui part dans des messages publics, donc irrattrapable.
 *  3. Le libelle du bouton n'est pas un reglage : il est impose par WhatsApp (mesure du 2026-09-04, aucun
 *     champ d'API ne le porte). L'apercu doit le rendre lisible, jamais modifiable.
 */

// Lien FICTIF, tel qu'un serveur le rendrait : deja encode, jamais recompose ici.
const LIEN = 'https://wa.me/33525680250?text=Je%20veux%20en%20savoir%20plus%20(cm-a7k2m9p3)';

describe('segmentsApercu', () => {
  it('aucun lien rattache : le texte seul, et surtout AUCUN bouton', () => {
    expect(segmentsApercu('Nouvelle video en ligne', null)).toEqual([
      { auteur: 'client', kind: 'texte', contenu: 'Nouvelle video en ligne' },
    ]);
  });

  it('un lien vide vaut pas de lien (le serveur rend null quand aucun numero n est connecte)', () => {
    expect(segmentsApercu('Bonjour', '   ')).toEqual([
      { auteur: 'client', kind: 'texte', contenu: 'Bonjour' },
    ]);
  });

  it('🔴 lien rattache : le texte et le lien sont A NOUS, le bouton est a WhatsApp', () => {
    expect(segmentsApercu('Nouvelle video en ligne', LIEN)).toEqual([
      { auteur: 'client', kind: 'texte', contenu: 'Nouvelle video en ligne' },
      { auteur: 'client', kind: 'lien', contenu: LIEN },
      { auteur: 'whatsapp', kind: 'bouton', contenu: LIBELLE_BOUTON_DISCUTER },
    ]);
  });

  it('🔴 le lien du serveur ressort INTACT, encodage compris', () => {
    const segments = segmentsApercu('', LIEN);
    expect(segments.find((s) => s.kind === 'lien')?.contenu).toBe(LIEN);
  });

  it('le libelle du bouton est une constante, pas une saisie', () => {
    expect(LIBELLE_BOUTON_DISCUTER).toBe('Discuter');
  });
});
```

- [ ] **Step 2: lancer le test et constater l'echec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu, l'echec de resolution du module qui n'existe pas encore :

```
Error: Failed to load url ./chaine-apercu (resolved id: ./chaine-apercu)
  in lib/chaine-apercu.test.ts. Does the file exist?
```

- [ ] **Step 3: ecrire le module pur, version minimale**

Creer `web/lib/chaine-apercu.ts` :

```ts
/**
 * Ce que l'apercu de la chaine a le droit de dessiner, et QUI ecrit quoi.
 *
 * 🔴 DEUX TEXTES A NE JAMAIS CONFONDRE, et cet ecran est le seul endroit ou l'utilisateur voit les deux :
 * le TEXTE DU POST (ce que l'abonne LIT, il contient l'adresse) et le TEXTE PRE-REMPLI (ce que l'abonne
 * ENVOIE en touchant le bouton, il contient la phrase et le jeton). Le second est compose par le SERVEUR,
 * le front ne fait que l'afficher.
 *
 * 🔴 LE FRONT NE FABRIQUE AUCUNE ADRESSE. L'adresse de conversation arrive deja faite dans la reponse du
 * serveur. La recomposer ici donnerait deux verites sur une adresse qui part dans des messages publics :
 * une fois le post publie, il n'y a plus de retour arriere.
 */

export type AuteurSegment = 'client' | 'whatsapp';

export interface SegmentApercu {
  /** `client` = ce que l'utilisateur ecrit et ce que NOUS ajoutons. `whatsapp` = ce que le telephone dessine. */
  auteur: AuteurSegment;
  kind: 'texte' | 'lien' | 'bouton';
  /** Rendu tel quel. Un segment n'est jamais reconstruit a partir de ses morceaux. */
  contenu: string;
}

/**
 * Le libelle du bouton est IMPOSE par WhatsApp : mesure du 2026-09-04, aucun champ de l'API de publication
 * ne le porte, le client le dessine des qu'il repere une adresse de conversation. Ce n'est pas un reglage,
 * c'est un fait produit. La constante existe pour que l'apercu ne laisse jamais croire qu'on peut le changer.
 */
export const LIBELLE_BOUTON_DISCUTER = 'Discuter';

/**
 * Le post decoupe en segments, chacun attribue a son auteur.
 *
 * Pas de lien = pas de bouton, et c'est la regle entiere : WhatsApp ne dessine le bouton QUE parce qu'il
 * repere l'adresse dans le texte.
 */
export function segmentsApercu(texte: string, lienWaMe: string | null): SegmentApercu[] {
  const segments: SegmentApercu[] = [{ auteur: 'client', kind: 'texte', contenu: texte }];
  if (lienWaMe === null || lienWaMe.trim() === '') return segments;
  segments.push({ auteur: 'client', kind: 'lien', contenu: lienWaMe });
  segments.push({ auteur: 'whatsapp', kind: 'bouton', contenu: LIBELLE_BOUTON_DISCUTER });
  return segments;
}
```

- [ ] **Step 4: relancer et constater le succes**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu :

```
 ✓ lib/chaine-apercu.test.ts (5 tests)
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 5: ecrire les tests rouges du filtre d'image et des deux gardes**

Ajouter a la fin de `web/lib/chaine-apercu.test.ts`, et completer la premiere ligne d'import :

```ts
import {
  LIBELLE_BOUTON_DISCUTER, MAX_PHRASE, imageAffichable, pretAPublier, pretARattacher, segmentsApercu,
  type BrouillonChaine,
} from './chaine-apercu';

// ... (les describe existants restent inchanges)

const brouillon = (over: Partial<BrouillonChaine> = {}): BrouillonChaine => ({
  texte: 'Nouvelle video en ligne', imageUrl: '', workflowId: '', phrase: '', ...over,
});

describe('imageAffichable', () => {
  it('accepte une adresse https, detouree des espaces', () => {
    expect(imageAffichable('https://messagingme.app/visuel.jpg')).toBe('https://messagingme.app/visuel.jpg');
    expect(imageAffichable('  https://messagingme.app/visuel.jpg  ')).toBe('https://messagingme.app/visuel.jpg');
    expect(imageAffichable('HTTPS://messagingme.app/visuel.jpg')).toBe('HTTPS://messagingme.app/visuel.jpg');
  });

  it('vide : rien a afficher, ce n est pas une erreur', () => {
    expect(imageAffichable('')).toBeNull();
    expect(imageAffichable('   ')).toBeNull();
  });

  it('🔴 refuse tout ce qui n est pas https, y compris ce qui finirait dans un attribut src', () => {
    // Le serveur exige https (le visuel est recupere par Channels Me, pas par nous) : l'ecran doit dire la
    // meme chose AVANT le refus, sinon le client apprend son erreur d'un 422 sans explication.
    expect(imageAffichable('http://messagingme.app/visuel.jpg')).toBeNull();
    expect(imageAffichable('javascript:alert(1)')).toBeNull();
    expect(imageAffichable('data:image/png;base64,AAAA')).toBeNull();
    expect(imageAffichable('messagingme.app/visuel.jpg')).toBeNull();
  });
});

describe('pretAPublier', () => {
  it('un texte renseigne suffit : l image et le scenario sont facultatifs', () => {
    expect(pretAPublier(brouillon())).toBe(true);
    expect(pretAPublier(brouillon({ imageUrl: 'https://messagingme.app/v.jpg' }))).toBe(true);
  });

  it('refuse un texte vide ou blanc : ce n est pas une publication', () => {
    expect(pretAPublier(brouillon({ texte: '' }))).toBe(false);
    expect(pretAPublier(brouillon({ texte: '   \n ' }))).toBe(false);
  });

  it('🔴 refuse une adresse d image saisie mais inutilisable, plutot que de l envoyer telle quelle', () => {
    expect(pretAPublier(brouillon({ imageUrl: 'http://messagingme.app/v.jpg' }))).toBe(false);
  });
});

describe('pretARattacher', () => {
  it('exige un scenario ET une phrase', () => {
    expect(pretARattacher(brouillon({ workflowId: 'wf1', phrase: 'Je veux en savoir plus' }))).toBe(true);
    expect(pretARattacher(brouillon({ workflowId: '', phrase: 'Je veux en savoir plus' }))).toBe(false);
    expect(pretARattacher(brouillon({ workflowId: 'wf1', phrase: '  ' }))).toBe(false);
  });

  it('borne la phrase a MAX_PHRASE, la meme valeur que le serveur', () => {
    expect(MAX_PHRASE).toBe(60);
    expect(pretARattacher(brouillon({ workflowId: 'wf1', phrase: 'a'.repeat(MAX_PHRASE) }))).toBe(true);
    expect(pretARattacher(brouillon({ workflowId: 'wf1', phrase: 'a'.repeat(MAX_PHRASE + 1) }))).toBe(false);
  });
});
```

- [ ] **Step 6: lancer et constater l'echec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu, l'import qui ne resout pas les nouveaux symboles :

```
SyntaxError: The requested module './chaine-apercu' does not provide an export named 'MAX_PHRASE'
```

- [ ] **Step 7: implementer le filtre d'image et les deux gardes**

Ajouter a la fin de `web/lib/chaine-apercu.ts` :

```ts
/** Le brouillon du composeur. `workflowId` vide = aucun scenario rattache, donc post sans bouton. */
export interface BrouillonChaine {
  texte: string;
  imageUrl: string;
  workflowId: string;
  phrase: string;
}

/**
 * Longueur maximale de la phrase d'accroche. MIROIR de la borne du schema serveur, recopiee plutot
 * qu'importee : les deux builds ne partagent aucun module. Sans elle, le client tape sa phrase, clique, et
 * se la fait refuser sans savoir pourquoi.
 */
export const MAX_PHRASE = 60;

/**
 * L'adresse d'image A AFFICHER, ou null.
 *
 * Deux raisons de trancher ici plutot que dans le JSX : on exige `https` comme le serveur, et une valeur en
 * `javascript:` ou `data:` posee dans un `src` n'a rien a faire dans une page de la console.
 */
export function imageAffichable(url: string): string | null {
  const v = url.trim();
  if (v === '') return null;
  return /^https:\/\/\S+$/i.test(v) ? v : null;
}

/** Publiable ? Un texte vide n'est pas un post, et une adresse d'image inutilisable serait refusee au loin. */
export function pretAPublier(b: BrouillonChaine): boolean {
  if (b.texte.trim() === '') return false;
  if (b.imageUrl.trim() !== '' && imageAffichable(b.imageUrl) === null) return false;
  return true;
}

/**
 * Rattachable ? Un scenario et une phrase, rien de plus : c'est le SERVEUR qui tire le jeton, compose le
 * texte pre-rempli et fabrique l'adresse.
 */
export function pretARattacher(b: BrouillonChaine): boolean {
  const phrase = b.phrase.trim();
  return b.workflowId !== '' && phrase !== '' && phrase.length <= MAX_PHRASE;
}
```

- [ ] **Step 8: relancer, constater le succes, committer le module pur**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu :

```
 ✓ lib/chaine-apercu.test.ts (13 tests)
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

Puis :

```bash
cd /c/Users/julie/messagingme-mba && git add web/lib/chaine-apercu.ts web/lib/chaine-apercu.test.ts && git commit -m "$(cat <<'EOF'
feat(front): le module pur qui dit qui ecrit quoi dans l apercu de chaine

Le bouton n existe que si le lien est la, l adresse du serveur ressort intacte, et
l image doit etre en https comme cote serveur.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

⚠️ Le hook `rayon-de-souffle.js` bloque ce premier `git commit` pour afficher les lecteurs des symboles
touches. Relancer la MEME commande passe (le jeton porte l'empreinte de l'index).

- [ ] **Step 9: ecrire le test de garde rouge, qui lit les deux composants**

Ajouter en tete de `web/lib/chaine-apercu.test.ts` l'import de `node:fs`, et le describe a la fin :

```ts
import { readFileSync } from 'node:fs';

// ... (les describe existants restent inchanges)

describe('🔴 aucune adresse publique recomposee par le front', () => {
  // Ce test lit la SOURCE parce qu'aucun type ne peut exprimer « ce fichier ne fabrique pas d URL ». Le jour
  // ou un composant recompose l adresse a partir du numero et de la phrase, il y a deux verites sur une
  // adresse deja partie dans des messages publics : le serveur en fabrique une, l ecran en montre une autre,
  // et personne ne le voit avant qu un abonne tape sur un bouton mort.
  const SOURCES = ['../components/ChaineApercu.tsx', '../components/ChaineComposeur.tsx'];

  it('ni construction d adresse de conversation, ni encodage d un texte pre-rempli', () => {
    for (const rel of SOURCES) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src, `${rel} fabrique une adresse de conversation`).not.toContain('wa.me/');
      expect(src, `${rel} encode lui-meme un texte pre-rempli`).not.toContain('encodeURIComponent');
    }
  });
});
```

- [ ] **Step 10: lancer et constater l'echec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu, les composants n'existent pas encore :

```
 × 🔴 aucune adresse publique recomposee par le front > ni construction d adresse de conversation, ni encodage d un texte pre-rempli
   Error: ENOENT: no such file or directory, open '.../web/components/ChaineApercu.tsx'
 Tests  1 failed | 13 passed (14)
```

- [ ] **Step 11: ecrire `web/components/ChaineApercu.tsx`**

```tsx
'use client';

import { LIBELLE_BOUTON_DISCUTER, imageAffichable, segmentsApercu } from '@/lib/chaine-apercu';
import { useT } from '@/lib/i18n';

/**
 * Le post tel que l'abonne le verra dans la chaine, et surtout QUI dessine quoi.
 *
 * 🔴 LA LEGENDE EST LA MOITIE DU COMPOSANT. Deux couleurs, deux auteurs : ce que le client ecrit (le texte,
 * le visuel, et l'adresse que NOUS ajoutons a la fin) et ce que WhatsApp dessine (le bouton). Sans cette
 * distinction, le client cherche le champ « texte du bouton », ne le trouve pas, et croit a un oubli. Le
 * libelle est impose par WhatsApp : il n'y a pas de champ, il n'y en aura pas.
 *
 * ⚠️ `lienWaMe` arrive TEL QUEL du serveur. Ce composant ne le construit pas, ne le complete pas et ne
 * l'encode pas : il l'affiche. `tests/../lib/chaine-apercu.test.ts` lit cette source pour le garantir.
 */
export function ChaineApercu({ texte, imageUrl, lienWaMe, nomChaine, abonnes }: {
  texte: string;
  imageUrl: string;
  /** L'adresse composee par le SERVEUR, ou null tant qu'aucun lien n'est rattache. */
  lienWaMe: string | null;
  nomChaine: string | null;
  abonnes: number | null;
}) {
  const t = useT();
  const segments = segmentsApercu(texte, lienWaMe);
  const lien = segments.find((s) => s.kind === 'lien') ?? null;
  const bouton = segments.find((s) => s.kind === 'bouton') ?? null;
  const image = imageAffichable(imageUrl);

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        {t('Aperçu dans la chaîne', 'Preview in the channel')}
      </p>

      <div className="rounded-2xl border border-ink-200 p-3" style={{ backgroundColor: '#efeae2' }}>
        <div className="flex items-center gap-2 px-1 pb-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500 text-[11px] font-bold text-white">
            {(nomChaine ?? 'MM').slice(0, 2).toUpperCase()}
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-ink-900" data-testid="chaine-apercu-nom">
              {nomChaine ?? t('Votre chaîne', 'Your channel')}
            </div>
            <div className="text-[11px] text-ink-500">
              {abonnes === null
                ? t('nombre d’abonnés inconnu', 'subscriber count unknown')
                : t(`${abonnes} abonnés`, `${abonnes} subscribers`)}
            </div>
          </div>
        </div>

        <div className="rounded-lg bg-white p-2 shadow-sm">
          {image !== null && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={t('Aperçu du visuel joint', 'Preview of the attached image')}
              referrerPolicy="no-referrer"
              data-testid="chaine-apercu-image"
              className="mb-2 aspect-video w-full rounded bg-ink-100 object-cover"
            />
          )}

          <div
            data-testid="chaine-apercu-texte"
            className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-900"
          >
            {texte.trim() !== '' ? texte : <span className="italic text-ink-400">{t('Votre message…', 'Your message…')}</span>}
          </div>

          {lien !== null && (
            <p data-testid="chaine-apercu-lien" className="mt-2 break-all font-mono text-[11px] text-brand-600">
              {lien.contenu}
            </p>
          )}

          {bouton !== null ? (
            <div
              data-testid="chaine-apercu-bouton"
              className="mt-2 flex items-center justify-center gap-2 border-t border-ink-100 pt-2 text-[13.5px] font-medium"
              style={{ color: '#027EB5' }}
            >
              <span aria-hidden>💬</span>
              {bouton.contenu}
            </div>
          ) : (
            <p
              data-testid="chaine-apercu-sans-bouton"
              className="mt-2 border-t border-ink-100 pt-2 text-[11px] italic text-ink-400"
            >
              {t(
                'Aucun scénario rattaché : la publication part sans bouton.',
                'No scenario attached: the post goes out without a button.',
              )}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5 text-[11.5px] leading-snug text-ink-500">
        <p className="flex gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-sm bg-brand-500" />
          <span>
            <b className="font-semibold text-ink-700">{t('Ce que vous écrivez.', 'What you write.')}</b>{' '}
            {t(
              'Le texte, le visuel, et le lien que nous ajoutons à la fin.',
              'The text, the image, and the link we append at the end.',
            )}
          </span>
        </p>
        <p className="flex gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-sm bg-mint-400" />
          <span>
            <b className="font-semibold text-ink-700">{t('Ce que WhatsApp dessine.', 'What WhatsApp draws.')}</b>{' '}
            {t(
              `Le bouton « ${LIBELLE_BOUTON_DISCUTER} » apparaît de lui-même dès qu’un lien de conversation est présent. Son libellé ne se change pas, et il s’affiche dans la langue du téléphone de l’abonné.`,
              `The "${LIBELLE_BOUTON_DISCUTER}" button appears on its own as soon as a conversation link is present. Its wording cannot be changed, and it shows in the subscriber’s phone language.`,
            )}
          </span>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 12: ecrire `web/components/ChaineComposeur.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { estEnLigne, type WorkflowSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MAX_PHRASE, imageAffichable, pretAPublier, pretARattacher, type BrouillonChaine } from '@/lib/chaine-apercu';

/**
 * Le lien de chaine TEL QUE LE SERVEUR LE REND. Le composeur l'affiche, il ne le compose jamais : le jeton
 * est tire par le serveur, le texte pre-rempli et l'adresse aussi.
 */
export interface LienChaineVue {
  id: string;
  workflowId: string;
  phrase: string;
  /** Ce que l'abonne ENVERRA en touchant le bouton (phrase + jeton), compose par le serveur. */
  textePreRempli: string;
  /** L'adresse inseree dans le post. null = aucun numero WhatsApp connecte, donc rien a inserer. */
  lienWaMe: string | null;
}

/**
 * Le composeur de publication de chaine.
 *
 * 🔴 CONTROLE PAR SA PAGE, et ce n'est pas un detail de style : l'apercu affiche le MEME brouillon. Un etat
 * interne au composeur obligerait a le recopier vers l'apercu, donc a le tenir a jour a deux endroits, et
 * l'apercu montrerait un post different de celui qui part.
 *
 * 🔴 DEUX TEMPS, ET C'EST VOULU. Rattacher un scenario est une ECRITURE serveur (elle tire un jeton, compose
 * le texte pre-rempli et cree l'automation compagnon, eteinte). Tant qu'elle n'a pas eu lieu, le composeur
 * n'a rien de vrai a montrer : il le DIT, au lieu d'afficher une adresse plausible qu'il aurait fabriquee.
 * Une fois le lien cree, le scenario et la phrase se figent : les changer laisserait un jeton lie a une
 * phrase qui n'est plus celle affichee.
 */
export function ChaineComposeur({ brouillon, onChange, scenarios, lien, busy, onRattacher, onPublier }: {
  brouillon: BrouillonChaine;
  onChange: (b: BrouillonChaine) => void;
  scenarios: WorkflowSummary[];
  lien: LienChaineVue | null;
  busy: boolean;
  onRattacher: () => void;
  onPublier: () => void;
}) {
  const t = useT();
  const [copie, setCopie] = useState(false);
  const maj = (patch: Partial<BrouillonChaine>): void => onChange({ ...brouillon, ...patch });
  const scenarioChoisi = scenarios.find((s) => s.id === brouillon.workflowId) ?? null;
  const enLigne = scenarioChoisi !== null && estEnLigne(scenarioChoisi);
  const imageRefusee = brouillon.imageUrl.trim() !== '' && imageAffichable(brouillon.imageUrl) === null;
  const fige = lien !== null;

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-400">
        {t('Nouvelle publication', 'New post')}
      </h2>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="chaine-texte">
          {t('Votre message', 'Your message')}
        </label>
        <textarea
          id="chaine-texte"
          data-testid="chaine-texte"
          rows={6}
          className={inputCls}
          value={brouillon.texte}
          onChange={(e) => maj({ texte: e.target.value })}
        />
        <p className="mt-1 text-xs text-ink-400">
          {t('Mise en forme WhatsApp acceptée : *gras*, _italique_.', 'WhatsApp formatting accepted: *bold*, _italic_.')}
        </p>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="chaine-image">
          {t('Image (adresse web, facultatif)', 'Image (web address, optional)')}
        </label>
        <input
          id="chaine-image"
          data-testid="chaine-image"
          className={inputCls}
          placeholder="https://..."
          value={brouillon.imageUrl}
          onChange={(e) => maj({ imageUrl: e.target.value })}
        />
        {imageRefusee && (
          <p data-testid="chaine-image-refus" className="mt-1 text-xs text-amber-700">
            {t(
              'Adresse refusée : elle doit commencer par https://, c’est WhatsApp qui ira la chercher.',
              'Address refused: it must start with https://, WhatsApp is the one fetching it.',
            )}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
            {t('Bouton conversationnel', 'Conversational button')}
          </span>
          <span className="text-[13px] font-bold text-ink-800">{t('Rattacher un scénario', 'Attach a scenario')}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="chaine-scenario">
              {t('Scénario à démarrer', 'Scenario to start')}
            </label>
            <select
              id="chaine-scenario"
              data-testid="chaine-scenario"
              className={inputCls}
              value={brouillon.workflowId}
              disabled={fige}
              onChange={(e) => maj({ workflowId: e.target.value })}
            >
              <option value="">{t('Aucun (publication simple)', 'None (plain post)')}</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {estEnLigne(s) ? '' : t(' (jamais publié)', ' (never published)')}
                </option>
              ))}
            </select>
            {scenarioChoisi !== null && !enLigne && (
              <p data-testid="chaine-scenario-hors-ligne" className="mt-1 text-xs text-amber-700">
                {t(
                  'Ce scénario n’a aucune version en ligne : le bouton du post ne démarrerait rien. Publiez-le d’abord.',
                  'This scenario has no published version: the post button would start nothing. Publish it first.',
                )}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600" htmlFor="chaine-phrase">
              {t('Phrase du visiteur', 'Visitor sentence')}
            </label>
            <input
              id="chaine-phrase"
              data-testid="chaine-phrase"
              className={inputCls}
              maxLength={MAX_PHRASE}
              disabled={fige}
              value={brouillon.phrase}
              onChange={(e) => maj({ phrase: e.target.value })}
            />
            <p className="mt-1 text-right text-[11px] text-ink-400">{brouillon.phrase.trim().length} / {MAX_PHRASE}</p>
          </div>
        </div>

        <p className="mt-2 text-xs text-ink-400">
          {t(
            'C’est le message que votre abonné enverra en touchant le bouton. Il le voit avant d’envoyer, alors écrivez-le comme une vraie phrase. Un identifiant discret est ajouté derrière pour reconnaître le scénario à coup sûr.',
            'This is the message your subscriber will send by tapping the button. They see it before sending, so write it like a real sentence. A discreet identifier is appended so the scenario is recognised for sure.',
          )}
        </p>

        {lien === null ? (
          <>
            <button
              type="button"
              data-testid="chaine-rattacher"
              disabled={busy || !pretARattacher(brouillon) || !enLigne}
              onClick={onRattacher}
              className="mt-3 rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
            >
              {t('Créer le lien', 'Create the link')}
            </button>
            <p className="mt-2 text-xs text-ink-400">
              {t(
                'Le lien et le message pré-rempli sont fabriqués par le serveur à cette étape : ils s’afficheront ici, tels qu’ils partiront.',
                'The link and the pre-filled message are built by the server at this step: they will show up here, exactly as they will go out.',
              )}
            </p>
          </>
        ) : (
          <div className="mt-3 space-y-2 rounded-lg bg-ink-900 p-3">
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.09em] text-ink-400">
              {t('Ce que votre abonné enverra', 'What your subscriber will send')}
            </p>
            <code data-testid="chaine-texte-prerempli" className="block overflow-x-auto whitespace-nowrap font-mono text-[11px] text-mint-200">
              {lien.textePreRempli}
            </code>
            <p className="pt-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-ink-400">
              {t('Lien inséré dans la publication', 'Link inserted in the post')}
            </p>
            <code data-testid="chaine-lien" className="block overflow-x-auto whitespace-nowrap font-mono text-[11px] text-brand-300">
              {lien.lienWaMe ?? t(
                'Aucun numéro WhatsApp connecté : le lien ne peut pas être fabriqué.',
                'No WhatsApp number connected: the link cannot be built.',
              )}
            </code>
            {lien.lienWaMe !== null && (
              <button
                type="button"
                onClick={() => { void navigator.clipboard?.writeText(lien.lienWaMe ?? ''); setCopie(true); }}
                className="rounded-lg border border-ink-600 px-2 py-1 text-xs text-ink-100 transition hover:bg-ink-800"
              >
                {copie ? t('Copié', 'Copied') : t('Copier', 'Copy')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="chaine-publier"
          disabled={busy || !pretAPublier(brouillon)}
          onClick={onPublier}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
        >
          {t('Publier maintenant', 'Publish now')}
        </button>
        <span className="text-xs text-ink-400">
          {t('Publication immédiate : il n’y a pas de brouillon en V1.', 'Immediate publishing: there is no draft in V1.')}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 13: relancer vitest et constater que la garde passe**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-apercu.test.ts
```

Attendu :

```
 ✓ lib/chaine-apercu.test.ts (14 tests)
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

Si l'assertion `not.toContain('wa.me/')` echoue, ce n'est pas le test qu'il faut assouplir : c'est qu'un des
deux composants construit une adresse. Le corriger pour qu'il affiche celle du serveur.

- [ ] **Step 14: type-check, lint et suite unitaire complete du front**

```bash
cd /c/Users/julie/messagingme-mba/web && npx tsc --noEmit && npm run lint && npm test
```

Attendu : aucune sortie de `tsc`, puis `✔ No ESLint warnings or errors`, puis la suite complete verte
(`Test Files  19 passed`, le compte exact depend des fichiers presents). C'est la seule verification
possible des `.tsx` a ce stade : le vitest du front n'inclut que `lib/**`, et l'ecran ne sera atteignable en
Playwright qu'une fois la page montee, a la tache suivante.

- [ ] **Step 15: committer les deux composants**

```bash
cd /c/Users/julie/messagingme-mba && git add web/components/ChaineApercu.tsx web/components/ChaineComposeur.tsx web/lib/chaine-apercu.test.ts && git commit -m "$(cat <<'EOF'
feat(front): composeur et apercu de publication de chaine

L apercu separe a la couleur ce que le client ecrit de ce que WhatsApp dessine : le
libelle du bouton n est pas un champ, c est un fait produit. Le composeur affiche le
texte pre-rempli et l adresse tels que le SERVEUR les rend, et un test lit les deux
sources pour garantir qu il ne les recompose jamais.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

⚠️ Comme au step 8, le hook `rayon-de-souffle.js` bloque le premier passage : relancer la meme commande.


---

### Task 11: Front : publications, navigation, demande d activation

Écran « Chaîne » de la console : la liste des publications (statut lu en direct, scénario rattaché, nombre de
conversations démarrées), l’état vide qui porte la demande d’activation, et l’entrée de navigation de premier
niveau juste après Campagnes. Maquette validée :
https://claude.ai/code/artifact/cb5fb856-8ddb-4dda-96b5-bc4cc88091b0

**Files:**
- Create : `web/lib/chaine-statut.ts`
- Test (Create) : `web/lib/chaine-statut.test.ts`
- Create (ou Modify, cf. Step 5) : `web/lib/api/channels-me.ts`
- Modify : `web/lib/api.ts` (le barrel, une ligne)
- Create : `web/components/ChaineDemandeActivation.tsx`
- Create : `web/components/ChainePublications.tsx`
- Create (ou Modify, cf. Step 11) : `web/app/chaine/page.tsx`
- Modify : `web/components/AppShell.tsx` (type `Tab`, objet `icons`, tableau `NAV_ADMIN`)
- Test (Create) : `web/e2e/chaine-publications.spec.ts`

Aucun fichier de `src/` n’est touché par cette tâche : `web/` a son propre `tsconfig.json` et n’importe
jamais le serveur. Les types serveur du contrat gelé (`ConnexionPublique`, `PostRow`, `LienRow`) sont
RECOPIÉS en miroir côté front, comme `Automation` l’est déjà dans `web/lib/api/integrations.ts`.

**Interfaces:**

- Consumes (des tâches précédentes, côté serveur) :
  - `GET /tenants/:tenantId/channels-me/connection` monté par `registerChannelsMeRoutes`
    (`src/http/channels-me.ts`), corps de réponse lu ici : `{ connexion: ConnexionPublique | null }` où
    `ConnexionPublique = { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }`.
  - `GET /tenants/:tenantId/channels-me/posts`, corps de réponse lu ici :
    `{ publications: Array<{ id: string; cmMessageId: string; createdAt: string; statut: string | null; texte: string | null; lien: { id: string; phrase: string; workflowId: string; workflowName: string; actif: boolean } | null; conversationsDemarrees: number | null }> }`.
  - `POST /tenants/:tenantId/channels-me/activation-request`, corps envoyé `{ message: string }`, réponse `{ ok: true }`.
  - `PgChannelsMePostStore` et `PgChannelsMeLinkStore` ne sont PAS importés ici : ils sont derrière les routes.

- Produces (pour les tâches suivantes et pour la doc) :
  - `web/lib/chaine-statut.ts` :
    - `export type TonPublication = 'publie' | 'attente' | 'refus' | 'inconnu'`
    - `export interface EtatPublication { libelle: string; ton: TonPublication }`
    - `export function etatPublication(statut: string | null | undefined, locale: Locale): EtatPublication`
    - `export function classesPastille(ton: TonPublication): string`
  - `web/lib/api/channels-me.ts` :
    - `export interface ChaineConnexionPublique { orgId: string; channelId: string; hasApiKey: boolean; hasSecret: boolean; verifiedAt: string | null }`
    - `export interface ChaineLienResume { id: string; phrase: string; workflowId: string; workflowName: string; actif: boolean }`
    - `export interface ChainePublication { id: string; cmMessageId: string; createdAt: string; statut: string | null; texte: string | null; lien: ChaineLienResume | null; conversationsDemarrees: number | null }`
    - `export function getChaineConnexion(tenantId: string): Promise<{ connexion: ChaineConnexionPublique | null }>`
    - `export function listChainePublications(tenantId: string): Promise<{ publications: ChainePublication[] }>`
    - `export function demanderActivationChaine(tenantId: string, input: { message: string }): Promise<{ ok: true }>`
  - `web/components/ChainePublications.tsx` : `export function ChainePublications({ tenantId }: { tenantId: string })`
  - `web/components/ChaineDemandeActivation.tsx` : `export function ChaineDemandeActivation({ tenantId }: { tenantId: string })`
  - `web/components/AppShell.tsx` : la valeur `'chaine'` du type `Tab`, utilisable par toute page de la
    section (`<AppShell active="chaine">`).
  - `data-testid` posés (contrat des specs Playwright suivantes) : `chaine-publications`,
    `chaine-publications-vide`, `chaine-publications-erreur`, `chaine-publication-<id>`,
    `chaine-publication-conversations-<id>`, `chaine-publication-etat-<id>`,
    `chaine-publication-eteint-<id>`, `chaine-vide`, `chaine-demande-message`, `chaine-demande-envoyer`,
    `chaine-demande-envoyee`, `chaine-demande-erreur`.

---

- [ ] **Step 1: écrire le test rouge de la traduction du statut (`web/lib/chaine-statut.test.ts`)**

Le statut d’une publication est LU EN DIRECT chez Channels Me (décision 7 du document de conception) : il
n’est jamais stocké chez nous, et son vocabulaire appartient au fournisseur. La seule pièce testable
unitairement de cet écran est donc la traduction de cette chaîne opaque en libellé plus ton. Le vitest du
front ne voit que `lib/**` (`web/vitest.config.ts`), c’est le bon emplacement.

```ts
import { describe, it, expect } from 'vitest';
import { etatPublication, classesPastille } from './chaine-statut';

/**
 * L’état d’une publication de chaîne, tel qu’il s’affiche.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. Le statut n’est PAS stocké chez nous : il arrive à chaque lecture, tel que le fournisseur le donne.
 *     Une valeur qu’on ne connaît pas se rend donc TELLE QUELLE, en ton neutre, jamais rangée de force dans
 *     « Publiée » : un client qui lit « Publiée » sur un post refusé attend des conversations qui ne
 *     viendront jamais, et ne va pas chercher pourquoi.
 *  2. Un statut ABSENT n’est pas un échec. C’est « non communiqué », gris, exactement comme `mmLiteBadge`
 *     et `accountReviewBadge` le font déjà dans `format.ts`.
 *  3. Un REFUS a son PROPRE ton, distinct de l’attente. C’est la raison d’être de ce module : le
 *     `StatusTone` de `format.ts` ne connaît que ok / warn / unknown, et son unique lecteur
 *     (`BadgeField`, `app/accueil/page.tsx`) peint tout ce qui n’est ni ok ni warn en GRIS.
 *  4. Règle projet : aucun libellé produit ne contient de tiret cadratin ni demi-cadratin.
 */
const NO_EM_DASH = /[—–]/;

describe('etatPublication', () => {
  it('un statut publié rend le ton vert, quelle que soit la casse et dans les deux langues', () => {
    expect(etatPublication('published', 'fr')).toEqual({ libelle: 'Publiée', ton: 'publie' });
    expect(etatPublication('PUBLISHED', 'fr')).toEqual({ libelle: 'Publiée', ton: 'publie' });
    expect(etatPublication('sent', 'en')).toEqual({ libelle: 'Published', ton: 'publie' });
  });

  it('un statut intermédiaire est une ATTENTE, jamais un échec, et garde son mot à lui', () => {
    expect(etatPublication('sending', 'fr')).toEqual({ libelle: 'En cours d’envoi', ton: 'attente' });
    expect(etatPublication('draft', 'fr')).toEqual({ libelle: 'Brouillon', ton: 'attente' });
    expect(etatPublication('scheduled', 'en')).toEqual({ libelle: 'Scheduled', ton: 'attente' });
  });

  it('un refus a son ton propre, distinct de l’attente', () => {
    expect(etatPublication('rejected', 'fr')).toEqual({ libelle: 'Refusée par WhatsApp', ton: 'refus' });
    expect(etatPublication('failed', 'en').ton).toBe('refus');
    // Le point de la décision : refus et attente ne se peignent PAS pareil.
    expect(etatPublication('rejected', 'fr').ton).not.toBe(etatPublication('sending', 'fr').ton);
  });

  it('absent -> non communiqué ; inconnu -> rendu BRUT, jamais requalifié', () => {
    expect(etatPublication(null, 'fr')).toEqual({ libelle: 'Non communiqué', ton: 'inconnu' });
    expect(etatPublication(undefined, 'en')).toEqual({ libelle: 'Not reported', ton: 'inconnu' });
    expect(etatPublication('   ', 'fr')).toEqual({ libelle: 'Non communiqué', ton: 'inconnu' });
    // Un mot que le fournisseur ajouterait demain : on le montre, on ne le devine pas.
    expect(etatPublication('under_review', 'fr')).toEqual({ libelle: 'under_review', ton: 'inconnu' });
  });
});

describe('classesPastille', () => {
  it('les quatre tons ont des classes distinctes, et aucun libellé ne porte de tiret long', () => {
    const tons = ['publie', 'attente', 'refus', 'inconnu'] as const;
    // Quatre classes identiques rendraient les quatre états indiscernables à l’écran, sans rien casser.
    expect(new Set(tons.map(classesPastille)).size).toBe(4);
    for (const statut of ['published', 'sending', 'rejected', '', 'zorglub']) {
      expect(etatPublication(statut, 'fr').libelle).not.toMatch(NO_EM_DASH);
      expect(etatPublication(statut, 'en').libelle).not.toMatch(NO_EM_DASH);
    }
  });
});
```

- [ ] **Step 2: lancer le test et constater l’échec**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-statut.test.ts
```

Sortie attendue : l’import ne se résout pas, aucun test ne tourne.

```
 FAIL  lib/chaine-statut.test.ts [ lib/chaine-statut.test.ts ]
Error: Failed to resolve import "./chaine-statut" from "lib/chaine-statut.test.ts". Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

- [ ] **Step 3: écrire `web/lib/chaine-statut.ts`**

```ts
import type { Locale } from './locale';

/**
 * Le statut d’une publication de chaîne, traduit en état affichable.
 *
 * 🔴 POURQUOI UN MODULE À PART ET PAS UN `StatusBadge` DE `format.ts`. Le type `StatusTone` de `format.ts`
 * ne connaît que `ok | warn | unknown`, et son unique rendu (`BadgeField`, `app/accueil/page.tsx`) fait
 * `tone === 'ok' ? vert : tone === 'warn' ? ambre : gris`. Une publication REFUSÉE doit se voir en rouge :
 * ajouter un ton à `StatusTone` la peindrait en GRIS chez ce lecteur existant, sans une seule erreur du
 * compilateur. On garde donc un vocabulaire propre à la chaîne, et `format.ts` ne bouge pas.
 *
 * 🔴 LE STATUT N’EST JAMAIS MIROITÉ EN BASE (décision 7 du document de conception) : il arrive à chaque
 * lecture, tel que Channels Me le donne. Une valeur inconnue se rend donc TELLE QUELLE, en ton neutre,
 * plutôt que d’être rangée de force dans « publiée » ou dans « échec ».
 */

export type TonPublication = 'publie' | 'attente' | 'refus' | 'inconnu';
export interface EtatPublication { libelle: string; ton: TonPublication }

const PUBLIE = new Set(['published', 'sent', 'delivered']);
const REFUS = new Set(['failed', 'rejected', 'error', 'canceled', 'cancelled']);
/** Les attentes gardent leur mot : un brouillon n’est pas « en cours d’envoi », et le confondre ferait
 *  attendre une diffusion qui n’a jamais été demandée. */
const ATTENTE: Record<string, { fr: string; en: string }> = {
  draft: { fr: 'Brouillon', en: 'Draft' },
  scheduled: { fr: 'Programmée', en: 'Scheduled' },
  queued: { fr: 'En cours d’envoi', en: 'Sending' },
  sending: { fr: 'En cours d’envoi', en: 'Sending' },
  processing: { fr: 'En cours d’envoi', en: 'Sending' },
  pending: { fr: 'En cours d’envoi', en: 'Sending' },
};

export function etatPublication(statut: string | null | undefined, locale: Locale): EtatPublication {
  const texte = (statut ?? '').trim();
  if (texte === '') return { libelle: locale === 'en' ? 'Not reported' : 'Non communiqué', ton: 'inconnu' };
  const cle = texte.toLowerCase();
  if (PUBLIE.has(cle)) return { libelle: locale === 'en' ? 'Published' : 'Publiée', ton: 'publie' };
  if (REFUS.has(cle)) return { libelle: locale === 'en' ? 'Refused by WhatsApp' : 'Refusée par WhatsApp', ton: 'refus' };
  const attente = ATTENTE[cle];
  if (attente) return { libelle: locale === 'en' ? attente.en : attente.fr, ton: 'attente' };
  // Valeur que le fournisseur a ajoutée depuis : on la montre brute plutôt que de mentir sur son sens.
  return { libelle: texte, ton: 'inconnu' };
}

const PASTILLES: Record<TonPublication, string> = {
  publie: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  attente: 'border-amber-200 bg-amber-50 text-amber-800',
  refus: 'border-rose-200 bg-rose-50 text-rose-800',
  inconnu: 'border-ink-200 bg-ink-50 text-ink-600',
};

/** Classes de la pastille d’état. Une seule définition : quatre ternaires recopiés dans le tableau
 *  divergeraient à la première retouche de couleur. */
export function classesPastille(ton: TonPublication): string {
  return `inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PASTILLES[ton]}`;
}
```

- [ ] **Step 4: relancer le test, constater le succès, committer**

```bash
cd /c/Users/julie/messagingme-mba/web && npx vitest run lib/chaine-statut.test.ts
```

Sortie attendue :

```
 ✓ lib/chaine-statut.test.ts (5 tests)

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Puis le commit (le hook `rayon-de-souffle.js` BLOQUE le premier `git commit` pour afficher les dépendants
des symboles touchés ; relancer la MÊME commande la fait passer) :

```bash
cd /c/Users/julie/messagingme-mba && git add web/lib/chaine-statut.ts web/lib/chaine-statut.test.ts && git commit -m "$(cat <<'EOF'
feat(web): l etat d une publication de chaine, lu en direct et jamais requalifie

Le statut vient de Channels Me a chaque lecture, il n est pas stocke. Un mot
inconnu se rend donc brut, en ton neutre, au lieu d etre range dans « publiee ».

Module a part et pas un StatusBadge de format.ts : le StatusTone existant ne
connait que ok/warn/unknown, et son unique lecteur (BadgeField, accueil) peint
tout le reste en gris. Un refus doit se voir en rouge, sans toucher a l existant.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
