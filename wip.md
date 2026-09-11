# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA QUATRIÈME FOIS le 2026-09-09**, et c'est le chiffre qui compte. Trois fois, c'est que le
> problème n'est pas la négligence : **un lot terminé n'a aucune raison d'attendre ici**, il a une place
> ailleurs le jour même.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.**
>
> **Au-delà de cent lignes, ce fichier a recommencé à être une archive.**

## 🔴 LE LOT DEMANDÉ PAR JULIEN LE 2026-09-11 AU SOIR, RIEN N'EST COMMENCÉ

Écrit ici VERBATIM dans l'esprit, avant une compaction de session, parce qu'un résumé perdrait le détail qui
fait le travail. Aucun de ces points n'est instruit : ce sont ses mots remis en ordre, pas des décisions.

### A. L'écran du bot d'aide est triste

Le cadre qui s'ouvre quand on clique le bouton d'aide manque de tout. A minima : le **logo Engage Me**, deux
ou trois **étoiles « magiques »** qui disent l'IA, et un message d'accueil qui soit une invitation, **« Je
suis là pour vous aider »**, pas la consigne actuelle « Posez votre question sur la console ».

### B. 🔴 Bug : la transcription des notes vocales échoue

Dans une conversation de l'Inbox, le bouton **Transcrire** rend « La transcription a échoué, réessayez ».
⚠️ Le bouton **Écouter** fonctionne, donc le média est bien récupérable : le défaut est dans la
transcription elle-même, pas dans l'accès au fichier.

### C. L'agent IA, son setup et son bac à sable

1. **Outil « Envoyer un bloc de votre scénario » (irréversible) : le client ne peut pas choisir le bloc.**
   Ce que Julien attend : pouvoir désigner **soit un scénario** (une liste de scénarios), **soit un scénario
   PUIS un bloc à l'intérieur**. Aujourd'hui rien ne le lui demande.
2. **Outil « Terminer par une règle d'arrêt » : question de cohérence.** Son texte dit « À appeler quand la
   conversation a atteint un de ses aboutissements ». Julien demande confirmation que ces aboutissements sont
   bien ceux déclarés dans **Règles d'arrêt**, onglet Objectifs et transferts. Si oui, le dire dans le texte ;
   si non, c'est un défaut.
3. **Règles d'arrêt, thème `question_resolue` : il manque un DÉLAI MAXIMUM.** Au bout de combien de temps
   sans réaction du client cesse-t-on de relancer l'agent s'il revient ? La question doit être **posée par le
   bot de construction**, et le réglage écrit dans l'onglet correspondant.
4. **Bandeau orange fantôme.** « Aucun outil actif : l'agent peut parler mais ne peut rien faire, pas même
   terminer » persiste après activation des outils. Il a disparu après être sorti de l'agent, revenu, et avoir
   cliqué « activer » en haut à droite. Donc soit un rafraîchissement manquant, soit deux notions d'activation
   confondues.
5. 🔴 **LE PLUS IMPORTANT DU BLOC : le bac à sable doit actionner les OUTILS même quand l'agent n'est pas
   activé globalement.** Vécu : question « quel type de contrat de prévoyance vendez-vous », réponse « la base
   ne me donne pas le détail des types de contrats », alors que la base de connaissance était activée dans
   Outils et que l'information est dans les fiches issues du site. Après activation globale du bot, la même
   question a trouvé sa réponse. **Un essai qui ne prouve rien est pire qu'aucun essai** : c'est le motif que
   le cadrage nomme déjà (« un bac à sable qui ne jugerait pas comme la production ne prouverait rien »).

### D. Le MBA

1. **Allowlist de numéros pour tester gratuitement.** Regarder ce que permet
   `https://developers.facebook.com/documentation/meta-business-agent/reference/onboard/agent-allowlist`.
   ⚠️ Et lever l'ambiguïté : « tester gratuitement » veut-il dire tester **via WhatsApp** ou **via le Business
   Manager** ? Ce que Julien veut, c'est tester **dans Engage Me, dans un vrai WhatsApp**, pour revoir la
   synchronisation avec l'envoi d'un scénario, la reprise en main par un agent humain, bref tout ce qui a été
   éprouvé le 2026-09-10.
2. **Comment récupérer la consommation réelle de tokens, ou le prix, du MBA ?** Aujourd'hui on ne sait pas.
3. **Voir d'un coup d'œil, dans l'Inbox, qui tient chaque conversation.** Colorer le cadre du NOM (deuxième
   colonne) différemment quand le MBA tient le fil : bleu clair un peu flou ou dégradé, avec quelques étoiles
   ou une baguette magique dans le cadre ou juste à côté. La mention texte « agent Meta » devient alors
   inutile et disparaît.
4. 🔴 **Bug : « Reprendre la main » ne tient pas.** Après ce clic le MBA est censé être éteint, mais si le
   client écrit juste après, **il se remet en route**. Il doit rester éteint jusqu'au moment prévu (2 h par
   défaut), **même si l'agent humain n'a écrit aucun message**. ⚠️ À rapprocher du lot du 2026-09-11 sur
   `control_changed_at`, qui ne se met à jour que sur un envoi humain : c'est probablement la même racine.

### E. mini-CRM : ce qu'un contact a coûté, et ce qu'il a rapporté

Sur la fiche d'un contact, onglet **Historique**, afficher tout en haut ce que la personne a **coûté**, et en
face son nombre d'**engagements par niveau** : premier niveau (elle a réagi au premier message), deuxième,
troisième… Même esprit que le coût d'engagement par campagne de la page d'accueil du Performance Lab.

## Ce qui attend une action de Julien

- 🔴 **Activer les deux outils de l'agent « Conseiller IA Gan Prevoyance »** : `mba_chercher_connaissance`
  et `mba_escalader_humain` sont INACTIFS en base (vérifié le 2026-09-09). C'est la cause de l'essai raté du
  2026-09-08, et le changement de modèle ne la corrige pas : Haiku sait appeler des outils, mais on ne lui en
  expose aucun. Onglet Outils de la fiche. C'est une décision qui change ce que l'agent a le droit de faire
  chez un client en secteur RÉGULÉ, donc elle ne se prend pas sans lui. ⚠️ Le modèle, lui, est déjà passé sur
  `anthropic/claude-haiku-4.5` (écriture en base du 2026-09-09, vérifiée, et le modèle appelle bien l'outil).
- **Relire la phrase de passage de main du MBA** (Paramètres de l'agent Meta, « message de transfert ») :
  celle qui est en place a été posée par moi pendant les essais du 2026-09-10, sans accents et sans les mots
  de la marque. C'est la phrase que LIT le client au moment où l'agent de Meta passe la main : elle doit être
  la vôtre. ⚠️ Le même écran décide aussi si l'agent LÂCHE le fil après l'avoir annoncée : à « non », le
  client lit « un conseiller arrive » sans que personne ne soit prévenu.
- **Poser une photo de profil sur le numéro WhatsApp** : la pastille de l'Accueil n'affiche rien tant qu'il
  n'y en a pas, et aucun des deux numéros du parc n'en a (mesuré).
- **Régler les heures d'ouverture dans Paramètres** avant d'utiliser la case « heures ouvrées » d'une
  campagne ou le bloc Attente « jusqu'aux prochaines heures ouvrées » : sans aucun jour ouvert, la campagne se
  met en pause et le dit, mais ne repart pas toute seule, et le bloc Attente ne retient personne.
- 🔴 **Copier `ENCRYPTION_KEY` dans le coffre**, hors de toute infrastructure. Elle n'existe QUE dans
  `.env.prod` sur le VPS : si la machine disparaît, la base survit mais ses 8 secrets chiffrés deviennent
  illisibles pour toujours. Deux minutes, et c'est le seul point du plan RSSI qui ne demande ni code ni budget.
- **Facultatif : éteindre `mba-web`** et faire de `mba.messagingme.app/` une redirection vers `engageme`.
  Rien ne presse : le laisser tourner ne coûte presque rien et garde une porte de sortie.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3, L4, L6 et L7**. Le cadrage est écrit, rien n'est commencé. ⚠️ L2 est LIVRÉ
depuis le 2026-08-28, et il n'y a pas de L5. Détail dans [todo.md](todo.md).
