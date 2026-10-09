# Lot 13, domaine 4 : les webhooks sortants par l'API et par Claude

Spec : `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 6 (décisions prises en l'absence de Julien, à
relire).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture : la route expose par une clé d'API un canal par lequel des données de contacts
quittent l'espace (créer une adresse, lire le journal). Aucune migration ; toute la logique est celle de la console.
L'essai réel qui clôt le domaine : avec une clé `webhooks:write` de l'espace d'essai, créer une adresse de test par
curl, recevoir l'essai signé, lire le journal, mettre en pause puis réactiver, tourner le secret, rejouer un envoi ; et
demander à Claude de lister les adresses et de lire un journal.

## Tâches

1. **Les routes** `src/http/v1-webhooks.ts` : les dix routes de la spec, sur `src/evenements/gestion.ts` ; la
   traduction des noms (`since`, `before`, `limit`) et des vues (`WebhookV1`, `DeliveryV1`) ; les refus en codes de
   l'API ; l'audit de chaque écriture. Usage `webhooks.read` et `webhooks.write`, hors quota du jour. Tests de route :
   chaque refus, l'isolation entre espaces, le secret montré une fois, la traduction.
2. **Le droit** `webhooks:write` (clés, référence, parité des droits) et les codes neufs.
3. **Claude** : `list_webhook_endpoints` (`mcp:read`), `get_webhook_deliveries` et `replay_webhook_delivery` (réservés à
   une personne). Tests de l'outil.
4. **La doc** : une page « Gérer les webhooks » dans la doc API, les points d'entrée, les exemples validés ;
   `features.md`, `documentation.md`.

## Ordre de déploiement

Aucune migration. ⚠️ La page des clés propose `webhooks:write` dès le push : fenêtre réduite par le `up` de l'API
juste après la CI.
