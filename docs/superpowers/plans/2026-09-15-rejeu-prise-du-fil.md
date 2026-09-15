# Sortir le rejeu de prise du fil de la fermeture où il est enfermé

**15 septembre 2026.** Un lot, et il établit un patron pour onze autres.

## Le constat, mesuré

`src/workflow/wiring.ts` fait **933 lignes**, retourne **13 choses**, définit **12 fonctions internes**, a
**deux appelants** (`src/index.ts`, `src/worker.ts`) et **zéro test ne l'importe**. Pendant ce temps,
**17 fichiers de tests** montent `WorkflowExecutor`, l'exécuteur que ce module câble.

C'est le motif exact que ce dépôt paie le plus souvent : **le moteur pur est testé dix-sept fois, le câblage
qui l'appelle ne l'est jamais**, et trois bugs de production connus sont nés là (le 131008 du 2 septembre,
`reclaimControl` qui ne prévenait pas Meta le 14, l'opt-out qui « couvrait les trois » et n'en couvrait que
deux).

La cause n'est pas la taille. C'est que ce fichier est **à la fois un câblage et le domicile d'une douzaine de
comportements qui n'ont nulle part où vivre**. Une fonction dans une fermeture n'a pas d'interface : personne
ne peut l'appeler, donc personne ne peut l'exercer.

## Ce que ce lot sort, et pourquoi celui-là

`prendreLeFilAvecUnRejeu` (`wiring.ts:331`). Il gouverne un comportement face à Meta : **un rejeu et jamais
deux**, la classification de l'erreur (`MetaApiError.retryable`), et l'attente qui suit (`Retry-After` de Meta
quand il le donne, sinon 500 ms, **plafonné à 2 s** parce qu'on est dans la boucle d'envoi d'une campagne et
qu'une attente longue retarde tous les destinataires suivants).

Aujourd'hui, **aucune de ces quatre règles n'est vérifiable**. Et il n'a besoin d'aucun `Pool` : ses vraies
dépendances sont une fonction « prendre le fil » et une horloge.

**Il va dans `src/inbox/controle-du-fil.ts`, qui existe déjà et pour exactement cette raison.** Ce module a
été créé le 2026-09-10 parce qu'un geste piégé dans la fermeture de `buildWorkflowRuntime` était inatteignable
depuis l'API : le bouton « Reprendre la main » de l'Inbox écrivait notre état local pendant que Meta
continuait de croire que nous tenions le fil. Le rejeu rejoint le geste qu'il rejoue ; il n'y a pas de concept
neuf à inventer.

## Méthode de livraison

**Implémenteur, avec revue humaine sur le DIFF.** Un seul lot, un seul fichier de comportement touché.

Ce choix est fait **parce que** la production emprunte ce chemin (toute reprise de parole d'un scénario ou
d'une campagne y passe quand l'agent de Meta est actif) et qu'une erreur y est invisible : un rejeu de trop
insiste auprès de Meta, un rejeu de moins abandonne un fil que le client croit repris. `feature-loop` est
écarté pour la même raison qu'aux trois lots précédents : ses critères seraient testables, mais sa porte est
la complétude, pas le rayon de souffle.

🔴 **L'essai réel qui clôt ce lot**, en deux moitiés, parce que la première seule reproduirait le défaut que
ce dépôt paie en boucle (« une capacité câblée sur un consommateur sur trois ») :

1. le module extrait est **exercé** : un rejeu et jamais deux, un refus rejouable qui rejoue, un refus non
   rejouable qui ne rejoue pas, et l'attente qui vaut le `Retry-After` de Meta plafonné à 2 s. Chaque cas
   vérifié **dans les deux sens** par mutation ;
2. **le câblage réel l'appelle, et c'est vrai PAR CONSTRUCTION, pas par un grep.** Mesuré avant d'écrire :
   `takeThreadChezMeta` n'a qu'un seul usage dans `wiring.ts`, à l'intérieur du rejeu. Le câblage ne
   construira donc plus que la version qui rejoue, et la prise sans rejeu ne sera même plus dans sa portée.
   Il n'y a plus rien à recopier de travers.

## Ce que ce lot ne change PAS

- **Aucun comportement.** C'est une extraction. Le code déplacé est le même, aux dépendances injectées près.
- **Les onze autres fonctions restent où elles sont.** Ce lot établit le patron ; les appliquer douze fois
  d'un coup ferait un gros diff sur un fichier central du chemin d'envoi, sans rien pour valider le patron
  avant de le répéter. ⚠️ Et une autre session édite ce dépôt en continu : un lot étroit se rebase, un gros
  lot entre en conflit.
- **Le `pool` reste dans `WorkflowRuntimeDeps`.** L'injecter à sa place était l'autre forme possible, écartée
  avec Julien : `buildRcsStack` prend aussi le `pool`, donc le sortir obligerait soit à dupliquer sa
  construction chez les deux appelants (ce que ce module existe précisément pour éviter), soit à s'arrêter à
  mi-chemin. Si l'extraction des comportements réussit, le résidu ne portera plus de logique et l'injection
  n'aura plus d'objet.

## Deux choses relevées en lisant, à ne pas corriger en silence

🔴 **Le rejeu JETTE la valeur de retour de `prendreLeFil`.** Celle-ci rend `false` quand aucun numéro n'est
connecté, or la boucle fait `await takeThreadChezMeta(...); return true;`. Un espace qui aurait MBA activé
sans numéro obtiendrait donc « on tient le fil ». Le résultat final se trouve être JUSTE (sans numéro, il n'y
a aucun agent Meta à qui prendre quoi que ce soit, donc écrire notre état local est correct), mais il est
juste **par accident**. L'extraction ne change pas le comportement ; elle NOMME ce contrat dans le module :
`true` signifie « Meta n'a pas protesté », ce qui couvre « il nous l'a rendu » et « il n'y avait rien à
prendre ».

⚠️ **Le bouton de l'Inbox ne rejoue pas.** `src/index.ts:394` construit `prendreLeFilAuMba` avec la prise
NUE. L'asymétrie est défendable (un humain qui clique voit l'échec et reclique ; le worker, lui, est dans une
boucle que personne ne regarde), mais elle n'est écrite nulle part. Après ce lot elle devient un CHOIX
visible, puisque la version qui rejoue sera juste à côté. Elle n'est pas modifiée ici.

## Rayon de souffle

- `creerPrendreLeFil` garde ses deux appelants (`index.ts` pour l'Inbox, `wiring.ts` via le rejeu) : aucune
  signature existante ne change.
- `reprendreLeFilPourLApp` et `reclaimControl` consomment le booléen du rejeu : son contrat doit rester
  identique, y compris le cas « aucun numéro » décrit plus haut.
- Textes à relire : le docblock de `reprendreLeFilPourLApp`, qui compte ses consommateurs, et l'en-tête de
  `controle-du-fil.ts`, qui explique pourquoi le module existe et gagne un troisième geste.
