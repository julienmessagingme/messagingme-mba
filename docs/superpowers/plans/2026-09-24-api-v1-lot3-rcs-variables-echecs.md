# API publique v1, lot 3 : RCS, variables par destinataire, échecs des messages libres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** donner le RCS à l'API publique (cible `rcsMessage` de `/v1/sends`, route `POST /v1/messages/rcs` qui partage son chemin avec le bouton RCS de l'Inbox), porter des variables propres à chaque destinataire jusqu'à l'envoi, et cesser de perdre en silence l'échec de livraison d'un message libre (défaut 4 de la spec) : journal des erreurs, joignabilité RCS.

**Architecture:** trois morceaux, chacun derrière une fonction pure ou un store testé. (1) Les variables : une source de paramètre `{ type: 'variable', key }` dans `src/crm/template.ts`, une colonne `campaign_recipients.variables` écrite à la construction et relue à l'envoi RCS et au renvoi F7. (2) L'envoi RCS libre : `envoyerRcsLibre` (`src/rcs/envoyer-libre.ts`), un seul chemin pour l'Inbox (opérateur) et l'API (machine), les gardes de machine (consentement, STOP général, joignabilité connue) ne visant que la machine, pour que le bouton de l'Inbox reste identique ; la route `/v1/messages/rcs` ne fait que résoudre la fiche, traduire les refus, puis ouvrir le fil AVANT de le prendre. (3) Les échecs : `PgEchecsMessagesStore` (`src/delivery/echecs-messages.pg.ts`) est nourri par `processStatuses` (Meta) et par `traiterRapportRcs` (smsmode, extrait de `onDlr`) SEULEMENT sur un échec qui n'a touché aucun destinataire de campagne (et, côté smsmode, même quand le rapport devance l'inscription du message, `noterSansMessage`) ; le rapport smsmode écrit aussi la joignabilité RCS ; le journal des erreurs lit la nouvelle table en quatrième source ; la purge RGPD efface ce que le lot ajoute.

**Tech Stack:** TypeScript (ESM, `verbatimModuleSyntax`), Fastify 5, zod 4 (`safeParse` seulement), pg, pg-boss, vitest 2, Next.js (console `web/`).

**Spec:** docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md (§ 3 cible `rcsMessage` et variables, § 4 partie RCS, § 5, § 9, § 11, § 13, § 14, § 17).

**Lots précédents consommés :** lot 1 (identité et contacts : `src/api/fiche.ts`, `src/api/consentement.ts`, `src/api/erreurs.ts`) et lot 2 (envois refondus : `src/workflow/ouverture-api.ts`, `src/api/suivi-envoi.ts`, `src/api/sends-build.ts`, `src/api/idempotence.ts`, `EnvoiApiBrut` et `lireEnvoiApi` dans `src/campaign/store.pg.ts`, `POST /v1/messages/whatsapp`). 🔴 **Le code du lot 2 est celui de son plan, `docs/superpowers/plans/2026-09-24-api-v1-lot2-envois.md`** (Tasks 5 à 9) : la Task 10 de ce lot-ci en cite le texte exact comme ancrage, et la Task 0 vérifie que chaque ancrage est bien sur `main`. Ce lot ne produit rien que les lots 1 et 2 lisent.

---

## Global Constraints

**Conventions du dépôt (CLAUDE.md global et projet), à tenir dans chaque tâche :**

- Toute entrée non fiable (corps HTTP, rapport de fournisseur) passe par zod `safeParse`, jamais `parse`, jamais un `as` sur le payload.
- `tenant_id = $1` sur CHAQUE requête, sauf l'exception déjà documentée du dépôt : une écriture déclenchée par un accusé de Meta, qui ne connaît qu'un identifiant de message unique dans toute la base (`consommerReleaseMba`). `PgEchecsMessagesStore.noter` en relève et le dit ; quand l'espace est connu (rappel smsmode), il est passé et filtré.
- Tout ajout sur `processStatuses` et `onDlr` est BEST-EFFORT (`try/catch` + `console.error`) : une exception y ferait rejouer tout le job par pg-boss, ou rendre 5xx à smsmode qui rejouerait le rappel. Un statut ordinaire (`sent`, `delivered`, `read` chez Meta) ne coûte AUCUNE requête de plus.
- Une dépendance de sécurité n'est jamais optionnelle (`estDesabonne` est requise dans `DepsRcsLibre`) ; un puits qu'on peut omettre est un puits qu'on oublie (`echecsLibres` est requis, comme `tarifs`).
- Un test de non-régression se vérifie DANS LES DEUX SENS : remettre le code fautif, voir l'échec ET son symptôme, restaurer. Une assertion d'ABSENCE s'accompagne toujours d'une ancre POSITIVE prouvant que le mécanisme a tourné.
- Aucun compteur calculable recopié en prose. Aucun tiret cadratin ni demi-cadratin dans le code, les commentaires, les messages d'erreur et la doc. Ne jamais écrire le nom de l'infrastructure sous-jacente de messagingme.app. Aucun outil tiers nommé dans un texte destiné à l'intégrateur (messages d'erreur de l'API).
- Dans un commentaire SQL `--` À L'INTÉRIEUR d'un gabarit de chaîne TypeScript : aucun accent grave (il fermerait le gabarit). Les noms s'écrivent nus.
- Avant d'écrire un helper, chercher s'il existe (`grep`) ; les points de passage partagés sont listés dans `documentation.md` § 13.

**Tests :**

- Unitaire : `npx vitest run <fichier>` ; lot complet : `npm test` ; types : `npm run typecheck`.
- 🔴 Les tests d'INTÉGRATION (`tests/integration/*.integration.test.ts`) ne se lancent JAMAIS en local : le `DATABASE_URL` du `.env` local est la base de PRODUCTION. Ils s'écrivent, et leur verdict se lit sur le run GitHub après le push, job par job : `gh run list --limit 5` puis `gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'`. Jamais le code de sortie de `gh run watch` (il a rendu 0 sur un run en échec le 2026-09-07). Pour une tâche dont le seul test est d'intégration, le « rouge » local est `npm run typecheck` qui échoue sur le module absent.

**Commits (arbre partagé par plusieurs sessions) :**

- 🔴 **Les lots 1 et 2 commitent en PLOMBERIE** (procédure P du lot 1, `docs/superpowers/plans/2026-09-24-api-v1-lot1-identite-contacts.md`, § « Procédure de commit P »), qui ne fait JAMAIS avancer le `main` local. Quand ce lot commence, le `main` local est donc en retard sur `origin/main` : un `git commit --only` s'y poserait sur une base périmée, et `git push origin main` serait refusé (ou pousserait les commits locaux non poussés d'une autre session). Contrôle au début de chaque commit : `git fetch -q origin && test "$(git rev-parse main)" = "$(git rev-parse origin/main)"`. S'il échoue (le cas attendu après les lots 1 et 2), le commit de la tâche passe par la procédure P du lot 1 (et P' pour `CLAUDE.md`), avec les MÊMES chemins (`CHEMINS`) et le MÊME message que le gabarit ci-dessous, qui ne sert alors plus qu'à les donner. Jamais `git pull`, `git merge` ni `git reset` dans l'arbre partagé pour « rattraper » `main`.
- Jamais `git add` puis `git commit` nu. Un fichier NEUF est déclaré par `git add -N <fichier>` (intention d'ajout, rien n'est mis en scène pour les autres sessions), puis tout part par `git commit --only <chemins que la tâche a touchés>`.
- La liste des chemins se construit depuis ce que la tâche a touché, JAMAIS depuis `git status`, et elle vit dans la variable `CHEMINS` de la commande de commit. Contrôle d'intrus sur la LISTE, dans la même commande : `test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0`. ⚠️ C'est `test` qui juge, et pas le code de sortie de `grep` : `grep -c` rend le code 1 quand il compte 0, donc une chaîne `&&` posée directement derrière lui s'arrêterait justement dans le BON cas. Contrôle d'intrus sur le CONTENU : `git diff -- $CHEMINS` relu dans la MÊME commande que le `git commit`, en cherchant une ligne qui n'est pas de la tâche.
- 🔴 **L'état du shell ne persiste pas d'un appel à l'autre : chaque commande de commit est AUTONOME.** Le message s'écrit dans un fichier temporaire NEUF, créé par la même commande (`MSG="$(mktemp)"` puis un here-document), jamais dans un fichier réutilisé : un `-F` reprend sans broncher un fichier périmé. Sa première ligne s'affiche avant le commit, et il se termine par la ligne `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Le gabarit, que chaque tâche remplit (le here-document commence à la ligne qui suit la commande) :

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="<les chemins de la tâche>" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N <les fichiers NEUFS de la tâche> \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
<titre>

<corps>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

Une tâche qui ne crée aucun fichier retire la ligne `git add -N`.
- 🔴 Fichiers de CÂBLAGE PARTAGÉ (`src/index.ts`, `src/server.ts`, `src/worker.ts`) : AVANT de les éditer, annonce aux autres sessions (`ListAgents`, puis `SendMessage` à chacune : « Lot 3 API : j'édite <fichier> (<quoi>), commit dans ~15 min »). Juste avant le commit, `git diff -- <fichier>` : s'il porte une ligne étrangère, ne pas utiliser `--only` ; construire le commit en plomberie comme le prescrit le CLAUDE.md du projet (`GIT_INDEX_FILE` temporaire hors du dépôt, `git read-tree origin/main`, blob reconstruit depuis `git show origin/main:<fichier>` plus ses seules lignes, `git hash-object -w`, `git update-index --add --cacheinfo`, `git write-tree`, `git commit-tree -p origin/main -F "$MSG"`, `git push origin <sha>:main`, le tout dans UNE commande qui crée elle-même `MSG="$(mktemp)"` et son here-document, comme le gabarit ci-dessus).
- Le hook `rayon-de-souffle.js` refuse le premier `git commit` pour afficher les dépendants : les lire, puis RELIRE `git diff -- <chemins>` avant de relancer (l'arbre a pu changer entre les deux).
- Push : `git push origin main`, tout sur `main`, aucune branche, aucun worktree. S'il est refusé (origin a bougé), ne pas rebaser dans l'arbre partagé : reconstruire le commit en plomberie (recette ci-dessus).

**Migrations :** le numéro se prend AU MOMENT D'ÉCRIRE (`ls db/migrations | tail -1`, le dossier tranche sur ce qui est PRIS) et se recontrôle contre `origin` juste avant le commit (`git fetch origin && git ls-tree --name-only origin/main db/migrations/ | tail -1`). La ligne du compteur de `CLAUDE.md` se met à jour DANS le commit qui prend le numéro. `<N>` et `<N+1>` désignent les deux numéros pris à la Task 1, reportés tels quels dans TOUT le lot, commentaires de code et messages de commit compris. Les deux migrations de ce lot sont additives, BLOQUANTES toutes les deux (la création et le run de campagne nomment la première, la purge RGPD nomme la seconde), et passent AVANT le déploiement du code qui les écrit ; elles se relisent en base juste après `migrate`.

---

### Task 0: Vérifier le contrat consommé (lecture seule)

**Files:** aucun écrit.

**Interfaces:**
- Consumes (lot 1) : `resoudreFiche(deps: DepsFiche, tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>`, `schemaClesFiche` (un `z.object`), `ClesFiche`, `ResolutionFiche`, `refuser(reply, statut, code, message)`, `CodeApi`.
- Consumes (lot 2, texte exact de son plan) : `formaterSuiviEnvoi(b: EnvoiApiBrut): SuiviEnvoiApi`, `CibleSuivi` (qui porte déjà `{ rcsMessage: string | null }`), `cibleDe` (qui juge déjà le CANAL avant le template et rend `{ rcsMessage: null }` pour une campagne RCS), `ouvertureDe` (`src/api/suivi-envoi.ts`) ; `EnvoiApiBrut` (qui porte déjà `channel: 'whatsapp' | 'rcs'`), `PgCampaignRepo.lireEnvoiApi`, `ContactEnvoi { bloque; rcsDesabonne }` ; `DestinataireResolu`, `trierDestinataires`, `construireDestinataires(category, params, tri, now)` (`src/api/sends-build.ts`) ; dans `src/http/v1-sends.ts` : `schemaCible`, `schemaDestinataire`, `PRECISIONS`, `CibleDemandee`, `CibleResolue`, `lireCible`, `numeroDEnvoi`, `resoudreCible`, `resoudreDestinataires`, et le corps de `POST /v1/sends` (claim d'idempotence AVANT le numéro et la cible, `libererEtRefuser`) ; le câblage `resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o)` (blocs `sends` et `messages` de `src/index.ts`, `contactStore` servant de `DepsFiche`) ; `POST /v1/messages/whatsapp`.

- [ ] **Step 1: Vérifier que les symboles existent sur `main`**

```bash
cd /c/Users/julie/messagingme-mba && git fetch origin && git log --oneline -3 origin/main
grep -n "export async function resoudreFiche\|export const schemaClesFiche\|export interface ClesFiche\|export type ResolutionFiche\|export type ModeCreation\|DepsFiche" src/api/fiche.ts
grep -n "export function refuser\|export type CodeApi" src/api/erreurs.ts
for c in unauthorized invalid_body invalid_recipient invalid_phone unknown_contact identity_conflict blocked_contact opted_out no_consent no_phone rcs_unreachable rcs_not_enabled rcs_message_not_found unsendable_target missing_variable; do grep -q "'$c'" src/api/erreurs.ts && echo "ok $c" || echo "MANQUE $c"; done
grep -n "export function formaterSuiviEnvoi(b: EnvoiApiBrut)\|^export type CibleSuivi\|  | { rcsMessage: string | null };\|^function cibleDe\|^function ouvertureDe\|  if (b.channel === 'rcs') return { rcsMessage: null };" src/api/suivi-envoi.ts
grep -n "^export interface EnvoiApiBrut\|  channel: 'whatsapp' | 'rcs';\|async lireEnvoiApi(campaignId: string, tenantId: string)\|select c.id, c.status, c.created_at, c.channel, c.template_name\|      channel: t.channel === 'rcs' ? 'rcs' : 'whatsapp',\|async listContactsPourEnvoiApi" src/campaign/store.pg.ts
grep -n "^export interface ContactEnvoi" src/campaign/build.ts
grep -n "^export type DestinataireResolu\|^export function trierDestinataires\|^export function construireDestinataires\|eligibles.push({ index: r.index, contact: c });\|const built = buildRecipients(category, params, tri.eligibles.map((x) => x.contact), { now });" src/api/sends-build.ts
for a in "^const schemaCible = z.union" "^const schemaDestinataire = z.object" "^type CibleDemandee" "^interface CibleResolue" "^function lireCible" "^async function numeroDEnvoi" "^async function resoudreCible" "^async function resoudreDestinataires" "const { consent, consentSource, ...cles } = d.data;" "const numero = await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);" "const params = validateParamMapping(corps.params ?? \[\]);" "construireDestinataires(cible.category, params, tri, new Date());" "name: \`\[API\] \${cible.label}\`.slice(0, 120)"; do grep -q "$a" src/http/v1-sends.ts && echo "ok $a" || echo "MANQUE $a"; done
grep -n "export type OuvertureApi" src/workflow/ouverture-api.ts
grep -n "'/v1/messages/whatsapp'" src/http/v1-messages.ts
grep -c "resoudreFiche(contactStore, tenant, cles, o)" src/index.ts
```

Expected: chaque `grep -n` rend au moins une ligne (et les deux derniers, une ligne par motif) ; les deux boucles ne rendent que des lignes `ok` ; le dernier `grep -c` rend `2` (les blocs `sends` et `messages` du lot 2, liés au MÊME dépôt `contactStore`, que la Task 9 reprend tel quel). Un `MANQUE`, un symbole absent ou un autre compte : ARRÊTER et le signaler, ce lot ne peut pas commencer (le lot 2 s'est écarté de son plan, et les ancrages de la Task 10 seraient faux).

---

### Task 1: Les deux migrations, et le compteur

**Files:**
- Create: `db/migrations/<N>_variables_destinataire.sql`
- Create: `db/migrations/<N+1>_echecs_messages.sql`
- Modify: `CLAUDE.md` (section « Déploiement », le paragraphe qui commence par « **Dernière appliquée : »)

**Interfaces:**
- Produces : colonne `campaign_recipients.variables jsonb` nullable sans défaut ; table `echecs_messages (id, tenant_id, message_id, wa_id, canal, origine, code, motif, at)`, index unique `echecs_messages_message_uidx (message_id)`, index `echecs_messages_tenant_at_idx (tenant_id, at desc)`.

- [ ] **Step 1: Prendre les deux numéros**

```bash
cd /c/Users/julie/messagingme-mba && ls db/migrations | tail -1 && git fetch origin && git ls-tree --name-only origin/main db/migrations/ | tail -1
```

Expected: deux noms. Le plus grand des deux numéros, plus un, est `<N>` ; `<N+1>` le suit. Exemple : si la sortie est `0174_...`, alors `<N>` = `0175` et `<N+1>` = `0176`. Remplacer `<N>` et `<N+1>` partout dans cette tâche.

- [ ] **Step 2: Écrire `db/migrations/<N>_variables_destinataire.sql`**

```sql
-- <N>_variables_destinataire.sql : les variables propres à UN destinataire d'un envoi de l'API publique.
--
-- Spec 2026-09-24 (API publique cohérente), § 3 et § 11, lot 3. Un intégrateur passe, destinataire par
-- destinataire, des valeurs qui n'ont rien à faire sur la fiche (un numéro de commande, un montant) :
-- recipients[].variables. Elles ne sont JAMAIS écrites sur la fiche du contact.
--
-- Deux lecteurs :
--   - un message RCS les relit À L'ENVOI (makeCampaignSender) : {{commande}} prend la variable du
--     destinataire, sinon le champ de fiche du même nom ;
--   - le renvoi d'un destinataire en échec de variable (F7, resetRecipientForRetry) re-résout le template :
--     sans elles, une source « variable » y manquerait toujours.
-- Un template les résout à la CONSTRUCTION dans resolved_params, comme aujourd'hui.
-- La purge RGPD (PgContactStore.purgeMany) la remet à null avec les autres données du destinataire : un
-- numéro de commande ou un montant désignent la personne autant que son prénom.
--
-- Nullable SANS défaut : null = « ce destinataire n'en porte pas », le cas de tous les destinataires d'avant
-- et de toute campagne créée par la console. Une colonne nullable sans défaut ne réécrit aucune ligne.
--
-- 🔴 BLOQUANTE POUR LE CODE, DONC AVANT LE DÉPLOIEMENT. bulkInsertRecipients l'écrit (TOUTE création de
-- campagne, console comprise) et listPending la lit (TOUT run de campagne) : déployer d'abord ferait tomber
-- chaque création et chaque envoi de campagne en 42703. L'ancien code ne la nomme pas et y survit.

alter table campaign_recipients add column if not exists variables jsonb;
```

- [ ] **Step 3: Écrire `db/migrations/<N+1>_echecs_messages.sql`**

```sql
-- <N+1>_echecs_messages.sql : l'échec de livraison d'un message LIBRE cesse de n'être écrit nulle part.
--
-- Spec 2026-09-24 (API publique cohérente), § 5, lot 3, « défaut 4 ». Le rapport de smsmode et les statuts
-- de Meta ne mettaient à jour que les destinataires de CAMPAGNE : une réponse de l'Inbox, un RCS libre ou
-- un message de l'API qui n'arrivait pas n'apparaissait ni dans Sécurité > Journal des erreurs, ni ailleurs.
--
-- 🔴 UNE TABLE, ET PAS UNE COLONNE DE STATUT SUR conversation_messages. Seuls les ÉCHECS sont écrits : la
-- table reste petite, sur le modèle des échecs d'avance de scénario (0108), et le fil de l'Inbox, relu toutes
-- les 4 secondes, ne gagne aucune jointure. Ce n'est pas un doublon : ces échecs n'avaient aucun domicile.
--
-- Les colonnes wa_id, canal et origine sont RECOPIÉES du message au moment de l'échec : la ligne reste
-- lisible sans jointure sur conversation_messages, et la lecture du journal n'en fait aucune.
--
-- 🔴 L'INDEX UNIQUE SUR message_id REND L'ÉCRITURE IDEMPOTENTE, et l'écriture en DÉPEND : pg-boss rejoue un
-- job de statuts en entier, et « on conflict (message_id) do nothing » exige une contrainte qui corresponde
-- à la cible du conflit (sans elle, l'insertion LÈVE). L'identifiant d'un message est unique dans toute la
-- base (conversation_messages_wamid_uidx, 0009).
--
-- 🔴 BLOQUANTE, À CAUSE DE LA PURGE RGPD. L'écriture est best-effort chez l'appelant et la lecture du journal
-- rend une liste vide si la table manque, mais PgContactStore.purgeMany efface les échecs de la personne DANS
-- SA transaction : sans la table, TOUTE purge de contact échouerait en entier (42P01), comme pour 0163. Donc
-- AVANT le déploiement, avec la migration précédente. L'ancien code ne la nomme pas et y survit.
--
-- Rétention : la même que les échecs d'avance (AVANCE_ECHECS_RETENTION_DAYS), par le balayage général du
-- worker. C'est de l'exploitation, pas une preuve.

create table if not exists echecs_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  message_id text not null,
  wa_id text not null,
  canal text not null,
  -- La colonne origin du message (humain, api, mcp, scenario, ia, mba). Nullable : un message d'avant 0099
  -- n'en porte pas.
  origine text,
  -- Code numérique de Meta. null pour un échec smsmode, qui n'en donne pas.
  code integer,
  motif text,
  at timestamptz not null default now()
);

create unique index if not exists echecs_messages_message_uidx on echecs_messages (message_id);

-- La lecture est toujours « les plus récents d'un espace » (journal des erreurs) : exactement cet index.
create index if not exists echecs_messages_tenant_at_idx on echecs_messages (tenant_id, at desc);
```

- [ ] **Step 4: Mettre à jour le compteur de `CLAUDE.md`, dans ce même commit**

D'abord, s'assurer que `CLAUDE.md` ne porte pas le travail non commité d'une autre session :

```bash
cd /c/Users/julie/messagingme-mba && git diff --stat -- CLAUDE.md
```

Expected: aucune ligne. Si le fichier est modifié : `SendMessage` à la session qui l'édite, attendre son commit, `git fetch origin`, puis reprendre ce step.

Puis, dans le paragraphe de la section « Déploiement » qui commence par « **Dernière appliquée : », remplacer la phrase « **ÉCRITE ET PAS ENCORE APPLIQUÉE : ... » et la phrase « **Prochaine libre = ... » par (en gardant les numéros écrits par les lots 1 et 2 s'ils sont encore « écrits et pas encore appliqués ») :

```markdown
**ÉCRITES ET PAS ENCORE APPLIQUÉES : <N>** (`variables_destinataire`, `campaign_recipients.variables` ;
BLOQUANTE, la création de campagne l'écrit et chaque run la lit, donc AVANT le `up`) **et <N+1>**
(`echecs_messages`, les échecs de livraison des messages libres ; additive, BLOQUANTE elle aussi : la purge RGPD
l'efface dans sa transaction, donc AVANT le `up`). Lot 3 de l'API publique. **Prochaine libre = <N+2>**, et le
dossier `db/migrations/` s'arrête à <N+1>.
```

- [ ] **Step 5: Vérifier que rien d'autre n'a bougé**

```bash
cd /c/Users/julie/messagingme-mba && npm run typecheck && npx vitest run tests/migration-directives.test.ts
```

Expected: PASS (les deux fichiers sont transactionnels, sans directive `-- migrate:`).

- [ ] **Step 6: Commit**

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="db/migrations/<N>_variables_destinataire.sql db/migrations/<N+1>_echecs_messages.sql CLAUDE.md" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N db/migrations/<N>_variables_destinataire.sql db/migrations/<N+1>_echecs_messages.sql \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(api,db): migrations du lot 3, variables par destinataire et échecs des messages libres

<N> ajoute campaign_recipients.variables (bloquante : écrite par la création, lue par chaque run).
<N+1> crée echecs_messages, idempotente par son index unique sur message_id (bloquante : la purge RGPD la nomme).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: La source de paramètre `variable`

**Files:**
- Modify: `src/crm/template.ts` (lignes 3 à 7 `ParamSource`, ligne 16 `ResolveOpts`, lignes 38 à 46 `isValidSource`, ligne 55 `validateParamMapping` et, ligne 62, son appel à `isValidSource`, lignes 98 à 122 `valueOf` ; relevées sur `main` avant le lot, les ancres textuelles citées aux étapes font foi)
- Test: `tests/template-source-variable.test.ts`

**Interfaces:**
- Produces : `ParamSource` gagne `{ type: 'variable'; key: string }` ; `export const CLE_VARIABLE: RegExp` ; `ResolveOpts.variables?: Readonly<Record<string, string>>` ; `validateParamMapping(raw: unknown, options?: { accepterVariables?: boolean }): TemplateParam[] | null`.
- Inchangé : `parseParamHints` (les indices de la console refusent `variable`), `resolveHintParams`.

- [ ] **Step 1: Écrire le test qui échoue**

`tests/template-source-variable.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { validateParamMapping, parseParamHints, resolveTemplateParams } from '../src/crm/template';

/**
 * LA SOURCE « variable » (spec 2026-09-24, § 3, lot 3) : un paramètre de template lu dans les variables
 * du DESTINATAIRE d'un envoi de l'API, jamais sur sa fiche.
 */
describe('la source de paramètre « variable »', () => {
  const mapping = [{ position: 1, source: { type: 'variable', key: 'commande' } }];

  it('🔴 la console la REFUSE : une variable de destinataire n’existe que dans un envoi de l’API', () => {
    expect(validateParamMapping(mapping)).toBeNull();
  });

  it('l’API l’accepte, avec un nom de variable bien formé seulement', () => {
    expect(validateParamMapping(mapping, { accepterVariables: true })).toEqual(mapping);
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: 'a b' } }], { accepterVariables: true })).toBeNull();
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: '' } }], { accepterVariables: true })).toBeNull();
    expect(validateParamMapping([{ position: 1, source: { type: 'variable', key: 'x'.repeat(65) } }], { accepterVariables: true })).toBeNull();
  });

  it('🔴 un indice de template (posé dans la console) ne peut pas être une variable', () => {
    expect(parseParamHints([{ position: 1, source: { type: 'variable', key: 'commande' } }])).toBeNull();
  });

  it('résout la variable du destinataire', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: { commande: '8412' } })).toEqual({ values: ['8412'], missing: [] });
  });

  it('absente et sans repli : position manquante, donc destinataire écarté en amont', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: [''], missing: [1] });
    expect(resolveTemplateParams(p, {})).toEqual({ values: [''], missing: [1] });
  });

  it('absente AVEC repli : le repli part', () => {
    const p = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'commande' }, fallback: 'votre commande' }], { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: ['votre commande'], missing: [] });
  });

  it('🔴 un nom hérité du prototype n’est pas une variable', () => {
    const p = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'constructor' } }], { accepterVariables: true })!;
    expect(resolveTemplateParams(p, {}, { variables: {} })).toEqual({ values: [''], missing: [1] });
  });

  it('ne lit JAMAIS la fiche : un champ du même nom ne remplace pas la variable absente', () => {
    const p = validateParamMapping(mapping, { accepterVariables: true })!;
    expect(resolveTemplateParams(p, { fields: { commande: 'depuis la fiche' } }, { variables: {} }).missing).toEqual([1]);
  });
});
```

- [ ] **Step 2: Le voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/template-source-variable.test.ts`
Expected: FAIL, dont « l’API l’accepte » (`expected null to deeply equal [...]`) et « résout la variable du destinataire ».

- [ ] **Step 3: Implémenter**

Dans `src/crm/template.ts`, remplacer le type `ParamSource` (lignes 3 à 7) par :

```ts
export type ParamSource =
  | { type: 'field'; key: string }
  | { type: 'attribute'; key: 'name' | 'phone' | 'bsuid' | 'wa_id' }
  | { type: 'now' }
  | { type: 'literal'; value: string }
  /**
   * UNE VARIABLE DU DESTINATAIRE, passée par l'API publique dans `recipients[].variables` (spec 2026-09-24,
   * § 3, lot 3). Elle ne vit que le temps d'un envoi et n'est JAMAIS écrite sur la fiche.
   *
   * 🔴 ACCEPTÉE SEULEMENT LÀ OÙ ELLE A UN SENS (`validateParamMapping(..., { accepterVariables: true })`,
   * appelé par `/v1/sends`). La console et les indices de template la refusent : un mapping de campagne de
   * la console qui la porterait écarterait TOUS ses destinataires en `missing_variable`, puisqu'aucun n'a de
   * variables.
   */
  | { type: 'variable'; key: string };

/**
 * Le nom d'une variable de destinataire. La MÊME classe de caractères que les `{{nom}}` d'un message RCS
 * (`MOTIF`, `src/rcs/variables.ts`) : une variable nommée ici doit pouvoir y être appelée.
 */
export const CLE_VARIABLE = /^[A-Za-z0-9_.-]{1,64}$/;
```

Remplacer `export interface ResolveOpts { now?: Date; tz?: string }` par :

```ts
export interface ResolveOpts {
  now?: Date;
  tz?: string;
  /** Les variables du destinataire (source `variable`). Absentes = aucune, donc toute source `variable` manque. */
  variables?: Readonly<Record<string, string>>;
}
```

Dans `isValidSource`, remplacer ses trois premières lignes de corps et sa signature :

```ts
function isValidSource(s: unknown, accepterVariables = false): s is ParamSource {
  if (typeof s !== 'object' || s === null) return false;
  const src = s as { type?: unknown; key?: unknown; value?: unknown };
  if (src.type === 'variable') return accepterVariables && typeof src.key === 'string' && CLE_VARIABLE.test(src.key);
  if (src.type === 'literal') return typeof src.value === 'string';
```

Remplacer la signature de `validateParamMapping` :

```ts
export function validateParamMapping(raw: unknown, options: { accepterVariables?: boolean } = {}): TemplateParam[] | null {
```

et, dans son corps, la ligne `    if (!isValidSource(p.source)) return null;` par :

```ts
    if (!isValidSource(p.source, options.accepterVariables === true)) return null;
```

Dans `valueOf`, remplacer la fin du `switch` :

```ts
    case 'field':
      return c.fields?.[source.key];
  }
}
```

par :

```ts
    case 'field':
      return c.fields?.[source.key];
    case 'variable':
      // `Object.hasOwn` et pas une lecture directe : `constructor` est un nom de variable valide, et
      // `{}['constructor']` rendrait la fonction du prototype, envoyée ensuite en texte à Meta.
      return opts?.variables && Object.hasOwn(opts.variables, source.key) ? opts.variables[source.key] : undefined;
  }
}
```

- [ ] **Step 4: Le voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/template-source-variable.test.ts && npm run typecheck && npm test`
Expected: PASS partout. (`src/index.ts` lit `src.key` après avoir écarté `now` et `literal` : la nouvelle forme porte un `key`, le compilateur l'accepte.)

- [ ] **Step 5: Commit**

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/crm/template.ts tests/template-source-variable.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N tests/template-source-variable.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(api): la source de paramètre « variable », refusée par la console

Un paramètre de template lu dans les variables du destinataire d'un envoi de l'API, jamais sur sa fiche.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Les variables voyagent jusqu'à l'envoi

**Files:**
- Modify: `src/campaign/build.ts` (interfaces `BuildContact` lignes 6 à 11 et `BuiltRecipient` lignes 13 à 17, corps de `buildRecipients` lignes 72 et 77, relevées avant le lot 2 ; le `ContactEnvoi` que le lot 2 insère après `BuildContact` les décale : les ancres textuelles citées font foi)
- Modify: `src/campaign/types.ts` (interface `Recipient`, lignes 68 à 92)
- Modify: `src/campaign/store.pg.ts` (`resetRecipientForRetry` lignes 682 à 711, `bulkInsertRecipients` lignes 1501 à 1518, `listPending` lignes 1620 à 1645, relevées avant le lot 2, qui insère `EnvoiApiBrut` et deux méthodes au-dessus : s'appuyer sur les noms)
- Modify: `src/rcs/variables.ts` (ajout après `appliquerVariables`)
- Modify: `src/campaign/sender.ts` (lignes 1 à 6, 21, 56 à 61)
- Test: `tests/campagne-variables-destinataire.test.ts`
- Test: `tests/integration/variables-destinataire.integration.test.ts`

**Interfaces:**
- Consumes : `ResolveOpts.variables` (Task 2), colonne `campaign_recipients.variables` (Task 1).
- Produces : `BuildContact.variables?: Readonly<Record<string, string>>` ; `BuiltRecipient.variables?: Readonly<Record<string, string>>` ; `Recipient.variables?: Readonly<Record<string, string>> | null` ; `fusionnerVariables(fiche: Readonly<Record<string, string | null>>, destinataire: Readonly<Record<string, string>> | null | undefined): Record<string, string | null>` ; `CampaignSender.sendTo(recipient: Pick<Recipient, 'id' | 'toE164' | 'variables'>, jeton?: string)`.

- [ ] **Step 1: Écrire les tests qui échouent**

`tests/campagne-variables-destinataire.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { buildRecipients, type BuildContact } from '../src/campaign/build';
import { makeCampaignSender } from '../src/campaign/sender';
import { RcsSender } from '../src/rcs/sender';
import { Reachability, type ReachabilityStore } from '../src/rcs/reachability';
import { FakeRcsProvider } from '../src/rcs/fake';
import { fusionnerVariables } from '../src/rcs/variables';
import { validateParamMapping } from '../src/crm/template';

const fiche = (id: string, over: Partial<BuildContact> = {}): BuildContact => ({
  id, phone_e164: `+3361234567${id.slice(-1)}`, bsuid: null, profile_name: null, fields: {}, optInStatus: 'opted_in', ...over,
});

describe('buildRecipients : les variables du destinataire', () => {
  const mapping = validateParamMapping([{ position: 1, source: { type: 'variable', key: 'commande' } }], { accepterVariables: true })!;

  it('résout le template sur SES variables, et les garde pour l’envoi', () => {
    const r = buildRecipients('utility', mapping, [fiche('c1', { variables: { commande: '8412' } })], { now: new Date() });
    expect(r.skipped).toEqual([]);
    expect(r.recipients).toEqual([{ contactId: 'c1', toE164: '+33612345671', resolvedParams: ['8412'], variables: { commande: '8412' } }]);
  });

  it('variable absente : écarté en missing_variable, comme un champ vide', () => {
    const r = buildRecipients('utility', mapping, [fiche('c2')], { now: new Date() });
    expect(r.recipients).toEqual([]);
    expect(r.skipped).toEqual([{ contactId: 'c2', toE164: '+33612345672', reason: 'missing_variable', missing: [1] }]);
  });

  it('🔴 un destinataire sans variables ne porte AUCUNE clé `variables` : la console écrit ce qu’elle écrivait', () => {
    const r = buildRecipients('utility', [], [fiche('c3')], { now: new Date() });
    expect(Object.keys(r.recipients[0]!)).toEqual(['contactId', 'toE164', 'resolvedParams']);
  });
});

describe('fusionnerVariables', () => {
  it('🔴 la variable du destinataire PRIME sur le champ de fiche du même nom', () => {
    expect({ ...fusionnerVariables({ commande: 'fiche', prenom: 'Camille' }, { commande: '8412' }) }).toEqual({ commande: '8412', prenom: 'Camille' });
  });
  it('sans variables de destinataire, la table de la fiche telle quelle', () => {
    expect({ ...fusionnerVariables({ prenom: 'Camille' }, null) }).toEqual({ prenom: 'Camille' });
  });
  it('une table SANS prototype, comme contactVars', () => {
    expect(Object.getPrototypeOf(fusionnerVariables({}, {}))).toBeNull();
  });
});

class SansCache implements ReachabilityStore {
  async get() { return null; }
  async put() { /* rien */ }
}

function envoyeur() {
  const provider = new FakeRcsProvider();
  const rcs = new RcsSender(provider, new Reachability(provider, new SansCache(), () => 0), { isOptedOut: async () => false });
  return { provider, rcs };
}

describe('makeCampaignSender : un message RCS et les variables du destinataire', () => {
  it('🔴 {{commande}} prend la variable du destinataire, {{prenom}} le champ de fiche', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({
      channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs,
      message: { kind: 'text', text: 'Bonjour {{prenom}}, commande {{commande}}' },
      varsFor: async () => ({ prenom: 'Camille', commande: 'depuis la fiche' }),
    });
    await s.sendTo({ id: 'r1', toE164: '+33612345671', variables: { commande: '8412' } });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour Camille, commande 8412' });
  });

  it('sans résolution de fiche câblée, les variables du destinataire s’appliquent quand même', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({ channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs, message: { kind: 'text', text: 'Commande {{commande}}' } });
    await s.sendTo({ id: 'r2', toE164: '+33612345672', variables: { commande: '8412' } });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Commande 8412' });
  });

  it('sans variables, le message part exactement comme avant', async () => {
    const { provider, rcs } = envoyeur();
    const s = makeCampaignSender({ channel: 'rcs', tenantId: 't1', agentId: 'a1', rcs, message: { kind: 'text', text: 'Commande {{commande}}' } });
    await s.sendTo({ id: 'r3', toE164: '+33612345673' });
    expect(provider.sent[0]!.msg).toEqual({ kind: 'text', text: 'Commande {{commande}}' });
  });
});
```

`tests/integration/variables-destinataire.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgCampaignRepo, PgRecipientStore } from '../../src/campaign/store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES VARIABLES D'UN DESTINATAIRE EN BASE (migration <N>). En intégration parce que tout ce qui compte est du
 * SQL : l'écriture par `unnest`, la relecture du jsonb par `listPending`, et le renvoi F7 qui re-résout le
 * template. Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('variables de destinataire (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';
  let c1 = '';
  let c2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-variables-destinataire') returning id`)).rows[0]!.id;
    c1 = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000401', 'opted_in') returning id`, [tenantId])).rows[0]!.id;
    c2 = (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, '+33600000402', 'opted_in') returning id`, [tenantId])).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const creer = async (): Promise<string> => (await new PgCampaignRepo(pool).createWithRecipients({
    tenantId, phoneNumberId: '', name: 'itest-variables', category: 'utility',
    templateName: 'confirmation', templateLanguage: 'fr',
    paramMapping: [{ position: 1, source: { type: 'variable', key: 'commande' } }],
  }, [
    { contactId: c1, toE164: '+33600000401', resolvedParams: ['8412'], variables: { commande: '8412' } },
    { contactId: c2, toE164: '+33600000402', resolvedParams: [''] },
  ])).campaignId;

  it('🔴 écrites à la construction, relues par le run : un objet pour l’un, null pour l’autre', async () => {
    const campaignId = await creer();
    const pending = await new PgRecipientStore(pool).listPending(campaignId);
    const parContact = new Map(pending.map((r) => [r.contactId, r.variables]));
    expect(parContact.get(c1)).toEqual({ commande: '8412' });
    expect(parContact.get(c2)).toBeNull();
  });

  it('🔴 le renvoi F7 re-résout le template SUR les variables du destinataire', async () => {
    const campaignId = await creer();
    const r = (await pool.query<{ id: string }>(
      `update campaign_recipients set status = 'failed', error_code = 131009, resolved_params = '[""]'::jsonb
        where campaign_id = $1 and contact_id = $2 returning id`, [campaignId, c1])).rows[0]!;
    const reset = await new PgCampaignRepo(pool).resetRecipientForRetry(tenantId, campaignId, r.id);
    expect(reset).toEqual({ result: 'queued', campaignId });
    const apres = (await pool.query<{ resolved_params: string[] }>('select resolved_params from campaign_recipients where id = $1', [r.id])).rows[0]!;
    expect(apres.resolved_params).toEqual(['8412']);
  });
});
```

- [ ] **Step 2: Les voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/campagne-variables-destinataire.test.ts && npm run typecheck`
Expected: le test unitaire FAIL (import `fusionnerVariables` introuvable, puis les assertions) ; `typecheck` FAIL sur `variables` inconnu de `BuiltRecipient` et de `Recipient` dans le fichier d'intégration.

- [ ] **Step 3: Implémenter**

`src/campaign/build.ts`, interface `BuildContact` : ajouter après `optInStatus` :

```ts
  /**
   * Les variables propres à CE destinataire d'un envoi de l'API publique (lot 3). Jamais lues sur la fiche,
   * jamais écrites dessus : elles naissent avec l'envoi et meurent avec lui. Absentes pour la console.
   */
  variables?: Readonly<Record<string, string>>;
```

interface `BuiltRecipient` : ajouter après `resolvedParams` :

```ts
  /** Gardées avec le destinataire (migration <N>) : relues à l'envoi d'un message RCS et au renvoi F7. */
  variables?: Readonly<Record<string, string>>;
```

Dans `buildRecipients`, remplacer :

```ts
    const { values, missing } = resolveTemplateParams(paramMapping, c, opts);
```

par :

```ts
    const { values, missing } = resolveTemplateParams(paramMapping, c, c.variables ? { ...opts, variables: c.variables } : opts);
```

et :

```ts
    recipients.push({ contactId: c.id, toE164: to, resolvedParams: values });
```

par :

```ts
    // La clé n'existe QUE si le destinataire porte des variables : la console écrit ce qu'elle écrivait.
    recipients.push({ contactId: c.id, toE164: to, resolvedParams: values, ...(c.variables ? { variables: c.variables } : {}) });
```

`src/campaign/types.ts`, interface `Recipient` : ajouter après `etageCourant?: number;` :

```ts
  /**
   * Les variables propres à ce destinataire (API publique, `campaign_recipients.variables`, migration <N>).
   * `null` ou absent = aucune, le cas de toute campagne de la console. Relues par l'envoi d'un message RCS.
   */
  variables?: Readonly<Record<string, string>> | null;
```

`src/campaign/store.pg.ts`, `bulkInsertRecipients` : remplacer le bloc de `const params = ...` jusqu'à la fin de l'appel `q.query(...)` par :

```ts
  const params = recipients.map((r) => JSON.stringify(r.resolvedParams));
  // null (et pas '{}') pour un destinataire sans variables : « il n'en porte pas » reste distinguable d'un
  // objet vide, et toute campagne de la console écrit exactement ce qu'elle écrivait (migration <N>).
  const variables = recipients.map((r) => (r.variables ? JSON.stringify(r.variables) : null));
  const res = await q.query(
    `insert into campaign_recipients (campaign_id, contact_id, to_e164, resolved_params, variables)
     select $1, c, t, p::jsonb, v::jsonb
     from unnest($2::uuid[], $3::text[], $4::text[], $5::text[]) as u(c, t, p, v)
     on conflict (campaign_id, contact_id) do nothing`,
    [campaignId, contactIds, toE164s, params, variables],
  );
```

`listPending` : dans le type de ligne, ajouter après `etage_courant: number;` la ligne `variables: Record<string, string> | null;` ; dans la requête, remplacer `select id, contact_id, to_e164, resolved_params, status, etage_courant` par `select id, contact_id, to_e164, resolved_params, status, etage_courant, variables` ; dans le `map`, ajouter après `etageCourant: r.etage_courant,` la ligne `variables: r.variables,`.

`resetRecipientForRetry` : remplacer le type et la requête de lecture :

```ts
    const rec = await this.pool.query<{ contact_id: string; status: string; error_code: number | null; param_mapping: TemplateParam[] | null; variables: Record<string, string> | null }>(
      `select r.contact_id, r.status, r.error_code, c.param_mapping, r.variables
       from campaign_recipients r join campaigns c on c.id = r.campaign_id
       where r.id = $1 and r.campaign_id = $2 and c.tenant_id = $3`,
      [recipientId, campaignId, tenantId],
    );
```

et la ligne `    }, { now: new Date() });` qui clôt l'appel à `resolveTemplateParams` par :

```ts
    // 🔴 LES VARIABLES DU DESTINATAIRE REPARTENT AVEC LUI (migration <N>). Sans elles, une source
    // « variable » d'un envoi de l'API serait toujours manquante au renvoi, et le bouton « Corriger +
    // renvoyer » répondrait `missing_var` sur un destinataire parfaitement renseigné.
    }, { now: new Date(), ...(row.variables ? { variables: row.variables } : {}) });
```

`src/rcs/variables.ts`, ajouter après la fonction `appliquerVariables` :

```ts
/**
 * La table de substitution d'UN destinataire : les variables qu'il porte (API publique, spec 2026-09-24 § 3)
 * PRIMENT sur les champs de sa fiche du même nom. Construite SANS prototype, comme `contactVars`.
 */
export function fusionnerVariables(
  fiche: Readonly<Record<string, string | null>>,
  destinataire: Readonly<Record<string, string>> | null | undefined,
): Record<string, string | null> {
  const out: Record<string, string | null> = Object.create(null);
  for (const [k, v] of Object.entries(fiche)) out[k] = v;
  for (const [k, v] of Object.entries(destinataire ?? {})) out[k] = v;
  return out;
}
```

`src/campaign/sender.ts` : remplacer l'import `import { appliquerVariables } from '../rcs/variables';` par `import { aDesVariables, appliquerVariables, fusionnerVariables } from '../rcs/variables';` ; remplacer la signature de l'interface :

```ts
  sendTo(recipient: Pick<Recipient, 'id' | 'toE164' | 'variables'>, jeton?: string): Promise<SendResult | { skipped: string }>;
```

et le corps de `sendTo` dans `makeCampaignSender` :

```ts
    async sendTo(recipient, jeton) {
      // Les variables du DESTINATAIRE s'appliquent même sans résolution de fiche câblée : elles viennent de
      // l'envoi, pas de la base. La fiche ne complète que ce qu'elles ne disent pas.
      const aResoudre = o.varsFor !== undefined || (recipient.variables != null && aDesVariables(o.message));
      const message = aResoudre
        ? appliquerVariables(o.message, fusionnerVariables(o.varsFor ? await o.varsFor(o.tenantId, recipient.toE164) : {}, recipient.variables))
        : o.message;
      return o.rcs.sendTo(o.tenantId, o.agentId, recipient.toE164, message, recipient.id, jeton);
    },
```

- [ ] **Step 4: Les voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/campagne-variables-destinataire.test.ts && npm run typecheck && npm test`
Expected: PASS partout (`tests/campaign-rcs.test.ts` et `tests/campaign-build-rcs.test.ts` restent verts : aucun de leurs destinataires ne porte de variables).

- [ ] **Step 5: Commit, puis verdict de l'intégration sur la CI**

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/campaign/build.ts src/campaign/types.ts src/campaign/store.pg.ts src/rcs/variables.ts src/campaign/sender.ts tests/campagne-variables-destinataire.test.ts tests/integration/variables-destinataire.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N tests/campagne-variables-destinataire.test.ts tests/integration/variables-destinataire.integration.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(api,campagne): les variables d'un destinataire voyagent jusqu'à l'envoi RCS et au renvoi F7

Écrites par bulkInsertRecipients (migration <N>), relues par listPending et resetRecipientForRetry ; un message
RCS les fait primer sur le champ de fiche du même nom.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Expected: le job `integration` en `success` (la migration <N> est appliquée par la CI avant les tests).

---

### Task 4: Le store des échecs de messages libres, et la purge RGPD de ce que le lot ajoute

**Files:**
- Create: `src/delivery/echecs-messages.pg.ts`
- Modify: `src/ops/erreurs-livraison.pg.ts` (interface `ErreurLivraison` lignes 34 à 58, interface `FiltreErreurs` ligne 82 : types seulement)
- Modify: `src/crm/contact-store.pg.ts` (`purgeMany`, lignes 1062 et suivantes : l'`update campaign_recipients` et un `delete` ajouté après celui de `webhook_events`)
- Test: `tests/integration/echecs-messages.integration.test.ts`
- Test: `tests/integration/purge-rgpd.integration.test.ts` (import, fin du `beforeAll`, deux cas)

**Interfaces:**
- Consumes : colonne `campaign_recipients.variables` et `BuiltRecipient.variables` (Tasks 1 et 3), table `echecs_messages` (Task 1).
- Produces :
  - `export interface EchecMessageLibre { messageId: string; code: number | null; motif: string | null; tenantId?: string }`
  - `export interface EchecSansMessage { messageId: string; tenantId: string; waId: string; canal: 'whatsapp' | 'rcs'; code: number | null; motif: string | null }`
  - `export interface EchecEcrit { tenantId: string; waId: string; canal: string; origine: string | null }`
  - `export class PgEchecsMessagesStore { noter(e: EchecMessageLibre): Promise<EchecEcrit | null>; noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null>; lister(tenantId: string, filtre: FiltreErreurs, limit: number): Promise<ErreurLivraison[]>; purgerAvant(jours: number): Promise<number> }`
  - `ErreurLivraison.origine` gagne `'message'` ; `ErreurLivraison.origineMessage?: string | null` ; `ErreurLivraison.canal?: 'whatsapp' | 'rcs'` ; `FiltreErreurs.campagnesSeulement?: boolean`.
  - `PgContactStore.purgeMany` (signature inchangée) remet `campaign_recipients.variables` à `null` et efface les lignes d'`echecs_messages` de la personne, dans SA transaction.

- [ ] **Step 1: Écrire le test d'intégration (le rouge local est le typecheck)**

`tests/integration/echecs-messages.integration.test.ts` :

```ts
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgEchecsMessagesStore } from '../../src/delivery/echecs-messages.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES ÉCHECS DE LIVRAISON DES MESSAGES LIBRES (migration <N+1>, défaut 4 de la spec 2026-09-24).
 *
 * En intégration parce que tout ce qui compte est du SQL : retrouver le message par son identifiant, exclure
 * les entrants et les envois de campagne, l'idempotence par l'index unique, le rattachement du contact par la
 * règle de routage des entrants, le scope tenant et les filtres. Jamais joué en local.
 */
describe.skipIf(!url)('échecs des messages libres (Postgres)', () => {
  let pool: Pool;
  let store: PgEchecsMessagesStore;
  let tenantId = '';
  let autreTenant = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgEchecsMessagesStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-echecs-libres') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-echecs-libres-2') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  /** Un message du fil de `waId`, comme l'écrit `recordOutbound`. Rend son identifiant. */
  async function message(tenant: string, waId: string, o: { canal?: 'whatsapp' | 'rcs'; origine?: string | null; direction?: 'in' | 'out' } = {}): Promise<string> {
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2)
       on conflict (tenant_id, wa_id) do update set wa_id = excluded.wa_id returning id`,
      [tenant, waId],
    );
    const id = `itest-${randomUUID()}`;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, channel, origin)
       values ($1, $2, 'text', 'Bonjour', $3, $4, $5)`,
      [conv.rows[0]!.id, o.direction ?? 'out', id, o.canal ?? 'whatsapp', o.direction === 'in' ? null : (o.origine === undefined ? 'api' : o.origine)],
    );
    return id;
  }

  it('🔴 un échec de message SORTANT est écrit, et relu avec l’origine « message »', async () => {
    const id = await message(tenantId, '33600000501', { canal: 'rcs', origine: 'api' });
    expect(await store.noter({ messageId: id, code: null, motif: 'UNDELIVERABLE' }))
      .toEqual({ tenantId, waId: '33600000501', canal: 'rcs', origine: 'api' });
    const ligne = (await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000501');
    expect(ligne).toMatchObject({ origine: 'message', origineMessage: 'api', canal: 'rcs', message: 'UNDELIVERABLE', code: null, campaignId: null });
  });

  it('le contact est rattaché par la règle de routage des entrants', async () => {
    await pool.query(`insert into contacts (tenant_id, phone_e164, profile_name) values ($1, '+33600000502', 'Alice Test')`, [tenantId]);
    const id = await message(tenantId, '33600000502');
    await store.noter({ messageId: id, code: 131026, motif: '131026 Message undeliverable' });
    expect((await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000502')?.contactNom).toBe('Alice Test');
  });

  it('🔴 idempotent : le même échec rejoué n’écrit qu’une ligne', async () => {
    const id = await message(tenantId, '33600000503');
    expect(await store.noter({ messageId: id, code: 131026, motif: 'x' })).not.toBeNull();
    expect(await store.noter({ messageId: id, code: 131026, motif: 'x' })).toBeNull();
    const n = await pool.query<{ n: number }>('select count(*)::int as n from echecs_messages where message_id = $1', [id]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('🔴 rien n’est écrit pour un entrant, un envoi de campagne ou un identifiant inconnu', async () => {
    const libre = await message(tenantId, '33600000504');
    const entrant = await message(tenantId, '33600000504', { direction: 'in' });
    const campagne = await message(tenantId, '33600000504', { origine: 'campagne' });
    expect(await store.noter({ messageId: entrant, code: null, motif: 'x' })).toBeNull();
    expect(await store.noter({ messageId: campagne, code: null, motif: 'x' })).toBeNull();
    expect(await store.noter({ messageId: `itest-${randomUUID()}`, code: null, motif: 'x' })).toBeNull();
    // Ancre positive : le même fil, un message libre, est bien noté.
    expect(await store.noter({ messageId: libre, code: null, motif: 'x' })).not.toBeNull();
  });

  it('🔴 noterSansMessage : un rapport arrivé AVANT l’inscription du message est écrit, origine inconnue', async () => {
    const id = `itest-${randomUUID()}`;
    const echec = { messageId: id, tenantId, waId: '33600000511', canal: 'rcs' as const, code: null, motif: 'UNDELIVERABLE' };
    expect(await store.noterSansMessage(echec)).toEqual({ tenantId, waId: '33600000511', canal: 'rcs', origine: null });
    expect((await store.lister(tenantId, {}, 100)).find((e) => e.telephone === '33600000511'))
      .toMatchObject({ origine: 'message', origineMessage: null, canal: 'rcs', message: 'UNDELIVERABLE' });
    // Rejoué par smsmode : rien de plus.
    expect(await store.noterSansMessage(echec)).toBeNull();
  });

  it('🔴 noterSansMessage n’écrit RIEN quand le message est inscrit : c’est `noter` qui en décide alors', async () => {
    const campagne = await message(tenantId, '33600000512', { origine: 'campagne' });
    expect(await store.noterSansMessage({ messageId: campagne, tenantId, waId: '33600000512', canal: 'rcs', code: null, motif: 'x' })).toBeNull();
    // Ancre positive : le même appel sur un identifiant qu'aucun message ne porte écrit bien.
    expect(await store.noterSansMessage({ messageId: `itest-${randomUUID()}`, tenantId, waId: '33600000512', canal: 'rcs', code: null, motif: 'x' })).not.toBeNull();
  });

  it('🔴 l’espace connu de l’appelant est un filtre : un message d’un autre espace n’est pas noté', async () => {
    const id = await message(autreTenant, '33600000505');
    expect(await store.noter({ messageId: id, code: null, motif: 'x', tenantId })).toBeNull();
    expect(await store.noter({ messageId: id, code: null, motif: 'x', tenantId: autreTenant })).not.toBeNull();
  });

  it('🔴 scope tenant à la lecture', async () => {
    const id = await message(autreTenant, '33600000506');
    await store.noter({ messageId: id, code: null, motif: 'chez le voisin' });
    expect((await store.lister(tenantId, {}, 100)).some((e) => e.telephone === '33600000506')).toBe(false);
    expect((await store.lister(autreTenant, {}, 100)).some((e) => e.telephone === '33600000506')).toBe(true);
  });

  it('les filtres : code, texte, numéro (avec ou sans +), campagne, campagnes seulement', async () => {
    const avecCode = await message(tenantId, '33600000507');
    const sansCode = await message(tenantId, '33600000508');
    await store.noter({ messageId: avecCode, code: 131049, motif: 'plafond marketing' });
    await store.noter({ messageId: sansCode, code: null, motif: 'INVALID_PHONE_NUMBER' });
    const parCode = await store.lister(tenantId, { code: 131049 }, 100);
    expect(parCode.some((e) => e.telephone === '33600000507')).toBe(true);
    expect(parCode.some((e) => e.telephone === '33600000508')).toBe(false);
    expect((await store.lister(tenantId, { q: 'INVALID_PHONE' }, 100)).map((e) => e.telephone)).toContain('33600000508');
    expect((await store.lister(tenantId, { telephone: '+33 6 00 00 05 08' }, 100)).map((e) => e.telephone)).toEqual(['33600000508']);
    expect(await store.lister(tenantId, { campaignIds: ['00000000-0000-0000-0000-000000000000'] }, 100)).toEqual([]);
    expect(await store.lister(tenantId, { campagnesSeulement: true }, 100)).toEqual([]);
  });

  it('la purge efface les vieux et épargne les récents', async () => {
    const recent = await message(tenantId, '33600000509');
    await store.noter({ messageId: recent, code: null, motif: 'frais' });
    await pool.query(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, motif, at)
       values ($1, $2, '33600000510', 'whatsapp', 'très vieux', now() - interval '400 days')`,
      [tenantId, `itest-${randomUUID()}`],
    );
    expect(await store.purgerAvant(90)).toBeGreaterThanOrEqual(1);
    const restants = await store.lister(tenantId, {}, 1000);
    expect(restants.some((e) => e.telephone === '33600000510')).toBe(false);
    expect(restants.some((e) => e.telephone === '33600000509')).toBe(true);
  });
});
```

Puis, dans `tests/integration/purge-rgpd.integration.test.ts`, les deux données neuves du lot, qui portent des données de la personne. Ajouter l'import après `import { PgContactStore } from '../../src/crm/contact-store.pg';` :

```ts
import { PgCampaignRepo } from '../../src/campaign/store.pg';
```

À la fin du `beforeAll`, juste après l'insertion dans `arrivees_pub` (donc après la création de `autreTenantId`) :

```ts
    // LOT 3 DE L'API PUBLIQUE : les VARIABLES d'un destinataire (migration <N>) et l'ÉCHEC d'un message libre
    // (migration <N+1>) portent des données de la personne (un numéro de commande, un numéro de téléphone).
    // Une ligne d'échec est posée AUSSI chez le voisin, sur le même numéro : elle prouve le cloisonnement.
    await new PgCampaignRepo(pool).createWithRecipients(
      { tenantId, phoneNumberId: '', name: 'itest-purge-variables', category: 'utility', templateName: 'confirmation', templateLanguage: 'fr', paramMapping: [] },
      [{ contactId, toE164: E164, resolvedParams: ['8412'], variables: { commande: '8412' } }],
    );
    await pool.query(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, motif)
       values ($1, 'itest-purge-echec', $2, 'rcs', 'UNDELIVERABLE'), ($3, 'itest-purge-echec-voisin', $2, 'rcs', 'UNDELIVERABLE')`,
      [tenantId, WA_ID, autreTenantId],
    );
    // ANCRE : les deux données existent AVANT la purge. Sans elle, les assertions d'absence plus bas
    // passeraient à vide sur une insertion ratée.
    const avant = await pool.query<{ v: unknown; e: number }>(
      `select (select variables from campaign_recipients where contact_id = $1) as v,
              (select count(*)::int from echecs_messages where tenant_id = $2 and wa_id = $3) as e`,
      [contactId, tenantId, WA_ID],
    );
    expect(avant.rows[0]).toEqual({ v: { commande: '8412' }, e: 1 });
```

Et, juste avant le commentaire `/**` qui précède le cas « les événements Meta bruts de la personne sont effacés », deux cas :

```ts
  it('🔴 les VARIABLES du destinataire partent (migration <N>), la ligne de campagne reste', async () => {
    const r = await pool.query<{ to_e164: string; variables: unknown }>(
      'select to_e164, variables from campaign_recipients where contact_id = $1', [contactId],
    );
    expect(r.rows).toEqual([{ to_e164: 'anonyme', variables: null }]);
  });

  it('🔴 l’échec d’un message libre de la personne est effacé, pas celui d’un autre espace (migration <N+1>)', async () => {
    const r = await pool.query<{ tenant_id: string }>('select tenant_id from echecs_messages where wa_id = $1', [WA_ID]);
    expect(r.rows.map((x) => x.tenant_id)).toEqual([autreTenantId]);
  });
```

- [ ] **Step 2: Le voir échouer localement**

Run: `cd /c/Users/julie/messagingme-mba && npm run typecheck`
Expected: FAIL, `Cannot find module '../../src/delivery/echecs-messages.pg'`.

- [ ] **Step 3: Étendre les types du journal**

`src/ops/erreurs-livraison.pg.ts`, dans l'interface `ErreurLivraison`, remplacer :

```ts
  origine: 'envoi' | 'livraison' | 'scenario';
  at: string | null;
}
```

par :

```ts
  origine: 'envoi' | 'livraison' | 'scenario' | 'message';
  at: string | null;
  /**
   * Ligne `message` seulement (migration <N+1>) : un message LIBRE (réponse de l'Inbox, API, MCP, bloc de
   * scénario, agent) n'est pas arrivé. `origineMessage` est la colonne origin du message, `canal` son tuyau.
   * Absents sur les trois autres origines.
   */
  origineMessage?: string | null;
  canal?: 'whatsapp' | 'rcs';
}
```

et compléter le commentaire de `origine` (la liste à puces au-dessus) par une puce :

```ts
   *  - `message` : un message LIBRE n'est pas arrivé (migration <N+1>). Jamais un envoi de campagne, que les
   *    deux premières portent déjà.
```

Dans l'interface `FiltreErreurs`, ajouter après `templateNames?: string[];` :

```ts
  /**
   * Les seules erreurs de CAMPAGNE (Analytics). Le détail d'un code s'y ouvre depuis un compteur que
   * `getErrorBreakdown` calcule sur les destinataires de campagne seulement : y mêler les messages libres
   * ferait ouvrir quatorze lignes sous un « 12 ».
   */
  campagnesSeulement?: boolean;
```

- [ ] **Step 4: Écrire `src/delivery/echecs-messages.pg.ts`**

```ts
import type { Pool } from 'pg';
import { matchWaIdPredicat } from '../crm/contact-store.pg';
import { STATS_TZ } from '../stats/range';
import type { ErreurLivraison, FiltreErreurs } from '../ops/erreurs-livraison.pg';

/**
 * LES ÉCHECS DE LIVRAISON DES MESSAGES LIBRES (spec 2026-09-24, § 5, migration <N+1>, « défaut 4 »).
 *
 * Le rapport de smsmode et les statuts de Meta ne mettaient à jour que les destinataires de CAMPAGNE. Une
 * réponse de l'Inbox, un RCS libre, un message de l'API ou d'un bloc de scénario qui n'arrivait pas n'était
 * écrit nulle part : ni journal des erreurs, ni joignabilité. Cette table est leur seul domicile.
 *
 * 🔴 SEULS LES ÉCHECS SONT ÉCRITS, ET SEULEMENT CEUX QU'AUCUNE CAMPAGNE NE PORTE. L'appelant ne l'appelle que
 * sur un échec qui n'a touché aucun destinataire de campagne ; la requête exclut en plus l'origine
 * `campagne`, pour qu'une tentative ancienne d'un destinataire de campagne n'apparaisse pas deux fois.
 */

/** Ce que les deux traitements de statuts savent d'un échec. */
export interface EchecMessageLibre {
  messageId: string;
  /** Code numérique de Meta. `null` pour smsmode, qui n'en donne pas. */
  code: number | null;
  motif: string | null;
  /**
   * L'espace, quand l'appelant le CONNAÎT : le rappel smsmode le tient du code de son URL, et il devient
   * alors un filtre. Un accusé de Meta ne connaît qu'un identifiant de message : c'est la ligne retrouvée
   * qui dit l'espace.
   */
  tenantId?: string;
}

/**
 * Ce que le rapport smsmode sait d'un échec quand le message N'EST PAS (encore) inscrit dans le fil : son
 * identifiant, l'espace (le code de l'URL de rappel) et le numéro (`to`, en chiffres nus, donc un wa_id).
 */
export interface EchecSansMessage {
  messageId: string;
  tenantId: string;
  waId: string;
  canal: 'whatsapp' | 'rcs';
  code: number | null;
  motif: string | null;
}

/**
 * La ligne écrite, ou `null` quand aucun message sortant ne porte cet identifiant : c'est ce `null` qui fait
 * replier le rapport smsmode sur `noterSansMessage` (`traiterRapportRcs`).
 */
export interface EchecEcrit {
  tenantId: string;
  waId: string;
  canal: string;
  origine: string | null;
}

export class PgEchecsMessagesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * NOTE un échec. `null` = rien d'écrit : identifiant inconnu, message entrant, envoi de campagne, message
   * d'un autre espace que celui annoncé, ou échec déjà noté.
   *
   * 🔴 UNE SEULE REQUÊTE, par l'index unique de meta_message_id (0009). Elle n'a lieu que sur un échec : un
   * statut ordinaire n'y arrive jamais.
   *
   * ⚠️ tenant_id N'EST PAS TOUJOURS DANS LE WHERE, ET C'EST LA MÊME EXCEPTION QUE `consommerReleaseMba` : un
   * accusé de Meta ne porte aucun espace, et l'identifiant de message est unique dans toute la base, donc il
   * ne peut désigner qu'une conversation d'un seul espace. Quand l'appelant connaît l'espace, il le passe et
   * il filtre.
   *
   * ⚠️ `on conflict (message_id) do nothing` S'APPUIE SUR L'INDEX UNIQUE de la migration : pg-boss rejoue un
   * job de statuts en entier, et Meta renvoie parfois deux fois le même échec.
   */
  async noter(e: EchecMessageLibre): Promise<EchecEcrit | null> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; canal: string; origine: string | null }>(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, origine, code, motif)
       select c.tenant_id, m.meta_message_id, c.wa_id, m.channel, m.origin, $2::integer, $3
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where m.meta_message_id = $1
          and m.direction = 'out'
          and m.origin is distinct from 'campagne'
          and ($4::uuid is null or c.tenant_id = $4::uuid)
       on conflict (message_id) do nothing
       returning tenant_id, wa_id, canal, origine`,
      [e.messageId, e.code, e.motif === null ? null : e.motif.slice(0, 2000), e.tenantId ?? null],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, waId: r.wa_id, canal: r.canal, origine: r.origine } : null;
  }

  /**
   * NOTE un échec dont le message N'EST PAS dans conversation_messages, à partir de ce que le rapport en sait.
   *
   * 🔴 LA COURSE QU'ELLE FERME : l'envoi rend la main, PUIS la route (ou l'Inbox) inscrit le message dans le
   * fil. Un rapport smsmode rapide (numéro sans RCS : UNDELIVERABLE) peut arriver entre les deux ; `noter` ne
   * trouve alors rien, et l'échec retombait dans le silence que ce lot répare (défaut 4). L'origine reste
   * `null` : le message n'était pas encore là pour la dire.
   *
   * ⚠️ `where not exists` : si le message EST inscrit, c'est `noter` qui a décidé (entrant, envoi de campagne,
   * autre espace, déjà noté), et cette méthode n'écrit RIEN. Elle ne sert que l'absence.
   * ⚠️ L'espace est CONNU de l'appelant (le code de l'URL de rappel, puis l'agent vérifié) : il est écrit tel
   * quel. Même idempotence que `noter`, par l'index unique sur message_id.
   */
  async noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null> {
    const res = await this.pool.query<{ tenant_id: string; wa_id: string; canal: string; origine: string | null }>(
      `insert into echecs_messages (tenant_id, message_id, wa_id, canal, origine, code, motif)
       select $1::uuid, $2::text, $3::text, $4::text, null, $5::integer, $6::text
        where not exists (select 1 from conversation_messages m where m.meta_message_id = $2::text)
       on conflict (message_id) do nothing
       returning tenant_id, wa_id, canal, origine`,
      [e.tenantId, e.messageId, e.waId, e.canal, e.code, e.motif === null ? null : e.motif.slice(0, 2000)],
    );
    const r = res.rows[0];
    return r ? { tenantId: r.tenant_id, waId: r.wa_id, canal: r.canal, origine: r.origine } : null;
  }

  /**
   * La QUATRIÈME source du journal des erreurs, origine `message`, avec les mêmes filtres que les autres.
   *
   * ⚠️ Un message libre n'appartient à aucune campagne ni à aucun template : filtrer par campagne ou par
   * template, ou demander les seules campagnes (Analytics), rend une liste vide.
   * ⚠️ Le numéro se compare en CHIFFRES : la table porte le wa_id (sans « + »), l'écran laisse taper un E.164.
   * ⚠️ DÉGRADE PROPREMENT : table absente (migration pas passée), liste vide et une ligne d'erreur.
   */
  async lister(tenantId: string, filtre: FiltreErreurs, limit: number): Promise<ErreurLivraison[]> {
    if (filtre.campagnesSeulement) return [];
    if (filtre.campaignIds?.length || filtre.templateNames?.length) return [];

    const where = ['e.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (filtre.telephone) {
      const chiffres = filtre.telephone.replace(/[^0-9]/g, '');
      ajouter((n) => `e.wa_id ilike '%' || $${n} || '%'`, chiffres !== '' ? chiffres : filtre.telephone);
    }
    if (filtre.code !== undefined) ajouter((n) => `e.code = $${n}`, filtre.code);
    if (filtre.from && filtre.to) {
      params.push(filtre.from, filtre.to, STATS_TZ);
      const [a, b, tz] = [params.length - 2, params.length - 1, params.length];
      where.push(`e.at >= ($${a}::date)::timestamp at time zone $${tz}`);
      where.push(`e.at < (($${b}::date) + 1)::timestamp at time zone $${tz}`);
    }
    if (filtre.q) {
      ajouter(
        (n) => `(e.motif ilike '%' || $${n} || '%' or e.code::text ilike '%' || $${n} || '%' or e.wa_id ilike '%' || $${n} || '%')`,
        filtre.q,
      );
    }
    params.push(Math.min(Math.max(limit, 1), 1000));

    try {
      const res = await this.pool.query<{
        id: string; wa_id: string; canal: string; origine: string | null; code: number | null; motif: string | null;
        at: Date; contact_id: string | null; contact_nom: string | null;
      }>(
        // Même garde de tenant sur la jointure du contact que les autres sources : le pooler est superuser.
        `select e.id, e.wa_id, e.canal, e.origine, e.code, e.motif, e.at,
                ct.id as contact_id, ct.profile_name as contact_nom
           from echecs_messages e
             left join lateral (
               select c2.id, c2.profile_name
                 from contacts c2
                where c2.tenant_id = e.tenant_id and c2.deleted_at is null
                  and ${matchWaIdPredicat('c2.', 'e.wa_id')}
                order by (c2.phone_e164 = '+' || e.wa_id) desc
                limit 1
             ) ct on true
          where ${where.join(' and ')}
          order by e.at desc
          limit $${params.length}`,
        params,
      );
      return res.rows.map((r) => ({
        recipientId: r.id,
        campaignId: null,
        campaignName: null,
        telephone: r.wa_id,
        contactId: r.contact_id,
        contactNom: r.contact_nom,
        code: r.code,
        message: r.motif === null ? null : r.motif.slice(0, 500),
        origine: 'message' as const,
        at: r.at.toISOString(),
        origineMessage: r.origine,
        canal: r.canal === 'rcs' ? 'rcs' as const : 'whatsapp' as const,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('erreurs-livraison: lecture des échecs de messages libres impossible (migration <N+1> passée ?):', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /** Purge de rétention, appelée par le balayage général du worker. De l'exploitation, pas une preuve. */
  async purgerAvant(jours: number): Promise<number> {
    const res = await this.pool.query(
      `delete from echecs_messages where at < now() - make_interval(days => $1::int)`,
      [Math.max(1, Math.floor(jours))],
    );
    return res.rowCount ?? 0;
  }
}
```

- [ ] **Step 5: La purge RGPD efface ce que le lot ajoute (`src/crm/contact-store.pg.ts`)**

Dans `purgeMany`, remplacer :

```ts
      // Quantitatif préservé : la ligne de campagne reste (statut, horodatage, livraison), son numéro et ses
      // variables résolues partent. `resolved_params` porte les valeurs injectées dans le template, donc
      // typiquement le prénom.
      await client.query(
        `update campaign_recipients set to_e164 = 'anonyme', resolved_params = '{}'::jsonb
          where contact_id = any($1::uuid[])`,
        [ids],
      );
```

par :

```ts
      // Quantitatif préservé : la ligne de campagne reste (statut, horodatage, livraison), son numéro et ses
      // variables partent. `resolved_params` porte les valeurs injectées dans le template, donc typiquement le
      // prénom ; `variables` (migration <N>, lot 3 de l'API publique) porte ce que l'intégrateur a passé pour CE
      // destinataire (un numéro de commande, un montant). `null` et pas '{}' : « n'en porte pas ».
      await client.query(
        `update campaign_recipients set to_e164 = 'anonyme', resolved_params = '{}'::jsonb, variables = null
          where contact_id = any($1::uuid[])`,
        [ids],
      );
```

Puis, juste APRÈS le bloc `if (waIdsAAnonymiser.length > 0) { ... delete from webhook_events ... }`, ajouter :

```ts
      // L'ÉCHEC D'UN MESSAGE LIBRE (migration <N+1>, lot 3 de l'API publique) garde le numéro et le motif.
      // EFFACÉ, pas anonymisé : c'est un journal d'exploitation, il n'a aucun quantitatif à préserver. Scopé à
      // l'espace, et visé par les DEUX formes du numéro (fils trouvés ET numéro de la fiche) : un échec survit à
      // son fil, et un rapport arrivé avant l'inscription du message n'en a jamais eu (`noterSansMessage`).
      if (waIdsAAnonymiser.length > 0) {
        await client.query(
          `delete from echecs_messages where tenant_id = $1 and wa_id = any($2::text[])`,
          [tenantId, waIdsAAnonymiser],
        );
      }
```

- [ ] **Step 6: Le voir compiler, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test`
Expected: PASS. `npm test` lance la configuration unitaire (`vitest.config.ts`), qui EXCLUT `tests/integration/**` : les fichiers d'intégration n'y tournent pas, ils sont seulement compilés par `typecheck`. Ne jamais lancer `npm run test:integration` avec le `DATABASE_URL` du `.env` (la production).

- [ ] **Step 7: Vérifier le test de la purge dans les deux sens, sur un Postgres JETABLE**

Ni la base de production (le `DATABASE_URL` du `.env`), ni un `main` poussé rouge : la voie documentée est un Postgres pgvector jetable sur le VPS, joint par un tunnel SSH (`documentation.md` § 9, « Pour un besoin ponctuel »). `<accès SSH>` est celui du VPS dans `brain/INFRA.md` ; il ne se recopie pas ici, le dépôt est public.

```bash
ssh <accès SSH> 'sudo docker run --rm -d --name pg-jetable-lot3 -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16'
ssh -f -N -L 55432:127.0.0.1:55432 <accès SSH>
cd /c/Users/julie/messagingme-mba && export DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres DB_SSL=off ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  && test "$DATABASE_URL" = postgres://postgres:postgres@localhost:55432/postgres \
  && npm run migrate && npx vitest run --config vitest.integration.config.ts tests/integration/purge-rgpd.integration.test.ts tests/integration/echecs-messages.integration.test.ts
```

Expected: PASS. Le `test` vérifie, AVANT `migrate`, que l'adresse exportée est bien celle du Postgres jetable ; `dotenv` (chargé par `db/migrate.ts` et par les tests) ne remplace pas une variable déjà posée, donc le `.env` de production n'est jamais lu pour `DATABASE_URL`.

Puis remettre le défaut : dans `purgeMany`, retirer `, variables = null` de l'`update` ET commenter le bloc `delete from echecs_messages`. Relancer la troisième commande ci-dessus EN ENTIER (elle repose ses trois variables et son contrôle : l'état du shell ne persiste pas d'un appel à l'autre ; `migrate` rejoué ne fait rien) : FAIL sur les deux cas neufs, avec leur symptôme exact (`expected [ { to_e164: 'anonyme', variables: { commande: '8412' } } ] to deeply equal [ { to_e164: 'anonyme', variables: null } ]`, puis la liste des espaces qui contient les DEUX `tenant_id`). Restaurer, relancer : PASS, et `git diff -- src/crm/contact-store.pg.ts` ne montre plus aucune ligne commentée. Enfin : `ssh <accès SSH> 'sudo docker stop pg-jetable-lot3'` et fermer le tunnel.

- [ ] **Step 8: Commit, puis verdict de l'intégration sur la CI**

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/delivery/echecs-messages.pg.ts src/ops/erreurs-livraison.pg.ts src/crm/contact-store.pg.ts tests/integration/echecs-messages.integration.test.ts tests/integration/purge-rgpd.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N src/delivery/echecs-messages.pg.ts tests/integration/echecs-messages.integration.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(delivery): le store des échecs de messages libres, et la purge RGPD de ce que le lot ajoute

PgEchecsMessagesStore : noter, noterSansMessage (le rapport qui devance l'inscription du message), lister
(quatrième source du journal), purgerAvant. purgeMany remet campaign_recipients.variables à null et efface les
échecs de la personne, dans sa transaction.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Expected: le job `integration` en `success`.

---

### Task 5: `processStatuses` note l'échec d'un message libre (défaut 4, côté Meta)

**Files:**
- Modify: `src/webhooks/delivery.ts` (interface `PuitsAccuses` lignes 84 à 88, `processStatuses` lignes 109 et 132)
- Modify: `src/webhooks/handler.ts` (import ligne 3, type `WebhookJobDeps` lignes 106 à 111, déstructuration ligne 117, appel ligne 129)
- Modify: `src/worker.ts` (construction du store après la ligne 248, file `webhook` après la ligne 483, file `webhook-status` ligne 703) : FICHIER DE CÂBLAGE PARTAGÉ
- Modify: `tests/webhook-fixtures.ts`, `tests/delivery.test.ts`, `tests/pubs-tarif-meta.test.ts`, `tests/release-mba-sur-accuse.test.ts`, `tests/workflow-mesure-statuts.test.ts`
- Test: `tests/echecs-messages-libres.test.ts`

**Interfaces:**
- Consumes : `PgEchecsMessagesStore` (Task 4).
- Produces : `export interface EchecsLibresSink { noter(e: { messageId: string; code: number | null; motif: string | null; tenantId?: string }): Promise<unknown> }` ; `PuitsAccuses.echecsLibres: EchecsLibresSink` (REQUIS) ; le couple de `WebhookJobDeps` devient `{ delivery; tarifsMeta; echecsLibres }` ; `aucunEchecLibre` dans `tests/webhook-fixtures.ts`.

- [ ] **Step 1: Annoncer l'édition de `src/worker.ts`**

`ListAgents`, puis `SendMessage` à chaque session : « Lot 3 API : j'édite src/worker.ts (échecs des messages libres sur les deux files d'accusés), commit dans ~15 min. »

- [ ] **Step 2: Écrire le test qui échoue**

`tests/echecs-messages-libres.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { processStatuses } from '../src/webhooks/delivery';
import type { DeliveryStore, DeliveryStatus, EchecsLibresSink } from '../src/webhooks/delivery';
import { handleWebhookJob } from '../src/webhooks/handler';
import type { WebhookEvent } from '../src/webhooks/parse';
import { aucunTarif } from './webhook-fixtures';

/**
 * L'ÉCHEC D'UN MESSAGE LIBRE N'ÉTAIT ÉCRIT NULLE PART (défaut 4 de la spec 2026-09-24).
 *
 * Seul `wamid.campagne` est un destinataire de campagne : tout autre identifiant n'en touche aucun.
 */
class Livraison implements DeliveryStore {
  async updateDeliveryByMessageId(messageId: string, _s: DeliveryStatus): Promise<number> {
    return messageId === 'wamid.campagne' ? 1 : 0;
  }
}

function puits() {
  const notes: Array<{ messageId: string; code: number | null; motif: string | null; tenantId?: string }> = [];
  const sink: EchecsLibresSink = { noter: async (e) => { notes.push(e); return null; } };
  return { notes, sink };
}

const statut = (id: string, status: string, erreur?: { code: number; title: string }): WebhookEvent => ({
  source: 'statuses',
  dedupKey: `status:${id}:${status}`,
  data: { id, status, ...(erreur ? { errors: [erreur] } : {}) },
});

const INJOIGNABLE = { code: 131026, title: 'Message undeliverable' };

describe('processStatuses : l’échec d’un message LIBRE', () => {
  it('🔴 un échec qui ne touche aucun destinataire de campagne est NOTÉ, avec son code et son motif', async () => {
    const { notes, sink } = puits();
    await processStatuses([statut('wamid.libre', 'failed', INJOIGNABLE)], new Livraison(), { tarifs: aucunTarif, echecsLibres: sink });
    expect(notes).toEqual([{ messageId: 'wamid.libre', code: 131026, motif: '131026 Message undeliverable' }]);
  });

  it('🔴 l’échec d’un destinataire de campagne n’en écrit PAS de second', async () => {
    const { notes, sink } = puits();
    await processStatuses(
      [statut('wamid.campagne', 'failed', INJOIGNABLE), statut('wamid.libre', 'failed', INJOIGNABLE)],
      new Livraison(), { tarifs: aucunTarif, echecsLibres: sink },
    );
    // L'ancre positive est le second : le mécanisme a bien tourné sur ce lot.
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.libre']);
  });

  it('un statut ordinaire ne coûte rien : sent, delivered et read ne notent jamais', async () => {
    const { notes, sink } = puits();
    await processStatuses(
      [statut('wamid.a', 'sent'), statut('wamid.a', 'delivered'), statut('wamid.a', 'read'), statut('wamid.b', 'failed', INJOIGNABLE)],
      new Livraison(), { tarifs: aucunTarif, echecsLibres: sink },
    );
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.b']);
  });

  it('🔴 un journal en panne ne fait pas échouer le job (pg-boss le rejouerait en entier)', async () => {
    const enPanne: EchecsLibresSink = { noter: async () => { throw new Error('base indisponible'); } };
    await expect(processStatuses([statut('wamid.libre', 'failed', INJOIGNABLE)], new Livraison(), { tarifs: aucunTarif, echecsLibres: enPanne }))
      .resolves.toBeUndefined();
  });

  it('🔴 le traitement d’un webhook transmet le puits jusqu’aux statuts', async () => {
    const { notes, sink } = puits();
    await handleWebhookJob({
      entry: [{ changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'pn1' },
        statuses: [{ id: 'wamid.h1', status: 'failed', errors: [INJOIGNABLE] }],
      } }] }],
    }, { store: { insertEvent: async () => true }, delivery: new Livraison(), tarifsMeta: aucunTarif, echecsLibres: sink });
    expect(notes.map((n) => n.messageId)).toEqual(['wamid.h1']);
  });
});
```

- [ ] **Step 3: Le voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/echecs-messages-libres.test.ts`
Expected: FAIL sur le premier, le deuxième, le troisième et le cinquième cas (`expected [] to deeply equal [...]`).

- [ ] **Step 4: Implémenter dans `src/webhooks/delivery.ts`**

Ajouter avant `export interface PuitsAccuses` :

```ts
/**
 * L'ÉCHEC D'UN MESSAGE LIBRE (spec 2026-09-24, § 5, « défaut 4 »).
 *
 * 🔴 APPELÉ SEULEMENT SUR UN `failed` QUI N'A TOUCHÉ AUCUN DESTINATAIRE DE CAMPAGNE : un statut ordinaire ne
 * coûte aucune requête de plus, et l'échec d'un destinataire de campagne est déjà porté par sa ligne.
 * Implémenté par `PgEchecsMessagesStore` (`src/delivery/echecs-messages.pg.ts`).
 */
export interface EchecsLibresSink {
  noter(e: { messageId: string; code: number | null; motif: string | null; tenantId?: string }): Promise<unknown>;
}
```

Dans `PuitsAccuses`, ajouter après `tarifs: TarifsMetaSink;` :

```ts
  /**
   * 🔴 OBLIGATOIRE, comme `tarifs` et pour la même raison : un puits qu'on peut omettre est un puits qu'on
   * oublie. Les tests qui n'en parlent pas passent `aucunEchecLibre` (`tests/webhook-fixtures.ts`).
   */
  echecsLibres: EchecsLibresSink;
```

Remplacer `  const { tarifs, nodeEvents, remiseMba } = puits;` par `  const { tarifs, echecsLibres, nodeEvents, remiseMba } = puits;`, et la ligne 132 :

```ts
    await delivery.updateDeliveryByMessageId(d.messageId, d.status, d.error, d.errorCode);
```

par :

```ts
    const touches = await delivery.updateDeliveryByMessageId(d.messageId, d.status, d.error, d.errorCode);
    /**
     * 🔴 L'ÉCHEC D'UN MESSAGE LIBRE, ÉCRIT NULLE PART JUSQU'ICI (défaut 4). Une réponse de l'Inbox, un message
     * de l'API ou d'un bloc de scénario qui échoue n'est pas un destinataire de campagne : `touches` vaut 0,
     * et c'est le seul cas qui paie une requête de plus.
     * ⚠️ BEST-EFFORT : une exception ici ferait rejouer tout le job par pg-boss pour un journal.
     */
    if (d.status === 'failed' && touches === 0) {
      try {
        await echecsLibres.noter({ messageId: d.messageId, code: d.errorCode, motif: d.error });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('échec de message libre non journalisé:', err instanceof Error ? err.message : err);
      }
    }
```

- [ ] **Step 5: Implémenter dans `src/webhooks/handler.ts`**

Ligne 3 : `import type { EchecsLibresSink, NodeStatusSink, RemiseMbaSurAccuse } from './delivery';`

Remplacer la première ligne du couple dans `WebhookJobDeps` :

```ts
  & ({ delivery: DeliveryStore; tarifsMeta: TarifsMetaSink } | { delivery?: undefined; tarifsMeta?: undefined })
```

par :

```ts
  & (
    // `echecsLibres` entre dans le couple des accusés (lot 3 de l'API publique) : une file qui applique des
    // statuts doit aussi noter l'échec d'un message libre, sinon il redevient invisible selon la file.
    { delivery: DeliveryStore; tarifsMeta: TarifsMetaSink; echecsLibres: EchecsLibresSink }
    | { delivery?: undefined; tarifsMeta?: undefined; echecsLibres?: undefined }
  )
```

Ligne 117 : `    tarifsMeta, echecsLibres, arriveesPub, routagePub,`

Ligne 129 : `  if (delivery) await processStatuses(events, delivery, { tarifs: tarifsMeta, echecsLibres, nodeEvents, remiseMba });`

- [ ] **Step 6: La fixture et les quatre fichiers de test existants**

`tests/webhook-fixtures.ts` : ajouter l'import `import type { EchecsLibresSink } from '../src/webhooks/delivery';` en tête, et à la suite de `aucunTarif` :

```ts
/** Aucun journal des échecs de messages libres (lot 3 de l'API publique) : le puits est inerte et le DIT. */
export const aucunEchecLibre: EchecsLibresSink = { noter: async () => null };
```

`tests/release-mba-sur-accuse.test.ts` et `tests/workflow-mesure-statuts.test.ts` (outil Edit, `replace_all: true`) : remplacer `import { aucunTarif } from './webhook-fixtures';` par `import { aucunTarif, aucunEchecLibre } from './webhook-fixtures';`, et `tarifs: aucunTarif` par `tarifs: aucunTarif, echecsLibres: aucunEchecLibre`.

`tests/delivery.test.ts` : même remplacement d'import ; remplacer `      tarifsMeta: aucunTarif,` par :

```ts
      tarifsMeta: aucunTarif,
      echecsLibres: aucunEchecLibre,
```

`tests/pubs-tarif-meta.test.ts` : ajouter après `import { handleWebhookJob } from '../src/webhooks/handler';` la ligne `import { aucunEchecLibre } from './webhook-fixtures';` ; puis, avant CHACUNE des quatre lignes qui commencent par `      tarifs: { enregistrer:` et avant la ligne `      tarifsMeta: { enregistrer:`, insérer la ligne `      echecsLibres: aucunEchecLibre,`.

Contrôle :

```bash
cd /c/Users/julie/messagingme-mba && grep -c "echecsLibres: aucunEchecLibre" tests/release-mba-sur-accuse.test.ts tests/workflow-mesure-statuts.test.ts tests/delivery.test.ts tests/pubs-tarif-meta.test.ts
```

Expected: `5`, `5`, `1`, `5`.

- [ ] **Step 7: Le câblage du worker**

`src/worker.ts` : ajouter l'import `import { PgEchecsMessagesStore } from './delivery/echecs-messages.pg';` avec les autres imports de stores ; après la ligne `  const erreursLivraison = new PgErreursLivraisonStore(pool);` :

```ts
  // Les échecs de livraison des MESSAGES LIBRES (lot 3 de l'API publique, migration <N+1>) : écrits par les
  // deux files qui voient des accusés, purgés par le balayage de rétention.
  const echecsMessages = new PgEchecsMessagesStore(pool);
```

Dans la file `webhook`, après `      tarifsMeta: tarifsMetaStore,` :

```ts
      // 🔴 SUR LES DEUX FILES qui voient des accusés, comme le tarif : un échec arrive par l'une ou par l'autre.
      echecsLibres: echecsMessages,
```

Dans la file `webhook-status`, remplacer l'appel par :

```ts
    await handleWebhookJob(data, { store: eventStore, delivery: recipientStore, nodeEvents: nodeEventStore, remiseMba: remiseMbaSurAccuse, tarifsMeta: tarifsMetaStore, echecsLibres: echecsMessages });
```

- [ ] **Step 8: Le voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/echecs-messages-libres.test.ts && npm run typecheck && npm test`
Expected: PASS partout.

- [ ] **Step 9: Vérifier le test dans les deux sens**

Remettre le défaut : dans `src/webhooks/delivery.ts`, commenter les trois lignes `if (d.status === 'failed' && touches === 0) {` ... `}` (le bloc entier). Puis :

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/echecs-messages-libres.test.ts`
Expected: FAIL avec le symptôme exact du défaut 4 : `expected [] to deeply equal [ { messageId: 'wamid.libre', code: 131026, … } ]` (rien n'est écrit). Restaurer le bloc, relancer : PASS. `git diff -- src/webhooks/delivery.ts` ne doit plus montrer aucune ligne commentée.

- [ ] **Step 10: Commit**

`src/worker.ts` est un fichier de câblage PARTAGÉ : si `git diff -- src/worker.ts` montre une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/webhooks/delivery.ts src/webhooks/handler.ts src/worker.ts tests/webhook-fixtures.ts tests/delivery.test.ts tests/pubs-tarif-meta.test.ts tests/release-mba-sur-accuse.test.ts tests/workflow-mesure-statuts.test.ts tests/echecs-messages-libres.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N tests/echecs-messages-libres.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
fix(webhooks): l'échec d'un message libre chez Meta est enfin écrit (défaut 4)

processStatuses note un failed qui n'a touché aucun destinataire de campagne, en best-effort, sur les deux
files qui voient des accusés. Un statut ordinaire ne coûte aucune requête de plus.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Le rapport smsmode note l'échec et écrit la joignabilité RCS

**Files:**
- Create: `src/rcs/rapport-livraison.ts`
- Modify: `src/index.ts` (imports ; stores après la ligne 233 ; corps de `onDlr`, lignes 2637 à 2664) : FICHIER DE CÂBLAGE PARTAGÉ
- Test: `tests/rcs-rapport-livraison.test.ts`

**Interfaces:**
- Consumes : `PgEchecsMessagesStore.noter` et `noterSansMessage`, types `EchecMessageLibre`, `EchecSansMessage`, `EchecEcrit` (Task 4), `ReachabilityStore.put(agentId, e164, reachable, atMs)`, `RcsDlr` (`src/rcs/callback.ts`, `to` en chiffres nus), `DeliveryStatus`.
- Produces : `export interface EchecsRcsSink { noter(e: EchecMessageLibre): Promise<EchecEcrit | null>; noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null> }` ; `export interface DepsRapportRcs` (dont `echecs: EchecsRcsSink`) ; `export async function traiterRapportRcs(deps: DepsRapportRcs, tenantId: string, dlr: RcsDlr): Promise<void>`.

- [ ] **Step 1: Annoncer l'édition de `src/index.ts`**

`SendMessage` à chaque session : « Lot 3 API : j'édite src/index.ts (onDlr extrait vers src/rcs/rapport-livraison.ts), commit dans ~15 min. »

- [ ] **Step 2: Écrire le test qui échoue**

`tests/rcs-rapport-livraison.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { traiterRapportRcs, type DepsRapportRcs } from '../src/rcs/rapport-livraison';
import type { RcsDlr } from '../src/rcs/callback';
import type { EchecMessageLibre, EchecSansMessage } from '../src/delivery/echecs-messages.pg';

const MAINTENANT = 1_700_000_000_000;

const rapport = (over: Partial<RcsDlr> = {}): RcsDlr => ({
  messageId: 'sms-1', channelId: 'agent-1', to: '33612345678', status: 'failed',
  echecDefinitif: true, detail: 'UNDELIVERABLE', refClient: null, ...over,
});

/**
 * `touches` : les destinataires de campagne que le rapport a touchés. `messageInscrit` : ce que `noter` trouve
 * dans le fil (faux = le rapport a DEVANCÉ l'inscription du message par la route ou par l'Inbox).
 */
function monde(touches = 0, messageInscrit = true) {
  const journal: string[] = [];
  const notes: EchecMessageLibre[] = [];
  const replis: EchecSansMessage[] = [];
  const cache: Array<{ agentId: string; e164: string; reachable: boolean; at: number }> = [];
  const deps: DepsRapportRcs = {
    majLivraison: async (id, statut) => { journal.push(`maj:${id}:${statut}`); return touches; },
    mesureBloc: async (id, statut) => { journal.push(`bloc:${id}:${statut}`); return 0; },
    echecs: {
      noter: async (e) => {
        notes.push(e);
        return messageInscrit ? { tenantId: 't1', waId: '33612345678', canal: 'rcs', origine: 'api' } : null;
      },
      noterSansMessage: async (e) => { replis.push(e); return null; },
    },
    joignabilite: { put: async (agentId, e164, reachable, at) => { cache.push({ agentId, e164, reachable, at }); } },
    rcsInjoignable: async (_t, to, id) => { journal.push(`injoignable:${to}:${id}`); return true; },
    rcsDelivre: async (_t, to, id) => { journal.push(`delivre:${to}:${id}`); return true; },
    maintenant: () => MAINTENANT,
  };
  return { deps, journal, notes, replis, cache };
}

describe('traiterRapportRcs : l’échec d’un RCS libre (défaut 4, côté smsmode)', () => {
  it('🔴 un échec définitif hors campagne est NOTÉ, avec l’espace connu par le code de l’URL', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.notes).toEqual([{ messageId: 'sms-1', code: null, motif: 'UNDELIVERABLE', tenantId: 't1' }]);
    // Le message était inscrit : le repli n'a rien à faire.
    expect(m.replis).toEqual([]);
  });

  it('🔴 le rapport arrivé AVANT l’inscription du message est écrit quand même, depuis ce qu’il sait', async () => {
    const m = monde(0, false);
    await traiterRapportRcs(m.deps, 't1', rapport());
    // Ancre positive : `noter` a bien été interrogé d'abord.
    expect(m.notes.map((n) => n.messageId)).toEqual(['sms-1']);
    expect(m.replis).toEqual([{ messageId: 'sms-1', tenantId: 't1', waId: '33612345678', canal: 'rcs', code: null, motif: 'UNDELIVERABLE' }]);
  });

  it('🔴 le numéro devient injoignable pour CET agent, sous sa forme E.164', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.cache).toEqual([{ agentId: 'agent-1', e164: '+33612345678', reachable: false, at: MAINTENANT }]);
  });

  it('un destinataire de campagne n’est pas noté une seconde fois, mais sa joignabilité est apprise', async () => {
    const m = monde(1);
    await traiterRapportRcs(m.deps, 't1', rapport());
    expect(m.notes).toEqual([]);
    expect(m.replis).toEqual([]);
    expect(m.cache.map((c) => c.reachable)).toEqual([false]);
  });

  it('une livraison rend le numéro joignable, et ne note rien', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: 'delivered', echecDefinitif: false, detail: null }));
    expect(m.cache).toEqual([{ agentId: 'agent-1', e164: '+33612345678', reachable: true, at: MAINTENANT }]);
    expect(m.notes).toEqual([]);
    expect(m.journal).toContain('delivre:33612345678:sms-1');
  });

  it('un statut lu ou envoyé ne touche pas au cache', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: 'read', echecDefinitif: false, detail: null }));
    await traiterRapportRcs(m.deps, 't1', rapport({ messageId: 'sms-2', status: 'sent', echecDefinitif: false, detail: null }));
    // Ancre positive : les deux rapports ont bien été traités.
    expect(m.journal).toEqual(['maj:sms-1:read', 'bloc:sms-1:read', 'maj:sms-2:sent']);
    expect(m.cache).toEqual([]);
  });

  it('🔴 une panne du journal ou du cache ne fait pas échouer le rapport, et la sortie du bloc s’allume quand même', async () => {
    const m = monde(0);
    m.deps.echecs = {
      noter: async () => { throw new Error('base indisponible'); },
      noterSansMessage: async () => { throw new Error('base indisponible'); },
    };
    m.deps.joignabilite = { put: async () => { throw new Error('base indisponible'); } };
    await expect(traiterRapportRcs(m.deps, 't1', rapport())).resolves.toBeUndefined();
    expect(m.journal).toContain('injoignable:33612345678:sms-1');
  });

  it('un statut inconnu n’écrit rien, et ne masque pas le rapport suivant', async () => {
    const m = monde(0);
    await traiterRapportRcs(m.deps, 't1', rapport({ status: null, echecDefinitif: false }));
    await traiterRapportRcs(m.deps, 't1', rapport({ messageId: 'sms-3' }));
    expect(m.journal).toEqual(['maj:sms-3:failed', 'bloc:sms-3:failed', 'injoignable:33612345678:sms-3']);
    expect(m.notes.map((n) => n.messageId)).toEqual(['sms-3']);
  });
});
```

- [ ] **Step 3: Le voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/rcs-rapport-livraison.test.ts`
Expected: FAIL, module `../src/rcs/rapport-livraison` introuvable.

- [ ] **Step 4: Écrire `src/rcs/rapport-livraison.ts`**

```ts
import type { RcsDlr } from './callback';
import type { DeliveryStatus } from '../webhooks/delivery';
import type { EchecEcrit, EchecMessageLibre, EchecSansMessage } from '../delivery/echecs-messages.pg';

/**
 * LE RAPPORT DE LIVRAISON D'UN RCS (rappel smsmode), extrait de `onDlr` (`src/index.ts`) pour être testé.
 *
 * Trois choses dans cet ordre, les deux premières étant celles d'avant ce lot :
 *   1. le destinataire de campagne, par identifiant de message, et la mesure par bloc ;
 *   2. les DEUX sorties du bloc RCS d'un scénario ;
 *   et, depuis le lot 3 de l'API publique (spec 2026-09-24, § 5) :
 *   3. l'échec d'un message LIBRE, noté quand il n'a touché aucun destinataire de campagne ; et la
 *      joignabilité RCS du numéro pour CET agent, apprise sur tout rapport qui la dit.
 *
 * 🔴 SMSMODE NE SAIT PAS DIRE LA JOIGNABILITÉ AVANT L'ENVOI (`canCheckReachability = false`). Le rapport est
 * donc la SEULE source : sans lui, le cache ne l'apprenait jamais, et le second RCS libre vers un numéro non
 * RCS partait comme le premier.
 *
 * ⚠️ BEST-EFFORT sur tout ce que ce lot ajoute : une exception rendrait 5xx à smsmode, qui rejouerait le
 * rappel, donc réappliquerait la livraison pour un motif secondaire.
 * ⚠️ UNE LIVRAISON COÛTE UNE ÉCRITURE PAR CLÉ PRIMAIRE dans le cache : c'est ce qui fait qu'un numéro
 * redevenu joignable cesse d'être refusé. Un statut « envoyé » ou « lu » ne coûte rien.
 */

/**
 * Le journal des échecs vu du rapport smsmode (`PgEchecsMessagesStore`). Deux méthodes, parce que le rapport
 * peut DEVANCER l'inscription du message dans le fil : `noter` ne le trouve alors pas, et `noterSansMessage`
 * écrit quand même ce que le rapport sait.
 */
export interface EchecsRcsSink {
  noter(e: EchecMessageLibre): Promise<EchecEcrit | null>;
  noterSansMessage(e: EchecSansMessage): Promise<EchecEcrit | null>;
}

export interface DepsRapportRcs {
  majLivraison(messageId: string, status: DeliveryStatus, detail: string | null): Promise<number>;
  mesureBloc(messageId: string, status: 'delivered' | 'read' | 'failed'): Promise<unknown>;
  echecs: EchecsRcsSink;
  joignabilite: { put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void> };
  rcsInjoignable(tenantId: string, to: string, messageId: string): Promise<unknown>;
  rcsDelivre(tenantId: string, to: string, messageId: string): Promise<unknown>;
  maintenant(): number;
}

export async function traiterRapportRcs(deps: DepsRapportRcs, tenantId: string, dlr: RcsDlr): Promise<void> {
  // 1. Le destinataire de campagne, par identifiant de message. Même chemin que les accusés Meta : une seule
  //    échelle de statuts dans le produit, donc un seul écran de résultats à lire.
  if (dlr.status !== null) {
    const touches = await deps.majLivraison(dlr.messageId, dlr.status, dlr.detail);
    // 1 bis. La MESURE PAR BLOC (Analytics > Mes tableaux), best-effort comme côté Meta.
    if (dlr.status !== 'sent') {
      try {
        await deps.mesureBloc(dlr.messageId, dlr.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('mesure de bloc RCS (statut) ignorée:', err instanceof Error ? err.message : err);
      }
    }
    // 1 ter. L'échec d'un message LIBRE (défaut 4) : seulement s'il n'a touché aucun destinataire de campagne.
    //        L'espace est CONNU ici (le code de l'URL), donc il filtre.
    if (dlr.echecDefinitif && touches === 0) {
      try {
        const ecrit = await deps.echecs.noter({ messageId: dlr.messageId, code: null, motif: dlr.detail, tenantId });
        // 🔴 LE RAPPORT PEUT DEVANCER L'INSCRIPTION DU MESSAGE : la route de l'API et l'Inbox l'inscrivent dans
        // le fil APRÈS l'envoi, et un UNDELIVERABLE de smsmode (numéro sans RCS) peut arriver entre les deux.
        // `noter` ne trouve alors rien ; sans ce repli, l'échec retombait dans le silence (défaut 4), et c'est
        // justement le premier RCS vers un numéro sans RCS, celui que l'essai réel du lot envoie.
        if (ecrit === null && dlr.to !== '') {
          await deps.echecs.noterSansMessage({ messageId: dlr.messageId, tenantId, waId: dlr.to, canal: 'rcs', code: null, motif: dlr.detail });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('échec de RCS libre non journalisé:', err instanceof Error ? err.message : err);
      }
    }
  }
  // 1 quater. La JOIGNABILITÉ, pour l'agent qui a envoyé (le `channelId`, déjà vérifié égal à l'agent de
  //           l'espace par la route de rappel) et en E.164, la clé du cache (`documentation.md` § 5).
  if (dlr.to !== '' && dlr.channelId !== null) {
    const joignable = dlr.echecDefinitif ? false : dlr.status === 'delivered' ? true : null;
    if (joignable !== null) {
      try {
        await deps.joignabilite.put(dlr.channelId, `+${dlr.to}`, joignable, deps.maintenant());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('joignabilité RCS non enregistrée:', err instanceof Error ? err.message : err);
      }
    }
  }
  // 2. Les DEUX sorties du bloc RCS. C'est ICI, et nulle part ailleurs, qu'elles s'allument : chez smsmode le
  //    sort d'un message ne se sait pas avant l'envoi, il se constate APRÈS, sur un rapport. Échec définitif
  //    -> repli WhatsApp. Remis -> la suite du parcours (sauf si le bloc attend encore un clic).
  if (dlr.to !== '') {
    if (dlr.echecDefinitif) await deps.rcsInjoignable(tenantId, dlr.to, dlr.messageId);
    else if (dlr.status === 'delivered') await deps.rcsDelivre(tenantId, dlr.to, dlr.messageId);
  }
}
```

- [ ] **Step 5: Le câblage dans `src/index.ts`**

Ajouter aux imports :

```ts
import { PgEchecsMessagesStore } from './delivery/echecs-messages.pg';
import { PgReachabilityStore } from './rcs/reachability.pg';
import { traiterRapportRcs } from './rcs/rapport-livraison';
```

Après `  const erreursLivraison = new PgErreursLivraisonStore(pool);` :

```ts
  // Les échecs des messages LIBRES (migration <N+1>) et le cache de joignabilité RCS (0057), que le rapport de
  // smsmode alimente depuis le lot 3 de l'API publique et que l'envoi RCS libre lit directement.
  const echecsMessages = new PgEchecsMessagesStore(pool);
  const joignabiliteRcs = new PgReachabilityStore(pool);
```

Remplacer tout le corps de `onDlr` (de la ligne `      onDlr: async (tenant, dlr) => {` jusqu'à la `      },` qui précède `      onMo: async (tenant, mo) => {`) par :

```ts
      /**
       * Le rapport de livraison : destinataire de campagne, mesure par bloc, échec d'un message libre,
       * joignabilité RCS, sorties du bloc. La logique et ses raisons vivent dans `traiterRapportRcs`, testée ;
       * ce câblage ne fait que brancher.
       */
      onDlr: (tenant, dlr) => traiterRapportRcs({
        majLivraison: (id, statut, detail) => recipientStore.updateDeliveryByMessageId(id, statut, detail, null),
        mesureBloc: (id, statut) => nodeEventStore.recordStatusForMessage(id, statut),
        echecs: echecsMessages,
        joignabilite: joignabiliteRcs,
        rcsInjoignable: (t, to, id) => workflowRuntime.executor.rcsUndeliverable(t, to, id),
        rcsDelivre: (t, to, id) => workflowRuntime.executor.rcsDelivered(t, to, id),
        maintenant: () => Date.now(),
      }, tenant, dlr),
```

- [ ] **Step 6: Le voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/rcs-rapport-livraison.test.ts tests/rcs-callback.test.ts && npm run typecheck && npm test`
Expected: PASS partout.

- [ ] **Step 7: Vérifier le test dans les deux sens**

1. Commenter le bloc `if (dlr.echecDefinitif && touches === 0) { ... }` de `src/rcs/rapport-livraison.ts`, relancer `npx vitest run tests/rcs-rapport-livraison.test.ts` : FAIL sur « un échec définitif hors campagne est NOTÉ » (`expected [] to deeply equal [ { messageId: 'sms-1', … } ]`). Restaurer, relancer : PASS.
2. Commenter seulement le repli `if (ecrit === null && dlr.to !== '') { ... }` : FAIL sur « le rapport arrivé AVANT l’inscription du message » (`expected [] to deeply equal [ { messageId: 'sms-1', tenantId: 't1', … } ]`), et le cas « un échec définitif hors campagne est NOTÉ » reste vert (la mutation ne touche que la course). Restaurer, relancer : PASS, et `git diff -- src/rcs/rapport-livraison.ts` ne montre plus aucune ligne commentée.

- [ ] **Step 8: Commit**

`src/index.ts` est un fichier de câblage PARTAGÉ : si `git diff -- src/index.ts` montre une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/rcs/rapport-livraison.ts src/index.ts tests/rcs-rapport-livraison.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N src/rcs/rapport-livraison.ts tests/rcs-rapport-livraison.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
fix(rcs): le rapport smsmode note l'échec d'un RCS libre et apprend la joignabilité

onDlr est extrait vers traiterRapportRcs, testé. Un rapport qui devance l'inscription du message dans le fil
est écrit quand même (noterSansMessage).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Le journal des erreurs lit la quatrième source

**Files:**
- Modify: `src/ops/erreurs-livraison.pg.ts` (import ; constructeur ligne 121 ; fin de `lister`, lignes 237 à 247)
- Modify: `src/index.ts` (`getErrorContacts`, lignes 1187 à 1194) : FICHIER DE CÂBLAGE PARTAGÉ
- Modify: `src/worker.ts` (balayage de rétention, après l'étape `avances` ligne 1605) : FICHIER DE CÂBLAGE PARTAGÉ
- Modify: `web/lib/api/contacts.ts` (interface `ErreurLivraison`, lignes 245 à 264)
- Modify: `web/components/ErreursLivraison.tsx` (après la table `CODES`, ligne 33 ; lignes 137 à 141)
- Test: `tests/integration/echecs-messages.integration.test.ts` (ajout d'un `describe`)

**Interfaces:**
- Consumes : `PgEchecsMessagesStore.lister` et `purgerAvant` (Task 4), `echecsMessages` du worker (Task 5).
- Produces : `new PgErreursLivraisonStore(pool, echecsMessages?)` ; `lister` rend aussi l'origine `message`, sauf avec `campagnesSeulement`.

- [ ] **Step 1: Annoncer l'édition de `src/index.ts` et `src/worker.ts`**

`SendMessage` à chaque session : « Lot 3 API : j'édite src/index.ts (getErrorContacts) et src/worker.ts (purge), commit dans ~15 min. »

- [ ] **Step 2: Écrire le test d'intégration (le rouge local est le typecheck)**

Ajouter à la fin de `tests/integration/echecs-messages.integration.test.ts` :

```ts
describe.skipIf(!url)('le journal des erreurs lit les messages libres (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-journal-libres') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 la quatrième source apparaît dans le journal, et Analytics l’exclut', async () => {
    const conv = await pool.query<{ id: string }>(`insert into conversations (tenant_id, wa_id) values ($1, '33600000601') returning id`, [tenantId]);
    const id = `itest-${randomUUID()}`;
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, type, body, meta_message_id, channel, origin)
       values ($1, 'out', 'text', 'Bonjour', $2, 'whatsapp', 'humain')`,
      [conv.rows[0]!.id, id],
    );
    const journal = new PgErreursLivraisonStore(pool);
    await new PgEchecsMessagesStore(pool).noter({ messageId: id, code: 131026, motif: '131026 Message undeliverable' });
    expect((await journal.lister(tenantId)).filter((e) => e.origine === 'message').map((e) => e.telephone)).toEqual(['33600000601']);
    // Même code, mais les seules campagnes : c'est ce que le compteur d'Analytics compte.
    expect((await journal.lister(tenantId, { code: 131026, campagnesSeulement: true })).some((e) => e.origine === 'message')).toBe(false);
    expect((await journal.lister(tenantId, { code: 131026 })).some((e) => e.origine === 'message')).toBe(true);
  });
});
```

et ajouter en tête du fichier l'import `import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';`.

Run: `cd /c/Users/julie/messagingme-mba && npm run typecheck`
Expected: PASS (le test compile : `campagnesSeulement` existe depuis la Task 4) ; le rouge est côté CI tant que la fusion n'est pas écrite, et ce test ne se lance pas en local. Passer au step suivant.

- [ ] **Step 3: La fusion dans `src/ops/erreurs-livraison.pg.ts`**

Ajouter l'import `import { PgEchecsMessagesStore } from '../delivery/echecs-messages.pg';`.

Remplacer `  constructor(private readonly pool: Pool) {}` par :

```ts
  /**
   * `echecsMessages` : la quatrième source (migration <N+1>). Injectable pour un test, construite ici par
   * défaut : les deux câblages (API et worker) n'ont qu'un `pool` à passer.
   */
  constructor(
    private readonly pool: Pool,
    private readonly echecsMessages: PgEchecsMessagesStore = new PgEchecsMessagesStore(pool),
  ) {}
```

Remplacer, à la fin de `lister`, depuis `    const avances = await this.listerEchecsAvance(tenantId, filtre, limit);` jusqu'à la fin de la fonction, par :

```ts
    // Analytics ne veut QUE les campagnes : son compteur par code n'en compte pas d'autres (`getErrorBreakdown`).
    if (filtre.campagnesSeulement) return campagnes;

    const avances = await this.listerEchecsAvance(tenantId, filtre, limit);
    // La QUATRIÈME source (migration <N+1>) : les messages libres non délivrés.
    const messages = await this.echecsMessages.lister(tenantId, filtre, limit);

    /**
     * Fusion en MÉMOIRE plutôt qu'en `union` SQL, et c'est un choix. Les sources n'ont ni les mêmes colonnes
     * ni les mêmes filtres, donc une union ferait cohabiter plusieurs jeux de fragments de WHERE dans une seule
     * requête. Chaque lecture étant bornée par `limit`, on tient au plus trois fois `limit` lignes le temps du tri.
     */
    return [...campagnes, ...avances, ...messages]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, limit);
  }
```

- [ ] **Step 4: Analytics garde sa parité**

`src/index.ts`, dans `getErrorContacts`, ajouter avant `        limit: PLAFOND_CONTACTS_ERREUR + 1,` :

```ts
        // Les seules campagnes : le compteur cliqué (`getErrorBreakdown`) ne compte qu'elles. Sans ce filtre,
        // un « 12 » ouvrirait aussi les messages libres du même code (lot 3 de l'API publique).
        campagnesSeulement: true,
```

- [ ] **Step 5: La purge de rétention**

`src/worker.ts`, après l'étape `avances` :

```ts
    // Les échecs de messages libres (migration <N+1>) : même nature, même rétention que les échecs d'avance.
    await etape('messages', `échec(s) de message libre effacé(s) (au-delà de ${config.AVANCE_ECHECS_RETENTION_DAYS} j)`,
      () => echecsMessages.purgerAvant(config.AVANCE_ECHECS_RETENTION_DAYS));
```

- [ ] **Step 6: La console montre la nouvelle origine**

`web/lib/api/contacts.ts`, dans `ErreurLivraison`, remplacer `  origine: 'envoi' | 'livraison' | 'scenario';` par :

```ts
  origine: 'envoi' | 'livraison' | 'scenario' | 'message';
  /** Ligne `message` : un message LIBRE n'est pas arrivé. D'où il venait (colonne origin), et son canal. */
  origineMessage?: string | null;
  canal?: 'whatsapp' | 'rcs';
```

et compléter son commentaire JSDoc par la phrase « `message` = un message libre (réponse de l'Inbox, API, MCP, bloc de scénario, agent) n'est pas arrivé. »

`web/components/ErreursLivraison.tsx`, ajouter après la table `CODES` :

```tsx
/** D'où venait un message libre non délivré : la colonne `origin` du message, en mots. */
const ORIGINES_MESSAGE: Record<string, [string, string]> = {
  humain: ['réponse d’un opérateur', 'operator reply'],
  api: ['envoi par l’API', 'API send'],
  mcp: ['agent branché par MCP', 'MCP agent'],
  scenario: ['bloc de scénario', 'scenario block'],
  ia: ['agent IA', 'AI agent'],
  mba: ['agent de Meta', 'Meta agent'],
};
```

dans le composant, après la fonction `sens` :

```tsx
  /** Le libellé d'une ligne `message` : son canal, et d'où venait le message quand on le sait. */
  const libelleMessage = (e: ErreurLivraison): string => {
    const base = e.canal === 'rcs' ? t('RCS non délivré', 'RCS not delivered') : t('message non délivré', 'message not delivered');
    const origine = e.origineMessage ? ORIGINES_MESSAGE[e.origineMessage] : undefined;
    return origine ? `${base} (${t(...origine)})` : base;
  };
```

et, après la ligne `{e.origine === 'scenario' && t('scénario bloqué sur une réponse', 'scenario stuck on a reply')}` :

```tsx
                {e.origine === 'message' && libelleMessage(e)}
```

Mettre à jour le commentaire JSX juste au-dessus : « L'ORIGINE distingue quatre pannes » et ajouter « un message libre non délivré vient du téléphone d'en face, hors de toute campagne ».

- [ ] **Step 7: Vérifier**

Run: `cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test && cd web && npx tsc --noEmit && npm run lint`
Expected: PASS partout.

- [ ] **Step 8: Commit, puis verdict de l'intégration sur la CI**

`src/index.ts` et `src/worker.ts` sont des fichiers de câblage PARTAGÉS : si `git diff` montre sur l'un d'eux une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/ops/erreurs-livraison.pg.ts src/index.ts src/worker.ts web/lib/api/contacts.ts web/components/ErreursLivraison.tsx tests/integration/echecs-messages.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(journal): les messages libres non délivrés entrent dans le journal des erreurs, pas dans Analytics

Quatrième source de PgErreursLivraisonStore.lister, exclue par campagnesSeulement (le détail d'un code
d'Analytics), purgée par le balayage de rétention du worker.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Expected: jobs `integration` et `ci-web` en `success`.

---

### Task 8: `envoyerRcsLibre`, un seul chemin pour l'Inbox et l'API

**Files:**
- Create: `src/rcs/envoyer-libre.ts`
- Modify: `src/crm/contact-store.pg.ts` (nouvelle méthode après `estDesabonneParWaId`, ligne 530)
- Modify: `src/index.ts` (constante `depsRcsLibre` avant `const app = buildServer({`, ligne 639 ; `sendRcsFromInbox`, lignes 956 à 997 ; imports lignes 49, 92, 102, 103) : FICHIER DE CÂBLAGE PARTAGÉ
- Test: `tests/rcs-envoyer-libre.test.ts`
- Test: `tests/integration/rcs-libre.integration.test.ts`

**Interfaces:**
- Consumes : `joignabiliteRcs` (Task 6), `TTL_MS` (`src/rcs/reachability.ts`), `RcsSendOutcome`, `classifyWaId`, `aDesLiensTracables`, `apercuRcsSortant`, `aDesVariables`, `appliquerVariables`.
- Produces :
  - `export type RefusRcsLibre = 'rcs_not_enabled' | 'rcs_unreachable' | 'opted_out' | 'no_consent' | 'no_phone' | 'rcs_message_not_found'`
  - `export interface DepsRcsLibre { agentIdForTenant; estDesabonne; estDesabonneRcs; aConsentiOuEcrit; lireJoignabilite; lireMessageRcs; variablesDeLaFiche; jetonDuContact; envoyer; nouvelId; maintenant }` (signatures dans le code ci-dessous)
  - `export async function envoyerRcsLibre(deps: DepsRcsLibre, tenantId: string, waId: string, contenu: { text: string } | { rcsMessageId: string }, origine: 'humain' | 'api'): Promise<{ messageId: string; apercu: string } | { refus: RefusRcsLibre }>`
  - `export function phraseOperateur(refus: RefusRcsLibre): string`
  - `PgContactStore.aConsentiOuEcritParWaId(tenantId: string, waId: string): Promise<boolean>`
- Inchangé : le contrat `InboxRouteDeps.sendRcsFromInbox` et la route `send-rcs` de `src/http/inbox.ts` (lignes 1093 à 1127).

- [ ] **Step 1: Annoncer l'édition de `src/index.ts`**

`SendMessage` : « Lot 3 API : j'édite src/index.ts (sendRcsFromInbox passe par envoyerRcsLibre), commit dans ~15 min. »

- [ ] **Step 2: Écrire les tests qui échouent**

`tests/rcs-envoyer-libre.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { envoyerRcsLibre, phraseOperateur, type DepsRcsLibre } from '../src/rcs/envoyer-libre';
import { TTL_MS } from '../src/rcs/reachability';
import type { RcsOutbound } from '../src/rcs/types';
import type { RcsSendOutcome } from '../src/rcs/sender';

/**
 * L'ENVOI RCS LIBRE (spec 2026-09-24, § 4) : UN chemin pour le bouton RCS de l'Inbox et `POST /v1/messages/rcs`.
 * La garde de consentement ne vise que la MACHINE, jamais l'opérateur.
 */
interface Monde {
  desabonne: boolean;
  desabonneRcs: boolean;
  consentiOuEcrit: boolean;
  agent: string | null;
  joignabilite: { reachable: boolean; checkedAt: number } | null;
  message: { content: RcsOutbound | null } | null;
  issue: RcsSendOutcome;
}

const MAINTENANT = 1_800_000_000_000;
const MONDE: Monde = {
  desabonne: false, desabonneRcs: false, consentiOuEcrit: true, agent: 'agent-1',
  joignabilite: null, message: null, issue: { messageId: 'rcs-1' },
};
const NUMERO = '33612345678';

function monde(over: Partial<Monde> = {}) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ agentId: string; waId: string; msg: RcsOutbound; id: string; jeton?: string }> = [];
  const lectures: string[] = [];
  const deps: DepsRcsLibre = {
    agentIdForTenant: async () => m.agent,
    estDesabonne: async (_t, waId) => { lectures.push(`desabonne:${waId}`); return m.desabonne; },
    estDesabonneRcs: async (_t, e164) => { lectures.push(`desabonneRcs:${e164}`); return m.desabonneRcs; },
    aConsentiOuEcrit: async (_t, waId) => { lectures.push(`consentement:${waId}`); return m.consentiOuEcrit; },
    lireJoignabilite: async (agentId, e164) => { lectures.push(`joignabilite:${agentId}:${e164}`); return m.joignabilite; },
    lireMessageRcs: async () => m.message,
    variablesDeLaFiche: async () => ({ prenom: 'Camille' }),
    jetonDuContact: async () => 'jeton-1',
    envoyer: async (_t, agentId, waId, msg, id, jeton) => {
      envois.push({ agentId, waId, msg, id, ...(jeton ? { jeton } : {}) });
      return m.issue;
    },
    nouvelId: () => 'id-1',
    maintenant: () => MAINTENANT,
  };
  return { deps, envois, lectures };
}

describe('envoyerRcsLibre : le consentement d’une MACHINE', () => {
  it('a consenti ou a écrit : le RCS part, au wa_id, sous un identifiant neuf', async () => {
    const { deps, envois } = monde();
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(envois).toEqual([{ agentId: 'agent-1', waId: NUMERO, msg: { kind: 'text', text: 'Bonjour' }, id: 'id-1' }]);
  });

  it('🔴 ni consenti ni écrit : no_consent, et RIEN ne part', async () => {
    const { deps, envois, lectures } = monde({ consentiOuEcrit: false });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'no_consent' });
    expect(lectures).toContain(`consentement:${NUMERO}`);
    expect(envois).toEqual([]);
  });

  it('🔴 désabonné du RCS : opted_out, même consenti, AVANT le consentement', async () => {
    const { deps, envois, lectures } = monde({ desabonneRcs: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'opted_out' });
    expect(lectures).toContain('desabonneRcs:+33612345678');
    expect(lectures).not.toContain(`consentement:${NUMERO}`);
    expect(envois).toEqual([]);
  });

  it('désabonné en général : opted_out', async () => {
    const { deps, envois } = monde({ desabonne: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'opted_out' });
    expect(envois).toEqual([]);
  });
});

describe('envoyerRcsLibre : l’OPÉRATEUR n’est pas une machine', () => {
  it('🔴 ni le consentement, ni le désabonnement général, ni le cache de joignabilité ne sont lus, et le message part', async () => {
    const { deps, envois, lectures } = monde({ consentiOuEcrit: false, desabonne: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(lectures).toEqual([]);
    expect(envois).toHaveLength(1);
  });

  it('le STOP RCS l’arrête quand même, par le point de passage unique de l’envoi', async () => {
    const { deps } = monde({ issue: { skipped: 'rcs_optout' } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ refus: 'opted_out' });
  });
});

describe('envoyerRcsLibre : les conditions communes', () => {
  it('pas de numéro (un BSUID) : no_phone, avant toute lecture', async () => {
    const { deps, lectures } = monde();
    expect(await envoyerRcsLibre(deps, 't1', 'BSUID.abc', { text: 'Bonjour' }, 'api')).toEqual({ refus: 'no_phone' });
    expect(lectures).toEqual([]);
  });

  it('canal éteint : rcs_not_enabled', async () => {
    const { deps, envois } = monde({ agent: null });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ refus: 'rcs_not_enabled' });
    expect(envois).toEqual([]);
  });

  it('🔴 injoignable connu et récent : la MACHINE est refusée, l’OPÉRATEUR part comme avant (spec § 17)', async () => {
    const injoignable = { joignabilite: { reachable: false, checkedAt: MAINTENANT - 1000 } };
    const api = monde(injoignable);
    expect(await envoyerRcsLibre(api.deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'rcs_unreachable' });
    expect(api.envois).toEqual([]);
    // Le bouton RCS de l'Inbox doit rester identique : l'opérateur n'est jamais refusé sur le cache.
    const humain = monde(injoignable);
    expect(await envoyerRcsLibre(humain.deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(humain.envois).toHaveLength(1);
  });

  it('injoignable PÉRIMÉ (au-delà de TTL_MS) : on retente', async () => {
    const { deps, envois } = monde({ joignabilite: { reachable: false, checkedAt: MAINTENANT - TTL_MS - 1 } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(envois).toHaveLength(1);
  });

  it('le fournisseur dit non joignable : rcs_unreachable', async () => {
    const { deps } = monde({ issue: { skipped: 'not_rcs_reachable' } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'rcs_unreachable' });
  });
});

describe('envoyerRcsLibre : le contenu', () => {
  it('texte libre : aucune substitution, une accolade tapée reste une accolade', async () => {
    const { deps, envois } = monde();
    await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Prix {{prenom}}' }, 'humain');
    expect(envois[0]!.msg).toEqual({ kind: 'text', text: 'Prix {{prenom}}' });
  });

  it('message de la bibliothèque : variables résolues sur la fiche', async () => {
    const { deps, envois } = monde({ message: { content: { kind: 'text', text: 'Bonjour {{prenom}}' } } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour Camille' });
    expect(envois[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour Camille' });
  });

  it('message supprimé ou illisible : rcs_message_not_found', async () => {
    expect(await envoyerRcsLibre(monde({ message: null }).deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ refus: 'rcs_message_not_found' });
    expect(await envoyerRcsLibre(monde({ message: { content: null } }).deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ refus: 'rcs_message_not_found' });
  });

  it('le jeton du contact n’est lu que si le message porte un lien tracé', async () => {
    const lien: RcsOutbound = { kind: 'text', text: 'Voir', suggestions: [{ kind: 'openUrl', text: 'Ouvrir', url: 'https://exemple.fr/offre', postbackData: 'o' }] };
    const avec = monde({ message: { content: lien } });
    await envoyerRcsLibre(avec.deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain');
    expect(avec.envois[0]!.jeton).toBe('jeton-1');
    const sans = monde();
    await envoyerRcsLibre(sans.deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain');
    expect(sans.envois[0]!.jeton).toBeUndefined();
  });
});

describe('phraseOperateur', () => {
  it('🔴 les phrases que l’opérateur lisait déjà ne changent pas', () => {
    expect(phraseOperateur('rcs_not_enabled')).toBe("Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp).");
    expect(phraseOperateur('rcs_message_not_found')).toBe('Ce message RCS n’existe plus, ou son format n’est plus reconnu.');
    expect(phraseOperateur('opted_out')).toBe('Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.');
    expect(phraseOperateur('rcs_unreachable')).toBe('Ce contact n’est pas joignable en RCS.');
  });
});
```

`tests/integration/rcs-libre.integration.test.ts` :

```ts
import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgContactStore } from '../../src/crm/contact-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE CONSENTEMENT D'UN RCS LIBRE ENVOYÉ PAR UNE MACHINE (spec 2026-09-24, § 4) : « opted_in OU nous a déjà
 * écrit ». En intégration parce que « a écrit » est une requête sur les messages entrants du fil. Jamais en local.
 */
describe.skipIf(!url)('RCS libre : lectures de fiche (Postgres)', () => {
  let pool: Pool;
  let store: PgContactStore;
  let tenantId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgContactStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-rcs-libre') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  const fiche = async (phone: string, optIn: 'opted_in' | 'unknown'): Promise<string> =>
    (await pool.query<{ id: string }>(`insert into contacts (tenant_id, phone_e164, opt_in_status) values ($1, $2, $3) returning id`, [tenantId, phone, optIn])).rows[0]!.id;
  const fil = async (waId: string, direction: 'in' | 'out'): Promise<void> => {
    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id) values ($1, $2) on conflict (tenant_id, wa_id) do update set wa_id = excluded.wa_id returning id`,
      [tenantId, waId],
    );
    await pool.query(`insert into conversation_messages (conversation_id, direction, type, body) values ($1, $2, 'text', 'x')`, [conv.rows[0]!.id, direction]);
  };

  it('🔴 les quatre cas du consentement d’une machine', async () => {
    await fiche('+33600000701', 'opted_in');
    await fiche('+33600000702', 'unknown');
    await fil('33600000702', 'in');
    await fiche('+33600000703', 'unknown');
    await fiche('+33600000704', 'unknown');
    await fil('33600000704', 'out');
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000701')).toBe(true);   // consenti, jamais écrit
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000702')).toBe(true);   // a écrit, sans consentement
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000703')).toBe(false);  // ni l'un ni l'autre
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000704')).toBe(false);  // on lui a écrit, lui non
    expect(await store.aConsentiOuEcritParWaId(tenantId, '33600000799')).toBe(false);  // aucune fiche
  });
});
```

- [ ] **Step 3: Les voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/rcs-envoyer-libre.test.ts && npm run typecheck`
Expected: FAIL, module `../src/rcs/envoyer-libre` introuvable ; `typecheck` FAIL sur `aConsentiOuEcritParWaId` inexistant.

- [ ] **Step 4: Écrire `src/rcs/envoyer-libre.ts`**

```ts
import { classifyWaId } from '../crm/identity';
import { aDesLiensTracables } from '../links/rcs-liens';
import { TTL_MS } from './reachability';
import { apercuRcsSortant } from './schema';
import type { RcsSendOutcome } from './sender';
import type { RcsOutbound } from './types';
import { aDesVariables, appliquerVariables } from './variables';

/**
 * L'ENVOI D'UN RCS LIBRE : UNE implémentation, deux appelants (spec 2026-09-24, § 4).
 *
 * Le bouton RCS de l'Inbox (un OPÉRATEUR) et `POST /v1/messages/rcs` (une MACHINE) passent par ici, sur le
 * modèle de `repondreDansLaFenetre` pour WhatsApp : une copie des gardes dans la route de l'API aurait fait
 * deux jeux de règles sur le même envoi.
 *
 * L'ORDRE est celui de la spec : un numéro ; pas désabonné (en général ni du RCS) ; consenti OU a déjà écrit ;
 * canal actif ; pas connu injoignable (désabonnement général, consentement et joignabilité : pour une machine
 * seulement). Le contact inconnu et le contact bloqué sont refusés AVANT, par la route
 * de l'API (elle seule sait résoudre une fiche) ; l'Inbox part d'une conversation qui existe.
 *
 * 🔴 UNE MACHINE NE PARLE PAS À QUI N'A NI CONSENTI NI ÉCRIT, NI À QUI A DIT STOP ; UN OPÉRATEUR SI. Même
 * doctrine que `repondreDansLaFenetre` (décision du 2026-09-13) : la garde se pose sur « tout ce qui n'est pas
 * un opérateur humain », jamais sur une liste d'appelants. Le STOP RCS arrête quand même l'opérateur, par le
 * point de passage unique de l'envoi (`RcsSender.sendTo`).
 *
 * 🔴 LA JOIGNABILITÉ SE LIT DANS LE CACHE, DIRECTEMENT, ET POUR UNE MACHINE SEULEMENT. `RcsSender` saute ce
 * contrôle quand le fournisseur ne sait pas vérifier avant l'envoi (smsmode) : le cache n'est alors nourri que
 * par les rapports de livraison (`traiterRapportRcs`). Un « injoignable » plus vieux que `TTL_MS` ne refuse plus
 * rien : un parc mobile bascule. L'OPÉRATEUR n'y est pas soumis : la spec (§ 17) veut le bouton RCS de l'Inbox
 * IDENTIQUE, et smsmode range en échec définitif un téléphone simplement éteint (UNDELIVERED), qui aurait
 * refusé l'opérateur sept jours durant sur un numéro redevenu joignable.
 */

export type RefusRcsLibre = 'rcs_not_enabled' | 'rcs_unreachable' | 'opted_out' | 'no_consent' | 'no_phone' | 'rcs_message_not_found';

export interface DepsRcsLibre {
  agentIdForTenant(tenantId: string): Promise<string | null>;
  /** STOP général. REQUISE ; lue seulement pour une origine machine. */
  estDesabonne(tenantId: string, waId: string): Promise<boolean>;
  /** STOP RCS (`contacts.rcs_optout_at`). Lue seulement pour une origine machine ; l'envoi la relit pour tous. */
  estDesabonneRcs(tenantId: string, e164: string): Promise<boolean>;
  /** A consenti (`opted_in`) OU nous a déjà écrit (un entrant, tout canal). Lue seulement pour une machine. */
  aConsentiOuEcrit(tenantId: string, waId: string): Promise<boolean>;
  /** Le cache de joignabilité, clé (agent, E.164). Lu seulement pour une origine machine. */
  lireJoignabilite(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null>;
  lireMessageRcs(tenantId: string, id: string): Promise<{ content: RcsOutbound | null } | null>;
  variablesDeLaFiche(tenantId: string, waId: string): Promise<Record<string, string | null>>;
  jetonDuContact(tenantId: string, waId: string): Promise<string | undefined>;
  envoyer(tenantId: string, agentId: string, waId: string, msg: RcsOutbound, messageId: string, jeton?: string): Promise<RcsSendOutcome>;
  nouvelId(): string;
  maintenant(): number;
}

export async function envoyerRcsLibre(
  deps: DepsRcsLibre,
  tenantId: string,
  waId: string,
  contenu: { text: string } | { rcsMessageId: string },
  origine: 'humain' | 'api',
): Promise<{ messageId: string; apercu: string } | { refus: RefusRcsLibre }> {
  // Le RCS s'adresse à un NUMÉRO : un wa_id qui n'en est pas un (un BSUID) ne peut pas le recevoir.
  const { phoneE164 } = classifyWaId(waId);
  if (!phoneE164) return { refus: 'no_phone' };

  if (origine !== 'humain') {
    if ((await deps.estDesabonne(tenantId, waId)) || (await deps.estDesabonneRcs(tenantId, phoneE164))) return { refus: 'opted_out' };
    if (!(await deps.aConsentiOuEcrit(tenantId, waId))) return { refus: 'no_consent' };
  }

  const agentId = await deps.agentIdForTenant(tenantId);
  if (!agentId) return { refus: 'rcs_not_enabled' };

  // Machine seulement : le bouton RCS de l'Inbox reste identique (spec § 17, cf. le docblock).
  if (origine !== 'humain') {
    const connu = await deps.lireJoignabilite(agentId, phoneE164);
    if (connu && !connu.reachable && deps.maintenant() - connu.checkedAt <= TTL_MS) return { refus: 'rcs_unreachable' };
  }

  // Réponse LIBRE : rien à relire, rien à substituer. Une accolade tapée par erreur n'est pas un trou.
  let message: RcsOutbound;
  if ('text' in contenu) {
    message = { kind: 'text', text: contenu.text };
  } else {
    const enregistre = await deps.lireMessageRcs(tenantId, contenu.rcsMessageId);
    if (!enregistre?.content) return { refus: 'rcs_message_not_found' };
    message = aDesVariables(enregistre.content)
      ? appliquerVariables(enregistre.content, await deps.variablesDeLaFiche(tenantId, waId))
      : enregistre.content;
  }

  // QUI a cliqué : lu SEULEMENT si le message porte un lien tracé, et jamais bloquant.
  const jeton = aDesLiensTracables(message) ? await deps.jetonDuContact(tenantId, waId) : undefined;
  const issue = await deps.envoyer(tenantId, agentId, waId, message, deps.nouvelId(), jeton);
  if ('skipped' in issue) return { refus: issue.skipped === 'rcs_optout' ? 'opted_out' : 'rcs_unreachable' };
  return { messageId: issue.messageId, apercu: apercuRcsSortant(message) };
}

/**
 * La raison d'un refus, DESTINÉE À L'OPÉRATEUR de l'Inbox : « le canal n'est pas activé » et « ce contact s'est
 * désabonné » demandent deux gestes différents. Les quatre premières phrases sont celles qu'il lisait déjà.
 */
export function phraseOperateur(refus: RefusRcsLibre): string {
  switch (refus) {
    case 'rcs_not_enabled': return "Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp).";
    case 'rcs_message_not_found': return 'Ce message RCS n’existe plus, ou son format n’est plus reconnu.';
    case 'opted_out': return 'Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.';
    case 'rcs_unreachable': return 'Ce contact n’est pas joignable en RCS.';
    case 'no_phone': return 'Ce contact n’a pas de numéro de téléphone : le RCS ne peut pas lui parvenir. Passez par WhatsApp.';
    case 'no_consent': return 'Ce contact n’a ni consenti ni jamais écrit.';
  }
}
```

- [ ] **Step 5: La lecture de consentement dans `src/crm/contact-store.pg.ts`**

Ajouter après `estDesabonneParWaId` :

```ts
  /**
   * CE CONTACT A-T-IL CONSENTI, OU NOUS A-T-IL DÉJÀ ÉCRIT ? La garde d'un RCS libre envoyé par une MACHINE
   * (spec 2026-09-24, § 4) : un message simple ne fonde pas une relation.
   *
   * « A écrit » = au moins un message ENTRANT dans son fil, tout canal (le fil est unique par contact, 0056).
   * ⚠️ Un contact INCONNU n'a ni consenti ni écrit : `false`, et c'est la route qui l'a déjà refusé en 404.
   * ⚠️ Le `exists` s'arrête au premier entrant, par l'index (conversation_id, created_at) de 0009.
   */
  async aConsentiOuEcritParWaId(tenantId: string, waId: string): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean }>(
      `select (opt_in_status = 'opted_in')
              or exists (
                select 1
                  from conversations v
                  join conversation_messages m on m.conversation_id = v.id
                 where v.tenant_id = $1 and v.wa_id = $2 and m.direction = 'in'
              ) as ok
         from contacts
        where tenant_id = $1 and deleted_at is null
        ${MATCH_BY_WAID_SQL}`,
      [tenantId, waId],
    );
    return res.rows[0]?.ok === true;
  }
```

- [ ] **Step 6: Le câblage dans `src/index.ts`**

Ajouter l'import `import { envoyerRcsLibre, phraseOperateur, type DepsRcsLibre } from './rcs/envoyer-libre';`.

Juste avant `  const app = buildServer({` :

```ts
  /**
   * L'ENVOI RCS LIBRE, partagé par le bouton RCS de l'Inbox et par `POST /v1/messages/rcs` (lot 3 de l'API
   * publique). Les gardes vivent dans `envoyerRcsLibre`, testée ; ce bloc ne fait que brancher.
   */
  const depsRcsLibre: DepsRcsLibre = {
    agentIdForTenant: (t) => workflowRuntime.rcsStack.agents.agentIdForTenant(t),
    estDesabonne: (t, waId) => contactStore.estDesabonneParWaId(t, waId),
    estDesabonneRcs: (t, e164) => workflowRuntime.rcsStack.optout.isOptedOut(t, e164),
    aConsentiOuEcrit: (t, waId) => contactStore.aConsentiOuEcritParWaId(t, waId),
    lireJoignabilite: (agentId, e164) => joignabiliteRcs.get(agentId, e164),
    lireMessageRcs: (t, id) => rcsMessageStore.getById(t, id),
    variablesDeLaFiche: async (t, waId) => contactVars(await contactStore.getResolvableByPhone(t, waId) ?? {}),
    jetonDuContact: async (t, waId) => (await trackedLinkStore.jetonPourE164(t, waId, fabriquerJeton).catch(() => null)) ?? undefined,
    envoyer: (t, agentId, waId, msg, id, jeton) => workflowRuntime.rcsStack.sender.sendTo(t, agentId, waId, msg, id, jeton),
    nouvelId: () => randomUUID(),
    maintenant: () => Date.now(),
  };
```

Remplacer le commentaire et le corps de `sendRcsFromInbox` (de `      /**\n       * Envoi d'un message RCS depuis l'inbox.` jusqu'à la `      },` qui précède `      // Un opérateur qui écrit prend le fil`) par :

```ts
      /**
       * Envoi d'un message RCS depuis l'inbox, par le MÊME chemin que `POST /v1/messages/rcs`
       * (`envoyerRcsLibre`). Origine `humain` : ni la garde de consentement, ni celle du désabonnement général,
       * ni le cache de joignabilité ne s'appliquent à un opérateur (le bouton reste identique, spec § 17) ; le
       * STOP RCS, si, par le point de passage unique de l'envoi.
       * Chaque refus porte sa RAISON, destinée à l'opérateur (`phraseOperateur`).
       */
      sendRcsFromInbox: async (tenant, waId, contenu) => {
        const issue = await envoyerRcsLibre(depsRcsLibre, tenant, waId, contenu, 'humain');
        return 'refus' in issue ? { refus: phraseOperateur(issue.refus) } : issue;
      },
```

Retirer les imports devenus inutiles, APRÈS avoir vérifié qu'ils le sont :

```bash
cd /c/Users/julie/messagingme-mba && for s in aDesLiensTracables apercuRcsSortant aDesVariables appliquerVariables RcsOutbound; do echo "$s: $(grep -c "\b$s\b" src/index.ts)"; done
```

Expected: `1` pour chacun (la seule ligne d'import). Retirer alors `import { aDesLiensTracables } from './links/rcs-liens';`, `import type { RcsOutbound } from './rcs/types';`, `import { apercuRcsSortant } from './rcs/schema';` et `import { aDesVariables, appliquerVariables } from './rcs/variables';`. Un compte supérieur à 1 : ne pas retirer cet import.

- [ ] **Step 7: Le voir passer, et l'Inbox rester identique**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/rcs-envoyer-libre.test.ts tests/http-inbox-rcs.test.ts && npm run typecheck && npm test`
Expected: PASS partout (`tests/http-inbox-rcs.test.ts` n'a pas bougé : le contrat de la route est le même).

- [ ] **Step 8: Vérifier le test du consentement dans les deux sens**

1. Dans `envoyerRcsLibre`, remplacer temporairement le PREMIER `if (origine !== 'humain') {` (celui du consentement) par `if (false) {`, relancer `npx vitest run tests/rcs-envoyer-libre.test.ts` : FAIL sur « ni consenti ni écrit » (`expected { messageId: 'rcs-1', … } to deeply equal { refus: 'no_consent' }`, le message PART). Restaurer, relancer : PASS.
2. Remplacer temporairement le SECOND (celui de la joignabilité) par `if (true) {` : FAIL sur « la MACHINE est refusée, l’OPÉRATEUR part comme avant » (`expected { refus: 'rcs_unreachable' } to deeply equal { messageId: 'rcs-1', … }`, c'est le bouton de l'Inbox qui cesserait d'être identique), et sur « ni le consentement, ni le désabonnement général, ni le cache » (la lecture du cache apparaît). Restaurer, relancer : PASS, et `git diff -- src/rcs/envoyer-libre.ts` ne montre ni `if (false)` ni `if (true)`.

- [ ] **Step 9: Commit**

`src/index.ts` est un fichier de câblage PARTAGÉ : si `git diff -- src/index.ts` montre une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/rcs/envoyer-libre.ts src/crm/contact-store.pg.ts src/index.ts tests/rcs-envoyer-libre.test.ts tests/integration/rcs-libre.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N src/rcs/envoyer-libre.ts tests/rcs-envoyer-libre.test.ts tests/integration/rcs-libre.integration.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(rcs): envoyerRcsLibre, un seul chemin pour l'Inbox et l'API, les gardes de machine ne visant que la machine

Consentement, désabonnement général et joignabilité connue ne s'appliquent qu'à une origine machine ; le
bouton RCS de l'Inbox garde son comportement et ses phrases (spec § 17).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

---

### Task 9: La route `POST /v1/messages/rcs`

**Files:**
- Create: `src/http/v1-messages-rcs.ts`
- Modify: `src/server.ts` (import ligne 58 ; `ServerDeps.v1` lignes 241 à 250 ; montage après la ligne 547) : FICHIER DE CÂBLAGE PARTAGÉ
- Modify: `src/crm/contact-store.pg.ts` (nouvelle méthode après `aConsentiOuEcritParWaId`)
- Modify: `src/index.ts` (`v1.messagesRcs`, après le bloc `messages:` du lot 2, qui se termine ligne 3151 avant le lot 2) : FICHIER DE CÂBLAGE PARTAGÉ
- Modify: `src/api/usage-guard.ts` (les deux lignes de commentaire au-dessus de `| 'messages.send'`, lignes 28 et 29 avant le lot 2 ; le lot 2 ajoute un import en tête et réécrit la première : s'appuyer sur le texte)
- Test: `tests/v1-messages-rcs.test.ts`
- Test: `tests/integration/rcs-libre.integration.test.ts` (ajout d'un cas)

**Interfaces:**
- Consumes : `resoudreFiche`, `schemaClesFiche`, `ClesFiche`, `ModeCreation`, `ResolutionFiche` (lot 1) ; `refuser` (lot 1) ; la fermeture `(tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o)` du câblage du lot 2 (vérifiée à la Task 0) ; `envoyerRcsLibre`, `DepsRcsLibre` (Task 8) ; `compterOuRefuser(..., 'messages.send')` ; `DepsRepondre['recordOutbound']` ; `PgInboxStore.setControlOwner` (un `update` sur `(tenant_id, wa_id)`, qui ne CRÉE rien) et `ouvrirConversationDuContact` (un upsert).
- Produces :
  - `export interface V1MessagesRcsRouteDeps { resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>; etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null>; rcs: DepsRcsLibre; ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>; takeControl(tenantId: string, waId: string): Promise<void>; recordOutbound: DepsRepondre['recordOutbound']; usage: ApiUsageGuard }` (même `resoudreFiche` que `V1MessagesRouteDeps` du lot 2 ; la route l'appelle avec `{ creer: 'jamais' }`)
  - `export function registerV1MessagesRcs(app: FastifyInstance, deps: V1MessagesRcsRouteDeps, garde: Guard): void`
  - `ServerDeps.v1.messagesRcs?: Omit<V1MessagesRcsRouteDeps, 'usage'>`
  - `PgContactStore.etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null>`
  - Réponse 200 : `{ messageId: string, conversationId: string | null, channel: 'rcs' }`.

- [ ] **Step 1: Annoncer l'édition de `src/server.ts` et `src/index.ts`**

`SendMessage` : « Lot 3 API : j'édite src/server.ts (montage de /v1/messages/rcs) et src/index.ts (son câblage), commit dans ~20 min. »

- [ ] **Step 2: Écrire le test qui échoue**

`tests/v1-messages-rcs.test.ts` :

```ts
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { registerV1MessagesRcs, type V1MessagesRcsRouteDeps } from '../src/http/v1-messages-rcs';
import type { DepsRcsLibre } from '../src/rcs/envoyer-libre';
import type { ClesFiche, ModeCreation, ResolutionFiche } from '../src/api/fiche';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';
import type { PreHandler } from '../src/auth/middleware';
import type { OrigineMessage } from '../src/inbox/origine';
import { RCS_TEXTE_MAX } from '../src/rcs/schema';

/**
 * `POST /v1/messages/rcs` (spec 2026-09-24, § 4). La route ne décide que de la FICHE (la trouver, un numéro,
 * pas bloquée) ; le reste est `envoyerRcsLibre`, partagé avec l'Inbox. Ces cas vérifient l'ORDRE des refus,
 * leurs codes, et ce qui part et s'enregistre.
 */
const cle: PreHandler = async (req) => {
  req.auth = { userId: 'apikey:k1', tenantId: 't1', role: 'api' };
  req.apiKeyId = 'k1';
};

interface Monde {
  fiches: Record<string, { phone: string | null; bloque: boolean }>;
  consentiOuEcrit: boolean;
  desabonne: boolean;
  agent: string | null;
  injoignable: boolean;
}

const MONDE: Monde = {
  fiches: {
    c1: { phone: '+33612345678', bloque: false },
    sansNumero: { phone: null, bloque: false },
    bloquee: { phone: '+33698765432', bloque: true },
    bloqueeSansNumero: { phone: null, bloque: true },
  },
  consentiOuEcrit: true, desabonne: false, agent: 'agent-1', injoignable: false,
};

async function app(over: Partial<Monde> = {}, garde: PreHandler = cle) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ waId: string; text: string }> = [];
  const enregistres: Array<{ conversationId: string; body: string; origine: OrigineMessage; type?: string; auteur: string | null; canal?: string }> = [];
  const prises: string[] = [];
  const creations: ModeCreation[] = [];
  /** L'ORDRE des gestes qui suivent l'envoi : ouvrir le fil, le prendre, y inscrire le message. */
  const journal: string[] = [];
  /** Les wa_id dont le fil EXISTE. Aucun au départ : le cas courant de l'API est une fiche qui n'a jamais écrit. */
  const ouverts = new Set<string>();
  const rcs: DepsRcsLibre = {
    agentIdForTenant: async () => m.agent,
    estDesabonne: async () => m.desabonne,
    estDesabonneRcs: async () => false,
    aConsentiOuEcrit: async () => m.consentiOuEcrit,
    lireJoignabilite: async () => (m.injoignable ? { reachable: false, checkedAt: Date.now() } : null),
    lireMessageRcs: async () => null,
    variablesDeLaFiche: async () => ({}),
    jetonDuContact: async () => undefined,
    envoyer: async (_t, _a, waId, msg) => { envois.push({ waId, text: msg.kind === 'text' ? msg.text : '' }); return { messageId: 'rcs-1' }; },
    nouvelId: () => 'id-1',
    maintenant: () => Date.now(),
  };
  const usage = new GardeUsageMemoire();
  const deps: V1MessagesRcsRouteDeps = {
    resoudreFiche: async (_t, cles: ClesFiche, o): Promise<ResolutionFiche> => {
      creations.push(o.creer);
      if (cles.contactId === 'conflit') return { ok: false, code: 'identity_conflict' };
      if (cles.externalId === 'crm-7781') return { ok: true, contactId: 'c1', cree: false };
      if (cles.contactId && m.fiches[cles.contactId]) return { ok: true, contactId: cles.contactId, cree: false };
      return { ok: false, code: 'unknown_contact' };
    },
    etatPourEnvoi: async (_t, id) => { const f = m.fiches[id]; return f ? { phoneE164: f.phone, bloque: f.bloque } : null; },
    rcs,
    ouvrirConversation: async (_t, contactId) => {
      const tel = m.fiches[contactId]?.phone;
      if (tel) ouverts.add(tel.replace(/\D/g, ''));
      journal.push(`ouvrir:${contactId}`);
      return 'conv-1';
    },
    // COMME LE VRAI `setControlOwner` : un `update` sur (espace, wa_id), qui ne touche RIEN tant que le fil
    // n'existe pas. Un faux qui enregistrerait la prise quoi qu'il arrive ne verrait pas l'ordre fautif.
    takeControl: async (_t, waId) => {
      if (!ouverts.has(waId)) return;
      prises.push(waId);
      journal.push(`prise:${waId}`);
    },
    recordOutbound: async (conversationId, body, _id, origine, type, _cat, _nom, auteur, canal) => {
      enregistres.push({ conversationId, body, origine, type, auteur: auteur ?? null, canal });
      journal.push(`inscrit:${conversationId}`);
    },
    usage,
  };
  const server = Fastify();
  registerV1MessagesRcs(server, deps, garde);
  await server.ready();
  return { server, envois, enregistres, prises, creations, journal, usage };
}

type App = Awaited<ReturnType<typeof app>>;
const post = (a: App, payload: unknown) =>
  a.server.inject({ method: 'POST', url: '/v1/messages/rcs', headers: { 'content-type': 'application/json' }, payload: payload as object });

describe('POST /v1/messages/rcs', () => {
  it('200 : le RCS part, s’inscrit dans l’Inbox avec l’origine api, et le fil est pris', async () => {
    const a = await app();
    const res = await post(a, { externalId: 'crm-7781', text: 'Bonjour' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ messageId: 'rcs-1', conversationId: 'conv-1', channel: 'rcs' });
    expect(a.envois).toEqual([{ waId: '33612345678', text: 'Bonjour' }]);
    expect(a.enregistres).toEqual([{ conversationId: 'conv-1', body: 'Bonjour', origine: 'api', type: 'rcs', auteur: null, canal: 'rcs' }]);
    expect(a.usage.compteurs().map((c) => c.operation)).toEqual(['messages.send']);
    // Un message simple ne fonde pas une relation : la fiche n'est jamais créée ici.
    expect(a.creations).toEqual(['jamais']);
    await a.server.close();
  });

  it('🔴 « écrire PREND le fil » (§ 4), même pour une fiche qui n’a jamais écrit : ouvrir, PUIS prendre, PUIS inscrire', async () => {
    const a = await app();
    await post(a, { contactId: 'c1', text: 'Bonjour' });
    expect(a.prises).toEqual(['33612345678']);
    expect(a.journal).toEqual(['ouvrir:c1', 'prise:33612345678', 'inscrit:conv-1']);
    await a.server.close();
  });

  it('corps invalide : 400 invalid_body, et rien n’est compté ni envoyé', async () => {
    const a = await app();
    for (const corps of [
      { contactId: 'c1' },
      { contactId: 'c1', text: '' },
      { contactId: 'c1', text: 'x'.repeat(RCS_TEXTE_MAX + 1) },
      { contactId: 'c1', text: 'x', rcsMessageId: 'm1' },
    ]) {
      const res = await post(a, corps);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('invalid_body');
    }
    expect(a.envois).toEqual([]);
    expect(a.usage.compteurs()).toEqual([]);
    await a.server.close();
  });

  it('fiche introuvable : 404 unknown_contact ; clés contradictoires : 409 identity_conflict', async () => {
    const a = await app();
    const inconnue = await post(a, { contactId: 'personne', text: 'x' });
    expect([inconnue.statusCode, inconnue.json<{ code: string }>().code]).toEqual([404, 'unknown_contact']);
    const conflit = await post(a, { contactId: 'conflit', text: 'x' });
    expect([conflit.statusCode, conflit.json<{ code: string }>().code]).toEqual([409, 'identity_conflict']);
    expect(a.envois).toEqual([]);
    await a.server.close();
  });

  it('🔴 l’ordre du § 4 : pas de numéro (422) passe AVANT bloqué (409)', async () => {
    const a = await app();
    const r1 = await post(a, { contactId: 'bloqueeSansNumero', text: 'x' });
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([422, 'no_phone']);
    const r2 = await post(a, { contactId: 'bloquee', text: 'x' });
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([409, 'blocked_contact']);
    expect(a.envois).toEqual([]);
    await a.server.close();
  });

  it('désabonné : 409 opted_out', async () => {
    const a = await app({ desabonne: true });
    const res = await post(a, { contactId: 'c1', text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'opted_out']);
    await a.server.close();
  });

  it('🔴 ni consenti ni écrit : 409 no_consent, rien ne part, et AUCUN fil n’est créé', async () => {
    const a = await app({ consentiOuEcrit: false });
    const res = await post(a, { contactId: 'c1', text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([409, 'no_consent']);
    expect(a.envois).toEqual([]);
    expect(a.journal).toEqual([]);
    await a.server.close();
  });

  it('canal éteint : 409 rcs_not_enabled ; injoignable connu : 422 rcs_unreachable', async () => {
    const eteint = await app({ agent: null });
    const r1 = await post(eteint, { contactId: 'c1', text: 'x' });
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([409, 'rcs_not_enabled']);
    await eteint.server.close();
    const injoignable = await app({ injoignable: true });
    const r2 = await post(injoignable, { contactId: 'c1', text: 'x' });
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([422, 'rcs_unreachable']);
    expect(injoignable.envois).toEqual([]);
    await injoignable.server.close();
  });

  it('sans authentification : 401 unauthorized', async () => {
    const a = await app({}, async () => {});
    const res = await post(a, { contactId: 'c1', text: 'x' });
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([401, 'unauthorized']);
    await a.server.close();
  });
});
```

Ajouter à `tests/integration/rcs-libre.integration.test.ts`, dans le même `describe` :

```ts
  it('etatPourEnvoi : le numéro et le blocage, rien pour une fiche supprimée ou d’un autre espace', async () => {
    const id = await fiche('+33600000705', 'unknown');
    expect(await store.etatPourEnvoi(tenantId, id)).toEqual({ phoneE164: '+33600000705', bloque: false });
    await pool.query('update contacts set blocked_at = now() where id = $1', [id]);
    expect(await store.etatPourEnvoi(tenantId, id)).toEqual({ phoneE164: '+33600000705', bloque: true });
    await pool.query('update contacts set deleted_at = now() where id = $1', [id]);
    expect(await store.etatPourEnvoi(tenantId, id)).toBeNull();
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-rcs-libre-2') returning id`)).rows[0]!.id;
    try {
      expect(await store.etatPourEnvoi(autre, await fiche('+33600000706', 'unknown'))).toBeNull();
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });
```

- [ ] **Step 3: Le voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/v1-messages-rcs.test.ts`
Expected: FAIL, module `../src/http/v1-messages-rcs` introuvable.

- [ ] **Step 4: Écrire `src/http/v1-messages-rcs.ts`**

```ts
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { refuser } from '../api/erreurs';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { waIdOf } from '../crm/identity';
import type { DepsRepondre } from '../inbox/repondre';
import { envoyerRcsLibre, type DepsRcsLibre, type RefusRcsLibre } from '../rcs/envoyer-libre';
import { RCS_TEXTE_MAX } from '../rcs/schema';

/**
 * `POST /v1/messages/rcs` : un TEXTE en RCS, à UNE personne qui a une fiche (spec 2026-09-24, § 4, lot 3).
 *
 * 🔴 ELLE N'A PRESQUE AUCUNE LOGIQUE À ELLE. Les gardes du RCS (désabonnement, consentement d'une machine, canal,
 * joignabilité) et l'envoi vivent dans `envoyerRcsLibre`, partagé avec le bouton RCS de l'Inbox. Cette route ne
 * fait que ce qu'elle seule sait faire : trouver la FICHE par les clés reçues, exiger un numéro, refuser un
 * contact bloqué, et traduire chaque refus en code.
 *
 * ⚠️ UN MODULE À PART DE `/v1/messages/whatsapp` : leurs règles n'ont presque rien en commun (pas de fenêtre de
 * 24 h ici, un consentement là), et la spec les veut en deux routes. Même garde, même limiteur, même droit
 * `sends:create`, même opération d'usage (`messages.send` : un message, une personne).
 *
 * ⚠️ LE FIL S'OUVRE APRÈS L'ENVOI, JAMAIS AVANT. Un refus (pas de consentement, canal éteint) n'a rien à montrer
 * dans l'Inbox : ouvrir le fil d'abord y ferait apparaître une conversation vide en tête de liste pour une
 * personne à qui rien n'est parti.
 *
 * 🔴 ET IL S'OUVRE AVANT D'ÊTRE PRIS. `takeControl` est un `update` sur (espace, wa_id) qui ne crée rien : pris
 * avant l'ouverture, le fil d'une fiche qui n'a jamais écrit (le cas courant de l'API, une fiche créée par
 * `/v1/contacts`) naîtrait ensuite avec le détenteur par défaut, donc NON pris, à rebours du § 4 de la spec
 * (« Écrire PREND le fil »). `/v1/messages/whatsapp` ouvre, lui aussi, avant de prendre.
 *
 * ⚠️ AUCUNE CLÉ D'IDEMPOTENCE, comme la barre de réponse de l'Inbox et `/v1/messages/whatsapp`.
 */
export interface V1MessagesRcsRouteDeps {
  /**
   * La résolution de fiche du lot 1, liée par le câblage aux MÊMES dépendances que `/v1/contacts`, `/v1/sends`
   * et `/v1/messages/whatsapp`. La route l'appelle en `creer: 'jamais'` : un message simple ne fonde pas une
   * relation.
   */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /** Le numéro et le blocage d'une fiche NON supprimée de cet espace. `null` = introuvable. */
  etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null>;
  /** Les dépendances d'`envoyerRcsLibre`, transmises d'un seul objet, jamais recopiées champ par champ. */
  rcs: DepsRcsLibre;
  /** Le fil du contact, créé s'il n'existe pas (la fonction du bouton « Ouvrir la conversation »). */
  ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>;
  takeControl(tenantId: string, waId: string): Promise<void>;
  recordOutbound: DepsRepondre['recordOutbound'];
  /** Le garde d'usage, injecté par `buildServer`. OBLIGATOIRE, comme sur les autres routes /v1. */
  usage: ApiUsageGuard;
}

/**
 * Les clés de fiche du lot 1, plus le texte. `strictObject` : une clé inconnue (un `rcsMessageId` d'Inbox, une
 * faute de frappe) est un défaut de forme, pas un champ ignoré.
 */
const schemaMessageRcs = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().trim().min(1).max(RCS_TEXTE_MAX),
});

type RefusDeFiche = Extract<ResolutionFiche, { ok: false }>['code'];

const REFUS_FICHE: Record<RefusDeFiche, { statut: 400 | 404 | 409; message: string }> = {
  invalid_recipient: { statut: 400, message: 'désignez le destinataire par au moins une clé : contactId, externalId, phone ou bsuid' },
  invalid_phone: { statut: 400, message: 'numéro de téléphone invalide' },
  unknown_contact: { statut: 404, message: 'aucune fiche ne correspond à ce destinataire' },
  identity_conflict: { statut: 409, message: 'ces clés désignent des fiches différentes' },
};

const REFUS_RCS: Record<RefusRcsLibre, { statut: 404 | 409 | 422; message: string }> = {
  no_phone: { statut: 422, message: 'cette fiche ne porte aucun numéro : le RCS s’adresse à un numéro de téléphone' },
  opted_out: { statut: 409, message: 'ce contact a demandé à ne plus recevoir de messages' },
  no_consent: { statut: 409, message: 'ce contact n’a ni consenti ni jamais écrit : un message simple ne peut pas ouvrir la relation, utilisez POST /v1/sends' },
  rcs_not_enabled: { statut: 409, message: 'le canal RCS n’est pas activé sur cet espace' },
  rcs_unreachable: { statut: 422, message: 'ce numéro n’est pas joignable en RCS (dernier rapport de livraison)' },
  rcs_message_not_found: { statut: 404, message: 'message RCS introuvable' },
};

export function registerV1MessagesRcs(app: FastifyInstance, deps: V1MessagesRcsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages/rcs', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const corps = schemaMessageRcs.safeParse(req.body);
    if (!corps.success) {
      const defaut = corps.error.issues[0];
      const champ = defaut ? defaut.path.map(String).join('.') : '';
      return refuser(reply, 400, 'invalid_body', defaut ? `${champ || 'corps'} : ${defaut.message}` : 'corps invalide');
    }
    // Compté APRÈS la validation, comme sur les autres routes : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const { text, ...cles } = corps.data;
    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) return refuser(reply, REFUS_FICHE[fiche.code].statut, fiche.code, REFUS_FICHE[fiche.code].message);

    // L'ordre du § 4 : la fiche existe, porte un numéro, n'est pas bloquée. Le reste est dans `envoyerRcsLibre`.
    const etat = await deps.etatPourEnvoi(tenantId, fiche.contactId);
    if (!etat) return refuser(reply, 404, 'unknown_contact', REFUS_FICHE.unknown_contact.message);
    const waId = waIdOf(etat.phoneE164, null);
    if (!waId) return refuser(reply, 422, 'no_phone', REFUS_RCS.no_phone.message);
    if (etat.bloque) return refuser(reply, 409, 'blocked_contact', 'ce contact est bloqué');

    const issue = await envoyerRcsLibre(deps.rcs, tenantId, waId, { text }, 'api');
    if ('refus' in issue) return refuser(reply, REFUS_RCS[issue.refus].statut, issue.refus, REFUS_RCS[issue.refus].message);

    /**
     * APRÈS l'envoi réussi, et dans CET ordre : le fil est OUVERT (créé s'il n'existe pas), puis PRIS, puis le
     * message y est INSCRIT (cf. le docblock : pris avant d'être ouvert, un fil neuf ne serait pas pris).
     * Best-effort : le message est parti, un 5xx ferait réessayer l'intégrateur, donc envoyer deux fois.
     * Origine `api` (0166), auteur `null` : personne ne signe ce message.
     * ⚠️ Un rapport d'échec smsmode peut arriver avant l'inscription : `traiterRapportRcs` l'écrit quand même
     * (`noterSansMessage`), rien à faire ici.
     */
    const conversationId = await deps.ouvrirConversation(tenantId, fiche.contactId).catch(() => null);
    if (conversationId) {
      await deps.takeControl(tenantId, waId).catch(() => {});
      await deps.recordOutbound(conversationId, issue.apercu, issue.messageId, 'api', 'rcs', null, null, null, 'rcs').catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`v1/messages/rcs: RCS parti mais non inscrit dans l'Inbox (${tenantId}):`, err instanceof Error ? err.message : err);
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(`v1/messages/rcs: RCS parti, fil introuvable pour ${fiche.contactId} (${tenantId}), bloqué ou supprimé entre-temps`);
    }
    return reply.code(200).send({ messageId: issue.messageId, conversationId, channel: 'rcs' });
  });
}
```

- [ ] **Step 5: La lecture de fiche dans `src/crm/contact-store.pg.ts`**

Ajouter après `aConsentiOuEcritParWaId` :

```ts
  /**
   * Ce qu'un envoi simple doit savoir d'une fiche : son numéro, et si elle est bloquée. `null` = introuvable
   * dans cet espace, ou supprimée. Sert `POST /v1/messages/rcs` (lot 3 de l'API publique).
   */
  async etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null> {
    const res = await this.pool.query<{ phone_e164: string | null; bloque: boolean }>(
      `select phone_e164, (blocked_at is not null) as bloque
         from contacts
        where tenant_id = $1 and id = $2::uuid and deleted_at is null`,
      [tenantId, contactId],
    );
    const r = res.rows[0];
    return r ? { phoneE164: r.phone_e164, bloque: r.bloque } : null;
  }
```

- [ ] **Step 6: Le montage dans `src/server.ts`**

Après `import type { V1MessagesRouteDeps } from './http/v1-messages';` :

```ts
import { registerV1MessagesRcs } from './http/v1-messages-rcs';
import type { V1MessagesRcsRouteDeps } from './http/v1-messages-rcs';
```

Dans `ServerDeps.v1`, après la ligne `messages?: ...` :

```ts
    /** Un simple texte en RCS à une fiche (`POST /v1/messages/rcs`, lot 3 de l'API publique). */
    messagesRcs?: Omit<V1MessagesRcsRouteDeps, 'usage'>;
```

Dans l'entrée `v1` de `modulesDeRoutes`, après la ligne `if (v1.messages) registerV1Messages(...)` :

```ts
      // MÊME droit, même limiteur et même garde que le message WhatsApp : c'est le même geste sur un autre canal.
      if (v1.messagesRcs) registerV1MessagesRcs(app, { ...v1.messagesRcs, usage: usageApi }, [requireApiKey, requireScope('sends:create')]);
```

- [ ] **Step 7: Le câblage dans `src/index.ts`**

`resoudreFiche` y est déjà importé, et `contactStore` déclaré : le lot 2 s'en sert (Task 0, le `grep -c` rend `2`). Dans l'objet `v1`, après le bloc `messages: { ... },` :

```ts
      /**
       * `POST /v1/messages/rcs` (lot 3). Ce bloc ne fait que brancher : les gardes du RCS vivent dans
       * `envoyerRcsLibre`, la MÊME fonction que le bouton RCS de l'Inbox (`depsRcsLibre`).
       */
      messagesRcs: {
        // La MÊME fermeture que les blocs `sends` et `messages` : le MÊME dépôt que `/v1/contacts`, sinon une
        // personne serait trouvée par une route et pas par l'autre. Ses quatre paramètres passent.
        resoudreFiche: (tenant, cles, o) => resoudreFiche(contactStore, tenant, cles, o),
        etatPourEnvoi: (tenant, id) => contactStore.etatPourEnvoi(tenant, id),
        rcs: depsRcsLibre,
        ouvrirConversation: (tenant, contactId) => inboxStore.ouvrirConversationDuContact(tenant, contactId),
        // `app_human`, comme les autres machines : le scénario cesse d'avancer seul. QUI a parlé est porté par
        // l'origine du message (`api`).
        takeControl: async (tenant, waId) => { await inboxStore.setControlOwner(tenant, waId, 'app_human'); },
        recordOutbound: (id, body, msgId, origine, type, cat, name, sender, canal, redaction) =>
          inboxStore.recordOutbound(id, body, msgId, origine, type, cat, name, sender, canal, redaction),
      },
```

Contrôle : `grep -c "resoudreFiche(contactStore, tenant, cles, o)" src/index.ts` rend maintenant `3`.

`src/api/usage-guard.ts`, remplacer les deux lignes de commentaire au-dessus de `| 'messages.send'` (la première nomme `POST /v1/messages/whatsapp` depuis le lot 2) par :

```ts
  // Un texte libre à une personne : `POST /v1/messages/whatsapp` (fenêtre de 24 h) et `POST /v1/messages/rcs`.
  // UNE unité par appel : un message, une personne. Le travail ne dépend pas du corps envoyé.
```

- [ ] **Step 8: Le voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/v1-messages-rcs.test.ts tests/scope-tenant.test.ts && npm run typecheck && npm test && npx tsx scripts/auto-attaque.mts`
Expected: PASS ; `auto-attaque` inventorie la nouvelle route et ne relève aucun défaut (sans clé : 401).

- [ ] **Step 9: Vérifier l'ordre des refus dans les deux sens**

1. Dans la route, intervertir temporairement les lignes du `no_phone` et du `blocked_contact` (le test du bloqué passe avant). Relancer `npx vitest run tests/v1-messages-rcs.test.ts` : FAIL sur « l’ordre du § 4 » (`expected [ 409, 'blocked_contact' ] to deeply equal [ 422, 'no_phone' ]`). Restaurer, relancer : PASS.
2. Remettre l'ordre fautif du fil : déplacer temporairement `await deps.takeControl(tenantId, waId).catch(() => {});` AVANT `const conversationId = await deps.ouvrirConversation(...)`. Relancer : FAIL sur « écrire PREND le fil » avec le symptôme exact du défaut (`expected [] to deeply equal [ '33612345678' ]` : la prise n'a rien touché, le fil n'existait pas encore). Restaurer, relancer : PASS, et `git diff -- src/http/v1-messages-rcs.ts` montre l'ordre ouvrir, prendre, inscrire.

- [ ] **Step 10: Commit**

`src/server.ts` et `src/index.ts` sont des fichiers de câblage PARTAGÉS : si `git diff` montre sur l'un d'eux une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/http/v1-messages-rcs.ts src/server.ts src/crm/contact-store.pg.ts src/index.ts src/api/usage-guard.ts tests/v1-messages-rcs.test.ts tests/integration/rcs-libre.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N src/http/v1-messages-rcs.ts tests/v1-messages-rcs.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(api): POST /v1/messages/rcs, sur le chemin partagé avec le bouton RCS de l'Inbox

La route résout la fiche (creer: jamais), exige un numéro, refuse un contact bloqué, puis passe par
envoyerRcsLibre ; après l'envoi, le fil est ouvert, PUIS pris, puis le message y est inscrit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

---

### Task 10: La cible `rcsMessage` et les variables dans `/v1/sends`

**Files:**
- Create: `src/api/variables.ts`
- Create: `src/api/cible-rcs.ts`
- Modify: `src/rcs/message-store.pg.ts` (méthode `getByName` après `getById`, lignes 48 à 54)
- Modify: `src/campaign/store.pg.ts` (la version du LOT 2 : interface `EnvoiApiBrut` et méthode `lireEnvoiApi`, pour y ajouter `name`)
- Modify: `src/api/sends-build.ts` (la version du LOT 2 : `DestinataireResolu`, `trierDestinataires`, `construireDestinataires`)
- Modify: `src/http/v1-sends.ts` (la version du LOT 2 : imports, `V1SendCreateInput`, `V1SendsRouteDeps`, `schemaCible`, `schemaDestinataire`, `PRECISIONS`, `CibleDemandee`, `CibleResolue`, `lireCible`, `resoudreCible`, `resoudreDestinataires`, corps de `POST /v1/sends`)
- Modify: `src/api/suivi-envoi.ts` (la version du LOT 2 : le commentaire de `CibleSuivi` et la ligne de `cibleDe` qui rend `{ rcsMessage: null }`)
- Modify: `src/index.ts` (bloc `v1.sends` du lot 2) : FICHIER DE CÂBLAGE PARTAGÉ
- Test: `tests/api-cible-rcs.test.ts` (neuf)
- Test: `tests/api-suivi-envoi-rcs.test.ts` (neuf)
- Test: `tests/api-tri-destinataires.test.ts` (du lot 2 : un `describe` ajouté)
- Test: `tests/v1-sends.test.ts` (du lot 2 : un import, la dépendance `rcs` par défaut de `app()`, la fixture `BRUT`, un `describe` ajouté)
- Test: `tests/api-suivi-envoi.test.ts` (du lot 2 : la fixture `TEMPLATE`)
- Test: `tests/api-usage-observation.test.ts` (du lot 2 : le double `sendsMuets`)
- Test: `tests/integration/rcs-libre.integration.test.ts` (imports et deux cas)

Les ancrages de `src/http/v1-sends.ts`, `src/api/sends-build.ts`, `src/api/suivi-envoi.ts` et `src/campaign/store.pg.ts` sont le texte EXACT du plan du lot 2 (`docs/superpowers/plans/2026-09-24-api-v1-lot2-envois.md`, Tasks 5 à 8), dont la Task 0 a vérifié la présence sur `main`.

**Interfaces:**
- Consumes : `validateParamMapping(..., { accepterVariables: true })`, `CLE_VARIABLE` (Task 2) ; `BuildContact.variables`, `BuiltRecipient.variables` (Task 3) ; `buildRecipients(category, paramMapping, contacts, opts, channel)` (son cinquième paramètre existe déjà, `src/campaign/build.ts:51`) ; du lot 2, `EnvoiApiBrut` (avec `channel`), `lireEnvoiApi`, `ContactEnvoi { bloque; rcsDesabonne }`, `DestinataireResolu`, `trierDestinataires`, `construireDestinataires`, `formaterSuiviEnvoi` et `CibleSuivi` (qui jugent déjà le canal avant le template et portent `{ rcsMessage: string | null }`), et dans la route `schemaCible`, `schemaDestinataire`, `lireCible`, `numeroDEnvoi`, `resoudreCible`, `resoudreDestinataires`, `libererEtRefuser` ; `CodeApi`, `refuser` (lot 1) ; `RcsOutbound`.
- Produces :
  - `src/api/variables.ts` : `VALEUR_VARIABLE_MAX = 1024`, `VARIABLES_MAX = 50`, `schemaVariables` (zod), `type VariablesDestinataire`, `type TypeDeCible = 'template' | 'scenario' | 'node' | 'rcsMessage'`, `destinataireAvecVariablesInterdites(cible: TypeDeCible, destinataires: readonly unknown[]): number | null`.
  - `src/api/cible-rcs.ts` : `NOM_MESSAGE_RCS_MAX = 120`, `schemaCibleRcs` (zod `{ rcsMessage }`), `PREFIXE_ENVOI_API = '[API] '`, `interface DepsCibleRcs { messageRcsParNom(tenantId: string, nom: string): Promise<{ name: string; content: RcsOutbound | null } | null>; agentIdForTenant(tenantId: string): Promise<string | null> }`, `type CibleRcs`, `resoudreCibleRcs(deps: DepsCibleRcs, tenantId: string, nom: string): Promise<CibleRcs>`, `nomDuMessageRcs(nomDeCampagne: string): string | null`.
  - `PgRcsMessageStore.getByName(tenantId: string, name: string): Promise<RcsMessage | null>`.
  - `EnvoiApiBrut` gagne `name: string` (lu par `lireEnvoiApi`) ; `CibleSuivi` ne change pas (le lot 2 y a déjà mis `{ rcsMessage: string | null }`) ; `cibleDe` rend `{ rcsMessage: nomDuMessageRcs(b.name) }` au lieu de `{ rcsMessage: null }`.
  - Le membre résolu de `DestinataireResolu` gagne `variables?: Readonly<Record<string, string>>` ; `construireDestinataires(category, params, tri, now, canal: 'whatsapp' | 'rcs' = 'whatsapp')`.
  - `V1SendsRouteDeps.rcs: DepsCibleRcs` (REQUIS) ; `V1SendCreateInput` gagne `channel?: 'rcs'; rcsAgentId?: string; rcsMessage?: RcsOutbound`.
- ⚠️ Aucun écart propre à l'ouverture `rcs` n'est écrit ici : le lot 2 écarte DÉJÀ le STOP RCS (`opted_out`) et la fiche sans numéro (`no_phone`) de toute ouverture `rcs`, dans `trierDestinataires` (`motifDEcart`, à partir de `ContactEnvoi.rcsDesabonne` lu par `listContactsPourEnvoiApi`). La cible `rcsMessage` pose `ouverture = 'rcs'` et en hérite.

- [ ] **Step 1: Annoncer l'édition de `src/index.ts`, et relire les ancrages du lot 2**

`SendMessage` à chaque session : « Lot 3 API : j'édite src/index.ts (bloc v1.sends, la cible rcsMessage), commit dans ~30 min. »

```bash
cd /c/Users/julie/messagingme-mba && sed -n '/^const schemaCible = z.union/,/^]);/p;/^const schemaDestinataire = z.object/,/^});/p;/^type CibleDemandee/,/^$/p;/^interface CibleResolue/,/^}/p;/^function lireCible/,/^}/p' src/http/v1-sends.ts
grep -n "^export interface EnvoiApiBrut" -A6 src/campaign/store.pg.ts
grep -n "select c.id, c.status, c.created_at, c.channel, c.template_name" src/campaign/store.pg.ts
grep -n "if (b.channel === 'rcs') return { rcsMessage: null };\|Sa cible est \`{ rcsMessage: null }\`" src/api/suivi-envoi.ts
```

Expected: le texte que les steps 6 à 9 remplacent, identique à celui du plan du lot 2. Un écart : ARRÊTER et le signaler (la Task 0 l'aurait dû voir).

- [ ] **Step 2: Écrire les tests qui échouent**

`tests/api-cible-rcs.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { resoudreCibleRcs, nomDuMessageRcs, PREFIXE_ENVOI_API, type DepsCibleRcs } from '../src/api/cible-rcs';
import { schemaVariables, destinataireAvecVariablesInterdites, VARIABLES_MAX } from '../src/api/variables';

/**
 * LA CIBLE `rcsMessage` DE `/v1/sends` ET LES VARIABLES PAR DESTINATAIRE (spec 2026-09-24, § 3, lot 3).
 */
const RELANCE = { kind: 'text' as const, text: 'Votre commande {{commande}} est prête' };

function deps(over: Partial<DepsCibleRcs> = {}) {
  const lectures: string[] = [];
  const d: DepsCibleRcs = {
    messageRcsParNom: async (_t, nom) => {
      lectures.push(`message:${nom}`);
      if (nom === 'relance-panier') return { name: 'relance-panier', content: RELANCE };
      if (nom === 'illisible') return { name: 'illisible', content: null };
      return null;
    },
    agentIdForTenant: async () => { lectures.push('agent'); return 'agent-1'; },
    ...over,
  };
  return { d, lectures };
}

describe('resoudreCibleRcs', () => {
  it('le message par son nom, et l’agent RCS de l’espace', async () => {
    expect(await resoudreCibleRcs(deps().d, 't1', 'relance-panier')).toEqual({ ok: true, nom: 'relance-panier', agentId: 'agent-1', contenu: RELANCE });
  });

  it('message inconnu : 404 rcs_message_not_found, et l’agent n’est pas lu', async () => {
    const { d, lectures } = deps();
    expect(await resoudreCibleRcs(d, 't1', 'inconnu')).toMatchObject({ ok: false, statut: 404, code: 'rcs_message_not_found' });
    expect(lectures).toEqual(['message:inconnu']);
  });

  it('contenu illisible : 422 unsendable_target ; canal éteint : 409 rcs_not_enabled', async () => {
    expect(await resoudreCibleRcs(deps().d, 't1', 'illisible')).toMatchObject({ ok: false, statut: 422, code: 'unsendable_target' });
    expect(await resoudreCibleRcs(deps({ agentIdForTenant: async () => null }).d, 't1', 'relance-panier'))
      .toMatchObject({ ok: false, statut: 409, code: 'rcs_not_enabled' });
  });
});

describe('nomDuMessageRcs', () => {
  it('un envoi RCS de l’API : le nom du message, derrière le préfixe', () => {
    expect(nomDuMessageRcs('[API] relance-panier')).toBe('relance-panier');
  });

  it('🔴 un nom de 120 caractères (la borne de la bibliothèque) revient ENTIER', () => {
    const nom = 'x'.repeat(120);
    expect(nomDuMessageRcs(`${PREFIXE_ENVOI_API}${nom}`)).toBe(nom);
  });

  it('🔴 une campagne RCS créée dans la console (sans préfixe) ne désigne AUCUN message : null, jamais son nom', () => {
    // Elle ne garde que le CONTENU du message : son nom de campagne n'est pas un nom de la bibliothèque.
    expect(nomDuMessageRcs('Soldes d’automne')).toBeNull();
    // Le préfixe seul, sans nom derrière, non plus.
    expect(nomDuMessageRcs(PREFIXE_ENVOI_API)).toBeNull();
  });
});

describe('les variables d’un destinataire', () => {
  it('accepte des textes nommés comme les {{variables}} d’un message RCS', () => {
    expect(schemaVariables.safeParse({ commande: '8412', 'date.rdv': '2026-10-01' }).success).toBe(true);
  });

  it('refuse un nom mal formé, un nom réservé, une valeur trop longue ou non texte, trop de variables', () => {
    expect(schemaVariables.safeParse({ 'a b': 'x' }).success).toBe(false);
    expect(schemaVariables.safeParse(JSON.parse('{"__proto__": "x"}')).success).toBe(false);
    expect(schemaVariables.safeParse({ commande: 'x'.repeat(1025) }).success).toBe(false);
    expect(schemaVariables.safeParse({ commande: 8412 }).success).toBe(false);
    expect(schemaVariables.safeParse(Object.fromEntries(Array.from({ length: VARIABLES_MAX + 1 }, (_v, i) => [`v${i}`, 'x']))).success).toBe(false);
  });

  it('🔴 un scénario ou un bloc n’a nulle part où les ranger : l’index du premier destinataire REÇU qui en porte', () => {
    expect(destinataireAvecVariablesInterdites('scenario', [{}, { variables: { a: 'b' } }])).toBe(1);
    // Les destinataires tels que reçus : `null` ou une chaîne nue ne portent rien, ils ne font pas lever.
    expect(destinataireAvecVariablesInterdites('node', [null, '+33612345678', { variables: {} }])).toBe(2);
    expect(destinataireAvecVariablesInterdites('scenario', [{ contactId: 'c1' }])).toBeNull();
    expect(destinataireAvecVariablesInterdites('template', [{ variables: { a: 'b' } }])).toBeNull();
    expect(destinataireAvecVariablesInterdites('rcsMessage', [{ variables: { a: 'b' } }])).toBeNull();
  });
});
```

`tests/api-suivi-envoi-rcs.test.ts` :

```ts
import { describe, it, expect } from 'vitest';
import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';
import type { EnvoiApiBrut } from '../src/campaign/store.pg';

/**
 * `GET /v1/sends/{sendId}` d'un envoi de message RCS (lot 3).
 *
 * Le lot 2 reconnaît déjà une campagne RCS par son CANAL (elle porte `templateName: ''`, pas null) et rend
 * `{ rcsMessage: null }`. 🔴 Pour un envoi de l'API, le suivi NOMME désormais le message, relu derrière le
 * préfixe du nom de la campagne ; une campagne de la console reste à `null`.
 */
const RCS: EnvoiApiBrut = {
  id: '33333333-3333-4333-8333-333333333333',
  status: 'running',
  createdAt: '2026-09-24T10:00:00.000Z',
  name: '[API] relance-panier',
  channel: 'rcs',
  templateName: '',
  templateLanguage: '',
  workflowCode: null,
  startNodeId: null,
  graph: null,
  counts: { pending: 0, sending: 0, sent: 1, failed: 0, skipped: 0 },
  recipients: [
    { contactId: 'c1', externalId: 'crm-7781', status: 'sent', messageId: 'sms-1', error: null, errorCode: null, sentAt: '2026-09-24T10:00:01.000Z', deliveryStatus: 'delivered', deliveryError: null },
  ],
};

describe('GET /v1/sends/{sendId} : un envoi de message RCS', () => {
  it('🔴 la cible est le message RCS, l’ouverture et le canal sont RCS', () => {
    const s = formaterSuiviEnvoi(RCS);
    expect(s.target).toEqual({ rcsMessage: 'relance-panier' });
    expect(s.opening).toBe('rcs');
    expect(s.recipients.map((r) => r.channel)).toEqual(['rcs']);
  });

  it('une campagne RCS de la console (nom sans le préfixe de l’API) : `rcsMessage: null`, comme au lot 2', () => {
    expect(formaterSuiviEnvoi({ ...RCS, name: 'Soldes d’automne' }).target).toEqual({ rcsMessage: null });
  });

  it('le contrat garde sa forme : ni le nom ni le canal de la campagne ne fuient', () => {
    expect(Object.keys(formaterSuiviEnvoi(RCS)).sort()).toEqual(['counts', 'createdAt', 'opening', 'recipients', 'sendId', 'status', 'target']);
  });
});
```

`tests/api-tri-destinataires.test.ts` (fichier du lot 2) : ajouter à la fin du fichier :

```ts
describe('les variables d’un destinataire (lot 3 de l’API publique)', () => {
  it('🔴 elles voyagent du tri à la construction, et résolvent la source « variable »', () => {
    const tri = trierDestinataires({
      category: 'utility', ouverture: 'whatsapp_template',
      resolus: [{ index: 0, contactId: 'a', variables: { commande: '8412' } }, vers(1, 'b')],
      contacts: [ct({ id: 'a' }), ct({ id: 'b', phone_e164: '+33600000002' })],
    });
    const params: TemplateParam[] = [{ position: 1, source: { type: 'variable', key: 'commande' } }];
    const { recipients, ecarts } = construireDestinataires('utility', params, tri, new Date());
    expect(recipients).toEqual([{ contactId: 'a', toE164: '+33600000001', resolvedParams: ['8412'], variables: { commande: '8412' } }]);
    expect(ecarts).toEqual([{ index: 1, reason: 'missing_variable' }]);
  });

  it('le canal atteint la construction : sur une campagne RCS, une fiche sans numéro est écartée no_phone', () => {
    // Le tri l'écarte déjà sur une ouverture rcs ; ici, un tri WhatsApp isole la construction.
    const tri = trierDestinataires({ category: 'utility', ouverture: 'whatsapp_template', resolus: [vers(0, 'b')], contacts: [ct({ id: 'b', phone_e164: null, bsuid: 'BS-b' })] });
    expect(construireDestinataires('utility', [], tri, new Date(), 'rcs').ecarts).toEqual([{ index: 0, reason: 'no_phone' }]);
    // Ancre positive : sans le canal, la même fiche part sur son BSUID, comme au lot 2.
    expect(construireDestinataires('utility', [], tri, new Date()).recipients.map((r) => r.toE164)).toEqual(['BS-b']);
  });
});
```

`tests/v1-sends.test.ts` (fichier du lot 2), quatre ajouts :

a) Après `import { formaterSuiviEnvoi } from '../src/api/suivi-envoi';` :

```ts
import { nomDuMessageRcs, PREFIXE_ENVOI_API } from '../src/api/cible-rcs';
```

b) Dans la fabrique `app()`, remplacer :

```ts
    lireEnvoi: async () => null,
    sleep: async () => {}, // pas de temporisation réelle dans les tests de retry
```

par :

```ts
    lireEnvoi: async () => null,
    // La cible `rcsMessage` (lot 3) : un seul message dans la bibliothèque, un agent RCS actif.
    rcs: {
      messageRcsParNom: async (_t, nom) => (nom === 'relance-panier'
        ? { name: 'relance-panier', content: { kind: 'text', text: 'Votre commande {{commande}} est prête' } }
        : null),
      agentIdForTenant: async () => 'agent-1',
    },
    sleep: async () => {}, // pas de temporisation réelle dans les tests de retry
```

c) Dans la fixture `BRUT` du `describe('GET /v1/sends/{sendId}')`, après la ligne `    id: ID, status: 'running', createdAt: '2026-09-24T10:00:00.000Z', channel: 'whatsapp', templateName: 'confirmation', templateLanguage: 'fr',`, ajouter la ligne :

```ts
    name: '[API] confirmation',
```

d) À la fin du fichier (`app`, `envoyer`, `fiche`, `PHONE`, `TPL`, `SCN` et `NODE` sont ceux du lot 2 ; la clé d'idempotence voyage en en-tête, troisième argument d'`envoyer`) :

```ts
describe('POST /v1/sends : la cible rcsMessage et les variables par destinataire (lot 3)', () => {
  const RCS = (nom = 'relance-panier') => ({ target: { rcsMessage: nom }, category: 'utility' as const });

  it('🔴 201 : ouverture rcs, campagne RCS SANS numéro WhatsApp (l’espace n’en a même aucun), variables gardées', async () => {
    const { server, cap } = app({ getTenantPhoneNumberId: async () => null });
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: 'c1', variables: { commande: '8412' } }] }, 'i-rcs-1');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ opening: 'rcs', recipientCount: 1, skipped: [] });
    expect(cap.sends[0]!.input).toMatchObject({
      channel: 'rcs', rcsAgentId: 'agent-1', phoneNumberId: '', name: '[API] relance-panier', category: 'utility',
      templateName: '', templateLanguage: '', paramMapping: [],
      rcsMessage: { kind: 'text', text: 'Votre commande {{commande}} est prête' },
    });
    expect(cap.sends[0]!.recipients).toEqual([{ contactId: 'c1', toE164: PHONE(1), resolvedParams: [], variables: { commande: '8412' } }]);
    await server.close();
  });

  it('un phoneNumberId fourni est IGNORÉ sur une cible rcsMessage (§ 3 : il reste optionnel, et un RCS part de l’agent)', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, { ...RCS(), phoneNumberId: 'pn-autrui', recipients: [{ contactId: 'c1' }] }, 'i-rcs-pn');
    expect(res.statusCode).toBe(201);
    expect(cap.sends[0]!.input.phoneNumberId).toBe('');
    await server.close();
  });

  it('message inconnu : 404 ; contenu illisible : 422 ; canal éteint : 409 ; ni campagne, ni fiche résolue', async () => {
    const { server, cap } = app({
      rcs: {
        messageRcsParNom: async (_t, nom) => (nom === 'illisible' ? { name: 'illisible', content: null } : null),
        agentIdForTenant: async () => 'agent-1',
      },
    });
    const r1 = await envoyer(server, { ...RCS('inconnu'), recipients: [{ contactId: 'c1' }] }, 'i-rcs-404');
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([404, 'rcs_message_not_found']);
    const r2 = await envoyer(server, { ...RCS('illisible'), recipients: [{ contactId: 'c1' }] }, 'i-rcs-422');
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([422, 'unsendable_target']);
    expect(cap.sends).toEqual([]);
    expect(cap.resolutions).toEqual([]);
    await server.close();
    const eteint = app({ rcs: { messageRcsParNom: async () => ({ name: 'x', content: { kind: 'text', text: 'x' } }), agentIdForTenant: async () => null } });
    const r3 = await envoyer(eteint.server, { ...RCS('x'), recipients: [{ contactId: 'c1' }] }, 'i-rcs-409');
    expect([r3.statusCode, r3.json<{ code: string }>().code]).toEqual([409, 'rcs_not_enabled']);
    expect(eteint.cap.sends).toEqual([]);
    await eteint.server.close();
  });

  it('sans category : 400 ; params non vides : 400 ; une liste params VIDE vaut son absence', async () => {
    const { server, cap } = app();
    const sansCat = await envoyer(server, { target: { rcsMessage: 'relance-panier' }, recipients: [{ contactId: 'c1' }] }, 'i-rcs-cat');
    expect([sansCat.statusCode, sansCat.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    const params = [{ position: 1, source: { type: 'literal', value: 'x' } }];
    expect((await envoyer(server, { ...RCS(), params, recipients: [{ contactId: 'c1' }] }, 'i-rcs-params')).statusCode).toBe(400);
    expect((await envoyer(server, { ...RCS(), params: [], recipients: [{ contactId: 'c1' }] }, 'i-rcs-params-vides')).statusCode).toBe(201);
    expect(cap.sends).toHaveLength(1);
    await server.close();
  });

  it('🔴 un nom plus long que la bibliothèque n’en accepte : 400 invalid_body, rien n’est cherché', async () => {
    const { server, cap } = app();
    expect((await envoyer(server, { ...RCS('x'.repeat(121)), recipients: [{ contactId: 'c1' }] }, 'i-rcs-121')).statusCode).toBe(400);
    expect(cap.sends).toEqual([]);
    await server.close();
  });

  it('🔴 un nom de 120 caractères n’est PAS coupé : le suivi relit le message entier', async () => {
    const nom = 'x'.repeat(120);
    const { server, cap } = app({ rcs: { messageRcsParNom: async (_t, n) => ({ name: n, content: { kind: 'text', text: 'Bonjour' } }), agentIdForTenant: async () => 'agent-1' } });
    await envoyer(server, { ...RCS(nom), recipients: [{ contactId: 'c1' }] }, 'i-rcs-120');
    expect(cap.sends[0]!.input.name).toBe(`${PREFIXE_ENVOI_API}${nom}`);
    expect(nomDuMessageRcs(cap.sends[0]!.input.name)).toBe(nom);
    await server.close();
  });

  it('🔴 variables sur un scénario ou un bloc : 400 invalid_body, AVANT toute résolution de fiche', async () => {
    const { server, cap } = app();
    const r1 = await envoyer(server, { ...SCN('scn_template'), recipients: [{ contactId: 'c1' }, { contactId: 'c2', variables: { a: 'b' } }] }, 'i-var-scn');
    expect([r1.statusCode, r1.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    expect(r1.json<{ error: string }>().error).toContain('recipients.1.variables');
    const r2 = await envoyer(server, { ...NODE('nod_qm'), recipients: [{ contactId: 'c1', variables: { a: 'b' } }] }, 'i-var-node');
    expect([r2.statusCode, r2.json<{ code: string }>().code]).toEqual([400, 'invalid_body']);
    expect(cap.resolutions).toEqual([]);
    expect(cap.sends).toEqual([]);
    await server.close();
  });

  it('un nom de variable invalide ÉCARTE ce destinataire (invalid_recipient), sans faire tomber l’envoi', async () => {
    const { server } = app();
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: 'c1', variables: { 'a b': 'x' } }, { contactId: 'c2' }] }, 'i-var-nom');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ recipientCount: 1, skipped: [{ index: 0, reason: 'invalid_recipient' }] });
    await server.close();
  });

  it('🔴 STOP RCS : opted_out ; fiche sans numéro : no_phone (le tri du lot 2, sur l’ouverture rcs)', async () => {
    const fiches = new Map<string, ContactEnvoi>([
      ['c3', fiche('c3', 3, { rcsDesabonne: true })],
      ['c4', fiche('c4', 4, { phone_e164: null, bsuid: 'BS4' })],
    ]);
    const { server } = app({}, { fiches });
    const res = await envoyer(server, { ...RCS(), recipients: [{ contactId: 'c3' }, { contactId: 'c4' }] }, 'i-rcs-ecarts');
    expect(res.json()).toMatchObject({ recipientCount: 0, skipped: [{ index: 0, reason: 'opted_out' }, { index: 1, reason: 'no_phone' }] });
    await server.close();
  });

  it('template : la source « variable » lit la variable du destinataire, sinon missing_variable à son index', async () => {
    const { server, cap } = app();
    const res = await envoyer(server, {
      ...TPL, params: [{ position: 1, source: { type: 'variable', key: 'commande' } }],
      recipients: [{ contactId: 'c1', variables: { commande: '8412' } }, { contactId: 'c2' }],
    }, 'i-tpl-var');
    expect(res.statusCode).toBe(201);
    expect(cap.sends[0]!.recipients.map((r) => r.resolvedParams)).toEqual([['8412']]);
    expect(res.json()).toMatchObject({ skipped: [{ index: 1, reason: 'missing_variable' }] });
    await server.close();
  });
});
```

`tests/api-suivi-envoi.test.ts` (fichier du lot 2) : dans la fixture `TEMPLATE`, remplacer :

```ts
  createdAt: '2026-09-24T10:00:00.000Z',
  channel: 'whatsapp',
  templateName: 'confirmation',
```

par :

```ts
  createdAt: '2026-09-24T10:00:00.000Z',
  channel: 'whatsapp',
  // 🔴 SANS le préfixe de l'API, délibérément : le cas « une campagne RCS de la console » ÉTALE cette fixture
  // en changeant son canal, et attend `{ rcsMessage: null }`. Un nom préfixé en ferait un envoi RCS de l'API.
  name: 'Confirmation de commande',
  templateName: 'confirmation',
```

`tests/api-usage-observation.test.ts` (double du lot 2) : remplacer :

```ts
  lireEnvoi: async () => null,
};
```

par :

```ts
  lireEnvoi: async () => null,
  rcs: { messageRcsParNom: async () => null, agentIdForTenant: async () => null },
};
```

`tests/integration/rcs-libre.integration.test.ts` : ajouter en tête les imports

```ts
import { PgRcsMessageStore } from '../../src/rcs/message-store.pg';
import { PgCampaignRepo } from '../../src/campaign/store.pg';
import { formaterSuiviEnvoi } from '../../src/api/suivi-envoi';
import { PREFIXE_ENVOI_API } from '../../src/api/cible-rcs';
```

et, dans le même `describe`, deux cas :

```ts
  it('getByName : le message par son nom exact, jamais un message supprimé ni celui d’un autre espace', async () => {
    const messages = new PgRcsMessageStore(pool);
    const cree = await messages.create(tenantId, 'relance-panier', { kind: 'text', text: 'Bonjour' });
    expect((await messages.getByName(tenantId, 'relance-panier'))?.id).toBe(cree.id);
    expect(await messages.getByName(tenantId, 'Relance-panier')).toBeNull();
    expect(await messages.getByName('00000000-0000-0000-0000-000000000000', 'relance-panier')).toBeNull();
    await messages.remove(tenantId, cree.id);
    expect(await messages.getByName(tenantId, 'relance-panier')).toBeNull();
  });

  it('🔴 lireEnvoiApi rend le NOM entier et le CANAL d’un envoi RCS, et le suivi en fait une cible rcsMessage', async () => {
    const repo = new PgCampaignRepo(pool);
    const nom = 'x'.repeat(120);
    const { campaignId } = await repo.createWithRecipients(
      {
        tenantId, phoneNumberId: '', name: `${PREFIXE_ENVOI_API}${nom}`, category: 'utility',
        templateName: '', templateLanguage: '', paramMapping: [],
        channel: 'rcs', rcsAgentId: 'itest-agent', rcsMessage: { kind: 'text', text: 'Bonjour' },
      },
      [],
    );
    const lu = await repo.lireEnvoiApi(campaignId, tenantId);
    // `templateName` vaut '' et non null : c'est ce qui rend l'ordre de `cibleDe` obligatoire.
    expect(lu).toMatchObject({ name: `${PREFIXE_ENVOI_API}${nom}`, channel: 'rcs', templateName: '', workflowCode: null });
    expect(formaterSuiviEnvoi(lu!)).toMatchObject({ target: { rcsMessage: nom }, opening: 'rcs' });
  });
```

- [ ] **Step 3: Les voir échouer**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/api-cible-rcs.test.ts tests/api-suivi-envoi-rcs.test.ts tests/api-tri-destinataires.test.ts tests/v1-sends.test.ts`
Expected: FAIL. `tests/api-cible-rcs.test.ts` et `tests/v1-sends.test.ts` échouent à l'import (`../src/api/cible-rcs` introuvable) ; `tests/api-suivi-envoi-rcs.test.ts` rend `{ rcsMessage: null }` au lieu de `{ rcsMessage: 'relance-panier' }` (le cas de la console, lui, passe déjà : c'est l'ancre du comportement du lot 2) ; dans `tests/api-tri-destinataires.test.ts`, le destinataire à variables est écarté `missing_variable` à l'index 0 et la fiche sans numéro part sur son BSUID. `npm run typecheck` échoue aussi (`name` inconnu d'`EnvoiApiBrut`, `rcs` inconnu de `V1SendsRouteDeps`).

- [ ] **Step 4: Écrire `src/api/variables.ts`**

```ts
import { z } from 'zod';
import { CLE_VARIABLE } from '../crm/template';

/**
 * LES VARIABLES D'UN DESTINATAIRE DE `/v1/sends` (spec 2026-09-24, § 3, lot 3) : `{ clé: texte }`, propres à
 * CE destinataire, jamais écrites sur sa fiche.
 *
 * Les bornes : 50 variables de 1 024 caractères au plus. Un paramètre de template WhatsApp et un texte RCS
 * tiennent dedans, et un corps de 50 destinataires reste loin du plafond de 1 Mo du serveur.
 */
export const VALEUR_VARIABLE_MAX = 1024;
export const VARIABLES_MAX = 50;

export const schemaVariables = z.record(
  z.string()
    .regex(CLE_VARIABLE, 'nom de variable : lettres, chiffres, « _ », « . » ou « - », 64 caractères au plus')
    .refine((cle) => cle !== '__proto__', 'nom de variable réservé'),
  z.string().max(VALEUR_VARIABLE_MAX, `valeur de variable : ${VALEUR_VARIABLE_MAX} caractères au plus`),
).refine((o) => Object.keys(o).length <= VARIABLES_MAX, `${VARIABLES_MAX} variables au plus par destinataire`);

export type VariablesDestinataire = z.infer<typeof schemaVariables>;

export type TypeDeCible = 'template' | 'scenario' | 'node' | 'rcsMessage';

/**
 * L'index du premier destinataire qui porte une clé `variables` alors que la cible n'en a pas l'usage, sinon
 * `null`. 🔴 Un scénario ou un bloc n'a aujourd'hui AUCUN endroit où les ranger : les accepter en silence ferait
 * croire à l'intégrateur qu'elles servent.
 *
 * ⚠️ ELLE LIT LES DESTINATAIRES TELS QUE REÇUS (`unknown`), et c'est voulu : le refus est un 400 sur tout
 * l'envoi, qui doit tomber AVANT le compteur d'usage et le claim d'idempotence, alors que la route du lot 2 ne
 * valide chaque destinataire qu'APRÈS (un destinataire mal formé y est écarté, pas refusé). Aucun `as` :
 * `Object.hasOwn` suffit à lire une clé sur un objet quelconque.
 */
export function destinataireAvecVariablesInterdites(cible: TypeDeCible, destinataires: readonly unknown[]): number | null {
  if (cible === 'template' || cible === 'rcsMessage') return null;
  const i = destinataires.findIndex((d) => typeof d === 'object' && d !== null && Object.hasOwn(d, 'variables'));
  return i === -1 ? null : i;
}
```

- [ ] **Step 5: Écrire `src/api/cible-rcs.ts`**

```ts
import { z } from 'zod';
import type { CodeApi } from './erreurs';
import type { RcsOutbound } from '../rcs/types';

/**
 * LA CIBLE `rcsMessage` DE `POST /v1/sends` (spec 2026-09-24, § 3, lot 3) : un message de Contenu > Messages
 * RCS, désigné par son NOM (unique par espace en base, index partiel `rcs_messages_tenant_name`, 0077).
 *
 * Elle donne l'ouverture `rcs` : aucun numéro WhatsApp n'est exigé (le message part de l'agent RCS de
 * l'espace), la catégorie est obligatoire (elle décide du consentement exigé), et `params` n'a pas de sens
 * (ses `{{variables}}` viennent de `recipients[].variables`). Ces règles de FORME vivent dans `lireCible`
 * (`src/http/v1-sends.ts`), avec celles des autres cibles ; ce module fait les LECTURES et le suivi.
 */

/**
 * La borne d'un nom dans la bibliothèque (`lireNom`, `src/http/rcs-messages.ts`, 120 caractères). Un nom plus
 * long ne désigne aucun message : refusé en forme plutôt que cherché.
 */
export const NOM_MESSAGE_RCS_MAX = 120;

/** Le noyau `{ rcsMessage }` de l'union des cibles de la route. */
export const schemaCibleRcs = z.strictObject({ rcsMessage: z.string().trim().min(1).max(NOM_MESSAGE_RCS_MAX) });

/**
 * Le préfixe du nom d'un envoi de l'API dans Campagnes. 🔴 UNE SEULE ÉCRITURE : la route de `/v1/sends` le
 * pose, `nomDuMessageRcs` le retire. Recopié en littéral à l'un des deux endroits, il divergerait en silence.
 */
export const PREFIXE_ENVOI_API = '[API] ';

export interface DepsCibleRcs {
  messageRcsParNom(tenantId: string, nom: string): Promise<{ name: string; content: RcsOutbound | null } | null>;
  agentIdForTenant(tenantId: string): Promise<string | null>;
}

export type CibleRcs =
  | { ok: true; nom: string; agentId: string; contenu: RcsOutbound }
  | { ok: false; statut: 404 | 409 | 422; code: Extract<CodeApi, 'rcs_message_not_found' | 'rcs_not_enabled' | 'unsendable_target'>; message: string };

/** Le message, PUIS l'agent : un message introuvable ne coûte pas la lecture de l'agent. */
export async function resoudreCibleRcs(deps: DepsCibleRcs, tenantId: string, nom: string): Promise<CibleRcs> {
  const m = await deps.messageRcsParNom(tenantId, nom);
  if (!m) return { ok: false, statut: 404, code: 'rcs_message_not_found', message: `aucun message RCS nommé « ${nom} » dans Contenu > Messages RCS` };
  if (!m.content) {
    return { ok: false, statut: 422, code: 'unsendable_target', message: 'le contenu de ce message RCS n’est plus reconnu : ouvrez-le dans Contenu > Messages RCS et enregistrez-le de nouveau' };
  }
  const agentId = await deps.agentIdForTenant(tenantId);
  if (!agentId) return { ok: false, statut: 409, code: 'rcs_not_enabled', message: 'le canal RCS n’est pas activé sur cet espace' };
  return { ok: true, nom: m.name, agentId, contenu: m.content };
}

/**
 * Le nom du message RCS qu'un envoi de l'API a fait partir, relu dans le NOM DE LA CAMPAGNE (`[API] <nom>`),
 * pour la cible `{ rcsMessage }` de `GET /v1/sends/{sendId}`. `null` quand le nom ne porte pas le préfixe.
 *
 * ⚠️ C'EST LE CANAL QUI RECONNAÎT UNE CAMPAGNE RCS, pas cette fonction : `cibleDe` (lot 2) le juge AVANT le
 * template, parce qu'une campagne RCS porte `templateName: ''`. Elle ne fait que NOMMER le message.
 * ⚠️ Le nom vient de l'ENVOI (jamais coupé pour une cible RCS, cf. la route), pas de la bibliothèque : il dit
 * ce qui est parti, même si le message a été renommé depuis, et aucune colonne de plus n'est nécessaire.
 * 🔴 UNE CAMPAGNE RCS DE LA CONSOLE N'A PAS LE PRÉFIXE : elle ne garde que le CONTENU du message, son nom de
 * campagne n'est pas un nom de la bibliothèque, donc `null` (le lot 2 ne l'invente pas, celui-ci non plus).
 */
export function nomDuMessageRcs(nomDeCampagne: string): string | null {
  if (!nomDeCampagne.startsWith(PREFIXE_ENVOI_API)) return null;
  const nom = nomDeCampagne.slice(PREFIXE_ENVOI_API.length);
  return nom === '' ? null : nom;
}
```

- [ ] **Step 6: `getByName`, et le nom et le canal dans la lecture du suivi**

`src/rcs/message-store.pg.ts`, après `getById` :

```ts
  /**
   * Un message par son NOM : la cible `rcsMessage` de `/v1/sends` (lot 3 de l'API publique). Servi par l'index
   * unique PARTIEL `rcs_messages_tenant_name` (0077), dont le prédicat `deleted_at is null` est repris mot pour
   * mot : s'en écarter ferait lire toute la bibliothèque de l'espace sans qu'aucune erreur ne le dise.
   */
  async getByName(tenantId: string, name: string): Promise<RcsMessage | null> {
    const { rows } = await this.pool.query<Row>(
      `select ${COLS} from rcs_messages where tenant_id=$1 and name=$2 and deleted_at is null`,
      [tenantId, name],
    );
    return rows[0] ? toMessage(rows[0]) : null;
  }
```

`src/campaign/store.pg.ts` (la version du lot 2, qui lit déjà `channel`), trois remplacements.

a) Dans l'interface `EnvoiApiBrut`, remplacer :

```ts
  /** `campaigns.channel` (0056, `not null default 'whatsapp'`). Une campagne RCS n'a jamais de scénario. */
  channel: 'whatsapp' | 'rcs';
```

par :

```ts
  /** `campaigns.channel` (0056, `not null default 'whatsapp'`). Une campagne RCS n'a jamais de scénario. */
  channel: 'whatsapp' | 'rcs';
  /**
   * Le nom de la campagne (lot 3). Pour un envoi RCS de l'API, `[API] <nom du message>`, jamais coupé : c'est
   * là que le suivi relit la cible `rcsMessage` (`nomDuMessageRcs`), la campagne ne gardant que le CONTENU.
   */
  name: string;
```

b) Dans `lireEnvoiApi`, remplacer le type de la première requête :

```ts
      id: string; status: CampaignStatus; created_at: Date; channel: string; template_name: string | null; template_language: string | null;
```

par :

```ts
      id: string; status: CampaignStatus; created_at: Date; channel: string; name: string; template_name: string | null; template_language: string | null;
```

et sa liste :

```ts
      `select c.id, c.status, c.created_at, c.channel, c.template_name, c.template_language, c.start_node_id,
```

par :

```ts
      `select c.id, c.status, c.created_at, c.channel, c.name, c.template_name, c.template_language, c.start_node_id,
```

c) Dans l'objet rendu, remplacer :

```ts
      channel: t.channel === 'rcs' ? 'rcs' : 'whatsapp',
```

par :

```ts
      channel: t.channel === 'rcs' ? 'rcs' : 'whatsapp',
      name: t.name,
```

- [ ] **Step 7: Les variables du tri à la construction (`src/api/sends-build.ts`, la version du lot 2)**

Remplacer, dans `DestinataireResolu` :

```ts
  | { index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string }
```

par :

```ts
  | {
    index: number; contactId: string; consent?: 'opted_in' | 'opted_out'; consentSource?: string;
    /** Les variables propres à ce destinataire (lot 3), portées jusqu'à la construction, jamais sur la fiche. */
    variables?: Readonly<Record<string, string>>;
  }
```

Dans `trierDestinataires`, remplacer :

```ts
    eligibles.push({ index: r.index, contact: c });
```

par :

```ts
    // Les variables du DESTINATAIRE voyagent sur la fiche CHARGÉE (une copie), jamais sur la fiche en base.
    eligibles.push({ index: r.index, contact: r.variables ? { ...c, variables: r.variables } : c });
```

Dans `construireDestinataires`, remplacer :

```ts
  tri: ResultatTri,
  now: Date,
): { recipients: BuiltRecipient[]; ecarts: Ecart[] } {
  const built = buildRecipients(category, params, tri.eligibles.map((x) => x.contact), { now });
```

par :

```ts
  tri: ResultatTri,
  now: Date,
  /** Le canal de la campagne (lot 3) : `rcs` pour une cible `rcsMessage`. Absent = WhatsApp, comme au lot 2. */
  canal: 'whatsapp' | 'rcs' = 'whatsapp',
): { recipients: BuiltRecipient[]; ecarts: Ecart[] } {
  const built = buildRecipients(category, params, tri.eligibles.map((x) => x.contact), { now }, canal);
```

(`ContactEnvoi` étend `BuildContact`, qui porte `variables?` depuis la Task 3 : la copie reste un `ContactEnvoi`.)

- [ ] **Step 8: Brancher la cible dans la route (`src/http/v1-sends.ts`, la version du lot 2)**

a) Après `import { formaterSuiviEnvoi } from '../api/suivi-envoi';` :

```ts
import type { RcsOutbound } from '../rcs/types';
import { PREFIXE_ENVOI_API, resoudreCibleRcs, schemaCibleRcs, type DepsCibleRcs } from '../api/cible-rcs';
import { destinataireAvecVariablesInterdites, schemaVariables } from '../api/variables';
```

b) Dans `V1SendCreateInput`, remplacer :

```ts
  /** Cible node : le run démarre à ce bloc du scénario (au lieu de son entrée). */
  startNodeId?: string;
}
```

par :

```ts
  /** Cible node : le run démarre à ce bloc du scénario (au lieu de son entrée). */
  startNodeId?: string;
  /** Cible `rcsMessage` (lot 3) : une campagne RCS, partie de l'agent de l'espace. Absent = WhatsApp. */
  channel?: 'rcs';
  rcsAgentId?: string;
  rcsMessage?: RcsOutbound;
}
```

c) Dans `V1SendsRouteDeps`, après la ligne `  lireEnvoi(sendId: string, tenantId: string): Promise<EnvoiApiBrut | null>;` :

```ts
  /** La cible `rcsMessage` (lot 3) : un message de la bibliothèque par son nom, et l'agent RCS de l'espace. */
  rcs: DepsCibleRcs;
```

d) Dans `schemaCible`, remplacer :

```ts
  z.strictObject({ node: z.string().trim().min(1).max(200) }),
]);
```

par :

```ts
  z.strictObject({ node: z.string().trim().min(1).max(200) }),
  // Lot 3 : un message de Contenu > Messages RCS, par son NOM (`src/api/cible-rcs.ts`).
  schemaCibleRcs,
]);
```

et, dans le commentaire juste au-dessus de `schemaCible`, remplacer `LES TROIS CIBLES DE CE LOT.` par `LES QUATRE CIBLES.` et retirer la dernière phrase (celle qui annonce que le lot 3 ajoutera `rcsMessage` à l'union), devenue fausse.

e) Dans `schemaDestinataire`, remplacer :

```ts
  consentSource: z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional(),
});
```

par :

```ts
  consentSource: z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional(),
  // Lot 3 : des valeurs propres à CE destinataire, jamais écrites sur sa fiche. Mal formées, elles écartent le
  // destinataire (`invalid_recipient`), comme toute autre clé fautive.
  variables: schemaVariables.optional(),
});
```

f) Dans `PRECISIONS`, remplacer la ligne `target: ...` par :

```ts
  target: 'une cible parmi { "template": { "name", "language" } }, { "scenario": "scn_…" ou un nom }, { "node": "nod_…" } et { "rcsMessage": "<nom d’un message RCS>" }',
```

g) Dans `CibleDemandee`, remplacer :

```ts
  | { kind: 'node'; code: string; category: CampaignCategory };
```

par :

```ts
  | { kind: 'node'; code: string; category: CampaignCategory }
  | { kind: 'rcsMessage'; nom: string; category: CampaignCategory };
```

h) Dans `CibleResolue`, remplacer :

```ts
  workflowId?: string;
  startNodeId?: string;
}
```

par :

```ts
  workflowId?: string;
  startNodeId?: string;
  /** Cible `rcsMessage` : l'agent qui envoie et le contenu, qui partent dans la campagne RCS. */
  rcs?: { agentId: string; contenu: RcsOutbound };
}
```

i) Dans `lireCible`, remplacer :

```ts
  if (corps.category === undefined) return { message: 'category : requise sur un scénario ou un bloc (marketing | utility)' };
  if (params.length > 0) return { message: 'params : n’a de sens que sur un template (aucune variable n’est envoyée à un scénario ou à un bloc)' };
  return 'scenario' in t
```

par :

```ts
  if (corps.category === undefined) return { message: 'category : requise sur un scénario, un bloc ou un message RCS (marketing | utility)' };
  if (params.length > 0) return { message: 'params : n’a de sens que sur un template (les {{variables}} d’un message RCS viennent de recipients[].variables)' };
  if ('rcsMessage' in t) return { kind: 'rcsMessage', nom: t.rcsMessage, category: corps.category };
  return 'scenario' in t
```

j) Dans `resoudreCible`, juste avant la ligne `  if (c.kind === 'scenario') {` :

```ts
  if (c.kind === 'rcsMessage') {
    const r = await resoudreCibleRcs(deps.rcs, tenantId, c.nom);
    if (!r.ok) return { refus: { statut: r.statut, code: r.code, message: r.message } };
    return {
      ouverture: 'rcs', category: c.category, label: r.nom, templateName: '', templateLanguage: '',
      rcs: { agentId: r.agentId, contenu: r.contenu },
    };
  }
```

k) Dans `resoudreDestinataires`, remplacer :

```ts
    const { consent, consentSource, ...cles } = d.data;
```

par :

```ts
    // `variables` est retiré des clés : `resoudreFiche` ne les voit pas, et elles ne touchent JAMAIS la fiche.
    const { consent, consentSource, variables, ...cles } = d.data;
```

et :

```ts
    resolus.push(consent ? { index, contactId: r.contactId, consent, consentSource: consentSource ?? 'api' } : { index, contactId: r.contactId });
```

par :

```ts
    resolus.push({
      index, contactId: r.contactId,
      ...(consent ? { consent, consentSource: consentSource ?? 'api' } : {}),
      ...(variables ? { variables } : {}),
    });
```

l) Dans le corps de `POST /v1/sends`, cinq remplacements. D'abord :

```ts
    const params = validateParamMapping(corps.params ?? []);
```

par :

```ts
    // La source « variable » (lot 3) est admise ici, et nulle part dans la console.
    const params = validateParamMapping(corps.params ?? [], { accepterVariables: true });
```

Puis, juste après la ligne `    if ('message' in demandee) return refuser(reply, 400, 'invalid_body', demandee.message);` :

```ts
    // Un scénario ou un bloc n'a aucun endroit où ranger des variables par destinataire (spec § 3) : refusé
    // AVANT le compteur d'usage et le claim d'idempotence, sur les destinataires tels que reçus.
    const fautif = destinataireAvecVariablesInterdites(demandee.kind, corps.recipients);
    if (fautif !== null) {
      return refuser(reply, 400, 'invalid_body', `recipients.${fautif}.variables : un scénario ou un bloc n’a aucun endroit où ranger des variables par destinataire`);
    }
```

Puis, dans le `try` qui suit le claim d'idempotence :

```ts
      const numero = await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
```

par :

```ts
      // Un message RCS part de l'agent RCS de l'espace : AUCUN numéro WhatsApp n'est exigé (spec § 3), et un
      // `phoneNumberId` fourni est ignoré (il reste optionnel). `numeroDEnvoi` rendrait sinon 409
      // `no_whatsapp_number` à un espace qui n'a que le RCS. La ligne suivante (`libererEtRefuser`) ne change pas.
      const numero = demandee.kind === 'rcsMessage' ? { phoneNumberId: '' } : await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
```

Puis :

```ts
      const { recipients, ecarts } = construireDestinataires(cible.category, params, tri, new Date());
```

par :

```ts
      const { recipients, ecarts } = construireDestinataires(cible.category, params, tri, new Date(), cible.rcs ? 'rcs' : 'whatsapp');
```

Enfin, dans l'entrée de `deps.createSend`, remplacer :

```ts
          tenantId, phoneNumberId: numero.phoneNumberId, name: `[API] ${cible.label}`.slice(0, 120), category: cible.category,
          templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
          ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
          ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
```

par :

```ts
          // 🔴 Le préfixe est `PREFIXE_ENVOI_API`, que le suivi relit (`nomDuMessageRcs`). Le nom d'un envoi RCS
          // n'est PAS coupé : le suivi y relit le nom du message, qui va jusqu'à 120 caractères dans la
          // bibliothèque (126 préfixe compris ; la colonne n'a pas de borne). Les autres cibles gardent leur coupe.
          tenantId, phoneNumberId: numero.phoneNumberId, category: cible.category,
          name: cible.rcs ? `${PREFIXE_ENVOI_API}${cible.label}` : `${PREFIXE_ENVOI_API}${cible.label}`.slice(0, 120),
          templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
          ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
          ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
          ...(cible.rcs ? { channel: 'rcs' as const, rcsAgentId: cible.rcs.agentId, rcsMessage: cible.rcs.contenu } : {}),
```

- [ ] **Step 9: La cible RCS dans le suivi (`src/api/suivi-envoi.ts`, la version du lot 2)**

Le lot 2 juge DÉJÀ le canal avant le template (`if (b.channel === 'rcs') return { rcsMessage: null };`, en tête de `cibleDe`) et rend l'ouverture `rcs` (`ouvertureDe`). Ce lot ne touche ni l'ordre ni `CibleSuivi` : il NOMME le message.

Après `import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';` :

```ts
import { nomDuMessageRcs } from './cible-rcs';
```

Dans `cibleDe`, remplacer :

```ts
  if (b.channel === 'rcs') return { rcsMessage: null };
```

par :

```ts
  // Lot 3 : un envoi RCS de l'API NOMME son message (relu derrière `[API] ` dans le nom de la campagne) ; une
  // campagne RCS de la console reste à `null`, elle ne garde que le contenu.
  if (b.channel === 'rcs') return { rcsMessage: nomDuMessageRcs(b.name) };
```

Et, dans le commentaire au-dessus de `CibleSuivi`, remplacer les deux lignes :

```ts
 * Sa cible est `{ rcsMessage: null }` : la campagne garde le CONTENU du message (`campaigns.rcs_message`), pas
 * son nom dans la bibliothèque, et ce lot ne l'invente pas.
```

par :

```ts
 * Sa cible est `{ rcsMessage: <nom> }` pour un envoi de l'API (lot 3 : le nom du message, relu derrière le
 * préfixe `[API] ` du nom de la campagne), `{ rcsMessage: null }` pour une campagne de la console, qui ne garde
 * que le CONTENU du message (`campaigns.rcs_message`) : aucun nom n'y est inventé.
```

(Le `channel` de chaque destinataire suit déjà l'ouverture dans `formaterSuiviEnvoi` : `rcs`.)

- [ ] **Step 10: Le câblage dans `src/index.ts`**

Dans le bloc `sends: { ... }` du lot 2, après la ligne `        lireEnvoi: (sendId, tenant) => repo.lireEnvoiApi(sendId, tenant),` :

```ts
        // La cible `rcsMessage` (lot 3) : la bibliothèque par son nom, et l'agent RCS de l'espace.
        rcs: {
          messageRcsParNom: (tenant, nom) => rcsMessageStore.getByName(tenant, nom),
          agentIdForTenant: (tenant) => workflowRuntime.rcsStack.agents.agentIdForTenant(tenant),
        },
```

- [ ] **Step 11: Les voir passer, et rien d'autre casser**

Run: `cd /c/Users/julie/messagingme-mba && npx vitest run tests/api-cible-rcs.test.ts tests/api-suivi-envoi-rcs.test.ts tests/api-suivi-envoi.test.ts tests/api-tri-destinataires.test.ts tests/v1-sends.test.ts tests/api-usage-observation.test.ts tests/v1-cablage.test.ts && npm run typecheck && npm test`
Expected: PASS partout, y compris tous les cas du lot 2 dans `tests/v1-sends.test.ts` et `tests/api-suivi-envoi.test.ts` (aucune cible existante n'a changé ; leurs fixtures ont seulement gagné `name` et `channel`).

- [ ] **Step 12: Vérifier quatre tests dans les deux sens**

1. Dans `cibleDe`, remettre temporairement `if (b.channel === 'rcs') return { rcsMessage: null };` : `npx vitest run tests/api-suivi-envoi-rcs.test.ts` échoue avec le symptôme exact (`expected { rcsMessage: null } to deeply equal { rcsMessage: 'relance-panier' }`), et le cas de la console reste vert (la mutation ne touche que l'envoi de l'API). Restaurer.
2. Dans la route, retirer temporairement le bloc `destinataireAvecVariablesInterdites` : `npx vitest run tests/v1-sends.test.ts` échoue sur « variables sur un scénario ou un bloc » (`expected [ 201, undefined ] to deeply equal [ 400, 'invalid_body' ]`). Restaurer.
3. Remettre `.slice(0, 120)` sur le nom d'un envoi RCS : le cas « un nom de 120 caractères n’est PAS coupé » échoue (le nom rendu fait 120 caractères au lieu de 126). Restaurer.
4. Dans `trierDestinataires`, remettre `eligibles.push({ index: r.index, contact: c });` : `tests/api-tri-destinataires.test.ts` échoue sur « elles voyagent du tri à la construction » (`missing_variable` à l'index 0) et `tests/v1-sends.test.ts` sur le cas 201 (`variables` absentes du destinataire construit). Restaurer, relancer les quatre fichiers : PASS, et `git diff` ne montre plus aucune mutation.

- [ ] **Step 13: Commit, puis verdict de l'intégration sur la CI**

`src/index.ts` est un fichier de câblage PARTAGÉ : si `git diff -- src/index.ts` montre une ligne qui n'est pas de cette tâche, ne PAS lancer la commande ci-dessous, construire le commit en plomberie (Global Constraints).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="src/api/variables.ts src/api/cible-rcs.ts src/rcs/message-store.pg.ts src/campaign/store.pg.ts src/api/sends-build.ts src/http/v1-sends.ts src/api/suivi-envoi.ts src/index.ts tests/api-cible-rcs.test.ts tests/api-suivi-envoi-rcs.test.ts tests/api-tri-destinataires.test.ts tests/v1-sends.test.ts tests/api-suivi-envoi.test.ts tests/api-usage-observation.test.ts tests/integration/rcs-libre.integration.test.ts" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git add -N src/api/variables.ts src/api/cible-rcs.ts tests/api-cible-rcs.test.ts tests/api-suivi-envoi-rcs.test.ts \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
feat(api): la cible rcsMessage et les variables par destinataire dans /v1/sends

Une campagne RCS sans numéro WhatsApp, au nom jamais coupé ; les variables voyagent du destinataire reçu à la
construction, jamais sur la fiche ; le suivi nomme le message RCS d'un envoi de l'API (null pour la console).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
gh run list --limit 3
gh run view <id du run de ce commit> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Expected: tous les jobs en `success`, `integration` compris.

---

### Task 11: La documentation technique

**Files:**
- Modify: `documentation.md` (§ 5 « Données et multi-tenant », sous-section « Identité d'un contact : un numéro OU un BSUID », après la ligne 611 ; § 12 « Invariants actifs », sous-section « Sur les envois », après son dernier item)

**Interfaces:** aucune.

- [ ] **Step 1: S'assurer que `documentation.md` n'est pas en cours d'édition ailleurs, et prendre les numéros**

```bash
cd /c/Users/julie/messagingme-mba && git diff --stat -- documentation.md
sed -n '/^## 12\. Invariants actifs/,/^## 13\. /p' documentation.md | grep -oE '^[0-9]+\.' | tr -d . | sort -n | tail -1
```

Expected: la première commande ne rend aucune ligne (sinon `SendMessage` à la session concernée, attendre son commit, `git fetch origin`, reprendre ce step). La seconde rend le PLUS GRAND numéro d'invariant de tout le § 12 (31 le jour où ce plan est écrit, relevé et non recopié : la valeur qui compte est celle du jour). `<K>` vaut ce numéro plus un, `<K+1>` et `<K+2>` le suivent.

🔴 **Les numéros du § 12 sont CONTINUS sur toute la section** (« Sur les envois » s'arrête à 11, « Sur les contrats externes » commence à 12) et ils sont CITÉS ailleurs (`CLAUDE.md` renvoie à « invariant §12.7 ») : écrire 12, 13, 14 à la suite de « Sur les envois » créerait des doublons, et renuméroter la suite casserait les renvois. Les trois invariants prennent donc des numéros NEUFS, après le plus grand de toute la section, tout en restant rangés sous « Sur les envois », où on les cherchera.

- [ ] **Step 2: Écrire les invariants**

Dans § 5, sous-section « Identité d'un contact : un numéro OU un BSUID », après la phrase « ... et le cache de joignabilité RCS a pour clé l'E.164. La correspondance passe par le prédicat partagé `MATCH_BY_WAID_SQL`, jamais par une égalité directe. », ajouter :

```markdown
⚠️ **Le cache de joignabilité RCS est écrit par le RAPPORT DE LIVRAISON**, smsmode ne sachant pas la dire avant
l'envoi : un échec définitif y pose « injoignable », une livraison « joignable », pour l'agent qui a envoyé et
toujours en E.164 (`traiterRapportRcs`, `src/rcs/rapport-livraison.ts`). `envoyerRcsLibre` le lit directement
pour une MACHINE seulement (l'opérateur de l'Inbox n'y est pas soumis), et un « injoignable » plus vieux que
`TTL_MS` ne refuse plus rien.
```

Dans § 12, sous-section « Sur les envois », juste après son dernier item (celui qui commence par « **Un envoi qui n'a rien montré au contact ne se journalise pas** »), ajouter une ligne vide puis ce bloc, où `<K>`, `<K+1>` et `<K+2>` sont les numéros du Step 1. La phrase d'introduction n'est pas décorative : elle ouvre une NOUVELLE liste, que le rendu Markdown numérote donc à partir de `<K>` ; collée à la liste précédente, elle serait renumérotée à la suite de 11.

```markdown
Ajoutés par le lot 3 de l'API publique, et numérotés après le dernier invariant de ce § 12 pour ne décaler
aucun renvoi :

<K>. **L'échec d'un message LIBRE s'écrit dans `echecs_messages`, et lui seul** (`processStatuses` pour Meta,
   `traiterRapportRcs` pour smsmode) : un échec qui a touché un destinataire de campagne est déjà porté par sa
   ligne, et un message d'origine `campagne` est exclu à l'écriture. La lecture de plus n'a lieu que sur un
   échec qui n'a touché aucun destinataire : un statut ordinaire de Meta ne coûte aucune requête. Un rapport
   smsmode qui DEVANCE l'inscription du message dans le fil est écrit quand même, origine inconnue
   (`noterSansMessage`). Le journal des erreurs le lit en quatrième source (`message`) ; Analytics l'exclut
   (`campagnesSeulement`), parce que son compteur par code ne compte que les campagnes ; la purge RGPD efface
   les lignes de la personne.
<K+1>. **Un RCS libre a UN chemin, `envoyerRcsLibre`**, pour le bouton de l'Inbox et `POST /v1/messages/rcs`.
   Une MACHINE ne l'envoie qu'à une fiche qui a consenti ou nous a déjà écrit, qui n'a dit STOP ni en général
   ni en RCS, et que le cache ne dit pas injoignable ; l'OPÉRATEUR n'est soumis qu'au STOP RCS, par le point de
   passage unique de l'envoi, et son bouton reste celui d'avant.
<K+2>. **Les variables d'un destinataire de l'API ne touchent jamais la fiche** : `campaign_recipients.variables`,
   relues à l'envoi d'un message RCS (elles priment sur le champ de fiche du même nom) et au renvoi F7, remises
   à `null` par la purge RGPD. Un scénario ou un bloc les refuse (400) : il n'a nulle part où les ranger.
```

- [ ] **Step 3: Vérifier et commiter**

Run: `cd /c/Users/julie/messagingme-mba && npm test` (un test lit la gouvernance du manuel ; il doit rester vert).
Puis relire le rendu du bloc (`git diff -- documentation.md`) : les trois numéros sont neufs, et aucun n'existe déjà dans le § 12 (`sed -n '/^## 12\. Invariants actifs/,/^## 13\. /p' documentation.md | grep -oE '^[0-9]+\.' | sort | uniq -d` ne rend aucun de `<K>.`, `<K+1>.`, `<K+2>.`).

```bash
cd /c/Users/julie/messagingme-mba && CHEMINS="documentation.md" \
  && test "$(printf '%s\n' $CHEMINS | grep -cvE '^(src/|tests/|db/migrations/|web/lib/api/contacts\.ts|web/components/ErreursLivraison\.tsx|documentation\.md|CLAUDE\.md)')" = 0 \
  && git diff -- $CHEMINS \
  && MSG="$(mktemp)" && cat > "$MSG" <<'EOF' && head -1 "$MSG" && git commit --only $CHEMINS -F "$MSG" && git push origin main
docs(manuel): les invariants du lot 3 de l'API publique (échecs libres, RCS libre, variables)

Numérotés après le dernier invariant du § 12, pour ne décaler aucun renvoi.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 12: Revue, verdict de la CI, et contrôle d'ensemble

**Files:** aucun écrit hors correctifs de revue.

- [ ] **Step 1: Le lot entier, en local**

Run: `cd /c/Users/julie/messagingme-mba && npm run typecheck && npm test && cd web && npx tsc --noEmit && npm run lint`
Expected: PASS partout. Un échec dans un fichier HORS du périmètre de ce lot (arbre partagé) se vérifie avant de s'attribuer la cause : `git diff --name-only` et `git log origin/main -5 --stat`.

- [ ] **Step 2: Aucun tiret cadratin ni demi-cadratin ajouté**

Run: `cd /c/Users/julie/messagingme-mba && git diff <premier commit du lot>~1 origin/main -- src tests db web documentation.md | grep -n "^+" | grep -c -e $'\xe2\x80\x94' -e $'\xe2\x80\x93'`
Expected: `0`. (Relire aussi à l'œil les messages d'erreur de l'API ajoutés : aucun nom d'outil tiers, aucun nom de l'infrastructure sous-jacente.)

- [ ] **Step 3: `/revue` sur le lot**

Invoquer la skill `revue` sur les commits du lot, section « Rayon de souffle » comprise (la liste de ce plan en est le point de départ). Corriger les 🔴 ET les 🟡 dans la foulée (chaque correctif avec son test, vérifié dans les deux sens), commits séparés.

- [ ] **Step 4: Verdict de la CI sur le dernier commit de code**

```bash
cd /c/Users/julie/messagingme-mba && gh run list --limit 5
gh run view <id> --json jobs --jq '.jobs[] | {name, conclusion}'
```

Expected: chaque job en `success`, `integration` compris. Un push qui ne touche que des `.md` ne déclenche aucun run : lire le run du dernier commit de CODE.

---

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** Les quatre questions penchent toutes du même côté : la production emprunte ces chemins (le traitement de CHAQUE statut de livraison de Meta, le rapport de CHAQUE RCS, la création et le run de CHAQUE campagne, le bouton RCS de l'Inbox), un message parti ne se rappelle pas, une partie des critères demande un œil (un vrai numéro sans RCS, un vrai rapport d'échec), et le code touché porte des invariants invisibles au compilateur : l'index unique `conversation_messages_wamid_uidx` dont dépend la capture, l'index unique de `echecs_messages` dont dépend `on conflict`, la forme E.164 de la clé du cache de joignabilité, la parité entre le compteur d'Analytics et son détail, le contrat du `CampaignSender` que le moteur appelle pour tout destinataire, l'ordre « ouvrir le fil, PUIS le prendre » (`setControlOwner` ne crée rien), le nom `[API] <message>` que le suivi relit pour dire la cible RCS, et la transaction de la purge RGPD, qui nomme désormais les deux données neuves. `feature-loop` est écarté : sa porte est la complétude d'un critère mécanique, et le critère qui clôt ce lot (« l'échec d'un vrai RCS apparaît dans le journal et le suivant est refusé ») ne s'observe qu'en production. Aucun `Workflow` multi-agents : non demandé.

L'essai réel qui clôt ce lot, le geste en production sans lequel il n'est que vert et pas éprouvé, est décrit dans la section « Essai réel qui clôt le lot » ci-dessous.

## Essai réel qui clôt le lot

Repris du § 14 de la spec (points 2, second volet, et 3), avec une VRAIE clé d'API, en production, sur le numéro d'essai, en regardant le téléphone, Campagnes, l'Inbox et Sécurité > Journal des erreurs :

1. `POST /v1/sends` avec l'idempotence DANS LE CORPS, cible `{ "template": ... }` dont le paramètre 1 a la source `{ "type": "variable", "key": "commande" }`, un destinataire `{ "phone": <numéro d'essai>, "variables": { "commande": "8412" } }` : le template arrive, « 8412 » rempli.
2. `POST /v1/sends`, cible `{ "rcsMessage": "<un message de la bibliothèque qui porte {{commande}}>" }`, `category: "utility"`, le même destinataire avec ses variables : le RCS arrive, la variable remplie ; la campagne apparaît dans Campagnes sous `[API] <nom>` ; `GET /v1/sends/{sendId}` rend `target: { rcsMessage }`, `opening: "rcs"`.
3. `POST /v1/messages/rcs` vers le numéro d'essai, sur une fiche créée par `POST /v1/contacts` et qui n'a JAMAIS écrit : le RCS libre arrive, apparaît dans l'Inbox avec l'origine API, et le fil est PRIS (`select control_owner from conversations where wa_id = '<wa_id>'` rend `app_human`, pas `app_workflow`).
4. Une fiche créée par `POST /v1/contacts` avec `consent: "opted_in"` sur un numéro dont l'appareil N'A PAS le RCS : le premier `POST /v1/messages/rcs` est accepté ; son rapport d'échec apparaît dans Sécurité > Journal des erreurs (« RCS non délivré (envoi par l'API) », ou « RCS non délivré » sans origine si le rapport a devancé l'inscription du message : c'est `noterSansMessage` qui l'a écrit, et la ligne DOIT être là dans les deux cas) ; `select reachable, checked_at from rcs_capabilities_cache where phone_e164 = '<E.164>'` rend `false` ; le second `POST /v1/messages/rcs` rend 422 `rcs_unreachable`. Le bouton RCS de l'Inbox, lui, n'est PAS soumis au cache (spec § 17) : ne pas le cliquer sur ce numéro, il partirait et un second échec arriverait dans le journal.
5. Le bouton RCS de l'Inbox sur le numéro d'essai (joignable) : il part comme avant, avec la même phrase en cas de refus.
6. Une fiche sans consentement qui n'a jamais écrit : `POST /v1/messages/rcs` rend 409 `no_consent`, et aucune conversation vide n'apparaît dans l'Inbox.

Tant que ces six gestes n'ont pas été faits, le lot est vert, pas éprouvé.

## Rayon de souffle

Ce que le lot change, et qui le lit ailleurs (§ 17 de la spec, complété par la lecture du code) :

- **`sendRcsFromInbox` devient `envoyerRcsLibre`** : le bouton RCS de l'Inbox garde son contrat (`InboxRouteDeps.sendRcsFromInbox`, route `send-rcs` inchangée, `tests/http-inbox-rcs.test.ts` et l'e2e `web/e2e/inbox-envoi-rcs.spec.ts` intacts), ses quatre phrases, et son comportement : ni consentement, ni STOP général, ni cache de joignabilité pour l'opérateur (spec § 17). ⚠️ UN seul écart, délibéré : un fil au `wa_id` non numérique (BSUID) est refusé en « pas de numéro » au lieu de partir vers le fournisseur, qui l'aurait refusé (le RCS s'adresse à un numéro).
- **`processStatuses`** (chemin très chaud, deux files) : une requête de plus SEULEMENT sur un `failed` qui n'a touché aucun destinataire de campagne ; best-effort. Le couple `delivery`/`tarifsMeta` de `WebhookJobDeps` devient un triplet : les deux appels du worker et quatre fichiers de tests le passent. ⚠️ Côté Meta, aucun repli `noterSansMessage` : l'accusé traverse la file `webhook-status` avant d'être traité, ce qui laisse à la route le temps d'inscrire le message ; un échec qui la devancerait resterait non écrit (limite connue, à mesurer avant d'y ajouter une écriture).
- **`onDlr`** extrait vers `traiterRapportRcs` : l'ordre des deux étapes d'avant est gardé (livraison, mesure par bloc, puis sorties du bloc), les ajouts sont best-effort. ⚠️ Une livraison (`delivered`) coûte désormais une écriture par clé primaire dans `rcs_capabilities_cache`, pour TOUT RCS, campagne comprise. ⚠️ Un échec dont le message n'est pas dans le fil (rapport qui devance l'inscription, mais aussi un RCS qu'aucun chemin n'inscrit, comme un envoi d'essai) est désormais écrit dans le journal, origine inconnue (`noterSansMessage`).
- **`PgContactStore.purgeMany`** (la purge RGPD, une transaction) : elle remet `campaign_recipients.variables` à `null` et efface les lignes d'`echecs_messages` de la personne (scopées à l'espace, visées par les wa_id des fils ET le numéro de la fiche). Elle efface déjà le cache de joignabilité par E.164, la forme que `traiterRapportRcs` écrit. 🔴 Elle NOMME donc les deux migrations du lot : les appliquer APRÈS le `up` ferait échouer TOUTE purge en `42703` ou `42P01` (précédent : 0163).
- **`bulkInsertRecipients` et `listPending`** servent TOUTE campagne (console, API, fil de l'eau) : ils écrivent et lisent `campaign_recipients.variables`, d'où la migration <N> BLOQUANTE. `insertWebhookRecipient` n'écrit pas la colonne (reste `null`).
- **`resetRecipientForRetry`** (F7, bouton « Corriger + renvoyer ») re-résolvait sur la fiche seule : il relit les variables, sans quoi une source `variable` y manquerait toujours.
- **`CampaignSender.sendTo`** : son `Pick` gagne `variables` ; le seul appelant est le moteur (`engine.ts`, qui passe le `Recipient` complet de `listPending`).
- **`buildRecipients`** sert aussi `createCampaignWithRecipients` (console) et `webhook-feed` : un contact sans `variables` produit un destinataire SANS clé `variables` (garde de test).
- **`validateParamMapping`** sert la console (`src/http/campaigns.ts`) : sans l'option, `variable` y reste refusée ; `parseParamHints` (indices des templates) la refuse toujours, donc le catalogue du lot 4 n'en verra jamais.
- **`PgErreursLivraisonStore.lister`** : la fusion en mémoire passe de deux à trois lectures bornées par `limit`. ⚠️ **Analytics** (`getErrorContacts`) lit le MÊME store : sans `campagnesSeulement`, le détail d'un code ouvrirait plus de lignes que le compteur de `getErrorBreakdown` n'en annonce.
- **`ErreurLivraison.origine`** gagne `message` : `web/lib/api/contacts.ts` et `web/components/ErreursLivraison.tsx` suivent ; `web/lib/api/stats.ts` n'est pas touché (Analytics ne reçoit jamais cette origine).
- **Le balayage de rétention du worker** gagne une étape indépendante (son propre `try`).
- **`POST /v1/sends`** (route du lot 2) : une cible de plus (`schemaCible`, `CibleDemandee`, `lireCible`, `resoudreCible`), un champ de plus par destinataire (`schemaDestinataire`, retiré des clés avant `resoudreFiche`), une dépendance REQUISE de plus (`rcs`) ; `numeroDEnvoi` n'est plus appelé pour une cible `rcsMessage` (un `phoneNumberId` fourni y est ignoré, la doc du lot 4 doit le dire) ; le nom d'un envoi RCS n'est plus coupé à 120 caractères ; le préfixe `[API] ` n'est plus écrit qu'une fois (`PREFIXE_ENVOI_API`). Les doubles du lot 2 qui décrivent `V1SendsRouteDeps` (`tests/v1-sends.test.ts`, `tests/api-usage-observation.test.ts`) gagnent `rcs`.
- **`src/api/sends-build.ts`** (lot 2) : `DestinataireResolu` porte les variables, `trierDestinataires` les pose sur une COPIE de la fiche chargée, `construireDestinataires` transmet le canal à `buildRecipients`. Ses appelants : la seule route `/v1/sends`.
- **`EnvoiApiBrut` et `lireEnvoiApi`** (lot 2, qui y lit déjà `channel`) gagnent `name` : `cibleDe` rend le nom du message d'un envoi RCS de l'API au lieu de `null`, et les deux fixtures du lot 2 qui décrivent un `EnvoiApiBrut` (`tests/api-suivi-envoi.test.ts`, `tests/v1-sends.test.ts`) gagnent le champ. ⚠️ La fixture `TEMPLATE` reçoit un nom SANS préfixe : son cas « campagne RCS de la console » l'étale et attend `{ rcsMessage: null }`. Le contrat rendu par `GET /v1/sends/{sendId}` ne change pas de forme.
- **`POST /v1/messages/rcs`** ouvre le fil PUIS le prend : l'inverse de l'ordre naïf, parce que `setControlOwner` n'est qu'un `update` (cf. `/v1/messages/whatsapp`, qui ouvre avant de prendre).
- **`OperationApi` `messages.send`** couvre désormais les deux messages simples ; `/ops` les compte ensemble.
- **`web/lib/qui-a-repondu.ts`** (commentaire de l'origine `api`, que le lot 2 a laissé à ce lot) affirme qu'un message de l'API « ne peut arriver qu'APRÈS que la personne a écrit », pour justifier le badge « scripté ». C'est faux dès `POST /v1/messages/rcs` (aucune fenêtre, une fiche qui a seulement consenti suffit) : le badge ne change pas dans ce lot, mais le commentaire et la raison du badge sont à trancher par Julien à la revue finale DE CE LOT, qui les corrige dans ce lot (aucun autre plan ne touche ce fichier : le lot 4 ne réécrit que la page de doc et `features.md`). Le commit de cette correction ajoute `web/lib/qui-a-repondu\.ts` au motif du contrôle d'intrus du gabarit de commit.
- **Le lot 6** émettra `em_message_failed` depuis SES propres points d'accroche, posés APRÈS les blocs de ce lot (`processStatuses`, et le câblage d'`onDlr` autour de `traiterRapportRcs`) ; il ne lit pas le retour de `noter`. Ce que ce lot doit lui laisser intact : `PuitsAccuses.echecsLibres`, le couple `{ delivery; tarifsMeta; echecsLibres }` de `WebhookJobDeps`, et la forme `onDlr: (tenant, dlr) => traiterRapportRcs({ … }, tenant, dlr)`.
- **Le serveur MCP n'est PAS touché.** La doc de l'API (`web/app/developers/api/page.tsx`) et `features.md` sont du lot 4.

## Déploiement

1. **Prérequis** : les lots 1 et 2 sont en production (ce lot appelle `resoudreFiche`, `refuser`, la route `/v1/sends` refondue et `formaterSuiviEnvoi`).
2. **CI** : `gh run list` puis `gh run view <id> --json jobs` sur le dernier commit de CODE du lot, chaque job en `success`, `integration` compris ; `git log <déployé>..origin/main --oneline` relu pour savoir ce qui part.
3. **`/revue-finale`** : son attestation est exigée par la garde de déploiement avant tout `migrate` ou `up` par `ssh`.
4. **Sur le VPS, dans cet ordre** : `git pull` ; `sudo docker compose build mba-api mba-worker` (les migrations vivent DANS l'image) ; `sudo docker compose run --rm --no-deps mba-api npm run migrate` (applique <N> et <N+1>, toutes deux additives et BLOQUANTES pour le code neuf : la création et le run de campagne nomment la première, la purge RGPD les deux ; l'ancien code y survit, d'où l'ordre) ; relecture en base IMMÉDIATE :

```sql
select name, applied_at from public.schema_migrations order by name desc limit 3;
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_name = 'campaign_recipients' and column_name = 'variables';            -- jsonb, YES, null
select column_name, data_type, is_nullable, column_default from information_schema.columns
 where table_name = 'echecs_messages' order by ordinal_position;
select indexname, indexdef from pg_indexes where tablename = 'echecs_messages';     -- les deux index, unique sur message_id
select confdeltype from pg_constraint where conrelid = 'echecs_messages'::regclass and contype = 'f';  -- 'c'
select count(*) from echecs_messages;                                                -- 0
select count(*) from campaign_recipients where variables is not null;               -- 0 : aucune ligne réécrite
```

   PUIS `sudo docker compose up -d --build mba-api mba-worker` (les DEUX : le worker écrit les échecs de Meta et purge, l'API écrit ceux de smsmode, sert la route et le journal).
5. **Contrôle public des deux portes** (`api.messagingme.app` et le chemin `/api/backend/` de `mba.messagingme.app`) : un 502 avec des conteneurs `healthy` se règle par `sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.
6. **Le chemin chaud exécuté par le vrai code**, dans le conteneur `mba-api` : `PgRecipientStore.listPending` sur une campagne récente (rend `variables: null`, pas de `42703`) et `PgErreursLivraisonStore.lister` sur un espace réel (rend ses lignes). Rien n'est écrit.
7. **Le compteur** : dans `CLAUDE.md`, « Dernière appliquée : <N+1> », RELU dans `schema_migrations` juste après `migrate`, commit `--only CLAUDE.md`.
8. **La console** : la seule modification de `web/` (l'étiquette de l'origine `message` dans le journal) n'appelle aucune route neuve ; elle part avec le push du code sans fenêtre à gérer. La page de documentation de l'API qui décrit ces routes (lot 4) ne se pousse qu'APRÈS ce déploiement.
9. **L'essai réel** ci-dessus, puis `/sync`.
