# Le widget WhatsApp : plan d'implémentation

**But :** une bulle WhatsApp à poser sur le site d'un client, qui ouvre WhatsApp avec un message pré-rempli, pour
tous les clients de la console.

**Approche :** une route publique sert un JavaScript dont la configuration est écrite dedans (aucun CORS). Une
table `widgets` porte la phrase, l'apparence et le devenir. À l'arrivée d'un message, la phrase identifie le
widget et son devenir s'applique à cette conversation, une seule fois.

**Spec :** [docs/superpowers/specs/2026-10-02-widget-whatsapp-design.md](../specs/2026-10-02-widget-whatsapp-design.md)

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, décidée dans la spec. La production emprunte ce chemin, le
lot crée une surface publique irréversible, et il porte des invariants qu'aucun test ne voit : la stabilité d'une
URL distribuée chez des tiers, et l'arbitrage entre deux réglages de répondeur. L'essai qui clôt se fait dans un
navigateur, sur un vrai site, avec un vrai téléphone.

## Contraintes globales

- 🔴 **L'arbre local est en retard de 153 commits sur `origin`** (constaté le 2026-10-02). Travailler depuis
  `origin/main`, et lire chaque référence avec `git show origin/main:<fichier>` plutôt que dans l'arbre.
- 🔴 **Le numéro de migration se lit dans `db/migrations/` d'`origin` au moment d'écrire le fichier.** 0199 au
  2026-10-02, mais plusieurs sessions en écrivent : le dossier tranche sur ce qui est PRIS, la base sur ce qui est
  APPLIQUÉ, et le compteur du `CLAUDE.md` ne fait foi ni pour l'un ni pour l'autre.
- 🔴 **L'identifiant public du widget est opaque et immuable.** Une balise posée chez un client est une porte à
  sens unique : l'adresse devra répondre pour toujours.
- Isolation : `tenant_id = $1` sur chaque requête, la RLS étant contournée par le pooler.
- Validation : `safeParse`, jamais `parse`, jamais de `as` sur une entrée externe.
- Pas de tiret cadratin dans le code, les commentaires ni la doc.
- Réutiliser `lienWaMe(displayPhoneNumber, texte)` de `src/lib/wa-me.ts`, ne jamais refabriquer un lien `wa.me`.

---

## Lot 1 : la table et son store

**Fichiers :** une migration `db/migrations/0199_widgets.sql` (numéro à relire), `src/widgets/store.pg.ts`,
`tests/widgets-store.test.ts` (intégration).

**Interfaces :** `PgWidgetStore` expose `creer`, `parCode(code)`, `lister(tenantId)`, `modifier`, `supprimer`.
`parCode` est le seul accès SANS `tenant_id` : il en RETOURNE un, puisque le code opaque est l'autorité, comme
`getByCode` des liens tracés.

**Ce que la migration porte :** `code` unique global, `phrase` unique PAR ESPACE (index, pas contrôle en code),
`devenir` nullable borné à `agent`/`mba`/`scenario`, `agent_id` et `workflow_id` en `on delete set null`, les deux
CHECK à SENS UNIQUE (`agent_id is null or devenir = 'agent'`), l'apparence bornée, `badge`, `actif`,
`max_par_heure`.

**Tests attendus :** le CHECK refuse un `agent_id` sans `devenir = 'agent'` ; il ACCEPTE `devenir = 'agent'` avec
`agent_id` à null (état atteignable, agent supprimé) ; deux widgets d'un même espace ne peuvent pas partager une
phrase ; deux espaces le peuvent ; supprimer un scénario met `workflow_id` à null sans détruire le widget.

---

## Lot 2 : la route publique et le script

**Fichiers :** `src/http/widget-public.ts`, le montage dans `src/server.ts` (registre `modulesDeRoutes`, classe
`code-url`), `src/widgets/script.ts` (fabrique le JavaScript), `tests/widget-script.test.ts`.

**Interfaces :** `GET /widget/:code.js` rend `application/javascript`, `Cache-Control: max-age=60`.
`construireScript(config)` est un module PUR : il reçoit ce qui est déjà résolu et rend une chaîne.

**Ce que le script contient :** le numéro, la phrase, l'apparence, le badge, et l'état `servi` ou `grise`. Rien
d'autre.

**Tests attendus :** 🔴 le script ne contient AUCUN secret ni identifiant d'espace, vérifié en cherchant
`tenant_id` et les noms des variables sensibles dans la sortie ; un code inconnu rend un script inerte et JAMAIS
une 5xx (Cloudflare remplacerait le corps) ; le lien `wa.me` est bien formé à partir d'un numéro tel que Meta
l'affiche, espaces et `+` compris ; un widget `actif = false` rend un script qui n'affiche rien ; la phrase est
encodée, donc non tronquée au premier espace.

---

## Lot 3 : la source et le devenir à l'arrivée

**Fichiers :** `src/widgets/reconnaissance.ts`, le branchement dans le chemin d'entrée des messages,
`tests/widget-devenir.test.ts`.

**Interfaces :** `widgetDuMessage(tenantId, texte)` rend le widget dont la phrase est contenue dans le texte, ou
null. Elle se pose à l'ARRIVÉE, une seule fois, avant que le fil ne décide.

**Ce que le lot décide :** la source du contact est marquée ; le `devenir` du widget s'applique à cette
conversation ; `devenir = null` laisse le réglage de l'espace gouverner.

**Tests attendus :** un message sans phrase connue ne change rien au comportement d'aujourd'hui (garde de
non-régression, à vérifier dans les DEUX SENS) ; `devenir = 'agent'` avec un `agent_id` supprimé retombe sur le
réglage de l'espace au lieu d'échouer ; la décision ne se repose PAS aux messages suivants de la même
conversation ; un message de masse n'émet rien (le chemin de masse n'émet jamais, invariant du dépôt).

---

## Lot 4 : l'écran de la console

**Fichiers :** `web/app/widgets/`, les routes d'écriture côté API (`src/http/widgets.ts`, classe `tenant`), les
tests d'écran.

**Interfaces :** l'écran liste, crée, modifie, montre un APERÇU en direct et le code à copier. Les routes sont
celles que le MCP appellera : une seule vérité.

**Tests attendus :** `tests/scope-tenant.test.ts` voit le nouveau module et exige sa garde ; une écriture est
réservée aux admins (RBAC) ; le QR se génère dans le navigateur, donc aucune dépendance ajoutée à l'API.

---

## Lot 5 : les trois outils MCP

**Fichiers :** `src/mcp/outils.ts`, `tests/mcp-widgets.test.ts`.

**Interfaces :** `create_widget`, `update_widget`, `list_widgets`, qui appellent les MÊMES routes que l'écran.

**Tests attendus :** les trois outils entrent dans le catalogue et portent le droit `mcp:write` pour les deux
premiers ; un outil appelé sur un espace qui n'est pas celui de la clé est refusé.

---

## Ordre de déploiement

1. **La migration AVANT le code**, puisqu'elle crée une table que le code écrit. Image construite, `migrate`,
   puis `up -d --build`.
2. **Lots 1 à 3 déployés avant le lot 4.** 🔴 Vercel publie la console à CHAQUE push, l'API attend son
   `up --build` : un écran poussé avant sa route appelle une route que la production n'a pas, et le client voit
   une page cassée pendant toute la fenêtre. C'est arrivé le 2026-09-21 avec l'onglet « Outils », en 404 pendant
   plus d'une heure.
3. **`gh run list` lu AVANT le déploiement**, job par job sur `gh run view <id> --json jobs` : les tests
   d'intégration ne tournent qu'en CI, et `gh run watch --exit-status` a déjà rendu 0 sur un run en échec.
4. **Contrôle public après le `up --build`** : les deux portes depuis l'extérieur. Le 502 de NPM tenant une
   ancienne IP est revenu plusieurs fois, et `nginx -s reload` le corrige.

## Ce qui clôt la feature

🔴 **Aucun test vert ne la clôt.** La balise posée sur un vrai site, un message envoyé depuis un vrai téléphone,
la conversation qui arrive marquée de la bonne source, et le devenir du widget qui prend effectivement la main.
Puis le même essai avec le numéro délié, pour voir la bulle grisée.

## Questions à trancher avant le lot 1

- [ ] Le texte exact de la bulle grisée, et s'il est traduit.
- [ ] Une limite au nombre de widgets par espace, et laquelle.
- [ ] Supprimer un scénario utilisé par un widget : refus en 409, ou widget rendu inerte ?
