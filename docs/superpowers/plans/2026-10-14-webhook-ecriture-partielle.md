# Le webhook entrant écrit le contact malgré un champ invalide (lot 2 du bilan, 2026-10-14)

Décision de Julien du 2026-10-14 : « écrire le reste ». Une seule valeur illisible faisait échouer l'appel entier du
webhook entrant (contact, champs valables et scénario perdus). L'API publique garde le refus entier.

## Méthode de livraison

**En direct, puis une relecture indépendante du diff** : la production emprunte ce chemin (chaque appel d'un outil
tiers), mais le changement tient en trois fichiers et ses critères se vérifient par des tests ; la relecture regarde
surtout la création à la main, qui partage la fonction et doit garder le refus entier, parce qu'un défaut de
câblage y ferait écrire des fiches incomplètes sans le dire.

**L'essai réel qui clôt** : un appel au webhook d'essai avec une date ambiguë dans un champ date ; le contact apparaît
dans le mini-CRM avec ses autres champs, et la réponse nomme le champ refusé.

## Tâches

1. `upsertContactsFromApi` (`src/api/contacts-upsert.ts`) : une option `champsInvalides: 'refuser' | 'ignorer'`,
   `refuser` par défaut. En `ignorer`, chaque champ se prépare seul ; un refusé rejoint `champsRefuses` (sa raison),
   les autres s'écrivent.
2. `src/http/webhook-entrant.ts` : le compte rendu à l'appelant porte `champsRefuses` et ne compte que les champs écrits.
3. `src/index.ts` : le câblage du webhook passe `ignorer` (seul appelant à le faire).

## Tests attendus

- Un champ invalide et un valable : le contact est écrit avec le valable, le refusé est nommé (`tests/api-contacts-upsert.test.ts`).
- Sans l'option, le refus reste entier (la création à la main, seul autre appelant).
- Le câblage : exactement un `champsInvalides: 'ignorer'` dans `src/index.ts`.
- La route : contact créé, scénario publié, `champsRefuses` dans la réponse (`tests/http-webhook-entrant.test.ts`).
- Chaque test vérifié dans les deux sens par mutation.

## Ordre de déploiement

Aucune migration. Push, CI lue job par job, puis la séquence habituelle de `DEPLOY.md` (l'API et le worker sur la même
image ; seule l'API sert la route, le défaut `refuser` laisse les autres appelants inchangés).
