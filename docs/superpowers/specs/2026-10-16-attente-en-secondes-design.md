# Bloc Attente en secondes (micro-délai entre deux messages)

Date : 2026-10-16. Statut : spec relue par un constructeur, à valider par Julien ; rien n'est codé.

## L'intention

Un scénario qui envoie plusieurs messages rapides d'affilée les envoie aujourd'hui sans aucune pause : le contact
reçoit trois bulles dans la même seconde, ce qui fait robot. Julien veut pouvoir poser une pause de quelques
secondes entre deux messages, pour que le scénario ait le rythme de quelqu'un qui écrit.

Le problème réglé est l'**effet humain**. L'ordre d'arrivée des médias (une image qui arrive après le texte qui la
suit) n'est pas visé : une pause l'améliore en passant, mais rien n'est construit pour le garantir.

## Ce qu'on construit

1. **Le bloc Attente existant gagne l'unité « secondes »**, de 1 à 59, en mode « après un délai ». Pas de nouveau
   bloc, pas de réglage automatique : le client pose le bloc à la main là où il veut une pause (choix de Julien).
2. **Une pause en secondes est tenue à la seconde près** (à environ une seconde), alors que le réveil actuel ne
   passe qu'une fois par minute.
3. **« En train d'écrire… » s'affiche pendant la pause** quand c'est possible (voir plus bas). Aucune case à
   cocher (mon choix).

## Ce qu'on ne construit pas

- Pas de rythme automatique calculé sur la longueur du message (écarté par Julien).
- Pas d'attente de l'accusé « envoyé » de Meta entre deux messages.
- Pas d'unité « secondes » sur l'échéance « pas de réponse » du bloc Question : l'écran ne la propose pas.
- Pas de changement aux pauses en minutes, heures, jours, date ou heures ouvrées : elles gardent le réveil actuel.

## Ce qui serait un échec même si ça marche

- **Une pause qui retient un traitement.** La file des messages entrants traite 3 messages à la fois, tous espaces
  confondus (`WEBHOOK_CONCURRENCY`) ; une pause de 5 s dans le traitement bloquerait la réception pour tous les
  clients. Les automations sont sérialisées par espace, les campagnes jouent la pause par destinataire. Aucune
  pause ne doit donc vivre dans un job : `sleep` et `setTimeout` attendus dans un traitement sont exclus.
- **Une pause annoncée à 4 s qui en dure 50.** C'est ce que donnerait le réveil actuel (balayage toutes les 60 s,
  `WORKFLOW_WAKE_SWEEP_INTERVAL_MS`).
- **Un message envoyé deux fois** parce que deux mécanismes de réveil auraient repris le même parcours.
- **Une rafale de reprises** qui partirait d'un seul coup vers Meta à la fin d'une pause posée dans une campagne
  de 10 000 destinataires.

## Comment ça marche aujourd'hui (relevé dans le code)

- Le bloc Attente rend `{status: 'sleeping', resumeInMs}` (`src/workflow/engine.ts`, `walk`). L'exécuteur écrit le
  parcours en `sleeping` avec `resume_at = now + resumeInMs` (`restToState`, `src/workflow/executor.ts`), à trois
  endroits : le démarrage (`runFrom`/`demarrer`), l'avance sur message entrant (`advance`) et la reprise (`resume`).
- Le réveil est un balayage `setInterval` du worker toutes les 60 s (`src/worker.ts`, tâche `reveil-parcours`) qui
  réclame les dus par `claimDue` (`src/workflow/run-store.pg.ts`) : un bail de 15 minutes posé en une requête
  (`resume_at = now() + 15 min`, `for update skip locked`), le parcours restant `sleeping`. C'est ce bail qui
  interdit deux reprises du même parcours.
- Le moteur n'impose aucun minimum : le « 1 minute » ne vient que de l'écran
  (`web/components/WorkflowConfigPanel.tsx`, `min={1}`, unité la plus fine les minutes). `waitDurationMs` rend 0
  (bloc traversé) pour une unité inconnue.
- L'exécuteur tourne dans le worker (réponse d'un contact, campagne, automation, réveil) ET dans l'API (lancement
  depuis l'Inbox), par le même câblage (`buildWorkflowRuntime`, `src/workflow/wiring.ts`, appelé par `src/socle.ts`).
- `workflow_runs.last_message_id` porte l'identifiant du dernier message consommé par le parcours (sert à la
  déduplication). Ce n'est pas toujours un message WhatsApp : la sortie d'un bloc agent y écrit un identifiant
  synthétique `agent:<session>:<sortie>` (`executor.ts`, `advance`), et un parcours RCS un identifiant smsmode.
- Au démarrage, seul le répondeur transmet le message déclencheur (`messageDeclencheur`, `src/workflow/lancements.ts`).
  Une automation par mot-clé ne le transporte pas (`src/automation/match.ts`, `event-job.ts`), le lancement depuis
  l'Inbox non plus.
- La reprise ne connaît pas `last_message_id` : `DueRun` (`wake-sweep.ts`) ne le porte pas, alors que `claimDue` le
  relit.
- `questionTimeoutMs` (bloc Question) partage la table `UNIT_MS` du bloc Attente.
- Tous les envois Meta passent déjà par le frein du numéro (`src/meta/factory.ts`) : le débit vers Meta est déjà
  borné, la concurrence à poser ici protège surtout le processus et le pool de connexions.
- Le produit ne marque aujourd'hui aucun message entrant comme lu chez Meta.

## Les décisions

### Le moteur : un réveil précis, le balayage en filet

Le parcours s'endort en base exactement comme aujourd'hui (`sleeping`, `resume_at` à la seconde). Ce qui change :

- **Quand une pause fait moins de 60 s, le processus qui vient d'endormir le parcours arme un minuteur local** à
  `resume_at`. À l'échéance, il **réclame CE parcours par son identifiant**, avec la même sémantique de bail que
  `claimDue` (une requête, `status = 'sleeping'`, `resume_at` échu, `for update skip locked`, bail de 15 minutes),
  puis appelle `executor.resume` comme le balayage. Une seule réclamation est autorisée à reprendre : celle qui
  obtient la ligne.
- **Le balayage existant ne change pas** et reste le filet : processus redémarré, déploiement, minuteur perdu, il
  rattrape le parcours dans la minute. Il ne peut pas doubler la reprise, puisque le minuteur et lui passent par le
  même bail.
- **Tolérance d'horloge** : l'horloge du processus et celle de Postgres peuvent différer de quelques centaines de
  millisecondes. Une réclamation par identifiant qui arrive un peu tôt trouverait `resume_at > now()` et laisserait
  le parcours au balayage, soit jusqu'à 60 s de retard. La réclamation par identifiant accepte donc une échéance
  dans les 2 secondes à venir (`resume_at <= now() + 2 s`). Le balayage garde sa condition stricte.
- **Pas de rafale** : les reprises déclenchées par minuteur passent par une file d'attente en mémoire, par
  processus, avec une concurrence bornée (de l'ordre de 4, à régler par une variable de configuration comme les
  autres concurrences). Au-delà, elles attendent leur tour en mémoire ; leur bail n'étant posé qu'au moment de la
  réclamation, un parcours qui attend trop longtemps est rattrapé par le balayage sans doublon.
- **Le minuteur est armé dans l'exécuteur**, au point unique où un état `sleeping` vient d'être écrit avec succès
  (les trois chemins ci-dessus), jamais avant l'écriture : un minuteur armé sur une écriture refusée réveillerait un
  parcours clos. La reprise elle-même ré-arme un minuteur si elle s'endort de nouveau sur une pause en secondes
  (message, Attente 4 s, message, Attente 3 s, message).
- **Pourquoi pas une file pg-boss différée** (`startAfter`) : sur une file notifiée, la notification part à
  l'insertion et non à l'échéance, donc le job attend le filet de sondage (60 s par défaut, `SONDAGE_FILET_NOTIFIE`) ;
  sur une file sondée à la seconde, c'est une lecture à vide par seconde et par boucle, l'egress que `names.ts`
  cherche à réduire. Le minuteur local ne coûte rien au repos.
- **Le cas de l'API** : un scénario lancé depuis l'Inbox s'endort dans le processus de l'API, qui arme le minuteur
  de la même façon. Si ce processus est arrêté ou gelé avant l'échéance (conteneur serverless après la bascule
  Scaleway), le balayage rattrape avec au plus une minute de retard. C'est accepté : le lancement depuis l'Inbox est
  rare, et le pire cas est l'actuel.

### L'écran

- Le panneau du bloc Attente (`web/components/WorkflowConfigPanel.tsx`) propose « secondes » en plus de minutes,
  heures, jours. En secondes, la saisie est un entier de 1 à 59 ; au-delà, l'écran invite à passer en minutes.
- Le résumé du bloc (`web/components/WorkflowNode.tsx`) et le résumé serveur (`src/workflow/node-list.ts`, lu aussi
  par les outils MCP) écrivent « attendre N s ».
- L'unité par défaut d'un nouveau bloc ne change pas (1 heure).

### « En train d'écrire… »

- Meta : `POST /{phone-number-id}/messages` avec `status: "read"`, le `message_id` d'un message REÇU et
  `typing_indicator: {type: "text"}`. L'indicateur s'éteint à notre réponse ou au bout de 25 s. Le même appel
  **marque le message comme lu** (coches bleues). Source :
  https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
- Règle (mon choix) : à l'entrée d'une pause en secondes, si le parcours est sur WhatsApp et connaît un message
  entrant WhatsApp, l'exécuteur envoie l'indicateur sur ce message, une fois, sans le renvoyer pour une pause de plus
  de 25 s. Sans message entrant (campagne, automation sur tag, lancement depuis l'Inbox), la pause reste
  silencieuse.
- Le message connu est `last_message_id`, **filtré sur la forme d'un identifiant WhatsApp** (`wamid.`) : un
  identifiant synthétique d'agent ou un identifiant RCS ne part jamais chez Meta.
- **La reprise doit le connaître** : `DueRun` et l'entrée de `resume` gagnent `lastMessageId` (déjà relu par
  `claimDue`), sinon une reprise qui se rendort sur une seconde pause ne peut pas afficher l'indicateur.
- **Le déclencheur par mot-clé transporte l'identifiant de son message** (mon choix), comme le fait déjà le
  répondeur : de l'événement d'automation jusqu'à `runFrom` (`messageDeclencheur`), où il devient `last_message_id`.
  Effet de bord voulu, identique au répondeur : une redélivrance par Meta du message déclencheur est reconnue par
  `advance` au lieu d'être prise pour une réponse. Sans ce chaînage, le cas le plus courant (un mot-clé qui lance une
  séquence) n'afficherait jamais l'indicateur.
- Best-effort : un refus de Meta est journalisé et n'arrête jamais le parcours.
- Dépendance de l'exécuteur requise (pas optionnelle), les tests passent une fausse qui ne fait rien : même règle
  que les autres dépendances du projet.
- ⚠️ **C'est la première fois que le produit marquera des messages comme lus.** Le contact verra des coches bleues
  sur le message auquel le scénario répond. **Accepté par Julien le 2026-10-17** : seul ce message est marqué lu,
  et seulement à l'entrée d'une pause en secondes.

## Contraintes

- **Un message du contact reçu pendant une pause en secondes garde le comportement actuel** (mon choix) : le
  parcours est `sleeping`, donc invisible d'`advance`, et le message suit le chemin habituel (automations,
  répondeur, Inbox). C'est déjà le cas des pauses en minutes ; la fenêtre de quelques secondes le rend rare. L'essai
  réel le vérifie (répondre « ok » pendant une pause) et, s'il coupe ou double la séquence, on en fait un lot à part.
- `WAIT_UNITS` gagne `seconds` (`src/workflow/engine.ts`, `UNIT_MS`), **pour le bloc Attente seulement** :
  `questionTimeoutMs` partage aujourd'hui `UNIT_MS`, et les secondes ne doivent pas s'ouvrir au bloc Question par
  l'API ou le MCP. Un code antérieur lit une unité inconnue comme
  « bloc traversé » : une image ancienne remise en route envoie les messages sans pause, sans erreur. Le retour
  arrière est donc sûr.
- `PAS_MIN_MS` (estimation du temps cumulé pour l'alerte de la fenêtre de 24 h, `engine.ts`) compte toute attente
  pour au moins 60 s. Une pause en secondes y reste surestimée de moins d'une minute, sans conséquence : laissé au
  constructeur de le garder ou d'utiliser la vraie durée, à condition de garder la borne qui protège des cycles.
- Ordre de déploiement : l'API et le worker AVANT la console (règle du dépôt : un écran qui propose ce que la
  production ne sait pas faire casse dès le push). Si la console part avant, un bloc en secondes est traversé sans
  pause, ce qui n'est pas grave mais n'est pas ce qu'on annonce.
- Aucune migration : `resume_at` est déjà un horodatage complet.
- `features.md` (§ « Bloc Attente », ligne « après un délai ») se met à jour avec la fiche d'aide qui la cite et son
  empreinte, dans le même commit (`tests/aide-proposer.test.ts`).

## Méthode de livraison

Implémenteur par lot puis relecture humaine du diff : le réveil des parcours est un chemin que la production
emprunte (réponses aux clients, campagnes) et il porte un invariant invisible (une seule reprise par bail).

## Les tests attendus

- Moteur : `waitDurationMs` en secondes, bornes (0, 1, 59, valeur fractionnaire, unité inconnue).
- Exécuteur : le minuteur n'est armé qu'après une écriture `sleeping` réussie, sur les trois chemins ; pas armé pour
  une pause de 60 s ou plus ; ré-armé par une reprise qui se rendort.
- Store (intégration, en CI) : la réclamation par identifiant prend un parcours dû, refuse un parcours déjà réclamé
  par le balayage (bail posé), refuse un parcours clos, accepte la tolérance de 2 s et pas au-delà.
- Concurrence : deux réclamations simultanées du même parcours, une seule reprise.
- File en mémoire : la concurrence bornée est respectée.
- Indicateur de saisie : envoyé avec le bon `message_id` sur WhatsApp, pas envoyé sans message entrant, ni en RCS,
  ni sur un identifiant synthétique d'agent ; un refus de Meta n'arrête pas le parcours ; la reprise le connaît.
- Déclencheur par mot-clé : l'identifiant du message arrive jusqu'à `last_message_id`, et sa redélivrance n'est pas
  prise pour une réponse.
- Bloc Question : une échéance en secondes reste refusée (traitée comme non configurée).
- Console : l'unité est proposée, la saisie bornée de 1 à 59, le résumé du bloc dit « s ».

## L'essai réel qui clôt la feature

Depuis le téléphone de Julien, sur un espace de test : un mot-clé déclenche « message, Attente 4 s, message,
Attente 3 s, message ». On relève les heures des trois messages reçus (écart attendu : 4 s et 3 s, à une seconde
près) et on vérifie que « en train d'écrire… » s'affiche pendant les pauses. On répond « ok » pendant une pause
pour voir ce que devient la séquence. Puis la même chose lancée depuis l'Inbox (pause silencieuse attendue), et une
campagne de quelques contacts de test.

## Laissé au constructeur

- Le nom de la méthode de réclamation par identifiant, de la variable de concurrence et de l'endroit où vit la file
  en mémoire (un petit module dans `src/workflow/`, testé seul).
- Le libellé exact de l'unité dans l'écran.
- Le comportement de `PAS_MIN_MS` (voir Contraintes).

## Décisions de Julien

- Le bloc Attente en secondes, posé à la main (pas de rythme automatique), pour l'effet humain (2026-10-16).
- Les coches bleues sont acceptées avec « en train d'écrire… » (2026-10-17).
