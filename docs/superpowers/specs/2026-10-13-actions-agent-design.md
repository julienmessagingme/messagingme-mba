# Spec : les actions de l'agent IA vers l'application du client (2026-10-13)

## Le besoin

Le client final écrit sur WhatsApp « je veux résilier ». L'agent IA le reconnaît, recueille ce qu'il peut (numéro de
contrat, motif), le dit au client (« c'est noté, vous recevrez une confirmation par e-mail sous 48 h ») et continue la
conversation. Au même moment, l'application de notre client reçoit un webhook et fait la résiliation elle-même. Sans
application, l'action peut aussi lancer une automation dans Messaging Me (tag, e-mail à l'équipe, scénario).

## Décisions de Julien (grill du 2026-10-13)

- Une action est un OUTIL DE L'AGENT, définie dans chaque agent, 10 au plus par agent.
- Elle porte des champs typés : texte, nombre, date, e-mail, liste de valeurs. TOUS facultatifs : l'agent part avec ce
  qu'il a, l'application complète.
- Au déclenchement, l'agent dit au client, dans la conversation WhatsApp, une phrase guidée par la consigne de
  l'action, dans son ton, puis continue. Aucune confirmation demandée avant.
- Une seule fois par JOUR, par contact et par action ; chaque envoi porte un identifiant unique.
- Effets : un webhook sortant `agent.action` (signé, réessayé), une trace dans la conversation, un déclencheur
  d'automation « action déclenchée ».
- Toutes les offres, Free comprise. Réglable dans la console et depuis Claude Code.

## La conception

**L'outil.** Un outil maison neuf, handler `declencher_action`, risque `write`. Sa cible (le `binding` de
`agent_tools`, comme les champs d'`ecrire_variable`) porte le nom de l'action, sa consigne (quand l'utiliser, quoi dire
après) et ses champs (code, libellé, type, valeurs d'une liste). Les paramètres annoncés au modèle sont DÉRIVÉS de ces
champs (`avecValeursDuChamp`) : texte, date et e-mail en chaîne (format dit dans la description et vérifié par le
handler, qui rend une erreur lisible au modèle), nombre en nombre, liste en énumération. Aucun n'est requis.

**Le déclenchement**, dans le handler de production (`src/agent/resolvers/mba.ts`), sans arrêter le tour :
1. réserve la ligne `agent_actions` (tenant, outil, contact, jour dans le fuseau de l'espace) en `insert … on conflict
   do nothing` ; déjà là : il rend au modèle « déjà déclenchée aujourd'hui, dis-le au client » ;
2. émet le webhook `agent.action` sur le modèle de `conversation.needs_reply` (voie directe, pas les signaux), avec un
   identifiant d'événement dérivé de la ligne : un tour rejoué n'envoie rien deux fois ;
3. écrit l'événement de conversation `action_agent` (la frise du panneau Détail de l'Inbox) ;
4. publie l'événement d'automation `agent_action` (démarrage unitaire, permis comme `poser_tag`) ;
5. rend au modèle « action enregistrée » et la consigne de réponse : il écrit sa phrase et la conversation continue.
Le bac à sable simule, sans aucun effet.

**Le webhook `agent.action`** porte l'action (identifiant, nom), les champs recueillis, le contact (`ContactPublic`),
la conversation et l'agent. Décoché par défaut sur les adresses existantes et neuves (on s'y abonne exprès).

**Lire les actions.** `get_conversation` rend les dernières actions de la conversation avec leurs champs ; l'Inbox les
montre dans la frise.

**Régler depuis Claude Code.** `set_agent_action` (créer ou modifier une action d'un agent) et `delete_agent_action`,
personne requise, toutes offres. Écart assumé à la règle « un outil à cible reste un geste d'écran » (`OUTILS_SURS`) :
c'est la décision de Julien, et la personne qui autorise Claude est un administrateur.

**Hors champ.** Attendre la réponse de l'application pour la dire au client ; les actions de l'agent de Meta ; un
point « actions » dans l'entretien de l'assistant de la console.
