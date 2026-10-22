# Les recharges de 5 et 10 €, et la Free à 100 % de commission : plan

**But :** deux offres de recharge de plus, 5 € et 10 € hors taxe, proposées par Claude seulement ; et en Free, la moitié
d'une recharge en jetons réellement consommés.

## Décisions de Julien (2026-10-22)

1. **Les prix Stripe existent** : Refill 5 € `price_1UTNJEF67GfPqM0X9utyNkVR`, Refill 10 € `price_1UTNIDF67GfPqM0Xcy3BCMU0`.
   Je les pose dans `.env.prod` (des identifiants, pas des secrets).
2. **5 et 10 € par Claude seulement** (`buy_credit`). L'écran Crédit IA de la console garde 50 et 100 €.
3. **En Free, 10 € rechargés = 5 € de jetons** : la commission de la Free passe de 50 % à 100 %. Le tarif affiché suit,
   puisqu'il lit la même commission (`commissionPour`).
4. **Pas de budget par conversation par défaut** (posée en cours de lot, quand le test de 0222 a montré qu'à 100 % la
   Free aurait coupé ses conversations environ 25 % plus tôt) : « c'est le client qui paie le crédit IA, et nous margeons
   dessus ». Un outil MCP pour en poser un viendra plus tard (`todo.md`).

## Tâches

**1. Les deux offres (serveur).** Les deux nouvelles offres s'ajoutent à `OFFRES_RECHARGE` (`refill_5`, `refill_10`,
`htCentimes` 500 et 1 000, rangées de la plus petite à la plus grande), et leurs deux prix entrent dans `src/config.ts`,
vides par défaut, dans la table des prix de `src/index.ts` (câblage partagé : annonce, commit en plomberie) et dans
`.env.example`. Le refus « offre inconnue » de `paiement.ts` se dérive de la liste au lieu de nommer deux offres. La
description de `buy_credit` liste déjà les offres depuis la liste : elle dira aussi de proposer le plus petit montant
utile pour un essai. Le crédit reste dérivé du hors taxe, et le webhook recoupe toujours `amount_subtotal`.
La console ne change pas (`web/lib/api-credit.ts`, `web/app/parametres/credit/page.tsx`). Sa route accepte les quatre
offres, puisque la validation est commune, mais son écran n'en montre que deux.
- Tests : le crédit des quatre offres vaut leur hors taxe (`tests/stripe-client.test.ts`) ; `refill_5` ouvre un paiement
  avec son prix, un prix vide rend 503, et le webhook crédite 5 € pour 500 centimes encaissés mais refuse un `refill_5`
  à 1 000 (`tests/http-credit-stripe.test.ts`) ; `buy_credit` accepte `refill_5` et sa description cite les quatre
  montants (`tests/mcp-agent.test.ts`).

**2. La Free à 100 %.** `commissionPct` de la Free passe de 50 à 100 (`src/offres/offres.ts`). Les textes qui écrivent
50 % suivent : les fiches `choisir-mon-offre` (publique, FR et EN, donc `npm run vitrine:aide`) et
`recharger-le-credit-ia` (qui dit aussi que Claude propose 5 et 10 €) ; dans `features.md`, les deux passages et les
empreintes de leurs fiches ; `documentation.md`, `CLAUDE.md`, `.env.example`. Je relis la capture de la page Offre :
si elle montre la colonne Free, `npm run aide:captures`. Les données simulées des e2e restent.
- Tests : la grille rend 100 % en Free (`tests/offres-commission.test.ts`, `tests/offres.test.ts`) ; à 100 %, un tour
  coûte exactement le double du coût brut (`tests/agent-devise.test.ts`).

**3. Le budget par conversation sans limite par défaut.** La migration 0248 porte le défaut de
`agents.budget_micro_eur` à 100 000 000 micro-euros (100 €, le maximum que la fiche accepte), et y range les agents
restés au défaut de 0222 (70 000). Une valeur plutôt qu'un nul : le code lit un nombre, rien n'y change, et l'ancien
code y survit. La fiche « Construire un agent IA » et `features.md` le disent.
- Tests : `tests/migration-0248.test.ts` (les trois instructions exactes, le défaut égal au maximum de la fiche, et le
  pire cas de 0222 à la commission la plus haute tenant cent fois dedans) ; `tests/migration-0222.test.ts` garde son
  cas, à la commission de la Base À SA DATE (50 %).

Aucune route neuve, aucune montée du plugin (la description de `buy_credit` vient du serveur).

## Ordre de déploiement

1. Les deux prix dans `.env.prod`, ajoutés sans lire les autres lignes. L'ancien code les ignore. La migration 0248 peut
   passer avant le `up` : l'ancien code lit le budget tel quel.
2. Le push, après le déploiement du lot de la marche arrière (jamais pendant sa CI) ; la CI relue job par job.
3. `up -d --build` de `mba-api` (paiement, essai, traduction) et de `mba-worker` (le débit des tours d'agent), sur
   le même commit.
4. `aide:charger` en production. La vitrine se publie au push : pendant les quelques minutes avant le `up`, elle annonce
   100 % alors que la production applique encore 50 %. C'est sans conséquence : tous les espaces Free sont des
   espaces de test.

## Méthode de livraison

**Implémenteur (moi), puis une relecture indépendante du diff à la fin du lot**, parce que c'est un chemin d'argent : un
paiement ouvert, un crédit accordé, un montant débité à chaque tour. Les critères se testent, mais une offre mal
recoupée ou une commission mal câblée coûte de l'argent réel, d'un côté ou de l'autre.

**L'essai réel qui clôt le lot**, sur l'espace Free de l'essai de la filière application :
1. Julien demande à Claude une recharge de 5 € : la page Stripe montre 5 € hors taxe, Julien paie (son geste), puis
   `get_credit` affiche 5 € de plus.
2. Un client écrit, l'agent répond : je relis en base que le débit du tour vaut le double de son coût brut.
3. Sur un espace Pro, l'écran Crédit IA de la console ne montre toujours que 50 et 100 €.

## Points d'attention de la relecture

- Deux prix intervertis (5 et 10) : le contrôle existant relit le prix chez Stripe et refuse AVANT le paiement.
- Une Entreprise négociée et le Pro ne bougent pas : seule la ligne Free change dans la grille.
- Un espace Free qui a déjà du crédit le consomme à 100 % dès le déploiement. Ce sont tous des espaces de test.
