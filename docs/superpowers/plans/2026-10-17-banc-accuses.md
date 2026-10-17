# Le banc des accusés avec de vrais messages (point P1 de l'audit du 2026-10-17)

La question : combien de numéros peuvent envoyer à plein débit en même temps (80 messages par minute chacun, le
plafond par numéro) avant que la file `webhook-status`, à concurrence 1, laisse les statuts en retard de plus de
**2 minutes** (l'objectif de Julien, au p95) ; et en combien de temps elle résorbe le retard d'une panne du worker. Le
banc du 14 octobre ne répondait pas : ses accusés désignaient des messages inexistants, qui ne mettent rien à jour.

## Méthode de livraison

**En direct, puis une relecture indépendante du diff**, parce que c'est un outil de mesure qui ne touche aucun chemin
de production, mais dont une erreur ferait mesurer du vide en silence, comme la fois précédente : la relecture
regarde d'abord que chaque accusé fasse le vrai travail. **La vérification réelle qui clôt** : le banc joué sur une
base DB-PRO2-XXS jetable et une machine PRO2-XXS jetables à Amsterdam (accord de Julien du 2026-10-17), détruites
ensuite, et ses chiffres au journal.

## Tâches

1. `scripts/banc-accuses.ts` : la fabrique d'accusés, le semis de vraies campagnes (destinataire, envoi au journal,
   message sortant), la lecture du retard dans pg-boss (`completed_on - start_after`), le WAL, le verdict d'un palier.
2. `scripts/banc-api.mts` : les épreuves `accuses` (paliers de 4 à 14 numéros, 8 minutes chacun, la file vidée puis
   lue après chaque palier) et `panne` (6 numéros, le worker arrêté 10 minutes en pleine émission).
3. `scripts/banc-api.sh` : les deux épreuves, l'arrêt puis la relance du worker, et `BANC_CA_FICHIER` pour le
   certificat d'une base jetable neuve.

## Tests attendus

- `tests/banc-accuses.test.ts` : chaque accusé fabriqué passe par les vraies fonctions de réception et de traitement
  (rangé sur `webhook-status`, message, statut, destinataire, instant et tarif lus) ; le verdict d'un palier.
- `tests/integration/banc-accuses.integration.test.ts` (CI) : le semis pose ce que trouve la vraie mise à jour de la
  livraison, et un identifiant inventé ne touche rien.

## Ordre

Poussée, CI lue job par job, puis le banc sur la machine jetable (`sudo BANC_BASE_FICHIER=... BANC_CA_FICHIER=... bash
scripts/banc-api.sh <sha> "" accuses,panne`), le rapport, le démontage chez Scaleway.
