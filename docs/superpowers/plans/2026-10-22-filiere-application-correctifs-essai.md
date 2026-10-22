# Filière application : les correctifs de l'essai réel du 2026-10-22

**But :** que l'agent IA réponde à chaque message d'une conversation, et que ses réponses arrivent sur tous les appareils
du client. L'essai réel du lot 1 (`2026-10-22-filiere-application-lot-1.md`) l'a montré en défaut sur les deux.

## Ce que l'essai a mesuré

1. **L'agent ne répond qu'au premier message.** Le deuxième message d'une conversation est enregistré (job
   `application-entrant` terminé), mais aucun tour d'agent n'est créé : le parcours de l'agent reste « en attente ». La
   réception de Meta fait avancer les parcours en attente (`processWorkflowAdvance`, `src/webhooks/handler.ts`) avant la
   remise ; la réception de la filière application l'avait omis (« ni scénarios »), alors qu'un agent qui converse EST un
   parcours en attente.
2. **Une réponse reste « En attente de ce message » sur le mobile du client**, et s'affiche sur son ordinateur. Chaque
   appareil déchiffre sa propre copie ; celui qui échoue en demande un renvoi, et Baileys ne renvoie que ce que
   `getMessage` lui rend. Le socket n'en avait pas : Baileys rend `undefined` par défaut (`Defaults/index.js`) et note
   « message not available » (`sendMessagesAgain`, `Socket/messages-recv.js`, 6.7.23). Le mobile avait ouvert une
   nouvelle session à 18 h 50 (« Closing open session in favor of incoming prekey bundle »), d'où l'échec.
3. **Les journaux du service écrivent les clés privées de Signal** : `libsignal` passe la session entière à
   `console.info` (« Closing session: », « Opening session: », « Removing old closed session: », et « Session already
   closed » à `console.warn`).

## Tâches

**1. Avancer le parcours en attente.** `traiterEntrantApplication` reçoit une dépendance requise `avance`
(`WorkflowAdvanceDeps`) et appelle `processWorkflowAdvance` après l'ingestion ; les messages qu'un parcours a reçus ne
vont pas à la remise. Le worker passe la même avance que la réception de Meta (une seule définition). Un message tapé
sur le téléphone n'avance rien : c'est une prise de main.
- Tests (`tests/application-entrant.test.ts`) : sans parcours en attente, l'ordre est fiche, enregistrement, avance,
  remise ; avec un parcours en attente, l'avance le reçoit et la remise ne le reprend pas ; un message du téléphone
  n'appelle pas l'avance.

**2. Renvoyer un message qu'un appareil n'a pas pu déchiffrer.** Le transport garde en mémoire les derniers messages
envoyés par session (les 500 derniers), et le socket reçoit `getMessage`, qui les y retrouve. Une copie perdue au
redémarrage du service n'est plus renvoyable : c'est accepté, un renvoi se demande dans les secondes qui suivent.
- Tests : un message envoyé est retrouvé par son identifiant, un identifiant inconnu rend `undefined`, le plus ancien
  sort au-delà de la borne, et `emitOwnEvents` reste à `false`.

**3. Taire les clés de Signal.** Au démarrage du service de connexions, les quatre messages de `libsignal` qui portent une
session s'écrivent sans elle.
- Test : une session factice portant `privKey` n'apparaît plus dans ce qui est écrit, et un autre message passe intact.

## Ordre de déploiement

Le push (sans CI d'un pair en cours), la CI relue job par job, puis `up -d --build` de `mba-application` et de
`mba-worker` sur le même commit. Aucune migration.

## Méthode de livraison

**Implémenteur (moi), puis une relecture indépendante du diff**, parce que c'est le chemin de chaque message reçu et
envoyé de la filière, et que le correctif 2 touche le chiffrement côté Baileys, que seul un essai réel prouve.

**L'essai réel qui clôt le lot**, sur l'espace « newCompany » : Julien écrit deux messages de suite depuis son mobile ;
l'agent répond aux deux, et les deux réponses s'affichent sur le mobile, pas seulement sur l'ordinateur. Puis il répond
lui-même depuis le téléphone du compte : l'agent se retire. Si ce dernier geste n'arrive pas en base (le service ne
déchiffre plus les messages de ce téléphone depuis 18 h 50), on relie le compte par un nouveau QR code, et l'écart part
au backlog avec sa mesure.
