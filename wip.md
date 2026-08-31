# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique et ses gotchas dans [documentation.md](documentation.md) (section
> « Journal des lots livrés »), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **Vidé le 2026-08-29** : il faisait 1341 lignes et remontait à juillet. Trente-huit sections de lots
> déployés ont été déplacées dans `documentation.md`. Si ce fichier dépasse une centaine de lignes, c’est
> qu’on a recommencé à s’en servir comme d’une archive.

## 2026-08-29 : deux correctifs demandes par Julien apres essai

### 1. Le bloc Question : des sorties qu on voyait mais qu on ne pouvait pas relier

Symptome : « certains boutons de reponses restent rouge et je ne peux pas les relier [...] puis je vais dans
l inbox et je reviens et la je peux les relier ».

🔴 **Cause racine, lue dans `@xyflow/system` 0.0.79 et confirmee par un test qui echoue sans le correctif.**
React Flow garde les positions des poignees EN CACHE (`node.internals.handleBounds`) et ne les remesure que si
la taille EXTERIEURE du bloc change, ou sur ordre (`updateNodeInternals`). Or `onPointerDown` commence par
resoudre la poignee de depart DANS CE CACHE, et sort en silence si elle n y est pas : le point se voit, se
survole, et le glisser ne commence jamais. Passer par l inbox remontait le composant, donc vidait le cache.

Ce qui rendait le cache faux : `handleSig`, une signature ECRITE A LA MAIN censee reproduire le JSX. Elle
avait deja derive a deux endroits. Une ligne de menu au libelle VIDE compte dans `rows` mais ne dessine
aucune poignee ; taper son libelle en ajoute une sans changer la signature ni la hauteur du bloc. Idem pour un
bouton qui passe de « lien » a « reponse rapide ». Dans les deux cas la poignee naissait morte.

**Le correctif ne repare pas les deux cas, il supprime la classe entiere** : la signature est desormais lue
dans le DOM (les poignees reellement presentes, dans leur ordre), c est-a-dire la MEME chose que React Flow
mesure. La derive devient impossible par construction, et ce qu on ajoutera plus tard est couvert d avance.

Test : `web/e2e/workflow-sorties-multiples.spec.ts`, « une reponse AJOUTEE A L INSTANT se relie ». Verifie dans
les deux sens (echec sans le correctif, 6/6 avec).

### 2. L assistant de construction : il comblait les blancs au lieu de demander

🔴 **La cause etait dans NOS mots, pas dans le modele.** Le mandat ordonnait « deduis-les de ce qu il raconte
plutot que de les lui demander », et le schema exigeait une clause « quand ne pas l appeler » JAMAIS VIDE. Les
propositions absurdes relevees par Julien etaient l obeissance a ces deux consignes : « quand le client semble
pret a prendre rendez-vous, envoyer un bloc de votre scenario » (personne n avait dit scenario plutot qu
outil), et « ne pas l appeler si le client pose encore des questions » (or repondre est le travail de l agent).

Quatre changements :
- **Entretien d abord.** Six points a couvrir (`src/agent/setup/couverture.ts`), donnes au modele comme ordre
  du jour. Tant qu il en manque un, la route RETIENT le diff : on discute avant d afficher ce qu il a compris.
- **Deux verrous, pas un.** La couverture est declaree par le modele, donc un modele presse l annoncerait
  complete des la premiere phrase. Second verrou mecanique : deux messages du client au minimum.
- **La clause negative n est plus obligatoire.** Elle ne se remplit que si le client a nomme un cas.
- **Chaque regle se garde, se corrige ou se jette separement** (`restreindreProposition`). Une ligne jetee
  REECRIT la valeur actuelle : les deux textes d un outil partent dans le meme enregistrement, l omettre lui
  ferait prendre la valeur proposee, celle-la meme qu on vient de refuser. C est le piege de cette feature.

⚠️ **Reste ouvert, a l arbitrage de Julien** : il proposait aussi une liste deroulante d actions (scenario /
appel API / appel MCP) SUR la regle affichee. Ce n est pas une modification de la ligne mais un changement de
sa cle (`outil.<handler>.description`), donc une autre ligne : la bonne place est la QUESTION de l assistant,
avec les choix tires du catalogue reel. Non fait dans ce lot.

Aucune migration. La route de setup n ecrit toujours rien.

## 2026-08-31 : R1 et R13 de l'audit, faits et commités, EN ATTENTE DE DÉPLOIEMENT

Le fond, les gotchas et la vérification dans les deux sens sont dans
[documentation.md](documentation.md) §Journal des lots livrés. Ce qui reste ici, c'est la seule chose à faire :
**déployer** (aucune migration ; `web/` change, donc l'image web doit être rebâtie). Ce qui reste ouvert de R1
est passé dans [todo.md](todo.md) sous R1-bis.

## EN COURS : le bloc agent IA (lots L0 et L1)

Le plan, l etat tache par tache et le **registre des dettes** vivent dans
[AGENT-IA-PLAN-L0-L1.md](AGENT-IA-PLAN-L0-L1.md). **D1, D2, D3, D4 et D6 sont fermees**. Reste **D5** (les
blocs agent invisibles d Analytics).
