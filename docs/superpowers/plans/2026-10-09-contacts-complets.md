# Lot 13, domaine 5 : les contacts complets (A : champs et suppression RGPD ; B : import et liste de refus)

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

---

## Livraison B : la recette d'import et la liste de refus (décisions de Julien du 2026-10-09, spec § 7)

### Méthode de livraison

Implémenteur par lot, puis UNE relecture du diff : la liste de refus touche les quatre insertions de fiches, dont
`upsertFromInbound`, sur le chemin de CHAQUE message entrant, et la transaction de purge ; elle porte un invariant
invisible (une entrée n'existe que tant qu'aucune fiche ne porte son identifiant). L'essai réel qui clôt la livraison :
sur l'espace d'essai, une fiche passée en STOP puis effacée (console ou API) ; la recréer par l'API, puis par un message
entrant, et la voir naître en STOP avec la date du STOP d'origine ; vérifier en base qu'une seule ligne de refus a
existé, puis qu'elle a disparu à la recréation.

### Tâches

1. **Migration 0226** `refus_effaces` : `(tenant_id, empreinte)` en clé primaire, cascade depuis `tenants`,
   `whatsapp_le` et `rcs_le` nullables (au moins un), `cree_le`. Aucun autre index.
2. **L'empreinte** `src/crm/refus-effaces.ts` : HMAC-SHA256 d'une clé dérivée d'`ENCRYPTION_KEY` (HKDF, libellé dédié),
   sur l'espace et l'identifiant (`tel:+33…`, `bsuid:…`). Tests : stable, propre à l'espace, propre au type de clé.
3. **La purge** (`purgeMany`, dans sa transaction, AVANT l'anonymisation) : une ligne par identifiant d'une fiche en
   STOP WhatsApp ou RCS, dates d'origine (`opt_out_at`, ou l'instant de la purge s'il manque ; `rcs_optout_at`).
4. **Les quatre insertions** (`upsertByPhoneReturningId`, `upsertManyByPhone`, `upsertFromInbound`, `creerFicheApi`) :
   un CTE consomme les entrées de l'identifiant ; la branche `insert` naît en STOP (statut, date, source
   `liste_de_refus`, STOP RCS) sauf si l'autorité lève un STOP et demande `opted_in` ; la branche `on conflict` garde
   la demande d'origine (jamais le statut de la liste). Un test d'inventaire compte les `insert into contacts` de
   `src/` : une cinquième insertion le fait échouer.
5. **La rétention** : le balayage du worker supprime une entrée trois ans après son STOP le plus récent.
6. **La doc** : la recette « Importer un fichier » (page Contacts de l'API, CSV en lots de 50), la page RGPD de l'API et
   la politique de confidentialité si elle décrit l'effacement, `features.md`, `documentation.md`.

### Ordre de déploiement

🔴 0226 est BLOQUANTE : le code neuf la nomme dans la purge et dans `upsertFromInbound` (chaque message entrant). Push,
CI verte, `compose build`, `migrate` (0226 seule dans l'image), PUIS `up` de l'API et des deux workers. L'ancien code
ignore la table : elle passe avant sans risque.
