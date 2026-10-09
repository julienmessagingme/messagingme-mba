# Lot 13, domaine 5 : les contacts complets (livraison A : champs et suppression RGPD)

Spec : `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 7 (décisions prises en l'absence de Julien, à
relire ; l'import d'un fichier attend sa décision).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture : la suppression efface pour de vrai (irréversible) une fiche et tout ce qui
s'y rattache, par une clé d'API. Aucune migration ; la logique est celle de la console (création de champ, purge).
L'essai réel qui clôt la livraison : avec une clé `contacts:admin` de l'espace d'essai, créer un champ par curl, le voir
dans Contenu > Champs, écrire une fiche qui le remplit, puis effacer cette fiche et vérifier qu'elle a disparu de la
console (et de l'agent de Meta si elle y était).

## Tâches

1. **Les routes** `src/http/v1-contacts-admin.ts` : `GET /v1/fields`, `POST /v1/fields`, `DELETE /v1/contacts/{contactId}`
   sur les fonctions de la console (les gardes de `src/http/fields.ts` sorties en une fonction partagée ; la purge de
   `PgContactStore.purgeMany`, la limite `QuotaSuppressions`, le retrait chez Meta en fond). Usage `contacts.admin`, hors
   quota du jour. Tests : le droit, l'isolation (une fiche d'un autre espace est inconnue), la limite du jour tout ou
   rien, le libellé réservé, la clé existante, l'audit.
2. **Le droit** `contacts:admin` (clés, référence, parité) et les codes.
3. **La doc** : une section dans la page Contacts, les points d'entrée, les exemples validés ; `features.md`,
   `documentation.md`.

## Ordre de déploiement

Aucune migration. ⚠️ La page des clés propose `contacts:admin` dès le push : fenêtre réduite par le `up` de l'API juste
après la CI.
