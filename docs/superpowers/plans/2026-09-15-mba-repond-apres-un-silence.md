# L'agent de Meta répond quand un client revient après un silence

**Objectif :** un message WhatsApp entrant sur une conversation dont personne ne s'occupe déclenche l'agent de
Meta, quel que soit le temps écoulé et quel que soit le canal du dernier échange.

**Demande de Julien, 2026-09-15 :** « quand un client te parle 3 mois après, il faut que ce soit le MBA qui
réponde, c'est pour ça que ça a été créé le MBA, pour répondre quand on n'a rien préparé » et « si cette
personne s'adresse à nous par WhatsApp et qu'elle nous envoie un WhatsApp 3 mois après il faut que le MBA soit
déclenché aussi ».

---

## Les deux incidents qui l'ont révélé, mesurés en production le 2026-09-15

### Incident 1 : `33685973811`, message à 15:28, personne ne répond

**La preuve.** Meta livre un message en `messages` quand NOUS tenons le fil, et en `standby` quand l'agent de
Meta le tient. Le matin même, sur `33633921577`, on a reçu des `standby` (07:58, 09:42) : l'agent avait
vraiment le fil et il répondait. À 13:28 UTC, `33685973811` est arrivé en **`messages`**.

🔴 **Meta considère donc que nous tenons ce fil, alors que notre base dit `control_owner = 'mba'` depuis
07:35:37.** Nous ne faisons rien puisqu'on croit l'avoir donné ; l'agent ne fait rien puisqu'il ne l'a pas.

**La cause.** À 07:35:37 le balayage de contrôle a rendu **dix** conversations d'un coup, toutes silencieuses
depuis **166 à 281 heures**. On ne peut pas passer la main sur un fil dont la fenêtre de 24 h est fermée
depuis une semaine : il n'y a pas de session à transmettre. Et le balayage **jette le verdict de Meta**, par
un choix assumé écrit dans `src/worker.ts` (« best-effort, un fil ne doit pas rester gelé pour toujours à
cause d'un hoquet réseau »), donc il écrit `mba` que Meta ait accepté ou non.

⚠️ **Il n'en reste AUCUNE trace** : le verdict est jeté au point d'appel et rien n'est journalisé. On ne peut
donc pas distinguer « Meta a refusé » de « Meta a accepté puis a rendu le contrôle à l'ouverture d'une
nouvelle fenêtre ». Les deux mènent au même correctif.

✅ **Le filet a tenu** : `control_owner = 'mba'` n'étant pas `app_workflow`, la conversation apparaît bien dans
« À traiter ». Le message n'est pas perdu.

### Incident 2 : `33634264992`, invisible ET muet

`control_owner = 'app_workflow'`, **`control_changed_at = null`**, deux messages sortants les 09-08 (un
template WhatsApp puis un message RCS), rien depuis.

🔴 **`listHeldControl` EXCLUT délibérément `control_changed_at is null`**, avec cette justification :
« c'est la marque d'une conversation qui n'a JAMAIS basculé, donc d'un fil que personne n'a pris. Il n'y a
rien à rendre. »

🔴 **CETTE JUSTIFICATION EST FAUSSE, et c'est le cœur de l'incident 2.** `app_workflow` est la valeur PAR
DÉFAUT de la colonne, et **envoyer un message PREND le fil implicitement chez Meta** (fait mesuré le
2026-09-15 au matin). Une conversation créée par un envoi sortant a donc `app_workflow` + `null`, alors que
nous tenons le fil pour de vrai. L'équivalence « null donc personne ne l'a pris » ne tient pas.

🔴 **ET LA CONSÉQUENCE EST PIRE QUE L'INCIDENT 1** : `A_TRAITER` exclut `app_workflow`. Si ce contact écrit,
sa conversation n'apparaît **ni** dans « À traiter », **ni** chez l'agent de Meta. Elle est invisible et
muette, sans aucun symptôme.

⚠️ **Le canal RCS n'est PAS la cause**, contrairement à ce que la chronologie suggère : le premier envoi était
un template WhatsApp, et c'est lui qui a pris le fil. Le RCS n'a fait que masquer le sujet.

---

## Les trois tâches

### Tâche 1 : le fil passe à l'agent de Meta à l'ARRIVÉE du message

🔴 **LE MOMENT EST TOUT.** L'agent de Meta ne peut prendre un fil que s'il existe une session ouverte, et
cette session s'ouvre **exactement quand le client écrit**. Une passation décidée avant, sur un fil mort, ne
peut pas fonctionner : c'est l'incident 1. Une passation décidée après l'arrivée du message fonctionne
toujours, quel que soit le temps écoulé.

**Où.** Le chemin entrant, après `processWorkflowAdvance`. La machinerie existe déjà : `rendreLaMainAMba` dans
`src/workflow/executor.ts` porte déjà la garde « aucun appel Meta si l'agent n'est pas allumé », et
`rendreLeFilMaintenant` (Meta d'abord, puis l'écriture) est déjà exporté par `buildWorkflowRuntime`.

**Les conditions, et chacune est un refus si elle manque :**

- le message arrive en `messages` et non en `standby` (en `standby`, l'agent a déjà le fil, il n'y a rien à
  faire) ;
- l'agent de Meta est allumé pour cet espace ;
- 🔴 **aucun parcours vivant n'attend la réponse de ce contact.** Un scénario qui pose une question doit
  recevoir sa réponse ; le lui voler serait un défaut bien pire que celui qu'on répare ;
- 🔴 **aucun humain ne tient la conversation.** Un opérateur qui travaille dans l'Inbox ne doit pas se faire
  doubler par l'agent au milieu d'un échange. C'est exactement ce que `CONTROL_HUMAN_TIMEOUT_MS` borne déjà.

### Tâche 2 : le balayage cesse d'écrire un état que Meta n'a pas confirmé sur une fenêtre fermée

Un `release` hors fenêtre ne transmet rien. Écrire `mba` derrière est un mensonge qui coûte deux fois : il
fait croire que quelqu'un s'en occupe, et il masque la vraie question.

⚠️ **L'état de repli doit garder la conversation VISIBLE.** `app_workflow` est la seule valeur exclue de
« À traiter » : y retomber rendrait la conversation invisible, c'est-à-dire échanger un défaut contre un pire.

⚠️ **Le verdict cesse d'être jeté en silence.** Le « best-effort » reste (un fil ne doit pas geler pour un
hoquet réseau), mais un échec laisse désormais une trace lisible, faute de quoi le prochain diagnostic
repartira de zéro comme celui-ci.

### Tâche 3 : `control_changed_at is null` cesse d'être un angle mort

La justification de `listHeldControl` est fausse (voir incident 2) et doit être corrigée EN MÊME TEMPS que le
code, pas seulement le code : une justification fausse se recopie.

⚠️ **Le garde-fou de volume du commentaire reste valable** : ramener TOUS les `app_workflow` saturerait le lot
de 500 avec des fils sains et affamerait les `app_human`. La correction doit donc rester bornée par l'âge, en
traitant `null` comme « au moins aussi vieux que la conversation », pas comme « toujours éligible ».

---

## Méthode de livraison

**Implémenteur par lot + revue humaine sur le DIFF.**

**Pourquoi celle-là**, contre les trois autres : les quatre questions d'arbitrage répondent toutes dans le même
sens. **(1) La production emprunte ce chemin** : c'est celui des messages entrants, le plus chaud du produit.
**(2) Ce n'est pas réversible** : si la garde « un parcours attend une réponse » est fausse, l'agent de Meta
répond à la place d'un scénario, et un message parti ne se rappelle pas. **(3) Les critères se testent**, mais
**(4) le code touché porte des invariants invisibles** : la fenêtre de 24 h, la distinction
`messages`/`standby`, le fait qu'envoyer prend le fil, et le `A_TRAITER` qui n'exclut qu'une seule valeur.
Deux « oui » en haut de la liste imposent la revue humaine.

⚠️ **Pas de feature-loop** : le critère d'acceptation qui compte (« l'agent répond, et il ne vole pas la
réponse d'un scénario ») ne se vérifie pas mécaniquement sur un faux câblage, puisque c'est précisément le
câblage qui est en cause. ⚠️ **Pas de workflow multi-agents** : trois tâches sur un seul chemin.

**Chaque tâche est un commit**, testée par MUTATION dans les deux sens, et le diff est relu par Julien avant
la suivante.

### 🔴 L'essai réel qui clôt cette feature, et aucun test ne le remplace

Un mécanisme qui n'a jamais tourné sur du vrai trafic n'est pas éprouvé, il est seulement vert. Les trois
gestes, dans cet ordre :

1. **Julien écrit depuis `33685973811`** (conversation en faux `mba`, silencieuse depuis 8 jours) :
   l'agent de Meta doit répondre. C'est l'incident 1, rejoué.
2. **Julien écrit depuis `33634264992`** (conversation en `app_workflow` + `null`, dernier envoi RCS) :
   l'agent de Meta doit répondre **aussi**. C'est l'incident 2, rejoué, et c'est la demande explicite.
3. **Un scénario qui pose une question, et on répond** : le scénario doit avancer, et l'agent de Meta doit
   rester muet. C'est la garde qui protège l'existant, et c'est celle dont l'échec coûterait le plus cher.

⚠️ La vérification se fait **dans l'Inbox ET dans la base** : `control_owner` doit valoir `mba` après 1 et 2,
et rester `app_workflow` après 3.
