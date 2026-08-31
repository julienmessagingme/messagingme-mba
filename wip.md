# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique et ses gotchas dans [documentation.md](documentation.md) (section
> « Journal des lots livrés »), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **Vidé le 2026-08-29** : il faisait 1341 lignes et remontait à juillet. Trente-huit sections de lots
> déployés ont été déplacées dans `documentation.md`. Si ce fichier dépasse une centaine de lignes, c’est
> qu’on a recommencé à s’en servir comme d’une archive.
>
> ⚠️ **Re-vidé le 2026-08-31**, et la leçon est la même : le lot du 29 y était resté deux jours, et la moitié
> de ce qu’il affirmait était déjà PÉRIMÉE par la refonte du 31 (« six points à couvrir », « deux verrous »,
> « la conversation n’est pas persistée »). Un lot déployé qui traîne ici ne vieillit pas, il MENT.

## EN COURS : lot 1 du programme (`PLAN.md` § LE PROGRAMME)

Quatre choses qui cassent AUJOURD'HUI, aucune migration :

- [ ] **Codes de plafond Meta.** `130429` et `131048` sont absents des deux listes de `src/meta/errors.ts`,
      donc traités par le défaut « 4xx sans code connu = terminal » : un plafond Meta ne ralentit pas la
      campagne, il fait échouer DÉFINITIVEMENT chaque destinataire restant. Les classer, et mettre la campagne
      en PAUSE plutôt que de rejouer par destinataire (c'est le numéro qui est plafonné, pas le contact).
- [ ] **Claim atomique de l'avance de scénario.** `setStateSiEncoreSur` existe, est testé, et n'a qu'UN
      appelant (le tour d'agent) ; les huit écritures de l'exécuteur passent par `setState`, un `update where
      id` nu. La course API/worker est atteignable dès aujourd'hui sur les rappels RCS.
- [ ] **Recherche de connaissance mutualisée** entre `resolvers/mba.ts` et `resolvers/simulation.ts` : logique
      identique au caractère près, erreurs déjà divergentes. C'est le garde-fou anti-hallucination.
- [ ] **Refus explicite du second numéro** (décision : un seul numéro par client). Aujourd'hui il serait
      accepté et fusionnerait des conversations en silence.

## EN PAUSE : le bloc agent IA (lots L0 et L1)

Le plan, l’état tâche par tâche et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermées**. Reste **D5** (les
blocs agent invisibles d’Analytics).
