# Le chiffre d'affaires attribué sans téléphone : la preuve par UTM seule

**Décision de Julien, 2026-10-30** (pendant l'essai réel du chiffre d'affaires attribué) : une vente qui arrive par notre
lien s'attribue, même quand la commande ne porte pas de numéro de téléphone. Mesuré le jour même : deux commandes payées
après un clic sur le bouton d'une campagne, passées sans numéro, ont fini en `sans_telephone`, sans rien d'attribué, alors
que la boutique d'essai, comme beaucoup, ne demande que l'e-mail.

## Ce qui change

- **Réception** (`src/shopify/attribution.ts`, `attribuerCommande`) : une commande sans téléphone, ou d'un numéro qui n'a
  pas de fiche, ne s'arrête plus. Rien ne s'écrit à la réception (l'attribution au temps exige un contact : sans lui, on ne
  sait pas à qui on a écrit), mais la relecture UTM est programmée, avec `contactId: null`. Aucune fiche n'est créée.
- **Relecture** (`src/shopify/preuve-utm.ts`) : `contactId` peut être nul. Sans contact, la vente revient à la DERNIÈRE
  CAMPAGNE de l'espace qui a envoyé le modèle nommé par les UTM, avant le paiement (`derniereCampagneDuModele`), avec la
  preuve `utm`. Seules les campagnes de masse comptent : ni les lignes Shopify (relance, confirmation, expédition), ni
  `[API]`, ni HubSpot (mêmes exclusions que les touches d'un contact), ni les messages d'un scénario ou d'un agent, qui
  supposent un contact et qu'on ne retrouverait qu'en balayant tous les fils de l'espace.
- **Écriture** (`src/shopify/ventes.pg.ts`, `appliquerPreuveUtm`) : sans contact, l'insertion ne vérifie plus la fiche
  vivante (il n'y en a pas) ; la garde de la boutique branchée avant le paiement reste.
- **Aucune migration** : `ventes_attribuees.contact_id` est déjà nullable (0261).

## Tests attendus

- La réception d'une commande sans téléphone, et d'un numéro sans fiche, programme la relecture avec `contactId: null`
  et n'écrit rien (les deux cas de `tests/shopify-traitement.test.ts` qui disaient « rien » sont gardés, leur attente
  change).
- La relecture sans contact : nos UTM et une campagne trouvée prouvent la vente (`campagne`, `utm`, sans contact) ; des
  UTM étrangers ou aucune campagne du modèle : sans preuve, rien d'écrit.
- Intégration (`tests/integration/ventes-store.integration.test.ts`) : la recherche de campagne sans contact exclut les
  lignes Shopify, `[API]` et HubSpot, et prend la plus récente avant le paiement ; l'insertion sans contact passe.
- Chaque nouveau test vérifié dans les deux sens.

## Limites connues (relecture du lot, aucun rouge)

- **Effacement** : sans contact, l'insertion n'a pas de fiche vivante à exiger. Un `customers/redact` qui anonymise la
  vente pendant les deux heures où la relecture peut encore tourner laisserait celle-ci recréer une ligne portant le
  numéro de commande, sans personne. Fenêtre quasi théorique (Shopify envoie l'effacement des jours après la demande).
- **Ventilation** : sans contact, rien ne prouve que ce client a reçu CETTE campagne ; deux campagnes du même modèle se
  départagent par leur dernier envoi avant le paiement. Le total « campagne » reste juste, la ventilation peut se tromper.
  Le lot 2 (lecture du chiffre) pourra distinguer les ventes sans contact (`contact_id` nul).
- **Coût** : aucun index `campaigns (tenant_id, template_name)`, et `max(sent_at)` parcourt les destinataires de chaque
  campagne du modèle. Négligeable aujourd'hui (mesuré : 0,5 ms sur la démo) ; à revoir si un modèle sert à de grosses
  campagnes répétées. Chaque commande sans fiche coûte aussi un appel GraphQL à Shopify, 30 minutes après.
- **Panier relancé payé sans numéro** : il perd sa preuve `panier` (le chemin sans contact sort avant). Rare, et il n'est
  alors attribué à rien, jamais à la mauvaise source.

## Ordre de déploiement

Code seul, API et workers ensemble (`deploy-scaleway.yml`, `migration=aucune`). Un job déjà en file garde son
`contactId` texte : l'ancien et le nouveau format se lisent.

## Méthode de livraison

**Implémenteur par lot, puis une relecture indépendante du diff**, parce que la production emprunte ce chemin à chaque
commande payée et qu'il fabrique un chiffre affiché au client : une erreur attribuerait une vente à la mauvaise campagne
sans qu'aucune erreur ne le signale. Les critères sont testables, mais l'invariant de vie privée (aucune fiche créée, aucun
lien recréé vers une personne effacée, voir les limites ci-dessus) demande un œil.

**Essai réel qui clôt le lot** : dans l'espace « Messaging Me demo », depuis WhatsApp, toucher « Voir la boutique » du
modèle `essai_ca_boutique`, payer une commande de test SANS numéro de téléphone ; 30 minutes plus tard, Claude lit en
lecture seule une ligne de `ventes_attribuees` source `campagne`, preuve `utm`, `contact_id` nul, sur la campagne du modèle.
