# Recharges du crédit IA : les jaunes (2026-10-23)

**But :** solder les jaunes de la relecture des recharges de 5 et 10 € (`todo.md`, section du 2026-10-22) qui
peuvent encaisser sans créditer, laisser passer un prix faux ou proposer une offre qui ne s'achète pas.

## Tâches

**1. Une offre inconnue de cette version, payée : on le sait.** Le webhook (`src/http/credit-stripe.ts`) rendait 200
en silence pour une session dont l'offre n'est pas dans `OFFRES_RECHARGE` : après un retour arrière d'image sous une
session ouverte par une version plus récente, l'argent était encaissé sans crédit, sans trace. Une session `payment`
qui porte NOS métadonnées (un `tenant_id` valide et une `offre`) avec une offre inconnue, une fois réglée (`paid` ou
`no_payment_required`), journalise `stripe_offre_inconnue` et alerte (`numero.alerter`, lien de la facture) : rien
n'est crédité, à créditer à la main ou à rembourser. Toujours 200 : rejouer n'y changerait rien, et un rejeu qui
créditerait après un crédit fait à la main paierait deux fois.
- Tests (`tests/http-credit-stripe.test.ts`) : offre inconnue réglée, 200, aucun crédit, une erreur au journal, une
  alerte qui nomme l'offre, la session et la facture ; la même non réglée, aucune alerte ; une session sans nos
  métadonnées (ou sans `tenant_id` valide) reste muette.

**2. Le prix d'une recharge doit être hors taxe.** `lirePrixStripe` (`src/stripe/client.ts`) lit `tax_behavior`
(`taxe`) ; `ouvrirPaiement` refuse en `prix_incoherent` un prix qui n'est pas `exclusive` (taxe incluse ou non
précisée : le client paierait la TVA dans le prix, et le crédit, dérivé du HT, serait trop grand). Seules les
recharges sont concernées. Mesuré en lecture seule chez Stripe le 2026-10-23 : les quatre prix configurés en
production sont `exclusive`.
- Tests : `inclusive`, `unspecified` et absent rendent 422 `prix_incoherent` sans rien créer chez Stripe ; les faux
  prix des tests de recharge deviennent `exclusive` ; `lirePrixStripe` rend `taxe`.

**3. `buy_credit` n'annonce que les offres en vente sur l'instance.** Un outil MCP peut déclarer `selonInstance(deps)`,
qui ajuste sa description et son schéma dans `tools/list` (`src/mcp/serveur.ts`) ; `buy_credit` y garde les offres
dont le prix est configuré, la plus petite nommée pour un essai. Le catalogue statique (documentation publique, plugin)
garde les quatre. Aucune offre configurée : la description du catalogue, et l'appel refuse comme aujourd'hui.
- Tests (`tests/mcp-agent.test.ts`) : `refill_5` sans prix, la liste et l'énumération commencent à `refill_10` ; tout
  configuré, la description est celle du catalogue.

**4. Le webhook crédite une recharge de 10 €** (le cas manquant de la même relecture).

**5. `todo.md`** : la section sort.

## Ordre de déploiement

Le push (sans CI d'un pair en cours), la CI lue job par job, puis `up -d --build` de `mba-api` seul (webhook, route de
paiement et MCP y vivent). Aucune migration. Le plugin ne change pas.

## Méthode de livraison

**En direct, puis une relecture indépendante du diff en fin de lot**, parce que les tâches 1 et 2 sont sur le chemin
de l'argent (le webhook qui crédite, le contrôle qui précède un paiement) mais tiennent en quelques fichiers déjà
couverts par des tests simulant Stripe.

**L'essai réel qui clôt le lot :** Claude ouvre par `buy_credit` une recharge de 5 € sans la payer, et la page de
Stripe s'ouvre : le contrôle du prix hors taxe passe sur les vrais prix de production.
