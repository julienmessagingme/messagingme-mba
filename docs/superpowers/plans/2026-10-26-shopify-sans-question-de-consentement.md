# La relance de panier Shopify sans la question du consentement : plan

> **Pour un agent** : un implémenteur, puis UNE relecture indépendante du diff. Les étapes se cochent (`- [ ]`).

**La décision de Julien (2026-10-26)** : à la question « La relance de panier Shopify demande encore au marchand
d'affirmer l'accord de ses clients, alors que l'import par Claude les déclare déjà consentants. On supprime cette
question ? », il répond « Oui ». C'est la suite de sa règle du 2026-10-25 : « par principe, les contacts sont opt in,
c'est la responsabilité du client, pas la nôtre ; on respecte le STOP ».

**Aujourd'hui** : la relance de panier ne s'active que si le marchand a affirmé le consentement de ses clients
(`customers_consented`, colonnes `shopify_boutiques.consentement_par` et `consentement_le`, migration 0246). Le refus
409 vit dans `brancherMessage` (`src/shopify/gestion.ts`, Claude) et dans la préparation de la console
(`src/shopify/preparation.ts`) ; `noterCheckout` (`src/shopify/traitement.ts`) ne garde un panier qu'affirmé ; `servir`
n'écrit la fiche consentante (`sourceConsentement`) qu'affirmé ; `reglerMessage` affirme ou retire ; `get_shopify_state`
rend `customers_consented_at` ; la console (`web/components/ShopifyAssistant.tsx`) et trois skills du plugin posent la
question.

## Méthode de livraison

**Implémenteur, une relecture indépendante du diff, puis déploiement**, parce que le lot touche un chemin d'ENVOI de la
production : la relance part à des clients qui n'ont rien demandé sur WhatsApp, et une garde retirée de travers
écrirait à un contact qui a dit STOP. Pas de migration (les deux colonnes restent, inutilisées). **Essai réel qui
clôt** : sur la boutique Shopify de test, Claude active la relance sans aucune question ; un panier abandonné reçoit sa
relance ; la fiche du client est consentante (source `shopify:<domaine>`) ; un client qui a dit STOP ne reçoit rien.

## Ce qui change

1. **La question disparaît partout** : ce qui dépendait de l'affirmation se comporte comme si le marchand l'avait
   donnée. `brancherMessage` et la préparation de la console n'exigent plus rien pour la relance ; `noterCheckout`
   garde le panier dès que la relance est active ; chaque envoi né d'un événement Shopify (commande, expédition,
   relance) porte `consent: opted_in`, source `shopify:<domaine>`, bornée par `MAX_OPT_IN_SOURCE` ;
   `appliquerConsentement` ne lève jamais un STOP (chemin partagé, inchangé).
2. **Ce qui ne servait qu'à la question part** : le paramètre `customers_consented` de `set_shopify_message` (le
   serveur MCP ne valide pas les arguments contre le schéma, `src/mcp/serveur.ts` : un ancien plugin qui l'enverrait
   n'est pas refusé, la valeur est ignorée), `customers_consented_at` de `get_shopify_state`, la case de la console,
   `affirmerConsentement` et `retirerConsentement` du magasin. Les routes de la console ACCEPTENT encore
   `consentementAffirme` et l'ignorent : un onglet ouvert avec l'ancien bundle ne doit pas recevoir de 400.
3. **Textes** : les skills `shopify`, `regles-whatsapp` et `mise-en-service` (montée de version de `plugin.json`,
   publication après l'API) ; la fiche d'aide « Brancher ma boutique Shopify » (FR, EN, `traduit_de`, empreinte, pages de
   la vitrine par `npm run vitrine:aide`) ; `features.md` ; `documentation.md`.

## Tests attendus

- Une relance s'active sans affirmation, par Claude comme par la console.
- Un checkout est noté dès que la relance est active, sans affirmation.
- Un envoi né d'une commande et une relance portent `consent: opted_in`, source `shopify:<domaine>`.
- Un contact en STOP reste désabonné et ne reçoit rien (le refus du chemin partagé, sur un vrai faux de l'envoi public).
- `set_shopify_message` n'annonce plus `customers_consented` ; `get_shopify_state` ne rend plus `customers_consented_at`.
- Chaque garde retirée vérifiée dans les deux sens : remettre l'exigence rougit son test.

## Déploiement

L'API (`mba-api`, `mba-worker`, puis `mba-worker-analyse`), garde de révision dans chaque commande ; la console part au
push (elle n'envoie plus le champ ; l'API d'avant l'exige encore pour la relance, d'où un déploiement de l'API juste
après le push) ; le plugin après l'API ; `aide:charger` après le push, `docs/aide` comparé à origin d'abord.
