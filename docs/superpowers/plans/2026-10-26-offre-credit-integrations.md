# Tools > Intégrations, l'offre en deux onglets, et le Pro dit en clair : plan

**La demande de Julien (2026-10-26)** : un sous-menu « Intégrations » dans Tools, qui reprend les intégrations de
Paramètres > Général ; Paramètres > Offre en deux onglets, « Offre » et « Crédit IA », avec des recharges de 5 et 10 € ;
un lien clair vers les factures et la résiliation du Pro ; et pour le Pro, « super clair » sur le début, la fin et le
statut de l'abonnement.

**Ses choix (grill du même jour)** : les factures se LISTENT dans la console ; la résiliation se fait DANS la console ; la
Free n'a pas l'onglet Crédit IA (elle recharge par Claude, ses routes de solde restent fermées) ; le travail se fait dans
une copie à part (l'arbre partagé avait 121 commits de retard et le travail d'une autre session).

**Aujourd'hui** : les recharges de 5 et 10 € existent côté serveur et sont configurées en production (`buy_credit` les
liste), seul l'écran ne les propose pas. Le Pro n'a qu'un bouton « Gérer mon abonnement » vers le portail de Stripe. La
base sait déjà tout du Pro (`abonnements_offre` : `cree_le`, `periodicite`, `statut`, `periode_fin`, `fin_prevue_le`,
`essai_fin_le`, `fini_le`, `fin_raison`), mais la vue de l'offre n'en dit rien.

## Méthode de livraison

**En direct (Claude implémente lui-même), en deux lots, une relecture indépendante à la fin de chaque lot**, parce que
le lot A écrit chez Stripe sur un abonnement payé (la résiliation) et que le lot B déplace des écrans que des liens déjà
partis nomment : les deux ont un rayon de souffle qu'un test ne voit pas seul, mais ni l'un ni l'autre n'est un balayage
qui justifierait un workflow, et les critères ne sont pas assez mécaniques pour feature-loop (l'essentiel se juge à
l'écran). **Ordre** : le lot A se pousse et se déploie AVANT le lot B, car la console publiée par Vercel au push appellerait
sinon des routes absentes (elle tolère de toute façon leur absence). Pas de migration.

**Essai réel qui clôt** : sur un espace de test en Pro (Stripe en mode test, payeur exploitant) : la carte « Votre
abonnement » dit le bon statut et les bonnes dates ; « Résilier » programme la fin, l'écran ET Stripe disent « fin le … » ;
« Annuler la résiliation » la retire des deux côtés ; une facture de la liste s'ouvre et son PDF se télécharge ; une
recharge de 5 € passe par Stripe et revient sur l'onglet Crédit IA ; un ancien lien `/parametres#integration-shopify`
ouvre la carte Shopify dans Tools > Intégrations.

## Lot A : l'API

1. **La vue de l'offre porte l'abonnement** (`src/offres/vue.ts`, `VueOffre.abonnement`) : `statut` calculé UNE fois
   côté serveur (`termine` si fini, `en_retard`, `resiliation_programmee` si une fin est posée, `essai` si l'essai court,
   sinon `actif`), `periodicite`, `debutLe` (`cree_le`), `prochaineEcheanceLe` (`periode_fin`), `finPrevueLe`,
   `essaiFinLe`, `finiLe`, `finRaison`. `null` sans aucun Pro, vivant ou fini. Lu par une méthode dédiée du store
   (`resume`), même ordre que `deLEspace`, pour ne pas changer ce que rendent ses autres méthodes. `get_plan` le rend aussi.
2. **La résiliation** : `POST /tenants/:tenantId/offre/resiliation` `{ resilier: boolean }`, admin, plafond coûteux.
   `cancel_at_period_end` chez Stripe, sur le Pro VIVANT de l'espace seulement (409 sinon), puis la fin prévue relue dans
   la réponse de Stripe par le MÊME calcul que le webhook (`finPrevueDe`, partagé), écrite par `modifier` comme le ferait
   `customer.subscription.updated` : l'écran est juste tout de suite, le webhook réécrit la même chose ensuite.
   🔴 La clé d'idempotence est unique par demande : `fin-<abonnement>` (celle du numéro) rejouerait la première réponse
   pendant 24 h et ferait d'un « résilier, annuler, résilier » une résiliation qui ne s'applique pas.
3. **Les factures** : `GET /tenants/:tenantId/offre/factures`, admin, plafond coûteux, ouverte à la Free (module
   `offrePaiement`). Les 24 dernières factures du client Stripe de l'espace (brouillons exclus) : date, numéro, objet
   (`pro` ou `numero` par les métadonnées de l'abonnement, sinon le libellé de la première ligne, tel que la facture le
   porte), total TTC, statut (payée, à régler, impayée, annulée), adresses `https` de la page et du PDF, et `plusSurStripe`.
   Sans client Stripe : liste vide. Mode test sans payeur exploitant : 503, comme la facture d'une recharge.

**Tests attendus (A)** : le statut pour chaque état d'une ligne (dont essai + fin posée, retard + fin posée, fini) ; la
route de résiliation (admin seul, corps strict, 409 sans Pro vivant, la fin relue écrite, le refus de Stripe dit sans son
message, une clé d'idempotence différente à chaque appel) ; `finPrevueDe` rend ce que rendait le webhook (tests du webhook
inchangés et verts) ; la liste des factures (brouillon écarté, objet, statuts, une adresse non https refusée, le client
d'un autre espace jamais lu).

## Lot B : la console

4. **Tools > Intégrations** (`/integrations`, clé `integrations`, admin) : les cartes Batch, HubSpot, Salesforce et
   Shopify quittent Général. `/parametres#integration-…` renvoie vers `/integrations#integration-…` ; Général garde une
   ligne qui dit où elles sont parties. Liens internes (Accueil, Canaux et services, Salesforce, tuto) et adresse des
   e-mails Shopify (`pageParametres`) mis à jour.
5. **Offre en deux onglets** (`/offre`, `/offre?onglet=credit`) : l'écran du crédit devient un composant de l'onglet ;
   « Crédit IA » quitte le menu ; `/parametres/credit` redirige en gardant `?paiement=` (retour de Stripe, e-mails déjà
   partis). Quatre recharges, 5, 10, 50 et 100 € HT. En Free, pas d'onglet.
6. **L'onglet Offre** : la carte « Votre abonnement » en tête (statut, formule et prix HT, souscrit le, prochain
   renouvellement ou fin, essai), « Résilier mon abonnement » (confirmation datée : rien n'est remboursé, ce que devient le
   numéro fourni), « Annuler la résiliation », « Changer de carte bancaire » (portail) ; puis « Vos factures ». Sans le champ
   (API plus ancienne), l'écran reste celui d'aujourd'hui.
7. **Les textes** : `features.md`, `documentation.md`, les fiches d'aide qui nomment ces écrans (empreintes, captures,
   pages publiques régénérées et retraduites), la carte du bot (`npm run aide:carte`).

**Tests attendus (B)** : la barre (Intégrations sous Tools, plus de Crédit IA dans Paramètres) ; les e2e qui ouvraient
`/parametres` pour une intégration ou `/parametres/credit` ; la redirection des anciennes adresses ; la carte d'abonnement
pour chaque statut, la résiliation et son annulation, la liste des factures, l'absence d'onglet Crédit IA en Free.
