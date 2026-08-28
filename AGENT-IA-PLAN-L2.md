# Plan d'exécution, agent IA lot L2 : le connecteur API du client

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE, utiliser `superpowers:subagent-driven-development`
> (recommandé) ou `superpowers:executing-plans` pour exécuter tâche par tâche. Les étapes sont des cases
> à cocher (`- [ ]`).

**But :** qu'un agent puisse interroger le système du client (« où en est ma commande ? », « suis-je bien
inscrit ? ») par une API HTTP que le client déclare dans la console, sans qu'aucune adresse ni aucun
identifiant de ressource ne soit jamais choisi par le modèle.

**Architecture :** la troisième famille d'outils du cadrage, et la deuxième à exister. Elle ne se distingue
des outils maison que par son **résolveur** : le tronc commun (`src/agent/executor.ts`) garde la validation
des arguments, l'injection des paramètres non confiés au modèle, le budget de temps, le journal, la
troncature et la transformation d'une erreur en résultat lisible. Une **source** (adresse de base + mode
d'authentification + secret chiffré) est déclarée une fois par le client ; un **outil** de connecteur est un
gabarit de chemin sur cette source. Le modèle ne remplit que les paramètres marqués `source: 'modele'`.

**Stack :** TypeScript ESM exécuté par `tsx`, Fastify, Postgres Supabase, vitest, Next.js 15 dans `web/`,
Playwright pour les e2e. Aucune dépendance nouvelle.

**Cadrage de référence :** [AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md) §3 (« un
descripteur, trois résolveurs ») et §7 (séquencement). Le lot précédent :
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md).

---

## 🔴 CE QUI EST DÉJÀ LÀ, ET QU'IL NE FAUT PAS RÉÉCRIRE

L1 a posé l'ossature de cette famille. La lire avant d'écrire une ligne, sinon L2 la recopie.

| Ce qui existe | Où | Ce que L2 en fait |
|---|---|---|
| `origin in ('mba','http','mcp')` | migration 0086, `agent_tools` | rien à migrer sur la colonne : elle accepte déjà `http` |
| Routage par origine, refus propre si aucun résolveur | `src/agent/executor.ts:326-331` | on branche `resolveurs.http`, c'est tout |
| Séparation `modele` / `contact` / `fixe` | `src/agent/llm/tool-schema.ts` -> `paramsOutil` | **c'est LA garde anti-IDOR**, elle est écrite et testée : L2 la consomme, ne la redéfinit pas. ⚠️ Une SEULE correction, tâche 4bis : le `wa_id` doit venir du contexte du tour, pas de la projection du contact, qui ne le porte pas |
| Validation Zod des arguments du modèle, clés inconnues retirées | `src/agent/executor.ts` -> `schemaArguments` | rien à faire |
| Journal d'appels avec arguments rédigés | `agent_tool_calls`, `PgJournalAppels` | rien à faire : `origin` y est déjà |
| Plafonds (appels, budget, échéance dure) | `ContexteAppel` | rien à faire |
| Garde SSRF sur un nom d'hôte | `src/lib/page-distante.ts` -> `urlRecuperable` | **importée**, jamais recopiée |
| Chiffrement d'un secret au repos | `src/crypto/secretbox.ts` + `config.ENCRYPTION_KEY` | même patron que `src/email/account-store.pg.ts` |
| Activation par un humain, nom de l'activateur en base | contraintes de 0086 | s'applique telle quelle aux outils de connecteur |
| Le résolveur de référence | `src/agent/resolvers/mba.ts` | modèle de forme : ne lève jamais sur un cas métier |

---

## Contraintes globales (elles s'appliquent à CHAQUE tâche)

- **`tenant_id` sur CHAQUE requête.** Le pooler est superuser, la RLS est bypassée : le filtrage en code est
  le seul contrôle. Ici il porte sur une adresse réseau et un secret.
- **Aucun secret ne sort du serveur.** `auth_secret` est chiffré au repos, déchiffré au moment de l'appel,
  jamais rendu par une route, jamais journalisé, jamais mis dans un message d'erreur repassé au modèle.
- **Le modèle ne choisit jamais une cible.** Ni l'hôte, ni le chemin, ni un identifiant de ressource. Tout ce
  qu'il remplit passe par `source: 'modele'` et par le schéma Zod du tronc commun.
- **Zod `safeParse`, jamais `parse`**, sur tout corps de requête et sur toute réponse de connecteur.
- **Erreurs utilisateur en 4xx, jamais 5xx** (Cloudflare remplace le corps d'une 5xx par sa page).
- **Un résolveur ne lève pas sur un cas métier** : il rend `ok: false` avec une raison lisible.
- **Aucune connexion Postgres tenue pendant un appel réseau.** La source est lue AVANT, l'appel se fait
  ensuite, le résultat s'écrit après.
- **Pas de tirets longs** dans le code ni la doc.
- **Prochaine migration libre : 0088.** Les migrations ne sont pas auto-appliquées : `compose build` AVANT
  `compose run ... npm run migrate`, puis `up -d --build` (cf. `DEPLOY.md`).

---

## 🔴 LES QUATRE DÉCISIONS À TRANCHER AVANT DE COMMENCER

Elles changent le code, pas seulement la doc. Ma recommandation est donnée ; c'est Julien qui tranche.

**D-L2-1. Qui déclare le RISQUE d'un outil de connecteur ?** Pour un outil maison, le risque vient du
catalogue et n'est pas modifiable (le client règle l'autonomie, pas la dangerosité). Un connecteur n'a pas de
catalogue : personne d'autre que le client ne sait si `POST /commandes` crée une commande ou cherche dedans.
*Recommandation : DÉRIVÉ de la méthode HTTP (`GET`/`HEAD` -> `read`, `POST`/`PUT`/`PATCH` -> `write`,
`DELETE` -> `irreversible`), avec la possibilité de le MONTER (jamais de le descendre).* Un client qui
sous-déclare son propre connecteur ne doit pas pouvoir désarmer la garde d'autonomie.

**D-L2-2. Le filtrage de la réponse (`outputPaths`) est-il OBLIGATOIRE ?** Sur un outil maison, c'est nous
qui écrivons la réponse et elle est déjà bornée. Sur un connecteur, la réponse appartient au client, et elle
part **chez le fournisseur de modèle**. Une fiche client complète (adresse, téléphone, historique) traverserait
la frontière parce que personne n'a pensé à la borner.
*Recommandation : `outputPaths` NON VIDE exigé à la déclaration d'un outil de connecteur.* Le client dit
quels champs l'agent a le droit de lire. C'est le seul moment où quelqu'un y pense.

**D-L2-3. Modes d'authentification en L2.** *Recommandation : `none`, `bearer`, `header` (nom + valeur), et
rien d'autre.* Pas d'OAuth (c'est L6, et son coût est dans la supervision, pas le développement), pas de
signature HMAC tant que personne ne l'a demandée.

**D-L2-4. L'assistant de construction a-t-il le droit de proposer des outils de connecteur ?**
*Recommandation : OUI pour les MOTS d'un outil sur une source DÉJÀ déclarée, JAMAIS pour la source
elle-même.* Déclarer une source, c'est écrire une adresse réseau et un secret : c'est une frontière de
sécurité, elle reste à l'administrateur. C'est exactement la ligne déjà tenue par
`src/agent/setup/proposition.ts` (l'assistant écrit la fiche et les mots des outils, jamais la mention légale,
les plafonds, le risque ni l'activation).

---

# Tâche 1 : la migration 0088

**Fichiers :** Créer `db/migrations/0088_agent_tool_sources.sql`.

**Interfaces :** produit `agent_tool_sources` et la colonne `agent_tools.source_id`, consommées par les
tâches 2, 4, 5 et 6.

⚠️ La contrainte d'intégrité ajoutée sur `agent_tools` porte sur une table qui a déjà des lignes : toutes ont
`origin = 'mba'` et n'auront pas de `source_id`, donc elle valide. Vérifier ce point en CI (job `integration`),
pas en local : le `DATABASE_URL` local pointe la PRODUCTION.

- [ ] **Étape 1 : écrire la migration**

```sql
-- 0088 : les sources externes d outils (lot L2), et le lien depuis le catalogue.
--
-- POURQUOI UNE TABLE SEPAREE. L adresse de base et le secret appartiennent au TENANT, pas a l agent : deux
-- agents du meme client interrogent le meme systeme. Les mettre sur l outil obligerait a recopier le secret
-- a chaque outil, donc a le faire tourner en N endroits le jour ou il change.
--
-- POURQUOI L ADRESSE DE BASE EST FIGEE ICI. C est la garde anti-SSRF et anti-IDOR : le modele ne compose
-- jamais qu un gabarit de chemin, et le chemin final doit rester SOUS cette adresse. Une adresse ecrite par
-- le modele serait un lecteur de l interieur du reseau Docker du VPS.

create table if not exists agent_tool_sources (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- 'mcp' est declare des maintenant pour que L4 n ait pas de migration a faire, mais aucun code ne le sert.
  kind             text not null check (kind in ('http','mcp')),
  label            text not null,
  -- Adresse de BASE, https obligatoire. Jamais choisie par le modele.
  base_url         text not null,
  auth_kind        text not null check (auth_kind in ('none','bearer','header')),
  auth_header_name text,
  -- CHIFFRE au repos (src/crypto/secretbox.ts, meme patron que email_accounts.password_enc). Aucune route
  -- ne le rend, aucun journal ne l ecrit, aucun message d erreur ne le cite.
  auth_secret_enc  text,
  status           text not null default 'draft' check (status in ('draft','active','disabled')),
  -- Derniere epreuve reussie / derniere erreur : c est ce qui rend un connecteur mort VISIBLE avant qu un
  -- contact ne le decouvre. Un jeton expire ne produit aucune erreur applicative cote client.
  last_ok_at       timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists agent_tool_sources_label_idx
  on agent_tool_sources (tenant_id, lower(label));

-- Un secret est exige des que l authentification en demande un : une source 'bearer' sans secret signerait
-- avec une chaine vide et le systeme du client repondrait 401, qu on mettrait sur le dos de ses identifiants.
alter table agent_tool_sources drop constraint if exists agent_tool_sources_auth_chk;
alter table agent_tool_sources add constraint agent_tool_sources_auth_chk
  check ((auth_kind = 'none' and auth_secret_enc is null)
      or (auth_kind = 'bearer' and auth_secret_enc is not null)
      or (auth_kind = 'header' and auth_secret_enc is not null and auth_header_name is not null));

alter table agent_tools add column if not exists source_id uuid
  references agent_tool_sources(id) on delete cascade;

-- L integrite qui compte : un outil maison n a pas de source, un outil externe en a forcement une. Sans
-- elle, un outil 'http' sans source serait actif, expose au modele, et refuserait a chaque appel.
alter table agent_tools drop constraint if exists agent_tools_origin_src_chk;
alter table agent_tools add constraint agent_tools_origin_src_chk
  check ((origin = 'mba' and source_id is null) or (origin <> 'mba' and source_id is not null));
```

- [ ] **Étape 2 : recaler la numérotation** dans `CLAUDE.md` (« Dernière appliquée », « Prochaine libre =
  0089 ») et `DEPLOY.md` si nécessaire.

- [ ] **Étape 3 : commit.** `git add db/migrations/0088_agent_tool_sources.sql CLAUDE.md && git commit`

---

# Tâche 2 : le store des sources

**Fichiers :**
- Créer : `src/agent/sources.ts` (le contrat, pur)
- Créer : `src/agent/sources.pg.ts` (l'implémentation)
- Test : `tests/integration/agent-sources.integration.test.ts`

**Interfaces :**
- Consomme : `encryptSecret` / `decryptSecret` (`src/crypto/secretbox.ts`), `config.ENCRYPTION_KEY`.
- Produit : `SourceStore`, consommé par les tâches 4 (résolveur) et 5 (routes).

🔴 **Deux projections, et elles ne se mélangent pas.** `SourceVue` est ce qu'une route rend (jamais le
secret, seulement `aAuthentification: boolean`). `SourceAppel` est ce que le résolveur lit (secret déchiffré),
et cette méthode ne doit avoir qu'UN appelant. Une seule projection finirait par renvoyer le secret à
l'écran le jour où quelqu'un ajoute un champ.

```ts
export interface SourceVue {
  id: string; tenantId: string; kind: 'http' | 'mcp'; label: string; baseUrl: string;
  authKind: 'none' | 'bearer' | 'header'; authHeaderName: string | null;
  /** Le secret EXISTE-t-il. Sa valeur ne sort jamais du serveur. */
  aAuthentification: boolean;
  status: 'draft' | 'active' | 'disabled';
  lastOkAt: string | null; lastError: string | null;
}

/** Ce que le RÉSOLVEUR lit, et lui seul : le secret est déchiffré ici. */
export interface SourceAppel {
  id: string; baseUrl: string;
  authKind: 'none' | 'bearer' | 'header'; authHeaderName: string | null; authSecret: string | null;
  status: 'draft' | 'active' | 'disabled';
}

export interface SourceStore {
  lister(tenantId: string): Promise<SourceVue[]>;
  creer(tenantId: string, input: { kind: 'http'; label: string; baseUrl: string; authKind: SourceVue['authKind']; authHeaderName?: string; authSecret?: string }): Promise<SourceVue>;
  patch(tenantId: string, id: string, patch: Partial<{ label: string; baseUrl: string; authKind: SourceVue['authKind']; authHeaderName: string | null; authSecret: string; status: SourceVue['status'] }>): Promise<SourceVue | null>;
  supprimer(tenantId: string, id: string): Promise<boolean>;
  /** 🔴 UN SEUL APPELANT : le résolveur `http`, au moment de l'appel. */
  pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
  /** Résultat de la dernière épreuve, écrit après un appel réel. */
  marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
}
```

- [ ] **Étape 1 : écrire le test d'intégration qui échoue.** Il porte sur ce que seul Postgres prouve : le
  secret est bien CHIFFRÉ en base (lire la colonne brute et vérifier qu'elle ne contient pas la valeur en
  clair), `lister` ne le rend jamais, deux tenants sont étanches, la contrainte d'authentification refuse une
  source `bearer` sans secret, et supprimer une source emporte ses outils (`on delete cascade`).
- [ ] **Étape 2 : lancer, vérifier l'échec** (`npm run test:integration` en CI, jamais en local).
- [ ] **Étape 3 : implémenter** `sources.pg.ts`, `tenant_id = $1` sur chaque requête.
- [ ] **Étape 4 : relancer, vérifier le vert.**
- [ ] **Étape 5 : commit.**

---

# Tâche 3 : la garde d'URL de sortie (le cœur de sécurité de ce lot)

**Fichiers :**
- Créer : `src/agent/http-cible.ts`
- Test : `tests/agent-http-cible.test.ts`

**Interfaces :**
- Consomme : `urlRecuperable` (`src/lib/page-distante.ts`), IMPORTÉE et non recopiée.
- Produit : `construireCible`, consommée par la tâche 4 et par elle seule.

🔴 **C'est ici que le lot se joue.** Si cette fonction se trompe, un connecteur devient un lecteur de
l'intérieur du réseau Docker du VPS (l'admin NPM, les autres conteneurs, le service de métadonnées du
fournisseur) ou un IDOR sur les données d'un autre contact. Elle est pure, donc entièrement testable, et elle
doit l'être méchamment.

```ts
export interface CibleConstruite {
  ok: true; url: string; methode: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}
export interface CibleRefusee { ok: false; raison: string }

/**
 * L'URL FINALE d'un appel de connecteur, ou un refus lisible.
 *
 * 🔴 QUATRE GARDES, dans cet ordre, et aucune n'est facultative :
 *  1. l'adresse de base est HTTPS et passe `urlRecuperable` (pas d'hôte interne, pas de littéral privé) ;
 *  2. chaque segment `{param}` du gabarit est remplacé par une valeur ENCODÉE (`encodeURIComponent`) : sans
 *     ça, une valeur contenant `/` ou `..` change le chemin, et une valeur contenant `?` ajoute des
 *     paramètres de requête que personne n'a prévus ;
 *  3. l'URL résultante doit rester SOUS l'adresse de base (même origine ET le chemin de base est un préfixe
 *     de segments du chemin final) : c'est ce qui survit à un `..` qu'on aurait laissé passer ;
 *  4. un gabarit qui référence un paramètre absent est un REFUS, jamais un chemin avec un trou.
 */
export function construireCible(input: {
  baseUrl: string;
  binding: { methode: string; chemin: string };
  args: Record<string, unknown>;
}): CibleConstruite | CibleRefusee;
```

- [ ] **Étape 1 : écrire les tests qui échouent.** Au minimum, et chacun avec sa raison écrite :

```ts
it('🔴 une valeur qui contient un slash ne change PAS le chemin', () => {
  const r = construireCible({ baseUrl: 'https://api.client.fr/v1', binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: { ref: '../../admin/users' } });
  expect(r.ok).toBe(true);
  expect((r as CibleConstruite).url).toBe('https://api.client.fr/v1/commandes/..%2F..%2Fadmin%2Fusers');
});

it('🔴 une adresse de base interne est refusée', () => {
  for (const base of ['http://localhost:8095/v1', 'https://169.254.169.254/latest', 'https://mba-api:8095/', 'http://10.0.0.4/api']) {
    expect(construireCible({ baseUrl: base, binding: { methode: 'GET', chemin: '/x' }, args: {} }).ok, base).toBe(false);
  }
});

it('🔴 un gabarit qui sort de la base est refusé, même sans slash injecté', () => {
  expect(construireCible({ baseUrl: 'https://api.client.fr/v1', binding: { methode: 'GET', chemin: '../../secret' }, args: {} }).ok).toBe(false);
});

it('un paramètre manquant refuse, il ne fabrique pas un chemin à trou', () => {
  expect(construireCible({ baseUrl: 'https://api.client.fr/v1', binding: { methode: 'GET', chemin: '/commandes/{ref}' }, args: {} }).ok).toBe(false);
});

it('une méthode inconnue est refusée', () => {
  expect(construireCible({ baseUrl: 'https://api.client.fr/v1', binding: { methode: 'CONNECT', chemin: '/x' }, args: {} }).ok).toBe(false);
});
```

- [ ] **Étape 2 : lancer, vérifier l'échec.** `npx vitest run tests/agent-http-cible.test.ts`
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier le vert, ET dans l'autre sens :** retirer la garde 3 doit faire échouer le test du
  `..`, pas un autre. Si un seul test couvre deux gardes, le découper.
- [ ] **Étape 5 : commit.**

---

# Tâche 4 : le résolveur `http`

**Fichiers :**
- Créer : `src/agent/resolvers/http.ts`
- Test : `tests/agent-resolver-http.test.ts`

**Interfaces :**
- Consomme : `EntreeResolveur` / `SortieResolveur` (`src/agent/executor.ts`), `construireCible` (tâche 3),
  `SourceStore.pourAppel` et `marquerEpreuve` (tâche 2).
- **Ajoute `sourceId: string | null` à `OutilDefini`** (`src/agent/catalog.ts`) et à la projection du store
  (`src/agent/catalog.pg.ts`, colonne `source_id`) : le résolveur en a besoin, et il vient avant la tâche 6.
- Produit : `creerResolveurHttp(deps)`, câblé dans `src/worker.ts` (tâche 7) sous la clé `http` de
  `resolveurs`.

🔴 **`redirect: 'error'`, PAS `follow` ni `manual`.** Le scraper de connaissance suit les redirections en
revalidant chaque saut, parce qu'une page publique en a légitimement. Une API de connecteur qui redirige est
une anomalie : la refuser coûte un message d'erreur lisible au client, la suivre ouvre la porte que la
tâche 3 vient de fermer. C'est un choix, il est écrit là.

⚠️ **Le secret ne sort jamais dans `contenu` ni dans `erreur`.** Ce sont les deux champs que le tronc commun
repasse au MODÈLE, donc au fournisseur. En cas de 401, on rend « le système du client a refusé
l'authentification », jamais l'en-tête envoyé.

```ts
export interface DepsResolveurHttp {
  sources: Pick<SourceStore, 'pourAppel' | 'marquerEpreuve'>;
  /** Injecté pour tester sans réseau, comme partout dans ce dépôt. */
  fetchImpl?: typeof fetch;
}

export function creerResolveurHttp(deps: DepsResolveurHttp): ResolveurOutil;
```

Comportement, dans l'ordre :

1. `outil.binding` lu défensivement (jsonb) : `{ methode, chemin }`. Absent ou illisible -> `ok: false` avec
   une raison, JAMAIS une exception (ce serait un `erreur_protocole` qui arrête le tour, alors que le client
   peut corriger son outil dans la console).
2. `sources.pourAppel(ctx.tenantId, outil.sourceId)` : source absente, d'un autre tenant, ou `status !== 'active'`
   -> `ok: false` (« ce connecteur n'est pas actif »).
3. `construireCible` (tâche 3). Refus -> `ok: false` avec la raison.
4. Appel : méthode, en-têtes d'authentification, `signal` (celui du tronc commun, déjà borné par l'échéance
   du tour), `redirect: 'error'`.
5. Lecture BORNÉE à `outil.maxBytes`, vérifiée APRÈS lecture (un serveur peut mentir sur `content-length`).
6. `outputPaths` appliqués : le contenu rendu au modèle est **uniquement** ce que le client a listé.
7. `marquerEpreuve` en best-effort (jamais bloquant, jamais dans le chemin d'erreur du tour).

- [ ] **Étape 1 : écrire les tests qui échouent**, avec un faux `fetch`. Les cas qui comptent :
  succès nominal + filtrage `outputPaths` ; source inactive ; 401 (message sans secret) ; 500 du client
  (`ok: false`, le modèle peut le dire au contact) ; réponse plus grosse que `maxBytes` ; redirection refusée ;
  et **un test qui vérifie que le secret n'apparaît NI dans `contenu` NI dans `erreur`**, sur les trois modes
  d'authentification.
- [ ] **Étape 2 : lancer, vérifier l'échec.**
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier le vert.**
- [ ] **Étape 5 : commit.**

---

# Tâche 4bis : le NUMÉRO AUTHENTIFIÉ comme paramètre de connecteur

**Fichiers :**
- Modifier : `src/agent/executor.ts` (étape 4, l'injection), `src/agent/llm/tool-schema.ts` (la liste fermée)
- Créer : `src/agent/champs-contact.ts` (`CHAMPS_CONTACT_AUTORISES`)
- Test : `tests/agent-tool-executor.test.ts` (compléter)

🔴 **TROU TROUVÉ EN RELISANT LE CODE POUR CE PLAN, et c'est la clé de voûte anti-IDOR du lot.** Un connecteur
sert d'abord à répondre « où en est MA commande » : la ressource est identifiée par le contact lui-même. Or
l'injection actuelle lit `ctx.contact[contactPath]`, et `ctx.contact` est une **projection** volontairement
réduite (`{ nom, tags, champs }` dans `src/worker.ts`) qui **ne contient PAS le numéro** : y verser la ligne
brute enverrait le numéro, le BSUID et l'opt-in chez le fournisseur de modèle. Un paramètre déclaré
`source: 'contact'`, `contactPath: 'wa_id'` recevrait donc `null` aujourd'hui, et le connecteur serait appelé
sans identifiant, c'est-à-dire sur la mauvaise ressource ou sur aucune.

La correction est petite et elle est le cœur du lot : **le numéro vient de `ctx.waId`**, qui est authentifié
par la signature du webhook Meta, et **jamais de la projection**. C'est ce qui permet au client de brancher
une API par contact sans que le modèle puisse désigner quelqu'un d'autre.

```ts
// src/agent/executor.ts, étape 4
if (p.source === 'contact') {
  const chemin = p.contactPath ?? p.name;
  // 🔴 Le numéro ne vient PAS de la projection du contact : il vient du contexte du tour, où il est arrivé
  // par la signature du webhook Meta. La projection est bornée exprès (elle part chez le fournisseur de
  // modèle) et ne le porte pas ; le lire là rendrait `null`, donc un appel de connecteur sans identifiant.
  args[p.name] = chemin === 'wa_id' ? ctx.waId : (ctx.contact ? (ctx.contact[chemin] ?? null) : null);
}
```

Et la liste fermée, parce qu'un `contactPath` libre laisserait dériver un paramètre de n'importe quelle clé
de la projection le jour où elle s'élargit :

```ts
// src/agent/champs-contact.ts
/** Les seuls champs du contact dont un paramètre d'outil peut dériver. Fermée EXPRÈS : la projection du
 *  contact peut s'élargir un jour, la surface offerte à un connecteur ne doit pas suivre toute seule. */
export const CHAMPS_CONTACT_AUTORISES = ['wa_id', 'nom'] as const;
```

- [ ] **Étape 1 : écrire les tests qui échouent.** Trois cas : `contactPath: 'wa_id'` injecte le numéro DU
  TOUR (et pas `null`) même quand `ctx.contact` est `null` (contact inconnu) ; le numéro n'est PAS exposé au
  modèle (il n'entre pas dans le schéma, c'est déjà vrai, le vérifier ici quand même) ; un `contactPath` hors
  liste est refusé à la déclaration (tâche 6) et injecte `null` à l'exécution, jamais une valeur devinée.
- [ ] **Étape 2 : lancer, vérifier l'échec.**
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier le vert, ET dans l'autre sens** : remettre la lecture depuis la projection doit
  faire échouer le premier test.
- [ ] **Étape 5 : commit.**

---

# Tâche 5 : les routes des sources

**Fichiers :**
- Créer : `src/http/agent-sources.ts`
- Modifier : `src/server.ts` (montage), `src/index.ts` (câblage)
- Test : `tests/http-agent-sources.test.ts`

**Interfaces :** consomme `SourceStore` (tâche 2) ; produit les routes consommées par l'écran (tâche 8).

Routes, toutes **admin seulement** (`forbidNonAdmin`, patron de `agent-tools.ts`) et scopées par
`scopeTenant` + `estUuid` :

| Route | Ce qu'elle fait |
|---|---|
| `GET /tenants/:tenantId/agent-sources` | liste (`SourceVue`, donc sans secret) |
| `POST /tenants/:tenantId/agent-sources` | déclare une source. `baseUrl` validée par `urlRecuperable` + HTTPS **à l'écriture** : refuser à l'appel serait le découvrir en pleine conversation |
| `PATCH /tenants/:tenantId/agent-sources/:id` | modifie. Un secret absent du corps NE l'efface PAS (patron `email_accounts`) |
| `DELETE /tenants/:tenantId/agent-sources/:id` | supprime, et ses outils avec (cascade). ⚠️ Répondre 409 si des outils ACTIFS en dépendent : supprimer une source sous un agent actif le rend muet en silence |
| `POST /tenants/:tenantId/agent-sources/:id/epreuve` | appelle réellement la source (méthode et chemin donnés dans le corps), écrit `last_ok_at`/`last_error`, rend le statut. **C'est le seul moyen de savoir qu'un jeton est mort avant qu'un contact ne le découvre** |

- [ ] **Étape 1 : écrire les tests qui échouent** (patron `tests/http-agent-tools.test.ts`) : rôle `agent`
  refusé en écriture, tenant de l'URL qui dépasse celui du jeton refusé, `baseUrl` interne refusée en 400,
  secret jamais présent dans une réponse (le vérifier sur `GET` ET sur la réponse du `POST`), et suppression
  d'une source portant un outil actif refusée en 409.
- [ ] **Étape 2 : lancer, vérifier l'échec.**
- [ ] **Étape 3 : implémenter.**
- [ ] **Étape 4 : vérifier le vert.**
- [ ] **Étape 5 : commit.**

---

# Tâche 6 : déclarer un outil SUR une source

**Fichiers :**
- Modifier : `src/http/agent-tools.ts` (une route d'ajout distincte), `src/agent/catalog.pg.ts`
  (`ajouterConnecteur`), `src/agent/catalog.ts` (types)
- Test : `tests/http-agent-tools.test.ts` (compléter)

🔴 **Une route SÉPARÉE, pas un paramètre de plus sur l'ajout maison.** L'ajout maison prend son `handler`
dans le catalogue et refuse tout le reste (c'est sa garde). Un connecteur prend un `sourceId`, un gabarit et
des paramètres. Les fusionner ferait une route dont la moitié des gardes ne s'appliquent qu'à la moitié des
corps, et c'est ainsi qu'on finit par accepter un `handler` inventé.

Corps accepté (Zod `safeParse`) :

```ts
const paramConnecteurSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]{1,64}$/),
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  source: z.enum(['modele', 'contact', 'fixe']),
  description: z.string().trim().max(500).optional(),
  required: z.boolean().optional(),
  enum: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  // 🔴 Liste FERMÉE (`src/agent/champs-contact.ts`, tâche 4bis) : elle empêche de dériver un paramètre d'une
  // clé arbitraire de la projection du contact, y compris d'une clé qu'on y ajouterait plus tard.
  contactPath: z.enum(CHAMPS_CONTACT_AUTORISES).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const ajoutConnecteurSchema = z.object({
  sourceId: z.string().uuid(),
  name: NOM,
  title: TEXTE(120).min(1),
  description: TEXTE(2000).min(1),
  nePasUtiliser: TEXTE(2000).min(1),
  methode: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  chemin: z.string().trim().min(1).max(500),
  params: z.array(paramConnecteurSchema).max(20),
  // D-L2-2 : non vide. La réponse appartient au client et part chez le fournisseur de modèle.
  outputPaths: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  // D-L2-1 : le risque DÉRIVE de la méthode, et l'admin ne peut que le monter.
  risk: z.enum(['read', 'write', 'irreversible']).optional(),
});
```

- [ ] **Étape 1 : écrire les tests qui échouent.** Les cas de garde :
  `sourceId` d'un autre tenant -> 404 ; `contactPath` hors liste -> 400 ; `outputPaths` vide -> 400 ;
  `risk` inférieur à celui dérivé de la méthode -> 400 (un `DELETE` déclaré `read` est refusé) ;
  l'outil créé n'est PAS actif (l'activation reste un geste humain séparé, contrainte de 0086).
- [ ] **Étape 2 : lancer, vérifier l'échec.**
- [ ] **Étape 3 : implémenter**, `origin: 'http'` en dur côté store, jamais lu du corps.
- [ ] **Étape 4 : vérifier le vert.**
- [ ] **Étape 5 : commit.**

---

# Tâche 7 : le câblage

**Fichiers :** Modifier `src/worker.ts` (résolveur réel), `src/index.ts` (routes + bac à sable),
`src/agent/resolvers/simulation.ts` (le bac à sable SIMULE un connecteur).

🔴 **Le bac à sable NE DOIT PAS appeler l'API du client.** Il simule déjà les outils à effet ; un connecteur
en fait partie, même en lecture : un essai depuis la console ne doit pas taper sur le système de production
d'un client, ni consommer son quota. Le résolveur de simulation rend une réponse d'exemple marquée
`simule: true`, comme pour les autres.

- [ ] **Étape 1 :** brancher `resolveurs: { mba: resolveurMba, http: resolveurHttp }` dans `src/worker.ts`.
- [ ] **Étape 2 :** ajouter la branche `http` au résolveur de simulation, avec `simule: true`.
- [ ] **Étape 3 :** monter les routes de la tâche 5 et câbler le store.
- [ ] **Étape 4 :** test de bout en bout serveur : un tour d'agent qui appelle un outil de connecteur avec un
  faux `fetch`, et qui vérifie que le journal (`agent_tool_calls`) porte `origin = 'http'`.
- [ ] **Étape 5 : commit.**

---

# Tâche 8 : l'écran (onglet Outils)

**Fichiers :** Créer `web/lib/api-agent-sources.ts` ; modifier `web/components/AgentOutils.tsx` ;
e2e `web/e2e/agents-connecteurs.spec.ts`.

Ce que l'écran doit rendre évident, et qui n'est pas décoratif :

- **Deux sections distinctes** : « Outils maison » (le catalogue actuel) et « Vos connecteurs ». Un client ne
  doit pas confondre ce qu'on garantit et ce qu'il branche.
- **La source d'abord, l'outil ensuite.** Un outil de connecteur sans source active est un outil mort.
- **Le bouton « Éprouver »** sur chaque source, avec la date de la dernière réussite et la dernière erreur.
  C'est le seul endroit où un jeton expiré se voit avant qu'un contact ne le découvre.
- **Par paramètre, dire QUI le remplit** : « le modèle », « le contact » (avec le champ), « fixe » (avec la
  valeur). C'est la garde anti-IDOR, elle doit être lisible par le client, pas seulement vraie dans le code.
- **Les champs rendus par le connecteur** (`outputPaths`) sont saisis à la déclaration, et l'écran dit
  pourquoi : « l'agent ne verra que ces champs, et ce sont les seuls qui partiront chez le fournisseur du
  modèle ».
- Le secret ne se relit jamais : un champ vide veut dire « inchangé ».

- [ ] **Étape 1 : e2e qui échoue** (patron `web/e2e/agents-outils.spec.ts`).
- [ ] **Étape 2 : implémenter.**
- [ ] **Étape 3 : `npm run build` dans `web/`, e2e au vert.**
- [ ] **Étape 4 : commit.**

---

# Tâche 9 : l'assistant de construction propose des connecteurs (D-L2-4)

**Fichiers :** Modifier `src/agent/setup/proposition.ts` (schéma + application du diff),
`src/agent/setup/conversation.ts` (contexte : la liste des sources déclarées) ;
test `tests/agent-setup-proposition.test.ts`.

🔴 **La frontière ne bouge pas d'un pouce.** L'assistant lit du contenu tiers (le site du client) : ce qu'il
a le droit d'écrire est énuméré dans `proposition.ts` et nulle part ailleurs. L2 y ajoute UNE chose : les
MOTS d'un outil sur une source **déjà déclarée** (`description`, `nePasUtiliser`, et le choix d'un gabarit
parmi ceux que l'administrateur a créés). Jamais la source, jamais l'adresse, jamais le secret, jamais
l'activation, jamais le risque.

- [ ] **Étape 1 : test qui échoue**, dans les DEUX sens : une proposition qui porte un `sourceId` inconnu du
  tenant est ignorée, et une proposition qui tente d'écrire `baseUrl` ou `authSecret` est ignorée **même si
  le modèle la renvoie**.
- [ ] **Étape 2 : implémenter.**
- [ ] **Étape 3 : vérifier le vert.**
- [ ] **Étape 4 : commit.**

---

# Ce que L2 ne fait PAS

À écrire dans la doc au moment de livrer, pour que personne ne le découvre en le cherchant :

- **Pas de MCP.** La colonne `kind` l'accepte, aucun code ne le sert. C'est L4 (jeton statique sur allowlist),
  et la décision D3 du cadrage doit être tranchée avant.
- **Pas d'OAuth** (L6). Son coût est dans la SUPERVISION : un jeton mort ne produit aucune erreur applicative,
  l'agent dégrade en silence au milieu d'une conversation. L'épreuve de source (tâche 5) est le premier pas
  vers cette supervision, pas la supervision.
- **Pas d'URL saisie librement par le modèle**, jamais, à aucun lot.
- **Pas de corps de requête composé par le modèle** en L2 : `GET` et paramètres de chemin d'abord. Un corps
  JSON écrit par le modèle demande sa propre garde, et personne ne l'a encore demandé.

---

# Vérification de fin de lot

- [ ] `npx tsc --noEmit` et `npm test` verts à la racine ; `npm run build` vert dans `web/`.
- [ ] `npm run test:integration` vert **en CI** (le `DATABASE_URL` local pointe la PRODUCTION).
- [ ] Revue par un agent `feature-dev:code-reviewer` sur le diff complet, avec la question posée dans cet
  ordre : la garde d'URL, la non-fuite du secret, l'isolation tenant, puis le reste.
- [ ] Migration 0088 appliquée en production AVANT le déploiement : `compose build mba-api`, vérifier que
  0088 est DANS l'image, `compose run --rm --no-deps mba-api npm run migrate`, puis `up -d --build`.
- [ ] `documentation.md` : la famille `http` dans « Modules partagés », et le journal des décisions D-L2-1 à
  D-L2-4 avec ce qui a été tranché.
- [ ] `features.md` : « Brancher vos outils » côté client. Et **retirer l'annotation de `todo.md`** qui dit
  que le document produit promet un connecteur non livrable : à ce moment-là, il le sera.
