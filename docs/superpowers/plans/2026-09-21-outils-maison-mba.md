# Outils maison de l'agent de Meta : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** donner à l'agent de Meta quatre outils maison (poser un tag, enregistrer une information, envoyer un
bloc, lancer un scénario) exécutés par le relais, refaire l'onglet « Outils » du MBA, et transmettre à l'agent
de Meta la réponse « à côté » d'un client quand un scénario lui rend la main.

**Architecture :** le relais `POST /mba/relais/outils/:id` reconnaît un outil `origin = 'mba'` marqué
`pour_agent_meta` et exécute son geste avec les fonctions existantes (`creerPoserTagAgent`, `mergeFieldsByPhone`,
`startFromNode`, le lancement de l'Inbox). Les outils vivent dans `agent_tools` (migration 0162), se publient
sous le connecteur `EngageMe` comme les outils de connecteur, et se gèrent depuis un onglet refait
(`web/components/mba-outils/`). La réponse « à côté » part par `agent_event` une fois le fil rendu, et le
marqueur de 0149 cesse de se poser sur un message déjà acquitté.

**Tech Stack :** TypeScript, Fastify, Postgres (pg), Zod, vitest ; Next.js 14 / React / Tailwind, Playwright.

**Spec :** `docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md` (validée par Julien le 2026-09-21).

## Global Constraints

- Aucun tiret cadratin ni demi-cadratin, nulle part (code, commentaires, textes d'écran, docs).
- « Meta Business Agent », « agent de Meta » ; jamais « UChat » dans un texte d'écran.
- Isolation : chaque requête SQL filtre `tenant_id = $1` ; chaque route tenant passe par `scopeTenant` et la
  garde admin (`g.admin`), module déclaré dans `modulesDeRoutes` (`src/server.ts`) avec `acces: 'tenant'`.
- Toute entrée externe (corps de route, corps envoyé par Meta, `binding` relu en base) : Zod `safeParse`,
  jamais `as` sur un payload.
- Textes d'écran bilingues `t(fr, en)`.
- `npm run test:integration` **jamais en local** (le `DATABASE_URL` local est la PRODUCTION) : les tests
  `tests/integration/*` tournent en CI (job `integration`). Après chaque push de code, lire
  `gh run view <id> --json jobs`, jamais le code de sortie de `gh run watch`.
- Commits : `git add -- <fichier neuf>` puis `git commit --only <chemins touchés>`. La liste se construit depuis
  ce qu'on a touché, jamais depuis `git status`. Avant tout commit d'un fichier de doc partagé (`features.md`,
  `documentation.md`, `todo.md`, `wip.md`, `docs/JOURNAL-TECHNIQUE.md`, `CLAUDE.md`), relire son `git diff` en
  cherchant les blocs d'une autre session. Tout sur `main`, `git push origin main`.
- Une mutation de test se fait sur une copie hors dépôt, ou son motif est grepé avant commit
  (`git diff --cached | grep -n "MUTATION"` doit rendre vide).
- Migration : **0162**. Juste avant d'écrire le fichier, relire la base :
  `select name from public.schema_migrations order by name desc limit 3`.
- Aucun `Workflow` multi-agents sans le oui explicite de Julien.

## Écarts à la spec, assumés

1. **L'appel d'un outil de connecteur ne se change pas au « Modifier »** : il s'affiche en lecture seule, avec
   « Pour changer d'appel, créez un autre outil ». La spec disait « cible comprise » ; mais la définition d'un
   connecteur est partagée avec les agents IA qui l'utilisent (0127), et changer d'appel changerait leur outil
   sous leurs pieds. Les quatre outils maison, eux, changent de cible librement.
2. **Les routes MBA de `src/http/agent-catalogue.ts` partent** (`POST /agent-tools/connecteur-mba`,
   `PATCH /agent-tools/:outilId`, `PUT /agent-tools/:outilId/mba`, `DELETE /agent-tools/:outilId`) : leur seul
   client était l'écran remplacé. `GET /agent-tools` reste (lu par `AgentOutils.tsx` et `api-agent-setup.ts`).
   Leurs cas de test sont portés vers `tests/http-mba-outils.test.ts` (table au Task 7).
4. **Un outil désactivé se voit et se réactive** (trouvé à l'exécution du Task 4, rayon de souffle) : le départ
   d'un collaborateur éteint les consentements qu'il avait donnés (`PgUserStore.deleteUser`), donc un outil de
   l'agent de Meta qu'il avait créé devient inactif : le relais le refuse, et il sort de la publication. ⚠️ Il
   reste pourtant LISTÉ chez Meta jusqu'au prochain envoi, rien ne republiant au départ d'un collaborateur (revue
   finale du 2026-09-21) : la ligne dit alors « Désactivé » avec un bouton « À envoyer » qui l'en retire. L'ancienne
   case « Exposé » permettait de le rallumer ; elle part avec l'écran. La vue porte donc `actif`, la ligne affiche
   « Désactivé » (et non un état chez Meta), et un bouton « Réactiver » appelle
   `PUT /tenants/:tenantId/mba-outils/:outilId/actif` (`activerConsommateur`, au nom de l'administrateur qui
   clique ; 409 avec sa raison sur un outil non activable), puis publie.
3. **Deux déploiements**, chacun précédé d'une revue finale : après le lot 2 (écran, tag, information), puis
   après les lots 3 et 4. La migration 0162 passe avant le premier ; elle porte déjà `accuse_le`, que seul le
   lot 4 écrit (une colonne nullable que personne ne lit ne gêne rien).
5. **Un nom déjà pris se signale à l'ENREGISTREMENT, pas à la saisie** (spec § 9.4 ; relevé par la revue finale
   du 2026-09-21). Le formulaire ne connaît que les outils de l'agent de Meta, alors que l'unicité porte sur tous
   les outils de l'espace sans agent (`agent_tools_nom_espace_uidx`, connecteurs des agents IA compris) : un
   contrôle à la saisie sur la seule liste visible aurait laissé passer la moitié des collisions en promettant le
   contraire. La route rend 409 (« un outil de cet espace porte déjà ce nom »), affiché dans le formulaire, qui
   reste ouvert avec ce qui a été saisi. Un contrôle exact à la saisie demanderait de lire la bibliothèque de
   l'espace : noté dans `todo.md`.
6. **`params` reste vide pour un outil maison** (spec § 6 ; même revue). La variable que l'agent de Meta
   remplit (`valeur`, pour une information) se DÉRIVE de la cible à la publication (`variablesPourMeta`), et la
   route la relit à l'exécution (`lireValeurChamp`). L'écrire aussi dans `params` ferait deux vérités sur le
   même objet, dont une que rien ne lit.
7. **Le relais refuse d'écrire un champ supprimé du mini-CRM** (même revue). La spec ne le disait pas ; mais
   l'écran affiche alors « ce champ n'existe plus » en rouge, et écrire quand même rangeait la valeur sous une
   clé qu'aucun écran ne montre. `DepsMaison.champExiste` lit la même liste que cette ligne rouge.

## Méthode de livraison

**Implémenteur par lot, en direct dans cette session, avec revue humaine du DIFF avant chaque commit**, puis
`/revue` à la fin de chaque lot et `/revue-finale` avant chaque déploiement. La raison : la production emprunte
ces chemins (envoi de messages au client, traitement des accusés de Meta, migration), le marqueur de 0149 et la
prise du fil portent des invariants invisibles, et la moitié des critères (le fil chez Meta, la réponse de
l'agent) ne se vérifient pas par un test. feature-loop ne convient pas pour cette raison ; aucun workflow
multi-agents n'est demandé.

**L'essai réel qui clôt la feature**, par Julien sur son numéro WhatsApp, en deux temps :
- **après le lot 2** : créer depuis le nouvel écran un outil « Poser un tag » et un outil « Enregistrer une
  information », les voir passer de « À envoyer » à « Chez Meta » au seul enregistrement, puis les déclencher en
  conversation (étiquette et champ visibles sur la fiche du mini-CRM, lignes `mba` dans le journal) ;
- **après les lots 3 et 4** : un outil « Envoyer un bloc » déclenché en conversation (le bloc arrive, l'agent de
  Meta répond de nouveau au message suivant) ; un outil « Lancer un scénario » mené à son terme (l'agent de Meta
  reprend la parole) ; un second scénario où Julien répond à côté (l'agent de Meta répond à ce qu'il a écrit).
  L'inconnue M1 (l'agent de Meta écrit-il après notre prise du fil ?) se lit pendant cet essai.

## Structure des fichiers

**Serveur, créés**
- `db/migrations/0162_outils_maison_mba.sql` : colonne `pour_agent_meta`, CHECK relâché et CHECK neuf, colonne `accuse_le`.
- `src/mba/outils-maison.ts` : le catalogue des quatre gestes (pur) : handlers, schéma de cible, variables publiées, réponses, bloc seul.
- `src/mba/executer-maison.ts` : l'exécution d'un geste pour un contact, derrière des dépendances injectées.
- `src/mba/outils-a-publier.ts` : ce qui part chez Meta pour chaque outil exposé (sorti de `src/index.ts` pour être testé).
- `src/mba/vue-outils.ts` : la ligne d'écran d'un outil (type, cible, cible manquante, partage), pure.
- `src/mba/evenement.ts` : l'`agent_event` « réponse hors parcours » (pur).
- `src/http/mba-outils.ts` : les routes de l'onglet (liste, créer, modifier, retirer, blocs proposables).

**Serveur, modifiés**
- `src/agent/catalog.pg.ts` : `listToutesConsommateur`, `ajouterMaisonPourMba`, `patchMaisonPourMba`, `retirerDeMba` ; exclusions dans `listCatalogue` et `rattacherConsommateur`.
- `src/http/mba-relais.ts` : branche maison.
- `src/http/agent-catalogue.ts` : ne garde que `GET /agent-tools`.
- `src/server.ts` : registre (`mbaOutils`), types de dépendances.
- `src/index.ts` : câblage (relais maison, outils à publier, routes de l'onglet, lancement partagé avec l'Inbox).
- `src/workflow/node-list.ts` : exporte `CODE_BLOC_RE`.
- `src/workflow/wiring.ts` : `rendreLaMainApresParcours` nommé et rendu, `transmettreHorsParcours`.
- `src/workflow/executor.ts` : dépendance `transmettreHorsParcours`, appel dans la branche « il a écrit ».
- `src/inbox/store.pg.ts` : `demanderReleaseMba` (nouvelle règle), `consommerReleaseMba` (pose `accuse_le`).
- `src/mba/client.ts` : `agentEvent`, `signal` dans `appel`.

**Web, créés**
- `web/lib/api-mba-outils.ts`, `web/lib/mba-outils.ts` (+ `web/lib/mba-outils.test.ts`).
- `web/components/mba-outils/OutilsMba.tsx`, `ChoixTypeOutil.tsx`, `FormulaireOutilMba.tsx`, `CiblesOutil.tsx`.

**Web, modifiés ou supprimés**
- `web/app/mba/parametres/page.tsx` (monte `OutilsMba`), `web/app/outils/page.tsx` (renvoie vers l'onglet).
- `web/lib/api-agent-tools.ts` (retire `creerOutilPourMba`, `patchOutilMba`, `supprimerDefinitionOutil`, `exposerOutilAuMba`).
- `web/components/BibliothequeOutils.tsx` : supprimé.
- `web/e2e/mba-onglet-outils.spec.ts` : réécrit, cas conservés (table au Task 9).

**Tests créés** : `tests/mba-outils-maison.test.ts`, `tests/mba-executer-maison.test.ts`,
`tests/mba-outils-a-publier.test.ts`, `tests/mba-vue-outils.test.ts`, `tests/http-mba-outils.test.ts`,
`tests/mba-evenement.test.ts`, `tests/migration-0162.test.ts`,
`tests/integration/outils-maison-mba.integration.test.ts`.

**Tests modifiés** : `tests/http-mba-relais.test.ts`, `tests/http-agent-catalogue.test.ts`,
`tests/controle-du-fil-cablage.test.ts`, `tests/workflow-release-mba.test.ts`, `tests/mba-client.test.ts`,
`tests/integration/release-mba-marqueur.integration.test.ts` (un cas y change de sens, nommé au Task 16).

---

## Lot 1 : la mesure M2 (jetable)

### Task 1 : un `agent_event` fait-il répondre l'agent de Meta dans une conversation en cours ?

**Fichiers :** aucun dans le dépôt. Le script vit dans le scratchpad et sur le VPS (`/tmp`), puis part.
Le résultat s'écrit dans `docs/MBA-API-REFERENCE.md` (§ 6, `agent_event`).

**Ce qui dépend de la mesure :** le Task 18 (transmission) et le format de `to` dans `src/mba/evenement.ts`
(Task 17). Si l'agent ne répond pas, les Tasks 17 et 18 tombent ; le Task 16 (fil bloqué) reste.

- [ ] **Step 1 : retrouver le numéro de l'espace et la conversation de Julien, et vérifier `is_test`**

Lecture seule, sur le VPS (le conteneur connaît la base et la clé de chiffrement) :

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS "cd /home/ubuntu/mba && sudo docker compose exec -T mba-api node -e \"
const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
(async()=>{const r=await p.query(\\\"select c.tenant_id, c.wa_id, c.is_test, c.control_owner, pn.id as pn from conversations c join phone_numbers pn on pn.tenant_id = c.tenant_id where c.wa_id like '33%' order by c.last_message_at desc limit 5\\\");console.log(r.rows);await p.end();})();\""
```

Attendu : la ligne de Julien, son `pn`, et `is_test`. **Si `is_test = true`**, le fil ne lui reviendra jamais
en fin de scénario (règle du 2026-09-16) : le dire à Julien, qui choisit un autre numéro d'essai ou décide de
lever le drapeau (`update conversations set is_test = false where ...`, geste à lui faire valider).

- [ ] **Step 2 : écrire le script de mesure dans le scratchpad**

`<scratchpad>/mesure-agent-event.mts` (même moule que `scripts/sonde-mba-live.mts`) :

```ts
/**
 * MESURE M2 (jetable) : un agent_event fait-il répondre l'agent de Meta dans une conversation EN COURS ?
 * Usage : npx tsx /app/mesure-agent-event.mts <phone_number_id> <wa_id> <avec_plus|sans_plus>
 */
import { Pool } from 'pg';
// Le script est monté sous /app/mesure-agent-event.mts : le code de l'image est à côté, sous /app/src.
import { decryptSecret } from './src/crypto/secretbox';

const [PN, WA, FORME] = process.argv.slice(2);
if (!PN || !WA || (FORME !== 'avec_plus' && FORME !== 'sans_plus')) {
  console.error('usage: <phone_number_id> <wa_id> <avec_plus|sans_plus>');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  `select w.business_token_enc from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id where p.id = $1`, [PN],
);
const enc = cred.rows[0]?.business_token_enc;
const token = enc ? decryptSecret(enc, process.env.ENCRYPTION_KEY ?? '') : (process.env.META_ACCESS_TOKEN ?? '');
console.log(`token longueur ${token.length}`);
const to = FORME === 'avec_plus' ? `+${WA}` : WA;
const corps = {
  to,
  event: {
    type: 'reponse_hors_parcours',
    description: 'Le client vient d’écrire en dehors du parcours automatique qu’on lui proposait. Réponds à son message, et commence ta réponse par le mot ANANAS.',
    payload: JSON.stringify({ message: 'Au fait, vous êtes ouverts le dimanche ?' }),
  },
};
const res = await fetch(`https://api.facebook.com/${PN}/agent_event`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'X-API-Version': '2.0.0', 'Content-Type': 'application/json' },
  body: JSON.stringify(corps),
});
const txt = await res.text();
console.log(`POST agent_event (${FORME}) -> HTTP ${res.status}\n${txt.slice(0, 1500)}`);
await pool.end();
```

- [ ] **Step 3 : le lancer pendant que l'agent de Meta tient la conversation de Julien**

Protocole, dans cet ordre :
1. Demander à Julien d'écrire un message ordinaire à son numéro et d'attendre la réponse de l'agent de Meta
   (l'agent tient alors le fil).
2. Copier et lancer, forme `avec_plus` d'abord :

```bash
scp -i ~/.ssh/id_ed25519 "<scratchpad>/mesure-agent-event.mts" ubuntu@$VPS:/tmp/mesure-agent-event.mts
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS "cd /home/ubuntu/mba && sudo docker compose run --rm --no-deps -v /tmp/mesure-agent-event.mts:/app/mesure-agent-event.mts mba-api npx tsx mesure-agent-event.mts <PN> <WA> avec_plus"
```

3. Si la réponse est un 4xx sur `to`, relancer avec `sans_plus`.
4. Demander à Julien ce qu'il a reçu, et dans quel délai.

Attendu, à consigner tel quel : le statut HTTP et le corps de réponse ; si Julien reçoit un message ; s'il
commence par « ANANAS » (l'agent suit-il la `description`) ; s'il répond à la question du `payload` ; le délai.

- [ ] **Step 4 : consigner et trancher**

Écrire le résultat dans `docs/MBA-API-REFERENCE.md`, sous `### agent_event : déclencher l'agent depuis un
back-office`, en paragraphe « **MESURÉ le 2026-09-2x** », avec le format de `to` retenu. Puis :
- l'agent répond : les Tasks 17 et 18 se font, avec le format mesuré ;
- l'agent ne répond pas : les Tasks 17 et 18 sont retirés du plan (le dire dans `wip.md`), le Task 16 se fait.

Supprimer le script du VPS : `ssh ... "rm /tmp/mesure-agent-event.mts"`.

- [ ] **Step 5 : commit de la documentation**

```bash
git commit --only docs/MBA-API-REFERENCE.md -m "docs(mba): agent_event mesure dans une conversation en cours"
```

---

## Lot 2 : la base, le tag, l'information et le nouvel écran

### Task 2 : migration 0162

**Fichiers :**
- Créer : `db/migrations/0162_outils_maison_mba.sql`
- Créer : `tests/migration-0162.test.ts`
- Créer : `tests/integration/outils-maison-mba.integration.test.ts` (la partie contraintes ; le Task 4 l'étend)

**Interfaces :**
- Produit : `agent_tools.pour_agent_meta boolean not null default false` ; CHECK
  `agent_tools_action_par_agent_chk check (origin <> 'mba' or agent_id is not null or pour_agent_meta)` ;
  CHECK `agent_tools_pour_agent_meta_chk check (not pour_agent_meta or (origin = 'mba' and agent_id is null))` ;
  `conversation_messages.accuse_le timestamptz` nullable.

- [ ] **Step 1 : relire le compteur en base**

```bash
node -e "require('dotenv/config');const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});p.query('select name from public.schema_migrations order by name desc limit 3').then(r=>{console.log(r.rows);return p.end();});"
```

Attendu : `0161_relais_mba.sql` en tête. Sinon, prendre le numéro libre suivant et le reporter partout dans ce plan.

- [ ] **Step 2 : le test qui lit le fichier (il échoue, le fichier n'existe pas)**

`tests/migration-0162.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0162 : les outils maison de l'agent de Meta, et l'accusé de nos envois (spec 2026-09-21-outils-maison-mba).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : les deux CHECK, mot pour mot. Le premier RELÂCHE 0159 pour les seuls outils de
 * l'agent de Meta ; le second empêche ce drapeau de servir d'échappatoire à autre chose (un connecteur, une
 * action d'agent). Un CHECK réécrit de mémoire serait le moyen le plus sûr d'en perdre un sens.
 */
const sql = readFileSync(new URL('../db/migrations/0162_outils_maison_mba.sql', import.meta.url), 'utf8');
const compact = sql.replace(/\s+/g, ' ');

describe('migration 0162', () => {
  it('ajoute le drapeau avec un défaut qui ne change rien aux lignes existantes', () => {
    expect(compact).toContain('add column if not exists pour_agent_meta boolean not null default false');
  });
  it('🔴 relâche 0159 pour les seuls outils de l’agent de Meta', () => {
    expect(compact).toContain('drop constraint if exists agent_tools_action_par_agent_chk');
    expect(compact).toContain("check (origin <> 'mba' or agent_id is not null or pour_agent_meta)");
  });
  it('🔴 le drapeau ne vaut QUE pour un outil maison sans agent', () => {
    expect(compact).toContain("check (not pour_agent_meta or (origin = 'mba' and agent_id is null))");
  });
  it('ajoute l’accusé, nullable, sans défaut ni index', () => {
    expect(compact).toContain('alter table conversation_messages add column if not exists accuse_le timestamptz;');
    expect(sql).not.toMatch(/index[^;]*accuse_le/i);
  });
});
```

- [ ] **Step 3 : lancer, constater l'échec**

Run : `npx vitest run tests/migration-0162.test.ts`
Attendu : FAIL, `ENOENT` sur `0162_outils_maison_mba.sql`.

- [ ] **Step 4 : écrire la migration**

`db/migrations/0162_outils_maison_mba.sql` :

```sql
-- 0162_outils_maison_mba.sql : les outils maison de l'agent de Meta, et l'accusé de nos envois.
-- Spec : docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md (§ 5.1 et § 6).
--
-- AVANT le déploiement : le code neuf écrit `pour_agent_meta` et `accuse_le`. L'ancien code y survit : un CHECK
-- relâché, une colonne à défaut `false` qu'il n'écrit pas, une colonne nullable qu'il ne lit pas.

-- Un outil qui appartient à l'agent de Meta de l'espace, et à lui seul (il n'a pas de fiche d'agent).
alter table agent_tools add column if not exists pour_agent_meta boolean not null default false;

-- 0159 exigeait un agent propriétaire pour toute action maison. L'agent de Meta n'a pas de ligne `agents` :
-- son drapeau tient lieu de propriétaire.
alter table agent_tools drop constraint if exists agent_tools_action_par_agent_chk;
alter table agent_tools add constraint agent_tools_action_par_agent_chk
  check (origin <> 'mba' or agent_id is not null or pour_agent_meta);

-- Le drapeau n'est pas une échappatoire : il ne vaut que pour un outil maison sans agent.
alter table agent_tools drop constraint if exists agent_tools_pour_agent_meta_chk;
alter table agent_tools add constraint agent_tools_pour_agent_meta_chk
  check (not pour_agent_meta or (origin = 'mba' and agent_id is null));

-- Le premier accusé reçu de Meta pour un message sortant. Il dit que Meta a fini de traiter l'envoi, donc
-- qu'un release n'a plus rien à attendre (0149). Aucun index : la lecture passe par `meta_message_id`.
alter table conversation_messages add column if not exists accuse_le timestamptz;
```

- [ ] **Step 5 : le test passe, et la garde des directives aussi**

Run : `npx vitest run tests/migration-0162.test.ts tests/migration-directives.test.ts`
Attendu : PASS.

- [ ] **Step 6 : le test d'intégration des contraintes (CI seulement)**

`tests/integration/outils-maison-mba.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';

/**
 * Les outils maison de l'agent de Meta, contre une vraie base (migration 0162, spec 2026-09-21).
 * ⚠️ CI SEULEMENT : le DATABASE_URL local est la production.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('0162 : les contraintes', () => {
  let pool: Pool;
  let tenantId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-outils-maison-mba') returning id`)).rows[0]!.id;
  });
  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const inserer = (name: string, pourAgentMeta: boolean, origin = 'mba') => pool.query(
    `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
     values ($1, $2, $3, 'T', 'D', 'N', '[]'::jsonb, '{"handler":"tag_fixe","tag":"vip"}'::jsonb, 'write', $4)`,
    [tenantId, origin, name, pourAgentMeta],
  );

  it('🔴 un outil maison SANS agent et SANS le drapeau reste refusé (0159 tient toujours)', async () => {
    await expect(inserer('orphelin', false)).rejects.toMatchObject({ code: '23514', constraint: 'agent_tools_action_par_agent_chk' });
  });
  it('un outil maison de l’agent de Meta est accepté', async () => {
    await expect(inserer('pose_vip', true)).resolves.toBeTruthy();
  });
  it('🔴 le drapeau sur un connecteur est refusé', async () => {
    await expect(inserer('faux_connecteur', true, 'http')).rejects.toMatchObject({ code: '23514' });
  });
});
```

Vérifier le chemin de `pgSsl` : `grep -rn "export function pgSsl" src` ; utiliser celui que
`tests/integration/outil-par-agent.integration.test.ts` importe.

- [ ] **Step 7 : typecheck, commit**

```bash
npm run typecheck
git add -- db/migrations/0162_outils_maison_mba.sql tests/migration-0162.test.ts tests/integration/outils-maison-mba.integration.test.ts
git commit --only db/migrations/0162_outils_maison_mba.sql tests/migration-0162.test.ts tests/integration/outils-maison-mba.integration.test.ts -m "feat(mba): migration 0162, les outils maison de l agent de Meta et l accuse des envois"
```

---

### Task 3 : le catalogue des gestes (tag et information)

**Fichiers :**
- Créer : `src/mba/outils-maison.ts`
- Créer : `tests/mba-outils-maison.test.ts`

**Interfaces :**
- Consomme : `VariableDeclaree` (`src/agent/requetes.ts`), `RisqueOutil` (`src/agent/catalog.ts`),
  `OUTILS_MAISON` (`src/agent/outils-maison.ts`, pour le test de disjonction).
- Produit :
  - `HANDLERS_MAISON_MBA: readonly ['tag_fixe', 'champ_fixe']` (le lot 3 ajoute `bloc_fixe`, `scenario_fixe`)
  - `type HandlerMaisonMba`, `type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur'`
  - `cibleMaisonSchema`, `type CibleMaison`, `lireCibleMaison(binding: unknown): CibleMaison | null`
  - `typeDeLaCible(c: CibleMaison): Exclude<TypeOutilMba, 'connecteur'>`
  - `RISQUE_MAISON: Record<HandlerMaisonMba, RisqueOutil>`
  - `REPONSE_MAISON: Record<HandlerMaisonMba, string>`
  - `VARIABLE_VALEUR = 'valeur'`, `variablesPourMeta(c: CibleMaison): VariableDeclaree[]`
  - `lireValeurChamp(c: CibleChamp, corps: unknown): { ok: true; valeur: string } | { ok: false; erreur: string }`
  - `type CibleChamp = Extract<CibleMaison, { handler: 'champ_fixe' }>`

- [ ] **Step 1 : les tests (ils échouent, le module n'existe pas)**

`tests/mba-outils-maison.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import {
  HANDLERS_MAISON_MBA, cibleMaisonSchema, lireCibleMaison, typeDeLaCible, variablesPourMeta, lireValeurChamp,
  REPONSE_MAISON, RISQUE_MAISON, type CibleChamp,
} from '../src/mba/outils-maison';
import { OUTILS_MAISON } from '../src/agent/outils-maison';

/**
 * Le catalogue des gestes de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE : que la cible relue en base soit VALIDÉE (le `binding` est un jsonb opaque), et
 * que ces handlers ne croisent JAMAIS ceux des agents IA : un outil de l'agent de Meta qui atteindrait un agent
 * IA tomberait alors sur un handler inconnu, donc un refus, au lieu d'être joué avec d'autres paramètres.
 */
describe('la cible d’un outil maison', () => {
  it('lit une étiquette fixée et un champ fixé', () => {
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: 'vip' })).toEqual({ handler: 'tag_fixe', tag: 'vip' });
    expect(lireCibleMaison({ handler: 'champ_fixe', champ: 'ville', valeurs: [] }))
      .toEqual({ handler: 'champ_fixe', champ: 'ville', valeurs: [] });
  });
  it('🔴 refuse un handler des agents IA, une clé en trop, une étiquette vide', () => {
    expect(lireCibleMaison({ handler: 'poser_tag', tag: 'vip' })).toBeNull();
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: 'vip', agentId: 'x' })).toBeNull();
    expect(lireCibleMaison({ handler: 'tag_fixe', tag: '  ' })).toBeNull();
    expect(lireCibleMaison(null)).toBeNull();
  });
  it('dit le type d’écran de chaque cible', () => {
    expect(typeDeLaCible({ handler: 'tag_fixe', tag: 'vip' })).toBe('tag');
    expect(typeDeLaCible({ handler: 'champ_fixe', champ: 'ville', valeurs: [] })).toBe('champ');
  });
});

describe('ce que Meta reçoit dans le corps de l’outil', () => {
  it('rien pour une étiquette : l’agent ne fournit rien', () => {
    expect(variablesPourMeta({ handler: 'tag_fixe', tag: 'vip' })).toEqual([]);
  });
  it('🔴 une seule variable pour un champ, requise, avec les valeurs permises quand il y en a', () => {
    const [v] = variablesPourMeta({ handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] });
    expect(v).toMatchObject({ nom: 'valeur', type: 'string', origine: { type: 'modele' }, requis: true, enum: ['Paris', 'Lyon'] });
    const [libre] = variablesPourMeta({ handler: 'champ_fixe', champ: 'ville', valeurs: [] });
    expect(libre).not.toHaveProperty('enum');
  });
});

describe('la valeur que l’agent de Meta envoie pour un champ', () => {
  const ville: CibleChamp = { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] };
  it('accepte une valeur permise, sans ses blancs', () => {
    expect(lireValeurChamp(ville, { valeur: ' Paris ' })).toEqual({ ok: true, valeur: 'Paris' });
  });
  it('🔴 refuse une valeur hors liste, en nommant la liste', () => {
    const r = lireValeurChamp(ville, { valeur: 'Marseille' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.erreur).toContain('Paris, Lyon');
  });
  it('refuse une valeur absente ou vide', () => {
    expect(lireValeurChamp(ville, {}).ok).toBe(false);
    expect(lireValeurChamp(ville, { valeur: '' }).ok).toBe(false);
  });
});

describe('le catalogue est complet et fermé', () => {
  it('🔴 chaque handler a son schéma, sa réponse et son risque', () => {
    const duSchema = cibleMaisonSchema.options.map((o) => o.shape.handler.value).sort();
    expect(duSchema).toEqual([...HANDLERS_MAISON_MBA].sort());
    for (const h of HANDLERS_MAISON_MBA) {
      expect(REPONSE_MAISON[h].length).toBeGreaterThan(10);
      expect(RISQUE_MAISON[h]).toBeDefined();
    }
  });
  it('🔴 aucun handler de l’agent de Meta n’existe chez les agents IA', () => {
    const agentsIa = new Set(OUTILS_MAISON.map((o) => o.handler));
    expect(HANDLERS_MAISON_MBA.filter((h) => agentsIa.has(h))).toEqual([]);
  });
  it('🔴 aucune réponse ne cite un nom technique à répéter au client', () => {
    expect(REPONSE_MAISON.tag_fixe).toContain('sans citer de nom technique');
  });
});
```

- [ ] **Step 2 : lancer, constater l'échec**

Run : `npx vitest run tests/mba-outils-maison.test.ts`
Attendu : FAIL, module `../src/mba/outils-maison` introuvable.

- [ ] **Step 3 : écrire le module**

`src/mba/outils-maison.ts` :

```ts
import { z } from 'zod';
import type { VariableDeclaree } from '../agent/requetes';
import type { RisqueOutil } from '../agent/catalog';

/**
 * LES GESTES DE L'AGENT DE META : ce que le relais exécute lui-même, sans système tiers (spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 3).
 *
 * 🔴 DES HANDLERS À PART DE CEUX DES AGENTS IA (`src/agent/outils-maison.ts`), et c'est une garde. Un outil de
 * l'agent de Meta qui atteindrait par erreur un agent IA tomberait sur un handler inconnu, donc un refus, au
 * lieu d'être joué avec une autre forme de paramètres. `tests/mba-outils-maison.test.ts` tient la disjonction.
 *
 * 🔴 LA CIBLE EST FIXÉE PAR L'ADMINISTRATEUR, jamais par le modèle (arbitrage de Julien, 2026-09-21 : « fixé
 * d'avance »). L'agent de Meta ne décide que du MOMENT, et pour un champ, de la valeur.
 */
export const HANDLERS_MAISON_MBA = ['tag_fixe', 'champ_fixe'] as const;
export type HandlerMaisonMba = (typeof HANDLERS_MAISON_MBA)[number];

/** Le type d'un outil tel que l'écran le montre. `connecteur` n'est pas un geste maison : il appelle un tiers. */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

/**
 * ⚠️ `.strict()` : le `binding` est un jsonb que rien d'autre ne contraint. Une clé en trop veut dire qu'une
 * autre écriture l'a produit, et un outil qu'on ne comprend pas ne s'exécute pas.
 */
export const cibleMaisonSchema = z.discriminatedUnion('handler', [
  z.object({ handler: z.literal('tag_fixe'), tag: z.string().trim().min(1).max(64) }).strict(),
  z.object({
    handler: z.literal('champ_fixe'),
    champ: z.string().trim().min(1).max(64),
    valeurs: z.array(z.string().trim().min(1).max(120)).max(50),
  }).strict(),
]);
export type CibleMaison = z.infer<typeof cibleMaisonSchema>;
export type CibleChamp = Extract<CibleMaison, { handler: 'champ_fixe' }>;

/** La cible d'un outil relu en base, ou `null` : un outil illisible n'est ni exécuté ni publié. */
export function lireCibleMaison(binding: unknown): CibleMaison | null {
  const r = cibleMaisonSchema.safeParse(binding);
  return r.success ? r.data : null;
}

export function typeDeLaCible(c: CibleMaison): Exclude<TypeOutilMba, 'connecteur'> {
  switch (c.handler) {
    case 'tag_fixe': return 'tag';
    case 'champ_fixe': return 'champ';
  }
}

/** Le risque déclaré en base. Meta n'a aucun réglage d'autonomie : il sert au journal et à la lecture. */
export const RISQUE_MAISON: Record<HandlerMaisonMba, RisqueOutil> = {
  tag_fixe: 'write',
  champ_fixe: 'write',
};

/**
 * CE QUE L'AGENT DE META REÇOIT EN CAS DE SUCCÈS (spec § 7).
 *
 * ⚠️ Jamais le nom de l'étiquette ni du champ : ce sont des noms internes, et l'agent les répéterait au client.
 */
export const REPONSE_MAISON: Record<HandlerMaisonMba, string> = {
  tag_fixe: 'C’est fait, c’est enregistré sur la fiche du client. Confirme-le-lui sans citer de nom technique.',
  champ_fixe: 'C’est enregistré sur la fiche du client.',
};

export const VARIABLE_VALEUR = 'valeur';

/**
 * Les variables publiées dans le corps de l'outil chez Meta (`corpsOutilMeta` ne garde que les `modele`).
 * Une étiquette fixée ne demande rien ; un champ demande sa valeur, avec la liste permise quand il y en a une.
 */
export function variablesPourMeta(c: CibleMaison): VariableDeclaree[] {
  if (c.handler !== 'champ_fixe') return [];
  return [{
    nom: VARIABLE_VALEUR,
    type: 'string',
    origine: { type: 'modele' },
    requis: true,
    description: 'La valeur à enregistrer, telle que le client l’a donnée.',
    ...(c.valeurs.length > 0 ? { enum: c.valeurs } : {}),
  }];
}

const corpsChampSchema = z.object({ valeur: z.string().trim().min(1).max(500) });

/** La valeur que l'agent de Meta envoie pour un champ, validée contre la liste permise. */
export function lireValeurChamp(
  c: CibleChamp, corps: unknown,
): { ok: true; valeur: string } | { ok: false; erreur: string } {
  const r = corpsChampSchema.safeParse(corps);
  if (!r.success) return { ok: false, erreur: 'la valeur à enregistrer manque' };
  const valeur = r.data.valeur;
  if (c.valeurs.length > 0 && !c.valeurs.includes(valeur)) {
    return { ok: false, erreur: `valeur refusée : choisir parmi ${c.valeurs.join(', ')}` };
  }
  return { ok: true, valeur };
}
```

- [ ] **Step 4 : les tests passent**

Run : `npx vitest run tests/mba-outils-maison.test.ts` puis `npm run typecheck`
Attendu : PASS, aucune erreur de type.

- [ ] **Step 5 : mutation (sur une copie hors dépôt)**

Copier `src/mba/outils-maison.ts` dans le scratchpad, retirer `.strict()` du `tag_fixe` dans le dépôt, lancer le
test : le cas « clé en trop » doit tomber. Restaurer depuis la copie, relancer : PASS. Vérifier
`git diff src/mba/outils-maison.ts` vide par rapport à l'écriture du Step 3.

- [ ] **Step 6 : commit**

```bash
git add -- src/mba/outils-maison.ts tests/mba-outils-maison.test.ts
git commit --only src/mba/outils-maison.ts tests/mba-outils-maison.test.ts -m "feat(mba): le catalogue des gestes de l agent de Meta (tag et information)"
```

---

### Task 4 : le magasin des outils de l'agent de Meta

**Fichiers :**
- Modifier : `src/agent/catalog.pg.ts` (méthodes neuves, `listCatalogue`, `rattacherConsommateur`, `listToutes`)
- Modifier : `tests/integration/outils-maison-mba.integration.test.ts` (second `describe`)

**Interfaces :**
- Consomme : `CibleMaison`, `RISQUE_MAISON` (Task 3) ; `consommateurMba` ; `OutilComplet`, `RisqueOutil`.
- Produit (méthodes de `PgToolCatalog`) :
  - `listToutesConsommateur(tenantId: string, consommateur: string): Promise<OutilComplet[]>`
  - `ajouterMaisonPourMba(tenantId: string, phoneNumberId: string, outil: { name: string; title: string; description: string; nePasUtiliser: string; cible: CibleMaison }, parUtilisateur: string): Promise<OutilComplet | null>`
  - `patchMaisonPourMba(tenantId: string, phoneNumberId: string, outilId: string, patch: { name?: string; title?: string; description?: string; nePasUtiliser?: string; cible?: CibleMaison }): Promise<OutilComplet | null>`
  - `retirerDeMba(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'>`

- [ ] **Step 1 : les tests d'intégration (CI) du magasin**

Ajouter à `tests/integration/outils-maison-mba.integration.test.ts` :

```ts
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { consommateurMba, consommateurAgent } from '../../src/agent/consommateur';
import { NomOutilDejaPris } from '../../src/agent/catalog';

const PN = '1234840649713976';

describe.skipIf(!url)('le magasin des outils de l’agent de Meta', () => {
  let pool: Pool;
  let cat: PgToolCatalog;
  let tenantId = '';
  let userId = '';
  let agentId = '';
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    cat = new PgToolCatalog(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-magasin-maison-mba') returning id`)).rows[0]!.id;
    userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-maison-mba@e2e.test', 'admin', 'x') returning id`, [tenantId],
    )).rows[0]!.id;
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele) values ($1, 'Support', '{}'::jsonb, '', 'openai/gpt-4.1-mini') returning id`, [tenantId],
    )).rows[0]!.id;
  });
  afterAll(async () => {
    await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const nouvel = (name: string) => ({
    name, title: 'Marquer VIP', description: 'Appelle cet outil…', nePasUtiliser: 'Jamais sans demande.',
    cible: { handler: 'tag_fixe' as const, tag: 'vip' },
  });

  it('🔴 crée l’outil ET l’expose, actif, au nom de l’administrateur', async () => {
    const o = await cat.ajouterMaisonPourMba(tenantId, PN, nouvel('marquer_vip'), userId);
    expect(o).toMatchObject({ origin: 'mba', name: 'marquer_vip', actif: true, binding: { handler: 'tag_fixe', tag: 'vip' } });
    const listes = await cat.listToutesConsommateur(tenantId, consommateurMba(PN));
    expect(listes.map((x) => x.name)).toContain('marquer_vip');
  });

  it('🔴 il N’APPARAÎT PAS dans la bibliothèque proposée aux agents IA', async () => {
    expect((await cat.listCatalogue(tenantId)).map((x) => x.name)).not.toContain('marquer_vip');
  });

  it('🔴 il ne se rattache PAS à un agent IA, mais le MBA peut toujours être rattaché', async () => {
    const [o] = (await cat.listToutesConsommateur(tenantId, consommateurMba(PN))).filter((x) => x.name === 'marquer_vip');
    expect(await cat.rattacherConsommateur(tenantId, consommateurAgent(agentId), o!.id)).toBe(false);
  });

  it('modifie la cible et les mots, sans toucher au consentement', async () => {
    const [o] = (await cat.listToutesConsommateur(tenantId, consommateurMba(PN))).filter((x) => x.name === 'marquer_vip');
    const p = await cat.patchMaisonPourMba(tenantId, PN, o!.id, { title: 'Client VIP', cible: { handler: 'tag_fixe', tag: 'client_vip' } });
    expect(p).toMatchObject({ title: 'Client VIP', binding: { tag: 'client_vip' }, actif: true });
  });

  it('🔴 un nom déjà pris par un connecteur de l’espace est refusé', async () => {
    await pool.query(
      `insert into agent_tools (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, source_id, source_kind)
       select $1, 'http', 'add_tag', 'x', 'x', 'x', '[]', '{}', 'write', s.id, 'http'
         from (insert into agent_tool_sources (tenant_id, name, kind, base_url, auth_kind, status)
               values ($1, 'src', 'http', 'https://exemple.test', 'none', 'active') returning id) s`,
      [tenantId],
    );
    await expect(cat.ajouterMaisonPourMba(tenantId, PN, nouvel('add_tag'), userId)).rejects.toBeInstanceOf(NomOutilDejaPris);
  });

  it('🔴 retirer un outil maison le SUPPRIME ; retirer un connecteur partagé ne fait que le DÉTACHER', async () => {
    const [maison] = (await cat.listToutesConsommateur(tenantId, consommateurMba(PN))).filter((x) => x.name === 'marquer_vip');
    expect(await cat.retirerDeMba(tenantId, PN, maison!.id)).toBe('supprime');
    const connecteur = (await pool.query<{ id: string }>(`select id from agent_tools where tenant_id = $1 and name = 'add_tag'`, [tenantId])).rows[0]!.id;
    await cat.rattacherConsommateur(tenantId, consommateurMba(PN), connecteur);
    await cat.rattacherConsommateur(tenantId, consommateurAgent(agentId), connecteur);
    expect(await cat.retirerDeMba(tenantId, PN, connecteur)).toBe('detache');
    expect((await pool.query('select 1 from agent_tools where id = $1', [connecteur])).rowCount).toBe(1);
    expect(await cat.retirerDeMba(tenantId, PN, connecteur)).toBe('introuvable');
  });
});
```

Vérifier les colonnes exactes de `agent_tool_sources` avant d'écrire l'insertion :
`grep -n "insert into agent_tool_sources" tests/integration/outil-par-agent.integration.test.ts` et recopier
sa forme (le rapport de lecture la décrit : `kind 'http'`, `auth_kind 'none'`, `status 'active'`).

- [ ] **Step 2 : écrire les méthodes**

Dans `src/agent/catalog.pg.ts`, importer en tête :

```ts
import { RISQUE_MAISON, type CibleMaison } from '../mba/outils-maison';
```

Remplacer le corps de `listToutes` par une délégation, et ajouter `listToutesConsommateur` juste après :

```ts
  async listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]> {
    return this.listToutesConsommateur(tenantId, consommateurAgent(agentId));
  }

  /** Tous les outils d'un consommateur, actifs ou non, avec leurs champs d'écran. */
  async listToutesConsommateur(tenantId: string, consommateur: string): Promise<OutilComplet[]> {
    const res = await this.pool.query<LigneAdmin>(
      `select ${COLONNES_ADMIN} ${JOINTURE}
        where t.tenant_id = $1 and c.consommateur = $2
        order by t.name`,
      [tenantId, consommateur],
    );
    return res.rows.map(versComplet);
  }
```

Ajouter après `ajouterConnecteurPourMba` :

```ts
  /**
   * UN OUTIL MAISON DE L'AGENT DE META (migration 0162, spec 2026-09-21-outils-maison-mba § 6).
   *
   * 🔴 IL NAÎT EXPOSÉ ET ACTIF, AU NOM DE L'ADMINISTRATEUR, dans la même transaction. Il n'a pas d'autre
   * consommateur possible (`rattacherConsommateur` refuse un agent IA), donc un outil créé mais inactif ne
   * servirait à personne ; et `atc_actif_humain_chk` exige qu'un humain l'ait activé.
   *
   * ⚠️ `params` RESTE VIDE : ce que Meta envoie se dérive de la cible (`variablesPourMeta`), et le recopier ici
   * ferait une seconde vérité.
   */
  async ajouterMaisonPourMba(tenantId: string, phoneNumberId: string, outil: {
    name: string; title: string; description: string; nePasUtiliser: string; cible: CibleMaison;
  }, parUtilisateur: string): Promise<OutilComplet | null> {
    const consommateur = consommateurMba(phoneNumberId);
    return this.enTransaction(async (client) => {
      const res = await client.query<{ id: string }>(
        `insert into agent_tools
           (tenant_id, origin, name, title, description, ne_pas_utiliser, params, binding, risk, pour_agent_meta)
         values ($1, 'mba', $2, $3, $4, $5, '[]'::jsonb, $6::jsonb, $7, true)
         returning id`,
        [tenantId, outil.name, outil.title, outil.description, outil.nePasUtiliser,
          JSON.stringify(outil.cible), RISQUE_MAISON[outil.cible.handler]],
      ).catch(surNomDejaPris);
      const id = res.rows[0]?.id;
      if (!id) return null;
      await client.query(
        `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur, actif, active_par, active_le)
         values ($1, $2, $3, true, $4, now())`,
        [tenantId, id, consommateur, parUtilisateur],
      );
      return this.completAvecClient(client, tenantId, consommateur, id);
    });
  }

  /**
   * Corrige les mots ou la cible d'un outil maison de l'agent de Meta. `null` = pas un outil de CET agent.
   *
   * ⚠️ LE RISQUE SUIT LA CIBLE : il se recalcule quand elle change, jamais depuis le corps de la requête.
   */
  async patchMaisonPourMba(tenantId: string, phoneNumberId: string, outilId: string, patch: {
    name?: string; title?: string; description?: string; nePasUtiliser?: string; cible?: CibleMaison;
  }): Promise<OutilComplet | null> {
    const consommateur = consommateurMba(phoneNumberId);
    const res = await this.pool.query<{ id: string }>(
      `update agent_tools set
          name = coalesce($4, name), title = coalesce($5, title), description = coalesce($6, description),
          ne_pas_utiliser = coalesce($7, ne_pas_utiliser),
          binding = coalesce($8::jsonb, binding), risk = coalesce($9, risk),
          updated_at = now()
        where agent_tools.tenant_id = $1 and agent_tools.id = $3 and agent_tools.pour_agent_meta
          and exists (select 1 from agent_tool_consommateurs c
                       where c.tool_id = agent_tools.id and c.tenant_id = agent_tools.tenant_id
                         and c.consommateur = $2)
        returning id`,
      [tenantId, consommateur, outilId, patch.name ?? null, patch.title ?? null, patch.description ?? null,
        patch.nePasUtiliser ?? null, patch.cible ? JSON.stringify(patch.cible) : null,
        patch.cible ? RISQUE_MAISON[patch.cible.handler] : null],
    ).catch(surNomDejaPris);
    if (!res.rows[0]) return null;
    return this.complet(tenantId, consommateur, outilId);
  }

  /**
   * « SUPPRIMER » DEPUIS L'ONGLET DE L'AGENT DE META (spec § 9.1).
   *
   * 🔴 L'OUTIL N'EST RETIRÉ QU'À L'AGENT DE META. Un connecteur partagé avec un agent IA reste à cet agent
   * (`detache`) ; un outil qui n'a plus aucun consommateur part (`supprime`), sinon sa définition resterait
   * sans écran pour la voir, et son nom resterait pris. `agent_id is null` épargne une action d'agent IA qui
   * aurait été rattachée au MBA par l'ancienne route.
   */
  async retirerDeMba(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'> {
    const consommateur = consommateurMba(phoneNumberId);
    return this.enTransaction(async (client) => {
      const det = await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 and tool_id = $3',
        [tenantId, consommateur, outilId],
      );
      if ((det.rowCount ?? 0) === 0) return 'introuvable';
      const sup = await client.query(
        `delete from agent_tools t
          where t.tenant_id = $1 and t.id = $2 and t.agent_id is null
            and not exists (select 1 from agent_tool_consommateurs c where c.tool_id = t.id and c.tenant_id = t.tenant_id)`,
        [tenantId, outilId],
      );
      return (sup.rowCount ?? 0) > 0 ? 'supprime' : 'detache';
    });
  }
```

Dans `rattacherConsommateur`, remplacer la requête :

```ts
    // 🔴 UN OUTIL DE L'AGENT DE META NE S'OUVRE JAMAIS À UN AGENT IA (migration 0162) : son handler n'existe pas
    // chez eux, et le brancher ferait un outil offert qui refuse à chaque appel.
    const res = await this.pool.query(
      `insert into agent_tool_consommateurs (tenant_id, tool_id, consommateur)
       select $1, $2, $3
        where exists (select 1 from agent_tools
                       where id = $2 and tenant_id = $1 and (not pour_agent_meta or $3::text like 'mba:%'))
       on conflict (tool_id, consommateur) do nothing`,
      [tenantId, outilId, consommateur],
    );
```

Dans `listCatalogue`, ajouter après `and t.agent_id is null` :

```sql
          -- NI LES OUTILS DE L AGENT DE META (0162) : cette liste est celle que les agents IA peuvent brancher.
          and not t.pour_agent_meta
```

- [ ] **Step 3 : typecheck et tests unitaires existants**

Run : `npm run typecheck && npx vitest run tests/agent-catalog*.test.ts tests/http-agent-catalogue.test.ts`
Attendu : PASS (aucun test unitaire n'exerce le SQL ; le typecheck vérifie les signatures).

- [ ] **Step 4 : rayon de souffle, à relire avant le commit**

Chaque lecteur d'un outil d'espace (`agent_id is null`), listé par la lecture du code, et ce qu'il devient :
- `listCatalogue` (GET bibliothèque, `agentSetup.etatCourant`, `AgentOutils.tsx`, `api-agent-setup.ts`) : exclut les outils de l'agent de Meta. ✔
- `rattacherConsommateur` : refuse un agent IA sur un outil de l'agent de Meta. ✔
- `supprimerDefinition` : n'est plus appelé que par la route que le Task 7 retire ; rien à changer.
- `src/agent/mcp/store.pg.ts` `nomsPris` : lit tous les noms, donc évite aussi les collisions avec les outils de
  l'agent de Meta. Voulu, rien à changer.
- `src/agent/requetes.pg.ts` (compte `outils` d'une requête) et `src/agent/sources.pg.ts` (compteurs d'une
  source) : filtrent sur `request_id` / `source_id`, qu'un outil maison n'a pas. Rien à changer.
- `src/user/store.pg.ts` (départ d'un collaborateur) : réécrit `active_par` sur TOUTES les lignes de
  consentement, celles de l'agent de Meta comprises. Relire la requête pour le confirmer.
- `listActifsConsommateur` (relais, publication) : rendra désormais les outils maison ; les Tasks 5 et 6 les
  traitent. Jusque-là, les deux filtrent `origin !== 'http'` : aucun effet en production entre deux commits.

- [ ] **Step 5 : commit, puis la CI**

```bash
git commit --only src/agent/catalog.pg.ts tests/integration/outils-maison-mba.integration.test.ts -m "feat(mba): le magasin des outils de l agent de Meta, hors de la bibliotheque des agents IA"
git push origin main
```

Lire le run : `gh run list --limit 3`, puis `gh run view <id> --json jobs`. Le job `integration` doit être vert.

---

### Task 5 : le relais exécute un tag et une information

**Fichiers :**
- Créer : `src/mba/executer-maison.ts`, `tests/mba-executer-maison.test.ts`
- Modifier : `src/http/mba-relais.ts`, `tests/http-mba-relais.test.ts`, `src/index.ts` (dépendance `maison`)

**Interfaces :**
- Consomme : `lireCibleMaison`, `lireValeurChamp`, `REPONSE_MAISON`, `type CibleMaison` (Task 3).
- Produit :
  - `interface DepsMaison { poserTag(tenantId: string, waId: string, tag: string): Promise<void>; ecrireChamp(tenantId: string, waId: string, champ: string, valeur: string): Promise<void>; }` (le lot 3 ajoute `estBloque`, `envoyerBloc`, `lancerScenario`)
  - `type IssueMaison = { ok: true; reponse: string } | { ok: false; erreur: string }`
  - `executerOutilMaison(deps: DepsMaison, input: { tenantId: string; waId: string; cible: CibleMaison; corps: unknown }): Promise<IssueMaison>`
  - `MbaRelaisDeps.maison: DepsMaison` ; `outilsActifs` rend aussi `binding`.

- [ ] **Step 1 : les tests de l'exécution (ils échouent)**

`tests/mba-executer-maison.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { executerOutilMaison, type DepsMaison } from '../src/mba/executer-maison';

function faux() {
  const gestes: string[] = [];
  const deps: DepsMaison = {
    poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
    ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
  };
  return { deps, gestes };
}

describe('exécuter un geste de l’agent de Meta', () => {
  it('pose l’étiquette FIXÉE, pour le contact de l’en-tête', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: '33612345678', cible: { handler: 'tag_fixe', tag: 'vip' }, corps: { tag: 'autre' } });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('fiche du client') });
    // 🔴 le corps ne choisit PAS l'étiquette : c'est tout l'arbitrage « fixé d'avance ».
    expect(f.gestes).toEqual(['tag t1 33612345678 vip']);
  });
  it('écrit la valeur fournie dans le champ FIXÉ', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: [] }, corps: { valeur: 'Lyon', champ: 'autre' } });
    expect(r.ok).toBe(true);
    expect(f.gestes).toEqual(['champ t1 w ville=Lyon']);
  });
  it('🔴 une valeur refusée n’écrit RIEN', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] }, corps: { valeur: 'Lyon' } });
    expect(r.ok).toBe(false);
    expect(f.gestes).toEqual([]);
  });
});
```

- [ ] **Step 2 : lancer, constater l'échec**

Run : `npx vitest run tests/mba-executer-maison.test.ts`
Attendu : FAIL, module introuvable.

- [ ] **Step 3 : écrire l'exécution**

`src/mba/executer-maison.ts` :

```ts
import { REPONSE_MAISON, lireValeurChamp, type CibleMaison } from './outils-maison';

/**
 * EXÉCUTER UN GESTE DE L'AGENT DE META pour un contact (spec 2026-09-21-outils-maison-mba, § 3).
 *
 * 🔴 AUCUN GESTE N'EST RÉÉCRIT ICI : chaque dépendance est la fonction qui le fait déjà ailleurs (la pose d'un
 * tag des agents IA, l'écriture de champ du mini-CRM). Ce module ne fait que choisir laquelle, et traduire
 * l'issue en ce que l'agent de Meta lit.
 */
export interface DepsMaison {
  /** `creerPoserTagAgent` : pose, déclaration dans Contenus > Tags, `tag_added` si l'étiquette est nouvelle. */
  poserTag(tenantId: string, waId: string, tag: string): Promise<void>;
  ecrireChamp(tenantId: string, waId: string, champ: string, valeur: string): Promise<void>;
}

export type IssueMaison = { ok: true; reponse: string } | { ok: false; erreur: string };

export async function executerOutilMaison(
  deps: DepsMaison,
  input: { tenantId: string; waId: string; cible: CibleMaison; corps: unknown },
): Promise<IssueMaison> {
  const { tenantId, waId, cible } = input;
  switch (cible.handler) {
    case 'tag_fixe':
      await deps.poserTag(tenantId, waId, cible.tag);
      return { ok: true, reponse: REPONSE_MAISON.tag_fixe };
    case 'champ_fixe': {
      const lu = lireValeurChamp(cible, input.corps);
      if (!lu.ok) return { ok: false, erreur: lu.erreur };
      await deps.ecrireChamp(tenantId, waId, cible.champ, lu.valeur);
      return { ok: true, reponse: REPONSE_MAISON.champ_fixe };
    }
  }
}
```

- [ ] **Step 4 : les tests d'exécution passent**

Run : `npx vitest run tests/mba-executer-maison.test.ts`
Attendu : PASS.

- [ ] **Step 5 : les tests de la route (ils échouent)**

Dans `tests/http-mba-relais.test.ts` :
1. Ajouter à `monter()` une dépendance par défaut et un relevé des gestes :

```ts
  const gestes: string[] = [];
  // ... dans l'objet mbaRelais, avant `...over` :
    maison: {
      poserTag: async (t, w, tag) => { gestes.push(`tag ${t} ${w} ${tag}`); },
      ecrireChamp: async (t, w, champ, valeur) => { gestes.push(`champ ${t} ${w} ${champ}=${valeur}`); },
    },
  // ... et rendre { app, appels, gestes }
```

2. Ajouter, en fin de fichier, un `describe` :

```ts
const TAG = { id: 'o2', name: 'marquer_vip', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'tag_fixe', tag: 'vip' } };
const CHAMP = { id: 'o3', name: 'noter_ville', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris', 'Lyon'] } };
const ACTION_IA = { id: 'o4', name: 'mba_poser_tag', origin: 'mba' as const, requestId: null, timeoutMs: 5_000, maxBytes: 16_384,
  binding: { handler: 'poser_tag' } };

describe('les outils maison de l’agent de Meta', () => {
  const avec = (outils: unknown[]) => monter({
    outilsActifs: async (t, c) => (t === 't1' && c === 'mba:pn1' ? outils as never : []),
  });

  it('🔴 pose l’étiquette FIXÉE sur le contact de l’en-tête, sans rien appeler d’extérieur', async () => {
    const { app, appels, gestes } = avec([TAG]);
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ succes: true, reponse: expect.stringContaining('fiche du client') });
    expect(gestes).toEqual(['tag t1 33612345678 vip']);
    expect(appels).toHaveLength(0);
  });

  it('écrit la valeur envoyée par Meta dans le champ fixé', async () => {
    const { app, gestes } = avec([CHAMP]);
    const res = await poster(app, CLE_RELAIS, { valeur: 'Lyon' }, '+33612345678', 'o3');
    expect(res.json().succes).toBe(true);
    expect(gestes).toEqual(['champ t1 33612345678 ville=Lyon']);
  });

  it('🔴 une valeur hors liste est refusée en 200, avec la liste, et RIEN n’est écrit', async () => {
    const { app, gestes } = avec([CHAMP]);
    const res = await poster(app, CLE_RELAIS, { valeur: 'Marseille' }, '+33612345678', 'o3');
    expect(res.json()).toEqual({ succes: false, erreur: expect.stringContaining('Paris, Lyon') });
    expect(gestes).toEqual([]);
  });

  it('🔴 une action d’agent IA exposée au MBA n’est PAS exécutée (handler inconnu ici)', async () => {
    const { app, gestes } = avec([ACTION_IA]);
    const res = await poster(app, CLE_RELAIS, {}, '+33612345678', 'o4');
    expect(res.json()).toEqual({ succes: false, erreur: 'cet outil n’est pas proposé à l’agent de Meta' });
    expect(gestes).toEqual([]);
  });

  it('🔴 sans contact identifié, aucun geste', async () => {
    const { app, gestes } = avec([TAG]);
    const res = await poster(app, CLE_RELAIS, {}, null, 'o2');
    expect(res.json().succes).toBe(false);
    expect(gestes).toEqual([]);
  });

  it('🔴 l’appel est journalisé sous l’appelant `mba`, avec son issue', async () => {
    const ouverts: unknown[] = [];
    const clos: unknown[] = [];
    const { app } = monter({
      outilsActifs: async () => [TAG] as never,
      journal: { ouvrir: async (e: unknown) => { ouverts.push(e); return 'l1'; }, clore: async (e: unknown) => { clos.push(e); } } as never,
    });
    await poster(app, CLE_RELAIS, {}, '+33612345678', 'o2');
    expect(ouverts).toEqual([expect.objectContaining({ source: 'mba', origin: 'mba', toolId: 'o2', toolName: 'marquer_vip', sessionId: null })]);
    expect(clos).toEqual([expect.objectContaining({ id: 'l1', status: 'ok' })]);
  });
});
```

Run : `npx vitest run tests/http-mba-relais.test.ts`
Attendu : FAIL (typage de `maison` et branche absente).

- [ ] **Step 6 : la branche maison dans la route**

Dans `src/http/mba-relais.ts` :

1. Imports :

```ts
import { lireCibleMaison } from '../mba/outils-maison';
import { executerOutilMaison, type DepsMaison } from '../mba/executer-maison';
```

2. Dans `MbaRelaisDeps` : ajouter `'binding'` au `Pick` de `outilsActifs`, et la dépendance :

```ts
  /** Les gestes maison (tag, information), exécutés sans système tiers (spec 2026-09-21-outils-maison-mba). */
  maison: DepsMaison;
```

3. Remplacer l'étape 1 et insérer la branche maison après l'étape 2 (le contact) :

```ts
    const PAS_PROPOSE = 'cet outil n’est pas proposé à l’agent de Meta';
    // 1. L'OUTIL : un outil de CET espace, exposé ET actif pour SON agent de Meta. Deux familles : un appel de
    //    connecteur (`http`), ou un geste maison dont la cible se relit et se valide (`mba`). Une action d'agent
    //    IA exposée au MBA par l'ancienne route a un handler inconnu ici : refusée, jamais jouée.
    const pn = await deps.numeroDuTenant(tenant);
    const outil = pn === null
      ? undefined
      : (await deps.outilsActifs(tenant, consommateurMba(pn))).find((o) => o.id === req.params.outilId);
    if (!outil) return refus(PAS_PROPOSE);
    const cible = outil.origin === 'mba' ? lireCibleMaison(outil.binding) : null;
    const estConnecteur = outil.origin === 'http' && !!outil.requestId;
    if (cible === null && !estConnecteur) return refus(PAS_PROPOSE);
```

L'étape 2 (contact) reste telle quelle. Juste après elle :

```ts
    // 2 bis. UN GESTE MAISON : exécuté ici, journalisé comme un appel de connecteur (même table, même appelant).
    if (cible !== null) {
      if (cible.handler === 'champ_fixe' && corpsIllisible((req as { rawBody?: unknown }).rawBody)) {
        return refus('le corps de la requête n’est pas du JSON lisible');
      }
      const debut = Date.now();
      const ligne = await deps.journal.ouvrir({
        tenantId: tenant, sessionId: null, toolId: outil.id, toolName: outil.name, origin: 'mba',
        // ⚠️ Aucune valeur du client dans le journal : seule la CIBLE, que l'administrateur a fixée.
        argsRediges: { cible: cible.handler },
        source: 'mba',
      }).catch(() => null);
      let issue: Awaited<ReturnType<typeof executerOutilMaison>>;
      try {
        issue = await executerOutilMaison(deps.maison, { tenantId: tenant, waId, cible, corps: req.body });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-relais: geste ${outil.name} en échec :`, err instanceof Error ? err.message : err);
        issue = { ok: false, erreur: 'l’action n’a pas pu être faite, réessayez plus tard' };
      }
      if (ligne !== null) {
        await deps.journal.clore({
          tenantId: tenant, id: ligne, status: issue.ok ? 'ok' : 'refuse', dureeMs: Date.now() - debut,
          ...(issue.ok ? {} : { erreur: issue.erreur }),
        }).catch(() => {});
      }
      return issue.ok ? reply.code(200).send({ succes: true, reponse: issue.reponse }) : refus(issue.erreur);
    }
```

Puis l'étape 3 existante commence par `const requete = await deps.requete(tenant, outil.requestId!);` :
remplacer `outil.requestId` par une constante typée non nulle posée juste avant :

```ts
    const requestId = outil.requestId as string; // estConnecteur l'a garanti plus haut
```

⚠️ Ce `as` porte sur une valeur déjà vérifiée par `estConnecteur`, pas sur un payload externe. Si le typecheck le
permet, préférer un test explicite : `if (!outil.requestId) return refus(PAS_PROPOSE);` juste avant l'étape 3,
et garder `outil.requestId` tel quel.

- [ ] **Step 7 : les tests de la route passent**

Run : `npx vitest run tests/http-mba-relais.test.ts tests/mba-executer-maison.test.ts && npm run typecheck`
Attendu : PASS. Le typecheck signale `src/index.ts` : la dépendance `maison` manque (Step 8).

- [ ] **Step 8 : le câblage**

Dans `src/index.ts`, objet `mbaRelais` (vers la ligne 2522), ajouter :

```ts
          // Les gestes maison : les MÊMES fonctions que les agents IA et le mini-CRM, aucune réécrite ici.
          maison: {
            poserTag: workflowRuntime.poserTagDepuisAgent,
            ecrireChamp: async (t, waId, champ, valeur) => { await contactStore.mergeFieldsByPhone(t, waId, { [champ]: valeur }); },
          },
```

Run : `npm run typecheck && npm test`
Attendu : PASS.

- [ ] **Step 9 : mutation de la garde « fixé d'avance » (copie hors dépôt)**

Copier `src/mba/executer-maison.ts` dans le scratchpad ; dans le dépôt, remplacer `cible.tag` par
`String((input.corps as { tag?: string }).tag ?? cible.tag)` ; lancer `npx vitest run tests/mba-executer-maison.test.ts` :
le premier cas doit tomber (`autre` au lieu de `vip`). Restaurer depuis la copie, relancer : PASS.

- [ ] **Step 10 : commit**

```bash
git add -- src/mba/executer-maison.ts tests/mba-executer-maison.test.ts
git commit --only src/mba/executer-maison.ts tests/mba-executer-maison.test.ts src/http/mba-relais.ts tests/http-mba-relais.test.ts src/index.ts -m "feat(mba): le relais pose un tag et enregistre une information pour l agent de Meta"
```

---

### Task 6 : publier les outils maison chez Meta

**Fichiers :**
- Créer : `src/mba/outils-a-publier.ts`, `tests/mba-outils-a-publier.test.ts`
- Modifier : `src/index.ts` (`outilsPourMeta` délègue)

**Interfaces :**
- Consomme : `lireCibleMaison`, `variablesPourMeta` (Task 3) ; `OutilAPublier` (`src/mba/publication.ts`) ;
  `OutilDefini` ; `VariableDeclaree`.
- Produit : `outilsAPublier(actifs: readonly Pick<OutilDefini, 'id' | 'name' | 'description' | 'nePasUtiliser' | 'origin' | 'requestId' | 'binding'>[], requete: (id: string) => Promise<{ variables: VariableDeclaree[] } | null>): Promise<OutilAPublier[]>`

- [ ] **Step 1 : les tests (ils échouent)**

`tests/mba-outils-a-publier.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { outilsAPublier } from '../src/mba/outils-a-publier';
import { corpsOutilMeta } from '../src/mba/publication';

const base = { description: 'Appelle cet outil…', nePasUtiliser: 'Jamais.', requestId: null };

describe('ce qui part chez Meta', () => {
  it('🔴 un champ maison part avec UNE variable `valeur`, et ses valeurs permises dans la description', async () => {
    const [o] = await outilsAPublier(
      [{ ...base, id: 'o3', name: 'noter_ville', origin: 'mba', binding: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] } }],
      async () => null,
    );
    const corps = corpsOutilMeta(o!);
    expect(corps.request_definition.path).toBe('/outils/o3');
    expect(corps.request_definition.body).toMatchObject({ params: { valeur: { type: 'string', description: expect.stringContaining('Paris') } }, required: ['valeur'] });
  });
  it('un tag maison part SANS corps : l’agent ne fournit rien', async () => {
    const [o] = await outilsAPublier(
      [{ ...base, id: 'o2', name: 'marquer_vip', origin: 'mba', binding: { handler: 'tag_fixe', tag: 'vip' } }],
      async () => null,
    );
    expect(corpsOutilMeta(o!).request_definition).not.toHaveProperty('body');
  });
  it('🔴 un outil maison illisible, une action d’agent IA ou un MCP ne partent PAS', async () => {
    const r = await outilsAPublier([
      { ...base, id: 'a', name: 'casse', origin: 'mba', binding: { handler: 'tag_fixe' } },
      { ...base, id: 'b', name: 'mba_poser_tag', origin: 'mba', binding: { handler: 'poser_tag' } },
      { ...base, id: 'c', name: 'mcp', origin: 'mcp', binding: {} },
    ], async () => null);
    expect(r).toEqual([]);
  });
  it('un connecteur part avec les variables de sa requête, comme avant', async () => {
    const [o] = await outilsAPublier(
      [{ ...base, id: 'o1', name: 'add_tag', origin: 'http', requestId: 'rq1', binding: {} }],
      async (id) => (id === 'rq1' ? { variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' } }] } : null),
    );
    expect(o).toMatchObject({ id: 'o1', variables: [{ nom: 'user' }] });
  });
});
```

Vérifier d'abord que `corpsOutilMeta` s'importe bien de `../src/mba/publication` (le rapport de lecture le situe
là ; `src/http/mba-publication.ts` le réexporte).

- [ ] **Step 2 : lancer, constater l'échec**

Run : `npx vitest run tests/mba-outils-a-publier.test.ts`
Attendu : FAIL, module introuvable.

- [ ] **Step 3 : écrire le module**

`src/mba/outils-a-publier.ts` :

```ts
import type { OutilDefini } from '../agent/catalog';
import type { VariableDeclaree } from '../agent/requetes';
import type { OutilAPublier } from './publication';
import { lireCibleMaison, variablesPourMeta } from './outils-maison';

/**
 * CE QUE CHAQUE OUTIL EXPOSÉ À L'AGENT DE META DEVIENT CHEZ META (spec 2026-09-21-outils-maison-mba, § 8).
 *
 * 🔴 SORTI DE `src/index.ts` POUR ÊTRE TESTÉ : c'est la liste que la publication compare à Meta et que l'aperçu
 * montre, et un câblage ne se teste pas. Un outil qu'on ne sait pas lire ne part pas : publié, il serait appelé
 * et refusé à chaque fois.
 */
export async function outilsAPublier(
  actifs: readonly Pick<OutilDefini, 'id' | 'name' | 'description' | 'nePasUtiliser' | 'origin' | 'requestId' | 'binding'>[],
  requete: (id: string) => Promise<{ variables: VariableDeclaree[] } | null>,
): Promise<OutilAPublier[]> {
  const sortie: OutilAPublier[] = [];
  for (const o of actifs) {
    const commun = { id: o.id, name: o.name, description: o.description, nePasUtiliser: o.nePasUtiliser };
    if (o.origin === 'mba') {
      const cible = lireCibleMaison(o.binding);
      if (cible !== null) sortie.push({ ...commun, variables: variablesPourMeta(cible) });
      continue;
    }
    if (o.origin !== 'http' || !o.requestId) continue;
    const req = await requete(o.requestId);
    if (req) sortie.push({ ...commun, variables: req.variables });
  }
  return sortie;
}
```

Dans `src/index.ts`, remplacer le corps de `outilsPourMeta` :

```ts
  const outilsPourMeta = async (tenant: string, pn: string): Promise<OutilAPublier[]> =>
    outilsAPublier(
      await toolCatalog.listActifsConsommateur(tenant, consommateurMba(pn)),
      (id) => agentRequetes.parId(tenant, id),
    );
```

(importer `outilsAPublier` depuis `./mba/outils-a-publier`).

- [ ] **Step 4 : les tests passent, rien d'autre ne bouge**

Run : `npx vitest run tests/mba-outils-a-publier.test.ts tests/mba-publication.test.ts tests/http-mba-publication.test.ts tests/mba-appliquer-publication.test.ts && npm run typecheck`
Attendu : PASS.

- [ ] **Step 5 : commit**

```bash
git add -- src/mba/outils-a-publier.ts tests/mba-outils-a-publier.test.ts
git commit --only src/mba/outils-a-publier.ts tests/mba-outils-a-publier.test.ts src/index.ts -m "feat(mba): les outils maison se publient chez Meta sous le connecteur EngageMe"
```

---

### Task 7 : les routes de l'onglet « Outils »

**Fichiers :**
- Créer : `src/mba/vue-outils.ts`, `tests/mba-vue-outils.test.ts`
- Créer : `src/http/mba-outils.ts`, `tests/http-mba-outils.test.ts`
- Modifier : `src/server.ts`, `src/index.ts`, `src/http/agent-catalogue.ts`, `tests/http-agent-catalogue.test.ts`

**Interfaces :**
- Consomme : `lireCibleMaison`, `typeDeLaCible`, `TypeOutilMba`, `CibleMaison` (Task 3) ; méthodes du Task 4 ;
  `OutilComplet`, `OutilBibliotheque` ; `risqueSelonMethode`, `MethodeConnecteur` (`src/agent/http-cible.ts`) ;
  `scopeTenant`, `estUuid` (`src/http/scope.ts`) ; `NomOutilDejaPris`.
- Produit :
  - `src/mba/vue-outils.ts` : `type CibleVue`, `interface OutilMbaVue`, `interface ContexteVue`,
    `vueOutilMba(o: OutilComplet, ctx: ContexteVue): OutilMbaVue`
  - `src/http/mba-outils.ts` : `interface MbaOutilsDeps`, `registerMbaOutils(app, deps, garde)`,
    base `/tenants/:tenantId/mba-outils` : `GET` (liste), `POST` (créer), `PATCH /:outilId`, `DELETE /:outilId`.
  - Réponse `GET` : `{ outils: OutilMbaVue[]; phoneNumberId: string | null }`.

Les types de la vue (identiques côté web au Task 8) :

```ts
export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'inconnu' };
// le lot 3 ajoute { type: 'bloc'; ... } et { type: 'scenario'; ... }

export interface OutilMbaVue {
  id: string; name: string; title: string; description: string; nePasUtiliser: string;
  type: TypeOutilMba | 'inconnu';
  cible: CibleVue;
  /** Pourquoi la cible n'existe plus, ou `null`. Texte FR du serveur, affiché tel quel. */
  cibleManquante: string | null;
  /** Les agents IA qui partagent cet outil (connecteur seulement). */
  aussiUtilisePar: string[];
}

export interface ContexteVue {
  requetes: ReadonlyMap<string, { label: string }>;
  champs: ReadonlySet<string>;
  bibliotheque: ReadonlyMap<string, OutilBibliotheque>;
}
```

- [ ] **Step 1 : les tests de la vue (ils échouent)**

`tests/mba-vue-outils.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { vueOutilMba, type ContexteVue } from '../src/mba/vue-outils';
import type { OutilComplet } from '../src/agent/catalog';

const outil = (over: Partial<OutilComplet>): OutilComplet => ({
  id: 'o1', tenantId: 't1', origin: 'mba', name: 'n', description: 'd', nePasUtiliser: 'p', gestes: [], params: [],
  binding: {}, sourceId: null, requestId: null, nature: 'integre', outputPaths: [], risk: 'write', timeoutMs: 5000,
  maxBytes: 16384, autonome: false, mcpAnnonce: null, mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null,
  title: 'T', actif: true, activeLe: null, autonomeLe: null, ...over,
});
const ctx = (over: Partial<ContexteVue> = {}): ContexteVue => ({
  requetes: new Map([['rq1', { label: 'Poser une étiquette' }]]), champs: new Set(['ville']), bibliotheque: new Map(), ...over,
});

describe('la ligne d’un outil dans l’onglet', () => {
  it('un tag : son type et sa cible', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'tag_fixe', tag: 'vip' } }), ctx()))
      .toMatchObject({ type: 'tag', cible: { type: 'tag', tag: 'vip' }, cibleManquante: null });
  });
  it('🔴 un champ supprimé du mini-CRM est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ binding: { handler: 'champ_fixe', champ: 'code_postal', valeurs: [] } }), ctx());
    expect(v.cibleManquante).toContain('code_postal');
  });
  it('🔴 un connecteur dont l’appel a été supprimé est SIGNALÉ', () => {
    const v = vueOutilMba(outil({ origin: 'http', requestId: 'rq9' }), ctx());
    expect(v).toMatchObject({ type: 'connecteur', cible: { requeteId: 'rq9', libelle: null } });
    expect(v.cibleManquante).toContain('Connecteurs API');
  });
  it('🔴 un connecteur partagé NOMME les agents IA qui s’en servent', () => {
    const bibliotheque = new Map([['o1', {
      id: 'o1', name: 'n', title: 'T', description: 'd', nePasUtiliser: 'p', origin: 'http' as const, risk: 'write' as const,
      sourceId: 's', mcpNonActivable: null, mcpIndisponibleLe: null,
      consommateurs: [
        { cle: 'agent:a1', actif: true, agentId: 'a1', agentLabel: 'Support' },
        { cle: 'mba:pn1', actif: true, agentId: null, agentLabel: null },
      ],
    }]]);
    expect(vueOutilMba(outil({ origin: 'http', requestId: 'rq1' }), ctx({ bibliotheque })).aussiUtilisePar).toEqual(['Support']);
  });
  it('🔴 un outil maison illisible est montré comme tel, pas masqué', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'poser_tag' } }), ctx()))
      .toMatchObject({ type: 'inconnu', cibleManquante: expect.stringContaining('supprimez-le') });
  });
});
```

- [ ] **Step 2 : lancer, constater l'échec ; écrire la vue**

Run : `npx vitest run tests/mba-vue-outils.test.ts` → FAIL (module introuvable).

`src/mba/vue-outils.ts` :

```ts
import type { OutilComplet, OutilBibliotheque } from '../agent/catalog';
import { lireCibleMaison, typeDeLaCible, type TypeOutilMba } from './outils-maison';

/**
 * LA LIGNE D'UN OUTIL DANS L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9.1).
 *
 * 🔴 CE QUI MANQUE SE DIT : un champ supprimé, un appel supprimé, un outil illisible. Un outil dont la cible a
 * disparu reste publié chez Meta et refuse à chaque appel ; sans cette ligne rouge, personne ne le saurait.
 */
export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue {
  id: string; name: string; title: string; description: string; nePasUtiliser: string;
  type: TypeOutilMba | 'inconnu';
  cible: CibleVue;
  cibleManquante: string | null;
  aussiUtilisePar: string[];
}

export interface ContexteVue {
  requetes: ReadonlyMap<string, { label: string }>;
  champs: ReadonlySet<string>;
  bibliotheque: ReadonlyMap<string, OutilBibliotheque>;
}

export function vueOutilMba(o: OutilComplet, ctx: ContexteVue): OutilMbaVue {
  const base = { id: o.id, name: o.name, title: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser };
  if (o.origin === 'http' && o.requestId) {
    const req = ctx.requetes.get(o.requestId) ?? null;
    const aussiUtilisePar = (ctx.bibliotheque.get(o.id)?.consommateurs ?? [])
      .filter((c) => c.agentId !== null)
      .map((c) => c.agentLabel ?? 'un agent IA');
    return {
      ...base, type: 'connecteur',
      cible: { type: 'connecteur', requeteId: o.requestId, libelle: req?.label ?? null },
      cibleManquante: req ? null : 'l’appel de cet outil a été supprimé dans Connecteurs API',
      aussiUtilisePar,
    };
  }
  const cible = o.origin === 'mba' ? lireCibleMaison(o.binding) : null;
  if (cible === null) {
    return {
      ...base, type: 'inconnu', cible: { type: 'inconnu' },
      cibleManquante: 'l’agent de Meta ne peut pas appeler cet outil : supprimez-le', aussiUtilisePar: [],
    };
  }
  const type = typeDeLaCible(cible);
  switch (cible.handler) {
    case 'tag_fixe':
      return { ...base, type, cible: { type: 'tag', tag: cible.tag }, cibleManquante: null, aussiUtilisePar: [] };
    case 'champ_fixe':
      return {
        ...base, type, cible: { type: 'champ', champ: cible.champ, valeurs: cible.valeurs },
        cibleManquante: ctx.champs.has(cible.champ) ? null : `le champ « ${cible.champ} » n’existe plus dans le mini-CRM`,
        aussiUtilisePar: [],
      };
  }
}
```

Run : `npx vitest run tests/mba-vue-outils.test.ts` → PASS.

- [ ] **Step 3 : les tests des routes (ils échouent)**

`tests/http-mba-outils.test.ts`, monté comme `tests/http-agent-catalogue.test.ts` (vrai jeton signé dans
`beforeAll`, `h()` en fonction : un objet figé capturerait un jeton encore vide) :

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import { FakeQueue } from '../src/queue/fake';
import type { MbaOutilsDeps } from '../src/http/mba-outils';
import { NomOutilDejaPris, type OutilComplet } from '../src/agent/catalog';
import { risqueSelonMethode } from '../src/agent/http-cible';

/**
 * L'onglet « Outils » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 9).
 * 🔴 CE QUE CE FICHIER PROTÈGE : que la CIBLE et le RISQUE viennent du serveur et du catalogue, jamais du
 * navigateur ; que le numéro vienne du serveur ; que retirer DÉTACHE un connecteur partagé au lieu de le détruire.
 */
const TENANT = 't1';
const SECRET = 'test-secret';
const PN = '1234840649713976';
const REQ = '33333333-3333-4333-8333-333333333333';
const OUTIL = '22222222-2222-4222-8222-222222222222';
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
let adminTok = '';
beforeAll(async () => { adminTok = await signSession({ userId: 'u1', tenantId: TENANT, role: 'admin' }, SECRET); });
const h = (): { headers: Record<string, string> } => ({
  headers: { 'content-type': 'application/json', authorization: `Bearer ${adminTok}` },
});

const complet = (over: Partial<OutilComplet>): OutilComplet => ({
  id: OUTIL, tenantId: TENANT, origin: 'mba', name: 'marquer_vip', description: 'd', nePasUtiliser: 'p', gestes: [],
  params: [], binding: { handler: 'tag_fixe', tag: 'vip' }, sourceId: null, requestId: null, nature: 'integre',
  outputPaths: [], risk: 'write', timeoutMs: 5000, maxBytes: 16384, autonome: false, mcpAnnonce: null,
  mcpNonActivable: null, mcpIndisponibleLe: null, mcpVuLe: null, title: 'Marquer VIP', actif: true, activeLe: null,
  autonomeLe: null, ...over,
});

function monter(over: Partial<MbaOutilsDeps> = {}, numero: string | null = PN) {
  const gestes: Array<{ geste: string; args: unknown[] }> = [];
  const deps: MbaOutilsDeps = {
    numeroDuTenant: async () => numero,
    lister: async () => [complet({})],
    contexte: async () => ({ requetes: new Map(), champs: new Set(['ville']), bibliotheque: new Map() }),
    requete: async (_t, id) => (id === REQ ? {
      id: REQ, sourceId: 's1', methode: 'DELETE', variables: [
        { nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true },
        { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
      ],
    } : null),
    champs: async () => ['ville'],
    creerMaison: async (...args) => { gestes.push({ geste: 'creerMaison', args }); return { id: 'nouveau' }; },
    creerConnecteur: async (...args) => { gestes.push({ geste: 'creerConnecteur', args }); return { id: 'nouveau' }; },
    modifierMaison: async (...args) => { gestes.push({ geste: 'modifierMaison', args }); return { id: OUTIL }; },
    modifierConnecteur: async (...args) => { gestes.push({ geste: 'modifierConnecteur', args }); return { id: OUTIL }; },
    retirer: async (...args) => { gestes.push({ geste: 'retirer', args }); return 'supprime'; },
    ...over,
  };
  const app = buildServer({ queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, mbaOutils: deps });
  return { app, gestes };
}

const TEXTES = { name: 'marquer_vip', title: 'Marquer VIP', description: 'Appelle cet outil dès que le client le demande.', nePasUtiliser: 'Jamais sans demande.' };
const url = `/tenants/${TENANT}/mba-outils`;

describe('créer un outil de l’agent de Meta', () => {
  it('🔴 un tag devient un geste maison, au nom de l’utilisateur du JETON', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(201);
    expect(gestes).toEqual([{ geste: 'creerMaison', args: [TENANT, PN, { ...TEXTES, cible: { handler: 'tag_fixe', tag: 'vip' } }, 'u1'] }]);
  });

  it('🔴 le risque d’un connecteur est DÉRIVÉ de la méthode ; un `risk` dans le corps est refusé', async () => {
    const { app, gestes } = monter();
    const force = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, risk: 'read', cible: { type: 'connecteur', requeteId: REQ } } });
    expect(force.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'connecteur', requeteId: REQ } } });
    expect(res.statusCode).toBe(201);
    const [, , outil] = gestes[0]!.args as [string, string, Record<string, unknown>];
    // 🔴 Le MODÈLE ne voit que ce qu'il doit remplir : `ville` vient du mini-CRM, il n'est pas un paramètre.
    expect(outil).toMatchObject({ risk: risqueSelonMethode('DELETE'), requestId: REQ, sourceId: 's1', params: [{ name: 'ref', source: 'modele', required: true }] });
    expect((outil.params as unknown[]).length).toBe(1);
  });

  it('🔴 sans numéro connecté : 409 avec la raison, et RIEN n’est créé', async () => {
    const { app, gestes } = monter({}, null);
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(409);
    expect(gestes).toEqual([]);
  });

  it('🔴 un champ absent du mini-CRM est refusé en le nommant', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'champ', champ: 'code_postal', valeurs: [] } } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('code_postal');
    expect(gestes).toEqual([]);
  });

  it('🔴 un nom déjà pris rend 409 avec un message lisible', async () => {
    const { app } = monter({ creerMaison: async () => { throw new NomOutilDejaPris('espace'); } });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'tag', tag: 'vip' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('porte déjà ce nom');
  });
});

describe('modifier, retirer', () => {
  it('🔴 l’appel d’un connecteur ne se change pas (écart 1 du plan)', async () => {
    const { app, gestes } = monter({ lister: async () => [complet({ origin: 'http', requestId: REQ, binding: {} })] });
    const res = await app.inject({ method: 'PATCH', url: `${url}/${OUTIL}`, ...h(), payload: { cible: { type: 'connecteur', requeteId: REQ } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('créez un autre outil');
    expect(gestes).toEqual([]);
  });

  it('🔴 retirer un connecteur partagé le DÉTACHE : 204, et un outil inconnu rend 404', async () => {
    const { app } = monter({ retirer: async () => 'detache' });
    expect((await app.inject({ method: 'DELETE', url: `${url}/${OUTIL}`, ...h() })).statusCode).toBe(204);
    const { app: autre } = monter({ retirer: async () => 'introuvable' });
    expect((await autre.inject({ method: 'DELETE', url: `${url}/${OUTIL}`, ...h() })).statusCode).toBe(404);
  });

  it('🔴 sans jeton, la route REFUSE : scopeTenant échoue fermé', async () => {
    const { app, gestes } = monter();
    const res = await app.inject({ method: 'DELETE', url: `${url}/${OUTIL}` });
    expect([401, 403]).toContain(res.statusCode);
    expect(gestes).toEqual([]);
  });
});
```

Le tableau ci-dessous est la couverture attendue du fichier : chaque ligne sans code ci-dessus s'écrit sur le même
moule, avec son `expect` sur le statut, le corps et les `gestes` relevés.

| Cas | Ce qu'il vérifie |
|---|---|
| `GET` rend `{ outils, phoneNumberId }`, une ligne par outil de l'agent de Meta, avec `type` et `cible` | liste |
| `GET` sans numéro rend `{ outils: [], phoneNumberId: null }` | pas de 500 |
| `POST` tag : crée avec la cible `{ handler: 'tag_fixe', tag }`, au nom de l'utilisateur du jeton, rend 201 `{ id }` | création maison |
| `POST` champ : `valeurs` vides acceptées ; un champ inconnu du mini-CRM rend 422 avec son nom | validation de cible |
| 🔴 `POST` connecteur : le risque est DÉRIVÉ de la méthode, jamais accepté du corps (porté de « le risque est DÉRIVÉ ») | port |
| 🔴 `POST` connecteur : seules les variables `modele` deviennent des paramètres (porté de « le MODÈLE ne voit que… ») | port |
| 🔴 `POST` connecteur : crée ET active pour `mba:<pn>`, en un seul geste (porté de « crée l'outil ET l'expose ») | port |
| 🔴 `POST` sans numéro : 409 avec la raison, rien n'est créé (porté) | port |
| 🔴 `POST` connecteur sur une requête d'un autre espace : 404, rien n'est écrit (porté) | port |
| ⚠️ `POST` avec un nom technique mal formé : 400 (porté) | port |
| 🔴 `POST` avec un nom déjà pris : 409 avec le message de `NomOutilDejaPris` | collision |
| 🔴 `POST` avec un `type` inconnu ou une clé en trop dans `cible` : 400 | frontière |
| `PATCH` outil maison : mots et cible ; `PATCH` connecteur : mots seulement, une `cible` rend 400 « pour changer d'appel, créez un autre outil » | écart 1 |
| `PATCH` d'un outil qui n'est pas à l'agent de Meta : 404 | isolation |
| 🔴 `DELETE` : `supprime` et `detache` rendent 204 ; `introuvable` rend 404 (remplace « supprimer une définition encore rattachée rend 409 » : désormais on DÉTACHE au lieu de refuser, cas nommé dans le commit) | port |
| 🔴 sans jeton : 401/403 ; identifiant non UUID : 404 sans toucher au magasin (porté) | garde |
| 🔴 le numéro vient du serveur, jamais du corps (porté de « le NUMÉRO vient du serveur ») | port |

Table des cas retirés de `tests/http-agent-catalogue.test.ts` avec la route `PUT /:outilId/mba` : « cocher
RATTACHE ET ACTIVE », « décocher DÉTACHE », « un corps sans booléen rend 400 ». Ils n'ont plus d'objet : un outil
de l'agent de Meta naît exposé, et se retire par `DELETE`. Le dire dans le message de commit.

Run : `npx vitest run tests/http-mba-outils.test.ts` → FAIL (module et dépendance `mbaOutils` absents).

- [ ] **Step 4 : écrire le module de routes**

`src/http/mba-outils.ts` :

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { OutilComplet } from '../agent/catalog';
import { NomOutilDejaPris } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import { risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';
import { scopeTenant, estUuid } from './scope';
import type { CibleMaison } from '../mba/outils-maison';
import { vueOutilMba, type ContexteVue } from '../mba/vue-outils';

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9).
 *
 * 🔴 IL NE PARLE QUE DES OUTILS DE L'AGENT DE META. La bibliothèque de l'espace (`GET /agent-tools`) reste aux
 * agents IA ; l'ancien écran mélangeait les deux, c'est ce qui le rendait illisible (Julien, 2026-09-21).
 *
 * ⚠️ LE NUMÉRO VIENT DU SERVEUR, jamais du corps : c'est lui qui désigne l'agent de Meta de l'espace.
 */
export interface MbaOutilsDeps {
  numeroDuTenant(tenantId: string): Promise<string | null>;
  lister(tenantId: string, phoneNumberId: string): Promise<OutilComplet[]>;
  contexte(tenantId: string, outils: readonly OutilComplet[]): Promise<ContexteVue>;
  requete(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'id' | 'sourceId' | 'methode' | 'variables'> | null>;
  champs(tenantId: string): Promise<string[]>;
  creerMaison(tenantId: string, phoneNumberId: string, outil: TextesOutil & { cible: CibleMaison }, parUtilisateur: string): Promise<{ id: string } | null>;
  creerConnecteur(tenantId: string, phoneNumberId: string, outil: TextesOutil & {
    sourceId: string; requestId: string; params: unknown; risk: ReturnType<typeof risqueSelonMethode>;
  }, parUtilisateur: string): Promise<{ id: string } | null>;
  modifierMaison(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil> & { cible?: CibleMaison }): Promise<{ id: string } | null>;
  modifierConnecteur(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil>): Promise<{ id: string } | null>;
  retirer(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'>;
}

interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

const NOM = z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'nom technique au format [a-z0-9_], 64 caractères au plus');
const texte = (max: number) => z.string().trim().min(1).max(max);
const textes = { name: NOM, title: texte(120), description: texte(2000), nePasUtiliser: texte(2000) };

/** La cible SAISIE à l'écran. `connecteur` désigne un appel ; les autres deviennent un `binding` maison. */
const cibleSaisieSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(64) }).strict(),
  z.object({
    type: z.literal('champ'), champ: z.string().trim().min(1).max(64),
    valeurs: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  }).strict(),
  z.object({ type: z.literal('connecteur'), requeteId: z.string().uuid() }).strict(),
]);
type CibleSaisie = z.infer<typeof cibleSaisieSchema>;

const creationSchema = z.object({ ...textes, cible: cibleSaisieSchema }).strict();
const patchSchema = z.object({
  name: NOM.optional(), title: texte(120).optional(), description: texte(2000).optional(),
  nePasUtiliser: texte(2000).optional(), cible: cibleSaisieSchema.optional(),
}).strict();

function versCibleMaison(c: Exclude<CibleSaisie, { type: 'connecteur' }>): CibleMaison {
  switch (c.type) {
    case 'tag': return { handler: 'tag_fixe', tag: c.tag };
    case 'champ': return { handler: 'champ_fixe', champ: c.champ, valeurs: c.valeurs };
  }
}

export function registerMbaOutils(app: FastifyInstance, deps: MbaOutilsDeps, garde: Guard): void {
  const base = '/tenants/:tenantId/mba-outils';
  const opts = { preHandler: garde };
  const utilisateur = (req: unknown): string => (req as { auth?: { userId?: string } }).auth?.userId ?? '';
  const SANS_NUMERO = 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent de Meta à qui donner cet outil.';

  /** La cible d'un outil maison existe-t-elle ? `null` = oui, sinon la raison (422). */
  const cibleInvalide = async (tenant: string, c: CibleSaisie): Promise<string | null> => {
    if (c.type === 'champ' && !(await deps.champs(tenant)).includes(c.champ)) {
      return `le champ « ${c.champ} » n’existe pas dans le mini-CRM`;
    }
    return null;
  };

  const siNomPris = (err: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
    throw err;
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ outils: [], phoneNumberId: null });
    const outils = await deps.lister(tenant, pn);
    const ctx = await deps.contexte(tenant, outils);
    return reply.code(200).send({ outils: outils.map((o) => vueOutilMba(o, ctx)), phoneNumberId: pn });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const lu = creationSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: lu.error.issues[0]?.message ?? 'corps invalide' });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'création impossible sans utilisateur identifié' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const { cible, ...mots } = lu.data;
    try {
      if (cible.type === 'connecteur') {
        const requete = await deps.requete(tenant, cible.requeteId);
        if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
        // Le MODÈLE ne voit que ce qu'il doit remplir ; le risque se DÉRIVE de la méthode, jamais du navigateur.
        const params = requete.variables.filter((v) => v.origine.type === 'modele').map((v) => ({
          name: v.nom, type: v.type, source: 'modele' as const,
          ...(v.description ? { description: v.description } : {}),
          ...(v.requis ? { required: true } : {}),
          ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
        }));
        const cree = await deps.creerConnecteur(tenant, pn, {
          ...mots, sourceId: requete.sourceId, requestId: requete.id, params,
          risk: risqueSelonMethode(requete.methode as MethodeConnecteur),
        }, userId);
        if (!cree) return reply.code(404).send({ error: 'requête introuvable' });
        return reply.code(201).send({ id: cree.id });
      }
      const raison = await cibleInvalide(tenant, cible);
      if (raison !== null) return reply.code(422).send({ error: raison });
      const cree = await deps.creerMaison(tenant, pn, { ...mots, cible: versCibleMaison(cible) }, userId);
      if (!cree) return reply.code(422).send({ error: 'création refusée' });
      return reply.code(201).send({ id: cree.id });
    } catch (err) {
      return siNomPris(err, reply);
    }
  });

  app.patch<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const lu = patchSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: lu.error.issues[0]?.message ?? 'corps invalide' });
    if (Object.keys(lu.data).length === 0) return reply.code(400).send({ error: 'rien à corriger' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const outil = (await deps.lister(tenant, pn)).find((o) => o.id === req.params.outilId);
    if (!outil) return reply.code(404).send({ error: 'outil introuvable' });
    const { cible, ...mots } = lu.data;
    try {
      if (outil.origin === 'http') {
        // Écart assumé (plan, écart 1) : la définition d'un connecteur est partagée avec les agents IA.
        if (cible) return reply.code(400).send({ error: 'pour changer d’appel, créez un autre outil' });
        const fait = await deps.modifierConnecteur(tenant, pn, outil.id, mots);
        return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
      }
      if (cible?.type === 'connecteur') return reply.code(400).send({ error: 'un outil maison ne devient pas un connecteur' });
      if (cible) {
        const raison = await cibleInvalide(tenant, cible);
        if (raison !== null) return reply.code(422).send({ error: raison });
      }
      const fait = await deps.modifierMaison(tenant, pn, outil.id, { ...mots, ...(cible ? { cible: versCibleMaison(cible) } : {}) });
      return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
    } catch (err) {
      return siNomPris(err, reply);
    }
  });

  app.delete<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const issue = await deps.retirer(tenant, pn, req.params.outilId);
    return issue === 'introuvable' ? reply.code(404).send({ error: 'outil introuvable' }) : reply.code(204).send();
  });
}
```

⚠️ Vérifier que `risqueSelonMethode` est bien exporté par `src/agent/http-cible.ts` (l'import actuel de
`agent-catalogue.ts` le prouve), et que `Guard` vient de `../auth/middleware`.

- [ ] **Step 5 : registre, dépendances, câblage, retrait des anciennes routes**

`src/server.ts` :
- dans `ServerDeps`, à côté de `mbaPublication?` : `mbaOutils?: MbaOutilsDeps;` (import de type) ;
- dans `modulesDeRoutes`, après l'entrée `mbaPublication` :

```ts
    entree('mbaOutils', 'tenant', deps.mbaOutils, (app, d, g) => registerMbaOutils(app, d, g.admin)),
```

`src/index.ts`, à côté de `mbaPublication` :

```ts
      mbaOutils: {
        numeroDuTenant: (tenant) => repo.getTenantPhoneNumberId(tenant),
        lister: (tenant, pn) => toolCatalog.listToutesConsommateur(tenant, consommateurMba(pn)),
        contexte: async (tenant) => {
          const [requetes, champs, bibliotheque] = await Promise.all([
            agentRequetes.lister(tenant), fieldStore.list(tenant), toolCatalog.listCatalogue(tenant),
          ]);
          return {
            requetes: new Map(requetes.map((r) => [r.id, { label: r.label }])),
            champs: new Set(champs.map((f) => f.key)),
            bibliotheque: new Map(bibliotheque.map((o) => [o.id, o])),
          };
        },
        requete: (tenant, id) => agentRequetes.parId(tenant, id),
        champs: async (tenant) => (await fieldStore.list(tenant)).map((f) => f.key),
        creerMaison: (tenant, pn, outil, par) => toolCatalog.ajouterMaisonPourMba(tenant, pn, outil, par),
        // Deux gestes, comme l'ancienne route : créer, puis activer pour l'agent de Meta au nom de l'administrateur.
        creerConnecteur: async (tenant, pn, outil, par) => {
          const cree = await toolCatalog.ajouterConnecteurPourMba(tenant, pn, outil);
          if (!cree) return null;
          await toolCatalog.activerConsommateur(tenant, consommateurMba(pn), cree.id, true, par);
          return { id: cree.id };
        },
        modifierMaison: (tenant, pn, id, patch) => toolCatalog.patchMaisonPourMba(tenant, pn, id, patch),
        modifierConnecteur: (tenant, pn, id, patch) => toolCatalog.patchConsommateur(tenant, consommateurMba(pn), id, patch),
        retirer: (tenant, pn, id) => toolCatalog.retirerDeMba(tenant, pn, id),
      },
```

⚠️ Vérifier le nom de la méthode qui liste les requêtes d'un espace dans `PgRequeteStore`
(`grep -n "async lister\|async list" src/agent/requetes.pg.ts`) et l'utiliser. `listCatalogue` exclut les outils
de l'agent de Meta (Task 4) mais garde les connecteurs, ce qu'il faut pour « aussi utilisé par ».

`src/http/agent-catalogue.ts` : retirer les routes `PUT /:outilId/mba`, `POST /connecteur-mba`, `PATCH /:outilId`,
`DELETE /:outilId`, les dépendances devenues inutiles de `AgentCatalogueRouteDeps` (`supprimerDefinition`,
`numeroDuTenant`, `rattacherConsommateur`, `detacherConsommateur`, `activerConsommateur`, `creerPourMba`,
`patchPourMba`, `requetePourOutil`) et les imports orphelins. Ne garder que `GET`. Mettre à jour le JSDoc du
module (il ne porte plus que la bibliothèque, lue par les agents IA). Retirer de `src/index.ts` les dépendances
correspondantes de `agentCatalogue`. Dans `tests/http-agent-catalogue.test.ts`, ne garder que le `describe`
« la bibliothèque d'outils » moins ses cas `DELETE` (portés au Step 3).

- [ ] **Step 6 : tout passe**

Run : `npm run typecheck && npx vitest run tests/http-mba-outils.test.ts tests/mba-vue-outils.test.ts tests/http-agent-catalogue.test.ts tests/scope-tenant.test.ts && npm test`
Attendu : PASS. `tests/scope-tenant.test.ts` doit compter le module `mbaOutils` (monté un par un, avec sa garde).

- [ ] **Step 7 : `npm run auto-attaque`**

Run : `npm run auto-attaque`
Attendu : les quatre routes neuves inventoriées et refusées sans jeton, aucune régression.

- [ ] **Step 8 : commit**

```bash
git add -- src/mba/vue-outils.ts tests/mba-vue-outils.test.ts src/http/mba-outils.ts tests/http-mba-outils.test.ts
git commit --only src/mba/vue-outils.ts tests/mba-vue-outils.test.ts src/http/mba-outils.ts tests/http-mba-outils.test.ts src/server.ts src/index.ts src/http/agent-catalogue.ts tests/http-agent-catalogue.test.ts -m "feat(mba): les routes de l onglet Outils de l agent de Meta, les anciennes routes MBA partent

Cas portes vers tests/http-mba-outils.test.ts. Retires avec PUT /agent-tools/:id/mba : cocher, decocher, corps sans booleen (un outil de l agent de Meta nait expose et se retire par DELETE)."
```

---

### Task 8 : le client web et les aides pures de l'onglet

**Fichiers :**
- Créer : `web/lib/api-mba-outils.ts`, `web/lib/mba-outils.ts`, `web/lib/mba-outils.test.ts`
- Modifier : `web/lib/api-agent-tools.ts` (retrait de quatre fonctions mortes)

**Interfaces :**
- Consomme : `request` (`web/lib/http.ts`), `GestePublication`, `apercuPublicationMba`, `publierChezMeta`
  (`web/lib/api-agent-tools.ts`), `normaliserCodeSortie` (`web/lib/agent-sorties.ts`).
- Produit :
  - `api-mba-outils.ts` : types `TypeOutilMba`, `CibleVue`, `OutilMbaVue`, `CibleSaisie`, `TextesOutil` ;
    `listerOutilsMba(tenantId)`, `creerOutilMba(tenantId, corps)`, `modifierOutilMba(tenantId, id, patch)`,
    `retirerOutilMba(tenantId, id)`.
  - `mba-outils.ts` : `type EtatChezMeta = 'chez_meta' | 'a_envoyer' | 'inconnu'`,
    `etatsChezMeta(outils, gestes): Map<string, EtatChezMeta>`, `effacementsImprevus(gestes, attendus)`,
    `nomTechniqueDepuisTitre(titre)`, `TEXTES_PAR_TYPE`, `PLACEHOLDER`, `consigneIncomplete(texte)`.

- [ ] **Step 1 : les tests des aides (ils échouent)**

`web/lib/mba-outils.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { etatsChezMeta, effacementsImprevus, nomTechniqueDepuisTitre, consigneIncomplete, TEXTES_PAR_TYPE } from './mba-outils';
import type { OutilMbaVue } from './api-mba-outils';

const o = (id: string, name: string): OutilMbaVue => ({
  id, name, title: name, description: 'd', nePasUtiliser: 'p', type: 'tag', cible: { type: 'tag', tag: 'x' },
  cibleManquante: null, aussiUtilisePar: [],
});

describe('l’état chez Meta, ligne par ligne', () => {
  it('🔴 « À envoyer » quand le plan porte un geste sur CET outil', () => {
    const e = etatsChezMeta([o('1', 'a'), o('2', 'b')], [{ type: 'outil_modifier', nom: 'b' }]);
    expect(e.get('1')).toBe('chez_meta');
    expect(e.get('2')).toBe('a_envoyer');
  });
  it('🔴 TOUT est « À envoyer » quand le connecteur doit être renvoyé (clé révoquée)', () => {
    const e = etatsChezMeta([o('1', 'a')], [{ type: 'connecteur_modifier', nom: 'EngageMe' }]);
    expect(e.get('1')).toBe('a_envoyer');
  });
  it('« inconnu » quand Meta n’a pas pu être lu', () => {
    expect(etatsChezMeta([o('1', 'a')], null).get('1')).toBe('inconnu');
  });
});

describe('les effacements que personne n’a demandés', () => {
  it('🔴 ne remonte que ce qui n’est pas attendu', () => {
    const g = [{ type: 'outil_supprimer' as const, nom: 'a' }, { type: 'outil_supprimer' as const, nom: 'main_levee' }, { type: 'outil_creer' as const, nom: 'c' }];
    expect(effacementsImprevus(g, new Set(['a'])).map((x) => x.nom)).toEqual(['main_levee']);
  });
});

describe('le nom technique et les consignes', () => {
  it('se calcule depuis le titre', () => {
    expect(nomTechniqueDepuisTitre('Marquer client VIP !')).toBe('marquer_client_vip');
  });
  it('🔴 une consigne pré-remplie non complétée est signalée', () => {
    expect(consigneIncomplete(TEXTES_PAR_TYPE.tag.quand[0])).toBe(true);
    expect(consigneIncomplete('Appelle cet outil dès que le client demande un devis.')).toBe(false);
  });
});
```

Run : `cd web && npx vitest run lib/mba-outils.test.ts` → FAIL (modules introuvables).

- [ ] **Step 2 : écrire le client et les aides**

`web/lib/api-mba-outils.ts` :

```ts
import { request } from './http';

/** Miroir de `src/mba/vue-outils.ts` et `src/http/mba-outils.ts` (spec 2026-09-21-outils-maison-mba, § 9). */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

export type CibleVue =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string; libelle: string | null }
  | { type: 'inconnu' };

export interface OutilMbaVue {
  id: string; name: string; title: string; description: string; nePasUtiliser: string;
  type: TypeOutilMba | 'inconnu';
  cible: CibleVue;
  cibleManquante: string | null;
  aussiUtilisePar: string[];
}

export type CibleSaisie =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'connecteur'; requeteId: string };

export interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

const base = (tenantId: string): string => `/tenants/${tenantId}/mba-outils`;

export function listerOutilsMba(tenantId: string): Promise<{ outils: OutilMbaVue[]; phoneNumberId: string | null }> {
  return request(base(tenantId));
}
export function creerOutilMba(tenantId: string, corps: TextesOutil & { cible: CibleSaisie }): Promise<{ id: string }> {
  return request(base(tenantId), { method: 'POST', body: JSON.stringify(corps) });
}
export function modifierOutilMba(tenantId: string, id: string, patch: Partial<TextesOutil> & { cible?: CibleSaisie }): Promise<{ id: string }> {
  return request(`${base(tenantId)}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function retirerOutilMba(tenantId: string, id: string): Promise<void> {
  await request<void>(`${base(tenantId)}/${id}`, { method: 'DELETE' });
}
```

`web/lib/mba-outils.ts` :

```ts
import type { GestePublication } from './api-agent-tools';
import type { OutilMbaVue, TypeOutilMba } from './api-mba-outils';
import { normaliserCodeSortie } from './agent-sorties';

/**
 * LES AIDES PURES DE L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9).
 */
export type EtatChezMeta = 'chez_meta' | 'a_envoyer' | 'inconnu';

/**
 * L'état de chaque ligne, calculé par le PLAN de publication, jamais par un drapeau tenu à part (§ 9.2).
 * 🔴 Un connecteur à renvoyer (clé révoquée, adresse changée) rend TOUTES les lignes « À envoyer » : tous les
 * outils en dépendent, et sans ça aucun bouton ne permettrait de le réparer.
 */
export function etatsChezMeta(outils: readonly OutilMbaVue[], gestes: readonly GestePublication[] | null): Map<string, EtatChezMeta> {
  const etats = new Map<string, EtatChezMeta>();
  if (gestes === null) {
    for (const o of outils) etats.set(o.id, 'inconnu');
    return etats;
  }
  const connecteur = gestes.some((g) => g.type === 'connecteur_creer' || g.type === 'connecteur_modifier');
  const noms = new Set(gestes.filter((g) => g.type === 'outil_creer' || g.type === 'outil_modifier').map((g) => g.nom));
  for (const o of outils) etats.set(o.id, connecteur || noms.has(o.name) ? 'a_envoyer' : 'chez_meta');
  return etats;
}

/** Les effacements chez Meta que le geste en cours n'a pas demandés : eux seuls se font confirmer. */
export function effacementsImprevus(gestes: readonly GestePublication[], attendus: ReadonlySet<string>): GestePublication[] {
  return gestes.filter((g) => g.type.endsWith('supprimer') && !attendus.has(g.nom));
}

/** Le nom vu par l'agent de Meta, calculé depuis le titre (même règle que les codes de sortie). */
export function nomTechniqueDepuisTitre(titre: string): string {
  return normaliserCodeSortie(titre);
}

/** Le trou laissé dans une consigne pré-remplie : tant qu'il est là, la consigne n'est pas écrite. */
export const PLACEHOLDER = '[décrivez la situation]';
const PLACEHOLDER_EN = '[describe the situation]';

export function consigneIncomplete(texte: string): boolean {
  return texte.includes(PLACEHOLDER) || texte.includes(PLACEHOLDER_EN);
}

type Bilingue = [string, string];

/**
 * LES MOTS PAR TYPE D'OUTIL, dont les consignes pré-remplies (§ 1).
 * 🔴 DIRECTIVES, parce que c'est mesuré (2026-09-21) : une description vague perd face aux compétences de
 * l'agent de Meta, qui passe alors la main au lieu d'appeler l'outil.
 */
export const TEXTES_PAR_TYPE: Record<TypeOutilMba, { titre: Bilingue; badge: Bilingue; aide: Bilingue; quand: Bilingue; pasQuand: Bilingue }> = {
  tag: {
    titre: ['Poser un tag', 'Tag the contact'],
    badge: ['Tag', 'Tag'],
    aide: ['Une étiquette précise sur la fiche du client', 'A specific tag on the customer record'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Il sait déjà qui est le client : ne lui demande rien. Confirme-lui ensuite que c’est pris en compte. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. It already knows who the customer is: ask nothing. Then confirm it is taken into account. Do not hand over for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil si le client ne l’a pas demandé.', 'Do not call this tool if the customer did not ask for it.'],
  },
  champ: {
    titre: ['Enregistrer une information', 'Save a detail'],
    badge: ['Information', 'Detail'],
    aide: ['Un champ de la fiche, rempli par l’agent', 'A record field, filled by the agent'],
    quand: [
      `Appelle cet outil dès que le client te donne ${PLACEHOLDER}. Passe la valeur telle qu’il l’a donnée. Confirme-lui ensuite que c’est enregistré. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer gives you ${PLACEHOLDER_EN}. Pass the value as given. Then confirm it is saved. Do not hand over for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil tant que le client n’a pas donné l’information : ne l’invente jamais.', 'Do not call this tool until the customer has given the detail: never make it up.'],
  },
  bloc: {
    titre: ['Envoyer un bloc', 'Send a block'],
    badge: ['Bloc', 'Block'],
    aide: ['Un message d’un de vos scénarios', 'A message from one of your scenarios'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Le message part tout seul : n’écris rien de plus au client pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. The message is sent automatically: write nothing more for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil deux fois pour la même demande.', 'Do not call this tool twice for the same request.'],
  },
  scenario: {
    titre: ['Lancer un scénario', 'Start a scenario'],
    badge: ['Scénario', 'Scenario'],
    aide: ['Du début, puis la main revient à l’agent', 'From the start, then back to the agent'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Engage Me prend alors la conversation et te la rend à la fin : n’écris rien au client pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. Engage Me then takes the conversation and hands it back at the end: write nothing for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil si un parcours vient déjà d’être lancé pour cette demande.', 'Do not call this tool if a journey was just started for this request.'],
  },
  connecteur: {
    titre: ['Appeler un connecteur API', 'Call an API connector'],
    badge: ['Connecteur API', 'API connector'],
    aide: ['Un appel déclaré dans Connecteurs API', 'A call declared in API connectors'],
    quand: [
      `Appelle cet outil dès que le client ${PLACEHOLDER}. Il sait déjà qui est le client. Confirme-lui ensuite ce que la réponse indique. Ne passe pas la main pour cette demande.`,
      `Call this tool as soon as the customer ${PLACEHOLDER_EN}. It already knows who the customer is. Then tell them what the response says. Do not hand over for this request.`,
    ],
    pasQuand: ['N’appelle pas cet outil si le client ne l’a pas demandé.', 'Do not call this tool if the customer did not ask for it.'],
  },
};
```

⚠️ Le placeholder EN est inséré dans le texte FR ? Non : chaque langue porte le sien. Vérifier la cohérence :
`TEXTES_PAR_TYPE.tag.quand[0]` contient `PLACEHOLDER`, `[1]` contient `PLACEHOLDER_EN`.

`web/lib/api-agent-tools.ts` : supprimer `creerOutilPourMba`, `patchOutilMba`, `supprimerDefinitionOutil`,
`exposerOutilAuMba` (grep dans `web/` : plus aucun appelant une fois l'ancien écran parti au Task 9 ; faire ce
retrait au Task 9 si le build casse avant).

Run : `cd web && npx vitest run lib/mba-outils.test.ts` → PASS.

- [ ] **Step 3 : commit**

```bash
git add -- web/lib/api-mba-outils.ts web/lib/mba-outils.ts web/lib/mba-outils.test.ts
git commit --only web/lib/api-mba-outils.ts web/lib/mba-outils.ts web/lib/mba-outils.test.ts -m "feat(web): le client et les aides de l onglet Outils de l agent de Meta"
```

---

### Task 9 : le nouvel écran « Outils »

**Fichiers :**
- Créer : `web/components/mba-outils/OutilsMba.tsx`, `ChoixTypeOutil.tsx`, `FormulaireOutilMba.tsx`, `CiblesOutil.tsx`
- Modifier : `web/app/mba/parametres/page.tsx`, `web/app/outils/page.tsx`, `web/lib/api-agent-tools.ts`
- Supprimer : `web/components/BibliothequeOutils.tsx`
- Réécrire : `web/e2e/mba-onglet-outils.spec.ts`

**Interfaces :**
- Consomme : Task 8 ; `listTags` (`web/lib/api/scenarios.ts`), `listUserFields` (`web/lib/api/integrations.ts`),
  `listRequetes`, `RequeteApi` (`web/lib/api-agent-requetes.ts`), `inputCls` (`web/lib/ui.ts`), `useT`.
- Produit : `export function OutilsMba({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean })`.

**Testids (le e2e s'en sert) :** `mba-outils`, `mba-outils-ajouter`, `mba-outils-vide`, `mba-outils-erreur`,
`mba-outils-attente`, `mba-outil-${name}`, `mba-outil-type-${id}`, `mba-outil-cible-${id}`,
`mba-outil-manque-${id}`, `mba-outil-partage-${id}`, `mba-outil-etat-${id}`, `mba-outil-envoyer-${id}`,
`mba-outil-modifier-${id}`, `mba-outil-supprimer-${id}` ; choix : `mba-types`, `mba-type-${type}` ; formulaire :
`mba-form`, `mba-form-titre`, `mba-form-nom`, `mba-form-quand`, `mba-form-pasquand`, `mba-form-enregistrer`,
`mba-form-manque`, `mba-form-annuler`, `mba-form-erreur` ; cibles : `mba-cible-tag`, `mba-cible-tag-note`,
`mba-cible-champ`, `mba-cible-valeurs`, `mba-cible-appels`, `mba-cible-appel-${id}`, `mba-cible-appel-fixe`,
`mba-cible-valeurs-remplies`, `mba-cible-valeurs-demandees`.

- [ ] **Step 1 : réécrire le e2e (il échoue, l'écran n'existe pas)**

`web/e2e/mba-onglet-outils.spec.ts`. Garder l'import `mockMba, TENANT` de `./support/mba`. Un helper local
`monterOutils(page, { outils, gestes, requetes, tags, champs })` qui répond, dans `custom` :
`GET /tenants/${TENANT}/mba-outils` → `{ outils, phoneNumberId: 'PN1' }` ; `GET /mba-publication` →
`{ gestes, phoneNumberId: 'PN1' }` ; `POST /mba-publication` → `{ faits: [] }` (retenu sur une promesse quand le
test le demande) ; `GET /agent-requetes` → `{ requetes, champs: [], catalogue: {} }` ; `GET /tags` → `{ tags }` ;
`GET /user-fields` → `{ fields }` ; `POST`, `PATCH`, `DELETE /mba-outils` relevés dans un tableau et rendus 201
`{ id: 'nouveau' }` / 200 / 204.

Correspondance des cas avec l'ancien fichier (aucun perdu sans le dire) :

| Ancien cas | Nouveau cas |
|---|---|
| l'onglet Outils mène à la bibliothèque | 🔴 l'onglet mène à la liste des outils de l'agent de Meta, avec « Ajouter un outil » (`mba-outils`, `mba-outils-ajouter`, `mba-outil-suivi_commande`) |
| un outil MCP mort est lisible | **retiré** : un outil MCP ne peut pas être exposé à l'agent de Meta (Meta n'appelle que du HTTP). Remplacé par : 🔴 une cible manquante s'affiche en rouge (`mba-outil-manque-o1`) |
| l'onglet s'ouvre par l'adresse | l'onglet s'ouvre par `/mba/parametres?tab=outils` (`mba-outils`) |
| on choisit l'appel d'abord, Soumettre envoie | 🔴 Ajouter > Connecteur API : l'appel d'abord, les mots ensuite, Enregistrer crée PUIS publie (un POST `/mba-outils` avec `cible: { type: 'connecteur', requeteId }`, puis un POST `/mba-publication`) |
| Modifier ouvre les textes pré-remplis | 🔴 Modifier ouvre le formulaire pré-rempli ; Enregistrer envoie le PATCH PUIS publie |
| pendant l'envoi le bouton le dit, un second clic n'envoie rien | 🔴 « À envoyer » : pendant l'envoi, `mba-outils-attente` visible, un second clic (`force`) laisse un seul POST `/mba-publication` |
| choisir un appel montre ce qu'Engage Me remplit | 🔴 idem dans la cible connecteur (`mba-cible-valeurs-remplies`, `mba-cible-valeurs-demandees`) |
| Soumettre désactivé pendant un envoi | 🔴 « Enregistrer » désactivé pendant un envoi, et revient à sa fin |

Cas neufs :
- 🔴 « Ajouter un outil » montre les cinq types ; « Appeler un connecteur API » est désactivé avec le lien
  `/connecteurs` quand `agent-requetes` ne rend aucun appel ;
- 🔴 l'état par ligne : « Chez Meta » quand le plan est vide, « À envoyer » quand il porte `outil_modifier` sur
  ce nom ; tout « À envoyer » quand il porte `connecteur_modifier` ;
- 🔴 créer un tag : la cible part `{ type: 'tag', tag: 'vip' }`, le nom technique se calcule depuis le titre, et
  « Enregistrer » reste désactivé tant que la consigne garde `[décrivez la situation]` ;
- créer une information : le champ se choisit parmi `user-fields`, les valeurs permises une par ligne ;
- 🔴 supprimer : une confirmation, puis un DELETE, puis une publication SANS seconde confirmation pour cet outil ;
  mais une confirmation qui NOMME un autre effacement imprévu (`outil_supprimer` sur `main_levee`).

Run : `cd web && npx playwright test e2e/mba-onglet-outils.spec.ts`
Attendu : FAIL (les testids n'existent pas). ⚠️ Si le port 3000 est tenu par un serveur d'une autre session, le
dire et s'en remettre à la CI pour ce fichier.

- [ ] **Step 2 : `CiblesOutil.tsx`**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { listTags, listUserFields, type TagCount, type UserFieldDef } from '@/lib/api';
import { listRequetes, type RequeteApi } from '@/lib/api-agent-requetes';
import { inputCls } from '@/lib/ui';
import { useT } from '@/lib/i18n';

/**
 * LES CIBLES D'UN OUTIL DE L'AGENT DE META : ce que l'administrateur FIXE (spec 2026-09-21, § 9.4).
 * ⚠️ LECTURES DÉFENSIVES : une liste qu'on ne sait pas lire est VIDE, jamais fatale (leçon de l'ancien écran).
 */
export function CibleTag({ tenantId, valeur, onChange }: { tenantId: string; valeur: string; onChange: (v: string) => void }) {
  const t = useT();
  const [tags, setTags] = useState<TagCount[]>([]);
  useEffect(() => {
    let vivant = true;
    listTags(tenantId).then((r) => { if (vivant) setTags(Array.isArray(r?.tags) ? r.tags : []); }).catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <label className="text-xs text-ink-600">
      {t('Étiquette à poser', 'Tag to set')}
      <input className={`${inputCls} mt-1`} list="mba-tags" data-testid="mba-cible-tag" value={valeur}
        onChange={(e) => onChange(e.target.value)} placeholder="client_vip" />
      <datalist id="mba-tags">{tags.map((x) => <option key={x.tag} value={x.tag} />)}</datalist>
      <span className="mt-1 block text-[11px] text-ink-500" data-testid="mba-cible-tag-note">
        {t('Elle déclenche vos automations « tag ajouté ». Celles qui lancent un scénario attendent que l’agent de Meta rende la conversation : pour lancer un scénario, ajoutez plutôt un outil « Lancer un scénario ».',
          'It triggers your “tag added” automations. Those that start a scenario wait until Meta’s agent hands the conversation back: to start a scenario, add a “Start a scenario” tool instead.')}
      </span>
    </label>
  );
}

export function CibleChamp({ tenantId, champ, valeurs, onChange }: {
  tenantId: string; champ: string; valeurs: string[]; onChange: (champ: string, valeurs: string[]) => void;
}) {
  const t = useT();
  const [champs, setChamps] = useState<UserFieldDef[]>([]);
  useEffect(() => {
    let vivant = true;
    listUserFields(tenantId).then((r) => { if (vivant) setChamps(Array.isArray(r?.fields) ? r.fields : []); }).catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-ink-600">
        {t('Champ de la fiche', 'Record field')}
        <select className={`${inputCls} mt-1`} data-testid="mba-cible-champ" value={champ} onChange={(e) => onChange(e.target.value, valeurs)}>
          <option value="">{t('Choisir un champ', 'Pick a field')}</option>
          {champs.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </label>
      <label className="text-xs text-ink-600">
        {t('Valeurs permises, une par ligne (facultatif)', 'Allowed values, one per line (optional)')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="mba-cible-valeurs" value={valeurs.join('\n')}
          onChange={(e) => onChange(champ, e.target.value.split('\n').map((v) => v.trim()).filter((v) => v !== ''))} />
      </label>
    </div>
  );
}

export function CibleConnecteur({ tenantId, requeteId, fixe, onChoisir }: {
  tenantId: string; requeteId: string | null; fixe: boolean; onChoisir: (r: RequeteApi) => void;
}) {
  const t = useT();
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  useEffect(() => {
    let vivant = true;
    listRequetes(tenantId)
      .then((r) => { if (vivant) setRequetes(Array.isArray(r?.requetes) ? r.requetes : []); })
      .catch(() => { if (vivant) setRequetes([]); });
    return () => { vivant = false; };
  }, [tenantId]);
  if (requetes === null) return null;
  const choisie = requetes.find((r) => r.id === requeteId) ?? null;
  if (fixe) {
    return (
      <div className="flex flex-col gap-1" data-testid="mba-cible-appel-fixe">
        <p className="text-sm text-ink-800">{choisie?.label ?? t('Appel supprimé', 'Deleted call')}</p>
        <p className="text-[11px] text-ink-500">{t('Pour changer d’appel, créez un autre outil.', 'To change the call, create another tool.')}</p>
        {choisie && <ValeursDeLAppel requete={choisie} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1" data-testid="mba-cible-appels">
        {requetes.map((r) => (
          <li key={r.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${r.id === requeteId ? 'border-brand-400 bg-brand-50' : 'border-ink-200'}`}>
            <span className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm text-ink-800">{r.label}</span>
              <code className="text-[11px] text-ink-500">{r.methode} {r.chemin}</code>
            </span>
            <button type="button" data-testid={`mba-cible-appel-${r.id}`} onClick={() => onChoisir(r)}
              className="rounded-lg border border-ink-300 bg-white px-2 py-0.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
              {r.id === requeteId ? t('Choisi', 'Picked') : t('Choisir', 'Pick')}
            </button>
          </li>
        ))}
      </ul>
      {choisie && <ValeursDeLAppel requete={choisie} />}
    </div>
  );
}

/** Repris de l'ancien écran : qui fournit chaque valeur de l'appel. */
function ValeursDeLAppel({ requete }: { requete: RequeteApi }) {
  const t = useT();
  const remplies = requete.variables.filter((v) => v.origine.type !== 'modele').map((v) => v.nom);
  const demandees = requete.variables.filter((v) => v.origine.type === 'modele').map((v) => v.nom);
  if (remplies.length === 0 && demandees.length === 0) return null;
  return (
    <p className="text-xs text-ink-600">
      {remplies.length > 0 && (
        <span data-testid="mba-cible-valeurs-remplies">{t('Engage Me remplit lui-même : ', 'Engage Me fills in: ')}{remplies.join(', ')}.{' '}</span>
      )}
      {demandees.length > 0 && (
        <span data-testid="mba-cible-valeurs-demandees">{t('L’agent de Meta les obtient du client : ', 'Meta’s agent gets these from the customer: ')}{demandees.join(', ')}.</span>
      )}
    </p>
  );
}
```

⚠️ Vérifier que `listTags`, `listUserFields` et leurs types sont réexportés par `@/lib/api` (le rapport de
lecture le confirme : le barrel fait `export * from './api/scenarios'` et `./api/integrations`).

- [ ] **Step 3 : `ChoixTypeOutil.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listRequetes } from '@/lib/api-agent-requetes';
import type { TypeOutilMba } from '@/lib/api-mba-outils';
import { TEXTES_PAR_TYPE } from '@/lib/mba-outils';
import { useT } from '@/lib/i18n';

/** Les types proposés, dans l'ordre du croquis de Julien (2026-09-21). Le lot 3 ajoute bloc et scénario. */
export const TYPES_PROPOSES: readonly TypeOutilMba[] = ['tag', 'champ', 'connecteur'];

export function ChoixTypeOutil({ tenantId, onChoisir, onAnnuler }: {
  tenantId: string; onChoisir: (type: TypeOutilMba) => void; onAnnuler: () => void;
}) {
  const t = useT();
  const [appels, setAppels] = useState<number | null>(null);
  useEffect(() => {
    let vivant = true;
    listRequetes(tenantId)
      .then((r) => { if (vivant) setAppels(Array.isArray(r?.requetes) ? r.requetes.length : 0); })
      .catch(() => { if (vivant) setAppels(0); });
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-4" data-testid="mba-types">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink-900">{t('Quel outil ajouter ?', 'Which tool to add?')}</p>
        <button type="button" onClick={onAnnuler} className="text-xs text-ink-500 hover:underline">{t('Annuler', 'Cancel')}</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TYPES_PROPOSES.map((type) => {
          const x = TEXTES_PAR_TYPE[type];
          // 🔴 GRISÉ, PAS CACHÉ : un client sans appel doit apprendre que ça existe, et où le déclarer (§ 9.4).
          const indisponible = type === 'connecteur' && appels === 0;
          return (
            <div key={type} className={`rounded-xl border p-4 ${indisponible ? 'border-dashed border-ink-200 opacity-60' : 'border-ink-200 hover:border-brand-300 hover:bg-brand-50'}`}>
              <button type="button" disabled={indisponible || (type === 'connecteur' && appels === null)} data-testid={`mba-type-${type}`}
                onClick={() => onChoisir(type)} className="block w-full text-left disabled:cursor-not-allowed">
                <span className="block text-sm font-semibold text-ink-900">{t(x.titre[0], x.titre[1])}</span>
                <span className="mt-1 block text-xs text-ink-500">{t(x.aide[0], x.aide[1])}</span>
              </button>
              {indisponible && (
                <Link href="/connecteurs" className="mt-2 block text-xs text-brand-600 underline">
                  {t('Aucun appel déclaré : Tools > Connecteurs API', 'No call declared: Tools > API connectors')}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 4 : `FormulaireOutilMba.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { creerOutilMba, modifierOutilMba, type CibleSaisie, type OutilMbaVue, type TypeOutilMba } from '@/lib/api-mba-outils';
import { TEXTES_PAR_TYPE, consigneIncomplete, nomTechniqueDepuisTitre } from '@/lib/mba-outils';
import { CibleChamp, CibleConnecteur, CibleTag } from './CiblesOutil';
import { inputCls } from '@/lib/ui';
import { useT } from '@/lib/i18n';

/** La cible de départ : celle de l'outil modifié, ou une cible vide du type choisi. */
function cibleInitiale(type: TypeOutilMba, outil: OutilMbaVue | null): CibleSaisie | null {
  const c = outil?.cible;
  if (c?.type === 'tag') return { type: 'tag', tag: c.tag };
  if (c?.type === 'champ') return { type: 'champ', champ: c.champ, valeurs: c.valeurs };
  if (c?.type === 'connecteur') return { type: 'connecteur', requeteId: c.requeteId };
  if (type === 'tag') return { type: 'tag', tag: '' };
  if (type === 'champ') return { type: 'champ', champ: '', valeurs: [] };
  return null;
}

function cibleComplete(c: CibleSaisie | null): boolean {
  if (c === null) return false;
  if (c.type === 'tag') return c.tag.trim() !== '';
  if (c.type === 'champ') return c.champ !== '';
  return c.requeteId !== '';
}

/**
 * CRÉER OU MODIFIER UN OUTIL DE L'AGENT DE META (spec 2026-09-21, § 9.3 et § 9.4).
 *
 * 🔴 ENREGISTRER, C'EST ENVOYER : le parent publie après un succès. Le formulaire ne se referme que sur un
 * succès : le refermer sur un refus perdrait la saisie (défaut payé deux fois le 2026-09-15).
 */
export function FormulaireOutilMba({ tenantId, type, outil, envoiEnCours, onEnregistre, onAnnuler }: {
  tenantId: string; type: TypeOutilMba; outil: OutilMbaVue | null; envoiEnCours: boolean;
  onEnregistre: (nomsAttendus: Set<string>) => Promise<void>; onAnnuler: () => void;
}) {
  const t = useT();
  const textes = TEXTES_PAR_TYPE[type];
  const [cible, setCible] = useState<CibleSaisie | null>(() => cibleInitiale(type, outil));
  const [title, setTitle] = useState(outil?.title ?? '');
  const [name, setName] = useState(outil?.name ?? '');
  const [nomTouche, setNomTouche] = useState(outil !== null);
  const [description, setDescription] = useState(outil?.description ?? t(textes.quand[0], textes.quand[1]));
  const [nePasUtiliser, setNePasUtiliser] = useState(outil?.nePasUtiliser ?? t(textes.pasQuand[0], textes.pasQuand[1]));
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const changerTitre = (v: string): void => {
    setTitle(v);
    if (!nomTouche) setName(nomTechniqueDepuisTitre(v));
  };

  const manque: string | null =
    !cibleComplete(cible) ? t('Choisissez ce que fait l’outil.', 'Pick what the tool does.')
      : title.trim() === '' ? t('Donnez un titre lisible.', 'Give it a readable title.')
        : !/^[a-z0-9_]{1,64}$/.test(name) ? t('Un nom technique en minuscules, chiffres et tirets bas.', 'A technical name in lowercase, digits and underscores.')
          : description.trim() === '' || consigneIncomplete(description) ? t('Complétez « Quand l’appeler ».', 'Complete “When to call it”.')
            : nePasUtiliser.trim() === '' ? t('Dites quand NE PAS l’appeler.', 'Say when NOT to call it.')
              : busy ? t('Enregistrement en cours…', 'Saving…')
                : envoiEnCours ? t('Un envoi vers Meta est en cours : attendez qu’il se termine.', 'A send to Meta is running: wait for it to end.')
                  : null;

  const enregistrer = async (): Promise<void> => {
    if (manque !== null || cible === null) return;
    setBusy(true);
    setErreur(null);
    const mots = { name, title: title.trim(), description: description.trim(), nePasUtiliser: nePasUtiliser.trim() };
    try {
      if (outil === null) await creerOutilMba(tenantId, { ...mots, cible });
      // Un connecteur ne change pas d'appel (plan, écart 1) : sa cible ne part pas.
      else await modifierOutilMba(tenantId, outil.id, cible.type === 'connecteur' ? mots : { ...mots, cible });
      // L'ancien nom est ATTENDU aussi : renommer efface l'ancien outil chez Meta, et ce n'est pas une surprise.
      await onEnregistre(new Set([name, ...(outil ? [outil.name] : [])]));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Saving failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4" data-testid="mba-form">
      <p className="text-sm font-semibold text-ink-900">{t(textes.titre[0], textes.titre[1])}</p>
      {erreur !== null && <p className="text-xs text-coral" data-testid="mba-form-erreur">{erreur}</p>}

      {cible?.type === 'tag' && <CibleTag tenantId={tenantId} valeur={cible.tag} onChange={(tag) => setCible({ type: 'tag', tag })} />}
      {cible?.type === 'champ' && (
        <CibleChamp tenantId={tenantId} champ={cible.champ} valeurs={cible.valeurs} onChange={(champ, valeurs) => setCible({ type: 'champ', champ, valeurs })} />
      )}
      {type === 'connecteur' && (
        <CibleConnecteur tenantId={tenantId} requeteId={cible?.type === 'connecteur' ? cible.requeteId : null} fixe={outil !== null}
          onChoisir={(r) => {
            setCible({ type: 'connecteur', requeteId: r.id });
            if (title.trim() === '') changerTitre(r.label);
          }} />
      )}

      <label className="text-xs text-ink-600">
        {t('Titre', 'Title')}
        <input className={`${inputCls} mt-1`} data-testid="mba-form-titre" value={title} onChange={(e) => changerTitre(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Nom technique (vu par l’agent de Meta)', 'Technical name (seen by Meta’s agent)')}
        <input className={`${inputCls} mt-1`} data-testid="mba-form-nom" value={name}
          onChange={(e) => { setNomTouche(true); setName(e.target.value); }} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Quand l’appeler', 'When to call it')}
        <textarea className={`${inputCls} mt-1`} rows={3} data-testid="mba-form-quand" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="text-xs text-ink-600">
        {t('Quand NE PAS l’appeler', 'When NOT to call it')}
        <textarea className={`${inputCls} mt-1`} rows={2} data-testid="mba-form-pasquand" value={nePasUtiliser} onChange={(e) => setNePasUtiliser(e.target.value)} />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="mba-form-enregistrer" disabled={manque !== null} title={manque ?? ''} onClick={() => { void enregistrer(); }}
          className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
          {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer et envoyer à Meta', 'Save and send to Meta')}
        </button>
        {manque !== null && <span className="text-[11px] text-ink-500" data-testid="mba-form-manque">{manque}</span>}
        <button type="button" data-testid="mba-form-annuler" onClick={onAnnuler} className="text-xs text-ink-500 hover:underline">
          {t('Annuler', 'Cancel')}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 5 : `OutilsMba.tsx`**

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apercuPublicationMba, publierChezMeta, type GestePublication } from '@/lib/api-agent-tools';
import { listerOutilsMba, retirerOutilMba, type OutilMbaVue, type TypeOutilMba } from '@/lib/api-mba-outils';
import { TEXTES_PAR_TYPE, effacementsImprevus, etatsChezMeta } from '@/lib/mba-outils';
import { ChoixTypeOutil } from './ChoixTypeOutil';
import { FormulaireOutilMba } from './FormulaireOutilMba';
import { useT } from '@/lib/i18n';

type Mode = { vue: 'liste' } | { vue: 'choix' } | { vue: 'form'; type: TypeOutilMba; outil: OutilMbaVue | null };

/** Le nom du connecteur unique chez Meta : attendu dans tout effacement qui retire le dernier outil. */
const CONNECTEUR_RELAIS = 'EngageMe';

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 9 ; croquis de Julien).
 *
 * 🔴 L'ENVOI EN COURS SE LIT À L'INSTANT (`envoiRef`), PAS AU RENDU DU CLIC : revue finale du 2026-09-21. Et le
 * bouton qui envoie DIT qu'il envoie : un bouton muet sur une opération lente fabrique des doublons chez Meta
 * (Julien, 2026-09-18).
 */
export function OutilsMba({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const t = useT();
  const [outils, setOutils] = useState<OutilMbaVue[] | null>(null);
  const [gestes, setGestes] = useState<GestePublication[] | null>(null);
  const [etatsCharges, setEtatsCharges] = useState(false);
  const [mode, setMode] = useState<Mode>({ vue: 'liste' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const envoiRef = useRef(false);

  const chargerEtats = useCallback(async (): Promise<void> => {
    try {
      const r = await apercuPublicationMba(tenantId);
      setGestes(Array.isArray(r?.gestes) ? r.gestes : []);
    } catch {
      setGestes(null);
    } finally {
      setEtatsCharges(true);
    }
  }, [tenantId]);

  const charger = useCallback(async (): Promise<void> => {
    try {
      const r = await listerOutilsMba(tenantId);
      setOutils(Array.isArray(r?.outils) ? r.outils : []);
    } catch (e) {
      setOutils([]);
      setErreur(e instanceof Error ? e.message : t('Lecture impossible', 'Could not load'));
    }
    await chargerEtats();
  }, [tenantId, chargerEtats, t]);

  useEffect(() => { void charger(); }, [charger]);

  /** Envoie chez Meta tout ce qui attend. Seuls les effacements que ce geste n'a pas demandés se confirment. */
  const envoyer = async (attendus: ReadonlySet<string>): Promise<boolean> => {
    if (envoiRef.current) return false;
    envoiRef.current = true;
    setEnvoiEnCours(true);
    setErreur(null);
    try {
      const plan = (await apercuPublicationMba(tenantId)).gestes ?? [];
      if (plan.length === 0) return true;
      const imprevus = effacementsImprevus(plan, attendus);
      if (imprevus.length > 0) {
        const liste = imprevus.map((g) => `- ${g.nom}`).join('\n');
        if (!window.confirm(t(`Cet envoi va aussi SUPPRIMER chez Meta :\n\n${liste}\n\nContinuer ?`, `This will also DELETE at Meta:\n\n${liste}\n\nContinue?`))) return false;
      }
      await publierChezMeta(tenantId);
      return true;
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('L’envoi chez Meta a échoué.', 'Sending to Meta failed.'));
      return false;
    } finally {
      envoiRef.current = false;
      setEnvoiEnCours(false);
      await chargerEtats();
    }
  };

  const apresEnregistrement = async (nomsAttendus: Set<string>): Promise<void> => {
    setMode({ vue: 'liste' });
    await charger();
    const ok = await envoyer(new Set([...nomsAttendus, CONNECTEUR_RELAIS]));
    if (!ok) {
      setErreur((e) => e ?? t('L’outil est enregistré. L’envoi chez Meta n’a pas abouti : cliquez sur « À envoyer » pour réessayer.',
        'The tool is saved. Sending to Meta did not go through: click “To send” to retry.'));
    }
  };

  const supprimer = async (o: OutilMbaVue): Promise<void> => {
    if (!window.confirm(t(`Supprimer « ${o.title} » ? Il sera retiré chez Meta.`, `Delete “${o.title}”? It will be removed at Meta.`))) return;
    setErreur(null);
    try {
      await retirerOutilMba(tenantId, o.id);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('La suppression a échoué.', 'Deletion failed.'));
      return;
    }
    await charger();
    await envoyer(new Set([o.name, CONNECTEUR_RELAIS]));
  };

  if (outils === null) return null;
  // ⚠️ Tant que Meta n'a pas été lu, AUCUN état : afficher « Chez Meta » par défaut serait affirmer ce qu'on ignore.
  const etats = etatsCharges ? etatsChezMeta(outils, gestes) : null;

  return (
    <section data-testid="mba-outils" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">{t('Outils de l’agent de Meta', 'Meta’s agent tools')}</h1>
          <p className="text-sm text-ink-500">{t('Ce que l’agent de Meta peut faire pendant une conversation.', 'What Meta’s agent can do during a conversation.')}</p>
        </div>
        {isAdmin && mode.vue === 'liste' && (
          <button type="button" data-testid="mba-outils-ajouter" onClick={() => setMode({ vue: 'choix' })}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            {t('+ Ajouter un outil', '+ Add a tool')}
          </button>
        )}
      </div>

      {erreur !== null && <p className="text-xs text-coral" data-testid="mba-outils-erreur">{erreur}</p>}
      {envoiEnCours && (
        <p className="text-xs text-ink-500" data-testid="mba-outils-attente">
          {t('Envoi chez Meta : Meta répond en quelques secondes. N’appuyez pas une seconde fois.', 'Sending to Meta: it answers within seconds. Do not press again.')}
        </p>
      )}

      {mode.vue === 'choix' && (
        <ChoixTypeOutil tenantId={tenantId} onAnnuler={() => setMode({ vue: 'liste' })} onChoisir={(type) => setMode({ vue: 'form', type, outil: null })} />
      )}
      {mode.vue === 'form' && (
        <FormulaireOutilMba tenantId={tenantId} type={mode.type} outil={mode.outil} envoiEnCours={envoiEnCours}
          onEnregistre={apresEnregistrement} onAnnuler={() => setMode({ vue: 'liste' })} />
      )}

      {outils.length === 0 ? (
        <p className="text-sm text-ink-500" data-testid="mba-outils-vide">
          {t('Aucun outil pour l’instant. Ajoutez-en un : l’agent de Meta saura quand s’en servir.', 'No tool yet. Add one: Meta’s agent will know when to use it.')}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-2xl border border-ink-200 bg-white">
          {outils.map((o) => {
            const etat = etats === null ? 'chargement' : (etats.get(o.id) ?? 'inconnu');
            const badge = o.type === 'inconnu' ? ['Inconnu', 'Unknown'] : TEXTES_PAR_TYPE[o.type].badge;
            return (
              <li key={o.id} data-testid={`mba-outil-${o.name}`} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{o.title}</p>
                  <p className="truncate text-xs text-ink-500" data-testid={`mba-outil-cible-${o.id}`}>{libelleCible(o, t)}</p>
                  {o.cibleManquante !== null && <p className="text-xs text-coral" data-testid={`mba-outil-manque-${o.id}`}>{o.cibleManquante}</p>}
                  {o.aussiUtilisePar.length > 0 && (
                    <p className="text-[11px] text-ink-500" data-testid={`mba-outil-partage-${o.id}`}>
                      {t('Aussi utilisé par : ', 'Also used by: ')}{o.aussiUtilisePar.join(', ')}{t('. Le modifier le modifie pour eux aussi.', '. Editing it edits it for them too.')}
                    </p>
                  )}
                </div>
                <span className="justify-self-start rounded-md bg-ink-100 px-2 py-0.5 text-xs text-ink-700" data-testid={`mba-outil-type-${o.id}`}>{t(badge[0], badge[1])}</span>
                <span data-testid={`mba-outil-etat-${o.id}`}>
                  {etat === 'chargement' && <span className="text-xs text-ink-400">…</span>}
                  {etat === 'chez_meta' && <span className="text-xs text-mint-700">{t('✓ Chez Meta', '✓ At Meta')}</span>}
                  {etat === 'inconnu' && <span className="text-xs text-ink-400" title={t('Meta n’a pas pu être lu.', 'Meta could not be read.')}>?</span>}
                  {etat === 'a_envoyer' && (
                    <button type="button" data-testid={`mba-outil-envoyer-${o.id}`} disabled={envoiEnCours || !isAdmin}
                      title={t('Envoie chez Meta tout ce qui attend, pas seulement cet outil.', 'Sends everything pending to Meta, not only this tool.')}
                      onClick={() => { void envoyer(new Set()); }}
                      className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
                      {envoiEnCours ? t('Envoi…', 'Sending…') : t('À envoyer', 'To send')}
                    </button>
                  )}
                </span>
                {isAdmin && (
                  <span className="flex gap-3 text-xs">
                    <button type="button" data-testid={`mba-outil-modifier-${o.id}`} disabled={o.type === 'inconnu'}
                      onClick={() => { if (o.type !== 'inconnu') setMode({ vue: 'form', type: o.type, outil: o }); }}
                      className="text-ink-600 hover:underline disabled:opacity-40">{t('Modifier', 'Edit')}</button>
                    <button type="button" data-testid={`mba-outil-supprimer-${o.id}`} onClick={() => { void supprimer(o); }}
                      className="text-coral hover:underline">{t('Supprimer', 'Delete')}</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function libelleCible(o: OutilMbaVue, t: (fr: string, en?: string) => string): string {
  const c = o.cible;
  switch (c.type) {
    case 'tag': return t(`Tag : ${c.tag}`, `Tag: ${c.tag}`);
    case 'champ': return t(`Champ : ${c.champ}`, `Field: ${c.champ}`);
    case 'connecteur': return c.libelle ? t(`Appel : ${c.libelle}`, `Call: ${c.libelle}`) : t('Appel supprimé', 'Deleted call');
    case 'inconnu': return t('Format inconnu', 'Unknown format');
  }
}
```

⚠️ Vérifier que les couleurs `amber-*` et `mint-700` existent dans `web/tailwind.config.*` ; sinon prendre celles
d'un badge d'avertissement existant (`grep -rn "bg-amber\|text-mint" web/components | head`).

- [ ] **Step 6 : monter l'écran, rediriger `/outils`, retirer l'ancien**

`web/app/mba/parametres/page.tsx` : remplacer l'import de `BibliothequeOutils` par
`import { OutilsMba } from '@/components/mba-outils/OutilsMba';` et la ligne de l'onglet par
`{onglet === 'outils' && <OutilsMba tenantId={tenantId} isAdmin={isAdmin} />}`.

`web/app/outils/page.tsx` (même forme que `app/dashboard/erreurs/page.tsx`) :

```tsx
'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';

/** `/outils` reste servie pour les liens déjà partagés, et renvoie vers l'onglet de l'agent de Meta. */
export default function OutilsRedirection() {
  const router = useRouter();
  const t = useT();
  useEffect(() => { router.replace('/mba/parametres?tab=outils'); }, [router]);
  return (
    <p className="p-6 text-sm text-ink-500" data-testid="outils-redirection">
      {t('Les outils de l’agent de Meta ont déménagé dans Meta Business Agent > Paramètres > Outils.',
        'Meta’s agent tools moved to Meta Business Agent > Settings > Tools.')}
    </p>
  );
}
```

`web/lib/nav.test.ts:197` whiteliste `'outils-espace'` : l'entrée reste dans l'union `Tab` d'`AppShell`, plus
aucune page ne la porte. La retirer de l'union ET de la liste blanche, et vérifier que `npm test` du web passe.

Supprimer `web/components/BibliothequeOutils.tsx` (`git rm`), et dans `web/lib/api-agent-tools.ts` les quatre
fonctions `creerOutilPourMba`, `patchOutilMba`, `supprimerDefinitionOutil`, `exposerOutilAuMba` (grep : plus
aucun appelant).

- [ ] **Step 7 : build, tests, e2e**

```bash
cd web && npx tsc --noEmit && npx vitest run && npm run build && npx playwright test e2e/mba-onglet-outils.spec.ts e2e/agents-outils.spec.ts
```

Attendu : tout vert. Chaque cas du tableau du Step 1 passe.

- [ ] **Step 8 : regarder l'écran (une fois)**

Lancer la console en local avec le mock e2e ou contre l'API locale, ouvrir `/mba/parametres?tab=outils`,
prendre une capture de la liste et du choix de type, et la comparer au croquis. Corriger en une passe.

- [ ] **Step 9 : mutation du e2e « un seul envoi » (copie hors dépôt)**

Copier `OutilsMba.tsx` dans le scratchpad ; retirer `if (envoiRef.current) return false;` dans le dépôt ; le cas
« un second clic laisse un seul POST » doit tomber. Restaurer, relancer : PASS.

- [ ] **Step 10 : commit**

```bash
git add -- web/components/mba-outils/OutilsMba.tsx web/components/mba-outils/ChoixTypeOutil.tsx web/components/mba-outils/FormulaireOutilMba.tsx web/components/mba-outils/CiblesOutil.tsx
git rm --cached web/components/BibliothequeOutils.tsx
git commit --only web/components/mba-outils web/components/BibliothequeOutils.tsx web/app/mba/parametres/page.tsx web/app/outils/page.tsx web/lib/api-agent-tools.ts web/lib/nav.test.ts web/components/AppShell.tsx web/e2e/mba-onglet-outils.spec.ts -m "feat(web): l onglet Outils de l agent de Meta refait, une liste claire et un bouton Ajouter

Cas e2e conserves ou remplaces nommement (table du plan, Task 9). Retire : l outil MCP mort, un outil MCP ne pouvant plus etre expose a l agent de Meta."
git push origin main
```

Lire le run CI (`gh run view <id> --json jobs`) : unitaires, intégration et e2e verts.

---

### Task 10 : documentation du lot 2, `/revue`, défauts voisins

**Fichiers :** `features.md`, `documentation.md`, `wip.md`, `todo.md`.

- [ ] **Step 1 : `/revue` sur le diff du lot 2** (`git diff <commit avant le Task 2>..HEAD -- . ':!*.md'`), rayon
  de souffle compris ; corriger les 🔴 et les 🟡, commit par correctif.
- [ ] **Step 2 : `features.md`** : section du Meta Business Agent, l'onglet « Outils » refait (liste, Ajouter,
  « À envoyer », enregistrer envoie), et les deux premiers outils maison (live après déploiement).
- [ ] **Step 3 : `documentation.md`** : les invariants, au présent : un outil maison de l'agent de Meta vit dans
  `agent_tools` avec `pour_agent_meta` (0162), n'est jamais proposé ni rattachable à un agent IA, se publie sous
  `EngageMe` ; le relais distingue `http` et `mba` et ne joue que les handlers de `src/mba/outils-maison.ts`.
- [ ] **Step 4 : `todo.md`** : les deux défauts du § 12 de la spec (`envoyer_bloc` des agents IA : liste vide =
  tout bloc ; pas de contrôle de fenêtre), avec leur fichier (`src/workflow/executor.ts`, `envoyerBlocDepuisAgent`).
  Retirer l'item « L'écran ne dit pas si un outil est déjà chez Meta » (fait).
- [ ] **Step 5 : `wip.md`** : le chantier, lot 2 fait, lots 3 et 4 à venir.
- [ ] **Step 6 : commit** (relire le diff de chaque fichier partagé avant) :

```bash
git commit --only features.md documentation.md wip.md todo.md -m "docs(mba): les outils maison de l agent de Meta, lot 2"
```

### Task 11 : premier déploiement (lot 2)

- [ ] **Step 1 :** `gh run list --limit 5` puis `gh run view <id> --json jobs` sur le dernier commit de code : tout vert.
- [ ] **Step 2 :** `/revue-finale` (skill), jusqu'à l'attestation `COUVERT` sur `HEAD`.
- [ ] **Step 3 :** sur le VPS, dans l'ordre (0162 AJOUTE des colonnes que le code écrit, donc AVANT) :

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@$VPS "cd /home/ubuntu/mba && git pull && sudo docker compose build mba-api && sudo docker compose run --rm --no-deps mba-api npm run migrate"
```

- [ ] **Step 4 : relire la base, point par point** : `schema_migrations` rend 0162 en tête ; `pour_agent_meta` est
  `boolean NOT NULL DEFAULT false` ; `accuse_le` est `timestamptz` nullable sans défaut ; les deux CHECK ont leur
  définition exacte (`pg_get_constraintdef`) ; zéro outil ne porte le drapeau ; zéro message ne porte d'accusé.
- [ ] **Step 5 :** `sudo docker compose up -d --build mba-api mba-worker`, puis contrôle PUBLIC : `curl -s -o /dev/null -w "%{http_code}" https://api.messagingme.app/health` = 200. En cas de 502 :
  `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.
- [ ] **Step 6 : `CLAUDE.md`** : « Dernière appliquée : 0162 … Prochaine libre = 0163 », avec ce qui a été relu
  (Step 4). Commit `--only CLAUDE.md`.
- [ ] **Step 7 : essai réel, premier temps** (section « Méthode de livraison »), avec Julien. Consigner le
  résultat dans `wip.md` et `docs/JOURNAL-TECHNIQUE.md`.

---

## Lot 3 : envoyer un bloc, lancer un scénario

### Task 12 : le bloc seul, et les deux handlers

**Fichiers :**
- Modifier : `src/workflow/node-list.ts` (exporter `CODE_BLOC_RE`), `src/mba/outils-maison.ts`,
  `tests/mba-outils-maison.test.ts`

**Interfaces :**
- Produit :
  - `CODE_BLOC_RE` exporté de `src/workflow/node-list.ts` (l'actuel `NOD_RE`, renommé et exporté).
  - `HANDLERS_MAISON_MBA` gagne `'bloc_fixe'`, `'scenario_fixe'` ; `cibleMaisonSchema` gagne
    `{ handler: 'bloc_fixe'; workflowId: uuid; code: CODE_BLOC_RE }` et `{ handler: 'scenario_fixe'; workflowId: uuid }` ;
    `typeDeLaCible` rend `'bloc'` / `'scenario'` ; `RISQUE_MAISON` : `'irreversible'` pour les deux ;
    `REPONSE_MAISON` : textes du § 7.
  - `blocSeul(graph: WorkflowGraph, code: string): { ok: true; noeudId: string; graphe: WorkflowGraph; modele: boolean } | { ok: false; raison: string }`
  - `interface BlocPropose { workflowId: string; scenario: string; code: string; nom: string; type: string; envoyable: boolean; raison: string | null }`
  - `blocsProposables(workflows: readonly { id: string; name: string; graph: WorkflowGraph }[]): BlocPropose[]`

- [ ] **Step 1 : les tests du bloc seul (ils échouent)**

Ajouter à `tests/mba-outils-maison.test.ts` :

```ts
import { blocSeul, blocsProposables } from '../src/mba/outils-maison';
import type { WorkflowGraph } from '../src/workflow/graph';

const CODE = (n: number) => `nod_abc_${String(n).padStart(26, '0').replace(/0/g, 'A')}`;
const noeud = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as WorkflowGraph['nodes'][number];
const g = (nodes: WorkflowGraph['nodes'], edges: Array<[string, string]> = []): WorkflowGraph =>
  ({ nodes, edges: edges.map(([source, target], i) => ({ id: `e${i}`, source, target })) });

describe('envoyer un bloc SEUL', () => {
  const texte = noeud('n1', 'quick_message', { code: CODE(1), name: 'Brochure', body: 'Voici la brochure', quickReplies: [] });
  const suite = noeud('n2', 'quick_message', { code: CODE(2), body: 'Et ceci', quickReplies: [] });
  const question = noeud('n3', 'quick_message', { code: CODE(3), body: 'Oui ou non ?', quickReplies: [{ text: 'Oui' }] });

  it('🔴 le bloc part SANS ce qui le suit dans le scénario', () => {
    const r = blocSeul(g([texte, suite], [['n1', 'n2']]), CODE(1));
    expect(r.ok).toBe(true);
    expect(r.ok && r.graphe).toEqual({ nodes: [texte], edges: [] });
  });
  it('🔴 un bloc qui attend une réponse est refusé, en renvoyant vers « Lancer un scénario »', () => {
    const r = blocSeul(g([question]), CODE(3));
    expect(r).toEqual({ ok: false, raison: expect.stringContaining('Lancer un scénario') });
  });
  it('un code inconnu ou mal formé est refusé', () => {
    expect(blocSeul(g([texte]), CODE(9)).ok).toBe(false);
    expect(blocSeul(g([texte]), '').ok).toBe(false);
  });
  it('un bloc qui n’envoie rien (un tag) est refusé', () => {
    expect(blocSeul(g([noeud('n4', 'tag', { code: CODE(4), tag: 'x' })]), CODE(4)).ok).toBe(false);
  });
  it('liste les blocs proposables avec leur raison', () => {
    const l = blocsProposables([{ id: '11111111-1111-4111-8111-111111111111', name: 'Accueil', graph: g([texte, question]) }]);
    expect(l.map((b) => [b.code, b.envoyable])).toEqual([[CODE(1), true], [CODE(3), false]]);
  });
});
```

⚠️ `CODE(n)` doit satisfaire `CODE_BLOC_RE` (`/^nod_[0-9a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/`) : `A` répété 26 fois
convient ; vérifier en lançant le test.

- [ ] **Step 2 : lancer, constater l'échec ; écrire**

Dans `src/workflow/node-list.ts` : renommer `NOD_RE` en `export const CODE_BLOC_RE` et remplacer ses usages.

Dans `src/mba/outils-maison.ts` :
- `HANDLERS_MAISON_MBA = ['tag_fixe', 'champ_fixe', 'bloc_fixe', 'scenario_fixe'] as const;`
- au schéma, deux options :

```ts
  z.object({ handler: z.literal('bloc_fixe'), workflowId: z.string().uuid(), code: z.string().regex(CODE_BLOC_RE) }).strict(),
  z.object({ handler: z.literal('scenario_fixe'), workflowId: z.string().uuid() }).strict(),
```

- `typeDeLaCible` : `case 'bloc_fixe': return 'bloc'; case 'scenario_fixe': return 'scenario';`
- `RISQUE_MAISON` : `bloc_fixe: 'irreversible', scenario_fixe: 'irreversible'` (un message parti ne se rappelle pas).
- `REPONSE_MAISON` :

```ts
  bloc_fixe: 'Le client vient de recevoir le message prévu, envoyé par Engage Me. N’ajoute rien pour cette demande.',
  scenario_fixe: 'Engage Me déroule maintenant un parcours avec le client, il en reçoit déjà les messages. N’écris rien pour cette demande : la conversation te reviendra à la fin.',
```

- et, en fin de fichier :

```ts
import { walk } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';
import { CODE_BLOC_RE, summarize } from '../workflow/node-list';

/** Les envois WhatsApp qu'un bloc seul peut porter. Un formulaire ou une question attendent toujours. */
const ENVOIS = new Set(['sendTemplate', 'sendQuickMessage']);

const RAISON_REPOS: Record<string, string> = {
  waiting: 'ce bloc attend une réponse du client : utilisez « Lancer un scénario »',
  agent_turn: 'ce bloc passe la main à un agent IA : utilisez « Lancer un scénario »',
  inbox: 'ce bloc remonte la conversation à un humain : utilisez « Lancer un scénario »',
  sleeping: 'ce bloc contient une attente : utilisez « Lancer un scénario »',
  rcs_send: 'ce bloc envoie en RCS, l’agent de Meta parle en WhatsApp',
};

/**
 * LE BLOC SEUL (spec § 3.3) : le bloc désigné, SANS ce qui le suit, et seulement s'il ne demande pas de réponse.
 *
 * 🔴 VÉRIFIÉ À LA CRÉATION ET À CHAQUE APPEL : le scénario peut avoir été modifié depuis. Le walk est pur et se
 * joue sur un graphe réduit au seul bloc ; `mbaActif: true` parce que l'agent de Meta est par définition allumé.
 * `modele` dit si tout ce qui part est un modèle, seul envoi possible hors de la fenêtre de 24 h.
 */
export function blocSeul(
  graph: WorkflowGraph, code: string,
): { ok: true; noeudId: string; graphe: WorkflowGraph; modele: boolean } | { ok: false; raison: string } {
  if (!CODE_BLOC_RE.test(code)) return { ok: false, raison: 'ce bloc n’existe plus dans le scénario' };
  const noeud = graph.nodes.find((n) => String(n.data.code ?? '') === code);
  if (!noeud) return { ok: false, raison: 'ce bloc n’existe plus dans le scénario' };
  const graphe: WorkflowGraph = { nodes: [noeud], edges: [] };
  const { actions, rest } = walk(graphe, noeud.id, undefined, { mbaActif: true });
  if (rest.status !== 'done') return { ok: false, raison: RAISON_REPOS[rest.status] ?? 'ce bloc ne peut pas partir seul' };
  const envois = actions.filter((a) => ENVOIS.has(a.action.kind));
  if (envois.length === 0) return { ok: false, raison: 'ce bloc n’envoie aucun message' };
  return { ok: true, noeudId: noeud.id, graphe, modele: envois.every((a) => a.action.kind === 'sendTemplate') };
}

export interface BlocPropose {
  workflowId: string; scenario: string; code: string; nom: string; type: string; envoyable: boolean; raison: string | null;
}

/** Les blocs publiés de l'espace, pour le choix de l'écran : les refusés restent visibles, avec leur raison. */
export function blocsProposables(workflows: readonly { id: string; name: string; graph: WorkflowGraph }[]): BlocPropose[] {
  const sortie: BlocPropose[] = [];
  for (const wf of workflows) {
    for (const n of wf.graph.nodes) {
      const code = String(n.data.code ?? '');
      if (!CODE_BLOC_RE.test(code)) continue;
      const r = blocSeul(wf.graph, code);
      const nom = typeof n.data.name === 'string' && n.data.name.trim() !== '' ? n.data.name : summarize(n.type, n.data);
      sortie.push({ workflowId: wf.id, scenario: wf.name, code, nom, type: n.type, envoyable: r.ok, raison: r.ok ? null : r.raison });
    }
  }
  return sortie;
}
```

(Remonter les imports en tête de fichier.) ⚠️ Vérifier que `summarize` accepte le type `WorkflowNodeType` de
`src/workflow/graph.ts` ; sinon garder le seul `data.name` et un libellé par type.

Run : `npx vitest run tests/mba-outils-maison.test.ts tests/node-list*.test.ts && npm run typecheck`
Attendu : PASS ; le typecheck signale les `switch` à compléter (`executer-maison.ts`, `vue-outils.ts`,
`mba-outils.ts` des routes) : les Tasks 13 et 14 les complètent. Committer ce Task avec les stubs minimaux qui
rendent le typecheck vert n'est PAS permis : enchaîner les Tasks 12 à 14 avant le commit.

### Task 13 : le relais envoie un bloc et lance un scénario

**Fichiers :**
- Modifier : `src/mba/executer-maison.ts`, `tests/mba-executer-maison.test.ts`, `src/workflow/wiring.ts`,
  `tests/controle-du-fil-cablage.test.ts`, `src/index.ts`

**Interfaces :**
- `DepsMaison` gagne : `estBloque(tenantId: string, waId: string): Promise<boolean>` ;
  `envoyerBloc(tenantId: string, waId: string, cible: { workflowId: string; code: string }): Promise<true | string>` ;
  `lancerScenario(tenantId: string, waId: string, workflowId: string): Promise<true | string>`.
- `buildWorkflowRuntime` rend en plus `rendreLaMainApresParcours(tenant: string, waId: string): Promise<void>`.
- `src/index.ts` : `lancerScenarioPourContact(tenant, workflowId, waId, windowOpen): Promise<StartOutcome | null>`,
  partagé par l'Inbox et le relais.

- [ ] **Step 1 : les tests d'exécution (ils échouent)**

Ajouter à `tests/mba-executer-maison.test.ts` (compléter `faux()` avec `estBloque`, `envoyerBloc`,
`lancerScenario` qui relèvent leur appel et rendent `true` par défaut, un paramètre `bloque` et `issue`) :

```ts
describe('envoyer un bloc, lancer un scénario', () => {
  const BLOC = { handler: 'bloc_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111', code: `nod_abc_${'A'.repeat(26)}` };
  const SCEN = { handler: 'scenario_fixe' as const, workflowId: '11111111-1111-4111-8111-111111111111' };

  it('envoie le bloc fixé et répond « n’ajoute rien »', async () => {
    const f = faux();
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: BLOC, corps: {} });
    expect(r).toEqual({ ok: true, reponse: expect.stringContaining('N’ajoute rien') });
    expect(f.gestes).toEqual([`bloc t1 w ${BLOC.workflowId} ${BLOC.code}`]);
  });
  it('lance le scénario fixé', async () => {
    const f = faux();
    await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: SCEN, corps: {} });
    expect(f.gestes).toEqual([`scenario t1 w ${SCEN.workflowId}`]);
  });
  it('🔴 un contact BLOQUÉ ne reçoit rien, et l’agent de Meta le sait', async () => {
    const f = faux({ bloque: true });
    const r = await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: SCEN, corps: {} });
    expect(r.ok).toBe(false);
    expect(f.gestes).toEqual([]);
  });
  it('🔴 la raison d’un refus remonte telle quelle à l’agent de Meta', async () => {
    const f = faux({ issue: 'la fenêtre de 24 h est fermée' });
    expect(await executerOutilMaison(f.deps, { tenantId: 't1', waId: 'w', cible: BLOC, corps: {} }))
      .toEqual({ ok: false, erreur: 'la fenêtre de 24 h est fermée' });
  });
});
```

- [ ] **Step 2 : l'exécution**

Dans `src/mba/executer-maison.ts`, compléter `DepsMaison` (avec un JSDoc par méthode : `envoyerBloc` joue le bloc
seul par `startFromNode` en reprenant le fil ; `lancerScenario` est le lancement de l'Inbox), et le `switch` :

```ts
    case 'bloc_fixe':
    case 'scenario_fixe': {
      if (await deps.estBloque(tenantId, waId)) return { ok: false, erreur: 'ce client est bloqué : aucun message ne lui est envoyé' };
      const issue = cible.handler === 'bloc_fixe'
        ? await deps.envoyerBloc(tenantId, waId, { workflowId: cible.workflowId, code: cible.code })
        : await deps.lancerScenario(tenantId, waId, cible.workflowId);
      return issue === true ? { ok: true, reponse: REPONSE_MAISON[cible.handler] } : { ok: false, erreur: issue };
    }
```

Run : `npx vitest run tests/mba-executer-maison.test.ts` → PASS.

- [ ] **Step 3 : nommer le retour du fil dans le câblage**

Dans `src/workflow/wiring.ts`, sortir le corps de `releaseToMba` (dépendance de l'exécuteur) en constante nommée,
placée juste avant la construction de l'exécuteur, SANS changer une ligne de son corps ni de son commentaire :

```ts
  const rendreLaMainApresParcours = async (tenant: string, waId: string): Promise<void> => {
    if (!(await inboxStore.setControlOwner(tenant, waId, 'app_human', { only: ['app_workflow'] }))) return;
    const attendu = await inboxStore.demanderReleaseMba(tenant, waId);
    if (attendu) return;
    await rendreLeFilMaintenant(tenant, waId);
  };
```

Dans les dépendances de l'exécuteur : `releaseToMba: rendreLaMainApresParcours,`. L'ajouter à l'objet rendu par
`buildWorkflowRuntime`. Déplacer le long commentaire (« ON NE RELÂCHE PLUS DANS LA FOULÉE… ») au-dessus de la
constante, et ajouter : « ⚠️ RENDU AUSSI par `buildWorkflowRuntime` : le relais de l'agent de Meta l'appelle
quand un bloc ou un scénario n'a pas pu partir après la reprise du fil (spec 2026-09-21-outils-maison-mba). »

Dans `tests/controle-du-fil-cablage.test.ts`, remplacer la découpe du `bloc` :

```ts
  const bloc = wiring.slice(wiring.indexOf('const rendreLaMainApresParcours'), wiring.indexOf('evalContext:'));
```

et ajouter un cas :

```ts
  it('🔴 l’exécuteur rend le fil par CE geste, et le câblage le rend au relais', () => {
    expect(wiring).toContain('releaseToMba: rendreLaMainApresParcours,');
    expect(wiring.slice(wiring.lastIndexOf('return {'))).toContain('rendreLaMainApresParcours');
  });
```

⚠️ Vérifier que `wiring.indexOf('evalContext:')` tombe APRÈS la constante ; sinon borner la découpe par la ligne
`releaseToMba: rendreLaMainApresParcours,`. Relancer : `npx vitest run tests/controle-du-fil-cablage.test.ts
tests/workflow-release-mba.test.ts tests/controle-fil-scenario-rendu.test.ts` → PASS.

- [ ] **Step 4 : le lancement partagé et le câblage du relais**

Dans `src/index.ts`, juste avant l'objet `inbox` (vers la ligne 960), sortir le corps de `startWorkflow` :

```ts
  /**
   * LANCER UN SCÉNARIO POUR UN CONTACT, exactement comme le bouton de l'Inbox. Deux appelants : l'Inbox et
   * l'outil « Lancer un scénario » de l'agent de Meta (spec 2026-09-21-outils-maison-mba, § 3.4). Un seul chemin,
   * pas un cinquième : la fermeture du parcours en cours, la reprise du fil et la garde de fenêtre vivent dans
   * `runFrom`.
   */
  const lancerScenarioPourContact = async (
    tenant: string, workflowId: string, waId: string, windowOpen: boolean,
  ): Promise<StartOutcome | null> => {
    const wf = await workflowStore.getById(workflowId, tenant);
    if (!wf) return null;
    const contactId = await contactStore.findIdByWaId(tenant, waId);
    const contact = { waId, contactId };
    const opts = { emitEvents: true, ignoreHumanControl: true };
    return windowOpen
      ? workflowRuntime.executor.startInWindow(tenant, workflowId, wf.graph, contact, opts)
      : workflowRuntime.executor.start(tenant, workflowId, wf.graph, contact, undefined, opts);
  };
```

Garder le commentaire existant de `startWorkflow` (la fermeture du parcours dans `runFrom`) au-dessus de la
constante, et écrire l'Inbox : `startWorkflow: (tenant, workflowId, waId, windowOpen) => lancerScenarioPourContact(tenant, workflowId, waId, windowOpen),`.
Importer `StartOutcome` depuis `./workflow/executor` si ce n'est pas déjà fait.

Dans `mbaRelais.maison` :

```ts
            estBloque: (t, waId) => contactStore.isBlockedByWaId(t, waId),
            /**
             * 🔴 UN ÉCHEC APRÈS LA REPRISE DU FIL LE REND. `runFrom` reprend le fil (`ignoreHumanControl`) puis
             * peut refuser (désabonné, envoi refusé) : il rend alors une raison SANS rendre la main, parce que ses
             * autres appelants (l'Inbox) ont un opérateur. Ici personne : sans ce geste, le fil resterait à nous
             * et l'agent de Meta muet. Si la reprise elle-même a échoué, le geste ne touche à rien (`only`).
             */
            lancerScenario: async (t, waId, workflowId) => {
              const ouverte = (await inboxStore.getWindowOpenByWaIds(t, [waId])).get(waId) === true;
              const issue = await lancerScenarioPourContact(t, workflowId, waId, ouverte);
              if (issue === true) return true;
              await workflowRuntime.rendreLaMainApresParcours(t, waId);
              return issue ?? 'ce scénario n’existe plus';
            },
            envoyerBloc: async (t, waId, { workflowId, code }) => {
              const wf = await workflowStore.getById(workflowId, t);
              if (!wf) return 'le scénario de ce bloc n’existe plus';
              const seul = blocSeul(wf.graph, code);
              if (!seul.ok) return seul.raison;
              const ouverte = (await inboxStore.getWindowOpenByWaIds(t, [waId])).get(waId) === true;
              if (!seul.modele && !ouverte) return 'la fenêtre de 24 h est fermée : ce bloc ne peut pas partir';
              const contactId = await contactStore.findIdByWaId(t, waId);
              // Le graphe RÉDUIT au bloc : `runFrom` prend le fil, envoie, et rend la main à l'accusé (0149).
              const issue = await workflowRuntime.executor.startFromNode(
                t, workflowId, seul.graphe, { waId, contactId }, seul.noeudId, { ignoreHumanControl: true, emitEvents: false },
              );
              if (issue === true) return true;
              await workflowRuntime.rendreLaMainApresParcours(t, waId);
              return issue;
            },
```

(importer `blocSeul` depuis `./mba/outils-maison`). Run : `npm run typecheck && npm test` → PASS.

- [ ] **Step 5 : commit** (après le Task 14, le typecheck étant vert seulement une fois les `switch` complets)

### Task 14 : routes et écran pour le bloc et le scénario

**Fichiers :**
- Modifier : `src/mba/vue-outils.ts`, `tests/mba-vue-outils.test.ts`, `src/http/mba-outils.ts`,
  `tests/http-mba-outils.test.ts`, `src/index.ts`, `web/lib/api-mba-outils.ts`,
  `web/components/mba-outils/CiblesOutil.tsx`, `FormulaireOutilMba.tsx`, `ChoixTypeOutil.tsx`, `OutilsMba.tsx`,
  `web/e2e/mba-onglet-outils.spec.ts`

**Interfaces :**
- `CibleVue` (serveur et web) gagne `{ type: 'bloc'; workflowId: string; code: string; scenario: string | null; bloc: string | null }`
  et `{ type: 'scenario'; workflowId: string; scenario: string | null }`.
- `ContexteVue` gagne `workflows: ReadonlyMap<string, { name: string; graph: WorkflowGraph }>`.
- `MbaOutilsDeps` gagne `workflow(tenantId: string, id: string): Promise<{ name: string; graph: WorkflowGraph } | null>`
  et `blocs(tenantId: string): Promise<BlocPropose[]>` ; route `GET /tenants/:tenantId/mba-outils/blocs` →
  `{ blocs: BlocPropose[] }`.
- `cibleSaisieSchema` gagne `{ type: 'bloc'; workflowId: uuid; code: string }` et `{ type: 'scenario'; workflowId: uuid }`.
- Web : `listerBlocsMba(tenantId): Promise<{ blocs: BlocPropose[] }>` ; `CibleBloc`, `CibleScenario` ;
  `TYPES_PROPOSES = ['tag', 'champ', 'bloc', 'scenario', 'connecteur']`.

- [ ] **Step 1 : les tests (ils échouent)**

`tests/mba-vue-outils.test.ts` (le `ctx()` gagne `workflows: new Map()` par défaut) :

```ts
const WF = '11111111-1111-4111-8111-111111111111';
const CODE = `nod_abc_${'A'.repeat(26)}`;
const noeud = (type: string, data: Record<string, unknown>) =>
  ({ id: 'n1', type, position: { x: 0, y: 0 }, data: { code: CODE, name: 'Brochure', ...data } }) as never;

describe('les lignes d’un bloc et d’un scénario', () => {
  it('un bloc envoyable : son scénario et son nom, rien ne manque', () => {
    const workflows = new Map([[WF, { name: 'Accueil', graph: { nodes: [noeud('quick_message', { body: 'x', quickReplies: [] })], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } }), ctx({ workflows })))
      .toMatchObject({ type: 'bloc', cible: { scenario: 'Accueil', bloc: 'Brochure' }, cibleManquante: null });
  });
  it('🔴 un bloc DEVENU un bloc qui attend une réponse est signalé, avec la raison', () => {
    const workflows = new Map([[WF, { name: 'Accueil', graph: { nodes: [noeud('quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'bloc_fixe', workflowId: WF, code: CODE } }), ctx({ workflows })).cibleManquante)
      .toContain('Lancer un scénario');
  });
  it('🔴 un scénario supprimé, ou vide, est signalé', () => {
    expect(vueOutilMba(outil({ binding: { handler: 'scenario_fixe', workflowId: WF } }), ctx()).cibleManquante).toContain('n’existe plus');
    const vide = new Map([[WF, { name: 'Vide', graph: { nodes: [], edges: [] } }]]);
    expect(vueOutilMba(outil({ binding: { handler: 'scenario_fixe', workflowId: WF } }), ctx({ workflows: vide })).cibleManquante).toContain('vide');
  });
});
```

`tests/http-mba-outils.test.ts` (le `monter()` gagne `workflow` et `blocs` par défaut) :

```ts
describe('un bloc et un scénario', () => {
  const WF = '11111111-1111-4111-8111-111111111111';
  const CODE = `nod_abc_${'A'.repeat(26)}`;
  const graphe = (quickReplies: unknown[]) => ({
    nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { code: CODE, body: 'x', quickReplies } }], edges: [],
  }) as never;

  it('un bloc envoyable devient `bloc_fixe`', async () => {
    const { app, gestes } = monter({ workflow: async () => ({ name: 'Accueil', graph: graphe([]) }) });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'bloc', workflowId: WF, code: CODE } } });
    expect(res.statusCode).toBe(201);
    expect(gestes[0]!.args[2]).toMatchObject({ cible: { handler: 'bloc_fixe', workflowId: WF, code: CODE } });
  });
  it('🔴 un bloc qui attend une réponse est refusé avec la raison, et rien n’est créé', async () => {
    const { app, gestes } = monter({ workflow: async () => ({ name: 'Accueil', graph: graphe([{ text: 'Oui' }]) }) });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'bloc', workflowId: WF, code: CODE } } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toContain('Lancer un scénario');
    expect(gestes).toEqual([]);
  });
  it('un scénario inconnu est refusé', async () => {
    const { app } = monter({ workflow: async () => null });
    const res = await app.inject({ method: 'POST', url, ...h(), payload: { ...TEXTES, cible: { type: 'scenario', workflowId: WF } } });
    expect(res.statusCode).toBe(422);
  });
  it('🔴 GET /blocs rend la liste, et refuse sans jeton', async () => {
    const bloc = { workflowId: WF, scenario: 'Accueil', code: CODE, nom: 'Brochure', type: 'quick_message', envoyable: true, raison: null };
    const { app } = monter({ blocs: async () => [bloc] });
    expect((await app.inject({ method: 'GET', url: `${url}/blocs`, ...h() })).json()).toEqual({ blocs: [bloc] });
    expect([401, 403]).toContain((await app.inject({ method: 'GET', url: `${url}/blocs` })).statusCode);
  });
});
```

`web/e2e/mba-onglet-outils.spec.ts` : 🔴 créer un bloc (`GET /mba-outils/blocs` rend un bloc envoyable et un
bloc à boutons ; le second est désactivé, sa raison visible ; le POST part avec `cible: { type: 'bloc', ... }`) ;
créer un scénario (`GET /workflows` rend un publié et un brouillon jamais publié ; seul le premier est proposé).

- [ ] **Step 2 : serveur**

Dans `src/mba/vue-outils.ts`, ajouter les deux `case` :

```ts
    case 'bloc_fixe': {
      const wf = ctx.workflows.get(cible.workflowId) ?? null;
      const r = wf ? blocSeul(wf.graph, cible.code) : null;
      const noeud = wf?.graph.nodes.find((n) => String(n.data.code ?? '') === cible.code);
      return {
        ...base, type,
        cible: { type: 'bloc', workflowId: cible.workflowId, code: cible.code, scenario: wf?.name ?? null,
          bloc: typeof noeud?.data.name === 'string' ? noeud.data.name : null },
        cibleManquante: wf === null ? 'le scénario de ce bloc n’existe plus' : r && !r.ok ? r.raison : null,
        aussiUtilisePar: [],
      };
    }
    case 'scenario_fixe': {
      const wf = ctx.workflows.get(cible.workflowId) ?? null;
      return {
        ...base, type, cible: { type: 'scenario', workflowId: cible.workflowId, scenario: wf?.name ?? null },
        cibleManquante: wf === null ? 'ce scénario n’existe plus'
          : entryNode(wf.graph) === null ? 'ce scénario est vide ou n’est pas publié' : null,
        aussiUtilisePar: [],
      };
    }
```

(importer `blocSeul` et `entryNode`). Dans `src/http/mba-outils.ts` : les deux options du schéma de saisie,
`versCibleMaison` (`bloc` → `{ handler: 'bloc_fixe', workflowId, code }`, `scenario` → `{ handler: 'scenario_fixe', workflowId }`),
`cibleInvalide` :

```ts
    if (c.type === 'bloc' || c.type === 'scenario') {
      const wf = await deps.workflow(tenant, c.workflowId);
      if (!wf) return 'ce scénario n’existe pas';
      if (c.type === 'bloc') {
        const r = blocSeul(wf.graph, c.code);
        if (!r.ok) return r.raison;
      } else if (entryNode(wf.graph) === null) {
        return 'ce scénario est vide ou n’est pas publié';
      }
    }
```

et la route :

```ts
  app.get(`${base}/blocs`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ blocs: await deps.blocs(tenant) });
  });
```

⚠️ Déclarer `GET /blocs` AVANT toute route `/:outilId` en `GET` s'il y en a une (il n'y en a pas : seuls
`PATCH` et `DELETE` portent `:outilId`).

Dans `src/index.ts`, `mbaOutils` : `contexte` charge aussi `workflowStore.list(tenant)` en `workflows`
(`new Map(l.map((w) => [w.id, { name: w.name, graph: w.graph }]))`) ;
`workflow: async (t, id) => { const w = await workflowStore.getById(id, t); return w ? { name: w.name, graph: w.graph } : null; }` ;
`blocs: async (t) => blocsProposables((await workflowStore.list(t)).map((w) => ({ id: w.id, name: w.name, graph: w.graph })))`.

- [ ] **Step 3 : web**

`web/lib/api-mba-outils.ts` : les deux variantes de `CibleVue` et de `CibleSaisie`, le type `BlocPropose`, et :

```ts
export function listerBlocsMba(tenantId: string): Promise<{ blocs: BlocPropose[] }> {
  return request(`${base(tenantId)}/blocs`);
}
```

`CiblesOutil.tsx`, deux composants :

```tsx
export function CibleBloc({ tenantId, workflowId, code, onChange }: {
  tenantId: string; workflowId: string; code: string; onChange: (workflowId: string, code: string) => void;
}) {
  const t = useT();
  const [blocs, setBlocs] = useState<BlocPropose[] | null>(null);
  useEffect(() => {
    let vivant = true;
    listerBlocsMba(tenantId).then((r) => { if (vivant) setBlocs(Array.isArray(r?.blocs) ? r.blocs : []); }).catch(() => { if (vivant) setBlocs([]); });
    return () => { vivant = false; };
  }, [tenantId]);
  if (blocs === null) return null;
  if (blocs.length === 0) return <p className="text-xs text-ink-500" data-testid="mba-cible-blocs-aucun">{t('Aucun bloc publié dans vos scénarios.', 'No published block in your scenarios.')}</p>;
  const scenarios = [...new Set(blocs.map((b) => b.scenario))];
  return (
    <div className="flex flex-col gap-2" data-testid="mba-cible-blocs">
      {scenarios.map((s) => (
        <fieldset key={s} className="rounded-lg border border-ink-200 p-2">
          <legend className="px-1 text-xs font-medium text-ink-700">{s}</legend>
          {blocs.filter((b) => b.scenario === s).map((b) => (
            <label key={b.code} className={`flex items-start gap-2 py-1 text-xs ${b.envoyable ? 'text-ink-800' : 'text-ink-400'}`}>
              <input type="radio" name="mba-bloc" disabled={!b.envoyable} checked={b.code === code && b.workflowId === workflowId}
                data-testid={`mba-cible-bloc-${b.code}`} onChange={() => onChange(b.workflowId, b.code)} />
              <span>{b.nom}{b.raison && <span className="block text-[11px]">{b.raison}</span>}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function CibleScenario({ tenantId, workflowId, onChange }: { tenantId: string; workflowId: string; onChange: (id: string) => void }) {
  const t = useT();
  const [scenarios, setScenarios] = useState<WorkflowSummary[]>([]);
  useEffect(() => {
    let vivant = true;
    listWorkflows(tenantId).then((r) => { if (vivant) setScenarios((Array.isArray(r?.workflows) ? r.workflows : []).filter(estEnLigne)); }).catch(() => {});
    return () => { vivant = false; };
  }, [tenantId]);
  return (
    <label className="text-xs text-ink-600">
      {t('Scénario à lancer (depuis son début)', 'Scenario to start (from its beginning)')}
      <select className={`${inputCls} mt-1`} data-testid="mba-cible-scenario" value={workflowId} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('Choisir un scénario', 'Pick a scenario')}</option>
        {scenarios.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select>
    </label>
  );
}
```

⚠️ Vérifier la signature de `estEnLigne` (`web/lib/api/scenarios.ts:209`) : si elle prend autre chose qu'un
`WorkflowSummary`, adapter le filtre. Importer `listWorkflows`, `estEnLigne`, `WorkflowSummary` depuis `@/lib/api`.

`FormulaireOutilMba.tsx` : `cibleInitiale` et `cibleComplete` gèrent `bloc` (`workflowId` et `code` non vides)
et `scenario` (`workflowId` non vide) ; rendre `<CibleBloc>` et `<CibleScenario>` selon le type.
`ChoixTypeOutil.tsx` : `TYPES_PROPOSES = ['tag', 'champ', 'bloc', 'scenario', 'connecteur']`.
`OutilsMba.tsx` `libelleCible` : `bloc` → « Bloc « {bloc} » du scénario {scenario} », `scenario` →
« Scénario : {scenario} », avec un repli « supprimé » quand le nom manque.

- [ ] **Step 4 : tout passe**

```bash
npm run typecheck && npm test && cd web && npx tsc --noEmit && npx vitest run && npm run build && npx playwright test e2e/mba-onglet-outils.spec.ts
```

- [ ] **Step 5 : mutation « bloc seul » (copie hors dépôt)**

Copier `src/mba/outils-maison.ts` ; remplacer `{ nodes: [noeud], edges: [] }` par `graph` dans `blocSeul` ; le cas
« le bloc part SANS ce qui le suit » doit tomber. Restaurer, relancer : PASS.

- [ ] **Step 6 : commit des Tasks 12 à 14**

```bash
git commit --only src/workflow/node-list.ts src/mba/outils-maison.ts tests/mba-outils-maison.test.ts src/mba/executer-maison.ts tests/mba-executer-maison.test.ts src/workflow/wiring.ts tests/controle-du-fil-cablage.test.ts src/index.ts src/mba/vue-outils.ts tests/mba-vue-outils.test.ts src/http/mba-outils.ts tests/http-mba-outils.test.ts web/lib/api-mba-outils.ts web/components/mba-outils web/e2e/mba-onglet-outils.spec.ts -m "feat(mba): l agent de Meta envoie un bloc et lance un scenario, puis reprend la main"
git push origin main
```

Lire le run CI job par job.

### Task 15 : documentation du lot 3, `/revue`

- [ ] `/revue` sur le diff du lot 3, rayon de souffle compris (en particulier : `lancerScenarioPourContact` ne
  change rien pour l'Inbox ; `rendreLaMainApresParcours` est le même corps qu'avant).
- [ ] `features.md` (les deux outils), `documentation.md` (le bloc seul, la reprise et le retour du fil sur échec),
  `wip.md`. Commit `--only` après relecture du diff.

---

## Lot 4 : la réponse « à côté »

### Task 16 : le fil ne reste plus bloqué (marqueur et accusé)

**Fichiers :**
- Modifier : `src/inbox/store.pg.ts` (`demanderReleaseMba`, `consommerReleaseMba`)
- Modifier : `tests/integration/release-mba-marqueur.integration.test.ts`

**Interfaces :** signatures inchangées. `demanderReleaseMba` ne pose le marqueur que si notre dernier envoi est le
dernier message du fil (aucun message ENTRANT plus récent) ET n'est pas acquitté ; `consommerReleaseMba` pose
`accuse_le` au premier statut.

⚠️ **`accuse_le` VAUT `null` POUR TOUT MESSAGE ACQUITTÉ AVANT CE TASK** (relecture du 2026-09-21) : 0162 est
appliquée depuis le lot 2, et personne ne l'écrit avant ce Task. `null` ne veut donc PAS dire « pas encore
acquitté » pour un envoi antérieur au déploiement du lot 4 : la règle doit le traiter comme inconnu (se rabattre
sur les statuts reçus, ou sur la date de déploiement), sinon elle reposerait le marqueur sur des fils déjà
réglés. Le balayage des marqueurs reste le filet.

⚠️ **La règle lit les MESSAGES, pas `conversations.last_direction`.** Les deux disent presque la même chose, mais
`last_direction` ignore délibérément une réaction (arbitrage du 2026-09-19) et vaut `null` sur les conversations
d'avant 0130 ; les messages sont la preuve directe (un client qui a réagi ou écrit après notre envoi l'a reçu).

- [ ] **Step 1 : confirmer le défaut en base (lecture seule)**

```bash
node -e "require('dotenv/config');const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
p.query(\"begin read only\").then(()=>p.query(\"select c.control_owner, c.last_direction, c.release_mba_apres_message is not null as marque, m.created_at as envoi, c.control_changed_at from conversations c left join conversation_messages m on m.meta_message_id = c.release_mba_apres_message where c.release_mba_apres_message is not null order by m.created_at\")).then(r=>{console.log(r.rows);return p.query('rollback');}).then(()=>p.end());"
```

Attendu : des fils en `app_human` dont le marqueur désigne un message ANCIEN (bien plus vieux que
`control_changed_at`), c'est-à-dire déjà acquitté. Consigner le nombre dans `wip.md`. Aucun ? Le dire, et garder
la correction (le défaut se lit dans le code, § 5.1 de la spec).

- [ ] **Step 2 : les tests d'intégration (CI seulement)**

Dans `tests/integration/release-mba-marqueur.integration.test.ts` (son helper `conversation(waId, envois)` crée
une conversation et des envois espacés d'une seconde) :

1. **Réécrire le cas « ⚠️ les messages ENTRANTS ne comptent pas »** : il insère un entrant APRÈS notre envoi et
   attend encore le marqueur, ce que la nouvelle règle inverse délibérément. Le cas qu'il protégeait (le marqueur
   désigne NOTRE envoi, jamais l'identifiant d'un entrant) est gardé en plaçant l'entrant AVANT l'envoi :

```ts
  it('⚠️ un message ENTRANT n’est jamais attendu : le marqueur désigne NOTRE envoi', async () => {
    const waId = '33600000105';
    const conv = (await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) returning id`, [tenantId, waId],
    )).rows[0]!.id;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'in', 'text', 'bonjour', 'wamid.DENTRANT', now() - interval '10 seconds'),
              ($1, 'out', 'text', 'coucou', 'wamid.D1', now())`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBe('wamid.D1');
  });
```

2. **Ajouter** :

```ts
  it('🔴 le client a écrit APRÈS notre envoi (réponse « à côté ») : aucun marqueur, on rend tout de suite', async () => {
    // Spec 2026-09-21-outils-maison-mba § 5.1 : son message prouve que notre envoi est traité. Attendre son
    // accusé, déjà reçu depuis longtemps, gelait le fil en `app_human` jusqu'au balayage.
    const waId = '33600000106';
    const conv = await conversation(waId, ['wamid.F1']);
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, created_at)
       values ($1, 'in', 'text', 'vous êtes ouverts dimanche ?', 'wamid.FENTRANT', now() + interval '10 seconds')`,
      [conv],
    );
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 notre dernier envoi est DÉJÀ acquitté (question expirée) : aucun marqueur', async () => {
    const waId = '33600000107';
    await conversation(waId, ['wamid.E1']);
    await pool.query(`update conversation_messages set accuse_le = now() where meta_message_id = 'wamid.E1'`);
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });

  it('🔴 tout statut pose l’accusé, même attendu par personne, et le premier seulement', async () => {
    const waId = '33600000108';
    await conversation(waId, ['wamid.G1']);
    expect(await store.consommerReleaseMba('wamid.G1')).toBeNull(); // personne n'attendait
    const premier = (await pool.query<{ accuse_le: Date | null }>(
      `select accuse_le from conversation_messages where meta_message_id = 'wamid.G1'`,
    )).rows[0]!.accuse_le;
    expect(premier).not.toBeNull();
    await new Promise((r) => { setTimeout(r, 20); });
    await store.consommerReleaseMba('wamid.G1');
    const second = (await pool.query<{ accuse_le: Date }>(
      `select accuse_le from conversation_messages where meta_message_id = 'wamid.G1'`,
    )).rows[0]!.accuse_le;
    expect(second.getTime()).toBe(premier!.getTime());
    // Et un release demandé ensuite n'attend plus rien : l'accusé est déjà là.
    expect(await store.demanderReleaseMba(tenantId, waId)).toBeNull();
  });
```

Les cas existants « le marqueur vise le DERNIER envoi », « plusieurs statuts… QU'UNE FOIS », « RIEN envoyé » et
« SANS identifiant Meta » restent inchangés et doivent rester verts : ils décrivent le comportement de 0149 que la
règle garde quand aucun accusé n'est encore arrivé et que le client n'a rien écrit.

- [ ] **Step 3 : écrire les deux requêtes**

`demanderReleaseMba` :

```ts
    const res = await this.pool.query<{ release_mba_apres_message: string | null }>(
      `update conversations c
          set release_mba_apres_message = (
            select d.meta_message_id
              from (select m.meta_message_id, m.accuse_le, m.created_at
                      from conversation_messages m
                     where m.conversation_id = c.id and m.direction = 'out' and m.meta_message_id is not null
                     order by m.created_at desc limit 1) d
             where d.accuse_le is null
               and not exists (select 1 from conversation_messages i
                                where i.conversation_id = c.id and i.direction = 'in'
                                  and i.created_at > d.created_at))
        where c.tenant_id = $1 and c.wa_id = $2
       returning c.release_mba_apres_message`,
      [tenantId, waId],
    );
```

Ajouter au JSDoc : « 🔴 LE MARQUEUR NE SE POSE PLUS SUR UN MESSAGE DÉJÀ TRAITÉ PAR META (spec
2026-09-21-outils-maison-mba, § 5.1). Deux cas le posaient sur un accusé déjà reçu, donc qui ne reviendrait
jamais : la réponse « à côté » (le client a écrit depuis) et le délai d'une question sans sortie. Le fil restait en
`app_human` jusqu'au balayage. La règle lit les MESSAGES (un entrant plus récent que notre envoi prouve que Meta
l'a traité), pas `last_direction`, qui ignore les réactions et vaut `null` avant 0130. ⚠️ Fenêtre résiduelle
assumée : un client qui écrit dans la seconde même de notre envoi ; le balayage reste le filet. »

⚠️ Vérifier le plan d'exécution une fois, en lecture seule sur la base (`explain` de la requête pour une
conversation réelle) : le `not exists` doit passer par l'index de `conversation_messages` sur
`(conversation_id, created_at)` s'il existe (`select indexdef from pg_indexes where tablename = 'conversation_messages'`).

`consommerReleaseMba` :

```ts
    const res = await this.pool.query<{ tenant_id: string; wa_id: string }>(
      `with accuse as (
         update conversation_messages set accuse_le = now()
          where meta_message_id = $1 and accuse_le is null
       )
       update conversations c set release_mba_apres_message = null
        where c.release_mba_apres_message = $1
       returning c.tenant_id, c.wa_id`,
      [messageId],
    );
```

Ajouter au JSDoc : « ⚠️ ELLE POSE AUSSI L'ACCUSÉ du message (0162), dans la même requête : c'est la preuve que
`demanderReleaseMba` lit pour ne plus attendre ce qui est déjà arrivé. Un seul aller-retour sur ce chemin très
chaud, et `accuse_le is null` n'écrit qu'au premier statut. »

⚠️ **Ordre des Steps 2 à 5 : le test part SEUL d'abord.** Les tests d'intégration ne tournent qu'en CI et la base
locale est la production : pas de mutation locale. Le sens inverse se prouve donc par la CI : le fichier de test
est poussé sans le correctif (Step 4, rouge attendu), puis le correctif (Step 5, vert attendu). Écrire le Step 3
dans l'arbre SANS le committer pendant le Step 4.

- [ ] **Step 4 : pousser le test seul, lire le rouge**

```bash
git commit --only tests/integration/release-mba-marqueur.integration.test.ts -m "test(mba): le marqueur ne doit plus attendre un message deja traite par Meta

Cas reecrit : un message entrant n est jamais attendu. Il placait l entrant APRES notre envoi et attendait
encore le marqueur, ce que la regle de la spec 2026-09-21-outils-maison-mba 5.1 inverse deliberement."
git push origin main
```

Lire le job `integration` (`gh run view <id> --json jobs`) : ROUGE, sur les trois cas neufs et sur eux seuls.
Les cas existants et le cas réécrit restent verts.

- [ ] **Step 5 : pousser le correctif, lire le vert**

```bash
npm run typecheck && npm test
git commit --only src/inbox/store.pg.ts -m "fix(mba): le fil ne reste plus bloque quand le client repond a cote ou qu une question expire"
git push origin main
```

Lire le job `integration` : tous les cas du fichier passent.

### Task 17 : `agent_event` dans le client, et l'événement « hors parcours »

**Fichiers :**
- Créer : `src/mba/evenement.ts`, `tests/mba-evenement.test.ts`
- Modifier : `src/mba/client.ts`, `tests/mba-client.test.ts`

**Interfaces :**
- `interface EvenementAgent { type: string; description: string; payload: string }`
- `evenementHorsParcours(message: string): EvenementAgent` ; `destinataireAgentEvent(waId: string): string`
- `MbaClient.agentEvent(phoneNumberId: string, to: string, event: EvenementAgent, signal?: AbortSignal): Promise<unknown>`

- [ ] **Step 1 : les tests (ils échouent)**

`tests/mba-evenement.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { evenementHorsParcours, destinataireAgentEvent } from '../src/mba/evenement';

describe('l’événement « réponse hors parcours »', () => {
  it('porte le message du client dans un payload JSON en CHAÎNE', () => {
    const e = evenementHorsParcours('Vous êtes ouverts le dimanche ?');
    expect(e.type).toBe('reponse_hors_parcours');
    expect(JSON.parse(e.payload)).toEqual({ message: 'Vous êtes ouverts le dimanche ?' });
    expect(e.description.length).toBeLessThanOrEqual(1024);
  });
  it('🔴 le payload tient sous 4 096 caractères APRÈS échappement', () => {
    const e = evenementHorsParcours('"'.repeat(5000));
    expect(e.payload.length).toBeLessThanOrEqual(4096);
    expect(() => JSON.parse(e.payload)).not.toThrow();
  });
  it('le destinataire suit le format MESURÉ au lot 1', () => {
    expect(destinataireAgentEvent('33612345678')).toBe('+33612345678'); // à aligner sur la mesure
  });
});
```

Et, dans `tests/mba-client.test.ts` (même moule : `new MbaClient('tok', impl)` avec un faux `fetch`) :

```ts
  it('🔴 agent_event : POST au bon chemin, version 2.0.0, corps { to, event }, et le signal transmis', async () => {
    const vus: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (url: string, init: RequestInit): Promise<Response> => {
      vus.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    const signal = AbortSignal.timeout(1_000);
    const event = { type: 'reponse_hors_parcours', description: 'd', payload: '{"message":"x"}' };
    await new MbaClient('tok', impl).agentEvent('PN1', '+33600000001', event, signal);
    expect(vus[0]!.url).toBe('https://api.facebook.com/PN1/agent_event');
    expect(vus[0]!.init.method).toBe('POST');
    expect((vus[0]!.init.headers as Record<string, string>)['X-API-Version']).toBe('2.0.0');
    expect(JSON.parse(String(vus[0]!.init.body))).toEqual({ to: '+33600000001', event });
    expect(vus[0]!.init.signal).toBe(signal);
  });
```

- [ ] **Step 2 : écrire**

`src/mba/evenement.ts` :

```ts
/**
 * L'ÉVÉNEMENT QUI FAIT RÉPONDRE L'AGENT DE META à un client sorti d'un parcours (spec 2026-09-21, § 5).
 *
 * ⚠️ `payload` EST UNE CHAÎNE JSON, pas un objet (documentation de Meta), bornée à 4 096 caractères : la borne se
 * mesure APRÈS échappement, sinon un message plein de guillemets passerait la coupe et serait refusé.
 */
export interface EvenementAgent { type: string; description: string; payload: string }

export const TYPE_HORS_PARCOURS = 'reponse_hors_parcours';
export const DESCRIPTION_HORS_PARCOURS =
  'Le client vient d’écrire en dehors du parcours automatique qu’on lui proposait. Réponds à son message.';
const PAYLOAD_MAX = 4096;

export function evenementHorsParcours(message: string): EvenementAgent {
  let texte = message;
  let payload = JSON.stringify({ message: texte });
  while (payload.length > PAYLOAD_MAX && texte.length > 0) {
    texte = texte.slice(0, Math.max(0, texte.length - (payload.length - PAYLOAD_MAX) - 1));
    payload = JSON.stringify({ message: texte });
  }
  return { type: TYPE_HORS_PARCOURS, description: DESCRIPTION_HORS_PARCOURS, payload };
}

/** Le format de `to`, MESURÉ au lot 1 du plan 2026-09-21-outils-maison-mba (inconnue M2). */
export function destinataireAgentEvent(waId: string): string {
  return `+${waId}`;
}
```

(Aligner `destinataireAgentEvent` et son test sur le format mesuré au Task 1.)

`src/mba/client.ts` : ajouter `signal?: AbortSignal` en dernier paramètre de `appel`, transmis par
`...(signal ? { signal } : {})` dans l'`init` de `fetch` ; puis :

```ts
  /**
   * DÉCLENCHE L'AGENT DE META dans la conversation d'un client (spec 2026-09-21-outils-maison-mba, § 5).
   * ⚠️ `to` au format MESURÉ au lot 1 (`destinataireAgentEvent`), et la réponse de Meta ne porte rien d'utile :
   * l'effet se constate dans la conversation. (Recopier ici la phrase de résultat consignée au Task 1, Step 4.)
   */
  async agentEvent(phoneNumberId: string, to: string, event: EvenementAgent, signal?: AbortSignal): Promise<unknown> {
    return this.appel<unknown>('POST', `${phoneNumberId}/agent_event`, { to, event }, VERSION_AGENT_CONFIG, signal);
  }
```

Run : `npx vitest run tests/mba-evenement.test.ts tests/mba-client.test.ts && npm run typecheck` → PASS.

- [ ] **Step 3 : commit**

```bash
git add -- src/mba/evenement.ts tests/mba-evenement.test.ts
git commit --only src/mba/evenement.ts tests/mba-evenement.test.ts src/mba/client.ts tests/mba-client.test.ts -m "feat(mba): agent_event dans le client, l evenement reponse hors parcours"
```

### Task 18 : transmettre la réponse « à côté »

**Fichiers :**
- Modifier : `src/workflow/executor.ts`, `tests/workflow-release-mba.test.ts`, `src/workflow/wiring.ts`

**Interfaces :**
- Dépendance de l'exécuteur : `transmettreHorsParcours?(tenantId: string, waId: string): Promise<void>`.
- `rendreLaMainAMba(tenantId: string, waId: string, opts: { transmettre?: boolean } = {})`.

- [ ] **Step 1 : les tests (ils échouent)**

Dans `tests/workflow-release-mba.test.ts`, étendre `executeur()` : un tableau `ordre: string[]`, `releaseToMba`
pousse `release ${waId}`, et une dépendance `transmettreHorsParcours: async (_t, waId) => { ordre.push(\`transmis ${waId}\`); }`.
Ajouter :

```ts
describe('la réponse « à côté » est transmise à l’agent de Meta', () => {
  it('🔴 réponse libre : le fil est rendu PUIS le message transmis', async () => {
    const graph = g([n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' })], [['n1', 'n2', 'Oui']]);
    const { ex, ordre } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Vous êtes ouverts dimanche ?');
    expect(ordre).toEqual(['release 33600000001', 'transmis 33600000001']);
  });
  it('🔴 un bouton sans suite va à un humain : RIEN n’est transmis', async () => {
    const graph = g([n('n1', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })]);
    const { ex, ordre } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'btn:0');
    expect(ordre).toEqual([]);
  });
  it('🔴 une fin NORMALE de parcours rend le fil SANS rien transmettre', async () => {
    const graph = g([n('n1', 'quick_message', { body: 'Un conseiller ?', quickReplies: [{ text: 'Oui' }] }), n('n2', 'tag', { tag: 'ok' })], [['n1', 'n2', 'Oui']]);
    const { ex, ordre } = executeur(graph, { mbaActif: true });
    await ex.advance('t1', '33600000001', 'msg1', 'Oui');
    expect(ordre).toEqual(['release 33600000001']);
  });
  it('MBA éteint : ni release ni transmission', async () => {
    const graph = g([n('n1', 'quick_message', { body: 'x', quickReplies: [{ text: 'Oui' }] })]);
    const { ex, ordre } = executeur(graph, { mbaActif: false });
    await ex.advance('t1', '33600000001', 'msg1', 'Hors script');
    expect(ordre).toEqual([]);
  });
});
```

⚠️ Vérifier sur les cas existants du fichier la forme exacte d'un « bouton sans suite » (`btn:0` sans arête) et
d'une fin normale (bouton `Oui` qui mène à un bloc `tag` terminal) ; ajuster les graphes au besoin.

- [ ] **Step 2 : l'exécuteur**

Dans l'interface des dépendances, à côté de `releaseToMba?` :

```ts
  /**
   * TRANSMET À L'AGENT DE META le message « à côté » du client, une fois le fil rendu (spec
   * 2026-09-21-outils-maison-mba, § 5). Appelée SEULEMENT par la branche « il a écrit » : une fin normale n'a
   * rien à transmettre, un bouton sans suite va à un humain.
   */
  transmettreHorsParcours?(tenantId: string, waId: string): Promise<void>;
```

`rendreLaMainAMba` :

```ts
  private async rendreLaMainAMba(tenantId: string, waId: string, opts: { transmettre?: boolean } = {}): Promise<void> {
    if (!this.deps.releaseToMba) return;
    if (!(await this.mbaActif(tenantId))) return; // gate : aucun appel Meta si l'agent n'est pas allumé
    try {
      await this.deps.releaseToMba(tenantId, waId);
      // Après le release, jamais avant : tant que nous tenons le fil, l'agent de Meta n'a pas la parole.
      if (opts.transmettre === true && this.deps.transmettreHorsParcours) await this.deps.transmettreHorsParcours(tenantId, waId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`release vers MBA ignoré pour ${waId}:`, err instanceof Error ? err.message : err);
    }
  }
```

Dans la branche (a) de `advance` (le `else` après `boutonSansSuite`) :
`await this.rendreLaMainAMba(tenantId, waId, { transmettre: true });`

- [ ] **Step 3 : le câblage**

Dans `src/workflow/wiring.ts`, avant la construction de l'exécuteur :

```ts
  /**
   * LA RÉPONSE « À CÔTÉ » PART CHEZ L'AGENT DE META (spec 2026-09-21-outils-maison-mba, § 5).
   *
   * 🔴 SEULEMENT SI LE FIL EST VRAIMENT À LUI (`mba` chez nous) : une conversation de TEST, un release refusé ou
   * un marqueur en attente laissent un autre détenteur, et l'événement n'aurait personne pour y répondre.
   * Best-effort : un échec est journalisé par l'exécuteur, et l'agent répondra au message suivant du client.
   */
  const transmettreHorsParcours = async (tenant: string, waId: string): Promise<void> => {
    if ((await inboxStore.getControlOwner(tenant, waId)) !== 'mba') {
      // eslint-disable-next-line no-console
      console.log(`agent_event non envoyé pour ${waId} : le fil n’est pas à l’agent de Meta`);
      return;
    }
    const pn = await numeroDeLEspace(tenant);
    if (!pn) return;
    const texte = (await inboxStore.derniereSaisieDuContact(tenant, waId)) ?? '';
    const client = await metaFactory.mbaClientForTenant(tenant);
    await client.agentEvent(pn, destinataireAgentEvent(waId), evenementHorsParcours(texte), AbortSignal.timeout(10_000));
  };
```

et dans les dépendances de l'exécuteur : `transmettreHorsParcours,`. Importer depuis `../mba/evenement`.
⚠️ Vérifier que `numeroDeLEspace` et `metaFactory` sont dans la portée à cet endroit (ils servent déjà à
`creerRendreLeFil`).

Run : `npx vitest run tests/workflow-release-mba.test.ts tests/controle-du-fil-cablage.test.ts && npm run typecheck && npm test` → PASS.

- [ ] **Step 4 : mutation (copie hors dépôt)**

Retirer `{ transmettre: true }` de la branche (a) : le premier cas doit tomber. Déplacer l'appel à
`transmettreHorsParcours` AVANT `releaseToMba` : le premier cas doit tomber sur l'ordre. Restaurer : PASS.

- [ ] **Step 5 : commit**

```bash
git commit --only src/workflow/executor.ts tests/workflow-release-mba.test.ts src/workflow/wiring.ts -m "feat(mba): la reponse a cote du client part chez l agent de Meta quand le scenario lui rend la main"
git push origin main
```

### Task 19 : documentation du lot 4, `/revue`

- [ ] `/revue` sur le diff du lot 4 (rayon de souffle : `demanderReleaseMba` sert TOUTES les fins de parcours ;
  relire `tests/controle-fil-scenario-rendu.test.ts` et `tests/workflow-release-mba.test.ts` en cherchant une
  hypothèse sur l'ancien marqueur).
- [ ] `documentation.md` : la règle du marqueur (dernier message du fil, non acquitté), `accuse_le`, la
  transmission par `agent_event`. `features.md` : la réponse « à côté ». `CLAUDE.md` : mettre à jour le paragraphe
  de 0149 (« LE MARQUEUR RESTE JUSTE ») d'une phrase qui renvoie à 0162. Commit `--only` après relecture des diffs.

### Task 20 : second déploiement et essai réel

- [ ] `gh run list` puis `gh run view <id> --json jobs` : vert.
- [ ] `/revue-finale` jusqu'à `COUVERT`.
- [ ] VPS : `git pull`, `sudo docker compose up -d --build mba-api mba-worker` (aucune migration neuve), contrôle
  public 200 (et `nginx -s reload` en cas de 502).
- [ ] Essai réel, second temps (section « Méthode de livraison ») avec Julien ; lire M1 pendant l'essai.
- [ ] `docs/JOURNAL-TECHNIQUE.md` (le récit : mesures, essais, écarts), `wip.md` vidé du chantier, `features.md`
  en live, `/sync`.
