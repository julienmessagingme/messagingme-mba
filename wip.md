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

## RIEN EN COURS

Le lot 7 (brouillon / publié des scénarios) est **livré le 2026-09-01**, dernier des sept du **programme I**,
qui est donc terminé. Son fonctionnel est dans [features.md](features.md) § Automatisations, sa technique et
ses pièges dans [documentation.md](documentation.md) § Journal des lots livrés.

**La suite est écrite** : `PLAN.md` § **LE PROGRAMME II** (arrêté le 2026-09-01), huit lots dans l'ordre, qui
prennent ce qui reste des mêmes audits (surtout les jaunes de la §7 du 25 août).

**Lots 1 et 2 livrés et déployés le 2026-09-01** (index des chemins chauds + migrations hors transaction ;
ré-entrance des balayages + rejet de webhook qui parle). Détail et mesures dans
[documentation.md](documentation.md) § Journal des lots livrés. **Prochain : lot 3** (`register*Jobs` du
worker, puis ordonnancement par contact des files entrantes).

## EN PAUSE : le bloc agent IA (lots L0 et L1)

Le plan, l’état tâche par tâche et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermées**. Reste **D5** (les
blocs agent invisibles d’Analytics).
