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

## PROCHAIN : lot 7, brouillon / publié des scénarios

**Les quatre décisions sont prises** (Julien, 2026-09-01, détail et conséquences dans `PLAN.md` § LE
PROGRAMME) : bouton « Publier » explicite, un parcours en cours SUIT la version publiée (pas d'épinglage),
une campagne programmée prend la version live le jour de l'expédition, et la version publiée fige son
template et son association de variables.

Conséquence : le lot est bien plus petit que ce que l'audit décrivait. Pas de table de versions, pas de
colonne par run, pas de migration des runs, pas de sémantique de retour arrière. Un graphe BROUILLON et un
graphe PUBLIÉ sur le scénario, l'exécuteur lisant le publié.

**Deux refus, tranchés le 2026-09-01.** (1) Un run qui attend sur un bloc SUPPRIMÉ par la nouvelle publication
reste clos en silence : « tant pis on assume que le user tombe dans le vide ». Aucune remontée à un humain à
écrire, seulement une trace dans les journaux pour que ça se diagnostique. (2) Pas de conservation du graphe
publié précédent, donc pas de retour arrière : « on s'encombre pas de l'ancienne version ». Publier écrase.

## EN PAUSE : le bloc agent IA (lots L0 et L1)

Le plan, l’état tâche par tâche et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermées**. Reste **D5** (les
blocs agent invisibles d’Analytics).
