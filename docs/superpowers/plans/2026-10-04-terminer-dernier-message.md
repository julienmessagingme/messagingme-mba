# L'agent IA ne termine plus en silence : le dernier message porté par `terminer`

**Le défaut** (essai réel du lot 8a, 2026-10-04) : sous GPT-5 mini, l'agent appelle l'outil qui termine sans écrire de
texte dans la même réponse. `src/agent/brain.gateway.ts` arrête le tour sur cet appel (branche `res.sortie`) et ne garde
que le texte de cette réponse : le contact ne reçoit rien. Mesuré : 5 sorties sur 5 muettes sous GPT-5 mini, même avec
une consigne explicite dans l'objectif ; 2 sur 2 avec leur message sous Gemini 2.5 Flash. Touche tout espace qui
choisit ce modèle, console comme Claude. Choix de Julien : un champ du dernier message sur `terminer`.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, puis une relecture indépendante : le tour d'agent est un chemin que la
production emprunte (un message part, ou ne part pas, chez un vrai contact), et le code touché porte des invariants
invisibles (les outils déjà posés gardent leur copie de paramètres en base, la validation ne connaît que cette copie,
le texte d'une sortie n'est pas filtré comme une réponse). L'essai réel qui clôt est celui de l'ordre de déploiement :
les trois cas de l'essai rejoués sous GPT-5 mini dans le bac à sable.

## Ce qui change

1. **Un paramètre imposé par le catalogue, jamais stocké.** Les outils maison posés gardent en base
   (`agent_tools.params`) la copie de leurs paramètres : un paramètre ajouté au seul `params` du catalogue n'atteindrait
   ni l'agent Gan Prévoyance ni aucun agent existant. Le catalogue (`src/agent/outils-maison.ts`) gagne donc, à côté de
   `params`, un champ `paramsImposes` (ici `message` sur `terminer`), que ni `paramsInitiaux` ni le catalogue rendu à la
   console ne lisent. Une seule fonction rend les paramètres effectifs d'un outil (la copie stockée, plus les imposés que
   la copie ne déclare pas), et c'est elle que lisent l'exposition au modèle (`paramsAvecDerivations`) ET la validation
   des arguments (`src/agent/executor.ts`, étape 3). Sans la seconde, Zod retirerait `message` des arguments en silence.
2. **Annoncé requis, toléré absent.** Le schéma envoyé au modèle déclare `message` requis (c'est ce qui force un modèle
   de raisonnement à se poser la question) ; la validation l'accepte absent, `null` ou vide, sinon un modèle qui
   l'oublie verrait son `terminer` refusé et bouclerait jusqu'au plafond. Annoncer plus strict que ce qu'on applique ne
   crée aucune panne ; l'inverse en crée.
   Description, dans la langue des autres : le dernier message au contact, à écrire ici s'il n'a pas déjà été écrit
   dans cette réponse, sinon vide.
3. **Le résolveur le rend, le cerveau l'utilise en dernier recours.** `terminer` (réel, `resolvers/mba.ts`, et simulé,
   `resolvers/simulation.ts`) rend `dernierMessage` (le texte rogné, absent s'il est vide) ; `SortieResolveur` et
   `ResultatOutil` le portent. Dans `brain.gateway.ts`, à la sortie : le texte de la réponse s'il n'est pas vide
   (comportement inchangé pour Gemini), sinon `dernierMessage`, sinon `null`. Un `dernierMessage` qui imite nos
   délimiteurs (`ressembleAUnBlocOutil`) est écarté (texte `null`) sans changer la sortie.
4. **Rien d'autre ne bouge** : ni la consigne système, ni l'escalade, ni la console, ni l'agent de Meta. Aucune
   migration. Le bac à sable (`essai.ts`) montre et archive le message, puisqu'il lit `decision.texte`.

## Tests attendus (chacun vérifié dans les deux sens)

- Le schéma exposé de `terminer` porte `message` requis à côté de `sortie`, y compris pour un outil dont la copie en
  base ne le déclare pas ; `paramsInitiaux` et le catalogue de la console sont inchangés.
- L'exécuteur transmet `message` au résolveur (non retiré par Zod), et accepte un `terminer` sans `message`.
- Les deux résolveurs rendent `dernierMessage` rogné, et rien pour un message vide ou blanc.
- Le cerveau : réponse vide + `message` = ce message envoyé ; réponse écrite + `message` = la réponse ; message blanc
  = `null` ; message qui imite un bloc d'outil = `null`, sortie gardée.
- Le tour (`run-turn`) envoie ce texte avant de sortir, comme tout texte de décision.

## Ordre de déploiement

Aucune migration. L'API (bac à sable) et les workers qui jouent les tours d'agent, dans le même passage. Puis l'essai
réel qui clôt : rejouer sous GPT-5 mini les trois cas de l'essai (lead qualifié, hors cible, transfert) dans le bac à
sable, et constater que la sortie part avec son message.
