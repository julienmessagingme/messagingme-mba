# Le catalogue d'outils remonte à l'espace : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La DÉFINITION d'un outil devient une propriété de l'espace, son CONSENTEMENT descend dans
`agent_tool_consommateurs`, où un agent et le MBA sont deux consommateurs du même genre.

**Architecture:** `agent_tools` perd `agent_id` et les six colonnes de consentement (`actif`,
`active_par`, `active_le`, `autonome`, `autonome_par`, `autonome_le`). Une table de liaison les
reprend, une ligne par couple (outil, consommateur), la clé de consommateur étant un TEXTE
(`agent:<uuid>` ou `mba:<phone_number_id>`). Les routes existantes de l'agent gardent leur forme :
elles écrivent désormais dans la table de liaison au lieu d'écrire sur l'outil. Un nouvel écran
« Bibliothèque » montre les définitions au niveau de l'espace.

**Tech Stack:** TypeScript ESM, Fastify, Postgres (pooler Supabase, session mode), vitest
(unitaires sans base, intégration en CI seulement), Next.js 15 + Tailwind côté `web/`.

**Spec:** [docs/superpowers/specs/2026-09-10-outils-centralises-mba-design.md](../specs/2026-09-10-outils-centralises-mba-design.md)

## Périmètre de CE plan

Ce plan couvre les **lots 1 et 2** de la spec (le modèle, puis l'écran bibliothèque). Ils sont
inséparables : déplacer les outils change la forme de l'API que l'écran actuel consomme.

Les **lots 3 (la case « exposé au MBA ») et 4 (la publication chez Meta)** feront leur propre plan,
écrit une fois celui-ci livré. Ils n'ont de sens qu'une fois le consommateur `mba:` accepté par le
modèle, ce que ce plan pose.

⚠️ **Le lot 5 de la spec (client MCP) n'existe plus** : vérifié le 2026-09-10, Meta ne consomme pas
de MCP. Rien dans ce plan ne le prépare, et c'est voulu.

## Global Constraints

Ces contraintes s'appliquent à CHAQUE tâche, sans être répétées dans chacune.

- **`tenant_id = $1` sur CHAQUE requête SQL.** Le pooler est en rôle superuser, la RLS est
  contournée, le filtrage en code est le SEUL contrôle d'isolation entre clients.
- **`git commit --only <chemins>`, JAMAIS `git add` puis `git commit` nu.** Deux sessions partagent
  le même index ; un commit nu emporte le travail de l'autre. Pour un fichier NEUF :
  `git add -N <chemin>` puis `git commit --only <chemin>`.
- **Rester sur `main`.** Pas de branche, pas de worktree, pas de sous-session.
- **Pas de tirets longs** (« — » ni « – ») dans le code, les commentaires, les messages de commit ou
  la doc. Virgule, deux-points, parenthèses ou point.
- **Une erreur destinée à l'utilisateur sort en 4xx, jamais en 5xx.** Cloudflare remplace le corps de
  toute réponse 5xx par sa page d'erreur : le message n'arriverait jamais.
- **`safeParse`, jamais `parse`, jamais `as` sur une entrée externe.**
- **`npm test` en local ne prouve que la moitié.** Les tests d'intégration ont besoin d'un Postgres
  et le `DATABASE_URL` local pointe la PRODUCTION : ne JAMAIS lancer `npm run test:integration` en
  local. La CI monte un Postgres jetable (job `integration`). Après un push, lire le verdict avec
  `gh run view <id> --json jobs`, job par job, jamais sur le code de sortie de `gh run watch`.
- **Un test de non-régression se vérifie DANS LES DEUX SENS** : après l'avoir vu passer, remettre le
  code fautif (`git stash` du seul fichier de production, ou édition manuelle), constater l'ÉCHEC et
  son symptôme, puis restaurer. Un test qui passe dans les deux sens ne prouve rien.
- **Ordre des migrations : 0127 AVANT le déploiement, 0128 APRÈS.** Le TYPE décide : 0127 ne fait
  qu'ajouter, 0128 retire des colonnes que l'ancien code lit encore.
- **Le compteur de migrations vit dans `CLAUDE.md`, section Déploiement, et NULLE PART ailleurs.** Il
  se met à jour au moment où `migrate` s'exécute, pas quand le fichier SQL est écrit, et la ligne se
  RELIT après avoir été changée.
- **Avant d'écrire un helper, vérifier qu'il n'existe pas déjà** (`documentation.md`, § Modules
  partagés).

---

## Structure des fichiers

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `db/migrations/0127_outils_consommateurs.sql` | crée la table de liaison, recopie l'existant, pose le nouvel index unique | 1 |
| `src/agent/consommateur.ts` | **CRÉÉ.** Fabrique et lit une clé de consommateur. Le seul endroit où la chaîne `agent:` est écrite | 1 |
| `tests/agent-consommateur.test.ts` | **CRÉÉ.** Unitaire, plus la PARITÉ avec le CHECK de la migration | 1 |
| `src/agent/catalog.ts` | contrat : `OutilDefini` perd `agentId`, `ToolAdminStore` gagne le rattachement | 2, 3 |
| `src/agent/catalog.pg.ts` | SQL de lecture (jointure) puis d'écriture (upsert dans la liaison) | 2, 3 |
| `tests/integration/agent-catalog.integration.test.ts` | les deux sens de l'isolation, contre un vrai Postgres | 2, 3 |
| `src/http/agent-tools.ts` | les routes de l'agent gardent leur forme, `DELETE` détache au lieu de supprimer | 4 |
| `tests/http-agent-tools.test.ts` | routes, avec un faux store | 4 |
| `src/agent/agent-store.pg.ts` | supprimer un agent supprime ses lignes de consentement | 5 |
| `db/migrations/0128_outils_colonnes_retirees.sql` | retire `agent_id` et les six colonnes | 6 |
| `src/http/agent-catalogue.ts` | **CRÉÉ.** La bibliothèque au niveau de l'espace | 7 |
| `src/index.ts` | câblage des nouvelles dépendances | 4, 7 |
| `web/lib/api-agent-tools.ts` | client HTTP : rattachement, bibliothèque | 4, 8 |
| `web/components/BibliothequeOutils.tsx` | **CRÉÉ.** L'écran bibliothèque | 8 |
| `web/app/agents/outils/page.tsx` | **CRÉÉ.** La page qui le monte | 8 |

---

### Task 1: La clé de consommateur, et la migration qui l'accueille

**Files:**
- Create: `db/migrations/0127_outils_consommateurs.sql`
- Create: `src/agent/consommateur.ts`
- Create: `tests/agent-consommateur.test.ts`

**Interfaces:**
- Consomme : rien.
- Produit : `consommateurAgent(agentId: string): string`, `consommateurMba(phoneNumberId: string): string`,
  `agentDuConsommateur(cle: string): string | null`, `FORME_CONSOMMATEUR: RegExp`. La table
  `agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le, autonome, autonome_par, autonome_le, created_at, updated_at)`,
  clé primaire `(tool_id, consommateur)`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/agent-consommateur.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { consommateurAgent, consommateurMba, agentDuConsommateur, FORME_CONSOMMATEUR } from '../src/agent/consommateur';

/**
 * La clé de consommateur d'un outil.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE N'EST PAS LA CONCATÉNATION, c'est le fait que sa FORME est écrite à DEUX
 * endroits : ici en TypeScript, et en CHECK dans la migration 0127. Une clé que le code fabrique et que la
 * base refuse produirait une erreur 500 à l'activation d'un outil, en production, sans qu'aucun test
 * unitaire ne puisse la voir. Le dernier test lit le fichier SQL pour cette seule raison.
 */
describe('la clé de consommateur', () => {
  it('un agent devient « agent:<uuid> »', () => {
    expect(consommateurAgent('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('le MBA devient « mba:<phone_number_id> »', () => {
    expect(consommateurMba('123456789012345')).toBe('mba:123456789012345');
  });

  it('on retrouve l’agent, et SEULEMENT quand c’en est un', () => {
    // Sans ça, un écran qui liste « les agents qui utilisent cet outil » compterait le MBA parmi eux.
    expect(agentDuConsommateur('agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(agentDuConsommateur('mba:123456789012345')).toBeNull();
    expect(agentDuConsommateur('nimporte quoi')).toBeNull();
  });

  it('🔴 refuse ce qui n’est ni l’un ni l’autre', () => {
    for (const mauvais of ['agent:', 'agent:pas-un-uuid', 'mba:', 'mba:12a', 'agent:3f2504e0-4f89-11d3-9a0c-0305e82c3301 ', '']) {
      expect(FORME_CONSOMMATEUR.test(mauvais)).toBe(false);
    }
  });

  it('🔴 la forme est LA MÊME que le CHECK de la migration 0127', () => {
    // Deux constantes de fichiers différents qui doivent rester ordonnées : l'invariant n'est visible dans
    // aucun des deux, il ne peut vivre que dans un test.
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0127_outils_consommateurs.sql'), 'utf8');
    const source = FORME_CONSOMMATEUR.source;
    expect(sql).toContain(source);
  });
});
```

- [ ] **Step 2: Lancer le test et le voir échouer**

Run: `npm test -- tests/agent-consommateur.test.ts`
Expected: FAIL, `Cannot find module '../src/agent/consommateur'`.

- [ ] **Step 3: Écrire le module**

Créer `src/agent/consommateur.ts` :

```ts
/**
 * QUI consomme un outil : un agent IA du client, ou le Meta Business Agent d'un numéro.
 *
 * 🔴 UNE CLÉ TEXTE, ET C'EST UN CHOIX (tranché par Julien le 2026-09-10). Un consommateur n'est pas
 * toujours une ligne de notre base : le MBA n'a ni modèle, ni crédit, ni fiche. Lui fabriquer une fausse
 * ligne `agents` pour pouvoir poser une clé étrangère aurait pollué tous les écrans qui comptent les agents.
 *
 * ⚠️ LE PRIX EST ÉCRIT ICI POUR QU'IL NE SE PERDE PAS : il n'y a AUCUNE clé étrangère derrière
 * `agent:<uuid>`, donc aucune cascade ne nettoie les lignes d'un agent supprimé. C'est
 * `PgAgentStore.supprimer` qui doit le faire, dans la même transaction, et un test d'intégration le tient.
 *
 * La FORME est aussi un CHECK en base (migration 0127) : une clé que ce module fabriquerait et que la base
 * refuserait remonterait en 500 au moment où un client active un outil.
 */

/** ⚠️ Recopiée VERBATIM dans le CHECK de `db/migrations/0127_outils_consommateurs.sql`, et
 *  `tests/agent-consommateur.test.ts` vérifie que les deux ne divergent pas. */
export const FORME_CONSOMMATEUR = /^(agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mba:[0-9]{1,32})$/;

export function consommateurAgent(agentId: string): string {
  return `agent:${agentId}`;
}

export function consommateurMba(phoneNumberId: string): string {
  return `mba:${phoneNumberId}`;
}

/** L'identifiant de l'agent, ou `null` si ce consommateur n'en est pas un. */
export function agentDuConsommateur(cle: string): string | null {
  if (!FORME_CONSOMMATEUR.test(cle) || !cle.startsWith('agent:')) return null;
  return cle.slice('agent:'.length);
}
```

- [ ] **Step 4: Écrire la migration**

Créer `db/migrations/0127_outils_consommateurs.sql` :

```sql
-- 0127 : le CONSENTEMENT d un outil descend dans une table de liaison, la DEFINITION reste sur l outil.
--
-- POURQUOI. `agent_tools` porte aujourd hui les deux : ce qu un outil EST (nom, description, parametres,
-- liaison, risque, plafonds) et QUI a le droit de s en servir (`actif`, `autonome`, et qui les a coches).
-- Le premier appartient a l espace, le second au couple (outil, consommateur). Les laisser ensemble
-- obligeait a redecrire le meme outil pour chaque agent, et rendait impossible d exposer un outil au Meta
-- Business Agent sans inventer un faux agent.
--
-- 🔴 UNE REMONTEE NAIVE AURAIT RENDU UN OUTIL ACTIF POUR TOUS LES AGENTS D UN COUP. La migration 0086 dit
-- pourquoi ce serait grave : « la spec MCP exige un consentement humain avant l invocation d un outil ;
-- notre agent n a pas d humain au runtime, donc on deplace le consentement du runtime vers la
-- CONFIGURATION, et on le rend incontournable EN BASE ». Les deux CHECK de 0086 sont donc RECOPIES ici.
--
-- ⚠️ ELLE N AJOUTE QUE. Le retrait de `agent_id` et des six colonnes de consentement est la migration 0128,
-- qui passe APRES le deploiement : entre les deux, les deux formes coexistent et le retour arriere reste
-- possible.

create table if not exists agent_tool_consommateurs (
  tenant_id    uuid not null references tenants(id) on delete cascade,
  tool_id      uuid not null references agent_tools(id) on delete cascade,
  -- 'agent:<uuid>' ou 'mba:<phone_number_id>'. Clé TEXTE assumee : un consommateur n est pas toujours une
  -- ligne de notre base. Fabriquee par `src/agent/consommateur.ts`, jamais concatenee ailleurs.
  consommateur text not null,
  actif        boolean not null default false,
  active_par   uuid references users(id) on delete set null,
  active_le    timestamptz,
  autonome     boolean not null default false,
  autonome_par uuid references users(id) on delete set null,
  autonome_le  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tool_id, consommateur)
);

-- Les deux CHECK de 0086, recopies A L IDENTIQUE. Les perdre en chemin viderait 0086 de son contenu sans
-- que rien ne le signale : un outil pourrait redevenir actif sans que personne l ait active.
alter table agent_tool_consommateurs drop constraint if exists atc_actif_humain_chk;
alter table agent_tool_consommateurs add constraint atc_actif_humain_chk
  check (actif = false or active_par is not null);
alter table agent_tool_consommateurs drop constraint if exists atc_autonome_humain_chk;
alter table agent_tool_consommateurs add constraint atc_autonome_humain_chk
  check (autonome = false or autonome_par is not null);

-- La FORME de la cle, verrouillee en base. Recopiee VERBATIM depuis `FORME_CONSOMMATEUR`
-- (`src/agent/consommateur.ts`) ; `tests/agent-consommateur.test.ts` verifie que les deux ne divergent pas.
-- Sans ce CHECK, une faute de frappe produirait une ligne muette : aucun consommateur ne la lirait, et
-- l outil paraitrait simplement inactif.
alter table agent_tool_consommateurs drop constraint if exists atc_consommateur_chk;
alter table agent_tool_consommateurs add constraint atc_consommateur_chk
  check (consommateur ~ '^(agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mba:[0-9]{1,32})$');

-- 🔴 CONTRAT AVEC UNE REQUETE PRECISE : c est l index du CHEMIN CHAUD, celui que `listActifs` et `byName`
-- empruntent a chaque tour d agent. Elargir leur `where` sans elargir ce predicat ne produit aucune erreur,
-- juste un parcours de table a chaque message entrant.
create index if not exists agent_tool_consommateurs_actifs_idx
  on agent_tool_consommateurs (tenant_id, consommateur) where actif;

-- La reprise de l existant : une ligne par outil, pour SON agent, avec son consentement TRANSPORTE. Un outil
-- actif reste actif, et garde le nom de qui l a active : perdre `active_par` ferait echouer le CHECK.
insert into agent_tool_consommateurs
  (tenant_id, tool_id, consommateur, actif, active_par, active_le, autonome, autonome_par, autonome_le)
select tenant_id, id, 'agent:' || agent_id, actif, active_par, active_le, autonome, autonome_par, autonome_le
  from agent_tools
on conflict (tool_id, consommateur) do nothing;

-- La precondition du nouvel index, VERIFIEE plutot que supposee, et avec un message qui dit quoi faire.
-- Mesure le 2026-09-10 : zero doublon. Mais la migration peut etre rejouee des mois plus tard.
do $$
declare doublons int;
begin
  select count(*) into doublons from (
    select tenant_id, name from agent_tools group by 1, 2 having count(*) > 1
  ) d;
  if doublons > 0 then
    raise exception 'migration 0127 impossible : % nom(s) d outil porte(s) par plusieurs agents du meme espace. Renommer les doublons avant de rejouer (select tenant_id, name, count(*) from agent_tools group by 1,2 having count(*) > 1).', doublons;
  end if;
end $$;

-- Le nom expose devient unique par ESPACE, plus par agent. Pas de `lower()` : la contrainte
-- `name ~ '^[a-z0-9_]{1,64}$'` de 0086 garantit deja des minuscules, et un `lower()` inutile ferait croire
-- que la casse est un sujet. L ancien index `(agent_id, name)` reste en place jusqu a 0128.
create unique index if not exists agent_tools_nom_espace_idx on agent_tools (tenant_id, name);
```

- [ ] **Step 5: Lancer les tests et les voir passer**

Run: `npm test -- tests/agent-consommateur.test.ts && npm test -- tests/migration-directives.test.ts && npm run typecheck`
Expected: PASS pour les trois. `migration-directives` vérifie que le fichier ne réclame pas
`no-transaction` à tort : 0127 tourne bien DANS une transaction, elle ne contient aucun
`CREATE INDEX CONCURRENTLY`.

- [ ] **Step 6: Vérifier la parité DANS LES DEUX SENS**

Éditer `src/agent/consommateur.ts` et remplacer `mba:[0-9]{1,32}` par `mba:[0-9]+` dans
`FORME_CONSOMMATEUR`. Relancer `npm test -- tests/agent-consommateur.test.ts`.
Expected: le test « la forme est LA MÊME que le CHECK » ÉCHOUE. Puis restaurer la valeur et
revérifier que tout repasse. Sans cette manipulation, on ne sait pas si le test lit vraiment le SQL.

- [ ] **Step 7: Commit**

```bash
git add -N db/migrations/0127_outils_consommateurs.sql src/agent/consommateur.ts tests/agent-consommateur.test.ts
git commit --only db/migrations/0127_outils_consommateurs.sql src/agent/consommateur.ts tests/agent-consommateur.test.ts -m "feat(outils): la table de liaison du consentement, et la cle de consommateur"
```

---

### Task 2: Le store LIT le consentement dans la table de liaison

**Files:**
- Modify: `src/agent/catalog.ts` (contrat `OutilDefini`, `OutilComplet`, `ToolCatalog`)
- Modify: `src/agent/catalog.pg.ts` (`byName`, `listActifs`, `listToutes`, `COLONNES`)
- Test: `tests/integration/agent-catalog.integration.test.ts`

**Interfaces:**
- Consomme : `consommateurAgent(agentId)` de la tâche 1.
- Produit : `OutilDefini` SANS `agentId`. `ToolCatalog.byName(tenantId, agentId, name)` et
  `listActifs(tenantId, agentId)` gardent leur signature (l'appelant reste l'exécuteur, qui connaît
  l'agent) mais lisent la table de liaison.

- [ ] **Step 1: Écrire les tests d'intégration qui échouent**

Ajouter à `tests/integration/agent-catalog.integration.test.ts`, dans le `describe` existant :

```ts
  it('🔴 un outil n’est actif QUE pour le consommateur qui l’a activé', async () => {
    // Le coeur de la migration 0127 : la definition est partagee, le consentement ne l'est pas. Sans cette
    // separation, remonter les outils au tenant les aurait rendus actifs pour tous les agents d'un coup.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'lire_contact', title: 'Lire', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await catalogue.rattacher(tenantId, autreAgentId, outil!.id);
    await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);

    expect(await catalogue.byName(tenantId, agentId, 'lire_contact')).not.toBeNull();
    expect(await catalogue.byName(tenantId, autreAgentId, 'lire_contact')).toBeNull();
    expect((await catalogue.listActifs(tenantId, autreAgentId)).map((o) => o.name)).not.toContain('lire_contact');
  });

  it('🔴 le MBA est un consommateur comme un autre, sur la MEME definition', async () => {
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'partage', title: 'Partage', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await catalogue.rattacherConsommateur(tenantId, consommateurMba('123456789012345'), outil!.id);
    await catalogue.activerConsommateur(tenantId, consommateurMba('123456789012345'), outil!.id, true, adminId);

    const pourMba = await catalogue.listActifsConsommateur(tenantId, consommateurMba('123456789012345'));
    expect(pourMba.map((o) => o.name)).toContain('partage');
    // Et l'agent, lui, ne l'a pas active : une definition, deux consentements independants.
    expect(await catalogue.byName(tenantId, agentId, 'partage')).toBeNull();
  });

  it('🔴 l’isolation entre clients tient sur la JOINTURE, pas seulement sur l’outil', async () => {
    // Le nom d'outil vient du MODELE, donc d'un texte qu'un contact influence. Si la clause `where` de la
    // jointure oubliait le tenant, une injection reussie appellerait l'outil d'un autre client.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'isole', title: 'Isolé', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);
    expect(await catalogue.byName(autreTenantId, agentId, 'isole')).toBeNull();
  });
```

Ajouter en tête du fichier : `import { consommateurMba } from '../../src/agent/consommateur';`

- [ ] **Step 2: Vérifier que ça ne compile pas**

Run: `npm run typecheck`
Expected: FAIL, `Property 'rattacher' does not exist on type 'PgToolCatalog'` (et les trois autres
méthodes). C'est la preuve que les tests portent sur du contrat qui n'existe pas encore.

- [ ] **Step 3: Étendre le contrat**

Dans `src/agent/catalog.ts`, retirer `agentId` de `OutilDefini` :

```ts
export interface OutilDefini {
  id: string;
  tenantId: string;
  origin: OrigineOutil;
  /** Nom EXPOSÉ au modèle. Unique par ESPACE depuis la migration 0127, plus par agent. */
  name: string;
```

⚠️ Ne PAS toucher au reste de l'interface. `autonome` y reste : il vient désormais de la ligne de
liaison, ce que le SQL de la tâche suivante fournit, et l'exécuteur le lit au même endroit qu'avant.

Puis étendre `ToolCatalog` :

```ts
export interface ToolCatalog {
  byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null>;
  listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]>;

  /**
   * Les outils actifs d'un consommateur QUELCONQUE, pas seulement d'un agent.
   *
   * 🔴 C'est la porte par laquelle le MBA entre sans qu'on lui invente une fiche d'agent. `listActifs` en
   * devient un cas particulier, et surtout PAS l'inverse : garder deux SQL divergents finirait par ne plus
   * rendre le même outil selon le chemin, et le chemin qui compte est celui de l'exécution.
   */
  listActifsConsommateur(tenantId: string, consommateur: string): Promise<OutilDefini[]>;
}
```

- [ ] **Step 4: Réécrire les trois lectures**

Dans `src/agent/catalog.pg.ts`, remplacer l'interface `Ligne`, `COLONNES`, `versOutil` et les trois
méthodes de lecture :

```ts
interface Ligne {
  id: string;
  tenant_id: string;
  origin: OutilDefini['origin'];
  name: string;
  description: string;
  ne_pas_utiliser: string;
  params: unknown;
  binding: unknown;
  source_id: string | null;
  request_id: string | null;
  output_paths: string[] | null;
  risk: OutilDefini['risk'];
  timeout_ms: number;
  max_bytes: number;
  autonome: boolean;
}

/** Colonnes lues par toutes les requêtes. Une seule liste : deux projections divergentes finiraient par ne
 *  plus rendre le même outil selon le chemin, et le chemin qui compte est celui de l'exécution.
 *
 *  ⚠️ `autonome` vient de `c`, la LIAISON, pas de `t` : c'est un consentement, il est par consommateur. Le
 *  lire sur `t` rendrait l'ancienne valeur tant que 0128 n'a pas retiré la colonne, donc silencieusement
 *  fausse pour tout consommateur autre que le premier. */
const COLONNES = `t.id, t.tenant_id, t.origin, t.name, t.description, t.ne_pas_utiliser, t.params,
                  t.binding, t.source_id, t.request_id, t.output_paths, t.risk, t.timeout_ms, t.max_bytes,
                  c.autonome`;

function versOutil(r: Ligne): OutilDefini {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    origin: r.origin,
    name: r.name,
    description: r.description,
    nePasUtiliser: r.ne_pas_utiliser,
    params: r.params,
    binding: asRecord(r.binding),
    sourceId: r.source_id,
    requestId: r.request_id,
    outputPaths: r.output_paths ?? [],
    risk: r.risk,
    timeoutMs: r.timeout_ms,
    maxBytes: r.max_bytes,
    autonome: r.autonome,
  };
}
```

Puis les lectures :

```ts
  async byName(tenantId: string, agentId: string, name: string): Promise<OutilDefini | null> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES}
         from agent_tools t
         join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id
        where t.tenant_id = $1 and c.consommateur = $2 and t.name = $3 and c.actif`,
      [tenantId, consommateurAgent(agentId), name],
    );
    const r = res.rows[0];
    return r ? versOutil(r) : null;
  }

  async listActifs(tenantId: string, agentId: string): Promise<OutilDefini[]> {
    return this.listActifsConsommateur(tenantId, consommateurAgent(agentId));
  }

  async listActifsConsommateur(tenantId: string, consommateur: string): Promise<OutilDefini[]> {
    const res = await this.pool.query<Ligne>(
      `select ${COLONNES}
         from agent_tools t
         join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id
        where t.tenant_id = $1 and c.consommateur = $2 and c.actif
        order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map(versOutil);
  }
```

⚠️ **`c.tenant_id = t.tenant_id` est dans la jointure ET `t.tenant_id = $1` dans le `where`.** Le
second seul suffirait à l'isolation ; le premier empêche une ligne de liaison mal écrite (tenant
d'un autre client) de rattacher un outil qui n'est pas le sien.

Ajouter l'import : `import { consommateurAgent } from './consommateur';`

Puis `listToutes`, qui devient la jointure sans `actif` :

```ts
  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN}
         from agent_tools t
         join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id
        where t.tenant_id = $1 and c.consommateur = $2
        order by t.name`,
      [tenantId, consommateurAgent(agentId)],
    );
    return res.rows.map(versComplet);
  }
```

Et les colonnes d'administration :

```ts
const COLONNES_ADMIN = `${COLONNES}, t.title, c.actif, c.active_le, c.autonome_le`;
```

⚠️ **`listToutes` reste une jointure INTERNE, et c'est délibéré.** L'onglet Outils d'un agent
continue de montrer ce que CET agent utilise, pas tout le catalogue de l'espace : la bibliothèque
complète est un autre écran (tâche 8). Passer en `left join` ferait apparaître, dans chaque agent,
les outils de tous les autres.

- [ ] **Step 5: Corriger les lecteurs de `agentId`**

Run: `npm run typecheck`
Expected: FAIL sur chaque endroit qui lisait `outil.agentId`. Les corriger un par un : l'agent est
toujours connu de l'appelant (c'est lui qui a demandé l'outil), donc la correction est de prendre
l'identifiant du contexte plutôt que de l'outil. Aucun ne doit être « corrigé » en rajoutant
`agentId` sur la ligne.

- [ ] **Step 6: Pousser et lire le verdict de la CI**

```bash
git commit --only src/agent/catalog.ts src/agent/catalog.pg.ts tests/integration/agent-catalog.integration.test.ts -m "feat(outils): les lectures du catalogue passent par la table de liaison"
git push origin main
```

Puis `gh run list --limit 1` pour l'identifiant, et `gh run view <id> --json jobs` pour lire le
verdict **job par job**. Les tests d'intégration ne tournent QUE là.
Expected: job `integration` vert, les trois nouveaux tests passent.

⚠️ Cette étape échouera si la tâche 3 n'est pas faite (les tests appellent `rattacher`, `activer`,
`rattacherConsommateur`, `activerConsommateur`). C'est normal et voulu : faire les tâches 2 et 3
dans l'ordre, et ne pousser qu'à la fin de la tâche 3. Le commit de cette étape reste local.

---

### Task 3: Le store ÉCRIT le consentement dans la table de liaison

**Files:**
- Modify: `src/agent/catalog.ts` (`ToolAdminStore`)
- Modify: `src/agent/catalog.pg.ts` (`ajouter`, `ajouterConnecteur`, `activer`, `autonomie`, `patch`, `retirer`)
- Test: `tests/integration/agent-catalog.integration.test.ts`

**Interfaces:**
- Consomme : `consommateurAgent`, `consommateurMba` (tâche 1) ; `COLONNES_ADMIN`, `versComplet`,
  `LigneAdmin` (tâche 2).
- Produit : `rattacher(tenantId, agentId, toolId): Promise<boolean>`,
  `rattacherConsommateur(tenantId, consommateur, toolId): Promise<boolean>`,
  `detacher(tenantId, agentId, toolId): Promise<boolean>`,
  `activerConsommateur(tenantId, consommateur, toolId, actif, parUtilisateur): Promise<OutilComplet | null>`,
  `supprimerDefinition(tenantId, toolId): Promise<'ok' | 'rattachee' | 'introuvable'>`.

- [ ] **Step 1: Écrire les tests d'intégration qui échouent**

Ajouter à `tests/integration/agent-catalog.integration.test.ts` :

```ts
  it('🔴 créer un outil depuis un agent le RATTACHE à cet agent, inactif', async () => {
    // Le geste du client n'a pas change : « j'ajoute un outil a mon agent ». Ce qui a change, c'est qu'il
    // cree une definition d'espace PLUS un rattachement. Sans le rattachement, l'outil serait cree et
    // invisible dans l'onglet d'ou on vient de le creer.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'neuf', title: 'Neuf', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    expect(outil).not.toBeNull();
    expect(outil!.actif).toBe(false);
    expect((await catalogue.listToutes(tenantId, agentId)).map((o) => o.name)).toContain('neuf');
  });

  it('🔴 désactiver EFFACE l’activateur, sur la ligne de liaison', async () => {
    // Ces colonnes disent « qui l'a mis en service, et quand », pas « qui y a touche un jour ». Les garder
    // ferait afficher un consentement qui n'a plus cours.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'bascule', title: 'Bascule', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await catalogue.activer(tenantId, agentId, outil!.id, true, adminId);
    const eteint = await catalogue.activer(tenantId, agentId, outil!.id, false, adminId);
    expect(eteint!.actif).toBe(false);
    expect(eteint!.activeLe).toBeNull();
  });

  it('🔴 détacher un outil d’un agent ne le supprime PAS de l’espace', async () => {
    // C'est le changement de sens du bouton « supprimer » de l'onglet d'un agent : il retire l'outil DE CET
    // AGENT. Le supprimer pour tout le monde depuis l'ecran d'un seul agent casserait les autres en silence.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'garde', title: 'Garde', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await catalogue.rattacher(tenantId, autreAgentId, outil!.id);
    expect(await catalogue.detacher(tenantId, agentId, outil!.id)).toBe(true);
    expect((await catalogue.listToutes(tenantId, agentId)).map((o) => o.name)).not.toContain('garde');
    expect((await catalogue.listToutes(tenantId, autreAgentId)).map((o) => o.name)).toContain('garde');
  });

  it('🔴 supprimer une DEFINITION encore rattachée est REFUSÉ, pas silencieux', async () => {
    // Meme doctrine que la suppression d'une source qui porte des outils actifs : ce qui rendrait un agent
    // muet doit se refuser en le disant, pas se faire.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'occupe', title: 'Occupé', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    expect(await catalogue.supprimerDefinition(tenantId, outil!.id)).toBe('rattachee');
    await catalogue.detacher(tenantId, agentId, outil!.id);
    expect(await catalogue.supprimerDefinition(tenantId, outil!.id)).toBe('ok');
    expect(await catalogue.supprimerDefinition(tenantId, outil!.id)).toBe('introuvable');
  });

  it('🔴 un nom d’outil est pris pour tout l’ESPACE, plus seulement pour l’agent', async () => {
    await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'unique_espace', title: 'U', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    await expect(catalogue.ajouter(tenantId, autreAgentId, {
      handler: 'mba_lire_contact', name: 'unique_espace', title: 'U', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    })).rejects.toBeInstanceOf(NomOutilDejaPris);
  });

  it('🔴 activer pour un consommateur qui n’est pas rattaché ne crée RIEN', async () => {
    // Sinon `activer` deviendrait un rattachement implicite, et un identifiant d'agent errone poserait un
    // consentement sur un consommateur qui n'existe pas, invisible de tous les ecrans.
    const outil = await catalogue.ajouter(tenantId, agentId, {
      handler: 'mba_lire_contact', name: 'pas_rattache', title: 'P', description: 'd',
      nePasUtiliser: 'n', params: [], risk: 'read',
    });
    expect(await catalogue.activer(tenantId, autreAgentId, outil!.id, true, adminId)).toBeNull();
  });
```

- [ ] **Step 2: Étendre le contrat d'écriture**

Dans `src/agent/catalog.ts`, remplacer les signatures de `ToolAdminStore` concernées :

```ts
export interface ToolAdminStore {
  /** TOUS les outils RATTACHÉS à un agent, actifs ou non. */
  listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]>;

  ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null>;

  patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null>;

  activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  /**
   * Rend cet outil de l'espace disponible pour cet agent, INACTIF.
   *
   * ⚠️ Le rattachement et l'activation sont DEUX gestes. Les fondre ferait qu'ajouter un outil de la
   * bibliothèque à un agent l'exposerait au modèle dans la foulée, sans que personne ait relu ses mots.
   * `false` = l'outil n'existe pas dans cet espace, ou il est déjà rattaché.
   */
  rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;

  /** Même geste, pour un consommateur qui n'est pas un agent (le MBA). */
  rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean>;

  /** Retire l'outil de CET agent. La définition reste dans l'espace. */
  detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;

  /** Même geste, pour un consommateur qui n'est pas un agent. */
  activerConsommateur(tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;

  /**
   * Supprime la DÉFINITION, donc pour tout le monde.
   *
   * 🔴 REFUSE tant qu'un consommateur y est rattaché (`'rattachee'`), même inactif. La contrainte de la
   * migration 0127 est en `on delete cascade` : sans ce refus applicatif, supprimer une définition
   * emporterait en silence le consentement de trois agents qu'on ne regardait pas.
   */
  supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'>;
}
```

⚠️ **`retirer(tenantId, agentId, outilId)` DISPARAÎT du contrat**, remplacé par `detacher` et
`supprimerDefinition`. C'est délibéré : son nom ne disait pas lequel des deux il faisait, et après
0127 les deux existent. Le compilateur signalera ses appelants.

- [ ] **Step 3: Réécrire les écritures**

Dans `src/agent/catalog.pg.ts` :

```ts
  async ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    // 🔴 DEUX ÉCRITURES, DONC UNE TRANSACTION. Une définition créée sans son rattachement serait un outil
    // qui n'apparaît dans AUCUN écran : ni dans l'agent d'où on vient de le créer, ni ailleurs.
    return this.enTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into agent_tools
           (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
         select $1, 'mba', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8
          where exists (select 1 from agents where id = $9 and tenant_id = $1)
         returning id`,
        [
          tenantId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.params ?? []),
          JSON.stringify({ handler: outil.handler }),
          outil.risk, agentId,
        ],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)`,
        [tenantId, id, consommateurAgent(agentId)],
      );
      return this.completAvecClient(client, tenantId, consommateurAgent(agentId), id);
    });
  }
```

Le même patron pour `ajouterConnecteur`, en gardant ses TROIS `exists` (agent, source, requête) :

```ts
  async ajouterConnecteur(tenantId: string, agentId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: RisqueOutil;
  }): Promise<OutilComplet | null> {
    return this.enTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into agent_tools
           (tenant_id, origin, source_id, request_id, name, title, description, ne_pas_utiliser, params, binding, output_paths, risk)
         select $1, 'http', $2, $3, $4, $5, $6, $7, $8::jsonb, '{}'::jsonb, '{}'::text[], $9
          where exists (select 1 from agents where id = $10 and tenant_id = $1)
            and exists (select 1 from agent_tool_sources where id = $2 and tenant_id = $1)
            and exists (select 1 from connector_requests where id = $3 and tenant_id = $1)
         returning id`,
        [
          tenantId, outil.sourceId, outil.requestId, outil.name, outil.title, outil.description,
          outil.nePasUtiliser, JSON.stringify(outil.params ?? []), outil.risk, agentId,
        ],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)`,
        [tenantId, id, consommateurAgent(agentId)],
      );
      return this.completAvecClient(client, tenantId, consommateurAgent(agentId), id);
    });
  }
```

Les drapeaux, qui n'écrivent plus que la liaison :

```ts
  async activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null> {
    return this.activerConsommateur(tenantId, consommateurAgent(agentId), outilId, actif, parUtilisateur);
  }

  async activerConsommateur(
    tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string,
  ): Promise<OutilComplet | null> {
    // ⚠️ `update`, jamais `insert ... on conflict` : activer n'est PAS un rattachement implicite. Un
    // identifiant d'agent erroné doit rendre `null`, pas fabriquer un consentement pour un consommateur qui
    // n'existe nulle part et que plus aucun écran ne montrerait.
    const res = await this.pool.query(
      `update agent_tool_consommateurs set
         actif = $4,
         active_par = case when $4 then $5::uuid else null end,
         active_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and consommateur = $2 and tool_id = $3`,
      [tenantId, consommateur, outilId, actif, parUtilisateur],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return this.complet(tenantId, consommateur, outilId);
  }

  async autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null> {
    const res = await this.pool.query(
      `update agent_tool_consommateurs set
         autonome = $4,
         autonome_par = case when $4 then $5::uuid else null end,
         autonome_le = case when $4 then now() else null end,
         updated_at = now()
       where tenant_id = $1 and consommateur = $2 and tool_id = $3`,
      [tenantId, consommateurAgent(agentId), outilId, autonome, parUtilisateur],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    return this.complet(tenantId, consommateurAgent(agentId), outilId);
  }
```

Le rattachement et le détachement :

```ts
  async rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    return this.rattacherConsommateur(tenantId, consommateurAgent(agentId), outilId);
  }

  async rattacherConsommateur(tenantId: string, consommateur: string, outilId: string): Promise<boolean> {
    // Le `select ... where exists` vérifie que l'outil est de CE tenant : une clé étrangère lèverait en 500,
    // dont Cloudflare remplace le corps. `do nothing` rend un rattachement idempotent.
    const res = await this.pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
       select $1, $2, $3 where exists (select 1 from agent_tools where id = $2 and tenant_id = $1)
       on conflict (tool_id, consommateur) do nothing`,
      [tenantId, outilId, consommateur],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean> {
    const res = await this.pool.query(
      `delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 and tool_id = $3`,
      [tenantId, consommateurAgent(agentId), outilId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'> {
    return this.enTransaction(async (client) => {
      // `for update` sur la définition : sans lui, un rattachement concurrent passerait entre le comptage et
      // la suppression, et la cascade emporterait le consentement qui vient d'être posé.
      const exist = await client.query(
        'select 1 from agent_tools where tenant_id = $1 and id = $2 for update',
        [tenantId, outilId],
      );
      if ((exist.rowCount ?? 0) === 0) return 'introuvable';
      const rattachee = await client.query(
        'select 1 from agent_tool_consommateurs where tenant_id = $1 and tool_id = $2 limit 1',
        [tenantId, outilId],
      );
      if ((rattachee.rowCount ?? 0) > 0) return 'rattachee';
      await client.query('delete from agent_tools where tenant_id = $1 and id = $2', [tenantId, outilId]);
      return 'ok';
    });
  }
```

Enfin, les deux aides privées, à ajouter dans la classe :

```ts
  private async enTransaction<T>(travail: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const r = await travail(client);
      await client.query('commit');
      return r;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async complet(tenantId: string, consommateur: string, outilId: string): Promise<OutilComplet | null> {
    const client = await this.pool.connect();
    try {
      return await this.completAvecClient(client, tenantId, consommateur, outilId);
    } finally {
      client.release();
    }
  }

  private async completAvecClient(
    client: PoolClient, tenantId: string, consommateur: string, outilId: string,
  ): Promise<OutilComplet | null> {
    const res = await client.query<LigneAdmin>(
      `select ${COLONNES_ADMIN}
         from agent_tools t
         join agent_tool_consommateurs c on c.tool_id = t.id and c.tenant_id = t.tenant_id
        where t.tenant_id = $1 and c.consommateur = $2 and t.id = $3`,
      [tenantId, consommateur, outilId],
    );
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }
```

Ajouter l'import du type : `import type { Pool, PoolClient } from 'pg';`

Adapter aussi `patch`, dont le `where` perd `agent_id` et gagne la jointure :

```ts
  async patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null> {
    const res = await this.pool.query<{ id: string }>(
      `update agent_tools t set
         name = coalesce($4, t.name),
         title = coalesce($5, t.title),
         description = coalesce($6, t.description),
         ne_pas_utiliser = coalesce($7, t.ne_pas_utiliser),
         params = case when $8::jsonb is null then t.params else (
           select coalesce(jsonb_agg(
             case when $8::jsonb ? (p->>'name')
                  then jsonb_set(p - 'enum', '{enum}', $8::jsonb -> (p->>'name'))
                  else p end
             order by ord), '[]'::jsonb)
             from jsonb_array_elements(t.params) with ordinality as x(p, ord)
         ) end,
         updated_at = now()
       where t.tenant_id = $1 and t.id = $3
         and exists (select 1 from agent_tool_consommateurs c
                      where c.tool_id = t.id and c.tenant_id = t.tenant_id and c.consommateur = $2)
       returning t.id`,
      [tenantId, consommateurAgent(agentId), outilId, patch.name ?? null, patch.title ?? null,
        patch.description ?? null, patch.nePasUtiliser ?? null, patch.enums ? JSON.stringify(patch.enums) : null],
    ).catch(surNomDejaPris);
    const r = res.rows[0];
    return r ? this.complet(tenantId, consommateurAgent(agentId), r.id) : null;
  }
```

🔴 **L'`exists` sur la liaison n'est pas décoratif** : sans lui, l'écran d'un agent pourrait corriger
les mots d'un outil qu'il n'utilise pas, donc changer le comportement de l'agent du voisin.

- [ ] **Step 4: Pousser et lire le verdict de la CI**

```bash
npm run typecheck && npm test
git commit --only src/agent/catalog.ts src/agent/catalog.pg.ts tests/integration/agent-catalog.integration.test.ts -m "feat(outils): les ecritures du catalogue passent par la table de liaison"
git push origin main
gh run list --limit 1
```

Puis `gh run view <id> --json jobs`.
Expected: job `integration` vert, les neuf nouveaux tests (tâches 2 et 3) passent.

- [ ] **Step 5: Vérifier un test DANS LES DEUX SENS**

Dans `activerConsommateur`, remplacer le `update` par
`insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le) values ($1, $3, $2, $4, $5, now()) on conflict (tool_id, consommateur) do update set actif = excluded.actif`.
Pousser sur une branche jetable N'EST PAS possible (règle : rester sur `main`), donc vérifier
localement en lançant le seul test concerné contre le Postgres de la CI n'est pas praticable :
**exécuter cette vérification en relisant le SQL**, et noter dans le message de commit que
« activer pour un consommateur qui n'est pas rattaché ne crée RIEN » est le test qui garde ce point.

⚠️ Si un Postgres jetable local est disponible (`docker run --rm -e POSTGRES_PASSWORD=x -p 5433:5432 postgres:16`
puis `DATABASE_URL=postgres://postgres:x@localhost:5433/postgres npm run migrate`), faire la
mutation pour de vrai : c'est la seule façon de savoir que le test échoue sans le correctif.

---

### Task 4: Les routes de l'agent : rattacher, et un DELETE qui détache

**Files:**
- Modify: `src/http/agent-tools.ts:116-328`
- Modify: `src/index.ts:1119-1137` (câblage `agentTools`)
- Test: `tests/http-agent-tools.test.ts`

**Interfaces:**
- Consomme : `rattacher`, `detacher`, `activerConsommateur` (tâche 3).
- Produit : `PUT /tenants/:tenantId/agents/:agentId/tools/:outilId/rattachement` corps
  `{valeur: boolean}` ; `DELETE /tenants/:tenantId/agents/:agentId/tools/:outilId` détache au lieu
  de supprimer.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à `tests/http-agent-tools.test.ts` :

```ts
  it('🔴 DELETE sur l’outil d’un agent DÉTACHE, il ne supprime pas la définition', async () => {
    // Le sens du bouton a change avec la migration 0127 : la definition est partagee. Supprimer pour tout
    // le monde depuis l'ecran d'un seul agent rendrait les autres muets sans que personne le voie.
    const app = await monter();
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agents/${AGENT}/tools/${OUTIL}`, headers: entetesAdmin });
    expect(res.statusCode).toBe(204);
    expect(faux.detaches).toEqual([[TENANT, AGENT, OUTIL]]);
    expect(faux.definitionsSupprimees).toEqual([]);
  });

  it('rattacher un outil de la bibliothèque le rend disponible, INACTIF', async () => {
    const app = await monter();
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agents/${AGENT}/tools/${OUTIL}/rattachement`,
      headers: entetesAdmin, payload: { valeur: true },
    });
    expect(res.statusCode).toBe(200);
    expect(faux.rattaches).toEqual([[TENANT, AGENT, OUTIL]]);
  });

  it('🔴 rattacher un outil qui n’est pas de cet espace rend 404, pas 500', async () => {
    // Cloudflare remplace le corps de toute reponse 5xx : un message d'erreur en 500 n'arrive jamais.
    faux.rattacherRend = false;
    const app = await monter();
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agents/${AGENT}/tools/${OUTIL}/rattachement`,
      headers: entetesAdmin, payload: { valeur: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('🔴 un corps sans booléen rend 400', async () => {
    const app = await monter();
    const res = await app.inject({
      method: 'PUT', url: `/tenants/${TENANT}/agents/${AGENT}/tools/${OUTIL}/rattachement`,
      headers: entetesAdmin, payload: { valeur: 'oui' },
    });
    expect(res.statusCode).toBe(400);
  });
```

Étendre le faux store du fichier avec `detaches: string[][]`, `rattaches: string[][]`,
`definitionsSupprimees: string[][]`, `rattacherRend = true`, et les méthodes
`detacher`, `rattacher` correspondantes.

- [ ] **Step 2: Lancer et voir échouer**

Run: `npm test -- tests/http-agent-tools.test.ts`
Expected: FAIL, la route `/rattachement` répond 404 (elle n'existe pas) et `faux.detaches` est vide.

- [ ] **Step 3: Modifier les routes**

Dans `src/http/agent-tools.ts`, remplacer `retirer` par `detacher` dans `AgentToolsRouteDeps` et
ajouter `rattacher` :

```ts
  /**
   * Retire l'outil de CET agent. La définition reste dans l'espace (migration 0127).
   *
   * 🔴 ELLE S'APPELAIT `retirer` ET ELLE SUPPRIMAIT. Le renommage n'est pas cosmétique : après 0127 les deux
   * gestes existent, et un nom qui ne dit pas lequel il fait finirait par faire le mauvais.
   */
  detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
  /** Rend un outil de la bibliothèque de l'espace disponible pour cet agent, INACTIF. */
  rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
```

Puis la route DELETE, dont seul l'appel change :

```ts
  app.delete(`${base}/:outilId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    // DÉTACHE, ne supprime pas : la définition appartient à l'espace depuis 0127.
    const detache = await deps.detacher(ctx.tenant, ctx.agentId, outilId);
    if (!detache) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(204).send();
  });
```

Et la nouvelle route, à placer juste après `activation` et `autonomie` :

```ts
  /**
   * Rattacher ou détacher un outil de la bibliothèque, pour cet agent.
   *
   * ⚠️ Séparée de `activation`, et pas fondue dedans : rattacher rend l'outil DISPONIBLE, activer l'expose
   * au modèle. Un seul geste qui ferait les deux exposerait au modèle un outil dont personne n'a relu les
   * mots, ce que la migration 0086 existe précisément pour empêcher.
   */
  app.put(`${base}/:outilId/rattachement`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const parse = drapeauSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'valeur booléenne requise' });
    const fait = parse.data.valeur
      ? await deps.rattacher(ctx.tenant, ctx.agentId, outilId)
      : await deps.detacher(ctx.tenant, ctx.agentId, outilId);
    if (!fait) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(200).send({ rattache: parse.data.valeur });
  });
```

- [ ] **Step 4: Recâbler `src/index.ts`**

Remplacer la ligne `retirer:` du bloc `agentTools` (vers `src/index.ts:1132`) :

```ts
      detacher: (tenant, agentId, id) => toolCatalog.detacher(tenant, agentId, id),
      rattacher: (tenant, agentId, id) => toolCatalog.rattacher(tenant, agentId, id),
```

⚠️ Ce bloc est un littéral d'objet DIRECT, pas un spread : TypeScript y signale une propriété en
trop (TS2353). Laisser `retirer:` en place produirait donc une erreur de compilation, ce qui est
exactement le comportement voulu.

- [ ] **Step 5: Lancer les tests**

Run: `npm test -- tests/http-agent-tools.test.ts && npm run typecheck && npm test`
Expected: PASS partout.

- [ ] **Step 6: Vérifier le test DANS LES DEUX SENS**

Dans la route DELETE, remettre `deps.detacher` par un appel à `deps.rattacher(..., false)` puis
relancer : le test « DELETE DÉTACHE » doit échouer sur `faux.detaches` vide. Restaurer.

- [ ] **Step 7: Commit**

```bash
git commit --only src/http/agent-tools.ts src/index.ts tests/http-agent-tools.test.ts -m "feat(outils): la route de rattachement, et un DELETE qui detache"
```

---

### Task 5: Supprimer un agent nettoie ses lignes de consentement

**Files:**
- Modify: `src/agent/agent-store.pg.ts:101`
- Test: `tests/integration/agent-store.integration.test.ts`

**Interfaces:**
- Consomme : `consommateurAgent` (tâche 1).
- Produit : rien de nouveau ; `supprimer` garde sa signature.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `tests/integration/agent-store.integration.test.ts` :

```ts
  it('🔴 supprimer un agent supprime ses lignes de consentement d’outils', async () => {
    // C'est le PRIX de la clé texte, tranché le 2026-09-10 : il n'y a aucune clé étrangère derrière
    // `agent:<uuid>`, donc AUCUNE cascade ne nettoie ces lignes. Sans ce ménage, elles restent en base,
    // invisibles, et faussent les compteurs « utilisé par N consommateurs » de la bibliothèque.
    const agent = await store.creer(tenantId, { label: 'jetable' });
    const outil = await pool.query<{ id: string }>(
      `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk)
       values ($1, 'mba', 'menage', 'M', 'd', 'n', '[]'::jsonb, '{}'::jsonb, 'read') returning id`,
      [tenantId],
    );
    await pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur) values ($1, $2, $3)`,
      [tenantId, outil.rows[0]!.id, `agent:${agent!.id}`],
    );

    await store.supprimer(tenantId, agent!.id);

    const restant = await pool.query(
      'select 1 from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2',
      [tenantId, `agent:${agent!.id}`],
    );
    expect(restant.rowCount).toBe(0);
    // Et la DÉFINITION, elle, survit : elle appartient à l'espace, pas à l'agent.
    const def = await pool.query('select 1 from agent_tools where tenant_id = $1 and id = $2', [tenantId, outil.rows[0]!.id]);
    expect(def.rowCount).toBe(1);
  });
```

- [ ] **Step 2: Pousser pour voir le test échouer en CI**

```bash
git commit --only tests/integration/agent-store.integration.test.ts -m "test(agents): supprimer un agent doit nettoyer ses consentements d outils"
git push origin main
gh run list --limit 1
```

Puis `gh run view <id> --json jobs`.
Expected: job `integration` ROUGE sur ce test, avec `expected 1 to be 0`. C'est la moitié « sans le
correctif » de la vérification dans les deux sens, faite pour de vrai et lisible dans le run.

- [ ] **Step 3: Écrire le correctif**

Dans `src/agent/agent-store.pg.ts`, remplacer la méthode `supprimer` :

```ts
  async supprimer(tenantId: string, id: string): Promise<boolean> {
    // 🔴 DEUX SUPPRESSIONS, DONC UNE TRANSACTION, et l'ordre importe peu ici (rien ne lit entre les deux)
    // alors que l'ATOMICITÉ, si : la première seule laisserait des lignes de consentement orphelines que
    // plus aucun écran ne montre et qu'aucune cascade ne rattrapera jamais.
    //
    // ⚠️ POURQUOI PAS UNE CASCADE. `agent_tool_consommateurs.consommateur` est un TEXTE (migration 0127),
    // choisi pour que le MBA soit un consommateur sans avoir de fiche d'agent. Le prix de ce choix est ce
    // ménage-ci, et il est écrit dans `src/agent/consommateur.ts`.
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, id]);
      await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2',
        [tenantId, consommateurAgent(id)],
      );
      await client.query('commit');
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
```

Ajouter l'import : `import { consommateurAgent } from './consommateur';`

- [ ] **Step 4: Pousser et lire le verdict**

```bash
npm run typecheck && npm test
git commit --only src/agent/agent-store.pg.ts -m "fix(agents): supprimer un agent nettoie ses consentements d outils"
git push origin main
gh run list --limit 1
```

Puis `gh run view <id> --json jobs`.
Expected: job `integration` vert. Les deux sens sont désormais prouvés par deux runs successifs.

---

### Task 6: Migration 0128, le retrait des colonnes

**Files:**
- Create: `db/migrations/0128_outils_colonnes_retirees.sql`
- Modify: `CLAUDE.md` (la ligne du compteur, section Déploiement)

**Interfaces:**
- Consomme : la migration 0127 appliquée, et le code des tâches 2 à 5 DÉPLOYÉ.
- Produit : `agent_tools` sans `agent_id`, `actif`, `active_par`, `active_le`, `autonome`,
  `autonome_par`, `autonome_le`.

🔴 **CETTE MIGRATION PASSE APRÈS LE DÉPLOIEMENT, ET C'EST L'INVERSE DE L'HABITUDE.** Elle retire des
colonnes que l'ancien code lit : la jouer avant ferait échouer le chemin chaud en boucle pendant tout
le temps du déploiement.

- [ ] **Step 1: Écrire la migration**

```sql
-- 0128 : retrait des colonnes que la migration 0127 a remplacees.
--
-- 🔴 ELLE PASSE APRES LE DEPLOIEMENT, contrairement a la regle habituelle : elle RETIRE des colonnes que
-- l ancien code lit encore. Le TYPE de la migration decide de l ordre, pas la routine.
--
-- ⚠️ ELLE FERME LE RETOUR ARRIERE. Entre 0127 et 0128, les deux formes coexistent et redeployer l ancien
-- code marche encore. Apres celle-ci, non : les consentements ne vivent plus que dans la table de liaison.
-- Ne la jouer qu une fois le nouveau code VU EN PRODUCTION, pas seulement deploye.

-- Les deux CHECK de 0086 partent avec les colonnes qu ils gardaient. Leurs jumeaux vivent sur
-- `agent_tool_consommateurs` depuis 0127 : les retirer ici ne desarme rien.
alter table agent_tools drop constraint if exists agent_tools_actif_humain_chk;
alter table agent_tools drop constraint if exists agent_tools_autonome_humain_chk;

-- L index du chemin chaud d avant. Son remplacant est `agent_tool_consommateurs_actifs_idx` (0127).
drop index if exists agent_tools_actifs_idx;
-- L unicite par agent. Son remplacant est `agent_tools_nom_espace_idx` (0127), plus strict.
drop index if exists agent_tools_name_idx;

alter table agent_tools
  drop column if exists agent_id,
  drop column if exists actif,
  drop column if exists active_par,
  drop column if exists active_le,
  drop column if exists autonome,
  drop column if exists autonome_par,
  drop column if exists autonome_le;
```

- [ ] **Step 2: Vérifier la conformité du fichier**

Run: `npm test -- tests/migration-directives.test.ts && npm run typecheck`
Expected: PASS. 0128 tourne dans une transaction (aucun `CREATE INDEX CONCURRENTLY`), donc pas de
directive `no-transaction`.

- [ ] **Step 3: Commit**

```bash
git add -N db/migrations/0128_outils_colonnes_retirees.sql
git commit --only db/migrations/0128_outils_colonnes_retirees.sql -m "feat(outils): 0128 retire les colonnes remplacees par la table de liaison"
```

- [ ] **Step 4: Séquence de déploiement, dans cet ordre exact**

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS
cd /home/ubuntu/mba && git pull
sudo docker compose build mba-api
sudo docker compose run --rm --no-deps mba-api npm run migrate    # applique 0127 SEULEMENT si 0128 est encore hors de l image
```

🔴 **PROBLÈME D'ORDRE À RÉSOUDRE AVANT DE LANCER**, et il n'a pas de solution automatique : le runner
applique TOUTES les migrations en attente, donc un `migrate` après un `git pull` qui contient 0128
les jouerait toutes les deux d'un coup, ce qui casserait l'ancien code encore en service. **La
parade est de committer 0128 SÉPARÉMENT et de ne la pousser sur le VPS qu'au second passage** :

1. `git push origin main` avec les tâches 1 à 5 et la migration 0127, SANS 0128 ;
2. sur le VPS : `git pull`, `compose build mba-api`, `compose run ... npm run migrate` (0127),
   `compose up -d --build` ;
3. vérifier le service : appel INTERNE puis appel PUBLIC (le 502 par IP périmée est INTERMITTENT,
   donc le contrôle public est obligatoire après CHAQUE `up --build`) ;
4. `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload` si le public rend 502 ;
5. `node scripts/fumee.mjs` depuis le poste ;
6. SEULEMENT ensuite, pousser 0128, refaire `git pull`, `compose build`, `compose run ... migrate`.

- [ ] **Step 5: Vérifier EN BASE, pas par l'absence d'erreur**

```sql
select column_name from information_schema.columns where table_name = 'agent_tools' order by 1;
select conname from pg_constraint where conrelid = 'agent_tool_consommateurs'::regclass;
select indexname, indexdef from pg_indexes where tablename in ('agent_tools', 'agent_tool_consommateurs');
select name from public.schema_migrations order by name desc limit 3;
```

Expected: plus aucune des sept colonnes retirées ; les trois CHECK sur la table de liaison ;
`agent_tool_consommateurs_actifs_idx` avec son prédicat `WHERE actif` ; `agent_tools_nom_espace_idx`
sur `(tenant_id, name)` ; `0128` en tête de `schema_migrations`.

⚠️ Sans trafic, un silence dans les journaux ne prouve rien : c'est `information_schema` qui tranche.

- [ ] **Step 6: Mettre à jour le compteur, puis RELIRE la ligne**

Dans `CLAUDE.md`, section Déploiement : « **Dernière appliquée : 0128** », « **Prochaine libre =
0129** ». Puis rouvrir le fichier et relire la ligne : elle a dérivé trois fois, toujours parce
qu'on la modifiait sans la relire.

```bash
git commit --only CLAUDE.md -m "docs: compteur de migrations a 0128"
```

---

### Task 7: La bibliothèque d'outils, côté API

**Files:**
- Create: `src/http/agent-catalogue.ts`
- Modify: `src/index.ts` (montage des routes et câblage)
- Test: `tests/http-agent-catalogue.test.ts`

**Interfaces:**
- Consomme : `supprimerDefinition`, `listCatalogue` (défini ici) de `PgToolCatalog`.
- Produit : `GET /tenants/:tenantId/agent-tools` rendant
  `{outils: Array<{id, name, title, description, origin, risk, sourceId, consommateurs: Array<{cle, actif, agentId, agentLabel}>}>}`,
  et `DELETE /tenants/:tenantId/agent-tools/:outilId`.

- [ ] **Step 1: Ajouter la lecture de bibliothèque au store**

Dans `src/agent/catalog.ts` :

```ts
/** Une définition de l'espace, vue de la bibliothèque : ce qu'elle est, et QUI s'en sert. */
export interface OutilBibliotheque {
  id: string;
  name: string;
  title: string;
  description: string;
  origin: OrigineOutil;
  risk: RisqueOutil;
  sourceId: string | null;
  consommateurs: Array<{
    cle: string;
    actif: boolean;
    /** L'identifiant de l'agent, ou `null` quand ce consommateur n'en est pas un (le MBA). */
    agentId: string | null;
    /** Le nom lisible de l'agent, ou `null`. Un écran qui n'afficherait que des UUID ne sert à rien. */
    agentLabel: string | null;
  }>;
}
```

Et dans `ToolAdminStore` : `listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;`

Dans `src/agent/catalog.pg.ts` :

```ts
  async listCatalogue(tenantId: string): Promise<OutilBibliotheque[]> {
    // UNE requête, pas une par outil : la bibliothèque d'un espace bien rempli ferait sinon autant d'allers
    // et retours que d'outils, ce que l'audit du 2026-08-25 a déjà eu à corriger ailleurs.
    const res = await this.pool.query<{
      id: string; name: string; title: string; description: string;
      origin: OutilDefini['origin']; risk: OutilDefini['risk']; source_id: string | null;
      consommateurs: Array<{ cle: string; actif: boolean; agent_label: string | null }> | null;
    }>(
      `select t.id, t.name, t.title, t.description, t.origin, t.risk, t.source_id,
              coalesce(
                (select jsonb_agg(jsonb_build_object('cle', c.consommateur, 'actif', c.actif,
                                                     'agent_label', a.label) order by c.consommateur)
                   from agent_tool_consommateurs c
                   left join agents a on a.tenant_id = c.tenant_id
                                     and 'agent:' || a.id = c.consommateur
                  where c.tool_id = t.id and c.tenant_id = t.tenant_id),
                '[]'::jsonb) as consommateurs
         from agent_tools t
        where t.tenant_id = $1
        order by t.name`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, name: r.name, title: r.title, description: r.description,
      origin: r.origin, risk: r.risk, sourceId: r.source_id,
      consommateurs: (r.consommateurs ?? []).map((c) => ({
        cle: c.cle,
        actif: c.actif,
        agentId: agentDuConsommateur(c.cle),
        agentLabel: c.agent_label,
      })),
    }));
  }
```

Ajouter l'import : `import { agentDuConsommateur, consommateurAgent } from './consommateur';`

- [ ] **Step 2: Écrire les tests de routes qui échouent**

Créer `tests/http-agent-catalogue.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { agentCatalogueRoutes } from '../src/http/agent-catalogue';

/**
 * La bibliothèque d'outils d'un espace.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : le refus de supprimer une définition encore rattachée. Sans lui, la
 * cascade de la migration 0127 emporterait le consentement d'agents qu'on ne regardait pas, et l'écran
 * annoncerait un succès.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const OUTIL = '22222222-2222-4222-8222-222222222222';

function monter(verdict: 'ok' | 'rattachee' | 'introuvable') {
  const app = Fastify();
  const supprimes: string[][] = [];
  app.register(agentCatalogueRoutes, {
    deps: {
      listCatalogue: async () => [{
        id: OUTIL, name: 'lire_contact', title: 'Lire', description: 'd', origin: 'mba' as const,
        risk: 'read' as const, sourceId: null,
        consommateurs: [{ cle: `agent:${OUTIL}`, actif: true, agentId: OUTIL, agentLabel: 'Support' }],
      }],
      supprimerDefinition: async (t: string, id: string) => { supprimes.push([t, id]); return verdict; },
    },
    guard: { requireAuth: () => async () => {}, requireAdmin: () => async () => {} },
  });
  return { app, supprimes };
}

describe('la bibliothèque d’outils', () => {
  it('rend les définitions de l’espace, avec qui s’en sert', async () => {
    const { app } = monter('ok');
    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT}/agent-tools` });
    expect(res.statusCode).toBe(200);
    expect(res.json().outils[0].consommateurs[0].agentLabel).toBe('Support');
  });

  it('🔴 supprimer une définition encore rattachée rend 409, avec un message lisible', async () => {
    // 409 et pas 500 : Cloudflare remplace le corps de toute reponse 5xx, le message n'arriverait jamais.
    const { app } = monter('rattachee');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/utilisé|utilise/i);
  });

  it('supprimer une définition libre rend 204', async () => {
    const { app } = monter('ok');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}` });
    expect(res.statusCode).toBe(204);
  });

  it('une définition inconnue rend 404', async () => {
    const { app } = monter('introuvable');
    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT}/agent-tools/${OUTIL}` });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Lancer et voir échouer**

Run: `npm test -- tests/http-agent-catalogue.test.ts`
Expected: FAIL, `Cannot find module '../src/http/agent-catalogue'`.

- [ ] **Step 4: Écrire les routes**

Créer `src/http/agent-catalogue.ts` :

```ts
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { scopeTenant, estUuid } from './scope';

/**
 * La bibliothèque d'outils d'un ESPACE (migration 0127).
 *
 * 🔴 POURQUOI UN FICHIER À PART DE `agent-tools.ts`. Les deux écrans ne parlent pas du même objet : celui-ci
 * montre les DÉFINITIONS de l'espace, l'autre le CONSENTEMENT d'un agent. Les fondre ferait un module dont
 * la moitié des gardes ne s'appliquent qu'à la moitié des routes, et c'est ainsi qu'une garde finit par
 * manquer là où elle comptait.
 */

export interface AgentCatalogueRouteDeps {
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
  supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'>;
}

export async function agentCatalogueRoutes(
  app: FastifyInstance,
  { deps, guard }: { deps: AgentCatalogueRouteDeps; guard: Guard },
) {
  const base = '/tenants/:tenantId/agent-tools';

  app.get(base, { preHandler: guard.requireAuth() }, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (!tenant) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ outils: await deps.listCatalogue(tenant) });
  });

  /**
   * Supprime une définition, donc pour TOUT LE MONDE.
   *
   * 🔴 REFUSE en 409 tant qu'un consommateur y est rattaché, même inactif. La contrainte de 0127 est en
   * `on delete cascade` : sans ce refus, la suppression emporterait en silence le consentement d'agents
   * qu'on ne regardait pas, et l'écran annoncerait un succès.
   */
  app.delete(`${base}/:outilId`, { preHandler: guard.requireAdmin() }, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (!tenant) return reply.code(403).send({ error: 'espace interdit' });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const verdict = await deps.supprimerDefinition(tenant, outilId);
    if (verdict === 'introuvable') return reply.code(404).send({ error: 'outil introuvable' });
    if (verdict === 'rattachee') {
      return reply.code(409).send({ error: 'cet outil est utilisé par au moins un agent. Le retirer de chaque agent avant de le supprimer de la bibliothèque.' });
    }
    return reply.code(204).send();
  });
}
```

- [ ] **Step 5: Câbler dans `src/index.ts`**

À côté du bloc `agentTools`, ajouter :

```ts
    // La BIBLIOTHÈQUE d'outils de l'espace (migration 0127) : les définitions, et qui s'en sert. Séparée des
    // routes d'agent parce qu'elle ne parle pas du même objet.
    agentCatalogue: {
      listCatalogue: (tenant) => toolCatalog.listCatalogue(tenant),
      supprimerDefinition: (tenant, id) => toolCatalog.supprimerDefinition(tenant, id),
    },
```

Puis enregistrer les routes à côté de `agentToolsRoutes`, avec `guard`.

⚠️ `tests/scope-tenant.test.ts` énumère les modules à routes `:tenantId` : il CASSERA tant que
`agent-catalogue.ts` n'y est pas ajouté. C'est le garde-fou qui fait son travail, pas un bug.

- [ ] **Step 6: Lancer les tests**

Run: `npm test && npm run typecheck`
Expected: PASS, y compris `tests/scope-tenant.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add -N src/http/agent-catalogue.ts tests/http-agent-catalogue.test.ts
git commit --only src/http/agent-catalogue.ts tests/http-agent-catalogue.test.ts src/agent/catalog.ts src/agent/catalog.pg.ts src/index.ts -m "feat(outils): la bibliotheque d espace, et le refus de supprimer une definition rattachee"
```

---

### Task 8: L'écran Bibliothèque d'outils

**Files:**
- Create: `web/components/BibliothequeOutils.tsx`
- Create: `web/app/agents/outils/page.tsx`
- Modify: `web/lib/api-agent-tools.ts`
- Modify: `web/components/AppShell.tsx` (l'onglet)

**Interfaces:**
- Consomme : `GET /tenants/:t/agent-tools`, `DELETE /tenants/:t/agent-tools/:id` (tâche 7) ;
  `PUT /tenants/:t/agents/:a/tools/:id/rattachement` (tâche 4).
- Produit : rien pour les tâches suivantes.

- [ ] **Step 1: Étendre le client HTTP**

Dans `web/lib/api-agent-tools.ts`, ajouter :

```ts
export interface OutilBibliotheque {
  id: string;
  name: string;
  title: string;
  description: string;
  origin: OrigineOutil;
  risk: 'read' | 'write' | 'irreversible';
  sourceId: string | null;
  consommateurs: Array<{ cle: string; actif: boolean; agentId: string | null; agentLabel: string | null }>;
}

export async function getBibliothequeOutils(tenantId: string): Promise<{ outils: OutilBibliotheque[] }> {
  return api(`/tenants/${tenantId}/agent-tools`);
}

export async function supprimerDefinitionOutil(tenantId: string, outilId: string): Promise<void> {
  await api(`/tenants/${tenantId}/agent-tools/${outilId}`, { method: 'DELETE' });
}

export async function rattacherOutil(tenantId: string, agentId: string, outilId: string, valeur: boolean): Promise<void> {
  await api(`/tenants/${tenantId}/agents/${agentId}/tools/${outilId}/rattachement`, {
    method: 'PUT', body: JSON.stringify({ valeur }),
  });
}
```

⚠️ Reprendre exactement la fonction `api` et son maniement d'erreurs déjà utilisés dans ce fichier :
ne PAS en écrire une seconde.

- [ ] **Step 2: Écrire l'écran**

Créer `web/components/BibliothequeOutils.tsx` :

```tsx
'use client';

import { useEffect, useState } from 'react';
import { getBibliothequeOutils, supprimerDefinitionOutil, type OutilBibliotheque } from '@/lib/api-agent-tools';
import { useT } from '@/lib/i18n';

/**
 * Les outils de l'ESPACE, et qui s'en sert.
 *
 * 🔴 CE QUE CET ÉCRAN MONTRE ET QUE L'ONGLET D'UN AGENT NE PEUT PAS MONTRER : la colonne « utilisé par ».
 * Un outil déclaré une fois et branché sur trois agents était jusqu'ici trois outils qui se ressemblaient,
 * et corriger ses mots à un endroit ne les corrigeait pas aux deux autres.
 *
 * ⚠️ RIEN NE S'AFFICHE TANT QUE LA LECTURE N'A PAS ABOUTI. Une liste vide pendant le chargement dirait
 * « vous n'avez aucun outil » sur un espace qui en a douze.
 */
export function BibliothequeOutils({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [outils, setOutils] = useState<OutilBibliotheque[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    getBibliothequeOutils(tenantId)
      .then((r) => { if (vivant) setOutils(r.outils); })
      .catch(() => { if (vivant) setOutils([]); });
    return () => { vivant = false; };
  }, [tenantId]);

  async function supprimer(outilId: string) {
    setErreur(null);
    try {
      await supprimerDefinitionOutil(tenantId, outilId);
      setOutils((v) => (v ? v.filter((o) => o.id !== outilId) : v));
    } catch (e) {
      // 🔴 LE MESSAGE DU SERVEUR, PAS UN MESSAGE MAISON. Le 409 dit précisément quels agents bloquent, et
      // le remplacer par « échec » renverrait le client chercher lui-même ce que le serveur savait déjà.
      setErreur(e instanceof Error ? e.message : t('La suppression a échoué.', 'Deletion failed.'));
    }
  }

  if (outils === null) return null;

  return (
    <section data-testid="bibliotheque-outils">
      <h1 className="text-lg font-semibold text-ink-900">{t('Outils de l’espace', 'Workspace tools')}</h1>
      <p className="mt-1 text-sm text-ink-500">
        {t('Un outil se déclare une fois ici, puis chaque agent choisit de s’en servir.',
           'A tool is declared once here, then each agent chooses whether to use it.')}
      </p>

      {erreur && <p className="mt-3 text-xs text-coral" data-testid="bibliotheque-erreur">{erreur}</p>}

      {outils.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500" data-testid="bibliotheque-vide">
          {t('Aucun outil déclaré. Ajoutez-en un depuis l’onglet Outils d’un agent.',
             'No tools declared yet. Add one from an agent’s Tools tab.')}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {outils.map((o) => (
            <li key={o.id} className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm" data-testid={`outil-${o.name}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-ink-900">{o.title}</span>
                <code className="text-xs text-ink-500">{o.name}</code>
                {o.risk === 'irreversible' && (
                  <span className="rounded-full bg-coral/10 px-2 py-0.5 text-xs text-coral">
                    {t('action irréversible', 'irreversible action')}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-ink-600">{o.description}</p>
              <p className="mt-2 text-xs text-ink-500" data-testid={`outil-${o.name}-consommateurs`}>
                {o.consommateurs.length === 0
                  ? t('Utilisé par aucun agent.', 'Used by no agent.')
                  : t(`Utilisé par : ${o.consommateurs.map((c) => `${c.agentLabel ?? c.cle}${c.actif ? '' : ' (inactif)'}`).join(', ')}`,
                      `Used by: ${o.consommateurs.map((c) => `${c.agentLabel ?? c.cle}${c.actif ? '' : ' (inactive)'}`).join(', ')}`)}
              </p>
              {isAdmin && o.consommateurs.length === 0 && (
                <button type="button" className="mt-2 text-xs text-coral underline" onClick={() => supprimer(o.id)}>
                  {t('Supprimer de l’espace', 'Delete from workspace')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

⚠️ **Le bouton de suppression n'apparaît QUE sur un outil rattaché à personne.** Le serveur refuse de
toute façon en 409, mais montrer un bouton dont on sait qu'il échouera est une invitation à
l'échec, pas une garde.

- [ ] **Step 3: Monter la page et l'onglet**

Créer `web/app/agents/outils/page.tsx` sur le patron des autres pages :

```tsx
'use client';

import { AppShell } from '@/components/AppShell';
import { BibliothequeOutils } from '@/components/BibliothequeOutils';

export default function Page() {
  return (
    <AppShell active="outils-espace">
      {(session) => <BibliothequeOutils tenantId={session.tenantId} isAdmin={session.role === 'admin'} />}
    </AppShell>
  );
}
```

Dans `web/components/AppShell.tsx` : ajouter `'outils-espace'` au type `Tab`, et l'entrée de menu
dans le groupe qui porte déjà « Connecteurs API » :

```ts
      { key: 'outils-espace', href: '/agents/outils', label: t('Outils', 'Tools') },
```

🔴 **VÉRIFIER LE PIÈGE DE VOCABULAIRE AVANT DE VALIDER CE LIBELLÉ.** Le dépôt a déjà un menu
« Tools » dans la barre de gauche ET un onglet « Outils » DANS un agent, et Julien s'est déjà perdu
entre les deux le 2026-08-28. Si les deux libellés se ressemblent encore après ce lot, la correction
est de RENOMMER l'un des deux, pas de réexpliquer.

- [ ] **Step 4: Vérifier dans le navigateur**

Lancer le front (`cd web && npm run dev`), ouvrir `/agents/outils` avec un compte admin.
Expected: la liste s'affiche, la colonne « Utilisé par » nomme les agents, un outil rattaché n'a pas
de bouton de suppression, un outil libre en a un et le clic le retire de la liste.

- [ ] **Step 5: Lancer la vérification complète**

Run: `cd web && npm run build && cd .. && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -N web/components/BibliothequeOutils.tsx web/app/agents/outils/page.tsx
git commit --only web/components/BibliothequeOutils.tsx web/app/agents/outils/page.tsx web/lib/api-agent-tools.ts web/components/AppShell.tsx -m "feat(outils): l ecran bibliotheque d espace"
```

- [ ] **Step 7: La revue, puis la documentation**

Lancer `/revue` sur l'ensemble du lot, en incluant la section « Rayon de souffle » : pour chaque
symbole touché, qui le lit, quelle valeur en dur est devenue fausse, quel index sert encore sa
requête, quels textes sont devenus faux. Corriger 🔴 ET 🟡 dans la foulée, sans reporter.

Puis porter dans la doc, chacun à sa place :
- `features.md` : la bibliothèque d'outils, vue utilisateur, statut live ;
- `documentation.md` : le modèle (définition au tenant, consentement par consommateur), en
  MODIFIANT la section existante des outils d'agent, jamais en ajoutant une section à la fin ;
- `wip.md` : retirer ce lot ;
- `todo.md` : y noter que les lots 3 et 4 de la spec attendent leur plan.

---

## Auto-revue de ce plan

**1. Couverture de la spec.**

| Section de la spec | Tâche |
|---|---|
| §4.1 les deux tables | 1 |
| §4.1 les deux CHECK recopiés | 1 |
| §4.2 unicité du nom par espace | 1 (index + précondition), 3 (le test) |
| §4.3 migration 0127 avant, 0128 après | 1, 6 |
| §4.3 tolérance temporaire des deux formes | 2 (les lectures joignent la liaison, 0128 ne tombe qu'après) |
| §9 clé texte, et son ménage explicite | 1, 5 |
| §8 lot 1 (modèle) | 1 à 6 |
| §8 lot 2 (écran) | 7, 8 |
| §5 publication vers Meta | **PAS DANS CE PLAN**, lot 4, plan séparé |
| §6 la case « exposé au MBA » et son avertissement | **PAS DANS CE PLAN**, lot 3, plan séparé |
| §7 MCP | rien à faire, écarté |

Les deux « pas dans ce plan » sont annoncés en tête, sous « Périmètre ». Le modèle qu'ils exigent
(un consommateur `mba:`) est bien posé par la tâche 1 et exercé par un test de la tâche 2.

**2. Marqueurs interdits.** Aucun « TBD », aucun « gérer les cas limites », aucun « comme la tâche
N ». Chaque étape de code porte son code.

**3. Cohérence des types.** `consommateurAgent` / `consommateurMba` / `agentDuConsommateur` /
`FORME_CONSOMMATEUR` sont définis en tâche 1 et utilisés sous ces noms exacts en 2, 3, 5 et 7.
`OutilComplet` garde `actif`, `activeLe`, `autonomeLe`. `supprimerDefinition` rend le même triplet
`'ok' | 'rattachee' | 'introuvable'` en 3, 7 et dans le test de 7. `detacher` et `rattacher` portent
les mêmes signatures en 3, 4 et dans le câblage de `src/index.ts`.

**Un écart corrigé pendant l'auto-revue** : la tâche 3 supprimait `retirer` du contrat, mais la tâche
4 s'y référait encore dans le câblage. Le retrait est désormais annoncé explicitement en tâche 3
(step 2) et la tâche 4 (step 4) dit quelle ligne remplacer et pourquoi le compilateur la signalera.
