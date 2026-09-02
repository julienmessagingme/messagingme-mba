# Plan issu du contre-audit du 2026-09-02

> Source : `AUDIT-REVERIFICATION-POST-CONTRE-AUDIT-2026-09-02.md` (audit externe de l'état `184071b`).
> **Chaque constat de ce plan a été revérifié dans le code courant le 2026-09-02**, pas repris sur parole.
> Ce qui n'y figure pas a été écarté volontairement, avec sa raison, en fin de document.

## Ce que la mesure a tranché avant toute décision

Relevé en base de production le 2026-09-02, et c'est ce qui trie tout le reste :

| Mesure | Valeur |
|---|---|
| Jobs traités sur 7 jours, toutes files | **85** (60 webhook, 13 statut, 5 analyses, 5 push, 2 runs) |
| Durée d'un webhook | moyenne **3,6 s**, pire **12,9 s** |
| Contacts en base, tous espaces | **12** |
| Plus grosse campagne jamais créée | **2 destinataires** |

Conséquence directe : **aucun problème de capacité n'existe aujourd'hui.** Les lots ci-dessous corrigent des
défauts de CORRECTION (un message en trop, un écran qui ment), jamais des défauts de débit. Tout ce que
l'audit range sous « préparer le multi-worker » est donc reporté, et la raison est écrite plus bas.

---

## Lot 1 : fermer le bail du tour d'avance

**Le défaut, revérifié.** `BAIL_AVANCE_S = 60` (`src/workflow/executor.ts:22`). Or `withRetry`
(`src/meta/http.ts`) autorise `maxRetries = 4`, donc 5 tentatives à 30 s de plafond, plus le backoff :
**154 secondes au pire pour UN SEUL envoi Meta**, et une avance peut en enchaîner plusieurs. Le bail peut donc
expirer pendant que le premier porteur travaille encore, un second prend le tour, et **les deux envoient**.

Second morceau : `setStateSiEncoreSur` filtre sur `id`, `tenant_id`, `status` et `current_node`, **jamais sur
`avance_token`**. Un porteur de bail périmé peut donc encore écrire l'état.

**Pourquoi les tests ne l'ont pas vu.** `tests/integration/avance-claim.integration.test.ts` couvre bien « un
bail expiré est repris », mais comme FONCTIONNALITÉ (un worker tué ne doit pas bloquer le parcours à vie).
C'est le même mécanisme qui produit le double envoi quand le porteur n'est pas mort mais seulement lent. Le
test valide le remède et ne voit pas la maladie.

**Le correctif :**
1. **Renouveler le bail tant que l'avance est vivante** (prolongation périodique tant que le jeton est à nous).
   C'est la seule pièce qui distingue « porteur mort » de « porteur lent ». Dimensionner le bail ne suffit
   pas : une avance peut enchaîner un nombre non borné d'envois, aucune constante n'est sûre.
2. **Clôturer l'écriture d'état par le jeton** : ajouter `avance_token = $n` au `where` de
   `setStateSiEncoreSur`, pour qu'un porteur périmé ne puisse plus écrire.
3. **Retirer le commentaire périmé** de `executor.ts:1233` (« CE QUE ÇA NE FERME PAS... c'est un lot à part »),
   qui dit aujourd'hui le contraire du code situé vingt lignes plus haut. Une affirmation périmée devient une
   seconde spécification.
4. **Corriger la formulation du `CLAUDE.md`** : « le tour est RÉSERVÉ avant tout envoi » ferme la course
   courte, pas la course longue. Le dire.

**Preuve exigée :** un test où la première avance dépasse le bail et où la seconde ne produit **aucun effet**,
plus un test où un porteur périmé voit son écriture d'état refusée. Les deux doivent échouer si on retire la
garde.

**Migration :** oui, si le renouvellement demande une colonne. À trancher en construisant. Probablement aucune :
`avance_jusqu_a` se prolonge par un `update` conditionné au jeton.

---

## Lot 2 : le défilement du fil d'inbox

**Le défaut, revérifié, et c'est une régression que j'ai introduite le 2026-09-02.** Dans
`web/app/inbox/page.tsx`, l'effet mesure « suis-je en bas ? » **APRÈS** l'ajout des messages :

```js
const enBas = !fil || fil.scrollHeight - fil.scrollTop - fil.clientHeight < 80;
```

Deux conséquences arithmétiques :
- **À l'ouverture d'une conversation longue**, `scrollTop` vaut 0 et `scrollHeight` est grand, donc `enBas` est
  FAUX : le fil **ne descend pas**, l'opérateur atterrit en haut de l'historique.
- **À l'arrivée d'un message de plus de 80 px**, le fil était en bas AVANT l'ajout mais ne l'est plus après :
  il **ne suit pas** le nouveau message.

Le commentaire qui dit « le premier rendu n'a pas encore de conteneur mesurable » est **faux** : le `div`
porteur (`ref={filRef}`, ligne 754) est rendu inconditionnellement, et un `useEffect` s'exécute après le commit
DOM, donc la ref est toujours posée.

**Le correctif :** mémoriser « était en bas » **avant** la mutation (effet de layout ou instantané en ref), et
traiter le premier chargement comme un cas explicite « descendre ».

**Preuve exigée :** un test DOM sur un fil long (ouverture -> en bas) et sur l'arrivée d'un message haut
(suivi -> en bas), qui échoue sur le code actuel.

---

## Lot 3 : un plafond serveur de taille de campagne

**Le défaut, revérifié.** `idsForFilters` (`src/crm/contact-store.pg.ts:674`) a `cap = 100_000` par défaut,
`contactIdsForTarget` matérialise ces identifiants, et le chemin sans sélection charge tous les contacts sans
plafond. Aucune constante `CAMPAIGN_MAX_RECIPIENTS` n'existe.

Ce n'est pas un chantier 100k : c'est **empêcher le serveur d'accepter par accident** ce que Julien a déjà
décidé de ne pas faire.

**Le correctif :** une constante configurable, un `count` AVANT le chargement, et un refus **422** portant le
nombre demandé et le plafond. Uniforme sur les trois chemins : cible filtrée, identifiants explicites, et
« tous les contacts ».

⚠️ **Bloqué sur une décision produit** : le chiffre. Contexte pour trancher : la base compte **12 contacts**
et la plus grosse campagne jamais créée en portait **2**.

---

## Lot 4 : une panne d'avance cesse d'être invisible

**Le défaut, revérifié.** `processWorkflowAdvance` (`src/webhooks/workflow-advance.ts`) attrape chaque
exception par message, écrit un `console.error`, et le job webhook se termine **en succès**. Une avance qui
échoue après tous les retries Meta est donc perdue : aucun retry, aucune DLQ, aucune trace consultable.

L'isolation elle-même est BONNE (une erreur sur un contact ne doit pas emporter les autres messages du même
webhook). C'est l'acquittement silencieux qui ne va pas.

**Le correctif, version minimale :** écrire l'échec dans le **journal des erreurs** livré le 2026-09-02
(`src/ops/erreurs-livraison.pg.ts`), qui existe déjà et qui est déjà à l'écran. Coût faible, l'invisibilité
tombe.

**Ce qu'on ne fait PAS maintenant :** publier l'avance comme unité durable rejouable (la recommandation
complète de l'audit). C'est la bonne cible, c'est un lot à part, et elle ne se justifie qu'avec du trafic réel.

---

## Lot 5 : retirer deux affirmations qui mentent

Aucune ligne de code produit, mais ce sont des « secondes spécifications » qui induiront en erreur la prochaine
lecture, humaine ou automatique.

1. **Le profil `equite` du banc de charge.** `docs/SLO-2026-09-01.md` le mentionne **4 fois**,
   `scripts/banc-charge.mts` le contient **0 fois**. Soit on l'écrit, soit on retire la promesse. Un document
   qui annonce ce qui n'existe pas est pire que le silence.
2. **La contradiction campagne contre contrôle humain.** `src/inbox/repondre.ts:80` écrit « une campagne ne
   l'écrasera pas », pendant que `worker.ts:518`, `worker.ts:525` et `index.ts:511` passent
   `ignoreHumanControl: true`. Le comportement est peut-être le bon (une campagne lancée par un opérateur doit
   sans doute partir), mais **il ne peut pas y avoir deux règles écrites**. Trancher, aligner le texte, et
   poser un test au niveau du câblage réel et non de l'exécuteur nu.

---

## Ce qui est ÉCARTÉ, et pourquoi

**Tout le niveau B de l'audit (préparation multi-worker)** : rendre les groupes et balayages multi-worker,
renforcer la garde des deux URLs de base, refaire le budget de connexions. Les trois constats sont **exacts**
(19 balayages récurrents, plafonds `local*` en mémoire, écouteur `LISTEN` hors budget). Ils ne coûtent
**rien** tant qu'un seul worker tourne, et ils sont conditionnés à une décision qui n'est pas prise. Les
rouvrir le jour où le second worker est décidé, pas avant.

**Les découpages du niveau D** (`CampaignCreateForm` 1716 lignes, `worker.ts` 1323, `ConversationAnalysisCard`
686). Tailles confirmées. Ce sont des items de VÉLOCITÉ, sans effet sur la capacité. Et découper `worker.ts`
ne paie que le jour où l'on choisit qui, du leader ou des répliques, porte chacun des 19 balayages : le faire
avant déplace le risque sans le réduire.

**Mesurer la charge agrégée de `phone_rate_gate`** (C3 de l'audit). Sa propre conclusion est « mesurer avant
d'optimiser » ; à 85 jobs par semaine, il n'y a rien à mesurer.

**Le drill de restauration** (C4). Le plan Supabase est **free**, donc **aucun backup et RPO = perte totale**.
C'est une décision assumée de Julien jusqu'au passage au plan payant, qui accompagnera la mise en production
client. À rouvrir à ce moment-là, et pas avant : chronométrer une restauration qui n'existe pas n'a pas de sens.

**Ce que l'audit n'a pas pu voir** : la 404 sur `/r/:code/:jeton`, trouvée le 2026-09-02 en sondant le chemin
public après déploiement. Un audit qui lit le code ne traverse pas le proxy, exactement comme les tests e2e qui
mockent le backend. À garder en tête pour les prochains audits : cette famille de défaut leur est invisible.
