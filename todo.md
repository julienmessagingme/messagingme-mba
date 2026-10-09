# todo.md : backlog

## 🟡 Lot 13, les webhooks par l'API : ce que la relecture du domaine 4 laisse (2026-10-09)

- **Le journal d'une adresse se pagine par la date seule** (`PgEnvoisEvenementsStore.journal`, `cree_le < before`, et
  `GET /v1/webhooks/{id}/deliveries` qui rend `nextBefore`) : les lignes d'un même job de distribution partagent le même
  `cree_le`, et `toISOString` tronque la microseconde ; une page qui coupe un tel groupe fait sauter le reste. Passer à
  un curseur `(cree_le, id)` à pleine précision, pour la console comme pour l'API.
- **`list_webhook_endpoints` a été réservé à une personne** (décision prise par Claude en l'absence de Julien) : une
  adresse d'outil sans code porte son jeton dans le chemin. À reconfirmer.

## 🟡 Lot 13, les modèles : ce que la relecture de la livraison A laisse (2026-10-09)

- **Le dépôt d'un fichier chez Meta (`uploadImage`) n'a aucun délai** : un Meta muet tient la place d'en-tête (et
  16 Mo en mémoire) jusqu'à la fin de la socket. Défaut déjà présent côté écran Modèles ; lui donner un signal.

## 🟡 Lot 13, la lecture des fils : ce que la relecture de la livraison A laisse (2026-10-08)

- **Le téléchargement d'un fichier reçu n'a pas de borne de concurrence** (`GET /v1/messages/{id}/media`, comme la
  route de l'Inbox) : chaque appel charge le fichier entier en mémoire, jusqu'à `MEDIA_ENTRANT_TAILLE_MAX_KO` (25 Mo),
  et ne compte qu'une unité. Soixante téléchargements parallèles pèsent 1,5 à 3 Go dans la copie de l'API. Le compter
  comme une opération lourde, ou poser un sémaphore par copie.
- **Le fil d'un contact bloqué se lit par Claude, pas par l'API** : `get_conversation` et `get_messages` passent par
  `getConversationContext`, sans filtre `blocked_at`. Déjà vrai en Pro, étendu au Free ; même espace, aucune fuite.
  Aligner sur l'API (et l'Inbox), ou l'écrire.
- **Une réaction envoyée par l'API ou par Claude sort le fil d'« À traiter »** (lot 13, domaine 2) : `recordOutbound`
  pose `last_direction = 'out'` et l'emoji en aperçu, alors qu'une réaction REÇUE est délibérément neutre. Un 👍 sur
  « où est ma commande ? » fait disparaître la question sans réponse. Rendre la réaction sortante neutre elle aussi.
- **Le rapport RCS pose le statut d'un message sans filtre d'espace** (livraison B) : `traiterRapportRcs` connaît
  l'espace mais `majLivraison` (`src/index.ts`) écrit par le seul identifiant de message, comme il le faisait déjà pour
  `campaign_recipients`. Smsmode ne signe pas : un code de rappel valide et l'identifiant d'un message d'un autre espace
  suffiraient à le marquer `failed`. Passer l'espace et filtrer par `conversations`.
- **Un accusé et la purge RGPD verrouillent dans l'ordre inverse** (livraison B) : l'accusé prend `campaign_recipients`
  puis `conversation_messages`, `purgeMany` l'inverse. Un accusé du contact pendant sa purge peut faire tuer l'une des
  deux transactions (40P01) : un job rejoué ou une purge à relancer, sans perte.
- **Aucune reprise des statuts d'avant le 2026-10-08** (livraison B) : un message envoyé avant garde `status: null`,
  alors que `campaign_recipients.delivery_status` connaît celui d'un modèle de campagne. Reprendre si un client le
  demande.
- **Un fil sans fiche rend un contact tout à `null`** (le premier message RCS passe `recordInbound` avant
  `upsertFromInbound`) : l'intégrateur ne sait pas qui écrit. Exposer le `wa_id` en repli.

## 🟡 Lot 12, les webhooks sortants : ce que la relecture de la livraison A laisse (2026-10-08)

- **Aucun plafond technique en Entreprise** : « sans limite » (décision de Julien) laisse un admin créer autant
  d'adresses qu'il veut, et chaque message entrant fait une ligne et un job par adresse. Un plafond dur (25 ou 50),
  invisible de l'offre, protégerait le worker partagé. À trancher avec Julien.
- **Une session OAuth d'admin dans Claude Code peut créer une adresse sur l'injection d'un message client** lu par
  `get_conversation` : `exigePersonne` écarte les clés d'API, pas cette session. Atténuation proposée : l'outil crée
  l'adresse en pause, l'admin l'active dans la console (au prix d'un clic dans le tunnel). À trancher avec Julien.
- **`conversation.analyzed` garde un identifiant aléatoire** (`signalAnalyse`), alors que la spec annonçait
  `conversation:analyzedAt` : un rejeu de la distribution renverrait l'analyse sous un autre `id`.

## 🟡 Lot 19, le tunnel de la Base : ce qui reste (2026-10-08)

- **La documentation de l'API ne se lit pas sans JavaScript.** Le prompt de `/demarrer` (et `site/llms.txt`) pointe
  `/developers/api`, dont `CadreDoc` ne rend rien avant d'avoir lu la session côté navigateur : le WebFetch de Claude
  Code n'y trouve qu'une coquille. Rendre la doc côté serveur, ou en publier une version texte, puis y pointer.
- **Revenir sur `/demarrer` recrée une clé** « Mon application » à chaque clic (la précédente, montrée une fois, reste
  active et compte dans les 10). Acceptable (le lien vers Clés d'API est donné), à reprendre si l'essai réel le montre.
- **Le prompt peut proposer de brancher un numéro déjà connecté** tant que le statut du compte n'a pas répondu.
  Sans conséquence : l'outil répond qu'il n'y a rien à brancher.

## 🟡 L'assistant du MBA et ses consignes : ce qui reste (2026-10-08)

- **Les cibles des FAQ, des sites et des fichiers entrent sans garde dans le chemin de Meta** (`src/mba/client.ts`,
  `agent_config/faq/${faqId}` et voisins). Un `..` y remonterait d'un cran, et `encodeURIComponent` ne l'encode pas.
  Les consignes et les messages interactifs sont gardés par `ID_MESSAGE_RE` à l'application. Mesurer d'abord la forme
  des identifiants de FAQ, de site et de fichier sur le numéro de test, puis étendre le garde.
- **Le modèle modifie une consigne sans en voir le texte** : l'inventaire ne lui donne que le titre et la cible, et la
  modification REMPLACE le corps. L'historique garde l'ancienne consigne (`avant`) et le schéma lui dit de demander au
  client ce qu'il garde ; lui donner le quand et un début du corps reste possible si l'usage le réclame.
- **Le quand est borné en caractères** (1 024, comme l'onglet), et Meta compte peut-être en octets, comme pour les
  messages interactifs. Non mesuré : un quand français proche de la borne serait refusé avec « Meta a refusé cette
  modification. ».

## 🟡 Messages interactifs de l'agent de Meta : ce qui reste (2026-10-08)

- **Une liste remplie par un outil ne part pas, et la cause n'est pas isolée.** Quatre essais du 2026-10-08, trois
  consignes : l'outil MCP `get_contact`, par notre relais, rend `ok`, puis l'agent écrit « Je ne peux pas vous aider
  avec cela » (mesures : `docs/MBA-API-REFERENCE.md`, table des messages interactifs). L'exemple de Meta remplit un
  carrousel par un connecteur HTTP. L'essai qui tranche : la même liste remplie par une requête HTTP de la
  bibliothèque qui rend les étiquettes. La console déconseille ce cas en attendant
  (`mba-message-contenu-avertissement`).
- **Le connecteur MCP natif de Meta** (`connector_protocol: MCP`, `refreshMCPTools`, relevé le 2026-10-07) pourrait
  remplacer notre relais pour les outils MCP. À cadrer avant tout code : ce que le relais apporte et que le natif
  perdrait (l'identité du client prise de la macro et jamais du modèle, le journal `agent_tool_calls`, la clé qui ne
  quitte pas Messaging Me, le choix outil par outil), ce que le natif accepte (`auth_type` réduit à
  `OAUTH2_CLIENT_CREDENTIALS`, `API_KEY` ou `NONE`, donc aucun serveur MCP à connexion OAuth par l'utilisateur), et
  si une macro peut remplir un paramètre d'outil MCP. C'est aussi la troisième variable de la liste ci-dessus.
- **Le diff de l'assistant montre l'identifiant brut d'un formulaire**, pas son nom (jaune de la relecture de la
  livraison B).
- **L'essai réel de clôture du lot n'est pas fini** : faits le 2026-10-08, la création, l'envoi, l'Inbox, la
  désactivation et la suppression (après le correctif `82b82b94` de la borne des paramètres d'URL) ; restent le
  formulaire et sa réponse sur la fiche, l'assistant et sa ligne d'Historique, et le refus de supprimer un
  formulaire utilisé.

## 🟡 RC8, supprimer un espace depuis /ops : ce qui reste (2026-10-07)

- **Une clé Vercel déjà disparue chez Vercel rend l'espace insupprimable** : `supprimerCleGateway` ne tient que 2xx
  pour une confirmation, donc un 404 (clé supprimée à la main, ou Vercel a confirmé puis `oublier` a échoué) fait
  échouer l'étape `cle_vercel` à chaque essai. Vérifier ce que Vercel rend, puis tenir 404 pour confirmé.
- **Le verrou part avant toute certitude d'aller au bout** : si la clé Vercel échoue (ou si Vercel n'est pas configuré
  sur l'instance, cas que le bilan connaît), l'espace reste verrouillé, donc coupé de la console. Refuser (409) avant
  le verrou dans le cas `impossible`, et dire dans la réponse « l'espace reste verrouillé ».
- **Le bail de 10 minutes** du verrou de suppression peut expirer pendant un `toutRetirer` long (un appel Meta par
  contact de la liste), et Cloudflare coupe la réponse vers 100 s côté navigateur sans arrêter le serveur.
- **Fenêtre de coût** : entre la révocation de la clé et la purge (la durée des étapes chez Meta), le worker fait
  retomber les tours d'agent de l'espace sur notre clé maison. Le verrou n'arrête pas le worker.
- **Un compte dont le jeton ne se déchiffre pas rend l'espace insupprimable** depuis l'écran : `contexte` relance toute
  erreur autre que `TokenInvalidError`, et le bilan comme la suppression rendent 422.
- **Restes sans clé** : `salesforce.orgs` reste rattachée à un espace disparu si son étape échoue (inoffensif, rien
  ne le rattrape) ; `mmhs.conversations` n'est jamais purgée (à faire côté connecteur, dans `/service/unlink`). Un
  abonné « en attente de numéro » qui reçoit un numéro entre l'étape `numero_fourni` et la purge le perd en `bloque`.
- **La trace** (`espaces_supprimes.etapes`) peut porter jusqu'à 300 caractères de message d'erreur d'un tiers, alors
  que la migration promet « aucune donnée client » : à vérifier sur la première vraie suppression.
- **`DELETE /{waba}/subscribed_apps`** (le désabonnement du compte WhatsApp de notre app) n'a jamais été essayé chez
  Meta : à constater à l'essai réel.

## 🟡 RC7, un champ du contact dans le lien d'un bouton : ce qui reste (2026-10-07)

- **À faire par Julien, une fois RC7 en ligne : rééditer le modèle `lancement_napo_date_finale`** (espace de démo) dans
  la console, sans rien changer. L'ancienne modification a remplacé chez Meta notre lien tracé par l'adresse brute
  (`momrestaurant.fr/reservation/`) alors que `tracked_links` le dit toujours tracé à jeton : campagnes et scénarios
  l'envoient avec un composant de bouton en trop, et l'Inbox, qui marchait par hasard faute de composant, fera de même.
  La nouvelle modification le retrace (même code, clics gardés). Mesuré le 2026-10-07 par le vrai code : le seul écart
  sur les 18 liens confirmés. Le déconfirmer en base réglerait l'envoi mais cacherait ses clics passés des mesures.
- **Vie privée** : avec `{telephone}` ou `{nom}`, un message transféré mène un tiers vers une adresse remplie avec les
  données du contact d'origine. Une phrase dans la fiche d'aide des modèles, et dans le commentaire de
  `src/links/jeton-contact.ts` (« ne doit jamais servir d'authentification »).
- **`codeDuLienTrace` accepte n'importe quel hôte** : une destination client de la forme `https://go.client.fr/r/<12
  caractères>` n'est plus tracée (partie brute, sans mesure). À restreindre à nos hôtes (actuels et anciens).
- **Langue ignorée à l'envoi** : `suffixesPourUnEnvoi` (et `worker.ts`, la campagne) lit les liens par nom seul, quand
  `soumettreAvecLiens` raisonne par nom ET langue. Deux langues d'un même nom aux boutons différents recevraient un
  composant en trop ou en moins. L'Inbox a la langue sous la main.
- **Fenêtre pendant une modification** : `allocate` déconfirme avant l'appel à Meta, `confirm` ne passe qu'après ; un
  envoi de ce modèle pendant l'appel part sans composant. Et `tracked_links` décrit la nouvelle version dès la
  soumission, ce qui suppose que Meta bloque les envois pendant la revue d'une modification : à constater à l'essai réel
  (modifier un modèle approuvé à lien, puis envoyer pendant le PENDING).
- **Accolades d'avant** : un modèle dont l'URL porte des accolades que la règle refuse (`{a-b}`, orpheline) ne se
  modifie plus sans réécrire l'URL. Aucun en base (0 destination à accolade sur 22, mesuré le 2026-10-07).
- **`refusDesChamps`** lit les champs déclarés dès qu'une accolade apparaît, `{{1}}` seul compris : une panne de cette
  lecture rend alors 422 sans raison pour ce cas.
- **La console ne propose pas tous les champs que le serveur accepte** (un champ déclaré hors « Mes champs », comme
  `email`), et une clé inconnue tapée à la main n'est refusée qu'au serveur.


## 🟡 Lot 6 : ce que les livraisons A et B1 laissent pour plus tard (2026-10-07)

- **Un abonnement Pro rebasculé sur un autre prix au portail resterait Pro** : la configuration du portail ne doit
  lister que le produit Pro (geste de Julien) ; côté code, alerter si `items.data[].price.id` n'est ni
  `STRIPE_PRIX_PRO_MOIS` ni `_AN`. Et `/ops` qui passe en Entreprise un espace au Pro vivant devrait le dire (Stripe
  continue de facturer).
- **La course de la suggestion d'adresse n'est pas fermée** (`web/components/AgentConnaissance.tsx`, e2e
  `agents-connaissance.spec.ts` « une adresse déjà saisie n'est JAMAIS écrasée ») : la CI front de `d8cf836d` est
  tombée dessus au passage et à sa nouvelle tentative, puis est passée à la relance ; la mesure locale donne 1 échec sur 40 (4 sur 40 le 2026-09-22, avant la garde du
  focus). La saisie se colle DERRIÈRE la suggestion. Code et test identiques depuis `4220dc42`, vert : défaut antérieur,
  à corriger dans le composant, jamais en affaiblissant le test.
- 🔴 **Julien : restreindre chaque code promo Stripe à ses produits** (décidé le 2026-10-07 : le code reste ouvert
  aux codes, sur la recharge comme sur le Pro). Le compte Stripe est partagé avec d'autres activités, et la recharge
  crédite le montant AVANT remise : un code sans restriction de produit donne du crédit gratuit, et le Pro gratuit.
  À faire avant de poser les prix du Pro : désactiver ENGAGE100 (nommé dans le dépôt public), recréer GMC100 et
  VERIF100 restreints aux produits de leurs activités, et le code de l'essai réel restreint au seul produit Pro, une
  utilisation. Règle durable : tout code créé sur ce compte porte une restriction de produit.

- **En Base, trois écrans ouverts lisent encore une fonction fermée, en silence** (inventaire du 2026-10-07) : la
  création de campagne laisse vides ses sélecteurs e-mail et RCS, la fiche d'un agent ne lit pas ses suggestions de
  site, et « Connecter HubSpot » ouvre une alerte générique (plus l'avis du refus). Rien ne casse ; à reprendre avec
  le tunnel de la Base (lot 19), en masquant ces choix quand l'offre les ferme.
- **La phrase d'un refus d'offre est en français**, comme toutes les phrases du serveur : la console en anglais
  l'affiche telle quelle (limite connue, la même que les autres erreurs).
- **Le gel au retour en Base ne met pas en pause les adresses de webhook au-delà de la première** (spec § 7) : c'est
  le lot des webhooks sortants. Et la conservation à 30 jours qui ne s'applique qu'un mois après le retour en Base
  vient avec la livraison C.
- **La console ne montre pas qu'une automation est en pause par l'offre** : en Base, celles au-delà des 10 plus
  anciennes restent « allumées » à l'écran et ne tirent pas (le journal le dit). À ajouter au tunnel de la Base (lot 19).

## 🟡 RC6, qui répond au client : ce qui reste (2026-10-07)

- **À relire par Julien : allumer le MBA en mode « Équipe » le fait passer en mode « MBA »** (règle par défaut du plan,
  continuité avec avant). Elle s'applique aussi quand « Équipe » était un choix délibéré avec le MBA allumé pour le seul
  bloc « Envoyer au MBA » : un cycle éteindre / rallumer de l'Aperçu ou de l'assistant suffit à basculer le mode.
- **En veille, le MBA perd le contact au premier appel d'un de ses outils d'envoi** (bloc, scénario) : le lancement le
  retire de sa liste et la fin du parcours ne le lui rend pas (`rendreLaMainAMba` est gardé par le mode), alors que le
  chemin d'échec (`src/mba/gestes-envoi.ts`) le lui rend. À corriger, ou à dire au client avant d'annoncer le bloc à un
  espace qui a des outils maison.
- **Le bloc « Envoyer au MBA » n'attend pas l'accusé du dernier envoi** : `confier` fait le `release` juste après les
  envois du parcours, la course mesurée en 0149. À réutiliser : `demanderReleaseMba`. L'essai réel du bloc se fait avec
  un message AVANT lui. Voisins : `derniereSaisieDuContact` ignore les appuis de bouton, et après une attente le bloc peut
  confier sur une fenêtre fermée.
- **Les `standby` hors liste sont requalifiés dans les quatre modes** : un espace dont une autre application tiendrait
  le fil par handover verrait ses messages passer par nos scénarios. À mesurer sur les webhooks `standby` des 30 derniers
  jours avant de l'affirmer.
- **Mode Équipe** : chaque nouvel épisode ouvre une demande du Quantitatif > Performance (y compris un « merci » de fin
  de campagne), et un entrant d'un espace sans répondeur coûte environ six requêtes au lieu d'une.
- **`choisirRepondeur`** : si `toutRetirer` lève après l'écriture du réglage, le réessai trouve le même réglage et ne
  vide jamais la liste de Meta.
- **L'aperçu de la première réponse** (`web/lib/apercu-reponse.ts`) lit un scénario qui commence par « Envoyer au MBA »
  comme « aucun envoi ».

## 🟡 RC5 B, le bloc « Aller à » : ce qui reste (2026-10-07)

- **L'entrée d'un scénario visé depuis un AUTRE scénario reste ambiguë.** Corrigé dans le scénario lui-même (un bloc
  visé par un « Aller à » de ce scénario n'est plus une racine), mais un bloc qui ne sert que de cible à un autre
  scénario, créé avant le vrai premier bloc, devient l'entrée de la campagne et de l'API. Un graphe seul ne le voit pas :
  il faudrait lire les sauts de tout l'espace, ou laisser le client désigner l'entrée.
- **Campagne de masse vers une cible disparue** : chaque destinataire passe la conversation à l'équipe (une demande de
  Performance par destinataire) ; pour `aller_a_masse`, journaliser sans passer à l'équipe, ou une ligne par campagne.
  Et supprimer ou republier un scénario ciblé par un saut n'est vérifié nulle part (pas d'équivalent du 409 des liens
  de chaîne).
- **Deux écritures sans marque intermédiaire** (le parcours d'origine clos, puis l'arrivée démarrée) : un arrêt du
  worker entre les deux laisse le contact sans suite ni trace. Démarrer avant de clore risquerait deux parcours
  vivants ; le choix se défend, il est à écrire comme risque accepté.
- **Le canal RCS ne suit pas un saut vers un autre scénario** (l'arrivée démarre en WhatsApp).
- **Une arrivée qui finit sans rien envoyer** rend la main à l'agent de Meta sans lui transmettre le message du contact,
  contrairement à `advance`.
- **Tests à renforcer** : `&& ecrit` dans `advance` sans test qui le fasse échouer ; le refus de campagne de
  `src/http/campaigns.ts` sans test HTTP ; l'assertion « redélivré par Meta » (vérifier aussi l'état et l'équipe).
- **Doublons** : `nomDuBloc` (`src/workflow/aller-a.ts` et `src/mba/outils-maison.ts`), `blocDuCode` / `noeudDuCode`,
  `CODE_BLOC_RE` recopié dans deux composants ; `contactId` optionnel dans `WorkflowRunRow` alors que la doctrine du
  fichier le voudrait requis.

## 🟡 RC5 A, la Condition à familles : ce qui reste (2026-10-06)

- **Une sortie de Condition non reliée n'est pas signalée.** Les sorties de Question, de bouton et d'agent portent le
  marqueur « orpheline » (`WorkflowNode.tsx`), celles de Condition non. Une famille ajoutée, laissée vide (donc
  toujours vraie) et non reliée prend tous ceux que les familles d'avant n'ont pas retenus et arrête leur parcours, au
  lieu de les laisser sur « Sinon ». Plus il y a de familles, plus ce trou est probable : marquer ces sorties, ou
  avertir à la publication.
- **Fenêtre de déploiement** : une console neuve devant une API ancienne écrirait des familles que l'ancien moteur lit
  comme un groupe vide (tout le monde sur la première famille). Tenue en déployant l'API AVANT de pousser la console.

## 🟡 RC4, les outils de l'agent IA : ce qui reste (2026-10-06)

- **À valider par Julien : l'assistant de construction ne propose aucun outil à cible fixe** (tag, information, bloc,
  scénario), écart avec le plan : il ne voit ni les étiquettes, ni les champs, ni les scénarios de l'espace, et en
  inventerait l'identifiant. Le client les pose depuis la grille. Pour les lui ouvrir : lui donner la liste des cibles
  possibles dans son contexte, et la borne dans le schéma annoncé.
- **Le contenu d'une cible n'est pas revérifié à la pose** (un bloc envoyable seul, un scénario non vide, un champ
  déclaré) : l'écran ne propose que des cibles valides et l'appel refuse lisiblement le reste, mais une ligne d'outil
  posée par l'API peut refuser chaque appel sans le signaler. Câbler un dépôt dans `src/index.ts` pour la pose.
- **Un cycle entre scénarios** (un agent dans A lance B, un agent dans B relance A) n'est borné que par le crédit :
  chaque saut est une décision du modèle, et les plafonds repartent à zéro à chaque session.
- `scripts/mesure-tour-agent.mts` exclut désormais aussi `poser_tag` et `ecrire_variable` : ses mesures de latence et
  de jetons ne sont plus comparables à celles d'avant RC4.

## 🟡 RC3, changer d'espace : ce qui reste (2026-10-06)

- **À trancher par Julien : une bascule vers un espace où l'on est admin, sans second facteur actif.** Une personne
  sans facteur, invitée comme admin dans un autre espace pendant sa session, y bascule en admin sans s'enrôler, alors que
  la connexion par mot de passe l'y obligerait (`obligatoire` dès un compte admin). Pas fermé, délibérément : la
  connexion par Google n'exige aucun facteur pour un espace, et la session ne dit pas par quel chemin elle a été ouverte,
  donc refuser la bascule bloquerait un admin Google entre ses propres espaces. Pour le fermer sans ce défaut : porter
  dans le jeton la façon dont il a été prouvé (`amr`), et refuser seulement une bascule vers un compte admin d'une
  session ouverte par mot de passe sans facteur.
- **Journaliser la bascule** (une ligne d'audit dans l'espace cible, l'espace d'origine en détail) : aujourd'hui sa
  seule trace est la dernière connexion du compte cible.
- **Deux onglets** : après une bascule, l'autre onglet garde l'ancien espace en mémoire et ses appels rendent 403
  « tenant interdit » jusqu'au rechargement. Aucune fuite (l'étape d'espace refuse), un défaut d'ergonomie : un
  écouteur `storage` qui recharge l'onglet suffirait.

## 🟡 RC2, le statut urgent : ce qui reste (2026-10-06)

- **Le tri de « À traiter » ne s'arrête plus tôt sur l'index.** « Urgentes en tête » trie sur
  `(urgente_le is not null) desc, last_message_at desc, id desc`, qu'aucun index ne sert : la première page lit toutes
  les conversations « à traiter » de l'espace avant de couper. Mesuré le 2026-10-06 : le plus gros espace a 17
  conversations, dont une à traiter, donc rien à gagner aujourd'hui. Le jour où un espace en compte des dizaines de
  milliers : `EXPLAIN (ANALYZE, BUFFERS)` de la première page, et au besoin deux lectures (les urgentes par
  `conversations_urgentes_idx`, puis les autres par l'index récent).
- **L'en-tête d'une conversation qui quitte « Urgent » par « Traité » garde sa copie d'avant** (pastille et « Plus
  urgent » visibles jusqu'au rechargement) : comportement commun à toute conversation qui quitte son dossier, non
  corrigé dans RC2.

## Lot 3c : ce que l'essai réel commun a montré (2026-10-06)

- **Les codes promo, si Julien les veut** : `allow_promotion_codes` sur la session d'abonnement
  (`creerSessionAbonnement`), et un code à 100 % rend la session `no_payment_required`, que le webhook ignore
  aujourd'hui (seule la facture à 0 € enregistrerait l'abonnement) : traiter ce statut comme payé.
- **Ménage** : le numéro de l'essai du 3b (+44 1235 619343, `bloque`) est à résilier chez DIDWW (Julien), puis à
  passer en `resilie` dans la réserve.

## Lot 4 : ce qui reste après les livraisons A et B (2026-10-06)

Les deux livraisons sont en production (la suspension, puis la libération, « Abandonner » et les e-mails). La première
libération réelle est celle de l'espace de l'essai, le 14 octobre vers 15 h 50 UTC (rappel aux admins le 12, décalée
d'un jour par l'essai réel de B1 sur le même espace) : à
regarder ce jour-là (numéro résilié chez DIDWW, ligne retirée de l'espace, alerte, e-mail).

- **Un fil déjà tenu par l'agent de Meta lui reste pendant une suspension** : rien ne change chez Meta, donc s'il est
  allumé il continue de répondre au client, alors que l'espace ne peut plus rien envoyer lui-même. Décidé « rien chez
  Meta » pour la libération ; à confirmer pour la suspension si un client s'en étonne. ⚠️ La relecture a ajouté que
  la fin de l'inactivité (`rendreApresInactivite`), la fin d'un parcours (`rendreMaintenant`) et « Rendre la main »
  de l'Inbox CONFIENT encore un fil à l'agent de Meta pendant une suspension : seule la remise « personne ne suit »
  est gardée.

**Les jaunes de la relecture de la livraison B** (2026-10-06, à corriger après son déploiement ; les deux rouges sont
corrigés) :
- **« Abandonner » deux fois** : la clé d'idempotence de la fin chez Stripe est fixe (`fin-<abonnement>`). Abandonner,
  annuler la résiliation dans le portail, puis abandonner de nouveau dans les 24 h : Stripe rejoue l'ancienne réponse
  sans rien appliquer, et la page dit « rien ne vous sera plus prélevé ». Le geste est idempotent de lui-même : un aléa
  dans la clé suffit. Et `noterFinPrevue(periodeFin ?? maintenant)` peut écraser la date juste du webhook : n'écrire que
  si elle est vide.
- **Après « Abandonner » avec la fin programmée**, la page propose encore « Obtenir mon numéro » (un numéro coupé en fin
  de période) ; le bouton discret « Abandonner » résilie désormais l'abonnement SANS confirmation ; et sur un abonnement
  en retard, Stripe relance la facture ouverte, donc « rien ne vous sera plus prélevé » est faux.
- **Course entre un réabonnement et la libération** : `attribuerAvec` lit le numéro attribué sans verrou ; un paiement
  confirmé pendant l'appel à DIDWW (une seconde) garde un numéro que la libération résilie ensuite.
- **Les chiffres vides à moitié traités** : la route du paiement (`memeNumero`) refuse `''`, la garde et l'état non. Et
  un espace aux chiffres vides qui a un numéro apporté ET un fourni attribué voit son propre numéro suspendu puis retiré.
- **Un espace qui envoie par son propre numéro** reçoit à J+7 l'e-mail « votre numéro a été libéré » alors que le sien
  marche ; `resubscribe_number` le renvoie vers `start_whatsapp_connection`, qui le refuse.
- **Une libération en échec alerte Telegram toutes les 15 minutes, sans fin**, et un 404 de DIDWW (numéro déjà retiré)
  n'est pas traité comme une résiliation faite.
- **Un worker arrêté plusieurs jours** envoie suspension, rappel et libération dans le même tour ; l'alerte de
  `customer.subscription.deleted` dit « le numéro est gardé 7 jours » même quand il n'y en a plus (après « Abandonner »).
- **Resend sans délai côté worker** : un appel bloqué fait sauter les tours du balayage (garde de ré-entrance).
- **Tests manquants** : deux libérations concurrentes (spec § 7), la fenêtre de 2 jours d'`aSurveiller`.
- **Même invariant, une autre porte** : « Abandonner » remet en `libre` un numéro dont un code a été capté (vu de Meta).
- **Un numéro fourni résilié peut être RECONNECTÉ** par l'Embedded Signup (il reste dans le compte WhatsApp du client
  chez Meta) : `linkTenant` devrait refuser un numéro de la réserve qui n'est pas attribué à cet espace.

**Le jaune de la relecture de la livraison A qui reste** (les autres sont corrigés dans la livraison B) :
- **`customer.subscription.updated` : le dernier arrivé gagne** (une annulation de résiliation reçue avant la
  résiliation laisse un faux « se termine le ») ; affichage seulement. Le corriger demande de comparer la date de
  l'événement, et le test qui le tiendrait (deux `updated` dans le désordre) manque.

## Lot 3c : un lien déjà donné survit à la révocation de l'accès de Claude (jaune de la relecture, 2026-10-06)

Révoquer Claude dans « Applications autorisées » ne coupe pas un lien de connexion du numéro déjà donné : il sert jusqu'à
son heure, ou jusqu'à la connexion du numéro. Correction prévue : porter l'identifiant de l'autorisation OAuth dans le
jeton du lien (`signLienNumero`) et exiger dans la garde `adminOuLien` qu'elle ne soit pas révoquée. Dit dans
`features.md` en attendant.

## 🟠 Connecteurs : l'autonomie d'un outil ne suit pas le risque monté par sa requête (relecture de `099fd6c1`, 2026-10-05)

- ✅ ~~Les paramètres d'un outil ne suivaient pas les variables de sa requête~~ : réglé le 2026-10-08, ils se lisent
  sur la requête à chaque lecture de l'outil, sans copie (`paramsDuConnecteur`, plan
  `docs/superpowers/plans/2026-10-08-parametres-du-connecteur.md`).
- **Un connecteur monté à `irreversible` garde son autonomie** : depuis RC4 (2026-10-06), la ligne d'un connecteur
  irréversible le dit et « Modifier » offre la case. Reste à faire tomber `autonome` des outils montés à
  `irreversible` par un changement de méthode, dans la même transaction (`PgRequeteStore.patch`) : un consentement
  posé sur un outil `write` (la route l'accepte sur tout risque) ne doit pas passer en silence à une action devenue
  irréversible (même règle que le rafraîchissement MCP).
- 🟡 Une fenêtre reste ouverte sur le risque, de l'ordre de la milliseconde : la création d'un outil lit la méthode
  AVANT sa transaction (`POST .../tools/connecteur`), et ni l'insertion ni le patch ne voient l'écriture non validée
  de l'autre. La fermer : dans la transaction de `creerOutilConnecteur`, lire la méthode de la requête `for share`
  (qui attend un patch en cours) et monter le risque à son plancher ; couvre `agent-tools.ts` et `mba-outils.ts`.
- 🟡 Laissés délibérément par le même lot : le câblage construit deux fois le même objet de dépendances d'un
  connecteur (`src/index.ts`, bac à sable et relais de l'agent de Meta) ; et un GET qui « intègre » mais AGIT
  partirait encore au bac à sable (la déclaration du client fait foi, question produit si un cas réel se présente).

## 🟡 La mention d'IA et la forme WhatsApp : à trancher (relecture de `6d6e47dc`, 2026-10-05)

- **`reply_in_open_window` (outil MCP, `src/mcp/outils.ts`) envoie un texte écrit par Claude**, sans mention d'IA ni
  conversion Markdown (`pourLeContact`, `src/agent/brain.gateway.ts`). C'est le seul autre chemin par lequel un texte
  de modèle part sur WhatsApp, mais c'est un membre de l'équipe qui répond par Claude : l'annonce s'y applique-t-elle ?
  Décision de Julien, puis, si oui, brancher l'outil sur la même sortie.
- Suggestion de la relecture, non faite : dire dans la consigne commune « si on te demande si tu es une IA, réponds
  honnêtement », y compris au régime « jamais » (`promptSysteme`, `src/agent/prompt.ts`).

## 🟡 Le numéro fourni (lot 3b) : les jaunes de la relecture de la livraison A (2026-10-05)

- 🟡 **Une attribution n'expire jamais** (relecture de la livraison B) : un espace qui obtient un numéro sans jamais le
  connecter le garde. Un balayage qui rend à la réserve un numéro `attribue` non connecté après quelques jours.
- 🟡 **Un numéro fourni relié mais NON vérifié reste sans code affiché** : si la fenêtre de Meta se termine sans
  vérification, l'activation de l'Accueil demande le code par appel, l'Asterisk le capte, mais aucun écran ne le
  montre (la page « Connecter WhatsApp » s'arrête dès que l'espace a un numéro). Afficher le code tant que le numéro
  n'est pas vérifié.
- 🟡 **La course « deux demandes du même espace » n'est pas garantie par le test d'intégration** (`Promise.all` peut ne
  jamais se croiser) : la prouver avec une transaction tenue ouverte pendant la seconde attribution.

- 🟡 **Un compte sans numéro reste attaché au premier espace qui l'a relié** : relancer la fenêtre depuis un autre
  espace rend 409, et aucun geste de la console ne le libère (« Délier » exige un numéro). À traiter avec la page du 3b.
- 🟡 **Le cache de 60 s de `wabaDeLEspace`** (`src/meta/numero-espace.ts`) peut rendre un compte que `linkTenant` vient
  de retirer : l'activation et le statut échouent jusqu'à 60 s. Invalider l'espace après la liaison.
- 🟡 **`waitFor` s'arrête au premier compte seul** (`web/lib/connexion-numero.ts`) : si Meta envoie le compte seul
  AVANT le couple compte et numéro, le serveur repêche par `listPhones`, et rend 409 sur un compte à deux numéros.

## 🟠 Le pont du code (lot 3a) : les restes (2026-10-05)

- 🟠 **Remplacer la clé DIDWW** : elle a transité par une conversation le 2026-10-05. En créer une neuve chez DIDWW
  (limitée au VPS), la poser dans `.env.prod` (`DIDWW_API_KEY`), `--force-recreate` de `mba-api`, puis révoquer
  l'ancienne. Geste de Julien.
- 🟡 **Le secret du pont passe en argument d'`openssl`** (`-hmac`) le temps du calcul, lisible dans la liste des
  processus de l'hôte. Documenté dans `envoyer-otp.sh` ; la ligne de commande d'openssl n'offre pas mieux.
- 🟡 **`Record()` cherche un son « beep » que l'image n'a pas** : un avertissement à chaque appel, sans effet sur
  l'enregistrement. L'option `q` le ferait taire.
- 🟡 **Un nouvel essai par Meta ne demande aucun achat** : le portefeuille de test « Gerermonchantier » n'est pas
  vérifié et porte déjà deux numéros, la limite de Meta (le bouton « Add phone number » est grisé). Un essai suivant
  supprime puis réajoute un numéro existant.

## 🟡 L'observabilité : ce qui reste après la relecture du lot du 2026-10-04

- **Les passes qui rattrapent leur propre erreur ne comptent pas en échec** dans la carte des tâches de fond : la
  vectorisation et l'analyse des conversations (via `onError`). La rétention générale et les statistiques d'analyse
  relancent la leur depuis ce lot. Les aligner demande de regarder ce que chacune fait de son erreur.
- **Les moyennes de `risque-desengagement` et `retention-conversations` sont diluées** par leurs passes à vide (le
  risque passe 96 fois par jour, une seule travaille). Le pire cas, lui, est juste ; une moyenne des passes « qui
  ont travaillé » demanderait de distinguer une passe à vide.
- **La dernière minute de mesures est perdue à chaque arrêt d'un worker** : aucun vidage dans l'arrêt propre, et une
  passe en vol n'est pas mesurée.
- **Sans Telegram configuré** (ou une API locale branchée sur la base de production), la surveillance des workers
  prend et relâche un verrou par minute et par rôle silencieux, et journalise une ligne : sans effet, mais du bruit.
- **Un schéma `pgboss_test` existe dans la base de production** (0,3 Mo, mesuré le 2026-10-04) : reste d'anciens tests
  d'intégration lancés contre elle. Le supprimer est un geste de Julien (`drop schema pgboss_test cascade`), après
  avoir vérifié que rien ne l'utilise.

## 🟡 Les files : ce qui reste après le battement de cœur et le vidage continu (relecture de `933557b7`, 2026-10-04)

Le défaut de rafale et l'attente de 15 min au crash sont corrigés et déployés (journal du 2026-10-04). Restent :
- **Le même défaut de rafale sur `agent-turn`, `automation-event` et `campaign-run`** : chaque boucle repart dormir
  60 s après une tâche si rien ne la réveille. Pas mesuré : une campagne avec un bloc agent peut produire plus de
  douze tours d'un coup. À passer au banc (épreuve `rafale` adaptée), avant d'étendre `FILES_VIDEES_EN_CONTINU`
  (`agent-turn` a douze boucles : un filet court y coûterait cher, le vidage non).
- **Le démarrage à froid de l'API** : juste après un redémarrage, chaque premier enfilement d'une file refait sa
  création et ses réglages (`ensure`), et une rafale fait ce travail en parallèle avant que le premier ne le mémorise.
  Mesuré sur le banc : 845 prises de connexion pour 120 messages, 830 attentes de 230 ms au pire, une minute.
  Remède : mémoriser la promesse en vol de `ensure` par file.
- **Compter les reprises par battement** (« job heartbeat timeout ») dans `/ops` : c'est ce qui dira si de faux
  orphelins existent (une tâche vivante dont les battements n'ont pas pu partir).
- Le banc : programmer les sondages des onglets depuis le début du geste précédent (la console tire à heure fixe,
  le banc attend la réponse), et garder un fichier d'orchestration de l'hôte versionné.
## 🟡 Meta a refusé deux fois de relancer l'agent sur une réponse « à côté », puis accepté : cause non établie (2026-10-03)

Scénario lancé par le lien de test, sortie « Toute autre réponse » non reliée, réponse en texte libre : le parcours
s'arrête, la conversation est rendue à l'agent, et l'`agent_event` « réponse hors parcours » doit le faire répondre.
**Ça marche, modèle compris** : accepté à 19 h 40 (ouvert par un message rapide) et à 23 h 01 (ouvert par un modèle,
après « Reprendre la main » dans l'Inbox), l'agent a répondu les deux fois (heures de Paris). ⚠️ Une première version
de cette entrée concluait « après un modèle, l'agent ne répond pas » sur deux mesures : la troisième l'a démentie.

**Ce qui reste inexpliqué** : deux REFUS (« Validation error : Event request was not accepted »), à 19 h 25 en fin de
parcours après un modèle, puis renvoyé à la main vers 19 h 30, le contact sur la liste et l'agent tenant le fil. Seule
différence repérée : la conversation sortait d'une série de tests où l'agent avait annoncé un passage à l'équipe à
16 h 38 sans reparler depuis ; après qu'il a répondu à un message neuf (19 h 34), les deux événements suivants sont
passés. Non prouvé. Dans les deux cas, le `release` est refusé (l'agent tient déjà le fil après un modèle) sans gêner
l'événement. À regarder si un refus se reproduit en production : `GET /{phone_number_id}/agent_event/{id}` ne sert
qu'aux événements acceptés ; garder la conversation, l'heure et l'état du fil. Parade pour une démo : « Reprendre la
main » sur la conversation juste avant, pour partir d'un état propre.

## 🟡 Un envoi refusé par Meta en pleine avance laisse le parcours en attente, en silence (vu le 2026-10-03)

Pendant l'essai réel des envois de bloc, un bloc « formulaire » désignait un formulaire inexistant. Meta a refusé
(#131009) : `sendFlowMessage` lève, l'avance s'arrête, et la seule trace est la ligne
`processWorkflowAdvance: message ignoré` dans le journal du worker. Le parcours est resté en cours sur le bloc
précédent jusqu'à ce qu'un nouveau test le remplace ; ce que la console en montre n'a pas été vérifié à l'écran.
Le comportement est antérieur au déplacement des envois
(`src/workflow/envois-bloc.ts` ne fait que relayer l'erreur du client Meta). À regarder : rendre ce refus comme un
`SendRefusal` lisible (sortie d'échec du bloc, événement de bloc), au moins pour les erreurs de paramètre, qui ne
se corrigent pas en rejouant.

## 🟡 RGPD : `workflow_runs` et `automation_fires` ne sont pas purgés pour une personne sans conversation (2026-10-03)

Trouvé par la revue finale du widget, ANTÉRIEUR au widget. `PgContactStore.purgeMany` (`src/crm/contact-store.pg.ts`)
ne les vise que par les numéros des FILS de la personne ; la rétention efface les fils et garde la fiche, donc une
demande d'effacement tardive laisse le numéro dans ces deux tables. `widget_tirs` a été corrigé par
`waIdsDeLaPersonne` (fils ET fiche), avec un test d'intégration vérifié dans les deux sens par un commit muté poussé
sur une étiquette jetable : même correctif et même test à appliquer aux deux autres.

## 🟡 Widget WhatsApp : les jaunes ouverts (2026-10-03)

La liste vit dans le plan (`docs/superpowers/plans/2026-10-02-widget-whatsapp.md`, « Ce qui reste ») : la recopier
ici la ferait dériver. Les plus importants : une longueur minimale de phrase ; le scénario d'un widget qui démarre
DANS la boucle d'enregistrement des entrants (un envoi lent retarde les messages suivants du lot) ; une lecture des
widgets par message texte entrant, sans cache.

## 🟡 Le délai de reprise et le mode liste : les jaunes de la relecture de `53c112e8` (2026-09-30)

Lot « Traité relance le délai » (déployé et éprouvé le 2026-10-01). Aucun ne casse la production.

- 🟡 **`formesDuNumero` (formes brésilienne et mexicaine d'un numéro) ne sert qu'au chemin des modèles** : ni
  `reprendrePourLApp` ni `retirer` ne l'emploient, donc un contact de ces pays peut rester sur la liste de l'agent
  après une reprise.
- 🟡 **Le `catch` du `release` refusé est trop large** (`confier`, `src/inbox/fil.ts`) : il ne devrait tolérer que
  l'erreur observée de Meta (l'agent tient déjà le fil), pas toute erreur.
- 🟡 **Deux commentaires faux** : `src/worker.ts` (vers la ligne 510) et la JSDoc du fil qui dit encore « un fil déjà
  tenu par un opérateur reste tel quel ».
- 🟡 **La doc écrit comme un fait mesuré que Meta refuse `release` quand son agent tient le fil** : c'est une
  inférence (un refus observé le 2026-09-30), à écrire comme telle.
- 🟡 **`rouverte` se perd sur un job rejoué** : le second passage relit la conversation déjà rouverte et ne voit
  plus la réouverture, donc n'ouvre pas la demande.

## 🟡 Le coût par engagement des publicités : les restes de la relecture de `7ace4c9b` (2026-09-30)

Huit jaunes sur quatorze corrigés et déployés (`c6255bd4`). Ce qui reste ne touche pas un compte français.

- 🟡 **Fuseau** : les jours de Meta suivent le fuseau du compte publicitaire, les arrivées l'heure de Paris
  (`coutParPub`). `pub_connexion.fuseau` existe et pourrait borner les deux.
- 🟡 **Devise** : celle de la connexion au moment de la lecture, appliquée à tout l'historique ; après une
  reconnexion à un compte dans une autre devise, les anciens jours s'afficheraient dans la nouvelle.
- 🟡 **Performance** : l'index partiel `arrivees_pub_campagne_idx` ne porte pas `arrivee_le`, la CTE des arrivées lit
  toutes celles de l'espace. Négligeable aux volumes actuels.
- 🟡 **`limit(1000)` jamais mesuré** sur l'expansion des jours ; `paging.next` n'est pas suivi (journalisé
  seulement), et ce seraient les jours RÉCENTS qui manqueraient.
- 🟡 **L'écriture des jours par le câblage du worker n'est couverte par aucun test** (vérifiée en production).
- 🟡 **Une panne des campagnes push masque aussi l'accordéon des publicités** (il vit dans la même ligne).

## 🟠 L'agent de Meta et les publicités : à regarder (2026-10-01)

- 🟠 **Le message de passation de l'agent de Meta est en ANGLAIS** (« Thanks for reaching out! I'll ask a
  representative to respond », vu le 2026-09-30 sur une conversation en français) : c'est le message automatique
  de Meta. Voir s'il se règle (langue, texte) dans les réglages de l'agent.
- 🟠 **Lire les Business AI Terms connecté au Business Manager** (`facebook.com/legal/meta-business-ai-terms`) :
  rôle de Meta, usage des conversations pour la publicité ou l'entraînement, clause UE. Requis avant la première
  question d'une DSI. Le point de départ est dans `brain/MESSAGINGME.md`.
- 🟠 **L'ancienne console `mba.messagingme.app` n'est pas reconstruite** : elle montre encore le choix d'audience
  et le panneau de liste retirés de la console actuelle.
- 🟠 **App Review des six permissions publicitaires** le jour où un client devra brancher SEUL son compte : un texte
  et une vidéo PAR permission (doc Meta), tournés pendant une vraie création de publicité. Inutile tant qu'un
  admin de l'app branche les comptes (accès standard, mesuré sur Groupama PJ le 2026-09-30).

## 🟡 Lecture des fichiers déposés : ce que le worker borne sans le corriger (2026-09-30)

Depuis le 2026-09-30, un CSV, une page de FAQ, un document déposé ou les pages d'un site se lisent dans un worker
(`src/lib/hors-boucle.ts`) : échéance de 10 s (30 s pour un document, 20 s cumulées pour les pages d'un aperçu ou d'un
import de site), 1 Go de tas, quatre lectures EN COURS à la fois. Les formes ci-dessous ne figent donc plus l'API ;
chacune occupe un cœur jusqu'à l'échéance, puis le fichier est refusé en 400. Ce qui reste : un vrai fichier qui les
frôle serait refusé au lieu d'être lu, et quatre dépôts hostiles simultanés occupent quatre des huit cœurs du VPS le
temps de l'échéance.

- 🟡 **Guillemets mal placés puis une traîne d'espaces** : papaparse reparcourt la traîne à chaque guillemet
  (`extraSpaces`, puis `trim()`), soit N x K par lecture. 101 Ko : 1,5 s ; 330 Ko : 123 s selon la relecture.
- 🟡 **Doublons d'en-tête** : `a_1` ... `a_8192` puis 8 192 fois `a` passe la borne de colonnes, et le renommage de
  papaparse repart de `a_1` pour chaque doublon, soit un coût quadratique. 1,8 s pour 8 192 colonnes.
- 🟡 **Un .docx de quelques centaines d'octets** (`texteDocx`, `src/agent/setup/piece-jointe.ts`) : ses trois
  expressions sont quadratiques sur un `document.xml` fait de `<` ou de balises non fermées (80 000 `<` dans 227
  octets : 8,2 s, selon la relecture). Piste mesurée linéaire : `[^<>]` au lieu de `[^>]`, et `[^<]*` au lieu de
  `[\s\S]*?` (un `<` brut n'existe pas dans un `document.xml` valide).
- 🟡 **Une suite de lignes courtes dans un document texte** (`texteEnFiches`, même fichier) : chaque ligne qui
  ressemble à un titre recolle toute la section courante (`contenuDe`). `T` suivi de deux sauts de ligne, répété :
  120 Ko 10,2 s selon la relecture. Piste : tenir la longueur au fil de la lecture au lieu de tout recoller.
- 🟡 **Sous les bornes, le coût suit la taille**, dans le worker désormais : un million de lignes d'un caractère 1,9
  à 2,7 s, un guillemet sur deux caractères sur 8 Mo 6,2 s et 1,2 Go, 16 384 noms puis 250 rangées pleines 7,5 s et
  700 Mo.
- 🟡 **Le fil principal paie encore la relecture et la reconstruction des rangées d'un import**, en proportion des
  cellules présentes. Mesuré EN PRODUCTION le 2026-09-30, sur le plus gros vrai fichier (762 600 numéros) : 1,2 s de
  boucle bloquée, pendant une lecture de 5,9 s. Cette ligne annonçait 0,18 s : c'était, sur le poste, la seule
  relecture du JSON ; la reconstruction des rangées y pèse autant, et le VPS a mis près de trois fois le temps du
  poste pour les deux. Un CSV forgé de 7,5 Mo (16 384 noms de 200 caractères, 140 rangées pleines) : 0,8 s et 228 Mo
  de tas sur le poste, contre 1,8 s et 1,4 Go quand les rangées revenaient par nom. L'aperçu ne rapporte que quatre
  rangées (0,12 s sur le même fichier). Remède : faire arriver les rangées par morceaux, chacun relu et reconstruit
  entre deux tours de boucle ; ou que `importContacts` lise les rangées par numéro de colonne.
- 🟡 **Le plus gros vrai CSV n'a qu'une marge de 1,7 sous l'échéance de 10 s, en production** : 5,9 s mesurées le
  2026-09-30, contre 3 s sur le poste. Un VPS chargé pourrait le refuser. Déclencheur : un refus `echeance` sur
  `parseCsvCompact` pour un vrai fichier (journal `lecture_interrompue`). Remède : relever l'échéance de l'import de
  contacts, ou la lecture par morceaux ci-dessus.
- 🟡 **Le plafond de quatre lectures est commun à tous les espaces**, et compté par process. Les routes de la FAQ et
  des pièces jointes de l'assistant n'ont pas le plafond coûteux par espace : un seul administrateur peut y garder
  les quatre places (quatre fichiers lents toutes les 10 s), et l'import de contacts, la FAQ et les documents de
  TOUS les espaces rendent alors 429 le temps qu'il insiste. Remède : une part par espace, ou le plafond coûteux sur
  ces routes ; et un compteur partagé, en base, le jour où l'API tourne en plusieurs instances. Les pages d'un site
  ne gardent une place que pendant leurs lectures (pas pendant qu'elles attendent le réseau), 20 s au plus par
  requête, sous le plafond coûteux (10 par minute et par espace) : à 10 requêtes par minute de 20 s de lecture, un
  seul espace en tient pourtant 3,3 en moyenne, en continu.
- 🟡 **Un 429 peut tomber au milieu d'un parcours de site** : chaque lecture d'un aperçu (jusqu'à cent) repasse le
  plafond de quatre, et quatre imports lents d'autres espaces pendant la soixantième font refuser l'aperçu après des
  minutes de réseau. Rare, une lecture de page durant quelques millisecondes ; chaque refus est journalisé
  (`lecture_interrompue`, raison `occupe`). Déclencheur : ces refus apparaissent sur `pageEnFiches` ou
  `liensDeLaPage`. Remède proposé par la relecture du 2026-10-01 : un lecteur qui a déjà lu attend une place, pendant
  un temps borné, avant de refuser.
- 🟡 **Un parcours de site lit ses pages une à une** : depuis l'échéance de 30 s par requête (2026-10-01), un site à
  plus de 0,6 s par page ne rend qu'une partie de ses cinquante pages à l'aperçu, et l'import propose les restantes
  d'un nouveau clic. Les lire quatre à la fois diviserait la durée d'autant. Déclencheur : la ligne de journal
  `parcours_coupe` chez de vrais clients. ⚠️ L'ordre en largeur et le plafond de pages devront rester ceux d'aujourd'hui.
- 🟡 **`--max-old-space-size` l'emporterait sans bruit sur la limite de 1 Go d'un worker** (mesuré par la relecture
  sous Node 24, en ligne de commande comme dans `NODE_OPTIONS`). Rien ne le pose aujourd'hui (`NODE_OPTIONS` vide
  dans le conteneur de production, vérifié le 2026-09-30) : à ne pas ajouter sans relever cette limite.
- 🟡 **Une image lue par le modèle de vision peut ensuite tomber en 429 ou à l'échéance** du découpage (pièce
  jointe de l'assistant) : la lecture payée est perdue. Le plafond de 2 € par mois des assistants borne la perte.

## 🟡 Lecture des CSV : les restes de la réparation du séparateur (2026-09-30)

- 🟡 **Un CSV aux rangées inégales retombe encore sur la devinette de papaparse** (`parseCsv`, `src/crm/csv.ts`) :
  `separateurCsv` exige que les 50 premières rangées aient toutes le même nombre de colonnes. Une seule rangée
  courte (une question de FAQ sans réponse, une cellule de fin absente d'un fichier écrit à la main) suffit, et un
  fichier en point-virgule dont les cellules portent des virgules est lu en virgule : zéro paire de FAQ, zéro
  contact (mesuré par la relecture). Un export Excel écrit toutes ses cellules et n'est pas concerné. Remède
  esquissé et mesuré par la relecture : une seconde passe propre à `parseCsv`, qui a un en-tête (même ordre de
  séparateurs, en-tête d'au moins deux colonnes, aucune rangée plus longue que lui, la majorité aussi longue).
- 🟡 **Une première ligne faite de séparateurs seuls devient l'en-tête** (`parseCsv`, vu le 2026-09-30, antérieur) :
  papaparse renomme ses cellules vides (`_1`, `_2`...) avant de sauter les lignes vides. Sur `;;;` puis
  `nom;tel;ville;cp`, les en-têtes lus sont `_1`, `_2`, `_3`, le vrai en-tête devient une rangée de données et la
  colonne `nom` disparaît : l'import ne trouve plus le téléphone et écarte tout. Un export de tableur dont la
  première ligne est vide le produit. Remède esquissé : lire à partir de la première rangée non vide.

## 🟡 L'agent de Meta en mode liste : deux courses que la relecture a laissées porter (2026-09-30)

Les deux naissent de l'ordre « Meta d'abord, la ligne de `mba_liste` ensuite » (`src/mba/liste.ts`), voulu : sans
l'identifiant rendu par Meta, on ne peut plus retirer. Fenêtre de quelques centaines de millisecondes, aucune vue
en production.

- 🟡 **Un « confier » et un modèle concurrents.** L'ajout est fait chez Meta, la ligne pas encore écrite : le
  retrait avant un modèle (`retirerAvantUnModele`) lit la table, n'y voit pas le contact, et le modèle part vers un
  contact que l'agent a sur sa liste. L'agent répond alors à la réponse du contact à la place du scénario. Piste :
  un verrou court par contact (bail en base, sur le modèle de `src/campaign/run-lock.ts`) pris par les deux gestes.
- 🟡 **La compensation d'un `poser` en échec peut retirer l'entrée d'un « confier » concurrent.** Deux confier du
  même contact : le premier ajoute et écrit sa ligne ; le second, parti avant la ligne, reçoit le 400 de doublon,
  retrouve la MÊME entrée par relecture, puis son `poser` échoue (panne de base) et sa compensation la retire chez
  Meta. La ligne du premier reste : notre table croit le contact sur la liste, Meta non. Ses messages rangés en
  `standby` ne sont alors plus requalifiés (il est « présent ») et n'arrivent à personne. Piste : ne compenser que
  l'entrée que CE geste a créée (pas celle retrouvée par relecture).

## 🟠 Base de connaissance : ce que la réparation du CSV a trouvé à côté (2026-09-29)

- 🟠 **Le bot d'aide ne lit que le début de ses fiches** (mesuré en lecture seule le 2026-09-29) : 20 fiches sur
  26 de `aide_fiches` dépassent 2 000 caractères (la plus longue 10 008, « créer une publicité »). La recherche
  les lit entières, le modèle n'en reçoit que les 2 000 premiers (`CORPS_MAX`, `src/aide/repondre.ts`) : une
  question sur la fin d'une fiche la fait retenir, puis répondre sans elle. Même défaut que la base de
  connaissance des agents, réparée le même jour en bornant chaque fiche à ce que l'agent lit ; ici le remède est
  à trancher : découper les fiches par section au chargement (`db/charger-aide.ts`), ou les rendre entières au
  modèle, sur notre clé.

## 🟠 Suites de la recharge Stripe et du panneau Détail (2026-09-29)

- **Julien** : ajouter l'autorisation **Invoices : Lecture** à la clé restreinte « Messaging Me console », puis
  cliquer « Facture » sur l'achat ENGAGE100 de Paramètres > Crédit IA. Sans elle, le lien rend un refus lisible.
- 🔴 **À VÉRIFIER : la lecture du fil n'a pas de garde de visibilité.** Relevé par l'implémenteur du panneau :
  la route de détail passe par `visibiliteSql`, la lecture des messages du fil non. Un agent qui ne voit que ses
  conversations lirait donc le fil d'un collègue par l'URL, sans voir son panneau. Mesurer avant de corriger.
- 🟡 **Une traduction coupée par le délai n'est pas débitée** (`src/traduction/traduire.ts`) alors que Vercel l'a
  peut-être facturée : la commission de 10 % absorbe l'écart tant que c'est rare.
- 🟡 **La révocation d'une clé (`DELETE /ops/cle-modele/:tenantId`) est défaite par la traduction suivante**, qui
  rouvre une clé si l'espace a du crédit. ⚠️ Fermé pour la SUPPRESSION d'un espace (RC8, 2026-10-07 : l'espace est
  verrouillé et une clé ne s'ouvre plus pour un espace verrouillé), pas pour une révocation seule d'un espace actif.
- 🟡 **Mode test Stripe** (produits, clé restreinte, destination webhook en test) : facultatif, l'essai final a
  été fait en live avec un code promo à 100 %.

## 🟡 Vitrine (`app.messagingme.fr`) : restes du 2026-10-03

- **Search Console** (Julien) : déclarer la propriété du domaine (enregistrement TXT chez OVH, ou un fichier de
  vérification que Claude pose), puis soumettre `https://app.messagingme.fr/sitemap.xml`. C'est ce qui
  déclenche l'indexation : un moteur de recherche ne trouvait aucune page du domaine le 2026-09-30.
- **Un lien depuis messagingme.fr** vers la vitrine (aucun sur l'accueil du site mère), avec le travail sur le lien
  entre les deux sites.
- **Rapatrier l'assembleur des pages dans le dépôt.** Les pages fonctionnalités, contact, merci et 404 sont
  assemblées par un script (en-tête, pied et icônes recopiés de l'accueil, sitemap généré) qui ne vit, avec leurs
  corps de page, que dans le dossier temporaire d'une session. Sans lui, un changement d'en-tête ou de pied se
  reporte à la main dans sept pages, et le sitemap se tient à la main. Cible : `scripts/vitrine/`, jamais `site/`
  (tout y est publié).
- **Le widget en essai sur l'accueil** (`ndabjvs20vc4`) : le garder ou le retirer une fois l'essai réel fait.

## 🟠 Suites de « approfondir la racine » (2026-09-27 et 28, plan `docs/superpowers/plans/2026-09-27-approfondir-la-racine.md`)

1. **Essais réels à faire par Julien** (ils demandent sa session) : répondre depuis l'Inbox ; s'envoyer un message
   WhatsApp (premier entrant depuis le lot 5 : vérifier qu'il arrive, puis relire `webhook_events` et les jobs
   `webhook`) ; ouvrir Statistiques > coûts (mêmes montants qu'avant le lot 2) ; prendre puis rendre une
   conversation tenue par l'agent de Meta.
2. **Jaunes laissés par les relectures** :
   - `tests/pubs-cablage.test.ts` : l'inventaire des écritures du jeton exige `.poserJeton(` / `.remplacer(` avec un
     point (un appel déstructuré lui échappe) et `.remplacer(` est trop générique ;
   - `reprendrePourLApp({ saufOperateur })` (`src/inbox/fil.ts`) prend l'état d'attente `app_human` d'une fin de
     parcours pour un opérateur : un clic de publicité à ce moment ne lance pas son scénario (le message arrive
     dans l'Inbox, rien n'est perdu) ;
   - agent de Meta allumé sans numéro connecté : une fin de parcours laisse la conversation en `app_human`, que le
     balayage ne rend plus ; « Rendre la main » répond 409. À dire dans l'écran si ça se présente ;
   - décision 1 appliquée à une campagne à scénario de masse : elle efface l'escalade de chaque destinataire. À
     confirmer avec Julien sur ce cas ;
   - `/tenants/:id/conversations/:id/prendre` : une panne de base avant l'appel à Meta sort en 500 (Cloudflare
     mange le corps) au lieu de 409 ;
   - `FlowMappingDeps.audit` (trace du consentement capté par un Flow) reste optionnel.
3. ✅ **Candidat 6 de la revue d'architecture** (un point d'entrée « lancer un scénario » qui porte la politique de
   chaque type de lancement) : fait le 2026-10-04, piste 4 du rapport du 2026-10-02 (plus bas).

## 🟠 Suites de la session du 2026-09-25 au 27 (MFA, audit ponytail, commentaires)

1. **`/ops` nominatif avec double authentification** (lot 4 du bilan, `docs/prive/BILAN-AUDITS-2026-09-22.md`).
   Aujourd'hui un jeton partagé unique, sans identité. À cadrer avec Julien : nombre de comptes, accès de secours,
   durée de session. La moitié « admins d'espace » est faite et éprouvée (2026-09-27).
2. **Jaunes laissés par les relectures** :
   - `tests/http-inbox.test.ts` a perdu le cas « `POST /tenants/AUTRE/conversations/:id/traiter` -> 403 » en
     retirant son voisin 503 : le remettre ;
   - `tests/role-admin.test.ts` ne vérifie que l'AGENT sur les écritures des modules montés sur `g.auth`, où
     `forbidNonAdmin` est la seule barrière : ajouter le manager ;
   - quelques valeurs de `tests/routes-inertes.ts` ne reproduisent pas exactement l'ancienne absence
     (`agentsInertes.etatPourLint`) ; des fixtures contournent encore le typage par `as unknown as` ;
   - l'écran Équipe montre « Réinitialiser la double authentification » même pour un membre qui n'en a pas (la
     liste des membres ne dit pas qui a un facteur) ;
   - une alerte Telegram au déclenchement du blocage des codes (seul le journal le trace aujourd'hui) ;
   - un agent promu admin garde sa session sans facteur jusqu'à 12 h.
3. **L'heure de planification d'une campagne** s'affiche à l'heure de Paris (`web/app/campaigns/page.tsx`) alors
   qu'elle se saisit à l'heure du poste (`datetime-local` de `EtapeRecap.tsx`) : un poste qui n'est pas à Paris lit
   une autre heure que celle qu'il a tapée.
4. **Commentaires de `src/salesforce`** : pas traités par le chantier du 2026-09-27, sa session y travaillait.
5. **`LLM_PROVIDER`** à retirer de `.env.prod` sur le VPS (la fabrique de LLM a disparu au lot 1 de l'audit).
6. **Julien** : révoquer les deux clés d'API de l'essai réel du 2026-09-25 (puis vérifier le 401), supprimer les
   contacts fictifs +33639980001 à 04 et le champ `essai_api_x`.

## 🔴 App Salesforce core : L0 mesuré, BLOQUÉ par la liaison du namespace (2026-09-27)

Le pendant de HubSpot pour le Salesforce « core » (Leads, Contacts, Opportunités, Campaigns), en offre de
prospection. **Tout est dans la spec** : `docs/superpowers/specs/2026-09-26-app-salesforce-design.md`
(décisions de Julien, architecture, données, flux, lots L0 à L5, méthode de livraison, essai réel qui clôt).

Plan : `docs/superpowers/plans/2026-09-26-app-salesforce.md`. **L0 est fait** (résultats :
`docs/salesforce-mesures-2026-09.md`) : la recherche par téléphone a son algorithme, l'upsert par External ID
rend tout idempotent, l'appel Apex signé traverse Cloudflare. Namespace réservé : `engagemeapp` (`engageme` pris).

🔴 **LE BLOCAGE** : Salesforce refuse de relier `engagemeapp` au Dev Hub. Son application « SalesforceDX Namespace
Registry » exige PKCE (verrouillé, « contactez le Support »), et sa fenêtre de liaison ne l'envoie pas
(`missing required code challenge`). Sans cette liaison, aucun package géré 2GP, donc ni installation chez un
client ni les mesures 1, 5, 8 et 10. **Cause mesurée le 2026-09-28** : le durcissement de sécurité imposé par
Salesforce depuis juillet 2026 (PKCE obligatoire et verrouillé), que son propre bouton n'envoie pas ; revérifié le même
jour, même refus (détail : `docs/salesforce-mesures-2026-09.md`). **Prochain pas : faire lever le blocage par
Salesforce.** Fait le 2026-09-28 : inscription au programme partenaire (ISV, solution composite), accès EN
ATTENTE de validation par e-mail ; une fois admis, ouvrir un ticket partenaire avec le message du document des
mesures (ou l'envoyer à `partnercommunitysupport@salesforce.com`). En parallèle, le message sur la communauté
Trailblazer. La partie serveur de
L1 (migration 0183, client REST, store, connexion, routes, écrans) est DÉPLOYÉE depuis le 2026-09-27, invisible tant
que `SALESFORCE_CLIENT_ID` n'est pas posé (la route rend 404, la carte se cache).

## 🟠 Connecteurs API : un défaut restant, vu pendant l'essai Brevo (2026-09-28)

Vu en montant, avec Julien, un scénario qui répond sur le numéro WhatsApp d'un client Brevo par l'API de Brevo.

- **Le mode d'authentification et le nom d'en-tête d'un système ne se modifient pas après création**
  (`web/components/ConnecteursBibliotheque.tsx` : seul le secret se remplace), et le nom d'en-tête est
  pré-rempli à `x-api-key`. Brevo attend `api-key` : il a fallu supprimer et recréer le système deux fois.
- ✅ **Corrigé le 2026-09-30** : le bloc « Appel HTTP » d'un scénario accepte un appel qui POUSSE. Sans champ
  cible, la lecture est `pousse` (corps non lu, un 2xx vaut succès, 204 compris, aucun champ de réponse exigé,
  donc plus besoin d'un vrai « Essayer » pour en cocher un) ; avec un champ cible, rien ne change. Mesuré avant :
  le seul bloc `http` en production avait un champ, donc aucun comportement n'a bougé.

## 🟠 `features.md` se contredit à TROIS endroits, trouvé en écrivant les fiches d'aide (2026-09-23)

Écrire les quinze fiches a obligé à lire `features.md` section par section, et trois affirmations y sont
démenties par une AUTRE section du même fichier, ou par le code. Les fiches, elles, ont été écrites sur
l'état réel, vérifié ; c'est `features.md` qui reste à corriger.

- **Les droits du manager.** « Comptes & authentification » dit « Manager et agent ont les mêmes accès
  aujourd'hui ». « Sécurité & compliance » dit l'inverse, et le code tranche pour elle : la carte de la
  console range Paramètres et les quatre écrans de Sécurité en `encadrement`, donc un manager les voit.
- **Le journal des actions.** « Navigation » le place dans Paramètres. « Sécurité & compliance » dit qu'il
  en est parti, et l'écran Paramètres ne le porte effectivement plus.
- **Les outils de l'agent de Meta.** Sa section les décrit comme livrés (« Envoyer un bloc », « Lancer un
  scénario », la réponse « à côté »), et se termine par un « ⛔ Pas encore » qui les annonce à faire.

⚠️ **POURQUOI C'EST ICI ET PAS DANS LES FICHES.** Le bot d'aide ne lit pas `features.md`, il lit les fiches :
le risque n'est donc pas qu'il réponde faux aujourd'hui, c'est que la PROCHAINE fiche écrite depuis une
section périmée le fasse. 🔴 Et la garde de dérive ne peut rien y voir, par construction : elle compare une
fiche à SA section, jamais une section à la réalité.

## 🟡 Outils MCP de l'agent de Meta : les restes de la route A (livrée le 2026-10-02)

La route A est en production (plan `docs/superpowers/plans/2026-10-02-outils-mcp-agent-meta.md`, récit au journal du
2026-10-02). Restent, de sa relecture :

- **Le relais ne transmet pas l'abandon au résolveur MCP.** Passé `DELAI_REPONSE_MCP_MS`, le relais répond à Meta et
  journalise `timeout`, mais `src/agent/resolvers/mcp.ts` ne lit pas `entree.signal` : un outil d'écriture lent peut
  encore agir chez le serveur sans que l'agent le sache. Le budget de la session est déjà ramené à l'échéance.
- **Le câblage de « Donner à l'agent de Meta » (`proposerMcp`, `src/index.ts`) n'a pas de test d'intégration** : les
  tests de route passent par un faux, un câblage qui ne ferait plus que rattacher resterait vert. Et un
  rafraîchissement MCP concurrent peut, entre le rattachement et l'activation, laisser une ligne éteinte (que
  « Supprimer » retire).
- **Les gestes d'un outil MCP partagé ne sont pas joués par le relais** (ceux d'un connecteur HTTP non plus) : un
  geste réglé côté agent IA est muet côté agent de Meta, sans que rien ne le dise.
- **« Réactiver » un outil MCP éteint par un rafraîchissement ne montre pas ce qui a changé**, alors que la fiche d'un
  agent IA a `debranchesParRafraichissement`. La ligne dit désormais les deux causes possibles.
- **La description de repli** (« Outil <nom>. ») d'un outil MCP importé sans description : vérifier à l'essai que
  Meta l'accepte et que l'agent l'appelle quand même.

## 🟡 Outils MCP : les restes de la soirée du 2026-10-02 (outils enregistrés, Connecter, essai réel)

Relecture du lot « outils proposés » (`1b62b2fe`) : 0 rouge, 8 jaunes, dont deux corrigés dans « Connecter »
(`95f62099` : la lecture ratée n'est plus une liste vide ; « Donné à » se tait face à l'API d'avant). Restent :

- **Deux tests manquent** : les champs `propose`/`utilisePar` d'`outilsPourEcran` sur une vraie base, et
  `proposer` face à un espace voisin. (Le filtre de la section MCP d'un agent IA a disparu : la page affiche la
  liste `offrables` du serveur, règle unique du catalogue.)
- **La page Connecteurs MCP relit les outils de TOUS les serveurs à chaque nouvelle liste**, et deux fois le serveur
  importé. Mineur à l'échelle actuelle.
- **Un outil MCP qui prend une LISTE est « inutilisable »** (`aplatir.ts`) : `tag_conversation` de notre propre
  serveur en est un. À ouvrir quand un client en aura besoin.
- **Changer la source d'un paramètre ne republie pas** : vécu à l'essai, la garde d'identité n'a pris qu'après
  « À envoyer ». Republier tout seul après « Enregistrer les réglages » d'un outil donné à l'agent de Meta.
- **Le libellé « query string »** d'un paramètre est brut : « Paramètre query (texte), obligatoire : qui le
  remplit ? » proposé à Julien.
- **L'agent de Meta se tait sur un compliment** (« J'aime beaucoup ce que vous faites », 2026-10-02 18 h 00) : ni
  réponse ni passage à l'équipe. Comportement de Meta, à surveiller sur de vrais clients.

## 🟡 Plafond et tableau de l'agent de Meta : les restes (2026-10-02)

- **L'écriture du plafond ne laisse aucune trace** dans le journal d'audit, et remplacer un plafond posé ailleurs
  (`autres`, rendu par la route) ne se fait pas confirmer.
- **L'estimation de coût repose sur le prix public** (2 $ le million de jetons, 4 à 5 cents la réponse,
  `PRIX_MESSAGE_AGENT_USD` et `web/lib/api-mba.ts`, tenus égaux par `tests/mba-prix-parite.test.ts`) : à confronter
  à la facture de Meta avec Julien. Aucune API ne rend la consommation de l'agent (mesuré le 2026-10-02).
- **La carte « Agent de Meta » de Performance Lab s'affiche aussi pour un espace sans agent de Meta**, avec des zéros.

### Deux voisins trouvés dans la même page de Meta, à ne pas mélanger avec ce lot

- **`upsertOAuth` et `upsertCertificate` (mTLS) existent chez Meta**, nous ne savons poser qu'une clé d'API.
  ⚠️ Sous la route A c'est **sans objet** : Meta présente notre clé à notre relais. Ce qui manque est OAuth
  dans NOS connecteurs (`agent_tool_sources`), qui ne connaît que `none` / `bearer` / `header`, gravé dans un
  CHECK de la migration 0088. Zéro machinerie de renouvellement dans tout `src/` (pas un `refresh_token`, pas
  un `expires_in`) : l'OAuth HubSpot vit dans un AUTRE service. Écrit une fois, il servirait trois
  consommateurs (agent IA, bloc Appel HTTP d'un scénario, relais MBA). La migration RELAcHE un CHECK, donc
  **avant** le déploiement.
- **L'énumération d'`auth_type` de Meta liste six valeurs et la page dit que TROIS sont supportées**
  (`OAUTH2_CLIENT_CREDENTIALS`, `API_KEY`, `NONE`). Lire l'énumération sans lire la phrase mène à un refus à
  l'exécution.

## 🟡 Le reste du lot de retours de Julien du 2026-09-24

Le lot est livré pour l'essentiel (`7fef0a32`, `b9ae5070`, `7cce2924`, `b008edb0`, `05f96762`, `e65a112a`, plus
le lot de l'assistant). Ce qui suit est ce qui reste.

### 1. Deux gestes en attente du go de Julien

- 🔴 **`npm run aide:charger`** : la fiche d'aide du répondeur de Meta a changé DEUX fois le 2026-09-24
  (empreinte `5ebc5f` → `4ab4c2` → `d65ab5`). Tant qu'elle n'est pas rechargée, **le bot d'aide sert au client
  la version qui dit « Meta l'ouvre progressivement, par pays et par secteur »**, ce qui est faux. Ce script
  écrit dans la base de PRODUCTION depuis ce poste, hors de la garde de déploiement.
- 🔴 **Le déploiement de l'API** : la ligne « moyen de paiement » est retirée côté serveur
  (`src/mba/completion.ts`), donc elle reste affichée jusqu'au `up -d --build`.

### 1 bis. Le titre d'une carte RCS SIMPLE reste hors de portee de la console (2026-09-24)

⚠️ **Le modele l'accepte, aucun ecran ne sait le saisir.** `RcsCard.title` existe dans `src/rcs/types.ts` et
part bien chez smsmode (`toCardContent`), mais `RcsMessageForm` n'a pas ce champ : seules les cartes d'un
CARROUSEL portent un titre editable (`rcs-carte-N-titre`). Un client qui veut une carte simple titree doit
donc faire un carrousel d'une carte, ce que le formulaire refuse (deux au minimum).

🔴 **Trouve parce qu'un commentaire l'affirmait a tort**, dans `CreationMessageRcsEnLigne.tsx` : il disait
ouvrir le chemin vers « une carte a TITRE ». Corrige le 2026-09-24. C'est exactement le motif du depot,
une justification fausse est pire qu'aucune parce qu'elle sera recopiee, et elle l'avait deja ete dans le
message de commit `b008edb0`, qu'on ne peut plus corriger.

Le geste, s'il est decide : un champ titre dans `RcsMessageForm`, borne a 200 caracteres comme le schema le
prevoit deja (`rcsCardSchema`), et le `.refine` « titre OU media » devient atteignable sans image.

### 2. La question de vocabulaire est TRANCHÉE (2026-09-24), et mon chiffre était faux

**Julien : « Boutons » partout.** Fait en DEUX fois : `db292cf6` pour le libellé du champ, puis
`5d85f202` pour la description du canal, restée en « suggestions » jusqu'à ce qu'une relecture à froid la
trouve.

⚠️ **ET LE « QUATRE ÉCRANS » QUE CETTE SECTION ANNONÇAIT ÉTAIT FAUX.** `RcsMessageForm` et
`WorkflowConfigPanel` disaient « Boutons » depuis toujours, et l'éditeur partagé retombait lui-même sur
« + bouton ». Ce qui portait le mot de Google : le LIBELLÉ du champ de l'écran de campagne, et la
DESCRIPTION du canal RCS deux étapes plus tôt. Le chiffre avait été avancé pour évaluer un coût, il a servi
à décider, et il était faux dans le sens qui décourage.

🔴 **ET LE PREMIER BALAYAGE N'A VU QUE LE LIBELLÉ, PAS LE MOT**, d'où la seconde passe. Un renommage se
balaie sur le MOT, sans distinction de casse, sur tout ce que le client LIT, pas en comparant les libellés
des écrans entre eux.

⚠️ Corollaire trouvé en le faisant : le prop `libelleAjout` de `RcsButtonsEditor` n'existait que pour cet
appelant divergent. Son seul APPEL est parti avec le renommage (`db292cf6`, dans `EtapeContenu.tsx`), sa
DÉCLARATION deux commits plus tard (`310caf7a`, dans `RcsButtonsEditor.tsx`) : deux commits, deux fichiers,
sinon il restait une porte de sortie ouverte pour la divergence qu'on venait de refermer.

🔴 **ET CETTE PARENTHÈSE S'EST ACCUSÉE D'UNE FAUTE QU'ELLE N'AVAIT PAS COMMISE.** Elle disait que la ligne
avait « d'abord attribué son retrait à `db292cf6`, qui ne touche même pas ce fichier ». Deux erreurs : aucune
version de ce fichier n'a jamais nommé `db292cf6` ici (elle disait « parti avec lui », sans commit), et
`db292cf6` touche bien `EtapeContenu.tsx`. Une confession inventée est une fausseté de plus, pas une
réparation : un aveu se vérifie dans `git log -S` comme n'importe quelle autre affirmation.

### 3. Deux constats laissés porter

- Le diff de l'assistant du MBA reste en **tout ou rien**, là où celui d'un agent IA s'accepte ligne par ligne
  et s'édite. C'est une décision écrite dans le code (« UN SEUL BOUTON, ET PAS DE SECONDE CONFIRMATION »,
  2026-09-14) et Meta n'a ni corbeille ni annulation : la changer est un arbitrage produit, pas un alignement.
- `web/app/agents/page.tsx` : `avertissements` n'est toujours pas remis à `null` au changement d'agent.

### 4. L'entrée périmée du backlog, à nettoyer au prochain `/sync`

🔴 L'entrée « BUG — « Modèle et scénario » demande DEUX choix au lieu d'un » (2026-09-13) est **corrigée
depuis longtemps** : le sélecteur de modèle est conditionné à `formule === 'seul'`, et le modèle se déduit du
premier bloc du scénario par `firstTemplateOf`. Un 🔴 périmé dans un backlog coûte plus cher qu'une ligne
oubliée, parce qu'on le recroit.

## 🟡 Le reste du refactor des deux écrans d'agent (2026-09-23)

Le lot est livré, relu de bout en bout et déployé. Ce qui suit est ce qui reste, et **le premier point est
le seul qui touche du code**.

### 1. Deux `!` qui font compiler un câblage qui tomberait à l'exécution

`src/index.ts`, bloc `agents:`, deux lignes voisines (vers 1637) :

```ts
consommationAgent: (tenant, agentId, jours) => agentSessions.consommation!(tenant, agentId, jours),
messagesAgent:     (tenant, agentId, jours) => agentSessions.messagesTenus!(tenant, agentId, jours),
```

🔴 **CES DEUX `!` SONT REDONDANTS, ET C'EST LE MOINS GRAVE.** Mesuré par la relecture à froid de la session
voisine : `agentSessions` est construit par `new PgAgentSessionStore(pool)` **sans annotation de type**, et
la classe déclare `consommation` et `messagesTenus` en méthodes pleines. TypeScript n'a donc besoin d'aucune
assertion. Le motif écrit dans le plan du lot (« il est là parce que la méthode est optionnelle dans
l'interface ») ne s'applique pas à une référence de classe concrète.

⚠️ **Ce qui reste après le constat de redondance est un SILENCIEUX.** Le `!` continuerait de compiler le
jour où quelqu'un retype cette variable par l'interface `AgentSessionStore`, où les deux méthodes SONT
optionnelles. Le symptôme serait alors `is not a function` à l'exécution, sur un écran d'administration. Ce
n'est pas théorique : `src/workflow/executor.ts` type déjà un store par son interface.

**Deux façons de le fermer, et la seconde est la bonne** : retirer les deux `!` ferme le cas d'aujourd'hui ;
rendre les deux méthodes REQUISES sur l'interface `AgentSessionStore` (`src/agent/session-store.ts`) le
ferme structurellement et fait tomber les `!` d'eux-mêmes. ⚠️ La seconde touche `consommation`, donc du code
hors du lot : elle se décide, elle ne se glisse pas.

🔴 **`src/index.ts` EST UN FICHIER DE CÂBLAGE PARTAGÉ.** Annoncer à la session voisine avant de l'ouvrir, et
**construire le commit en plomberie** (`GIT_INDEX_FILE` temporaire, `read-tree origin/main`, `hash-object`,
`commit-tree`) plutôt qu'en `git commit --only`. Raison mesurée le 2026-09-23 : `--only` ne protège que si
le CONTENU du fichier est encore le sien, et le hook `rayon-de-souffle` AGRANDIT la fenêtre en ajoutant un
aller-retour entre la vérification du diff et le commit. Deux sessions y ont perdu du travail le même jour.

### 2. Un arbitrage qui attend Julien : la pastille de l'en-tête

Sur l'écran de l'agent de Meta, la pastille de l'en-tête montre l'état du **numéro**, pas celui de l'agent.
Sur un numéro sain dont l'agent est éteint, l'écran affiche donc un point vert à côté d'une ligne qui dit
que personne ne répond. Les textes ont été corrigés pour dire « l'état du numéro WhatsApp » ; le choix, lui,
reste ouvert. L'information qui manque vraiment serait l'interrupteur de l'agent, disponible dans les
réglages que l'onglet Activation lit déjà.

### 3. L'essai réel qui clôt la feature, et qu'aucun test vert ne remplace

Ouvrir les deux écrans, sur un agent complètement réglé et sur un agent vide, et vérifier quatre choses : le
bon logo de fournisseur, le nombre d'étapes restantes comparé à ce que les onglets contiennent vraiment, le
chiffre de messages comparé au Performance Lab sur la même période, et la colonne d'onglets sur un téléphone,
où elle doit redevenir la barre horizontale.

⚠️ **Le troisième point ne tombera PAS juste, et c'est attendu** : l'en-tête compte tous les messages des
conversations tenues, envois de campagne compris, là où le Performance Lab exclut les modèles sortants. La
légende l'avoue désormais. Ce qu'on vérifie est que l'écart va dans ce sens et dans cet ordre de grandeur,
pas qu'il est nul.

### 4. Trois constats mineurs laissés porter, relus par la revue suivante

- `web/app/agents/page.tsx` : `avertissements` n'est pas remis à `null` au changement d'agent, alors que
  `manques` et le chiffre le sont désormais. Une ligne, dans le même fichier, sous le commentaire qui la
  réclame.
- `web/components/EnteteAgent.tsx` : `key={e.message}` suppose des messages d'étape uniques.
- La fixture e2e de la complétion MBA décrit un état qui ne peut pas exister en vrai (un total de deux sans
  les compétences ni l'activation). C'est ce genre d'approximation qui avait laissé passer la disparition de
  la ligne « moyen de paiement ».

## 🟠 Pré-câbler la route Azure OpenAI France, sans bouton ni promesse prématurée (2026-09-21)

**Décision de Julien :** Vercel AI Gateway reste le chemin ordinaire. Pour un contrat dont le RSSI exige une
inférence OpenAI en France, Messaging Me doit pouvoir appeler directement un déploiement Azure OpenAI régional
France. Le choix est posé manuellement par l'exploitation pour l'espace ; il n'y a pas de toggle dans
l'interface client. Source d'architecture et limites : `docs/ARCHITECTURE-CIBLE.md`, §2.1.

**Aujourd'hui ce n'est PAS vrai en production.** `GatewayChatClient`, le catalogue, les clés par espace et le
coût sont spécifiques à Vercel. La documentation RSSI doit dire « option architecturée, non activée » jusqu'à
la recette réelle.

Lot borné à livrer, sans refonte générale :

1. **ne pas créer une seconde boucle d'agent ni une interface en doublon** : la couture existe déjà dans
   `GatewayBrainDeps.completer` (`src/agent/brain.gateway.ts`) et dans les injections de `src/index.ts` et
   `src/worker.ts` ; rendre au besoin ses types neutres, sans changer son comportement ;
2. conserver `GatewayChatClient` et ses tests sans changement fonctionnel pour la route Vercel ;
3. ajouter un client Azure OpenAI qui satisfait le même contrat structurel et réutilise les briques existantes
   de transport, timeout, retries et erreurs au lieu de les recopier ;
4. résoudre la route d'un espace une seule fois derrière ce contrat, puis injecter le même résolveur dans le
   bac à sable (`agentTest`) et le worker de production ; **ne pas** basculer par effet de bord l'assistant de
   construction, le bot d'aide, la traduction, les embeddings, le reranking ou les analyses ;
5. conserver Vercel par défaut et rendre le choix modifiable seulement par l'exploitation ; réutiliser le
   chiffrement de secrets existant plutôt que créer un deuxième coffre applicatif ;
6. pour Azure, configurer endpoint, nom de déploiement, type de déploiement et authentification ; l'API v1
   attend le nom du déploiement dans `model`. Revalider le modèle disponible en France au moment de l'achat ;
7. calculer le coût Azure depuis les jetons avec un tarif de déploiement versionné, puisque
   `provider_metadata.gateway.cost` est propre à Vercel ; ne pas modifier le débit Vercel ;
8. interdire tout fallback automatique Azure -> Vercel pour un espace France ;
9. journaliser fournisseur, région et déploiement sans prompt ni secret ;
10. tester la parité bac à sable/production, les appels d'outils, la non-régression Vercel, les erreurs et
    l'absence de fallback ;
11. avant de déclarer l'option disponible, faire un smoke test sur une vraie ressource Azure **de type
    Standard/Régional ou provisionné régional en France** et archiver région, modèle, DPA et résultat. Un
    déploiement Global ou Data Zone UE créé dans `francecentral` ne prouve pas un traitement en France.

**Périmètre à ne pas inventer :** ce premier lot peut couvrir seulement les tours conversationnels. Assistant
de construction, embeddings, reranking, transcription, traduction et analyses restent à inventorier. On ne
répond « tous les traitements IA restent en France » que lorsqu'ils sont tous couverts et testés.

## 🟠 Configurer et prouver Cloudflare Pro, sans casser les webhooks (2026-09-21)

**Décision de Julien :** Cloudflare Pro est retenu pour `api.messagingme.app` et `mba.messagingme.app`.
`engageme.messagingme.app` reste directement chez Vercel. L'abonnement seul ne ferme aucun écart RSSI : ce
sont la configuration, la fermeture de l'origine et les preuves qui comptent. Source :
`docs/ARCHITECTURE-CIBLE.md`, §7.3 à §7.7.

**Déjà acquis, ne pas refaire :** `api.messagingme.app` et `mba.messagingme.app` sont déjà proxifiés ; l'origine
VPS refuse l'accès direct et le vrai chemin Meta a été éprouvé le 2026-09-21 (`DEPLOY.md`, lignes 15 à 41).
Les plafonds applicatifs existent déjà par clé sur `/v1`, `/mcp` et `/mba/relais/outils/*`, et par code sur
`/w/:code`.

Reste à faire, par petits changements réversibles :

1. relever l'état du compte Cloudflare ; si ce n'est pas déjà acquis, imposer MFA, comptes nominatifs et
   moindre privilège. Une configuration déjà active devient une preuve, pas un chantier à refaire ;
2. vérifier si le **Cloudflare Managed Ruleset** est déjà actif ; sinon l'activer avec ses actions par défaut,
   relire les faux positifs, puis ne
   durcir que les règles comprises ; laisser l'OWASP Core Ruleset éteint tant qu'une mesure ou une exigence
   ne justifie pas son bruit supplémentaire ;
3. ne pas chercher à « consommer » les deux règles de rate limiting parce qu'elles sont incluses. Pro compte
   seulement par IP et ne sait ni compter par clé API, ni reproduire les quotas par espace ; ses compteurs ne
   sont pas exacts à la requête près. Deux candidats réels existent, à activer seulement avec des seuils
   mesurés :
   - un fusible large sur l'API externe : `/v1/*` sur `api.`, son ancien chemin `/api/backend/v1/*` sur
     `mba.`, et `/mcp` sur `mba.`. Inclure `/mcp`, oublié dans la version précédente du lot ;
   - les chemins d'authentification anonymes qui écrivent : `/auth/login`, `/auth/choose-workspace`,
     `/auth/google`, `/auth/signup`, `/auth/forgot-password`, `/auth/reset-password` et
     `/auth/invitations/accept`. Ne pas inclure `/auth/config` ni tout `/auth/*` en bloc ;
4. pour l'auth, compter largement par IP au bord sans remplacer les limites applicatives par discriminant.
   `engageme.` ne relaie pas ces appels : le navigateur appelle `api.` directement, donc Cloudflare voit bien
   l'appelant. Prévoir le cas d'une entreprise entière derrière une IP partagée et préférer un refus HTTP à
   un challenge susceptible de casser un appel `fetch` ;
5. n'appliquer **aucun challenge navigateur** à un appel machine à machine, y compris `/v1/*`, `/mcp`,
   `/webhooks/meta`, `/rcs/callback/*`, `/w/*`, `/hubspot/deal-stage` et `/mba/relais/outils/*`. Une exception
   WAF se limite à la règle qui produit un faux positif : ne jamais désactiver tout le WAF sur ces chemins ;
6. avant un blocage, éprouver les chemins publics réellement utilisés, y compris leurs variantes historiques
   sous `mba.messagingme.app/api/backend/*` : vrai message Meta entrant, vrais statuts, rappel RCS, webhook
   entrant, relais HubSpot/MBA, `/v1`, `/mcp`, lien `/r/*` et média `/m/*` ;
7. préserver la fermeture actuelle du VPS et sa preuve ; ne la reconfigurer que si elle régresse. À la bascule
   Scaleway seulement, vérifier que le nom technique du conteneur refuse un appel sans authentification
   d'origine avant de changer le DNS ;
8. distinguer les preuves : les **Audit Logs** retracent les changements de configuration Cloudflare ; les
   **Security Events** montrent le trafic filtré mais leur rétention Pro est courte. Conserver captures et
   exports de configuration, tandis que les journaux durables restent aujourd'hui dans Messaging Me et, après
   la migration seulement, dans Cockpit ;
9. ne pas acheter Cloudflare Business/Enterprise, Bot Management ou un second WAF Scaleway sans exigence ou
   incident précis.

## 🟡 Deux écarts que la revue finale du déploiement a laissés porter (2026-09-23)

Rapport : `docs/prive/REVUE-FINALE-2026-09-23-deploiement.md`. Aucun des deux n'est un défaut du lot relu, et
c'est pour ça qu'ils sont ici plutôt que corrigés dans la foulée. Le troisième jaune de cette revue (le puits
de tarifs en queue de paramètres optionnels) a été CORRIGÉ le jour même, en `PuitsAccuses`.

- **`bilanContact` exclut les 72 h gratuites mais ne porte pas les gardes de livraison** des autres lectures de
  coût (`status = 'sent'`, livraison non `failed`, canal WhatsApp). L'écart est ANTÉRIEUR au lot 1 des pubs et
  DÉCLARÉ dans le code, pas caché. 🔴 **Le fermer change un chiffre que le client voit**, donc ça commence par
  une MESURE sur les vraies données (combien de contacts changent de total, et de combien), jamais par le
  correctif : un écran de coût qui bouge sans explication est pire qu'un écart documenté.
- **`limiteCouteuse` est un paramètre OPTIONNEL dans huit modules de routes** (`agent-knowledge`, `agent-mcp`,
  `campaigns`, `contacts`, `import`, `inbox`, `embeddedSignup`, servis par `gardeEtendue`). ⚠️ **Ce n'est PAS
  le cas de la garde d'authentification, fermé le 2026-09-15**, et la nuance décide de la priorité :
  `gardeEtendue` pose TOUJOURS son `preHandler`, donc un oubli coûte le plafond de débit par espace, jamais le
  contrôle d'accès. À trancher pour les huit ENSEMBLE ou pour aucun : rendre le paramètre requis sur un seul
  module laisserait croire que les sept autres sont gardés.

## 🟡 Un carrousel RCS dans un scénario (lot 3 de la spec du 2026-09-21)

La bibliothèque compose des carrousels et l'assistant de campagne les envoie ; le bloc « Message RCS » d'un
scénario les propose GRISÉS (« pas encore dans un scénario »). Cadré dans
`docs/superpowers/specs/2026-09-21-carrousel-rcs-design.md` § « Lot 3 », trois pièces :

- **le message ENTIER dans le bloc** : `rcsOutboundOf` (`src/workflow/executor.ts`) reconstruit aujourd'hui
  un texte ou une carte depuis trois champs (`text`, `imageUrl`, `suggestions`), qui ne portent pas de cartes ;
- **une sortie par bouton Réponse de chaque carte**, comme le carousel WhatsApp le fait déjà pour un modèle ;
- **`normaliserPostbacks` réécrit les boutons d'un carrousel en `card:<i>:btn:<j>`**, la forme que l'exécuteur
  route déjà pour le carousel WhatsApp. ⚠️ Il LAISSE les carrousels tels quels aujourd'hui, et leurs
  `postbackData` enregistrés (`carte<i>_btn<j>`, dérivés à la saisie) peuvent se RÉPÉTER d'une carte à l'autre
  après un retrait de carte : sans effet tant que rien ne route dessus, mais c'est bien la réécriture à
  l'envoi qui doit trancher, pas la valeur stockée.

Relevé à côté, et antérieur au carrousel : un envoi de CAMPAGNE RCS en carte ou en carrousel s'inscrit dans le
fil d'Inbox sous le libellé « Message RCS » (`rcsCampaignBody`, `src/campaign/engine.ts`, qui ne lit que le
texte d'un message texte), quand l'envoi depuis l'Inbox dit déjà son contenu (`apercuRcsSortant`). Brancher
`rcsCampaignBody` sur `parseStoredRcsOutbound` puis `apercuRcsSortant` alignerait les deux chemins.

Relevé par la revue finale du 2026-09-21 : `web/components/InboxRcsPanel.tsx` (vers les lignes 147 et 166)
affiche « il ne peut pas partir » pour un message RCS incomplet, mais le bouton d'envoi reste ACTIF.

## 🟡 Outils maison de l'agent de Meta : ce qu'ils laissent derrière eux (2026-09-21)

Chantier : spec `docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md`, plan
`docs/superpowers/plans/2026-09-21-outils-maison-mba.md`.

- 🟡 **La suppression d'un agent tient ses connecteurs PARTAGÉS pendant toute sa cascade**, et cette cascade n'a
  pas d'index qui la serve : `agent_tool_calls` n'en a aucun qui commence par `session_id` ni sur `tool_id`,
  `agent_credit_mouvements.session_id` non plus (0086, 0087). Pendant ce temps, les appels d'autres agents et du
  relais de l'agent de Meta sur ces connecteurs ATTENDENT. ⚠️ Côté Meta, attendre n'est pas anodin : l'appel du
  relais a son propre délai, donc une cascade longue fait ÉCHOUER l'outil dans une conversation client. Sans effet
  aujourd'hui, mesuré en base le 2026-09-22 : un seul agent (en brouillon), zéro session, cinq appels journalisés,
  tous sans session. Le temps n'est pas borné pour autant, et le verrou ne peut pas être raccourci (le prendre après
  la cascade était l'interblocage n°3). **Déclencheur** : avant la mise en service du premier agent IA d'un client,
  ou dès qu'un `remove` mesuré dépasse une seconde. À faire alors : mesurer `PgAgentStore.remove` sur un agent
  chargé, puis un index `agent_tool_calls (session_id)` (migration hors transaction, et une écriture de plus sur
  le chemin chaud du journal, à peser).
- 🟡 **Un nom d'outil déjà pris ne se signale qu'à l'enregistrement** (plan, écart 5) : la route rend 409 et le
  formulaire reste ouvert, mais la spec § 9.4 le voulait à la saisie. Un contrôle exact demande de lire TOUS les
  outils de l'espace sans agent (connecteurs des agents IA compris, `agent_tools_nom_espace_uidx`), pas la seule
  liste de l'onglet : sinon il promettrait un nom libre qui ne l'est pas. Et depuis 0211
  (`atc_nom_par_consommateur_uidx`), les autres outils de chaque consommateur concerné : les actions et les appels
  de l'agent à une création, CHAQUE consommateur de l'outil à un renommage.
- 🟡 **L'assistant de construction ne voit plus un outil dont l'agent porte déjà le nom, et ne peut pas dire
  pourquoi** (relecture du lot 2 de 0211, 2026-10-06). `catalogueBranchable` écarte une offre `nomPris` : si c'est le
  seul outil, l'assistant lit une bibliothèque vide. C'est le choix déjà fait pour un outil inappelable ; pour le
  corriger, garder l'outil dans la liste avec l'état « nom déjà pris, à renommer » et le refuser dans `brancheables`.
- 🟡 **Dans la bibliothèque entière, `nomPris: false` veut dire « non calculé »** (publié par
  `GET /tenants/:id/agent-tools`), et ne se distingue pas d'un nom libre. Un type d'offre réservé à `offrablesPour`
  l'en retirerait.
- 🟡 **L'application d'une proposition de l'assistant branche HORS du `try` qui dit « La fiche est enregistrée »**
  (`web/lib/api-agent-setup.ts`, préexistant) : un refus tardif (une course, une source éteinte entre la proposition
  et le clic) remonte sans cette phrase. Le cas symétrique de 0211 n'est pas écarté en amont non plus : une ACTION
  proposée (`mba_*`) dont un connecteur de l'agent porte déjà le nom, que ce `try` rattrape lisiblement.
- 🟡 **DÉCISION ATTENDUE (Julien) : un outil MCP disparu de son serveur ne se supprime plus qu'avec toute sa
  source.** Le retrait de `DELETE /agent-tools/:outilId` (lot 2, avec l'ancienne bibliothèque) a emporté le seul
  geste qui l'effaçait seul ; un outil MCP disparu est marqué (`mcp_indisponible_le`), jamais supprimé, et la
  règle des orphelins l'épargne exprès. Deux voies : l'effacer au dernier détachement quand il est marqué
  disparu, ou rendre un bouton dans Tools > Connecteurs MCP. Sans enjeu tant qu'aucun serveur MCP n'est branché
  en production.
- 🟡 **L'outil `envoyer_bloc` des AGENTS IA accepte n'importe quel bloc quand sa liste est vide**, alors que
  l'écran annonce « aucun » (`src/workflow/executor.ts`, `envoyerBlocDepuisAgent` ; la liste vit dans
  `agent_tools.params`). Relevé en cadrant les outils de l'agent de Meta (spec § 12).
- 🟡 **Et il ne vérifie pas la fenêtre de 24 h avant d'envoyer** (même fonction) : Meta refuse alors en 131047,
  après coup. Le relais de l'agent de Meta, lui, la vérifie avant de prendre le fil (lot 3).

## 🟡 Relais du MBA : ce qu'il laisse derrière lui (2026-09-21)

- **Les appels de publication à Meta n'ont pas de délai propre** (`MbaClient.appel`, `src/mba/client.ts`) :
  une Meta muette tient le verrou de publication d'un espace jusqu'au délai par défaut de Node (300 s par
  appel), et l'écran répond « une publication est déjà en cours » pendant ce temps. Et le bail du verrou (en base
  depuis le 2026-09-28, `BAIL_PUBLICATION_MS`) est de dix minutes : au-delà de deux appels muets, il échoit et une
  seconde publication peut partir. Poser un `AbortSignal.timeout` sur les appels de publication, sans toucher à
  `agent_test` (lent par nature), permettrait de raccourcir ce bail.
- **Le plafond du relais est celui d'une clé d'API : 60 appels par minute** (`API_KEY_RATE_LIMIT_MAX`), pour
  TOUS les appels d'outils de l'agent de Meta d'un espace. Au-delà, Meta reçoit un 429, pas un
  `succes: false`. Suffisant aujourd'hui ; à dimensionner avec le premier client à fort trafic.
- **Les refus du relais ne laissent aucune ligne de journal** (outil non proposé, numéro absent, contact
  introuvable, valeur invalide). Une fois `journaliserForme` retiré, une macro jamais remplie serait invisible
  côté produit : journaliser ces refus (appelant `mba`, statut `refuse`) avant de retirer la mesure.

- **`agent_tool_sources.secret_publie_le` et `marquerSecretPublie` sont morts** : le secret d'un client ne part
  plus chez Meta. Les retirer (migration qui RETIRE une colonne, donc APRÈS le déploiement du relais).
- **La contrainte de nom « comme Meta » sur les sources n'a plus de raison d'être** (`NOM_CONNECTEUR_META_RE`,
  `nomPubliableChezMeta`) : seul `EngageMe` part désormais chez Meta. Vérifier si un écran l'impose encore
  au nom d'un connecteur API, et la retirer.
- **`listConnectorTools` caste la réponse de Meta** (`r as T[]`, `src/mba/client.ts`) au lieu de la valider :
  le plan la compare, un `safeParse` la rendrait sûre.
- **Relayer les outils MCP** : même route, résolveur MCP à la place de `creerAppelConnecteur` (hors du
  chantier du 2026-09-21, arbitrage de Julien).

## 🟡 La facturation qui lira `agent_tool_calls` devra exclure `source = 'signaux'` (lot 6 de l'API publique, 2026-09-24)

`agent_tool_calls` est AUSSI le grand livre de facturation (commentaire de la migration 0086 : « c est la meme
table, volontairement »). Depuis le lot 6, la remontée des signaux vers l'outil d'un client y écrit ses poussées
RATÉES (`source = 'signaux'`, une ligne par tranche refusée ou par succès partiel ; 401 et 403 suspendent la
remontée au lieu d'écrire une ligne par signal). Ce ne sont PAS des appels d'outil facturables.

- **Le geste** : le jour où une requête de facturation lit cette table, elle exclut `source = 'signaux'`, et un
  test le garde (une ligne `signaux` écrite, relue, et absente du compte facturé).
- ⚠️ **Piège ARMÉ, pas une fuite ouverte** : aucune facturation ne lit la table aujourd'hui, son seul lecteur est
  le journal des erreurs (`PgErreursLivraisonStore.listerEchecsSysteme`).
- ⚠️ **Et la table n'est jamais purgée** : si un espace branché accumule des refus (un identifiant de profil
  refusé par l'outil, fiche après fiche), les lignes s'additionnent. À surveiller à la première mise en
  production d'un client branché, pas à anticiper.

## 🟡 API publique : ce qui manque encore (mémo d'architecture du 2026-09-19, décision du 2026-09-21)

Les trois premiers points viennent du mémo, dont le reste est fusionné dans `docs/ARCHITECTURE-CIBLE.md` : ils
n'y ont pas leur place (ils ne dépendent pas de la bascule) et n'étaient consignés nulle part. Le quatrième
vient d'une décision de Julien.

- ✅ **Les quotas quotidiens par espace sont posés** (2026-10-05, `src/api/quotas.ts`, `ARCHITECTURE-CIBLE.md` § 13.1) :
  2 000 envois et 20 000 fiches par jour. Ce qui reste, de la relecture du lot :
  - **Compter le quota d'un envoi APRÈS le `claim` d'idempotence** : aujourd'hui un rejeu, ou une relance qui tombe
    sur un envoi en cours (409), consomme `recipients.length` (documenté publiquement). Le faire demande de libérer la
    clé si le quota refuse ensuite : sur le chemin d'envoi, donc en lot à part.
  - **Le 429 de quota de bout en bout sur `/v1/sends` et `/v1/messages/*`** : la famille de chaque opération est testée,
    pas l'opération que chaque route déclare (seul `/v1/contacts` l'est, par le vrai câblage).
  - **Le compte du jour dans `GET /ops/plafond-api`** : la consommation n'est pas visible ; on ne sait qu'un espace a
    atteint son quota que par l'alerte (une par espace, famille et jour).
- **L'usage de `/v1` ne vit que deux heures** (`/ops/usage`, en base depuis le lot B du 2026-09-28 :
  `compteurs_debit`, une écriture par appel ACCEPTÉ, bornée par le plafond de l'espace), et rien n'alerte sur une
  série de `429`, l'épuisement du préfiltre ou la saturation des opérations lourdes. À faire : des agrégats par
  minute gardés plusieurs jours (allonger `minutesGardees` suffit désormais, au prix de la taille de la table), et
  une alerte throttlée. ⚠️ **Jamais une ligne SQL par requête hostile** (le préfiltre et les budgets de codes
  inconnus restent en mémoire pour ça), et jamais la clé ni son empreinte dans un journal.
- **Un geste de publication plus long que le bail** (relecture du lot A, jaune 2, traité en partie le
  2026-09-28) : le bail de dix minutes est désormais PROLONGÉ avant chaque geste, et une publication qui l'a perdu
  s'arrête. Reste ouvert : un SEUL geste qui durerait plus de dix minutes (plusieurs appels à Meta de 300 s dans le
  même geste) laisserait échoir le bail pendant qu'il tourne. Si cela arrive un jour, un bail entretenu par une
  minuterie pendant la publication fermerait le cas ; aujourd'hui aucun geste n'en approche.
- **Aucun moyen de lire QUEL commit tourne** en production. Un identifiant de build dans `/ops/overview`
  (pas dans une réponse publique). C'est aussi un test d'acceptation de la bascule (`ARCHITECTURE-CIBLE.md`
  § 11).
- **L'opération lourde est UNE pour tout le process, tous clients confondus** (`API_MAX_LOURDES_SIMULTANEES`,
  gardée ainsi par décision de Julien du 2026-09-21). Pendant le lot d'un espace, l'opération lourde d'un AUTRE
  reçoit un 429. Sans conséquence avec un seul intégrateur ; le jour où deux se croisent, il faudra une file
  d'attente courte ou un partage équitable, sans jamais relever le plafond au-delà de la moitié du pool.

## 🟡 API publique, lot 1 : quatre restes que la relecture a laissés hors du lot (2026-09-24)

Relevés par la relecture du lot 1 (identité et fiches), hors de ses fichiers. Aucun ne touche un client
aujourd'hui ; chacun rend faux, à moitié, ce que le lot affirme.

- **`/mcp` rend encore deux refus 401 sans `code`** (`src/http/mcp.ts`, les deux `if (!tenantId)` de `POST` et
  `GET /mcp`). Inatteignables tant que la garde de clé est montée devant, mais la même situation passée par
  `compterOuRefuser` rend `unauthorized`, et `src/auth/rate-limit.ts` affirme que `/mcp` porte le code. À
  aligner par `refuser(reply, 401, 'unauthorized', …)` (`src/api/erreurs.ts`), au plus tard au lot 4, qui
  documente les erreurs.
- **Le parseur JSON est GLOBAL et avale tout corps illisible en `{}`** (`src/webhooks/receiver.ts`, posé pour
  le webhook Meta). Un `POST /v1/contacts` au corps `{bad` passe donc la validation : il rend `invalid_recipient`
  au lieu de `invalid_body`, et il est compté dans l'usage ; un `PATCH` illisible devient « rien à modifier ».
  Correction : ne rendre `{}` que pour `/webhooks/meta`, ailleurs `done(err)` avec un statut 400, et faire
  rendre aux adresses `/v1/*` `{ error: 'corps JSON illisible', code: 'invalid_body' }` dans `setErrorHandler`.
  Un test de route le fixe : `payload: '{bad'` rend 400 `invalid_body` sans que le service soit appelé.
  ⚠️ **La documentation de l'API décrit ce comportement tel qu'il est** (page « Authentification, limites et
  erreurs », `web/app/developers/api/reference/page.tsx`, section « Erreurs », avec le 415 sans `code` d'un corps
  qui n'est pas du JSON, mesuré le 2026-09-25) : la corriger dans le même commit que le parseur, sinon elle
  mentira dans l'autre sens.
- ~~**La puce de `documentation.md` qui suit les trois ajoutées au lot 1**~~ **FAIT le 2026-09-25** (lot 4,
  tâche 8) : l'API publique y crée en `unknown`, sauf `consent` explicite, et sait écrire `opted_out` comme
  `opted_in`.
- **Le cache de joignabilité RCS porte un même numéro sous DEUX formes** (`+33…` écrit par les campagnes et
  par les rapports de livraison, `traiterRapportRcs` ; chiffres seuls par les scénarios et la réponse RCS de
  l'Inbox). DEUX lecteurs lisent les deux formes, la plus récente gagnant (`joignabiliteRcsToutesFormes`,
  `src/rcs/reachability.ts`) : la fiche de l'API (`GET /v1/contacts`) et, depuis `d7791116`, l'envoi RCS libre
  d'une machine (`envoyerRcsLibre`, donc `POST /v1/messages/rcs`). ⚠️ **Le lot 3 s'est clos SANS l'écriture
  unique qu'il prévoyait** : elle reste à faire (une forme unique à l'écriture, sans casser les entrées déjà
  écrites sous l'autre). D'ici là, tout nouveau lecteur du cache passe par `joignabiliteRcsToutesFormes`.

## 🟡 API publique, lot 4 : un refus de Meta sort SANS `code` (décision de spec, réservée à Julien, 2026-09-25)

Relevé par la relecture du lot 4. Le plan affirmait « 5xx sans corps » ; le code dit autre chose, et la
documentation de l'API dit désormais la vérité (page « Authentification, limites et erreurs », section « Erreurs »,
`web/app/developers/api/reference/page.tsx`), figée par `tests/v1-catalogues.test.ts`.

- **Ce qui se passe** : le gestionnaire global (`setErrorHandler`, `src/server.ts`) rend une `MetaApiError` en
  422 `{ error: "Meta: …" }` SANS `code`, et toute autre exception (panne réseau vers Meta comprise) en 500
  opaque, qu'un proxy peut remplacer par sa page. Deux routes publiques y passent aujourd'hui :
  `GET /v1/templates` (la liste du WABA) et `POST /v1/messages/whatsapp` (l'envoi du texte).
- **La décision** : un code dédié (un pour la panne, un pour le refus, ou un seul), sous un statut qu'aucun
  proxy ne réécrit, élargirait le § 9 de la spec et `CodeApi` (`src/api/erreurs.ts`),
  donc la table de la page, que `tests/api-exemples.test.ts` tient égale à `CodeApi`. Rien n'est fait tant que
  Julien n'a pas tranché ; le jour venu, les deux cas « panne de Meta » de `tests/v1-catalogues.test.ts`
  tombent, et la page avec eux.
- **Même lot, à savoir** : le catalogue des templates écarte un bouton de lien à variable qui n'est pas un lien
  tracé à jeton, en reconnaissant la FORME de nos liens (`estLienTraceAvecJeton`, `src/links/rewrite.ts`),
  quand l'envoi lit `tracked_links`. Les deux ne divergent que pour une adresse étrangère qui imiterait
  exactement `/r/<code de 12 caractères>/{{1}}`. La parité stricte demanderait une lecture de `tracked_links`
  câblée dans `src/index.ts`, hors du périmètre du lot.

## 🟡 `inbox-envoi-scenario.spec.ts` est INSTABLE, mesuré le 2026-09-19

Les cas `:112` (« fenêtre FERMÉE -> seuls ceux qui ouvrent par un template ») et `:169` (« un refus du serveur
s'affiche avec sa raison ») sortent « flaky » (passés à la reprise) dans **4 runs de la CI de la console sur
12** entre le 2026-09-18 matin et le 2026-09-19. Deux de ces runs sont ANTÉRIEURS au chantier Inbox du 19 : il
n'en est donc pas la cause. `securite-navigation.spec.ts` (« brancher un connecteur sur le consentement ») et
`agents-connaissance` apparaissent aussi, plus rarement. À instrumenter avant d'en chercher la cause ; ne pas
affaiblir le test pour le faire taire.

Mesuré le 2026-09-21 en local, sur un build de production et deux suites complètes à quatre workers : `:112`
tombe une fois sur deux suites, et `performance-intentions.spec.ts:104` (« une intention BRICOLEE dans
l'adresse ne pose aucun filtre ») aussi, une fois. Les deux passent **8 sur 8** relancés seuls
(`--repeat-each 4`). Même signature que ci-dessus : une contention, pas une régression.

## 🟡 Une fiche d'aide ne dit rien du rôle MANAGER

La fiche `repondre-dans-l-inbox` a été relue le 2026-09-19 (Traité, pièces jointes, « Je m'en occupe »), mais
aucune fiche ne dit ce qu'un manager peut faire dans Paramètres : la carte du bot le mène à l'écran
(`acces: encadrement`), sans texte qui explique qu'il n'y trouvera qu'un réglage.

## 🟡 `queue-group-concurrency` est INSTABLE, mesure le 2026-09-18

`tests/integration/queue-group-concurrency.integration.test.ts` a echoue sur le commit `f8c32b8b`
(`AssertionError: expected false to be true`, 15 652 ms), puis le REJEU DU MEME COMMIT est passe. Meme
code, deux verdicts : c est la definition d une instabilite, pas un defaut du commit, qui ne touchait que
des `.md`, la migration 0154 et deux tests de prix.

⚠️ **NI AFFAIBLI NI RETIRE, ET LA MESURE RESTE A FAIRE.** La regle du depot est de QUANTIFIER une
instabilite sur la reference avant de s en attribuer la cause, jamais de l affaiblir pour la faire taire.
Ce qui est mesure aujourd hui : 1 echec sur 2 executions du meme commit, et 8 runs verts sur les commits
precedents. C est assez pour dire « instable », pas assez pour dire « une fois sur combien ».

Le test dort 250 ms dans son gestionnaire et court contre un vrai pg-boss, avec un plafond de 25 s : il
depend de l ordonnancement d un Postgres ephemere de CI. Piste a instruire : ce qu il affirme (« borne la
concurrence par tenant sans affamer les autres ») se verifie peut-etre sur les COMPTEURS d appels plutot
que sur une fenetre de temps, ce que le test unitaire voisin (`tests/queue-group-concurrency.test.ts`) fait
deja avec un faux.


## 🟡 Ce que les six revues du Performance Lab ont laisse porter (2026-09-18)

Aucun ne bloque le deploiement, la sixieme revue l a tranche explicitement. Ils sont ranges dans l ordre ou
elle recommande de les prendre.

- **La phrase additive de la carte « Facture par Meta » n est couverte par AUCUN test**, ni unitaire ni
  e2e : la version fautive, celle qui BRANCHAIT entre les deux phrases au lieu de les cumuler, passerait la
  suite a l identique. `web/e2e/quantitatif-sous-onglets.spec.ts` simule deja `/stats/templates` : y poser
  `margeTemplate: 150` et affirmer la presence des DEUX phrases coute trois lignes. Plus un cas unitaire
  `fmtPourcent(120.5, 'fr') === '120,5 %'`.
- **`fmtPourcent` met une espace avant le `%` dans les DEUX langues**, alors que `fmtPct`, deux fonctions
  plus haut dans le meme fichier, documente et applique la convention inverse (« 42 % » en francais,
  « 42% » en anglais). L anglais rendra donc « your 150 % margin » a cote de « 42% » sur la meme page. Elle
  teste aussi `locale === 'fr'` avec `en-US` la ou le reste du fichier teste `locale === 'en'` avec `en-GB`.
- **Le cas « la marge est celle de l espace du JETON » ne discrimine pas** : `scopeTenant` rend `null` des
  que les deux different, donc les deux valeurs sont toujours la meme chaine quand la route continue. Ce
  qu il prouve reellement, et c est reel, c est qu un espace refuse ne declenche AUCUNE lecture. Le
  renommer, ou monter un jeton dont le tenant differe.
- **`tests/prix-grille.test.ts` passe la marge en CHAINE mais n assert jamais dessus** : le cas annonce
  couvrir « sa forme reelle » et ne le prouve pas. Une ligne, `expect(g.margeTemplate).toBe(120.5)`.
- **`/stats/templates` lit `tenant_settings` DEUX fois par appel**, une fois dans `getPricing` et une fois
  pour la marge. Le cout est nul (cle primaire, une ligne par espace), mais les deux lectures peuvent
  encadrer un `PATCH` de la grille et afficher une marge qui n est pas celle qui a servi au prix. Deriver
  la marge de la meme lecture que `getPricing` ferme les deux.
- ✅ **LA DEVISE EST TRANCHEE : TOUT EST EN EUROS** (Julien, 2026-09-23). La question se posait parce que la
  grille RCS est saisie en centimes d euro pendant que les tarifs de Meta arrivent dans la devise de
  facturation du WABA, et que les deux s additionnent. Reponse : tous les WABA sont en euros, on n ajoute
  aucune garde, aucune conversion, aucune colonne de devise. ⚠️ Ce qui rendrait la question VIVANTE, et donc
  ce qu il faut surveiller : un premier client dont le WABA facture dans une autre devise. Ce jour-la,
  l addition ne serait dans AUCUNE devise, et l ecran l etiquetterait avec celle de Meta.
- 🟡 **`flagUnreachable` N EST NEUTRALISE QU AU NIVEAU DE L INSTANCE, PAS DE L ESPACE** (releve au lot 9, le
  2026-09-23, laisse dehors par decision de Julien). Le balayage de relance ecrit « injoignable » dans
  HubSpot au second echec 131026. Quand `HUBSPOT_SERVICE_URL` est absente, il devient un no-op qui REUSSIT,
  ce qui est juste. Mais sur une instance qui A le connecteur, un espace SANS portail lie appelle quand meme
  mm-hubspot. Ce qu il faut verifier avant de decider : l appel echoue-t-il ? Si oui, `markUnreachableDone`
  n est jamais atteint et le destinataire est reliste a CHAQUE tour de balayage, pour toujours. ⚠️ Ce n est
  pas un correctif d affichage : il toucherait un chemin que la production emprunte, et lire le portail par
  contact injoignable coute une requete de plus (ou un cache, donc une invalidation).
- 🟡 **L ACTION « METTRE A JOUR UN CHAMP HUBSPOT » RESTE A FAIRE, ET ELLE COMMENCE DANS `mm-hubspot`** (lot 9,
  seconde moitie). Elle demande une route generique d ecriture de propriete dans le depot voisin, seul
  detenteur du jeton HubSpot, PUIS le branchement du bloc action ici. Rien n a ete ecrit ni verifie dans ce
  depot-la.
- 🟡 **« VOS PRIX » VIT DANS LA SECTION « CONTACTS & CRM » DE `features.md`, ET IL N Y A AUCUNE RAISON**
  (constate le 2026-09-23). Decouvert par la garde de derive des fiches d aide : modifier l entree des prix
  a peri la fiche « importer-mes-contacts », qui ne parle pas de prix du tout. Elle a ete RELUE, elle reste
  exacte, seule son empreinte a bouge. Le cout est reel et se repaiera a chaque touche : une fiche client a
  relire pour un changement qui ne la concerne pas. A deplacer dans une section de facturation quand on
  reorganisera `features.md`, pas au milieu d un lot (ca deplacerait d autres empreintes).
- 🟡 **LES SIX COLONNES DE PRIX DE `tenant_settings` SONT MORTES ET ATTENDENT LEUR `drop`** (lot 8,
  2026-09-23). La grille est passee dans `grille_prix` (migration 0168) et plus aucun code NEUF ne lit
  `tenant_settings.prix_*`. On ne les supprime PAS dans le meme lot, et c est deliberé : un `drop column`
  casse l ancien code, donc il se passe APRES le deploiement, quand le code deploye ne les lit plus (regle
  corrigee au lot 0128). Marche a suivre, dans cet ordre : deployer le lot 8, VERIFIER dans le conteneur
  qu aucune ecriture ni lecture ne subsiste (`grep` dans `mba-api` et `mba-worker`, comme pour 0128), puis
  ecrire la migration du `drop`. ⚠️ Tant qu elles sont la, elles portent les anciennes valeurs par espace :
  un lecteur qui les trouverait pourrait croire a une grille par client.
- 🟡 **Quantitatif > Performance relit TOUT le journal de l espace depuis 0194 a chaque ouverture** (relecture du
  2026-09-29) : `conversation_evenements` n a d index que par conversation ; un index `(tenant_id, at)` demande une migration.
- 🟡 **Une course rare sur `passee_par_mba`** (relecture du 2026-09-29) : traite APRES une reponse deja enregistree de
  l equipe, il ouvre une demande que cette reponse precede, donc ne compte pas ; a mesurer avant de corriger.


## 🟡 Quatre ecarts mineurs releves par les revues finales (2026-09-17 et 18)

- **Le cout par engagement divise un numerateur BORNE par un denominateur qui ne l est pas.** Depuis que
  les messages de service sont imputes, le numerateur est entierement borne par la periode affichee
  (templates ET services) ; `engagementsParCampagne`, lui, compte les engages de toute la vie de la
  campagne. Pour une campagne dont les envois debordent de la fenetre, le cout par engage sort donc TROP
  BAS. Le critere du cadrage (la meme fenetre de SEPT JOURS des deux cotes) reste tenu, d ou le jaune :
  ce qui manque est la borne de PERIODE, pas la fenetre d attribution. La corriger veut dire passer `range`
  a `engagementsParCampagne` et borner son CTE, exactement comme `servicesParCampagne`.
- **ET `coutParClic` a le MEME defaut, en pire.** `clicsParCampagne` n a ni borne de periode ni meme fenetre
  d attribution de sept jours : elle compte depuis le premier envoi, sans borne haute. On divise donc un
  cout borne par la periode par des clics de toute la vie de la campagne. C est le corollaire (c) du
  `CLAUDE.md` : corriger un compte a un endroit et le laisser a un autre, c est le laisser faux. Les deux se
  corrigent ensemble, avec la meme fenetre partagee (`FENETRE_IMPUTATION`).

- **La traduction tombe sur le credit du client mais n est chiffree NULLE PART.** `src/traduction/`
  `traduire.pg.ts` n ecrit ni debit ni compteur, et `consommationIa` ne lit que `agent_sessions`. Le
  libelle de la carte a ete corrige (il promettait la traduction), mais la mesure reste a faire : il
  faudrait un debit par traduction, sur le modele de ce que `agent_sessions` porte deja.
- **Les badges « qui a repondu » lisent `conversation_messages.origin` BRUT**, alors que
  `ORIGINE_EFFECTIVE_SQL` existe pour que l agregat et le detail classent un message de la meme facon. Un
  sortant anterieur au 2026-09-01 avec `sender_user_id` renseigne compte « humain » dans la Synthese et ne
  produit AUCUN badge sur l ecran d analyse. Le choix est documente et se resorbe tout seul a 90 jours de
  retention, mais d ici la les deux ecrans peuvent se contredire sur la meme conversation.
- **La fenetre de bascule RCS est ouverte vers l AVANT seulement** : les reactions sont lues jusqu a
  `end_ts + 7 j`, jamais avant `start_ts`. Un echange dont la reaction tombe AVANT le debut de la periode
  voit ses envois factures en « simple » alors que la regle dit que tout l echange bascule. Le sens de
  l erreur est favorable au client, d ou le jaune.

## 🟡 La rafale de `webhook-status` à « dès 3 » est en production et NE SERT PRESQUE PAS (2026-09-16)

`48ddf92` (15/09, déployé vers 18 h) a posé `SEUILS_RAFALE['webhook-status'] = 2` pour que les PAQUETS
d'accusés (3 à 12) partent ensemble. **Mesuré le 16/09 dans `pgboss.job`** : 11 accusés en 3 paquets, pris un
par un à **30,000 s d'écart**, comme avant ; la rafale ne s'est engagée qu'UNE fois, pour le dernier accusé
d'un paquet, 85 s après son arrivée. La baisse de la médiane (97-105 s -> 47-70 s) vient de paquets plus
petits, pas du réglage.

🔴 **LA CAUSE EST DANS pg-boss 12.25.1, lue dans `dist/manager.js` et `dist/boss.js`** : la rafale consulte
`readyCount`, un chiffre RECOMPTÉ par la maintenance toutes les `monitorIntervalSeconds` (60 s) puis RELU par
le worker toutes les `queueCacheIntervalSeconds` (60 s). Jusqu'à deux minutes de retard, plus que la durée
d'un paquet (un accusé toutes les 30 s). L'avalanche d'une campagne n'est pas concernée : elle dure assez
pour que le compteur la voie. ⚠️ Les tests de `48ddf92` vérifiaient la VALEUR du seuil, pas son EFFET.

⚠️ **ARBITRÉ PAR JULIEN LE 2026-09-16 : NON PRIORITAIRE.** « L'essentiel est que ça marche sur les grosses
campagnes quand on aura de gros volumes. » C'est le cas : l'avalanche rafale (20 accusés en 1,2 s, mesuré le
2026-09-10). Le retard des petits paquets est accepté ; ne pas lancer l'une des deux voies sans qu'il le
redemande.

**Deux voies, si le sujet revient** (détail et chiffres : artifact « La plomberie de Messaging Me », § 7) :
- **par lots (recommandé)** : `batchSize` ~12 sur cette seule file, traitement SÉQUENTIEL dans l'ordre
  d'arrivée, un verdict par job via `perJobResults` (supporté par pg-boss 12.25). Zéro requête ajoutée, paquet
  traité en 30 s au plus. ⚠️ Touche l'invariant `batchSize: 1` de `PgBossQueue.work` (`src/queue/pgboss.ts`),
  et un worker tué en plein lot laisse jusqu'à 12 jobs attendre leur expiration. Chemin des accusés : revue
  humaine sur le diff, essai réel = lire dans `pgboss.job` des accusés d'un même paquet pris à quelques ms.
- **regarder plus souvent** : `QUEUE_POLLING_SECONDS['webhook-status']` de 30 à 5. Un nombre, mais
  +14 400 requêtes/jour à vide.

⚠️ Dans les deux cas, corriger le commentaire de `SEUILS_RAFALE` (`src/queue/names.ts`) et le paragraphe du
seuil par file dans `documentation.md` : ils laissent croire que le seuil règle les paquets.

## 🟠 Une conversation que l'agent de Meta n'a pas résolue en 24 h DISPARAÎT de « À traiter » (2026-09-15)

Trouvé en vérifiant le lot « l'agent répond après un silence » sur les vraies données, pas en le cherchant.
**Défaut PRÉEXISTANT**, aucun rapport avec ce lot, mais il le rencontre.

`CONTROL_MBA_TIMEOUT_MS` (24 h) reprend les fils tenus par l'agent de Meta et les repose en `app_workflow`.
Or `app_workflow` est **la seule valeur que le dossier « À traiter » exclut**. Donc une conversation où le
client a écrit en dernier, que l'agent n'a pas su résoudre, est une ligne de travail visible pendant 24 h,
puis **disparaît de l'écran** sans que rien ne se soit passé.

⚠️ **MESURÉ LE 2026-09-15** : onze conversations sont dans ce cas, dont `33685973811`, dont le client attend
une réponse depuis 15:28. Elle est aujourd'hui dans « À traiter » ; demain matin à 07:35 elle n'y sera plus.

🔴 **LA QUESTION À TRANCHER EST PRODUIT, PAS TECHNIQUE** : quand l'agent de Meta n'a pas conclu en 24 h,
qui doit reprendre ? Le repli sur `app_workflow` suppose qu'un scénario prendra la suite, ce qui est vrai
quand un scénario existe et faux sinon. `app_human` serait l'état honnête d'un fil que personne n'a résolu et
qui attend quelqu'un, et il garderait la conversation visible.

⚠️ Ne PAS régler ça en changeant `A_TRAITER` : ce dossier exclut `app_workflow` pour une bonne raison (une
conversation qu'un scénario mène n'est pas une ligne de travail). C'est la DESTINATION de la reprise qui est
discutable, pas le filtre.

## 🟠 Le rapport d'architecture du 2026-10-02 : huit pistes restantes sur neuf (2026-10-03)

Une revue de profondeur sur les zones les plus modifiées des deux semaines précédentes, rendue en HTML dans le
scratchpad de session, donc NON DURABLE (`architecture-review-20261002-2234.html`). Ce qui compte est recopié ici.
Base analysée : `origin/main` 9334e840. Les décisions déjà écrites n'y sont pas rediscutées (pas de découpage des
gros dépôts, gardes de consentement en flèches nommées, émission décidée par le chemin appelant).

**La piste 1 est faite et déployée** : la règle unique du catalogue d'outils (offrable, appelable, publiable),
`880b624d`, `b8760b6b`, `d101358e`, journal du 2026-10-02 et 03.

**Les huit restantes**, de la plus forte à la plus spéculative :

1. ✅ **Une seule transition de consentement dans la fiche contact : FAIT et déployé le 2026-10-04** (`1c4df5ec`
   serveur, `a34c88c3` console, plan `docs/superpowers/plans/2026-10-03-transition-consentement.md`). La règle vit
   dans `src/crm/transition-consentement.ts`, les six écritures la composent, l'autorité de chaque appelant est un
   type fermé. Écarts corrigés (décisions de Julien) : statut inchangé, rien de réécrit ni d'annoncé ; l'action en
   masse ne lève plus un STOP et le dit. Une table d'intégration remplace les tests par expressions régulières.
2. ✅ **Sortir l'envoi d'un bloc de scénario du câblage : FAIT et déployé le 2026-10-03** (`cdcbde3e`, plan
   `docs/superpowers/plans/2026-10-03-envois-de-bloc.md`). Les quatre envois vivent dans
   `src/workflow/envois-bloc.ts`, exécutés par `tests/workflow-envois-bloc.test.ts`. Pas couplé au point d'envoi
   unique (décision de Julien), qui reste le candidat 2 ci-dessous. ⚠️ Les « 20 commits dont 8 correctifs »
   portaient sur tout `wiring.ts`, pas sur ces quatre fonctions.
3. **L'accès publicitaire d'un espace, lié une fois** (à explorer). Chaque appel Graph ajouté se câble trois fois
   (client, flèche de `src/index.ts` autour d'`accesPub`, dépendance de route), et `src/worker.ts` déchiffre le
   jeton lui-même, hors de la règle « le jeton ne sort en clair que par `jetonClair` » (`src/pubs/connexion.ts`).
   Rendre un accès déjà lié au compte publicitaire, construit dans le socle. À trancher en passant :
   `noterSiRefus` ne marque un jeton refusé que sur la connexion, pas sur la création ni la publication.
4. ✅ **Un point d'entrée par type de lancement de scénario : FAIT le 2026-10-04** (`b6e674ac`, plan
   `docs/superpowers/plans/2026-10-04-lancements-de-scenario.md`). Les sept lancements passent par
   `src/workflow/lancements.ts` (type fermé, table `POLITIQUE_DE_LANCEMENT`), l'exécuteur n'a plus que
   `demarrer(type, ...)`, comportement identique (décision de Julien), et `tests/workflow-lancements.test.ts`
   exécute la table à la place des lectures de texte. C'était aussi le candidat 6 de « approfondir la racine ».
   Reste, relevé par le lot et laissé tel quel :
   - 🟡 **Une automation qui démarre à un BLOC lève la garde de fenêtre sans la vérifier** (politique
     `bloc_ou_preuve`, héritée de l'ancien `startFromNode`), même pour un déclencheur qui n'est pas un message
     (étiquette, date, risque) ; `src/http/automations.ts` ne valide rien à l'enregistrement. Si ce bloc est un
     message de session et que la fenêtre est fermée, Meta refuse (131047) : rien n'est livré, et seul le journal
     du worker le dit. Piste : vérifier la fenêtre comme `/v1/sends` (`ouvertureApi`), ou refuser ce réglage à
     l'enregistrement pour un déclencheur qui n'est pas un message.
   - 🟡 **Un commentaire de la console cite encore `ignoreHumanControl`** (`web/app/inbox/page.tsx`, vers la ligne
     2374) : à corriger au prochain passage dans ce fichier (le toucher seul republie la console).
5. **La réception RCS en module, comme sa jumelle WhatsApp** (à explorer). `onMo` (`src/index.ts`, rcsCallback)
   enchaîne STOP, opt-out, signal, journal, contact, automation et scénario dans une flèche qu'aucun test
   n'exécute (le test la remplace par un faux) ; la jumelle WhatsApp est un module (`src/webhooks/inbound.ts`).
   Peu modifiée : le coût est un risque sur le consentement, pas une fréquence.
6. ✅ **Un seul geste « poser une étiquette » : FAIT le 2026-10-04** (`93e321b5`, plan
   `docs/superpowers/plans/2026-10-04-poser-une-etiquette.md`). `src/crm/poser-etiquette.ts` remplace
   `src/agent/poser-tag.ts` ; l'agent, le bloc de scénario, le widget, l'outil MCP `tag_conversation` et la fiche
   contact y passent, la publication restant demandée par chaque porte. Changements voulus (décisions de Julien) :
   l'outil MCP coupe à 64 et déclare dans le référentiel, la fiche déclare. Restent, de la relecture :
   - 🟡 **La création d'un contact à la main avec des étiquettes** (`POST /tenants/:id/contacts`) ne déclare rien,
     alors que la fiche déclare désormais : une sixième porte unitaire, hors du plan, à trancher par Julien.
   - 🟡 **Une déclaration coûte deux requêtes en série** (`resolveTenantCode` puis l'`insert`, `PgTagStore.create`),
     étiquette par étiquette : 100 allers-retours pour une fiche envoyée avec 50 étiquettes (la console en envoie
     une à la fois). Piste : un seul `insert ... select unnest($2::text[]) on conflict do nothing`.
   - 🟡 **La borne de 64 se compte en unités UTF-16** (`normaliserEtiquette`) quand le schéma de l'outil MCP annonce
     `maxLength: 64` en points de code : une étiquette à émojis peut être coupée au milieu d'un émoji, et se redire
     « nouvelle » à chaque pose. Antérieur au lot pour les autres portes. Piste : couper sur les points de code.
   - 🟡 **Deux tests lisent un champ privé de l'exécuteur** (`Reflect.get(executor, 'deps')`) et recopient le même
     faux `buildWorkflowRuntime` (`tests/workflow-lancements.test.ts`, `tests/crm-poser-etiquette.test.ts`) : un
     utilitaire partagé dans `tests/` éviterait la copie.
   - 🟡 **`mergeFieldsByPhone` est câblé à la main quatre fois** (constat du rapport, hors de ce lot).
7. **Le cerveau de l'agent IA construit deux fois** (spéculatif). `src/index.ts` (bac à sable) et `src/worker.ts`
   (production) recopient la moitié commune de `creerCerveauGateway`, alignées par deux tests de texte ; l'écart du
   2026-09-16 (bac à sable sans résolveur) venait de là. Une fabrique « production / essai » dans `src/agent/`.
8. ✅ **Le bail anti-double-envoi de l'exécuteur, requis : FAIT le 2026-10-04** (plan
   `docs/superpowers/plans/2026-10-04-bail-avance-requis.md`). `reserverAvance`, `prolongerAvance` et
   `libererAvance` sont requises ; les fixtures reçoivent un bail inerte par `avecGardesDEtatInertes`, et
   `tests/workflow-bail-requis.test.ts` fait échouer le typecheck si l'une redevient optionnelle. Aucun changement
   en production (`PgWorkflowRunStore` les portait toutes). Le reste du **candidat 6 du rapport du 2026-09-14**
   (dépendances optionnelles) demeure.

Écartée : les deux journaux du sortant de `PgInboxStore`, déjà décrits plus bas (« un échec du JOURNAL »).

## 🟠 Le rapport d'architecture du 2026-09-14 : huit candidats restants sur onze (2026-09-15)

Une revue de PROFONDEUR (« quel levier une interface donne-t-elle par unité de complexité à apprendre ? »),
rendue en HTML dans le scratchpad de session, donc NON DURABLE : `architecture-review-20260914-210220.html`.
Ce qui compte est recopié ici, parce qu'un fichier de session disparaît.

**Trois sont faits et déployés** (registre de montage, garde requise, consentement requis, plus le rejeu de
prise du fil extrait), racontés dans `docs/JOURNAL-TECHNIQUE.md`.

**Les huit restants**, du plus fort au plus spéculatif :

1. **`buildWorkflowRuntime` reste un câblage ET le domicile de onze comportements.** 906 lignes, deux
   appelants, zéro test ne l'importe, alors que 17 fichiers de tests montent l'exécuteur qu'il câble. Le rejeu
   de prise du fil en est sorti le 2026-09-15 et établit le patron, les quatre envois d'un bloc le 2026-10-03
   (`src/workflow/envois-bloc.ts`). Les trois suivants à sortir, dans cet ordre : le cache de corps de modèle
   (il décide CE QU'ON ENVOIE), `buildEvalContext` (il alimente les conditions d'un scénario), `sendEmail`. Les
   autres ne font que composer.
2. **Le point d'envoi unique**, rétrogradé après l'audit du coût des règles : il doit se placer SOUS les
   règles (là où `metaFactory.clientForTenant` réunit déjà les quatre chemins) et porter seulement le JOURNAL
   et la frontière d'import, pas les sept règles. Cf. les deux dettes voisines.
3. **~52 interfaces de store pour 4 seconds adaptateurs**, compensées par 146 `as unknown as` dans 58 fichiers
   de tests. Ne pas supprimer les 52 : cesser d'en créer, et en compléter cinq (les plus moqués).
4. **Le barrel `web/lib/api.ts`** : l'implémentation a été découpée en 9 modules (324 symboles) mais
   **92 fichiers importent encore le barrel**, donc l'interface vue par les appelants n'a pas bougé d'un
   symbole. À faire au fil des touches, écran par écran ; le barrel se vide seul.
5. **Le câblage MCP recopie 11 des 15 clés du bloc Inbox** dans `src/index.ts`, à 1600 lignes d'écart, dans le
   fichier le plus modifié du dépôt. Le module partagé (`repondreDansLaFenetre`) est bien fait ; c'est le
   CÂBLAGE qui est dupliqué. ⚠️ **Cette ligne a dit « l'asymétrie est VOULUE (`estDesabonne` branchée sur MCP,
   absente côté console) » et c'était FAUX** (corrigé le 2026-09-23) : la dépendance est branchée à TROIS
   endroits d'`index.ts`, et le type l'exige partout depuis le 2026-09-15. Ce qui exempte l'opérateur est la
   CONDITION posée dans `repondreDansLaFenetre`, pas une absence de câblage. L'affirmation venait d'un
   commentaire de huit lignes de ce même fichier, recopiée ici : c'est le motif exact que le dépôt nomme,
   une justification fausse se recopie.
6. **158 dépendances optionnelles sur 388 membres** dans les 49 contrats de routes, dont ~10 seulement sont
   réellement conditionnelles en production. Les autres le sont pour que 73 câblages de test puissent en
   omettre : le coût est payé en production, par tous les lecteurs. À découper par domaine.
7. **385 flèches passe-plat** dans les trois câblages (288 dans `index.ts`, 86 dans `worker.ts`, 11 dans
   `wiring.ts`). Une flèche à deux paramètres est assignable à un contrat qui en déclare trois. À tenter sur
   UN domaine avant de généraliser.
8. **`web/app/inbox/page.tsx`**, 2110 lignes, 72 `useState`/`useEffect`. ⚠️ EXPLICITEMENT REFUSÉ par les trois
   audits externes et par ce rapport : personne n'a su nommer quelle interface devient plus petite pour qui.
   Ne pas le rouvrir sans cette réponse.

## 🟠 Un échec du JOURNAL fait échouer une réponse DÉJÀ PARTIE, et les trois correctifs évidents sont faux (2026-09-15)

`src/inbox/repondre.ts:139` appelle `deps.recordOutbound(...)` **sans `try/catch`**, après que Meta a accepté
le message et rendu son `messageId`. Un échec d'écriture du journal remonte donc en erreur alors que le
message est parti. L'opérateur voit un échec, renvoie, et le client reçoit deux fois le même message.

⚠️ **CLASSÉ 🔴 LE MATIN MÊME, PUIS RÉTROGRADÉ APRÈS ANALYSE.** Les trois correctifs qui viennent à l'esprit
échouent chacun pour une raison différente, et c'est ce qui fait de ce point un LOT et pas un patch :

1. **Un `try/catch` nu ne corrige rien.** Le fil se rafraîchit depuis la base toutes les 4 secondes. Si le
   journal a échoué, le message n'y est pas : l'opérateur verrait « envoyé », puis son message s'effacerait
   sous ses yeux, et il le renverrait. Le doublon chez le client arrive quand même, on a seulement déplacé le
   symptôme et perdu la trace au passage.
2. **Rejouer l'écriture n'est pas sûr en l'état.** L'insert du journal sortant
   (`src/inbox/store.pg.ts:1317`) est un `insert ... values` **sans `on conflict`**, et l'index unique sur
   `meta_message_id` porte sur `webhook_events` (les ENTRANTS), pas sur `conversation_messages`. Un rejeu
   ferait apparaître le message deux fois dans le fil.
3. **L'échec bruyant actuel n'est pas absurde.** Les trois autres chemins sont best-effort, mais ce sont des
   chemins MACHINE, où personne ne peut réagir. Ici il y a un humain. Le vrai défaut n'est pas le `throw`,
   c'est que le message d'erreur **ne dit pas que le message est parti**.

**La forme juste, le jour où on le prend** : rendre l'insert sortant idempotent (index unique sur
`meta_message_id` + `on conflict do nothing`, migration sur une table chaude), rejouer une fois, et si ça
échoue encore rendre un résultat distinct (« parti, non enregistré ») que les DEUX appelants traduisent pour
leur public : « votre message est parti, ne le renvoyez pas » côté Inbox, et la même chose côté MCP pour que
l'agent ne réessaie pas.

⚠️ **Ce jour-là, en profiter** : `recordOutboundByWaId` (`src/inbox/store.pg.ts:603`) code `sender_user_id`
en dur à `null` et n'a pas `redaction_origine`, cf. la dette voisine sur le point d'envoi unique.

## 🟠 Trois lectures qu'un point d'envoi unique perdrait, à savoir avant de le construire (2026-09-15)

Relevé par l'audit du coût des règles d'envoi, à garder sous la main le jour du candidat 6 :

- `recordOutboundByWaId` (`src/inbox/store.pg.ts:603`) code `sender_user_id` **en dur à `null`** et n'a pas
  `redaction_origine` dans sa signature. Un envoi unifié sur cette fonction ferait disparaître **en silence**
  la pastille d'auteur et la rédaction d'origine (migration 0137) ;
- la fenêtre de 24 h, le `waId` et la langue détectée arrivent **ensemble** dans `getConversationContext`
  (`src/inbox/store.pg.ts:981-1006`). Un sas qui redemanderait l'un des trois doublerait une requête déjà
  payée ;
- `listPending` (`src/campaign/store.pg.ts:1615`) ramène déjà `contact_id`, `to_e164` et `resolved_params`
  pour tout le run. Un sas dont la signature serait `(tenantId, waId, texte)` devrait re-résoudre le contact :
  une requête unique deviendrait une par destinataire.

## 🟠 La route de traduction pose DEUX FOIS la même requête par appui (2026-09-15)

`src/http/inbox.ts:602` appelle `traductionDisponible`, puis `:607` appelle `traduireSortant`, dont
`src/traduction/traduire.ts:264` refait `await disponible(tenantId)`. Deux `select` identiques sur
`agent_gateway_keys` (`src/agent/cles-gateway.pg.ts:43`) par clic sur le bouton de traduction.

Sans gravité (geste humain, pas une boucle), mais c'est une requête pour rien sur le pool de l'API.

## 🟠 Le contrôle des symboles morts n'est branché NULLE PART (2026-09-15)

`tsconfig.prod.json` active `noUnusedLocals` sur `src` et existe depuis le 2026-09-14, mais aucun script npm
ni aucun job de CI ne l'exécute. C'est le constat A8 du contre-audit du 2026-09-14, toujours ouvert.

🔴 **Sa valeur vient d'être démontrée** : le 2026-09-15, il a attrapé un import mort (`creerWabaDeLEspace`
dans `wiring.ts`) que `npm run typecheck` laissait passer sans rien dire. Un import mort n'est pas cosmétique,
il fait croire à une dépendance qui n'existe pas.

**À faire** : un script `npm run morts` et une étape dans le job `unit` de `.github/workflows/ci.yml`.


## 🟠 Bascule Scaleway : tout est dans UN document (2026-09-15)

Les trois chantiers à finir avant de multiplier les processus (l API qui réserve une connexion, les balayages
à sérialiser, les plafonds de débit en mémoire), le sort du connecteur HubSpot, la question Redis et la
séquence du jour J vivent désormais dans **[docs/ARCHITECTURE-CIBLE.md](docs/ARCHITECTURE-CIBLE.md)**.

🔴 **Ne rien recopier ici.** Cette matière était éparpillée entre trois entrées de ce fichier, `CLAUDE.md` et
`documentation.md`, et elle commençait déjà à diverger. Le document est la source unique ; ceci est un
pointeur, et il doit le rester.

🔴 **Depuis le 2026-09-25, la vitrine affiche l'hébergement en France chez Scaleway comme FAIT**, alors que la
base est encore à Londres : c'est désormais une promesse publique. Le détail est en tête du document.

## 🔴 L'essai réel du lot « consentement » reste DÛ (2026-09-15)

Le consentement (`estDesabonne`) est une dépendance REQUISE depuis le 2026-09-15, livrée et déployée
(`150dc25`, plan `docs/superpowers/plans/2026-09-14-dependances-non-optionnelles.md`). Les quatre chemins
sont couverts par des tests de comportement. **L'essai en production, lui, n'a pas été fait**, et Julien a
tranché ce jour-là qu'on s'arrêtait après le déploiement.

Ce qu'il demanderait :

- **un contact de test, et son numéro est la décision** : l'espace de production ne contient que de vraies
  personnes (17 contacts) et **zéro `opted_out`**, mesuré en base. Il faut donc en créer un, et si une garde
  échouait, c'est ce numéro-là qui recevrait le message ;
- **un moyen de déclencher les quatre chemins** : un jeton de console pour le scénario et l'Inbox, une clé
  d'API pour MCP, ou les clics de Julien.

⚠️ **Ce qui A été vérifié en production, pour ne pas le refaire** : la garde déployée interroge réellement le
dépôt de contacts (`estDesabonneParWaId` exécutée depuis l'image déployée contre la vraie base, deux verdicts
corrects). Le chemin est vivant et la requête est juste sur le schéma. Ce qui manque est la preuve du REFUS,
faute d'un désabonné pour le déclencher.

## 🟠 Côté Meta, les champs cochés ne s'appliquent pas, et l'écran se tait (2026-09-15)

Depuis la migration 0150, chaque agent choisit ce qu'il lit de la réponse d'un appel, et l'écran promet que
« seuls les champs cochés partent chez le fournisseur du modèle ». **C'est vrai pour un agent IA, et faux pour
le Meta Business Agent.** On publie chez Meta l'adresse du système et le chemin de l'appel ; **Meta appelle le
système du client EN DIRECT et lit toute la réponse.** Nous ne sommes pas dans la boucle, donc ni la nature
« pousse » ni les champs cochés ne s'y appliquent.

⚠️ **Depuis le relais du 2026-09-21, Meta n'appelle plus le système du client en direct** : il appelle Messaging Me,
qui lui rend TOUTE la réponse (arbitrage de Julien, le jour du relais). La conclusion ne change pas, ni la nature
« pousse » ni les champs cochés ne s'appliquent à l'agent de Meta. L'onglet « Outils » de l'agent de Meta ne le
dit pas (la case « Exposé » de l'ancien écran n'existe plus). Arbitrage de Julien du 2026-09-15, à qui
la question a été posée : **on n'affiche rien**. C'est donc un trou ASSUMÉ, pas un oubli, et il est écrit ici
pour qu'il reste discutable.

⚠️ **Ce qu'il coûte, précisément** : quelqu'un qui restreint les champs pour son agent IA, par prudence sur
une réponse qui porte des données personnelles, peut croire que la même prudence vaut pour Meta. Elle ne vaut
pas. Une phrase sous la case suffirait (« Meta appelle votre système en direct et lit toute la réponse : ce
que vous avez choisi ici ne s'y applique pas »).

## ~~🟠 L'adresse d'origine du VPS n'est protégée que par le SILENCE (2026-09-15)~~ **FERMÉ le 2026-09-21** pour Messaging Me

`api.` et `mba.messagingme.app` n'acceptent plus que ce qui arrive par Cloudflare, par un filtre posé dans
NPM sur ces deux hôtes seulement. Fonctionnement, piège de `X-Real-IP`, retour arrière : `DEPLOY.md`, en tête.
⚠️ **Ce qui reste ouvert, hors du périmètre de Messaging Me** : les AUTRES hôtes du VPS (Odalys, Gan, Hyundai,
Neoma, leadgen) restent joignables en direct. Même filtre possible, hôte par hôte, en ajoutant leur nom à la
table de `/data/nginx/custom/http_top.conf`, après la même vérification des appelants directs dans leurs
journaux.

## 🟠 Le bouton « Rendre la main » de l'Inbox garde la course que la fin de parcours vient de perdre (2026-09-15)

Le correctif du 2026-09-15 (migration 0149) fait attendre à la fin d'un parcours l'accusé de son dernier
envoi avant de rendre le fil à l'agent de Meta, parce qu'envoyer un message PREND le fil chez Meta et que
l'accusé arrive DEUX MINUTES plus tard. **Le bouton « Rendre la main » de l'Inbox, lui, appelle toujours Meta
tout de suite** (`src/index.ts`, `rendreLeFilAuMba`). Un opérateur qui répond au client puis rend la main dans
la foulée relâche donc un fil que son propre message vient de reprendre : l'agent de Meta restera muet, comme
il l'était en fin de scénario.

🔴 **Ce n'est pas le même geste, et c'est pour ça que ça n'a pas été corrigé dans la foulée.** La route est
SYNCHRONE et rend un verdict à l'écran (« le fil est rendu, à qui »). Le différer jusqu'à l'accusé ferait
mentir le bouton, ou obligerait à afficher un état « remise en cours » qui n'existe nulle part aujourd'hui.

Deux pistes, à arbitrer : afficher l'attente (le bouton répond « rendu d'ici deux minutes ») et passer par le
même marqueur ; ou ne différer QUE quand notre dernier envoi date de moins de deux minutes et n'a pas encore
son accusé, et relâcher tout de suite sinon. La seconde ne change rien au cas courant, où l'opérateur rend la
main sans avoir écrit.

⚠️ Le filet existe déjà dans les deux cas : le balayage de contrôle reprend les fils immobiles et les rend
pour de vrai. Le coût d'aujourd'hui est un retard, pas une perte.

## 🔴 « L'agent de Meta prend la main » et « Un agent IA prend la main » NE PARTENT NULLE PART (2026-09-14)

Relevé en revue du lot « une question à la fois », en suivant ce que `devenir` devient. La question
« Que se passe-t-il quand le contact répond ? » de l'assistant de campagne propose trois réponses, et
**une seule voyage jusqu'au serveur** : « La conversation arrive dans l'Inbox », par `assignation` et
`assignationUserId`.

Mesuré, pas supposé : `devenir` et `agentId` n'apparaissent que dans l'écran et dans le brouillon
(`web/lib/campagne-brouillon.ts`) ; `CreateCampaignInput` (`web/lib/api/campagnes.ts`) ne porte aucun
champ pour eux ; `campaigns` n'a aucune colonne qui dise quel agent reprend la conversation.

**Choisir « Un agent IA prend la main » ne change donc rien à ce qui se passera**, et l'écran fait
pourtant désigner un agent précis dans une liste. C'est le motif « offert-et-inerte », que le produit
s'interdit ailleurs (un canal sans agent RCS est grisé AVEC sa raison plutôt que d'accepter un choix
sans effet).

Deux sorties possibles, et c'est un arbitrage de Julien :

- **le câbler** : une colonne sur `campaigns`, lue à l'arrivée d'une réponse, au même endroit que
  `assignationDeLaCampagne` (`src/campaign/store.pg.ts`) ;
- **ou retirer les deux options** et dire ce qui se passe réellement aujourd'hui (l'agent de l'espace
  répond s'il est actif, sinon la conversation tombe dans l'Inbox).

⚠️ Ne pas trancher à notre main : la première option est un vrai chantier, la seconde retire une
promesse qui a peut-être été faite à un client.

## ✅ LIVRÉ : traduction des conversations (tranché le 2026-09-12, livré et déployé le 2026-09-13)

> ⚠️ **CE TITRE A DIT « RIEN DE COMMENCÉ » PENDANT QUE C'ÉTAIT EN PRODUCTION** (migration 0137,
> `TRADUCTION_MODELE` posée, six tâches livrées). Relevé le 2026-09-14 en répondant à « il reste quoi à
> faire ? », c'est-à-dire par quelqu'un qui allait s'en servir. **Un backlog qui garde une entrée livrée ne
> vieillit pas, il MENT** : il fait rouvrir un chantier fini. Ce qui suit est le CADRAGE d'origine, gardé
> parce qu'il porte les décisions ; le fonctionnel vit dans `features.md`.

**Deux langues, FR et EN, et c'est ce qui rend le dessin simple.** « Traduire » veut dire « dans
l'autre », donc **aucun sélecteur de langue nulle part** : ni sur le contact, ni sur la conversation.

Décisions de Julien :

- **La langue de lecture vient de la console.** Elle vit dans le `localStorage`
  ([web/lib/i18n.tsx](web/lib/i18n.tsx)), **pas sur le compte**, donc le serveur ne la connaît pas.
  C'est le navigateur qui la passe à chaque appel. ⚠️ Le motif existe déjà et se décalque : le bot
  d'aide envoie `QuestionAide.langue: 'fr' | 'en'` à chaque question.
- **Les entrants se traduisent TOUS à l'ouverture d'une conversation**, jamais à l'arrivée. Traduire
  à l'arrivée fait payer les « ok », les emojis et toutes les conversations que personne n'ouvrira.
  Le premier lecteur paie, les suivants réutilisent le résultat rangé.
- **Les sortants ne se traduisent JAMAIS automatiquement.** Un bouton « Traduire » avant l'envoi.
  🔴 C'est une garde, pas une commodité : une traduction ratée en entrée se rattrape sur l'original
  affiché à côté, une traduction ratée en sortie est partie chez un client et **aucun message
  WhatsApp livré ne se rappelle**.
- **Le toggle « traduire les entrants » vit dans le `localStorage`**, comme la langue elle-même.
- **Stockage** : une colonne de traduction plus la langue dans laquelle elle est. Un message français
  n'a jamais besoin que d'une traduction anglaise, et réciproquement.
- 🔴 **À l'envoi, `body` porte ce qui est PARTI (le texte traduit), et une colonne à part porte ce
  que l'opérateur a ÉCRIT.** Miroir exact de la migration 0125 : ne garder que le traduit rend
  l'opérateur incapable de se relire, ne garder que l'original rend notre trace fausse le jour d'un
  litige.

Trois pièges à ne pas découvrir en route :

- 🔴 **Un template ne se traduit pas.** Il est approuvé par Meta dans une langue, et le texte
  approuvé EST le texte. La traduction ne concerne que les messages libres, dans la fenêtre de 24 h.
  Un bouton « Traduire » affiché sur un template ment.
- ⚠️ **Traduire coûte des jetons** sur la clé Gateway de l'espace (migration 0124), donc sur le
  crédit prépayé. Un espace à zéro ne peut pas traduire, et ça se dit à l'activation, pas au premier
  message muet.
- 🔴 **« L'autre langue » NE SUFFIT PAS, et c'est la précision de Julien du 2026-09-12.** Nos deux
  langues sont celles de la CONSOLE, pas celles des contacts : un client peut très bien écrire en
  espagnol. La règle juste est donc dissymétrique.
  - **En entrée** : traduire vers la langue du LECTEUR, quelle que soit la source. Aucun problème,
    la cible est toujours connue.
  - **En sortie** : la cible est la langue du CONTACT, qui n'est ni le français ni l'anglais dans ce
    cas. « L'autre des deux » ne veut plus rien dire.

### La langue du contact s'APPREND, elle ne se demande pas

🔴 **On la détecte déjà, et on la jette.** `src/agent/llm/transcription.ts` rend `langue: string |
null` (ligne 94) et la migration 0125 n'a créé aucune colonne pour la garder. Troisième fois dans la
même journée qu'on trouve une donnée calculée puis perdue, après la joignabilité WhatsApp.

Elle se retient donc sur la fiche du contact, alimentée par la transcription de ses vocaux et par la
traduction de ses textes. Ni question posée au contact, ni choix imposé à l'opérateur.

⚠️ **Le bouton NOMME sa cible** : « Traduire en espagnol », jamais « Traduire » tout court. Meilleur
même quand la cible est évidente, parce que l'opérateur voit où part sa phrase avant de valider.
Tant qu'on n'a rien appris du contact, il nomme la langue par défaut : il ne ment donc jamais.

### Les vocaux (précision de Julien, 2026-09-12)

Quand le client appuie sur **Transcrire** et que la traduction est active, la transcription doit
arriver dans SA langue de console, **même si le vocal était en espagnol**.

- 🔴 **On traduit la TRANSCRIPTION, pas le corps.** Le `body` d'un audio vaut `[audio]` ou la
  légende : le traduire ne produirait rien. L'ordre est imposé, transcrire puis traduire, et ça
  reste **un seul geste** pour l'opérateur.
- 🔴 **NE PAS utiliser le mode « traduire » intégré des API de transcription.** Il ne cible que
  l'anglais : s'en servir donnerait un comportement différent selon que l'opérateur est en FR ou en
  EN, et **détruirait l'original**. On transcrit fidèlement, puis on traduit.
- ⚠️ **Deux appels, donc deux fois le coût** sur le crédit prépayé pour un vocal traduit.
- La transcription garde ce qui a été **dit** (en espagnol), la traduction vit dans sa colonne avec
  sa langue. Même principe qu'en 0125 : la lecture d'un modèle n'est pas ce que le client a dit.

## 🔴 Ce qu'on exécute est le POINT 2 de l'audit externe du 2026-09-02

> **Au 2026-09-03 au soir : A1 à A4, B et C sont livrés et déployés.** Ne restent de ce point que le profil
> `equite` du banc de charge (plus bas) et, facultatif, éteindre `mba-web`.

### Contre-rapport de ChatGPT sur ces livraisons (2026-09-03) : les huit constats, vérifiés un par un

Vérifiés DANS LE CODE avant d'être acceptés, jamais sur leur formulation. **Cinq confirmés, trois à moitié**,
et les trois moitiés fausses valaient d'être établies, parce qu'elles auraient fait travailler pour rien.
**Tous les points confirmés sont corrigés**, sauf ceux listés comme ouverts en fin de section.

- ~~**A3-ipv6** : la classification IPv6 laissait passer cinq cas sur huit.~~ **CORRIGÉ.** C'était le plus
  grave, et il était à moi. La garde testait des PRÉFIXES DE TEXTE : `fe80::/10` fait dix bits et va jusqu'à
  `febf`, donc trois adresses lien-local sur quatre passaient ; et une IPv4 mappée s'écrit aussi en
  hexadécimal, donc `::ffff:ac12:1`, qui EST `172.18.0.1`, la passerelle du réseau Docker du VPS, passait.
  C'est l'adresse même que cette garde existe pour bloquer, et l'en-tête du module affirmait qu'elle était
  rejetée, « vérifié ». L'adresse est désormais DÉVELOPPÉE en huit groupes de seize bits et comparée en
  nombres. ⚠️ La vérification a aussi trouvé quatre cas que le contre-rapport ne voyait pas : forme non
  compressée, `::/96` déprécié, et `0:0:0:0:0:0:0:1` classé public. Non retenus en revanche : `fec0::/10`,
  `2002::/16` et `::ffff:0:0:0/96`, aucun n'étant joignable depuis ce VPS.
- ~~**A1-transition** : la sortie terminale d'un tour était une double écriture non atomique.~~ **CORRIGÉ.**
  Clore la session puis faire sortir le parcours : une panne entre les deux laissait un parcours mort POUR
  TOUJOURS, la clôture ayant effacé le marqueur qui l'aurait désigné au balayage. ⚠️ **Et le correctif évident
  était faux** : inverser l'ordre paraît plus sûr, mais `sortirDuBlocAgent` fait AVANCER le parcours, qui peut
  retomber sur un autre bloc agent dans le même appel et réutiliser la session encore vivante avec ses tours
  consommés. La réparation passe donc par la MARQUE, pas par l'ordre.
- ~~**B4-exclusions** : les exclusions de cible étaient appliquées APRÈS le `LIMIT` SQL.~~ **CORRIGÉ.** Sur
  30 000 contacts, un plafond de 20 000 et 5 000 exclus dans la fenêtre, la campagne partait vers 15 000
  destinataires. **Elle sous-envoyait en silence** : le nombre affiché est celui qu'on vient de calculer.
- ~~**A2-garde-rcs** : une fenêtre subsistait entre la garde et l'envoi RCS.~~ **CORRIGÉ.** Exactement deux
  attentes séparaient le contrôle du `sendTo`. La règle du lot A2 se précise : « entre les effets » veut dire
  immédiatement avant l'effet, pas avant le travail qui le précède.
- ~~**A3-timeout** : le bouton « Test » n'avait aucun plafond de temps.~~ **CORRIGÉ.** Seul des trois boutons
  de la même famille à ne pas en avoir. ⚠️ Deux moitiés du constat étaient fausses : ce n'était pas illimité
  mais borné au défaut d'undici, **mesuré à 309 s** ; et ça n'immobilisait PAS une place du pool, les lectures
  en base étant terminées avant l'appel. Rien à faire non plus sur `page-distante.ts`, dont le plafond par
  saut est explicite et borne le pire cas.
- ~~**A4-sli** : le SLO d'entrée alarmait sur la mauvaise mesure.~~ **CORRIGÉ.** Le rouge ne se posait que sur
  l'ATTENTE quand le SLO promet un message TRAITÉ en 30 s. `agent-turn` étant un appel modèle, cette file
  serait restée verte quelle que soit la lenteur du modèle. Le p99 promis se lit maintenant sur le pire cas
  bout en bout, qui était calculé et transporté depuis toujours et affiché nulle part.
- ~~**C1-spread** : un commentaire affirmait une garantie du compilateur qui est fausse.~~ **CORRIGÉ.**
  Mesuré, pas raisonné : une propriété en trop dans un littéral DIRECT est refusée (TS2353), la même
  introduite par un SPREAD passe en silence, et un `satisfies` sur le littéral EXTÉRIEUR n'y change rien.
  Seul un `satisfies` sur l'objet INTÉRIEUR du spread la voit. C'est précisément là que vivaient les deux
  capacités de la panne du 2026-09-02.
- **A4-equite** : le réglage rend le SLO 3 arithmétiquement intenable à la cible annoncée. **DOCUMENTÉ, pas
  corrigé, et c'est délibéré.** L'enveloppe manquait à tout le monde : `attente = N × T / C − T`, donc avec les
  valeurs par défaut (tranche de 2 min, 4 runs) le seuil de 5 min tient jusqu'à **environ 13 campagnes longues
  simultanées**, et vaut 10,5 min à 25. ⚠️ **Ne PAS retoucher les deux réglages avant de mesurer** : baisser la
  tranche multiplie un `listPending` non borné (jusqu'à 20 000 lignes), monter la concurrence mange un pool de
  8 connexions déjà partagé. L'ordre des mesures est écrit dans `docs/SLO-2026-09-01.md`. Ce n'est pas une
  panne d'aujourd'hui : 6 jobs `campaign-run` sur sept jours, attente p95 de 0,11 s.

**Ce qui reste ouvert de ce contre-rapport**, et pourquoi : le retriage des deux réglages de campagne, qui attend le profil de banc `equite` du lot 6, plus bas.

### Contre-CONTRE-rapport, sur les correctifs ci-dessus (2026-09-03 au soir)

Quatre nouveaux constats, vérifiés dans le code avec passe adverse : **trois confirmés, un réfuté**. Plus un
cinquième point hors tableau, sur mes propres tests, et **deux angles morts trouvés en propre**. Les deux
angles morts et deux des trois confirmés sont des **régressions que j'avais introduites la veille**.

- ~~**P1c, l'épreuve d'une SOURCE sans résolution DNS.**~~ **CORRIGÉ**, et c'était le plus grave. Elle
  appelait `construireCible` puis `fetch` : elle ne voyait donc pas qu'un nom public pointe vers le réseau
  Docker du VPS. C'était le **quatrième** chemin de ce genre, alors que le `CLAUDE.md` affirmait qu'il y en
  avait trois et qu'ils étaient tous gardés. Ce qui l'a fait rater : les deux boutons « Test » se ressemblent
  beaucoup, et l'autre appelait bien la garde. L'inventaire est désormais tenu par un test.
- ~~**P1a, le balayage sortait par « échec » en dur.**~~ **CORRIGÉ.** Juste tant qu'il ne réclamait que des
  sessions `en_cours` ; faux depuis qu'il ramasse aussi les closes dont la sortie est due. Le contact
  repartait par le repli technique au lieu de la branche prévue, et c'est le cas le plus fréquent. ⚠️ Le test
  unitaire du balayage ne voyait PAS le câblage du worker : une garde qui lit la source a été ajoutée, comme
  pour le plafond de campagne. Troisième fois que ce piège se présente.
- ~~**P2, l'index partiel de la 0112.**~~ **CORRIGÉ** (migration 0113, appliquée ; la base est à 0116, cf. le compteur de CLAUDE.md, seule source).
- **P1b, l'escalade humaine : RÉFUSÉ, et c'est un arbitrage.** Les faits sont vrais, c'est le seul couple
  « clore puis sortir » qui ne préserve pas la marque. Mais poser la marque **dégrade le cas le plus
  probable** : le rattrapage existant (le message suivant du contact remonte le fil en inbox ET escalade) est
  meilleur que le balayage, et un contact qui vient de réclamer un humain face à un silence total réécrit
  presque toujours. Le refus est écrit dans `src/agent/escalade.ts` avec sa raison.
- ~~**Point 5, mes deux tests du plafond de temps ne prouvaient rien.**~~ **CORRIGÉ.** Le premier n'assertait
  qu'un signal, le second passait AUSSI sans la garde qu'il tenait. Les faux minuteurs de vitest ne pilotent
  pas `AbortSignal.timeout`, d'où une couture `delaiTestMs`. Même lot : la résolution DNS n'était dans aucun
  budget, les deux s'additionnaient au lieu de se recouvrir.
- ~~**Angle mort 1 : un `Math.min(100_000)` écrasait en silence une limite de cible plus grande.**~~
  **CORRIGÉ.** Le plafond de campagne vit en configuration pour se relever le jour d'un gros client : le geste
  que le produit a prévu était exactement celui qui armait le défaut. C'est le sous-envoi silencieux de la
  veille, transposé du filtre d'exclusion au filtre de taille, trois lignes plus bas.
- ~~**Angle mort 2 : `AGE_TOUR_MORT_S` valait exactement `DUREE_MAX_AVANCE_MS`.**~~ **CORRIGÉ** (15 min).
  Marge nulle : une avance qui va au bout de son temps rend sa ligne réclamable à l'instant où elle abandonne.
  Ferme au passage la course sur `sortieAppliquee`, qui n'a pas de jeton de garde. Deux constantes qui doivent
  être ordonnées se règlent par une valeur, pas par une architecture ; le lien est tenu par un test, parce
  qu'il ne se voit dans aucun des deux fichiers pris séparément.

### Audit de RAYON DE SOUFFLE du lot précédent (2026-09-04) : ce que mes propres correctifs avaient cassé

Nouvelle discipline, née de la question de Julien (« qu'est-ce qui me fait croire que ce que tu as fait n'a
pas détruit autre chose ? »). Pour chacun des six changements du lot, **tous les dépendants ont été énumérés
et vérifiés un par un** : 102 au total, puis un réfuteur par changement chargé de trouver celui qui manquait.
**Aucun comportement cassé, trois risques réels, tous corrigés.**

- ~~**Des tests faisaient un VRAI appel DNS.**~~ **CORRIGÉ.** `tests/page-distante.test.ts` appelait
  `fetchUrlBorne(1000, impl)` à deux arguments, donc la vraie résolution, sur `www.exemple.fr`, un domaine que
  personne ici ne contrôle. Un des tests **passait aussi quand le nom ne résolvait pas** (« hôte non autorisé
  (nom introuvable) » contient bien « hôte non autorisé ») : vert par le chemin du refus, sans jamais
  atteindre la redirection qu'il prétend refuser. Le plafond DNS ajouté la veille avait en plus resserré leur
  marge en CI. **Un test unitaire qui touche le réseau n'est pas un test unitaire**, c'est un test dont le
  verdict appartient à quelqu'un d'autre. Prouvé corrigé en coupant le résolveur par défaut : 7 tests verts.
- ~~**Ma réécriture avait supprimé un cas de test sans le remplacer.**~~ **CORRIGÉ.** L'ancien test exerçait
  « le système coupe la connexion en plein corps », mal asserté mais exercé ; sa réécriture l'a remplacé par
  un cas piloté par l'échéance. Le chemin vivait toujours dans le code et produisait le même faux succès.
  `lireCorpsBorne` distingue désormais un flux CASSÉ d'un corps vide (les deux rendaient `{texte:''}`), et la
  route refuse aussi le corps **trop gros**, qu'elle ignorait alors que ses deux routes sœurs le refusent.
- ~~**Six endroits disaient encore « dix minutes ».**~~ **CORRIGÉ.** Dont le docbloc juste au-dessus de la
  constante à quinze, qui affirmait « même ordre de grandeur que la durée maximale d'une avance » alors que
  tout l'intérêt du changement est de NE PAS l'être ; et `CLAUDE.md`, avec deux affirmations fausses dans une
  seule phrase. Ma justification était en plus **orpheline**, placée après la constante, donc invisible au
  survol.
- ~~**Le `CLAUDE.md` se contredisait sur le compte des chemins sortants.**~~ **CORRIGÉ.** J'avais écrit qu'il
  y en avait quatre à la ligne 392 et laissé « les TROIS chemins concernés » à la ligne 407, plus les copies
  dans `todo.md` et `wip.md`. **Corriger un compte à un endroit et le laisser à trois autres, c'est le
  laisser faux.**

### Contradiction de mon PROPRE lot de correction (2026-09-04) : ce qui reste ouvert

Trois lecteurs indépendants, 71 fichiers ouverts, des scripts exécutés contre un vrai serveur local. **Rien de
cassé.** Quatre défauts trouvés et corrigés (le drapeau câblé sur un consommateur sur trois, une justification
FAUSSE dans mon propre commentaire, un témoin de test qui n'exerçait pas le cas qu'il nommait, un débris de
copier-coller). Ce qui reste ouvert, avec sa raison :

- **Le plafond du bouton « Test » n'est pas aligné sur celui de l'appel RÉEL.** Le test coupe à 40 000 octets
  (`MAX_APERCU * 2`), l'appel réel à `agent_tools.max_bytes` (défaut 16 384, réglable jusqu'à 262 144). Il
  existe donc des réglages valides où le bouton refuse une réponse que la production accepterait, et
  l'inverse. **Ce n'est pas une régression** : avant, une réponse de plus de 40 Ko donnait déjà un aperçu vide
  et zéro chemin, le bouton était donc déjà inutilisable au-delà. L'alignement exact est impossible (le test
  ne connaît pas l'outil qui utilisera la requête), donc à trancher : soit on affiche la borne à l'écran,
  soit on la fait remonter du plus permissif des outils qui désignent cette requête.
- **`sortieAppliquee` n'a toujours pas de jeton de garde.** La course est devenue INATTEIGNABLE en écartant
  `AGE_TOUR_MORT_S` de `DUREE_MAX_AVANCE_MS`, mais la pièce manque : il faudrait faire remonter l'instant de
  marque à travers `clore` puis `cloreEtSortir`, donc deux signatures.

**Vérifié et écarté** : `asIdArray` (`src/http/contacts.ts:91`) tronque les identifiants d'une action en
masse à 100 000, mais c'est **documenté dans son propre commentaire** et préexistant. Et le plafond DNS de 3 s
tombe DANS le budget d'outil de 8 s d'un tour d'agent, qu'il RÉDUIT au lieu de l'augmenter.

**Ce qui reste ouvert :** un jeton de garde sur `sortieAppliquee` (la course est devenue inatteignable par
la constante, mais la pièce manque toujours ; elle coûterait de faire remonter l'instant de marque à travers
deux signatures) ; et le compte jugé par le plafond de campagne inclut les contacts **bloqués**, alors que le
chargement des destinataires les filtre. Ce dernier **sur-compte** au lieu de sous-envoyer, donc le sens est
le bon, et il est préexistant.


Les sept lots de [docs/PLAN-POST-AUDIT-2026-09-02.md](docs/PLAN-POST-AUDIT-2026-09-02.md) sont **livrés et
déployés** (2026-09-02 au soir), ainsi que le point 1 de l'audit qui a suivi. Ce qui reste, dans cet ordre :

~~**A2 — arrêter les EFFETS à la perte du bail d'avance.**~~ **LIVRÉ le 2026-09-03.** Le battement expose
désormais `perduPourquoi()`, consulté avant CHAQUE effet dans `apply`, avant l'envoi RCS de `walkResolved` et
avant l'enfilement d'un tour d'agent ; une durée totale maximale de dix minutes abandonne une avance PENDUE
(le seul mode de panne que battre ne distinguait pas). ⚠️ **Un point de la demande a été volontairement NON
fait** : l'`AbortSignal` est exposé mais AUCUN transport ne l'écoute. Couper un envoi Meta en plein vol
échangerait « un message de trop » contre « un message parti que nous n'avons pas enregistré », qui est pire.
La garde se pose donc ENTRE deux effets. Le signal servira aux travaux réellement annulables (recherche de
connaissance, reranker, lecture de connecteur).

~~**A1 — rattraper un tour d'agent tué par un crash.**~~ **LIVRÉ le 2026-09-03** (migration 0112). Le
watchdog prévu : `src/agent/tour-bloque-sweep.ts`, passage à la minute, réclame et clôt en UNE requête les
tours en vol depuis plus de QUINZE minutes, puis fait sortir le parcours par la sortie RÉELLEMENT DUE (le
seuil était de dix, corrigé le 2026-09-03, et la sortie était en dur). On ne rejoue
pas, comme arbitré : le worker a pu mourir APRÈS l'envoi au contact. ⚠️ Il a fallu une COLONNE
(`tour_commence_le`) : « session en cours + run en attente + aucune échéance » décrit aussi un tour qui vient
d'être enfilé, et un balayage bâti là-dessus aurait tué des conversations vivantes.

~~**A3 — les deux bornes de sécurité des connecteurs HTTP.**~~ **LIVRÉ le 2026-09-03.** Résolution DNS
contrôlée (`src/lib/adresse-privee.ts`) sur les QUATRE chemins qui appellent une URL saisie par un client (le
compte a dit trois pendant un jour, l'épreuve d'une SOURCE manquait) : le
connecteur en conversation, le bouton « Test » d'une REQUÊTE, le bouton « éprouver » une SOURCE, et la lecture
de page distante (à chaque saut de redirection). Lecture bornée EN FLUX (`src/lib/corps-borne.ts`) sur les
TROIS qui lisent un corps, en OCTETS et non en unités UTF-16 (l'épreuve d'une source ne regarde que le
statut : dire « sur les mêmes » après avoir monté le compte à quatre serait faux). Le « DNS rebinding » (répondre public puis privé entre la vérification et l'appel), laissé ouvert ce
jour-là, est FERMÉ depuis le 2026-09-21 : l'adresse se revérifie à l'ouverture de la connexion (`fetchPublic`,
`src/lib/connexion-publique.ts`).

~~**A4 — la preuve de capacité.**~~ **LIVRÉ le 2026-09-03.** La photo compte désormais
les jobs `active` (elle retombait à zéro sur un job coincé), un VRAI p95 par file est calculé sur 24 h depuis
les horodatages que pg-boss écrit déjà (aucune instrumentation ajoutée, elle existait et personne ne la
lisait) et affiché dans `/ops`, l'affirmation fausse du document de SLO est retirée, et le banc agent a
désormais un mode DURÉE avec découpe par minute, et **il a tourné six minutes sur le VPS** : 1 406 tours,
738 000 tokens/minute, **zéro refus**, et aucune dérive (la durée moyenne DESCEND de 1 445 à 1 217 ms d'une
minute à l'autre). Le Gateway n'est pas le prochain plafond, et ce n'est plus une extrapolation. La mesure
longue a aussi montré une QUEUE que les rafales cachaient : 113 s pour le tour le plus lent contre 2,4 s de
médiane, soit 0,14 % des tours au-dessus de 30 s, c'est-à-dire exactement ce que `DEADLINE_MS` protège.
**Reste seulement** le profil `equite` du banc de charge, déjà listé plus bas.

🔴 **Ce que la mesure a trouvé au passage, et qui n'était dans aucun audit** : `webhook-status` se vidait à
DEUX jobs par minute (sondage 30 s, un job par sondage, travail de 0,05 s), soit 125 heures pour absorber les
15 000 accusés d'une campagne de 5 000 destinataires. Corrigé par `burstWhenReadyExceeds`. Chiffres et leçon
dans `docs/SLO-2026-09-01.md`.

**B et C de l'audit, état au 2026-09-03** (vérifiés un par un DANS LE CODE, avec contre-vérification adverse,
parce que le « lot immédiat » du 2026-09-02 en avait déjà fermé une partie et que l'audit est donc périmé par
endroits) :

- ~~**B2** sémantique de la télémétrie du pool~~, ~~**B3** validation stricte des concurrences et plafonds~~,
  ~~**B5** faux 500 sur une source absente~~ : **livrés le 2026-09-02** (lot immédiat, `f711743`).
- ~~**B4** course du plafond « tous les contacts »~~ : **livré le 2026-09-03**. Le chemin résout et FIGE son
  jeu d'identifiants, borné à `plafond + 1`, au lieu de compter puis recharger. ⚠️ La contre-vérification a
  trouvé le trou que mon propre correctif avait laissé : le câblage relayait `(tenant, target)` vers un
  contrat à trois paramètres, donc la borne était avalée EN SILENCE et le compilateur ne pouvait pas le voir
  (une flèche plus courte est assignable). Gardé par `tests/campagne-cablage.test.ts`.
- ~~**C2** contradictions documentaires~~ : **livré le 2026-09-03**, et le pire des trois n'était pas un
  document : l'infobulle « vous avez la main » promettait à l'opérateur, dans le produit, que les campagnes
  n'enverraient pas. C'est l'inverse du code, qui passe `ignoreHumanControl` et REPREND la main, délibérément.
- ~~**C3** attribution RCS~~ : **livré le 2026-09-03** (textuel). La phrase « le détail par campagne reste
  reconstructible » de la 0107 était fausse, et l'entrée de backlog décrivait un manque déjà comblé.
- **B1** échecs d'avance : **partiellement livré le 2026-09-03**. Le contexte (parcours, run, canal) traverse
  désormais, donc la jointure sur le nom du scénario sert enfin à quelque chose. ⚠️ **Trois points restent
  OUVERTS, et c'est un choix**, pas un oubli :
  (b) aucune déduplication (un rejeu Meta peut écrire deux lignes pour le même message) : demanderait une
  migration avec index unique `concurrently`, pour un journal d'exploitation dont les doublons se lisent ;
  (c) aucun état acquitté/résolu : demanderait une migration, une route d'écriture et un bouton, alors que
  personne n'a encore eu à exploiter cette table ;
  (d) purge globale sans index sur `at` : la table est petite par construction (une ligne par ÉCHEC, 90 jours
  de rétention), un balayage séquentiel quotidien n'y coûte rien.
  ⚠️ Et une fausse piste à ne pas suivre : passer `alreadySeen` à l'avance pour dédupliquer CASSERAIT la
  reprise, `insertEvent` marquant l'événement dès la première tentative, donc un rejeu pg-boss trouverait tous
  ses messages « déjà vus » et n'avancerait plus rien.
- ~~**C1** capacités imbriquées~~ : **livré le 2026-09-03**, et l'audit généralisait à tort (« recopiés de
  fichier en fichier »). Inventaire fait : **14 `Pick<` dans `src/`, 13 sont des contrats étroits légitimes,
  UN SEUL était un passe-plat**, `src/campaign/run-job.ts`, et c'est celui qui avait déjà cassé la production.
  Ses onze capacités voyagent maintenant dans un objet `moteur` transmis d'un seul spread : il n'y a plus de
  liste à tenir alignée. Gardé par trois tests de forme (`tests/clics-cablage.test.ts`), vérifiés dans les deux
  sens. Les 13 autres `Pick` n'ont pas été touchés : leurs membres sont consommés sur place, donc un oubli y
  est déjà une erreur de compilation.
- ~~**C4** découpage des gros fichiers~~ : **refusé, et la contre-vérification a tranché**. Les mesures
  (`worker.ts` 877 lignes de code, `executor.ts` 680, `CampaignCreateForm` 1 319) ne justifient pas un
  découpage, et le dépôt l'avait déjà refusé nommément le 2026-08-31 avec un meilleur argument. Le seul défaut
  VIVANT que cet item recouvrait a été corrigé au passage : deux balayages sur vingt-deux journalisaient leur
  échec sans ALERTER (`vectorisation` et `analyse-conversations`), donc une panne y restait invisible.

**Ajouté le 2026-09-02 (lot 5) : écrire le profil `equite` du banc de charge**, après le lot 6.
`docs/SLO-2026-09-01.md` l'annonçait comme une commande existante alors que `scripts/banc-charge.mts` ne la
contient pas ; la promesse est retirée du document. Il faut : deux espaces sur la même file à groupe, l'un
bavard et l'autre discret, et la mesure de l'attente du DISCRET, seuil 5 minutes. ⚠️ Il exige un Postgres
jetable ET un worker en face, sinon il mesure une file morte.

**Ajouté le 2026-09-15 (revue finale des assistants) : journaliser les CRÉATIONS et les MODIFICATIONS faites
depuis les onglets**, sur les deux surfaces. Aujourd'hui l'historique porte tout ce que les assistants
appliquent, plus les SUPPRESSIONS des formulaires (les quatre du MBA, les fiches de connaissance d'un agent).
C'est un ordre de priorité assumé : chez Meta une suppression est définitive et la ligne d'historique en est le
seul exemplaire, quand une création ratée se refait. ⚠️ En attendant, **l'écran le DIT** (`HistoriquePanel`),
parce qu'un journal qui promet plus qu'il ne montre fait conclure « ça n'a pas eu lieu » là où il faudrait lire
« ce n'est pas encore journalisé ». Les routes à couvrir : `PATCH /tenants/:t/agents/:id` (la fiche), les
écritures d'outils (`agent-tools.ts`), et les créations de FAQ, compétences, sites et documents du MBA.

Ce `todo.md` reste le **backlog de fond et l'historique des lots livrés**. Il ne porte PAS le séquencement : un
ordre écrit à deux endroits diverge, c'est déjà arrivé entre `PLAN.md` et ce fichier.

**Deux décisions produit tranchées le 2026-08-31** : **un seul numéro WhatsApp par client** (le chantier
multi-numéro sort du plan, remplacé par un refus explicite du second) et **conversations gardées 12 mois**
(plancher de 3 mois donné par Julien, quadruplé parce que l'effacement est irréversible).

## Ce que l'audit documentaire du 2026-09-08 laisse ouvert (trié le 2026-09-09)

L'essentiel est fait : le manuel est séparé de son journal, le README est redevenu un portail, et trois
contrôles automatiques empêchent le retour des dérives (compteur recopié, titre daté, lien mort). Restent
deux items, tous deux P2 ou P3 dans l'audit, aucun urgent.

🟠 **Classer les variables d'environnement, et faire de `src/config.ts` la source GÉNÉRATRICE.** Le schéma zod
porte une centaine de clés, `.env.example` en montre dix-neuf. Le manuel les range désormais en cinq familles
(secrets obligatoires, interrupteurs, capacité, rétention, paramètres commerciaux), mais cette table est
écrite à la main : c'est exactement ce qu'on vient d'interdire ailleurs. La vraie fermeture est un générateur
qui produit `.env.example` depuis le schéma. ⚠️ Ne PAS toucher au chargement des variables au passage :
documenter d'abord, générer ensuite.

🔵 **Un contrat OpenAPI pour l'API publique v1.** Utile le jour où on ouvre l'API à des intégrateurs, inutile
avant. ⚠️ À GÉNÉRER depuis le code, jamais à écrire à la main : un contrat écrit à part est un second
inventaire, donc une divergence programmée. Aucun besoin aujourd'hui, personne ne l'a demandé.

⛔ **Écarté : formaliser des ADR.** L'audit le classe P3 en notant lui-même le risque de double documentation.
Le « pourquoi » d'une décision vit déjà dans le journal technique et dans les invariants du manuel ; en faire
un troisième endroit garantirait qu'un des trois soit faux.

## Un refus d'automation n'a AUCUN écran (relevé au lot « la chaîne reprend la main », 2026-09-08)

🟠 **Le symptôme, vécu.** Un bouton de chaîne cliqué ne lançait pas son scénario. Le refus était légitime (le
fil appartenait à l'agent de Meta) et il était écrit, mot pour mot, dans le journal du worker. Nulle part
ailleurs : ni pour l'abonné, ni dans la console, ni sur l'écran des chaînes, qui affichait au même moment
« N personnes ont envoyé ce message » juste à côté. Trois heures de recherche du côté du bouton, de l'URL et
du mot-clé, pour des composants qui n'avaient rien.

**Ce lot a fermé LA cause dominante** (un clic de chaîne reprend désormais la main), mais pas la classe : les
trois autres refus de `runAutomations` restent aussi muets (anti-rebond, condition non satisfaite, plafond
horaire), et le prochain refus se diagnostiquera de la même façon, c'est-à-dire mal.

**La piste, sans alourdir.** Il existe déjà une table de journal d'exploitation purgée à intervalle
(`erreursLivraison`, les échecs d'avance, avec sa rétention et son écran). Y écrire les refus d'automation
avec leur raison, leur automation et leur contact donnerait l'endroit qui manque, sans nouvelle mécanique ni
nouvelle migration de structure. ⚠️ **À borner d'abord** : un refus par anti-rebond peut se produire des
milliers de fois par heure sur une chaîne qui marche, donc soit on n'écrit que les refus RARES (fil tenu,
condition, plafond), soit on agrège. Écrire tous les refus tels quels remplirait la table plus vite que les
envois eux-mêmes.

## Reste de l'audit sécurité du 2026-09-07

L'audit a trouvé le parc en bon état (secrets, RLS, isolation tenant, injection SQL, journalisation,
sessions : tous propres, détail dans `documentation.md`). Le seul trou de code, le plafond de débit des
routes authentifiées, est FERMÉ le jour même. Restent trois choses, par ordre de valeur.

### ✅ S'attaquer soi-même : FAIT (2026-09-07)

`scripts/auto-attaque.mts`, dans la CI. 540 sondes, inventaire pris sur le serveur construit, vérifiée dans
les deux sens (4 failles plantées, 4 détections). Détail dans `documentation.md`.

**⚠️ Question ouverte, petite mais réelle : la CI inventorie UNE route gardée de moins que ce poste** (168
contre 169, donc 148 gardées contre 149). Les deux runs sont verts et le run local couvre le sur-ensemble,
mais un écart d'inventaire est un écart de COUVERTURE : une route qui ne se monte pas en CI est une route que
la CI n'attaque jamais. Ce n'est PAS le `.env` (vérifié : même table de routes avec et sans), ni les routes
`/auth` (les 9 sont là), ni la version de Fastify (5.12.1 des deux côtés). Reste la version de Node (24 ici,
22 en CI). `npx tsx scripts/auto-attaque.mts --inventaire` imprime la liste complète : la comparer avec celle
d'un run de CI tranche en dix secondes.

**Ce qu'elle ne couvre PAS, et qui reste à faire un jour** : elle n'a jamais tourné contre la PRODUCTION.
Le mode distant est écrit et gardé, mais la couche NPM / Cloudflare / CORS réel n'a donc pas encore été
attaquée. Il faut pour ça un compte de test dédié dans un espace jetable. C'est une demi-heure, et c'est le
seul endroit où peuvent vivre des failles que le mode local ne verra jamais.

### ✅ Dépendances de `web/` remontées (2026-09-07)

`npm update` (plages semver respectées, `package.json` inchangé, seul le lock bouge) : **de 12
vulnérabilités à 7**. Fermées : `sharp`, `nanoid`, `js-yaml`, `browserslist`, `brace-expansion`, et `next`
15.5.20 -> 15.5.25 qui retombe de « high » à « moderate ». Build compilé, 213 tests web verts.

🔴 **Les 7 restantes ne sont pas ATTEIGNABLES ici, et c'est la seule raison de les laisser.** Ne pas les
rouvrir sans relire ceci :

- **`postcss`** : le nôtre est en 8.5.28, corrigé. Ce qui reste est le `postcss@8.4.31` que **Next embarque
  en interne**. Les trois avis portent sur un `sourceMappingURL` attaquant dans un commentaire CSS : notre
  CSS est le nôtre, compilé sur Vercel, personne d'extérieur n'en fournit à notre build.
- **`vitest` / `vite` / `esbuild` / `vite-node`** : l'avis critique vise l'**UI de Vitest**
  (`vitest --ui`), qu'on ne lance jamais, dans une dépendance de DEV qui n'est pas déployée.

Le seul correctif que npm propose pour les deux premiers est **next 16**, une majeure. À traiter comme un
chantier à part, avec `tailwindcss` 4, `typescript` 7, `eslint` 10 et `vitest` 5, jamais au passage d'un
`npm update`.

### 🟡 Trois broutilles relevées au passage

- **Trois faux positifs gitleaks** (`docs/MBA-API-REFERENCE.md`, `mba documentation/*`) : ce sont des
  exemples de format PEM recopiés de la doc Meta. Le hook `pre-commit` ne scanne que l'index, donc il ne
  bloque rien aujourd'hui, mais il bloquera le jour où on retouche un de ces trois fichiers. Un
  `.gitleaksignore` règle ça.
- **Un webhook entrant SANS secret** est un chemin d'écriture non authentifié (il crée des contacts et
  déclenche des automations, donc des envois facturés). Choix documenté et borné (code non devinable,
  plafond de débit par code, pris après la lecture du code depuis le 2026-09-21), mais l'UI devrait AVERTIR
  à la création d'un webhook sans secret.
- **Deux chemins d'upload qui ne se protègent pas pareil** : `src/http/media.ts` fait confiance au type MIME
  déclaré dans la data URL (allowlist par regex), là où `src/rcs/image.ts` lit les octets magiques. Risque
  faible aujourd'hui (Meta valide derrière), mais c'est l'écart qui devient une faille quand quelqu'un
  branche un troisième consommateur sur le premier.

## Contre-audit du 2026-09-01 : ce qui est retenu, verifie dans le code

L'audit complet est `AUDIT-COMPARATIF-STRUCTURE-SCALABILITE-2026-09-01.md`. Six de ses constats ont ete
REVERIFIES dans le code avant d'etre inscrits ici ; les six etaient vrais. Ce qui suit est le reste
actionnable, trie. Deux items sont deja faits (le typecheck du WIP, ferme par la brique C ; le texte du
palier et le commentaire du banc, fermes le jour meme).

**1. ✅ FAIT le 2026-09-01 (migration 0102).** Le debit par numero est desormais partage entre l'API et le
worker : le compteur en memoire devient une ligne, la reservation une instruction SQL atomique, et l'attente
se fait HORS de la base. Panne de la base = repli sur le frein local, donc le pire cas est le comportement
d'avant. La PRIORITE (faire passer l'inbox devant une campagne) n'est PAS faite et n'etait pas le sujet :
elle demanderait une file d'envoi ordonnee, donc de la latence sur le chemin interactif. Detail dans
`documentation.md`. Le constat d'origine, garde pour memoire :

~~**Le debit par numero n'est PAS partage entre l'API et le worker.**~~ `src/index.ts:192` et
`src/worker.ts:193` construisent chacun leur arbitre en memoire. Les deux conteneurs tournent DEJA en
production : pendant qu'une campagne part du worker, un operateur qui repond depuis l'inbox consomme un
SECOND budget sur le meme numero. Le debit affiche n'est donc pas une propriete du numero.
⚠️ Ce n'est pas un sujet de gros volume : ca se produit avec un client et deux messages.
**Decision a prendre avant de coder** : soit une file d'envoi durable partitionnee par numero (l'ordre et
les priorites deviennent simples, la latence interactive augmente), soit un compteur partage en base avec
bail (les chemins directs restent directs, une brique de coordination apparait). Test d'acceptation dans les
deux cas : une campagne, un scenario et un envoi inbox lances ensemble depuis DEUX process.

**2. ✅ FAIT le 2026-09-01.** La cible part en INTENTION (`contactTarget`), resolue en base, avec le MEME
analyseur que les actions en masse du mini-CRM. Quatre refus ferment le pire accident (une campagne a tout
l'espace), dont un trou PRE-EXISTANT : `contactIds: []` etait truthy et retombait sur « tous les contacts ».
Le decoupage SQL du moteur (`listPending` sans limite) reste NON FAIT, hors sujet decide par Julien.
Le constat d'origine, garde pour memoire :

~~**Le piege des 25 000 destinataires.**~~ Le front propose jusqu'a 100 000 contacts
(`idsForFilters`, cap 100 000), met tous leurs identifiants dans le POST, et la route plafonne a 1 Mo
(`src/server.ts:209`). Le JSON des seuls identifiants pese environ 975 Ko a 25 000 contacts : la casse
arrive donc bien AVANT la limite que l'ecran annonce. L'interface promet quelque chose qui echoue.
⚠️ Julien a mis les campagnes de 100k hors sujet pour l'instant, mais le piege, lui, reste pose.
La moitie du correctif ne coute presque rien : `BulkTarget` EXISTE deja dans le mini-CRM
(`{ filters, excludeIds } | { ids }`), il suffit d'envoyer l'INTENTION de selection et de la resoudre dans
la transaction. Le decoupage SQL du moteur (`listPending` sans limite) est un chantier separe, non retenu.

**3. ✅ FAIT le 2026-09-01.** La route sert un RESUME (`listResume`) : plus aucun graphe ne traverse le
reseau pour afficher des noms. `nodeCount` et `hasDraft` sont calcules en SQL, `campaignEligible` cote serveur
avec la MEME fonction que la garde de creation. `list()` reste inchangee (la resolution par code en a besoin).
⚠️ La base envoie toujours le graphe a l'application : seul le trajet vers le navigateur disparait. Aller plus
loin demanderait de denormaliser en colonnes tenues a l'ecriture, avec le risque de peremption. Le constat :

~~**La liste des scenarios renvoie DEUX graphes complets par ligne**~~ (`graph` et `draft_graph` sont
tous les deux dans `COLS`, `src/workflow/store.pg.ts:29`), pour des ecrans qui n'affichent qu'un nom.
Correctif : une projection resumee et paginee (id, code, nom, dates, brouillon en attente, nombre de blocs,
eligibilite campagne), le graphe complet restant sur `GET /workflows/:id`.
⚠️ Deux consommateurs empechent un simple retrait : `estEnLigne` a besoin du nombre de blocs, et le
selecteur de scenario de l'inbox appelle `isCampaignEligible(w.graph)`. Les deux doivent devenir des
champs calcules cote serveur, avec un test de parite, sinon la regle existe a deux endroits.
**Declencheur** : avant environ 100 scenarios par espace.

**4. ✅ FAIT le 2026-09-01 (migration 0103).** `pause_reason` + `paused_until`, un balayage qui reprend les
pauses de DEBIT echues (reclamation atomique), et une pause de QUALITE qui n'est JAMAIS reprise par une
machine. L'angle mort du 429 sans code connu est ferme aussi : il entre desormais dans `estPlafondNumero`.
Le constat d'origine, garde pour memoire :

~~**La pause Meta ne reprend jamais toute seule.**~~ Le texte est corrige (il dit desormais que la reprise
est manuelle), mais la reprise elle-meme reste a faire : `pause_reason` + `paused_until`, un debit temporaire
reessaye apres un `Retry-After` borne, une qualite degradee JAMAIS reactivee aveuglement.
⚠️ Angle mort a traiter en meme temps : un HTTP 429 sans code Meta connu n'entre pas dans `estPlafondNumero`
et finit en echec destinataire au lieu d'une pause globale.

**5. 🟠 PARTIELLEMENT FAIT le 2026-09-01.** Les SLO sont ECRITS AVANT toute mesure
(`docs/SLO-2026-09-01.md`, trois objectifs avec leurs seuils), l'age du plus vieux job PRET est instrumente
dans `/ops` (c'est la mesure qui les rend observables, la profondeur seule ne dit rien), et le profil
« entrants » du banc existe enfin (`webhooks <n>`).
⚠️ RESTE OUVERT, et c'est ecrit dans le document lui-meme : le SLO 3 (equite entre espaces) n'est
qu'A MOITIE instrumente. `/ops` donne l'age par FILE, pas par espace : un espace affame derriere un espace
bavard reste invisible. Le geste suivant est d'ajouter `group_id` au regroupement de `getQueueLoad`. Et le
profil `equite` du banc n'est pas ecrit. Le constat d'origine :

~~**Le banc de charge ne mesure pas ce qu'on lui prete.**~~ Il prouve la reprise apres kill d'une campagne
de 400 destinataires sur un worker, et rien d'autre. Manquent : le debit des entrants et son p95, l'equite
entre espaces, la rafale d'accuses, la concurrence API + worker sur un meme numero, deux workers.
🔴 **Ecrire les SLO AVANT les profils** : un resultat sans seuil d'acceptation est une observation, pas une
preuve de capacite. Trois suffisent pour commencer : delai d'un entrant, delai avant premier envoi de
campagne, age du plus vieux job par espace.

**5bis. ✅ FAIT le 2026-09-02 : le plafond de debit des entrants est leve.** La premiere mesure contre les
seuils avait donne 120 s sur une rafale de 400, soit 1,5 message/s, et j'avais conclu a un arbitrage cout
contre latence a soumettre a Julien (relever la concurrence, ou baisser la cadence de sondage). C'etait une
fausse alternative : pg-boss 12.25, DEJA installe, sait reveiller ses workers par `LISTEN/NOTIFY`. Mesure sur
le meme banc, meme rafale : 22 ms d'age maximum, 400 jobs sur 400 traites, latence moyenne 7 ms. Le levier que
Julien demandait (sondage a 0,5 s) a ete mesure aussi, honnetement : 6,06 msg/s, exactement la prediction de la
formule, et le seuil de 30 s reste DEPASSE (65 s). Detail et preuves : `docs/SLO-2026-09-01.md`.

⚠️ **Ce qui reste ouvert la-dessus, et qui est petit.** Le filet de sondage a ete pose EGAL a la cadence
d'avant, pour que le pire cas du changement soit exactement le comportement d'hier. Le defaut pg-boss serait de
30 s. Le relacher vaudrait quinze fois moins de sondage a vide sur les entrants, donc autant d'egress : c'est
une SECONDE decision, a prendre sur des mesures de production une fois l'ecouteur eprouve, jamais le jour de sa
mise en service.

**6. Non retenu, et pourquoi.** Le VERSIONNAGE IMMUABLE des scenarios (`workflow_versions`) : Julien a
tranche le 2026-09-01, « on s'encombre pas de l'ancienne version » et « tant pis on assume que le user tombe
dans le vide ». Ce n'est donc pas une dette, c'est un arbitrage. Ce qui reste utile et pas cher : **dire au
moment de publier combien de parcours vivants vont etre affectes**. Ne plus le faire les yeux fermes.

## L'attribution des clics par campagne est APPROCHÉE, pas exacte (relevé au lot RCS, 2026-09-02)

⚠️ **Le titre de cette entrée était faux et il est corrigé le 2026-09-03** : il disait « les clics ne se
voient PAS sur le rapport d'une campagne », ce qui n'est plus vrai depuis `e77434d` (2026-08-22). Le rapport
de campagne PORTE un compteur de clics (`urlClicks`, `src/stats/store.pg.ts`). Une entrée de backlog qui
décrit un manque déjà comblé fait chercher un travail qui n'existe plus.

Les clics s'affichent donc à **trois** endroits :
- le rapport de campagne (funnel), depuis le 2026-08-22 ;
- Analytics > Mes tableaux, par BLOC DE SCÉNARIO (templates depuis le 2026-08-20, blocs RCS depuis le 2026-09-02) ;
- la fiche du mini-CRM, indirectement, via l'indicateur « Engagé » qui compte désormais un clic.

**Ce qui reste vraiment ouvert est l'EXACTITUDE, pas l'affichage.** Un lien tracé n'existe qu'une fois par
(tenant, destination) : deux campagnes qui envoient la même adresse au même contact dans une fenêtre
rapprochée partagent le compteur, et rien en base ne dit laquelle a produit le clic. Le rapprochement par
proximité de temps tranche par convention. C'est acceptable tant qu'on ne VEND pas d'analytique détaillée ;
le jour où on la vend, il faudra une dimension de plus sur le lien, donc une porte à sens unique (les liens
déjà envoyés continuent de circuler).

🔴 **CETTE ENTRÉE S'EST TROMPÉE UNE SECONDE FOIS, ET DANS L'AUTRE SENS. Corrigé le 2026-09-08.** Elle
affirmait : « une campagne DIRECTE (sans scénario) n'a donc aucun compteur de clics, sur aucun des deux
canaux ». C'est l'INVERSE. Le comptage filtre sur `template_name is not null` : il sert donc les campagnes
à TEMPLATE, c'est-à-dire précisément les campagnes directes, et rend `null` pour les campagnes à SCÉNARIO,
dont `template_name` est nul. Vérifié dans `src/stats/store.pg.ts` en écrivant le lot E, et gardé par un
test d'intégration qui exerce les deux cas.

✅ FAIT le 2026-09-09 : les clics d'une campagne à SCÉNARIO sont rattachés, bloc par bloc, dans la fiche
qui s'ouvre en cliquant une ligne du tableau du coût. L'attribution est celle des envois (la dernière
campagne scénario réclamée pour ce numéro avant le clic), et elle s'appuie sur
`tracked_link_clicks.contact_id` (migration 0106). La case du TABLEAU, elle, dit désormais « sans lien
tracé » et non « non attribuable », qui se lisait comme une panne d'attribution alors qu'il n'y a
simplement rien à mesurer.

⚠️ CE QUI RESTE, ET C'EST DÉFINITIF : les clics venus d'un template approuvé AVANT le 2026-09-02 portent
une URL figée chez Meta, sans jeton, et n'auront jamais d'identifiant. La fiche les compte à part et dit
pourquoi. Aucun code ne changera ça.

⚠️ Deux entrées de backlog fausses sur le même sujet, à un jour d'intervalle, dans les deux sens : ce qui
les a produites n'est pas l'inattention, c'est d'avoir décrit le code de mémoire. Une affirmation sur ce que
le code fait se relit DANS le code avant d'être écrite ici, ou ne s'écrit pas.

⚠️ À dire honnêtement le jour où on le fera : le compteur sera juste pour les envois ATTRIBUÉS, et muet pour
les templates approuvés avant le 2026-09-02, dont l'adresse figée chez Meta ne porte pas de jeton.

## Des faux de test mentent encore au compilateur (relevé au lot « le déclencheur gagne », 2026-09-07)

Le lot en a corrigé quatre, qui portaient un `as unknown as WorkflowExecutorDeps['runs']` ou un
`deps as never`. Ils avaient fait exactement ce qu'un transtypage fait : quand `closeActiveByWaId` est
devenue requise, le compilateur a nommé les fabriques honnêtes et **a laissé passer les menteuses**, qui ont
planté à l'exécution.

Il en reste, sur d'AUTRES dépendances : une dizaine de `as unknown as WorkflowExecutorDeps['agentSessions']`
et `['rcs']` (`tests/workflow-executor.test.ts`, `tests/workflow-avance-concurrente.test.ts`), et deux
`new WorkflowExecutor(deps as never)` (`tests/workflow-action-optin.test.ts`,
`tests/workflow-mesure-blocs.test.ts`, dont le `runs` est désormais honnête mais pas l'objet entier).

Le même incident les attend au prochain changement de ces contrats-là. À typer, fichier par fichier, quand
on touche l'un d'eux : ce n'est pas un chantier à mener d'un bloc.

## `workflow_runs_waiting_idx` est-il devenu redondant ? (relevé au lot « le déclencheur gagne », 2026-09-07)

La migration 0115 ajoute `workflow_runs_actif_idx (tenant_id, wa_id) where status in ('waiting','sleeping')`,
parce qu'aucun index ne servait la clause de `closeActiveByWaId`, désormais appelée par destinataire de
campagne.

Il rend PROBABLEMENT `workflow_runs_waiting_idx (tenant_id, wa_id) where status = 'waiting'` redondant :
une requête `status = 'waiting'` implique `status in ('waiting','sleeping')`, donc Postgres devrait pouvoir
se servir du nouveau. « Devrait » n'est pas une mesure, et cet index-là sert `findWaitingByWaId`, lu sur le
chemin chaud de CHAQUE message entrant : on ne le retire pas sur un raisonnement.

**0115 est appliquée depuis le 2026-09-07 au soir**, `indisvalid = true`, et le planificateur prend bien le
nouvel index sur la requête de `closeActiveByWaId` (`Index Scan`, là où c'était un `Seq Scan`). **Ce qu'il
reste à faire** : `explain` la requête de `findWaitingByWaId` en production et regarder QUEL index elle prend. Si elle prend le nouveau, le retrait de
l'ancien devient une migration additive de plus (un index en moins, c'est de l'écriture en moins sur une
table du chemin chaud). Si elle prend l'ancien, on garde les deux et on écrit pourquoi.

## L'état de Meta se lit connecteur par connecteur, en séquence (relevé à la revue du 2026-09-10)

🟡 `etatMeta` (câblage de `mbaPublication`, `src/index.ts`) demande la liste des connecteurs, puis les outils
de CHAQUE connecteur, l'un après l'autre. Un espace à dix connecteurs fait onze allers-retours chez Meta
avant d'afficher le moindre aperçu, et l'aperçu est appelé deux fois par publication (une fois pour montrer,
une fois pour recalculer au moment d'appliquer).

**Pas corrigé, et c'est délibéré** : sur le parc réel (une source déclarée, zéro connecteur chez Meta au
2026-09-10), la question ne se pose pas encore, et paralléliser sans mesure serait de l'optimisation à
l'aveugle. ⚠️ Ce qui le rendrait urgent : un premier client avec plusieurs systèmes branchés. Le jour venu,
`Promise.all` sur la boucle des connecteurs suffit (ce sont des LECTURES, aucune ne dépend de la précédente),
mais il faudra regarder ce que Meta plafonne en débit avant d'en lancer dix d'un coup.

⚠️ Ne pas confondre avec le contexte de publication (`ctx`), déjà posé : lui mémorise les lectures pendant
l'APPLICATION du plan, il ne touche pas au calcul de l'état initial.

## Le rangement en lot fait UN appel par conversation (relevé à la revue du 2026-09-08)

🟡 Cocher vingt conversations et choisir une destination produit vingt requêtes, envoyées à la suite. C'est
tenable : on ne coche que ce que l'écran affiche (cinquante lignes au maximum), et le geste est rare.

⚠️ Le constat portait sur le seul archivage ; depuis le 2026-09-09 la sélection va dans QUATRE destinations
(« à traiter », « signalé », « archivé », « désarchiver »), donc le même N+1 vaut pour chacune. Il n'a pas
empiré pour autant : c'est toujours un appel par ligne cochée, quelle que soit la destination.

Ce qui le rendrait faux : une case « tout sélectionner » sur le dossier entier. Le jour où elle apparaît, il
faut une route de rangement EN MASSE, sur le modèle de l'action en masse du mini-CRM (une cible par
INTENTION, filtres plus exclusions, et non une liste d'identifiants, qui plafonne la requête vers
25 000 contacts).
⚠️ Ne pas se contenter de paralléliser les vingt appels : chacun invalide les compteurs, donc vingt appels
simultanés feraient vingt recalculs pour un seul résultat.

## Une SECONDE route sans appelant : `GET /tenants/:id/conversations/todo-count` (2026-09-08)

Le menu de dossiers de l'Inbox rend les cinq compteurs en une lecture (`/conversations/counts`), et il a
remplacé le seul appelant de `todo-count`. La route existe toujours, elle marche, et plus personne ne la
demande. Sa fonction côté front a été retirée (du code mort avéré) ; la ROUTE est laissée en place et notée
ici, exactement comme sa sœur ci-dessous : retirer une adresse est une porte à sens unique, et rien ne presse.

⚠️ Si on la retire un jour, retirer AUSSI la dépendance `countATraiter` et son câblage, sinon il restera une
requête que rien n'appelle. Et vérifier d'abord qu'aucun client n'a bricolé dessus : elle n'est pas dans la
documentation d'API publique (`/v1/*`), mais elle est joignable.

## Une route sans appelant : `GET /tenants/:id/contacts/ids`

Depuis le 2026-09-01, la création de campagne envoie l'INTENTION de sélection (`contactTarget`) et non plus
une liste d'identifiants. Cette route, qui rendait jusqu'à 100 000 identifiants au navigateur, était le seul
chemin par lequel ils y arrivaient, et donc le mécanisme même du piège des 25 000. Elle **n'a plus aucun
appelant** (la fonction cliente a été retirée).

Elle reste montée parce qu'elle est une primitive de lecture légitime, bornée et testée, et que retirer une
route est une décision à prendre à part plutôt qu'un effet de bord d'un lot de correction. À trancher : la
supprimer (avec son test) ferme définitivement la possibilité de reconstruire le piège, la garder laisse une
brique réutilisable. Rien ne presse : sans appelant, elle ne coûte rien.

## Ce que le lot MCP du 2026-09-01 laisse ouvert

**1. Le grant OAuth 2.1 délégué (le gros morceau).** ✅ **Fait le 2026-10-03** (lot 2 du plan « Messaging Me pour
Claude Code », spec `docs/superpowers/specs/2026-10-03-oauth-mcp-design.md`), sans enregistrement dynamique : les deux
clients Claude sont épinglés, la métadonnée de ressource et le consentement sont en place. Le texte qui suit est
l'énoncé d'origine. Aujourd'hui l'accès MCP passe par une **clé d'API** à
scopes : révocable par clé, limitée en débit, déjà en place. Ce que ça ne donne PAS, et que le scénario de
Julien décrivait (`claude mcp add`, une fenêtre de login, choisir son organisation, approuver l'accès), c'est
une **délégation par (utilisateur, client tiers, espace, scopes)**, révocable par utilisateur et traçable.
C'est une TROISIÈME autorité en plus du JWT de session et des clés d'API, avec enregistrement dynamique de
client (RFC 7591), écran de consentement, et métadonnées de ressource protégée (RFC 9728). C'est ce morceau
qui décide si une DSI signe, et c'est pour ça qu'il ne devait pas être bâclé en réutilisant une clé.
⚠️ Ne pas le faire à moitié : un demi-OAuth donnerait l'ILLUSION d'un contrôle d'accès par personne.

**2. `send_template` en MCP : une décision à prendre, pas un oubli.** Julien l'avait cité dans sa liste ; il
n'est volontairement pas exposé. Ouvrir l'envoi de template à un modèle, c'est un mégaphone facturé sur un
numéro dont Meta note la qualité. Le jour où on le veut, il faut décider AVANT : un scope à part
(`mcp:send_template`, non coché par défaut), et un plafond par clé et par jour. Un test
(`tests/mcp-serveur.test.ts`) garde aujourd'hui l'absence de tout outil de template : l'ajouter obligera à le
modifier, donc à en décider.

**3. Les six copies de la modale.** `web/components/Modale.tsx` existe et sert les deux fenêtres du
qualitatif, mais `app/tags`, `app/flows`, `app/inbox`, `ContactDetail`, `MbaFaqPanel` et `MbaSkillsPanel`
portent chacun leur propre copie de la même structure, sans touche Échap ni rôle de dialogue. À faire quand
on touchera ces écrans, pas comme un chantier à part.

**4. Un résumé pour les analyses d'avant.** Les conversations analysées avant le 2026-09-01 n'ont pas de
résumé (migration 0100) et la fiche le dit. Le rattraper voudrait dire rappeler le LLM sur tout l'historique,
donc payer une seconde fois pour du confort. À ne faire que si un client le demande, et alors par lots.

## Audit de scalabilité du 2026-08-25 : les constats retenus (triés le 2026-08-29)

L'audit complet reste `AUDIT-SCALE-2026-08-25.md`. Ce qui suit est le seul reste ACTIONNABLE après
vérification dans le code : la journée 1 est faite (R2 expiration de job, R6 plafond du Retry-After,
R3 alerte de file d'échec, J0 pool à 8), et R5, R6-découpage, J1, R12 et B3 vivent dans `PLAN.md`
(5.3, 5.4, 5.5), pas ici. Les 23 jaunes de la §7 de l'audit ne sont volontairement PAS recopiés :
aucun ne casse, ils se relisent à la source le jour où on ouvre le fichier concerné.

**Faits le 2026-08-31 :** **R1** (la vérité sur `singletonKey`, qui n'a jamais dédupliqué), **R1-bis** (le
verrou d'exécution par campagne, migration 0089), **R13** (arrêter une campagne lancée), **R4** (un
déploiement ne gèle plus une campagne : balayage de reprise, bail court renouvelé, drapeau d'arrêt,
`stop_grace_period`), **R10 + J2** (le rappel « avant date » ne part plus deux fois : claim conditionnel sur
le marqueur d'occurrence, dans le runner), puis **R9** (import CSV) et **R7** (compteurs de l'inbox). Détail
dans `docs/JOURNAL-TECHNIQUE.md`, l archive.

**Il ne reste donc AUCUN constat rouge ni orange de cet audit.** R11+J3 reste ouvert, sans objet tant qu'un
seul worker tourne, et deux leviers ont été laissés SCIEMMENT, avec leur condition de déclenchement :

- **La file pg-boss d'import** (R9, point 4). Une fois l'écriture groupée par lots de 500, un fichier de
  150 000 lignes, soit le plafond de corps de la route, tient en quelques centaines d'allers-retours : le
  timeout de 100 s de Cloudflare n'est plus approché, et c'était toute la raison d'être de la file. La poser
  coûterait une table de suivi, une file de plus, un écran qui interroge l'avancement, et un endroit où
  garer 8 Mo de CSV (une charge de job pg-boss est une ligne jsonb, ce n'est pas cet endroit-là). **À
  rouvrir si** un client importe régulièrement au-delà de la centaine de milliers de lignes.
- **La colonne `unread` dénormalisée** (R7, point 3). Le comptage reste en O(conversations de l'espace),
  mais l'index partiel (0092) le ramène à une sonde d'index par conversation, et le micro-cache le fait
  payer une fois pour tous les utilisateurs d'un même client. La colonne serait le vrai O(1), au prix d'une
  valeur maintenue à chaque écriture, donc capable de mentir. **À rouvrir si** un espace dépasse la dizaine
  de milliers de conversations, ou si le comptage se voit dans les temps de réponse.
- **Le polling du fil ouvert, toutes les 4 secondes**, reste la charge de lecture dominante de l'inbox, et
  aucun des quatre correctifs de R7 ne la touche (l'audit ne le demandait pas non plus). Le vrai remède est
  un delta `?after=` ou du SSE. **À rouvrir avant** de dépasser la dizaine de clients simultanément actifs.

- 🔲 **R11 + J3. Les deux prérequis à lever AVANT tout second worker** (sans objet aujourd'hui, le compose
  fige une instance). `advance` (`src/workflow/executor.ts:1135`) lit le run puis écrit par un `setState`
  inconditionnel : deux messages du même contact avancent le run deux fois. Le bon patron existe à côté
  (`setStateSiEncoreSur`, `run-store.pg.ts:158`), il ne sert qu'au tour d'agent. ⚠️ Une course est
  atteignable DÈS AUJOURD'HUI : le process API sur les rappels RCS (`src/index.ts:801`) pendant qu'un
  webhook du même contact est traité par le worker. Et `PgWorkerHeartbeatStore.beat` écrit une ligne
  unique `id = 'worker'` : à deux workers, un mort est masqué par le vivant.


## Sorti de `wip.md` à sa vidange (2026-08-29)

Ces points vivaient dans des sections de lots déployés. Ils n’ont rien à y faire : ce sont des choses à faire.

- 🔴 **Faire tourner les deux clés d’API smsmode** qui ont circulé en clair pendant le chantier RCS. Aucune
  autre trace de cette dette nulle part dans le dépôt.
- 🔴 **Aucun workspace n’a de solde prépayé.** Conséquence directe et non évidente : les agents IA ne
  démarrent pas et le bac à sable rend 409. Tant que personne n’a rechargé, tout le lot agent est inerte,
  et l’écran ne dit pas « il faut créditer », il dit « solde épuisé ».
- **`EUR_PER_USD` n’est pas posée dans `.env.prod`** : le défaut 0,92 de `src/config.ts` s’applique. C’est
  un arbitrage commercial (marge sur la conversion), il attend Julien.
- **Un message reste dans `webhook-dlq`** depuis l’incident du 2026-08-17, et **rien ne consomme cette file**.
  Sans outil de rejeu, la seule reprise est de renvoyer le message. Un consommateur de rejeu manque.
- **L’agent RCS est peut-être déposé en mode NON conversationnel** : le choix n’est pas modifiable après coup
  et imposerait un redépôt. À vérifier avant de vendre du RCS conversationnel.
- **Le cas GTFS / Auxerre** : ne jamais confier le paramètre `grille` au modèle. Prévoir un endpoint qui le
  déduit côté serveur, avec un jeton dédié révocable.
- **Excel (`.xlsx`) en pièce jointe** : toujours ÉCARTÉ, et c'est une décision reconduite le 2026-08-31. Les
  deux bibliothèques npm restent mauvaises (`xlsx` figé en 0.18.5 avec une CVE de pollution de prototype,
  `exceljs` énorme). Le PDF et le Word, eux, sont faits (`unpdf` et `fflate`, zéro dépendance transitive).
  Un client avec un tableur exporte en CSV, qui passe.
- **L’écriture en observation depuis `/ops`** : volontairement hors lot, à trancher si le besoin revient.
- **Astérisques sur les onze champs de l’éditeur de formulaire**, et la liste des vérifications visuelles.

### À voir sur du VRAI trafic (rien de tout ça n’a encore tourné en vol)

- le **bloc Question** : aucun contact n’a jamais reçu le menu WhatsApp qu’il produit ;
- la **campagne au fil de l’eau** : aucun lead n’est passé par le webhook ;
- la **chaîne RCS complète**, depuis le dernier déploiement ;
- l’**agent IA** sur du trafic réel : une conversation tenue, un outil appelé, une sortie qui reprend le
  scénario. Tout est testé contre des mocks, rien n’a parlé à un vrai contact.

## Relevé au lot « entretien de construction » (2026-08-31)

- ✅ **Les deux failles HAUTES des briques de Fastify sont FERMÉES** (2026-08-31) : `fast-uri` 3.1.3 -> 3.1.6
  et `find-my-way` 9.6.0 -> 9.9.0, dans les intervalles que Fastify autorisait déjà, donc `package.json`
  inchangé. Et **l'image de production n'embarque plus les outils de test** : le `Dockerfile` fait désormais
  `npm ci --omit=dev`, ce qui emporte `vitest` et toute sa chaîne (109 -> 76 paquets). `npm audit --omit=dev`
  rend 0 vulnérabilité. Prouvé AVANT bascule sur l'image allégée : `migrate`, l'API qui répond sur `/live` et
  `/health`, et le worker qui démarre avec ses sept files.
- ⚠️ **L'entretien à neuf points n'a jamais été mené en vrai.** Toute la mécanique est testée contre des
  doubles ; personne n'a encore vu le modèle formuler les neuf questions à la suite, ni le creusement
  `quel_outil` se déclencher sur une vraie conversation. C'est le premier essai à faire, et il demande un
  workspace crédité (voir plus haut : aucun ne l'est).
- ⚠️ **La lecture d'image n'a été prouvée que par une sonde**, avec un pixel de test. Aucune vraie grille de
  tarifs photographiée n'est encore passée par la chaîne complète.
- **Vérification visuelle du tchat** (fil, bulles, indicateur de frappe, trombone) : à faire à l'œil, aucun
  test ne la remplace.
- **La liste déroulante d'actions SUR une règle affichée** (scénario / API / MCP), demandée le 2026-08-28,
  reste non faite SOUS CETTE FORME. Le besoin est en grande partie couvert autrement depuis le 2026-08-31 :
  le point `quel_outil` de l'entretien pose la question au bon endroit, c'est-à-dire dans la QUESTION et non
  sur une ligne de diff dont ça changerait la clé. À rouvrir seulement si l'usage montre que ça manque encore.

## 🟠 Joindre un FICHIER à un message rapide (demandé par Julien le 2026-08-28)

Aujourd'hui un bloc « message rapide » ne porte qu'une IMAGE (`data.imageUrl`, champ partagé avec le bloc RCS).
Julien veut pouvoir y joindre un document (PDF, devis, plaquette). Ce n'est pas un champ de plus : la chaîne
entière est aujourd'hui image-seulement, par construction et volontairement.

Ce qu'il faut, dans l'ordre :

1. **Migration** (la médiathèque refuse tout le reste en base) : `rcs_media.mime` porte
   `check (mime in ('image/jpeg','image/png','image/gif'))`. À élargir, avec un plafond de poids propre au
   document (les octets vivent dans Postgres : 5 Mo maximum, pas les 100 Mo que Meta accepterait).
2. **Signature du fichier** : `src/rcs/image.ts` lit la signature réelle des octets et c'est ELLE qui décide du
   type servi (un PDF renommé en `.png` est refusé). Il faut la même chose pour `%PDF-`, jamais faire confiance
   au type annoncé par le navigateur : ces fichiers sont servis sur une URL PUBLIQUE.
3. **Route publique de service** : elle sert aujourd'hui `inline` avec un nom neutre (le nom d'origine en dirait
   trop sur le client). Pour un document, décider `attachment` + nom, sachant que WhatsApp affiche le nom qu'on
   passe à l'ENVOI, pas celui de l'URL : le nom neutre peut donc rester.
4. **Envoi WhatsApp** : téléverser chez Meta (`uploadForSend` est déjà générique sur le mime) puis, selon que le
   bloc porte des boutons ou non, un en-tête `document` sur le message interactif, ou un message `document`
   avec `filename` et légende. `sendInteractive` n'expose aujourd'hui qu'un en-tête image.
5. **Canal RCS** : un document n'a pas d'équivalent dans une carte RCS. Décider la dégradation (envoyer le
   texte seul ? un lien ?) et la DIRE dans l'écran, sinon le client croira que la pièce jointe part sur les
   deux canaux.
6. **Écran** : champ de téléversement à côté de l'image, aperçu WhatsApp, et la pièce jointe visible dans la
   miniature du bloc (comme le visuel depuis le 2026-08-28).

Deux à trois heures, sur le chemin d'ENVOI en production : à faire d'un bloc, pas en passant.

## 🔴 Agent IA : les lots NON développés (L3, L4, L6, L7), du cadrage du 2026-08-23

⚠️ **CE TITRE A DIT « L2 à L7 » JUSQU'AU 2026-09-11**, alors que L2 est livré et déployé depuis le
2026-08-28, deux lignes plus bas et marqué ✅. Un titre qui contredit sa propre liste est plus lu que la
liste : il a fait annoncer à Julien un chantier en pause plus gros qu'il n'est. Il n'y a PAS de L5, la
numérotation du cadrage saute de L4 à L6.

Ce qui est livré, c'est **L0, L1 et L2** : l'agent, ses outils MAISON, sa base de connaissance, la
construction en parlant, le bac à sable, le tour de production, le solde prépayé, et les connecteurs API du
client. Tout le reste ci-dessous n'existe pas. Le
séquencement et le pourquoi de l'ordre sont en §7 de
[AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md) ; le tableau côté client est dans
[AGENT-IA-PRODUIT-2026-08-27.md](AGENT-IA-PRODUIT-2026-08-27.md).

- ✅ **L2 : le connecteur API (HTTP) du client. LIVRÉ ET DÉPLOYÉ le 2026-08-28** (migration 0088 appliquée).
  Plan exécuté : [AGENT-IA-PLAN-L2.md](AGENT-IA-PLAN-L2.md), neuf tâches. Le système se déclare dans
  **Tools > Connecteurs API**, l'agent n'y déclare que ses appels. Détail dans [documentation.md](documentation.md) §Le connecteur API d’un client.
- 🟠 **L3 : le « temps 2 ».** L'IA de construction relit les VRAIES conversations, le journal d'outils et le
  signal de mécontentement, propose des corrections et **rejoue des cas de test avant d'appliquer**. N'a de
  valeur qu'une fois qu'il existe des conversations, donc après une mise en service réelle.
- ✅ **L4 : MCP en jeton statique. LIVRÉ le 2026-09-17**, pas encore déployé. Le chantier a suivi son
  propre plan (`docs/superpowers/plans/2026-09-16-connecteurs-mcp.md`), écrit sans connaître
  `AGENT-IA-PLAN-L4.md`, qui reste lisible pour ses constats. Ce qui a été tranché AUTREMENT que ce que
  cette ligne annonçait : **URL libre validée, pas d'allowlist** (décision de Julien du 2026-09-16 ; la
  garde est la double vérification d'adresse, sur le TEXTE et sur ce vers quoi elle RÉSOUT), et le `risk`
  est **proposé par les annotations du serveur puis CONFIRMÉ par le client**, jamais dérivé, la spec MCP
  déclarant ces annotations non fiables. Ce qui a été tenu : le schéma distant est TRADUIT dans notre
  modèle, jamais transmis tel quel, et c'est ce qui fait descendre la garde anti-IDOR jusqu'aux feuilles.
  **Reste à faire, dans cet ordre** : le déploiement, l'essai réel, puis la migration `0153` ci-dessous.
  🔴 **ET L4 NE SERVIRA JAMAIS LE MBA, vérifié le 2026-09-10 sur le corpus OpenAPI officiel de Meta**
  (`mba documentation/`, version 2.0.0) : zéro occurrence de « MCP » dans les 16 specs et 12 pages, et
  surtout **aucun champ où le déclarer**. Un `agent_connector` exige `base_url` + `auth_type`
  (`OAUTH2 | OAUTH2_CLIENT_CREDENTIALS | API_KEY | BASIC | CUSTOM | NONE`) et rien d'autre ; un tool est
  un `request_definition` HTTP. **Un outil MCP n'est donc pas publiable au MBA**, et L4 ne vaut que pour
  NOS agents. Ce constat a sorti le client MCP du programme « catalogue centralisé » du 2026-09-10
  (décision de Julien), il ne l'a pas annulé ici. ⚠️ Corollaire à ne pas perdre : le jour où L4 se fait,
  la case « exposé au MBA » d'un outil MCP doit être **grisée avec la raison**, pas cochable en vain.
- 🔴 **`0153_outil_source_kind_strict.sql` : le CHECK strict sur `agent_tools.source_kind`, APRÈS le
  déploiement de L4 et pas avant.** 0152 est délibérément permissive : elle pose la clé étrangère composite
  en `MATCH SIMPLE`, donc une ligne dont `source_kind` est null lui échappe, ce qui est exactement ce qui
  permet au code d'AVANT le déploiement de continuer à créer des outils. Le CHECK strict ferme cette
  échappatoire, et il ne peut passer qu'une fois que tout le code en production renseigne la colonne.
  ⚠️ **Cette étape ne vivait que dans un plan et dans `CLAUDE.md`** jusqu'au 2026-09-17 : une étape
  post-déploiement obligatoire qui n'est écrite que dans un plan clos se perd.
- 🟡 **La description d'un outil distant entre NON DÉLIMITÉE dans le contexte du modèle.** `motsExposes`
  (`src/agent/outils-maison.ts`) concatène `outil.description`, qui est un texte écrit par le TIERS et
  importé verbatim depuis son serveur MCP. Le RÉSULTAT d'un appel, lui, est bien protégé
  (`blocResultatOutil` → `neutraliserDelimiteurs`). L'écart est réel mais partiellement couvert : c'est le
  client qui déclare le serveur, la description s'affiche à l'écran au réglage, et l'empreinte couvre la
  description, donc une réécriture ultérieure fait TOMBER le consentement. Relevé par la revue finale du
  2026-09-17 ; à traiter quand on ouvrira le sujet « instructions dans une description d'outil », qui
  concerne aussi les connecteurs API.
- 🟡 **`web/e2e/securite-navigation.spec.ts` est INSTABLE SOUS CHARGE, et c'est mesuré.** 1 échec sur 7
  exécutions le 2026-09-17, sur DEUX tests différents du même fichier (« chaque boite correspond a un
  sous-menu » et « brancher un connecteur sur le consentement ENVOIE le choix »), et 6 succès sur 6 en
  passe isolée à un seul worker. ⚠️ QUANTIFIÉ AVANT D'ÊTRE ATTRIBUÉ : le fait que la cible change d'un run
  à l'autre, et que la passe isolée soit verte, écarte une régression du chantier MCP. La piste est la
  même que celle déjà notée sur le plafond de workers du fichier de config : le serveur Next est PARTAGÉ,
  et sous charge une requête de liste arrive après le rendu. ⚠️ NE PAS l'affaiblir pour le faire taire.
- 🟡 **`web/e2e/inbox-envoi-scenario.spec.ts` est INSTABLE LUI AUSSI, et ce N'EST PAS une découverte du
  2026-09-17 : le fichier le documente LUI-MÊME depuis le 2026-08-24** (« environ un échec sur six
  exécutions de ce fichier, sur des tests différents », dans le commentaire de `choisirScenario`). Ce que
  le 2026-09-17 ajoute, c'est que la parade posée alors (réessayer le clic jusqu'à voir le sélecteur) ne
  suffit pas : trois échecs observés dans la journée, sur DEUX tests différents, entrecoupés de trois
  passes isolées à 5/5 et d'un `--repeat-each=6` entièrement vert sur le test le plus souvent fautif.
  ⚠️ QUANTIFIÉ AVANT D'ÊTRE ATTRIBUÉ : la cible CHANGE d'une exécution à l'autre, ce qui écarte une
  régression (une régression fait tomber toujours le même test). ⚠️ NE PAS l'affaiblir.
  🔴 **DEUX FICHIERS INSTABLES, C'EST UN MOTIF, PLUS UN ACCIDENT.** Le jour où un troisième apparaît, ce
  n'est plus une spec qu'il faut regarder mais le montage : un serveur Next unique partagé par quatre
  workers, où chaque spec repose ses propres `page.route`. La piste à creuser est l'isolation par worker,
  pas le durcissement des attentes une par une.
- 🔵 **L6 : MCP OAuth.** Quatre à huit fois le coût de L4, et le coût n'est pas dans le développement mais
  dans la SUPERVISION : un jeton mort ne produit aucune erreur applicative, l'agent dégrade en silence au
  milieu d'une conversation. Premier serveur à brancher : Linear. Le pire premier candidat : HubSpot (la
  console a déjà son connecteur `mm-hubspot` en production, ce serait une deuxième façon de faire la même
  chose).
- 🔵 **L7 : URL MCP arbitraire par tenant.** Décision commerciale, pas technique.

⚠️ **PIÈGE DE VOCABULAIRE, vécu le 2026-08-28, et tranché depuis.** La console a un menu **Tools** dans la
barre de gauche ET un onglet **Outils** DANS un agent. Julien a cherché le connecteur dans le menu et n'a rien
vu, parce qu'il vivait alors dans l'agent. Le partage est désormais explicite, et c'est lui qui l'a tranché :
le **système** (adresse, authentification, secret) se déclare dans **Tools > Connecteurs API**, une
bibliothèque du workspace où plusieurs agents puisent ; l'**appel** que tel agent a le droit de faire se
déclare dans son onglet Outils. Si la confusion revient malgré ça, la correction est de RENOMMER l'un des
deux, pas de réexpliquer.

## 🔴 À TRANCHER : une règle d'arrêt nommée `humain` fabrique deux poignées identiques (2026-08-29)

Trouvé en instruisant le correctif du bloc Question, **pas encore déclenché**, mais atteignable dès qu'un
client nomme une règle d'arrêt d'une certaine façon.

Le bloc agent dessine ses sorties en deux séries : celles que le client déclare, en `sortie:<code>`
([WorkflowBuilder.tsx](web/components/WorkflowBuilder.tsx), `sortiesDuBloc`), puis celles que la plateforme
pose toujours (`AGENT_SORTIES_RESERVEES` dans [nodeMeta.ts](web/lib/nodeMeta.ts)), dont les poignées sont
`sortie:humain`, `sortie:sans_source`, `sortie:plafond` et `sortie:echec`. Un code client valant `humain`,
`sans_source`, `plafond` ou `echec` produit donc **deux `Handle` de même identifiant**. React Flow retient le
premier (`getHandle`), donc la seconde ligne tire sa flèche depuis celle du haut, et les deux s'affichent
reliées. C'est exactement la famille du défaut corrigé le 2026-08-29, et `humain` est un nom parfaitement
naturel pour une règle d'arrêt.

`sortiesDuBloc` ne filtre que les codes vides. La liste réservée existe côté serveur
([src/agent/sorties.ts](src/agent/sorties.ts)), et la parité code front / serveur a déjà ses tests
(`tests/web-agent-code-sortie-parity.test.ts`).

**Le choix est produit, pas technique**, d'où le report :
- soit **refuser le code à l'enregistrement** (`ficheAgentSchema` réserve les quatre noms). Propre, mais une
  fiche existante qui porte déjà `humain` ne s'enregistrerait plus, et il faudrait le dire au client ;
- soit **fusionner à l'affichage** : une règle client `humain` et la sortie réservée « Transfert à un humain »
  veulent dire la même chose, donc une seule ligne. Rien ne casse, mais la ligne du client disparaît du
  canevas sans explication ;
- soit **refuser à l'enregistrement ET absorber l'existant** à l'affichage. Le plus complet, le plus cher.

## Ouvert par la tranche 19c du bloc agent IA (2026-08-28)

**Dire à l'admin qu'une suppression de compte a éteint des outils d'agent.** Supprimer un utilisateur éteint
maintenant les outils d'agent qu'il avait mis en service (sans quoi le `delete` échouait en `23514`, cf. le
plan agent IA, tranche 19c). La réponse HTTP rend toujours `{id, deleted: true}` : seul un `console.warn`
côté serveur dit combien de réglages sont tombés. Conséquence : si un agent cesse d'envoyer un bloc après un
départ, il faut penser à chercher ce log. Renvoyer le compte dans la réponse du `DELETE` et l'afficher sur
l'écran Admin fermerait le trou. Non fait tout de suite parce que `UserMutation` est partagé avec
`setRole`/`setDisabled` et qu'aucune route de `users.ts` ne trace d'audit aujourd'hui : le faire ici seulement
serait incohérent.

**Confirmer avec Julien que `mba_envoyer_bloc` doit rester IRRÉVERSIBLE.** Déclaré tel quel en 19c (un message
parti chez un contact ne se rappelle pas, et il est facturé), donc l'agent ne peut pas envoyer un bloc tant
que l'autonomie n'est pas cochée sur cet outil. Si l'envoi de bloc doit être libre par défaut, c'est une ligne
dans `src/agent/outils-maison.ts`.

## 🆕 Ouvert par le second relevé de doc Meta du 2026-08-26 (soir)

Détail complet et citations : `docs/MBA-API-REFERENCE.md`, section « Second relevé du 2026-08-26 ».

- 🔴 **Agent Budget (`{business_manager_id}/agent_budget`), à mesurer puis à arbitrer.** Un plafond
  d'usage (jetons sur le Business Manager, ou tours d'IA **par conversation**, sur fenêtre glissante de
  1 à 30 jours) qui, une fois atteint, **arrête l'agent et bascule la conversation vers un humain** par la
  route de passation déjà configurée. C'est notre thèse produit, offerte en natif. Deux inconnues avant
  d'en faire quoi que ce soit : le 403 « not enabled for this business integration » (porte ouverte ou
  fermée pour nous ?), et le fait que cet endpoint attend le **Business Manager ID**, pas le
  `phone_number_id` de tous nos autres appels.
- 🟠 **Conversation Turns (`{entity_id}/insights/conversations/turns`).** Par tour : latence bout en bout,
  étapes `LLM_CALL` / `TOOL_CALL` avec leur statut, aperçu de la sortie du modèle, entrées et sorties des
  outils. C'est le « pourquoi l'agent a répondu ça » que notre référence listait comme définitivement
  absent. À brancher quand un agent tournera pour de vrai.
- 🟠 **`crawl_error` et `completed_no_data` : MESURER avant de coder.** Annoncés par le changelog du
  2026-08-24, absents de la page de référence ET de son export OpenAPI. Quand ils seront vus sur un appel
  réel : libeller `COMPLETED_NO_DATA` (« Exploré, rien d'exploitable », surtout pas en rouge) et afficher
  `crawl_error` **uniquement** si `crawl_status` vaut `FAILED` et que la valeur n'est pas vide (Meta le
  laisse vide pendant le crawl et sur tout crawl ayant ramené des pages).

## ⚠️ Revue du bloc Question : ce qui n'a PAS été instruit (2026-08-26)

La revue adversariale du bloc Question a rapporté **39 défauts**, chacun devant être soumis à deux sceptiques
chargés de le réfuter. **La moitié des réfutations n'a jamais tourné** (limite d'usage atteinte en cours de
route), et le décompte a écarté ces défauts-là par construction : un défaut dont AUCUN juge n'a pu se
prononcer compte comme non confirmé.

**Les 10 confirmés ont été vérifiés dans le code et corrigés** (commit `52a33b6`). Ce qui suit est la liste
de ce qui n'a été NI réfuté NI instruit, à reprendre à tête reposée. Aucun n'est bloquant à vue d'œil,
mais aucun n'a été vérifié non plus.

- **Le plafond du corps d'une liste.** J'ai retenu 4096 caractères, relevé sur la référence Cloud API que j'ai
  lue moi-même. Un relecteur affirme 1024. Non tranché : à vérifier à la source avant qu'un client écrive une
  question longue.
- **Échéance de plus de 7 jours.** Un relecteur soutient qu'elle sort du garde-fou d'unicité de parcours, donc
  que deux scénarios pourraient écrire au même contact. Plausible, jamais vérifié.
- **Reprise pendant un fil GELÉ** (repris par un humain ou par l'agent) : `resume` clot le run, là où
  `advance` refuse explicitement de le faire. Comportement hérité du bloc Attente, pas introduit ici, mais il
  prend un sens nouveau sur une question.
- **Délai remis à zéro après avoir relié « Pas de réponse »** : la sortie disparaît de l'éditeur, l'arête reste
  dans le graphe. Branche morte, invisible.
- **Le journal de conversation garde la question, pas le menu** : un opérateur qui relit un fil ne voit pas
  les choix qui ont été proposés.
- **Trous de couverture nommés** : ~~`wiring.sendQuestion` n'a aucun test~~ (fermé le 2026-10-03 : « liste ou
  texte » est exécuté par `tests/workflow-envois-bloc.test.ts`) ; la branche `question` de
  `waitBeforeSessionMessage` côté front n'est exercée par aucun cas ; rien ne
  prouve de bout en bout qu'un `row:<i>` reçu du webhook redescend jusqu'au routage.

### 🔴 Un point qui touche la base de PRODUCTION

`tests/integration/question-timeout.integration.test.ts` appelle `claimDueQuestions(50)` **sans filtre de
tenant** : il réclame donc aussi les échéances réelles d'autres espaces qui seraient dues au même instant.
Depuis le passage au BAIL, le dégât se limite à repousser leur réveil de 15 minutes (avant, la version qui
consommait l'échéance l'aurait détruite). À borner au tenant du test avant que des clients aient des
questions en vol.


## ⚠️ En attente d'une VÉRIFICATION EN VOL (2026-08-26)

Deux fonctionnalités sont livrées et déployées, mais AUCUNE n'a encore été vue fonctionner sur du vrai
trafic. Les tests prouvent que notre code émet la bonne forme, pas que Meta réagit comme attendu. Tant que
ce n'est pas fait, ne pas les compter comme acquises.

**1. L'image sur un bloc « message rapide »** (commit `f6f7be5`). La référence Meta documente les types
d'en-tête (text/video/image/document) et le fait qu'un média se donne par `id` ou par `link`, mais elle ne dit
PAS explicitement que l'en-tête est accepté sur le sous-type « boutons de réponse ». Un seul envoi réel
tranche. Trois issues possibles : le message arrive avec l'image (c'est réglé) ; Meta refuse l'envoi (le bloc
remonte son refus, et on bascule sur le lien plutôt que l'identifiant, ou sur deux messages) ; le message
arrive SANS l'image, et c'est le cas embarrassant car rien ne le signalerait.

**2. Le déclencheur « publicité » (CTWA)** (commit `bee7137`). Sur 275 corps de webhook conservés depuis
juillet, aucun ne contient `referral` ni `ctwa_clid` : personne n'a encore pointé de pub sur ce numéro.
⚠️ Le « réglage d'attribution à activer » côté WhatsApp Business n'est attesté que par un fournisseur d'API
non officielle (recherche du 2026-09-22) : la doc Cloud API ne le connaît pas. La preuve viendra de l'essai
réel du lot 3 des pubs (`docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md`) : une ligne dans
`arrivees_pub`, la fiche qui porte « Pub (identifiant) », et le scénario qui part.

## À faire : renvoyer les conversions publicitaires à Meta (`ctwa_clid`)

Le déclencheur « publicité » est livré (2026-08-26) : on sait de quelle pub vient un lead et on le route vers
un scénario. Ce qui reste, et qui a une vraie valeur commerciale : **refermer la boucle d'attribution**.
`ctwa_clid` sert à renvoyer à Meta les conversions (un lead qualifié, un achat) via l'Automatic Events /
Conversions API, ce qui laisse l'algorithme optimiser la diffusion de la pub. C'est un argument de vente
concret pour un client qui fait de l'acquisition.

Deux précautions connues : `ctwa_clid` arrive parfois VIDE, et il n'est transmis que sur le premier message.
Le repli « on le retrouvera dans le payload brut » avait une DATE DE PÉREMPTION (`webhook_events` est purgée à
30 jours, migration 0093) : ✅ **c'est réglé depuis le lot 1 des pubs**, `arrivees_pub.ctwa_clid` est écrit à la
réception. Le renvoi attend la mesure du pilote (spec du 2026-09-22, § 6).

## Étanchéité des canaux : ce que le lot du 2026-08-25 a volontairement laissé

Le lot est livré (voir `AUDIT-ETANCHEITE-CANAUX-2026-08-25.md` et `.loop/etancheite-canaux.md`). Trois points
avaient été écartés sciemment ; les deux premiers sont fermés depuis le 2026-09-21 (le `channelId` est exigé
sur le rappel smsmode, et un plafond par code existant le protège : `src/http/rcs-callback.ts`). Reste :

- **Une série RCS au tableau de bord.** Les envois RCS sont sortis de la série « Service » (qui les annonçait
  comme non facturés) mais ne sont affichés nulle part ailleurs. Leur donner leur propre série, avec le coût
  smsmode en face, est le vrai correctif.

> **Le plan global vit dans `PLAN.md`.** Audit de scalabilité et lot de features séquencés ensemble,
> en 6 blocs. Ce `todo.md` reste l'historique détaillé des lots livrés et le backlog de fond.

## ✅ LOT LIVRÉ : étanchéité des canaux RCS / WhatsApp (2026-08-25)

**L'audit reste la référence** : `AUDIT-ETANCHEITE-CANAUX-2026-08-25.md`, 6 rouges, 9 jaunes, et surtout
**41 partages de canal qui sont VOULUS et qu'il ne faut pas « corriger »**. Cette dernière liste se relit
avant toute intervention dans cette zone. Le plan exécuté est dans `.loop/etancheite-canaux.md`.

Le fond du sujet, en une phrase : `workflow_runs.channel` existait, il était correctement ÉCRIT à l'envoi,
mais **jamais relu** au moment de décider si un message entrant concernait ce parcours. Un tap RCS faisait
donc avancer une branche d'une question posée en WhatsApp, et l'inverse. `advance` reçoit désormais le canal
du retour et refuse ce qui ne vient pas du bon tuyau.

Les deux décisions produit ont été tranchées par Julien le 2026-08-25 : réponse RCS libre depuis l'inbox
→ **oui, livrée** ; automations sur un message RCS → **câblées**. Le troisième point (`lastInboundAt` poussé à
HubSpot) est résolu sans arbitrage : le champ est restreint à WhatsApp, puisque sa raison d'être écrite est
de piloter la fenêtre 24 h de Meta ; un besoin « dernier contact tous canaux » prendra un champ DISTINCT.

Ce qui reste ouvert est plus bas, section « Étanchéité des canaux : ce que le lot a volontairement laissé ».

## ✅ Laissé ouvert par le lot « Journée 1 », puis FAIT le 2026-08-31

Les deux chemins que le correctif voisin ne couvrait pas sont fermés : le **plafond de temps d'un appel
sortant** (30 s pour une API ordinaire, 120 s pour un modèle, l'échéance de l'appelant restant prioritaire) et
le **dimensionnement de l'enfilement du retry-sweep**. Détail et pièges dans `documentation.md` §Journal des
lots livrés.

⚠️ **Le même trou de plafond existe dans le connecteur** (`mm-hubspot/src/http/transport.ts`), consigné dans
le `todo.md` de CE dépôt-là.

## Ouvert par le lot « webhooks entrants » (2026-08-23)

- **Aucun appel d'un VRAI outil du marché.** L'arbre de mapping est éprouvé sur des payloads fabriqués. Ce
  que Zapier, Make ou HubSpot envoient réellement (enveloppes, tableaux imbriqués, clés à points) n'a pas été
  regardé. À faire au premier branchement client, en gardant le payload sous les yeux.
- **Un type de valeur invalide fait échouer l'appel ENTIER.** `upsertContactsFromApi` refuse l'enregistrement
  dès qu'une valeur ne passe pas la validation de son champ (du texte dans un champ nombre) : le téléphone est
  perdu avec. Seule la LONGUEUR est filtrée en amont. Le corriger demanderait soit une écriture partielle dans
  le chemin partagé (qui servirait aussi l'API publique et l'import), soit une validation par type dans la
  route, donc une seconde copie des règles. À trancher si le cas se présente vraiment.
- **Pas de journal des appels.** On garde le DERNIER payload, jamais un historique (choix RGPD). Un
  intégrateur qui débogue « mon 3e appel n'a rien fait » n'a donc rien à regarder. Un journal des RÉSULTATS
  sans les corps (horodatage, contact, champs, scénario) serait le bon compromis, il n'est pas fait.
- **Le plafond de débit est en mémoire du process.** Comme celui de `/v1`. À plusieurs instances d'API, le
  plafond réel est multiplié par leur nombre. Sans objet aujourd'hui (une seule instance).
- **Un webhook désactivé rend 404, pas 410.** Un outil tiers ne peut donc pas distinguer « supprimé » de
  « éteint ». C'est délibéré (ne rien révéler), mais ça complique le diagnostic côté client.

## Ouvert par le lot « 5 corrections » (2026-08-21)

- **Le compteur de clics reste un compteur de TEMPLATE, pas de campagne.** Un lien ne sait pas quel envoi l'a
  porté : deux campagnes sur le même template lisent le même chiffre. Le funnel le dit sous le graphe. Le
  rendre exact demanderait un lien par destinataire (donc un template par campagne, ce que Meta ne permet
  pas) ou un paramètre dynamique dans l'URL du bouton, à évaluer.
- **Les compteurs déjà pollués ne sont pas purgés.** Les 70 clics de Meta sur `testurl` restent en base ; le
  seuil « depuis le premier envoi » les écarte à la lecture. Rien à supprimer, donc rien d'irréversible, mais
  une lecture brute de `tracked_link_clicks` reste trompeuse.
- **Aucun envoi réel n'a encore exercé la chaîne de bout en bout** : le tap de bouton (`type = 'button'`) est
  déduit du code du webhook, pas mesuré sur un vrai destinataire. À vérifier au premier envoi réel d'un
  template à boutons.
- **`buttonReplies` ne distingue pas « aucun bouton » de « zéro tap ».** `urlClicks` le fait (`null` vs `0`),
  parce que la table des liens tracés dit si le template porte un bouton URL. Rien ne dit l'équivalent pour
  les boutons de réponse rapide sans interroger Meta. L'étape n'apparaît donc qu'à partir d'un tap. Choix
  assumé : mieux vaut une étape absente qu'une étape à zéro qui accuse les destinataires.
- **Les messages d'erreur venus du SERVEUR restent en français**, dans les deux langues. `http.ts` ne traduit
  que ses deux replis ; `body.error` est rédigé côté API et passe tel quel. Le vrai correctif serait un code
  d'erreur stable traduit côté front, à faire si un client anglophone arrive.
- **Le motif d'un refus Meta n'est pas récupéré** : `list()` ne demande pas le champ. L'écran renvoie donc à
  la liste des templates au lieu de l'expliquer. À faire si le cas devient fréquent.
- **`ENCRYPTION_KEY` manque au `.env` local** : 6 tests d'intégration de `email-account-store` échouent chez
  moi pour cette seule raison. Sans effet sur la production, mais la suite d'intégration n'est pas verte à
  100 % en local tant que la clé n'y est pas.

## 🔴 MBA : ce qui reste après le chantier « paramètres d'activation » (livré le 2026-08-21)

**Le chantier est DÉPLOYÉ** (écran Activation, migration 0067, règle du texte libre, abonnement webhook).
Dossier complet dans `.loop/mba-parametres-activation.md`. Ne restent que les deux points ci-dessous, dont
le premier ne dépend pas de nous.

### Ce qui reste à faire, dans l'ordre
1. 🔴 **BLOQUÉ PAR LE MOYEN DE PAIEMENT** : provoquer un VRAI transfert en conversation WhatsApp réelle.
   Sans moyen de paiement rattaché au compte, aucun message WhatsApp n'atteint l'agent : le bac à sable
   (`agent_test`, onglet « Tester ») est le SEUL canal. Rien à tenter d'ici là, ce n'est pas un manque de
   notre côté. Le jour où c'est rattaché : envoyer « je veux parler à un conseiller » au
   `+33 5 25 68 03 01` (`phone_number_id=1305301719324792`, WABA `1067000669256166`) et regarder si l'on
   reçoit `messaging_handovers`, sous quelle forme, si la suite bascule de `standby` vers `messages`, et si
   l'écho du message de transfert arrive. Puis corriger `ownerFromHandover` (`src/webhooks/handover.ts`),
   dont la lecture est DEVINÉE et probablement INVERSÉE. Le module journalise déjà tout payload reçu
   (`handover_recu`, `standby_echo`) : la trace sera là.
   ✅ **FAIT le 2026-09-10 au soir, sur le `+33 5 25 68 02 50` et non sur l'autre numéro.** Réponses aux
   quatre questions, toutes mesurées : on reçoit bien `messaging_handovers` ; la suite bascule bien de
   `standby` vers `messages` ; l'écho du message de transfert arrive. **Et « probablement INVERSÉE » était
   juste** : le repli « le texte contient `business_agent` » lisait `previous_owner_app_role`, donc le
   détenteur PRÉCÉDENT, et concluait l'inverse. Deux autres défauts sont tombés avec :
   `recipient` est un OBJET (le client vit dans `sender.phone_number`), et un `messaging_handovers` n'a
   AUCUN `metadata` (le numéro business vit dans `recipient.phone_number_id`).
   🔴 **CE QUI A DÉBLOQUÉ L'ATTENTE N'ÉTAIT PAS LE NUMÉRO, C'ÉTAIT UN RÉGLAGE** : `messaging_handovers` ne
   se déclenche QUE si le bloc `handoff` est configuré chez Meta, et il valait `null`. On a attendu des
   semaines un événement qu'aucun numéro n'aurait envoyé. Forme réelle et tests : `tests/handover-reel.test.ts`.
   ✅ L'abonnement webhook, lui, est FAIT (2026-08-21) : `messages`, `standby` et `messaging_handovers` sont
   souscrits sur l'app. Ce n'est donc plus un prérequis manquant.
2. 🔲 **La pastille « quelqu'un a besoin d'aide »** dans l'inbox. Demande une donnée NOUVELLE : `app_human` ne
   distingue pas « escaladé, personne ne s'en occupe » de « un opérateur a répondu », donc la pastille ne
   pourrait jamais s'éteindre. Et le balayage de reprise rebascule après le délai même si personne n'a rien
   fait : une demande d'aide peut donc s'éteindre toute seule. À ne faire qu'APRÈS le point 1.
3. 🔲 **Le texte lu par le client hors horaires** reste celui de Meta. Nous ne l'écrivons pas encore
   (`message` + `message_selection: CUSTOM`), parce que le comportement réel de ces deux champs n'a pas été
   mesuré. À traiter avec le point 1, sur le même test réel.

### Faits à ne pas re-chercher
- `handoff` a **trois** champs : `enabled`, `message`, `message_selection` (DEFAULT/AGENT/CUSTOM).
  🔴 `enabled` **n'active pas** le passage de main, il décide si l'agent LÂCHE le fil après l'avoir annoncé.
- « Je veux parler à un conseiller » -> `handoff_reason: customer_request`, **déjà mesuré** sur notre numéro
  de test. Le déclencheur est natif, rien à câbler.
- **Deux interrupteurs MBA** : `mba_enabled` (Accueil) ne fait PAS répondre l'agent, c'est le **rollout**
  (MBA > Vue d'ensemble) qui le fait. Asymétrique : `false` coupe TOUTES les conversations, `true` ne reprend
  que les nouvelles.
- Sur le WABA de test, **deux** apps sont abonnées : la nôtre et « Business Agent » de Meta. `subscribed_apps`
  liste les APPS, pas les CHAMPS ; les champs se lisent sur `{app_id}/subscriptions` (jeton d'application).
- ❌ Une skill = trois champs de TEXTE chez Meta. Elle ne produit aucun effet chez nous, elle ne fait
  qu'influencer le modèle. Ne jamais la vendre comme un transfert garanti.

## 🔲 CI rouge par intermittence : `inbox-envoi-scenario` et `campaign-carousel-preview` (mesuré 2026-08-21)

**Ce n'est pas une régression** : mesuré sur 5 exécutions, les échecs CHANGENT de test d'une fois sur l'autre,
et les deux fichiers passent **25/25** et **6/6** en isolation, y compris avec 4 workers.

| Exécution | Échecs |
|---|---|
| local (20/08 au soir) | aucun, 192/192 |
| CI | campaign-carousel |
| CI (rerun, même commit) | campaign-carousel + inbox-envoi-scenario |
| local | campaign-carousel + inbox-envoi-scenario |
| local | inbox-envoi-scenario seul, sur un AUTRE test du fichier |
| local (23/08, suite complète) | inbox-envoi-scenario seul, « fenêtre FERMÉE » |
| local (23/08, suite complète, rerun) | aucun, 246/246 |
| local (23/08, fichier seul, 3 fois) | aucun, 5/5 à chaque fois |

**Point commun constant** : le chargement de la liste des SCÉNARIOS (`wfSelect`, `scenario-select`), qui
attend workflows ET templates puis filtre par éligibilité. Ce sont les deux écrans les plus lourds de la suite.

**Cause** : contention. 4 workers partagent UN serveur Next (`playwright.config.ts`), et le budget du TEST
(30 s par défaut) est mangé par le chargement de l'écran avant que l'assertion commence.
`campaign-carousel-preview` a déjà reçu 90 s pour cette raison exacte ; `inbox-envoi-scenario` est resté à 30 s
alors que son `ouvrirPanneau` réessaie déjà pendant 20 s.

**Deux pistes, dans cet ordre :**
1. Aligner le budget de `inbox-envoi-scenario` sur les 90 s de son jumeau. Ce n'est PAS affaiblir un test :
   les assertions ne bougent pas, on rend seulement au test le temps que la contention lui prend.
2. 🔴 Un échec reste INEXPLIQUÉ par la contention : en CI, `carousel-cards` et « Séjour à Nice » étaient
   visibles mais « Séjour à Lyon » **absent du DOM** (`element(s) not found`, pas un timeout). Les deux cartes
   viennent pourtant du même `.map()`. À creuser avec un trace Playwright : la CI n'uploade aucun artefact
   aujourd'hui, l'ajouter est le prérequis pour diagnostiquer au lieu de deviner.

⚠️ Ne PAS « corriger » en rallongeant encore les attentes internes : ça a déjà été fait deux fois et n'a pas tenu.

## 🔲 Bornes de journée : les mesures filtrent en UTC, l'écran raisonne en heure locale (2026-08-21)

`countByNode` (`src/workflow/node-events.pg.ts`) compare `at >= $3::date and at < ($4::date + interval '1 day')`.
Les bornes sont donc interprétées en UTC, alors que l'utilisateur choisit « aujourd'hui » dans SON fuseau.
L'été, deux heures d'événements changent de journée : un clic de 23 h 30 à Paris est compté le lendemain.

**Comment c'est apparu** : un test d'intégration a échoué en CI à 00 h 05 heure de Paris, sur un commit qui
n'y touchait pas (vérifié en relançant la CI du commit précédent, qui a échoué au même endroit). Le test a été
rendu insensible au fuseau ; le décalage de fond, lui, est toujours là.

**À décider** : soit les bornes sont converties dans le fuseau du tenant (`tenant_settings.timezone`, déjà
lu ailleurs), soit on assume l'UTC et on le dit à l'écran. Aujourd'hui ce n'est ni l'un ni l'autre.
Concerne les mesures par bloc, et probablement les autres agrégats datés d'Analytics : à vérifier ensemble.

## Ouvert au 2026-08-20 (traçage des liens + statut manager)

- ✅ **TRANCHÉ le 2026-09-14 : un MANAGER consulte les écrans de conformité.** Julien : « ouvre la console aux
  managers sur les écrans de conformité ». Il atteint désormais Sécurité (accueil, Consentement, IA, Audit
  trails, Journal des erreurs) en plus de l'Inbox, et **il ne règle rien** : brancher un connecteur sur le
  consentement ou changer la politique d'annonce d'IA restent des décisions de la marque, refusées côté
  serveur ET masquées côté écran. Consulter et décider ne sont pas le même geste.
  ⚠️ **La liste vit dans `web/lib/nav.ts` (`ECRANS_ENCADREMENT`), et deux choses en dérivent** : la garde
  d'accès de la console et le FILTRAGE du menu. Les écrire séparément reproduirait le défaut que la revue du
  chantier 6 a trouvé dans l'autre sens : une garde serveur qui nomme `manager` pendant que la console ne
  l'y mène jamais.
  ⚠️ **Le reste des prérogatives d'un manager n'est toujours pas décidé** : campagnes, contacts, scénarios,
  réglages. Ça se décide écriture par écriture, comme avant.
- 🔲 **Premier test RÉEL du traçage des liens, de bout en bout.** La redirection est vérifiée en prod (302 +
  clic compté) et la substitution est vérifiée en test contre un faux Meta, mais **personne n'a encore créé un
  template avec un lien depuis la console**. Le maillon création -> approbation Meta -> envoi -> clic ->
  compteur n'a jamais été exercé en vrai.
- 🔲 **Nettoyer `test_lien_redir_a` et `test_lien_redir_b`** sur le WABA de test (« AuxR M le Bus MBA test »).
  Le token sait créer un template mais **pas le supprimer** sur ce compte (« Need permission on either
  WhatsApp Business Account or owner/shared business », par l'arête WABA comme par l'id). À retirer depuis
  Business Manager.
- 🔲 **Attribution par personne des clics** (reportée, pas abandonnée) : demanderait un suffixe fourni à
  l'envoi, donc un composant de bouton sur les quatre chemins d'envoi. Le lien de base ne changerait pas, les
  templates déjà approuvés n'auraient pas à être resoumis. **Julien n'en veut pas pour l'instant** : il veut
  un comptage global.
- ❌ **HORS PÉRIMÈTRE, tranché le 2026-08-20** : les liens écrits dans le **CORPS** d'un message ne sont pas
  traçables. Seuls les **boutons** le sont. WhatsApp va chercher lui-même les liens du corps pour en afficher
  l'aperçu, un compteur y compterait des robots plutôt que des humains. Décision de Julien, ne pas rouvrir
  sans qu'il le demande.

## Les deux audits de scalabilité : lequel fait foi

⚠️ **`AUDIT-SCALE-2026-08-25.md` succède à celui de juillet et le supplante.** Quand les deux se recouvrent,
celui d’août tranche : il re-statue les bloquants de juillet avec des mesures fraîches. Ce qui reste
ACTIONNABLE des deux est en tête de ce fichier (section « Audit de scalabilité du 2026-08-25 ») et dans
`PLAN.md`, dont les états ont été vérifiés item par item le 2026-08-29.

Des trois « bloquants mécaniques » de juillet, deux sont corrigés (le token Meta par tenant, le budget de
connexions Postgres) ; le troisième, un seul numéro par tenant, est `PLAN.md 5.4`.

## Plan des boucles feature-loop (ordre)

1. ✅ **Loop 1 : Webhook receiver + file + idempotence** (le socle que tout consomme).
2. ✅ **Loop 2 : Wrapper Cloud API + MM Lite** (send text/template, statuts, marketing_messages,
   erreurs + retries + throttling).
3. ✅ **Loop 3 : Contacts BSUID-native + import CSV + user fields** (parsing, dédup, merge CTA).
4. ✅ **Loop 4 : Moteur de campagne + garde-fous** (pacing, fréquence max, coupure quality rating).
5. ✅ **Loop 5 : Adaptateurs Postgres + run E2E** (stores PG, services create/run, routes HTTP
   import/campagne/run, worker campaign-run ; E2E CSV->campagne->envoi prouvé contre Supabase).

Fait ✅ : UI (login, contacts/import, campagnes) + auth JWT/RBAC + déployé **LIVE** sur
`mba.messagingme.app` (1er envoi WhatsApp réel le 2026-07-06, numéro Zadarma).

## Programme 16 features (2026-07-16) : lots restants

Lots A-E LIVE (cf `docs/JOURNAL-TECHNIQUE.md` (l archive)). Restent, dans l'ordre recommandé :
- ✅ **Lot 4b : fin du socle identifiants : FAIT (2026-07-16)** (codes des NODES mintés serveur + champs système
  déterministes + backfill, cf `.loop/lotF-identifiants-4b.md`). Reste le chantier DÉDIÉ **endpoints API publics**
  adressés par code (API keys, auth consommateur externe, scopes, rate limiting -> cadrage produit).
- ✅ **Lot 6 : i18n anglais COMPLET : FAIT (2026-07-16)** (bug lang resync fermé, day/format locale-requis,
  toggle pré-login sur les 5 pages auth, cf `.loop/lotG-i18n-anglais.md`).
- ✅ **Lot 7 : Flow avancé (#6b/#6c) : FAIT (2026-07-17)** : formulaires MULTI-ÉCRANS (onglets builder, ids
  `FORM`/`FORM_B`…, complete agrégé par refs globales, webhook INCHANGÉ), champs CONDITIONNELS (`visibleIf` ->
  propriété `visible`, sondé : champ masqué OMIS du payload, requis caché ne bloque pas), **fix node `flow`**
  (envoi interactif réel + garde fenêtre 24 h à 3 étages). Sondes LIVE avant plan + sonde committée
  `scripts/sonde-flow-live.mts` (générateur produit vs WABA réel). Cf `.loop/lot7-flow-avance.md`.
  ⚠️ Vérif Julien restante (V2) : scénario avec node Formulaire -> envoi réel reçu sur son WhatsApp,
  formulaire multi-écrans rempli -> champs contact + run avancé + carte inbox.
- ✅ **Lot 8 : Campagne « une-page » : FAIT (2026-07-17, 5 phases LIVE)** : écran pleine largeur 2 étapes
  (Préparation / Lancement), sources de destinataires (Liste de contacts requêtable par filtres / Import fichier
  + tag / HubSpot grisé), débit ajustable (mig 0033, timeout de job dimensionné), planification maintenant/plus
  tard (mig 0034, sweeper, annulable). Cf `.loop/lot8-campagne-une-page.md`. ⚠️ Vérif Julien restante (E1/V1) :
  drive navigateur du parcours complet + coup d'œil visuel (pleine largeur, filtres, slider, calendrier).
- **HubSpot import (#14, parké)** = **3e bouton de source** de campagne (le socle source-picker est prêt, il ne
  reste que la source HubSpot) : importer une liste HubSpot comme destinataires. Multi-repo : scope
  `crm.lists.read` sur l'app mm-hubspot + RE-CONSENTEMENT du portail cobaye (action Julien), client lists + route
  service-à-service côté mm-hubspot, proxy + réutilisation `importContacts()` côté mba, opt-in JAMAIS posé à
  'opted_in' par défaut (conformité). + (todo #5-tail) proposer les internal names HubSpot dans les sélecteurs.
- **Analytics palier L (suite #8)** : tracker les erreurs des envois Inbox/Workflow (colonnes d'erreur sur
  `conversation_messages` + toucher le handler de statuts webhook EN PROD, risqué → à froid).
- ✅ **ConvAnalyzer light (Lot 9) : FAIT (2026-07-17)** : bloc « Conversations (analyse) » dans Analytics
  (quanti donut/barres + table quali filtrable -> inbox), sur le moteur Pièce 1 déjà actif. Cf
  `.loop/lot9-convanalyzer.md`. **V2 (backlog)** : ~~(a) agent IA décisionnel branché sur l’analyse~~ **FAIT AUTREMENT, et mieux**
  (2026-08-03) : le déclencheur d’automation `conversation_analyzed` existe, donc une analyse démarre un scénario,
  qui sait poser un tag, écrire dans HubSpot et envoyer. Restent ouverts :
  (b) enrichir le schéma d'analyse pour reprendre ce que le vrai convanalyzer a en plus (urgence graduée 0-5,
  score d'échec du bot, churn, clustering de sujets) ; (c) tendance temporelle stable (joindre
  `conversations.created_at`, pas `conversation_analysis.created_at` qui bouge à la ré-analyse).
- ✅ **Palier 2 : champ booléen + consentement de flow : FAIT (2026-07-17)** : canonicalisation booléenne
  (`crm/fields.ts`, partagée fiche/import/webhook), OptIn de flow -> champ booléen choisi (défaut `whatsapp_optin`
  créé à la volée) ET flip `opt_in_status='opted_in'` (opt-out écrasé, décision Julien), garde double-consentement.
  Cf `.loop/palier2-consentement.md` + cadrage `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md`.
  ⚠️ Dette test : `toBElems` (FlowBuilder) non testé unitairement (fonction non exportée) -> exporter + test
  (optin défaut -> saveTo vide ; optin cible explicite -> saveTo non vide). ⚠️ Vérif Julien : flow avec écran
  de consentement -> coché -> champ « Oui » + statut opt-in + éligibilité campagne marketing.

## Décisions API/HubSpot tranchées (2026-07-17) -> paliers restants

Cf `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md` (D-1..D-10 validées par Julien). Paliers :
- ✅ **Palier 3 (Phase A+B) : API publique v1 : FAIT (2026-07-17)** : clés d'API (`api_keys`, scopes
  contacts:write/sends:create, rôle synthétique 'api'), résolveur code+nom (409 ambigu), `POST /v1/contacts`
  (+ batch), `POST /v1/sends` (scénario + template, `Idempotency-Key` obligatoire + claim atomique, rapport
  skipped détaillé, upsert-then-send), `GET /v1/sends/:id`, CRUD clés admin. Migration 0035. Cf
  `.loop/palier3-api.md`. Reviewer sécurité : 🔴 double-envoi (idempotence libérée post-enqueue) trouvé + corrigé.
  - ✅ **Phase B2 : cible node : FAITE (2026-07-18)** : `WorkflowExecutor.startFromNode` (garde 24 h de `start`
    conservée intacte), `PgInboxStore.getWindowOpenByWaIds` (fenêtre en lot, 1 requête), `Campaign.startNodeId`
    de bout en bout, branche `startWorkflowFromNode` du moteur, `POST /v1/sends` accepte `{node:'nod_...'}`.
    Hors fenêtre -> `skipped:{reason:'out_of_window'}`, jamais d'envoi. `createMissing` forcé à false et `params`
    refusé (400) sur cette cible. Aucune migration (0035 portait déjà la colonne). Reviewer PASS.
    Cf `.loop/palier3-b2-et-robustesse.md`.
  - ✅ 🟡 **follow-up enqueue : FAIT (2026-07-18)** : retry borné (3 tentatives, backoff 100/300 ms) au lieu d'un
    sweeper. Motif : un sweeper qui ré-enfilerait les campagnes `draft` relancerait aussi les brouillons créés à
    la main dans l'UI et jamais lancés volontairement (= envois non désirés). L'idempotence reste scellée
    inconditionnellement sur tous les chemins.
  - 🟡 **runs de workflow orphelins** (reviewer 2026-07-18, pré-existant, rendu probable par la cible node) :
    `PgWorkflowRunStore.findWaitingByWaId` prend le run `waiting` le plus RÉCENT. Un contact qui avait déjà un run
    en attente (campagne scénario) et à qui on envoie un bloc se retrouve avec 2 runs : le 2e avance et se
    termine, puis une réponse ultérieure réveille le PREMIER et envoie un message que personne n'a demandé.
    Correctif proposé : dans `PgWorkflowRunStore.start`, clore les runs `waiting` du même (tenant, wa_id) avant
    l'insert (l'index partiel `workflow_runs_waiting_idx` couvre déjà l'écriture). Change la sémantique de cycle
    de vie des runs pour TOUTES les campagnes -> décision Julien avant de le faire.
  - 🟡 **`phoneNumberId` ignoré à l'envoi workflow** (reviewer 2026-07-18) : `/v1/sends` valide le numéro et le
    persiste sur la campagne, mais `worker.ts` (sendTemplate/sendQuickMessage/sendFlow du workflow) résout le
    numéro via `getTenantPhoneNumberId` = le PREMIER numéro du tenant. Zéro impact avec un seul numéro ; au 2e,
    un appel API explicite partirait du mauvais expéditeur en silence. Correctif : passer `campaign.phoneNumberId`
    jusqu'aux callbacks de l'executor.
  - 🟡 **intégration `queue.integration.test.ts`** : échoue en EMAXCONNSESSION (pooler Supabase plafonné à 15
    sessions, partagées avec la prod mba-api/mba-worker). `fileParallelism: false` a réglé les 5 autres fichiers
    (17 -> 60 tests verts). Reste à borner les pools de ce test précis, ou à le pointer sur une autre base.
- ~~Palier 3 (ancien cadrage)~~ remplacé par l'entrée ci-dessus.
  Rappel de portée (fait) : `POST /v1/sends` scénario + template, node = fenêtre 24h uniquement (D-1, Phase B2).
- 🔶 **Palier 4 : import listes HubSpot (Phase 0+1 FAITES 2026-07-18)** : toggle self-serve + re-consentement
  ciblé (`optional_scope=crm.lists.read`, mécanisme natif HubSpot, ne touche pas les autres portails). Phase 0
  (connecteur mm-hubspot) : client Lists (search/memberships/batch-read borné 5000), OAuth optional_scope +
  granted_scopes + garde anti-hijack, route service signée `/service/lists[/contacts]`. Phase 1 (mba) : toggle
  `hubspot_lists_enabled`, proxy signé, `importHubspotList` (opt-in JAMAIS opted_in, garanti au niveau du type,
  tag `HubSpot: <nom>`). Migrations 0007 (mmhs) + 0036 (mba). Reviewer cross-repo PASS. Cf
  `~/mm-hubspot/.loop/palier4-lists-connecteur.md`.
  - ✅ **Phase 2 (UI mba) FAITE (2026-07-18)** : toggle « Campagnes via données HubSpot » + CTA re-consentement
    sur /accueil (dans le bloc portail connecté), 3e bouton de source de campagne activé + composant
    HubspotListImport (liste -> sélection -> import, tag serveur source de vérité). Reviewer logique PASS (2 🔴
    corrigés : mismatch de tag, getSettings dans Promise.all). **RESTE Phase 3 (Julien)** : re-consentement réel du
    portail cobaye 139615673 + import de test.
  - ✅ 🟡 (a) **`searchLists` paginé : FAIT (2026-07-18)** : boucle par `offset`, arrêt sur `hasMore=false`,
    `total` atteint, page vide, borne 500 listes ET borne dure d'itérations, chaque troncature loguée.
  - ✅ 🟡 (b) **`/service/*` fermé au public : FAIT (2026-07-18)** : `advanced_config` sur le proxy host NPM 22
    (`mm-hubspot.messagingme.app`), `location ^~ /service/ { return 404; }`. mba appelle le connecteur en INTERNE
    (`HUBSPOT_SERVICE_URL=http://mm-hubspot-api:8096`), donc sans passer par NPM. Vérifié après bascule : public
    `/service/lists` -> 404, `/health` -> 200, `/ingest` -> 401 (inchangé), interne `/service/lists` -> 401
    (vivant, signature exigée).
- **Palier 5 : échelle d'autonomie HubSpot (4 niveaux)** : curseur sur le dashboard (N1 suggère, N2 actions
  sûres, N3 Deal auto, N4 autonome), seuil de confiance interne calibré par niveau (D-8/D-9/D-10). 5a = N1-2 +
  curseur + setter `autonomy_level` ; 5b = N3 (Deal auto) après mesure.
- **Drop différés** : rien (0030 a droppé `workflows.status` ; codes = additifs).

## Suites des revues Automation (2026-08-03) : identifiées, NON traitées

Trois points relevés par les revues adversariales des lots E/E.2/F, jugés non bloquants et laissés de côté.
Chacun est un compromis assumé, pas un oubli.

- **Pas de sweeper des parcours en attente.** Un parcours qu'un contact ne fait jamais avancer reste « en
  attente » indéfiniment. Aujourd'hui une automation l'ignore au bout de 7 jours (fenêtre d'âge), ce qui
  débloque le contact, mais la ligne reste en base. Un balayage qui les clôt proprement serait plus sain.
- **Le numéro qui teste un scénario compte dans la statistique Contacts.** Les messages du test sont bien
  exclus des chiffres et de l'analyse, mais la fiche contact créée par le test, elle, est comptée comme
  n'importe quel contact. L'écran de test le dit, ce n'est donc pas un mensonge, juste une imprécision.
- **Le signal « nouveau contact » ne survit pas à un rejeu du webhook.** Si le traitement d'un message échoue
  après la création de la fiche et qu'il est rejoué, le contact n'est plus « nouveau » : un déclencheur
  « nouveau contact » ne partira pas pour lui. Le rendre infaillible imposerait une requête de comptage sur
  chaque message entrant, prix jugé trop élevé pour un cas qui suppose déjà un incident.

## Chantier OTP + étapes de deal HubSpot (ouvert le 2026-08-16)

Contexte et gotchas : `docs/JOURNAL-TECHNIQUE.md` (l archive). ⚠️ Le compteur de migrations vit dans `CLAUDE.md`, pas ici : cette ligne a annoncé « 0059 » pendant trente migrations.

- 🔴 **Le pilote OTP, avant toute construction.** Répondeur Zadarma sur un numéro DÉDIÉ, un OTP déclenché, et
  on regarde si Meta dicte son code à une machine ou raccroche. Aucun retour d'expérience publié : c'est la
  seule question qui décide si le full-auto vit. Ne jamais utiliser un numéro qui sert Odalys, EDHEC ou Gan
  Prévoyance : une écriture de routage les couperait.
- **Le dossier d'identité (KYC) par numéro français** : un seul dossier au nom de la société, réutilisable, ou
  un par client final ? La deuxième réponse ramène le geste manuel par la porte juridique et touche le modèle,
  pas le code. À trancher AVANT d'industrialiser.
- **Réserve de numéros en base** (migration 0056) : quel numéro est alloué à quel embarquement, et son état.
- **Route + écran qui affiche le code en direct.** Sert dans les DEUX scénarios : c'est l'affichage du repli
  assisté si le full-auto meurt, et le suivi de la capture s'il vit. Avec un bouton « renvoyer le code ».
- **Instancier `ZadarmaClient` dans `index.ts`** à partir de la config (rien ne le fait aujourd'hui).
- 🟡 **L'aperçu de template n'affiche pas le visuel d'en-tête.** `web/components/TemplatePreview.tsx` ne
  transmet pas la prop `header` que `WhatsAppPreview` accepte pourtant déjà. Purement cosmétique (l'envoi, lui,
  joint bien le visuel depuis le 2026-08-17), mais ça donne un aperçu qui ne ressemble pas au message reçu.
- ✅ **Menu des étapes de deal dans l'écran Automation** (fait et déployé le 2026-08-16).
- ✅ **Souscription webhook HubSpot envoyée** (2026-08-16, build #8 sur le compte dev 148896252). La chaîne
  est donc vivante de bout en bout ; reste à l'éprouver sur le portail cobaye avec un deal dont le contact
  porte un numéro, et un scénario qui ouvre par un template.

## Suite de l'audit anti-slop (2026-08-18) : 1 item sur 57

Les 6 rouges et 50 des 51 jaunes sont corrigés et déployés (cf. `AUDIT-ANTI-SLOP-2026-08-18.md`). Ne reste que celui-ci, laissé
volontairement à l'arbitrage de Julien.

- 🟡 **Découper `web/lib/api.ts`** (1325 lignes, 203 exports, une quinzaine de domaines) par domaine dans
  `web/lib/api/`, derrière un barrel qui re-exporte tout (aucun import appelant ne change). Le repo pratique
  déjà l'extraction avec shim de re-export (`contact-filters`, `field-kinds`). Mécanique, mais ça brasse tous
  les imports du front, d'où l'arrêt : à faire dans un lot dédié, pas en fin de session. ⚠️ Reporter le
  `'use client'` de tête dans les modules qui touchent `session`/`window`.

## MBA ouvert sur la France (2026-08-18) : ce que la doc fraîche impose d'instruire

Contexte : `agent_eligibility` renvoie `is_eligible:true` sur `+33 5 25 68 03 01` (ToS acceptées par Julien),
et Meta a modifié 6 pages entre le 11 et le 15 août dont une page `changelog` neuve. Relevé complet :
`docs/MBA-API-REFERENCE.md` § « Ce qui a changé chez Meta ». Rien n'est cassé, rien n'est branché.

- 🔴 **Relever le nom exact des deux nouveaux champs de `handoff`** (« release thread control after sending a
  handoff message » et « source du message : CUSTOM / AGENT / DEFAULT »). Leur description est documentée,
  pas leur nom : il faut le lire dans le rendu de la page ou le déduire d'un GET une fois un handoff
  configuré. Ne pas coder dessus avant.
- 🔴 **Le read-modify-write de `settings` doit repasser les clés inconnues telles quelles.** La ressource est
  en remplacement complet ; un modèle typé fermé (Zod ou interface qui ne connaît que `enabled`/`message`)
  effacerait `never_say_phrases` et les champs de handoff au premier PUT, sans que personne l'ait demandé.
- 🟠 **Dire au client qu'un moyen de paiement conditionne la LIVRAISON**, pas seulement l'activation :
  « messages are not delivered unless your Business Agent account has a payment method attached ». Rien ne le
  signale côté console aujourd'hui.
- 🟠 **Lire les deux pages Meta jamais transcrites** : `agent-insights` (quelles sources de connaissance et
  quelles skills ont servi à répondre, utile pour expliquer une réponse à un client) et `capabilities`. Elles
  sont désormais dans la veille.
- 🟡 **Modèle de coût** : les messages MBA ont un régime tarifaire propre (grille « non-template messages »),
  que notre estimation par catégorie de template ne couvre pas.
- 🟢 **`agent_test` ne facture pas les jetons** (« Tokens consumed while testing through this endpoint are not
  billed »), écrit deux fois dans la page : la QA peut s'appuyer dessus sans compter.

## Post-live : prochaines actions

- 🟡 **Aucun outil de rejeu de la file d échecs (DLQ).** Un job en échec part dans `<file>-dlq`, que RIEN ne
  consomme : il y reste indéfiniment. Un message entrant y dort depuis le 2026-08-17. Une commande `/ops` qui
  liste et rejoue une entrée éviterait de perdre de la donnée à chaque incident de schéma.
- 🟡 **Une file sans consommateur devrait CRIER.** Le worker annonce `[inerte]` au démarrage quand une
  fonctionnalité n est pas configurée, mais personne ne lit cette ligne. Une alerte (Telegram, comme
  l error-tracking) au démarrage d une file inerte aurait économisé une journée sur le déclencheur HubSpot.


- ✅ **Token permanent POSÉ (2026-07-08).** `META_ACCESS_TOKEN` = token System User permanent
  (`expires_at:0`, scopes messaging+management), dans `.env.prod` du VPS. Templates create+list
  validés en live via l'app. Détails : `brain/PROJECTS.md` §Meta/WhatsApp.
- ✅ **Placeholders demo supprimés (2026-07-08).** `demo-pn`/`demo-waba` (seed) traînaient sous le
  tenant réel et gagnaient le `order by created_at limit 1` -> 502 templates. DELETE des 2 lignes.
- **Template `mba_console_test`** (id `1507311428074574`, PENDING) : template de test créé pour prouver
  la feature. Supprimable depuis l'onglet Templates quand tu veux.
- **Onboarding client (Embedded Signup)** : Facebook Login for Business (config_id) → bouton ES +
  échange de token BISU côté backend → **Access Verification (Tech Provider)** + **App Review**
  (Advanced Access sur les perms WhatsApp, screencast par permission). Ni l'un ni l'autre requis
  pour NOTRE propre numéro (rôle sur l'app), mais requis pour brancher les WABA de clients.
- ✅ **Veille MBA POSÉE (2026-07-09)** : cron VPS `ops/mba-eligibility-watch.mjs` (crontab ubuntu,
  toutes les 6h) qui poll `GET api.facebook.com/{pnid}/agent_eligibility` (X-API-Version 2.0.0).
  Baseline = 403 « Meta Business AI Terms » (`BLOCKED_TOS`, état dans `.mba-eligibility-state.json`).
  Alerte Telegram (`@Messagingmeapp_bot`, creds lus au runtime depuis `messagingme-pilot/config.json`)
  au moindre changement d'état (mur ToS levé → MBA ouvre FR). Log `.mba-eligibility.log`.

## ✅ Suites revue templates + inbox : TOUT RÉSOLU (2026-07-08)

- ✅ **Bouton URL dynamique** : `buildComponents` émet l'`example` bouton quand l'URL contient `{{n}}`.
- ✅ **Types interactifs Flows** : `nfm_reply` capturé (corps + `response_json` en payload), réaction
  (emoji), médias (légende ou `[type]`), localisation, sous-type inconnu -> `[interactif]`. Plus de
  perte silencieuse.
- ✅ **Liaison contact** : match `'+'||wa_id` PUIS chiffres normalisés (`regexp_replace`) -> tolère un
  formatage différent.
- ✅ **Message Meta** : 502 tronqué à 200 car., espaces compactés.
- ✅ **Templates list** : pagination complète (suit `paging.next`, cap 20 pages).

## ✅ Sécurité / auth : RÉSOLU (était BLOQUANT à la revue Loops 3-5)

Auth construite et déployée : login JWT (scrypt async, rate-limit, hash leurre anti-énumération),
isolation tenant sur toutes les routes (tenant DÉRIVÉ du JWT, 403 si mismatch), RBAC (écritures
admin-only via `forbidNonAdmin`), ownership `phoneNumberId` validée, `AUTH_SECRET` fail-fast en
prod. Résidus non bloquants ci-dessous.

## Suites de la revue sécurité auth

- ✅ **RBAC** : `forbidNonAdmin` applique le rôle admin sur les écritures (import, création + run
  de campagne). Reads ouverts aux comptes authentifiés. Matrice à affiner si un rôle `agent` est
  réellement provisionné.
- ✅ **Compte démo** `admin@demo.test` désactivé en prod (password_hash null, réversible).
- ✅ **AUTH_SECRET** : boot prod échoue si absent/faible ; posé sur le VPS.
- ✅ **Unicité email** : tranché -> email GLOBAL insensible à la casse. Migration 0010 (index
  `users_email_lower_unique` sur `lower(email)`), `findByEmail` matche `lower(email)`. Fin du
  non-déterminisme multi-tenant.

## ✅ Dashboard v2 : prix templates MARCHE EN PROD (corrigé 2026-07-10)

⚠️ CORRECTION d'une conclusion erronée. J'avais écrit que `pricing_analytics` était bloqué par
l'Advanced Access (403 #200). **C'était FAUX** : la sonde avait tourné avec le token du `.env` LOCAL,
qui est limité/périmé, PAS le token permanent de prod. Re-testé DANS le conteneur `mba-api` (vrai token
`.env.prod`) : `pricing_analytics` renvoie **200 + vraies données** (marketing 0,0712 / utility 0,0248…).
Donc **le prix par template s'affiche déjà en prod** (le getPricing déployé utilise le bon token). Aucun
App Review requis pour l'analytics de NOTRE WABA. Pas de dégradation « indisponible » en réalité.

- **Leçon (cf. LEARNINGS)** : le `META_ACCESS_TOKEN` du `.env` LOCAL n'est PAS le token de prod. Toute
  sonde Meta doit tourner **dans le conteneur / avec le token de prod** (`docker cp` + `docker exec mba-api
  node ...`), jamais avec un scratch local, sinon faux négatifs (#200 « Provide valid app ID »).

## Dette Feature 2 : Admin + RBAC (revue adversariale 2026-07-10)

RBAC posé : rôles `admin`/`agent`, agent = inbox uniquement (garde serveur `makeRequireRole`
sur tous les groupes sauf inbox + templates GET, source de vérité), onglet Admin (liste users,
créer un agent, changer un rôle). Corrigé à la revue : 🔴 templates GET remis en `requireAuth`
(l'inbox agent en dépend) ; invariant « ≥1 admin/tenant » forcé EN BASE dans `setRole` (refus
`last_admin` -> 409) ; tests agent->403 ajoutés sur contacts/import. Résidus non bloquants :

- ✅ **JWT figé sur changement de rôle / révocation : RÉSOLU (2026-07-10)** : `requireAuth` relit
  l'état du compte EN BASE à chaque requête authentifiée (`getUserState` -> `PgUserStore.getAuthState`) :
  compte supprimé/révoqué -> 401 immédiat, rôle rafraîchi depuis la base. Un changement de rôle, une
  révocation ou une suppression prennent effet TOUT DE SUITE, plus de fenêtre de 12h. Coût : un lookup
  PK par requête (négligeable à ce volume). Optionnel (absent en test -> JWT seul).
- 🟡 **Oracle d'existence d'email cross-tenant** : POST /users renvoie 409 si l'email existe DÉJÀ
  ailleurs (index unique GLOBAL `lower(email)`, migration 0010). Un admin peut ainsi sonder si un
  email est déjà un compte console d'un autre tenant (fuite limitée à l'existence, message générique,
  pas de PII ni de tenant révélé). Conséquence assumée du design « un email = un compte global ».
  Fermer l'oracle imposerait de repasser à l'unicité par tenant + login scopé au tenant (changement
  de schéma qui touche le login) -> à trancher côté produit, pas en aveugle.
- 🟡 **Course théorique zéro-admin** : deux rétrogradations croisées simultanées (READ COMMITTED)
  pourraient toutes deux voir count>1. Négligeable (2 admins à la milliseconde). Fermer via
  transaction + `SELECT ... FOR UPDATE` si on ajoute un jour token_version.

## Suites de la revue Loops 3-5

- ✅ **Réconciliation `sending`** : sweeper `reclaimStale` en place (worker.ts, `STALE_SENDING_MS`),
  reset `sending` -> `pending` au-delà du timeout.
- ✅ **createCampaign transactionnel + bulk** : `createWithRecipients` est dans un BEGIN/COMMIT et
  insère les destinataires en UNE requête (`unnest`, helper `bulkInsertRecipients`, idempotent
  `on conflict do nothing`). `insertRecipients` idem.
- 🟡 **quality getRating** : lu à chaque destinataire (point-query PK). Mémoïser (TTL court) si la
  volumétrie l'exige. Dominé par l'appel Meta aujourd'hui -> laissé tel quel.

## Raffinement invariant admin (lot 6 P3, non bloquant)

Les sous-requêtes « ≥1 admin actif » de `PgUserStore.setRole/setDisabled/deleteUser` comptent
`role='admin' and disabled_at is null` SANS exclure les comptes **pending** (password_hash null, invitation non
acceptée). Non exploitable (self-block + un pending ne peut pas s'authentifier), mais correctness-of-intent :
ajouter `and password_hash is not null` aux 3 sous-requêtes pour qu'un admin invité jamais activé ne compte pas
comme « admin actif ». Défense en profondeur, à faire à froid (touche du SQL d'invariant sécurité).

## Refonte auth : ✅ FAITE (Lot 6, 2026-07-13)

Inscription libre + Google + invitations Resend + mot de passe perdu/reset/changement, tous LIVE. Détail :
`docs/JOURNAL-TECHNIQUE.md` (l archive) §Lot 6. Domaine Resend vérifié + client OAuth Google configuré (origine JS + app publiée par Julien).

## Vérifier l'identité BSUID au 1er trafic réel (lot 4)

L'envoi route déjà un BSUID en `recipient` (vs `to` pour un numéro) via `messagingTarget`, et l'inbound
auto-crée les fiches (numéro OU BSUID). Mais **aucun contact BSUID n'existe encore** (le BSUID post-octobre
n'a pas commencé à remonter). Au 1er BSUID réel : (1) confirmer le format Meta et l'heuristique
`classifyWaId` (7-15 chiffres = numéro, sinon BSUID) ; (2) vérifier qu'un template part bien via `recipient`
et est délivré ; (3) vérifier que la fiche auto-créée + le matching merge/tag/conversation collent au format
réel. Cf `documentation.md §Identité`.

## Suites builder Lot 5 : node à sorties par bouton (V2, non bloquant)

Signalés à la revue Phase 3 (sous le seuil de confiance, défense en profondeur) :
- **Snapshot des boutons figé** : le node template mémorise `templateButtons` à la sélection. Si on ÉDITE
  ensuite le template (réordonner/renommer les boutons) sans ré-ouvrir le node, le workflow garde l'ancien
  ordre -> un bouton pourrait brancher vers la mauvaise cible (le payload `btn:<i>` reste posé sur l'index i).
  Fix possible : re-fetch les boutons courants du template à l'exécution, ou invalider/re-valider le node quand
  le template change. Conditionnel (édition après câblage), pas bloquant.
- **Arêtes orphelines à la re-sélection** : changer le template d'un node déjà câblé ne purge pas les arêtes des
  anciens `sourceHandle` disparus ; combiné au repli `nextNode` (1re arête), une arête morte pourrait être
  choisie. Fix : purger les arêtes du node dont le `sourceHandle` n'existe plus au changement de template.

## Suites builder Lot 3 (V2, non bloquant)

- **Branche par bouton quick-reply** : PB2 avance aujourd'hui sur N'IMPORTE QUELLE réponse inbound. Pour un
  vrai arbre (bouton A -> bloc X, bouton B -> bloc Y), mapper les arêtes sortantes d'un bloc template sur ses
  boutons (`sourceHandle` déjà prévu dans le modèle de graphe). À faire quand un scénario réel le réclame.
- **Livraison/lecture des campagnes workflow** : message_id synthétique `wf-<id>` -> le funnel affiche
  delivered/read/replied = 0 pour ces campagnes. Câbler un vrai suivi imposerait de relier le wamid du 1er
  template envoyé par le workflow au destinataire de campagne. Limitation V1 assumée.

## Décisions ouvertes

- **OTP post-octobre** : espérer un équivalent WABA-only en ES v4 ; sinon construire le
  fallback « copy-paste assisté ». Solution Partner écarté (hors de portée court terme).
- **Vertical de notre WABA** vs les 5 verticaux MBA : trancher via `agent_eligibility`
  post-ToS.
- **PaaS** : point de décision à l'entrée Phase 3 (Fly.io Paris / Railway EU, critère RGPD).

## Dette de la revue Loops 1-2

- ✅ **Test DLQ** : test d'intégration qui prouve job qui throw -> `<name>-dlq` (retryLimit
  configurable + `pullPending`, 1 seule tentative avec retryLimit:0).
- ✅ **CI intégration** : job `integration` (service Postgres 16, `DB_SSL=off`, migrate +
  `test:integration`) ajouté à `.github/workflows/ci.yml`.
- 🟢 **parse.ts** : VÉRIFIÉ, pas de double-comptage. Chaque sous-événement a une `dedupKey`
  distincte par source (rien ne collapse) ; messages+statuses arrivent sous le même `field:messages`
  donc le routage par tableau est le bon choix (gater par `field` serait fragile aux versions Meta).
- ⏸️ **`webhook_events` renommage `meta_message_id` -> `dedup_key`** : décision de NE PAS le faire.
  Renommer une colonne sur le chemin chaud du webhook (coordination migration+déploiement, fenêtre
  d'échec d'insert) pour un gain purement cosmétique n'en vaut pas le risque ; la couche appli
  utilise déjà `dedupKey` et la colonne est documentée. `tenant_id`/`waba_id` : prématuré tant
  qu'aucun consommateur analytique n'existe (colonnes vides = spéculatif).
- ⏸️ **`processed_at`/`error`** : sémantique à trancher (log brut d'ingestion vs statut de
  traitement réel). Décision produit, pas un bug.

## Raffinements notés

- ✅ **Loop 3 / import collision** : deux colonnes -> même custom key est signalé (`report.errors`
  « colonnes fusionnées »), 1re valeur non vide gagne.
- ⏸️ **Loop 3 / slugify** : deux labels distincts -> même key = fusion (1er gagne) + warning.
  Décision : on GARDE ce comportement. Disambiguer en `ville_2` casserait silencieusement le mapping
  des variables de template (l'utilisateur mappe sur `ville`). Le warning est le bon compromis.
- ✅ **Loop 2 / `withRetry`** : ne rejoue QUE `MetaApiError.retryable` + codes réseau connus
  (`NETWORK_CODES`), pas un throw arbitraire.
- ✅ **Loop 2 / `MetaClient`** : test « `rateLimiter.acquire()` appelé à chaque tentative » ajouté.
- ✅ **Loop 5 / existence campagne** : `campaignBelongsTo` = `select 1 ... where id and tenant_id`.
- ✅ **Loop 5 / `insertRecipients`** : bulk insert (`unnest`).
- 🟡 **Loop 5 / état `queued`** : la route `run` enqueue sans état intermédiaire visible (reste
  `draft` jusqu'à `running`). Une future UI voudra peut-être un `queued`. Décision produit.
- 🟡 **Loop 5 / quality rating** : `PgQualityProvider` lit `phone_numbers.quality_rating` (défaut
  UNKNOWN). Câbler l'alimentation par webhook `phone_number_quality_update` (feature, pas un bug).

## À durcir / suites (2026-07-15)

- ✅ **Bouton FLOW dans l'envoi workflow : FAIT (2026-07-16)** : `buildWorkflowTemplateComponents` génère désormais
  le composant `{sub_type:'flow', parameters:[{type:'action', action:{flow_token}}]}` par bouton FLOW (corrige #131009).
  Vérifié empiriquement contre la Cloud API. Détail : `CLAUDE.md` §Gotchas 2026-07-16.
- ⚠️ **Variables de template non contiguës** (`{{1}}` + `{{3}}` sans `{{2}}`) : le front compte les positions distinctes
  (Set) alors que le backend attend 1..N contigu -> désalignement possible. Pré-existant (mode direct), pas introduit
  ce lot ; à corriger si un template non contigu apparaît.

## Suites Embedded Signup / i18n (2026-07-16)

- 🔄 **Refresh du business token ES (60 j)** : le token BISU par-client expire à 60 j. Aujourd'hui il ne sert qu'à
  l'onboarding (subscribe webhooks), donc son expiration est sans impact. **Quand on enverra les campagnes avec le
  token PAR-CLIENT** (au lieu du `META_ACCESS_TOKEN` global), câbler le refresh + l'alerting d'expiration.
- 📤 **Envoi via le token par-client** : le worker envoie aujourd'hui avec le token global (marche pour NOTRE numéro).
  Pour de vrais clients onboardés, router l'envoi/les lectures sur le business token du WABA du client.
- 🗑️ **Supprimer le compte de test reviewer** `meta-review@messagingme.app` (admin Demo) **après approbation** de
  l'App Review Meta. Le garder tant que la review n'est pas passée (Meta peut re-tester).
- 🌐 **i18n** : spot-check des chaînes visibles restées en français en mode EN (build vert + grep « aucune valeur
  backend traduite » OK, mais quelques chaînes rares ont pu être oubliées). Corriger au fil des retours de Julien.

## Bugs connus

- 🟡 **`web/e2e/inbox-envoi-scenario.spec.ts` est INSTABLE sous charge parallèle** (constaté deux fois le
  2026-09-02, sur deux tests DIFFÉRENTS du même fichier). Il passe 10 sur 10 en isolation et 5 sur 5 en
  répétition ciblée ; il tombe environ une fois sur trois quand les 417 e2e tournent à quatre workers.
  Son helper `ouvrirPanneau` porte déjà un `toPass({ timeout: 20_000 })`, donc son auteur le savait fragile :
  le panneau met parfois plus de 20 s à s'ouvrir quand la machine est chargée.
  ⚠️ **Ne PAS le rendre plus tolérant pour le faire taire** : il finirait par ne plus rien prouver. La bonne
  piste est de comprendre CE QUI met 20 s (probablement une attente réseau simulée qui n'est pas encore
  installée quand le clic part), pas de relever le délai. En attendant, une CI rouge sur ce fichier seul se
  relance.

## Chaîne WhatsApp (Channels Me), avant la mise en service

⚠️ **Cette section a affirmé « le front n'est PAS fait » jusqu'au 2026-09-07 au soir**, alors que les écrans
Chaîne étaient livrés, testés de bout en bout et servis en production. Un paragraphe qui décrit un ÉTAT
vieillit sans prévenir : il est réécrit ici pour ne dire que ce qui RESTE à faire.

**Livré et en service** (migrations 0114 et 0116, signeur, client, trois stores, moteur, routes, écran Chaîne
complet : composeur avec mise en forme et smileys, téléversement de photo, liens, publications avec leur
scénario et leur mesure). Ce qui suit reste ouvert.

- 🔴 **Un échec d'allumage après publication ne réveille personne.** `POST /posts` répond désormais 201 dès
  que le post est parti, et c'est voulu : un 500 aurait poussé à republier vers toute l'audience, alors que
  `createMessage` n'a aucune clé d'idempotence. L'échec part dans un champ `avertissements` et dans le journal
  (`channelsme_distant_ko`), mais **aucune alerte n'y est branchée** et aucun écran ne lit ce champ. Une panne
  SYSTÉMATIQUE de l'allumage laisserait donc des posts au bouton mort, visibles seulement dans les journaux
  bruts. Deux pistes : afficher `avertissements` dans l'écran Chaîne, et alerter sur la répétition de
  `channelsme_distant_ko` comme on le fait déjà pour les refus `/ops`.
- **Régler le plafond horaire propre au lien.** Le mécanisme existe (colonne `max_par_heure` sur le lien, et
  le runner lit le plafond de l'automation avant celui de l'instance), mais personne ne sait combien
  d'abonnés appuient sur le bouton dans l'heure qui suit une publication. Poser une valeur généreuse pour le
  pilote, puis la régler sur la mesure du PREMIER vrai post. Sans ça, le plafond global de 200 ignore les
  suivants en silence.
- **Mesurer la longueur maximale d'un texte de post** chez le fournisseur. Aujourd'hui la console comptera
  sans refuser et relaiera le 422 distant, faute de valeur connue.
- **Provisionner la connexion du tenant pilote** (org, chaîne, clé, secret) via `PUT /connection`, puis
  vérifier avec `POST /connection/test`.

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).

## Chaîne : le comptage des conversations quand la table des messages aura grossi

`PgChannelsMeLinkStore.conversationsParLien` relit les messages entrants et compte en JS, avec
`normalizeText`, parce que c'est la SEULE définition de « ce message correspond à cette phrase » et que la
réécrire en SQL en créerait une seconde (`lower()` ne retire pas les accents, `unaccent` n'est ni installé ni
immuable sur cette base). La lecture est bornée deux fois : par la date du plus ancien lien, et par
`MESSAGES_CONVERSIONS = 20 000`, au-delà duquel l'écran dit « au moins N » au lieu d'un total.

**Mesure du 2026-09-07 : 89 messages entrants WhatsApp sur toute la base de production.** Le plafond est donc
à trois ordres de grandeur du besoin, et cette entrée n'est pas urgente.

⚠️ **Cette route ne porte PAS `limiteCouteuse`, et c'est un choix aligné sur le dépôt, pas un oubli** : aucune
route de `/stats` n'en porte non plus, alors qu'elles agrègent davantage. Le plafond général (300/minute par
utilisateur) s'applique. Si le profil de charge change, c'est la première chose à revoir.

**La bonne réparation, le jour venu, et elle préserve la justesse** : préfiltrer en SQL sur le plus long
segment de la phrase qui ne porte NI accent NI espace (« Réserver ma place » -> `place`). Tout corps qui
contient la phrase entière contient forcément ce segment, donc le préfiltre ne peut RIEN perdre, et le
comptage exact reste en JS sur les survivants. Repli quand aucun segment ne qualifie (phrase entièrement
accentuée) : pas de préfiltre, comportement actuel.

## 🟡 `campagne-assistant-recap` : la garde d'empilement est instable EN LOT (mesuré le 2026-09-12)

Le cas « le tableau, le bloc de coût et le bouton sont EMPILÉS » échoue par intermittence, mais
**seulement quand le fichier est lancé avec d'autres specs**, jamais seul.

**Quantifié dans les deux sens avant de conclure**, comme la règle du dépôt l'exige : **4 exécutions
vertes sur la référence** et **4 exécutions vertes avec le changement soupçonné**, en isolé. En lot,
il tombe environ une fois sur deux, sur la référence comme sur le code modifié. Ce n'est donc pas une
régression, et surtout ce n'est pas la faute du dernier qui l'a vu rougir.

⚠️ **Ne PAS l'affaiblir pour le faire taire.** L'assertion qu'il porte est celle qui attrape trois
blocs côte à côte, que ni `pasDeDebordement` ni `pasDeChevauchement` ne voient. C'est la garde la
plus utile de l'écran.

**La piste** : `boundingBox()` est lu sans attendre que la mise en page soit stabilisée. En lot, le
serveur de dev sert plus lentement et la mesure part avant la fin du rendu. La réparation est une
attente sur un état RENDU (les trois blocs visibles ET leur hauteur non nulle) avant de mesurer, pas
un `waitForTimeout`.

## 🟡 Cocher « heures ouvrées » sur un espace SANS jour ouvert condamne la campagne (relevé au lot 7, 2026-09-12)

**Le comportement est documenté et voulu**, pas accidentel : sans aucun jour ouvert,
`prochaineOuverture` rend `null`, la campagne se met en pause `hors_horaires` **sans échéance**, et
`reprendreCampagnesDues` exige `paused_until is not null`. Elle ne repart donc jamais toute seule.
⚠️ Ce n'est PAS silencieux : `messageDePause` l'explique à l'opérateur, avec la même sémantique
qu'une pause de qualité.

⚠️ **LA MOITIÉ « ÉCRAN » DE CE POINT EST CLOSE DEPUIS LE 2026-09-13.** Elle disait que le manque
était dans l'ancien formulaire, qui laissait cocher la case sans prévenir : cet écran a été RETIRÉ, et
l'assistant, seul chemin de création désormais, avertit au moment du clic (« aucune heure d'ouverture
n'est réglée »). C'est la bonne place : au moment de la décision, pas au moment de la panne.

⚠️ **MESURÉ LE 2026-09-12 : l'espace « Demo » a ZÉRO jour ouvert.** C'est celui sur lequel les essais
se font. Le piège est donc armé là où on teste, et zéro campagne y est bloquée aujourd'hui.

**Il ne reste donc qu'UNE question, et elle demande une décision** : un espace sans aucun jour ouvert
doit-il être traité comme « toujours ouvert » pour l'envoi initial ? Cela alignerait le comportement
sur celui du rattrapage (`fenetreDeRattrapageOuverte` rend déjà `true` dans ce cas). C'est plus
cohérent, mais cela change un comportement d'ENVOI : ça ne se fait pas sans décision explicite.

## 🟡 Le choix de l'EXPÉDITEUR a disparu avec l'ancien formulaire (relevé au lot 8, 2026-09-13)

L'assistant pose `phoneNumberId` sans le faire choisir. `CampaignCreateForm`, lui, le proposait quand
l'espace en avait plusieurs.

⚠️ **MESURÉ : régression LATENTE, pas vivante.** Les deux espaces de production ont **un seul numéro
chacun** au 2026-09-13, donc personne ne peut constater la perte aujourd'hui. Elle mordra au premier
client à deux numéros, et ce jour-là elle se manifestera par « mes campagnes partent du mauvais
numéro », pas par une erreur.

**À reposer dans l'assistant** : un sélecteur à l'étape Canal, visible seulement quand l'espace a plus
d'un numéro. Le montrer à un espace mono-numéro serait une question dont la réponse est déjà connue.

## 🔴 DEUX FOIS LE MÊME MOTIF : l'écran affiche ce que la requête n'envoie pas (2026-09-13)

Deux défauts trouvés à deux lots d'intervalle, de la même famille, dans le même assistant :

- **lot 7** : `entreeDeCreation` posait `contactTarget: { filters }` **quoi qu'on ait coché**. Une
  sélection ligne à ligne était affichée, comptée, et la campagne partait à tout ce que les filtres
  décrivaient, donc à plus de monde que ce que l'opérateur avait validé ;
- **lot 8** : le constructeur de message RCS était un littéral `kind: 'text'`. L'écran affichait le
  visuel, le téléversait, le montrait en aperçu, et n'en envoyait rien.

🔴 **LA CAUSE COMMUNE EST LA MÉTHODE DE CONSTRUCTION, PAS L'INATTENTION.** Un écran bâti écran d'abord
a deux moitiés qui avancent à des vitesses différentes : ce qu'il MONTRE et ce qu'il ENVOIE. Les tests
d'interface ne voient que la première, et ils sont verts pendant que la seconde ment.

⚠️ **LA PARADE, ET ELLE EST BON MARCHÉ** : pour tout écran qui construit une requête, au moins un test
lit le **CORPS DE LA REQUÊTE**, pas le rendu. C'est le seul qui prouve quelque chose. À appliquer à
l'assistant de traduction et au récap avant qu'ils ne reproduisent le motif une troisième fois.

## Une campagne en pause ne dit NI pourquoi NI jusqu'à quand (2026-09-13)

Trouvé en diagnostiquant le « le truc reste en pause » de Julien, un dimanche. La campagne était
parfaitement saine : `business_hours_only` coché, l'espace fermé le dimanche, donc
`pause_reason = 'hors_horaires'` et `paused_until` au lundi 9 h. Le moteur avait raison de bout en
bout, et **l'écran n'en montrait rien** : la liste affiche « en pause », point.

🔴 **LES DEUX COLONNES EXISTENT DEPUIS 0103 ET 0122, ET L'API NE LES EXPOSE PAS** (`pause_reason`,
`paused_until` absentes de `CampaignSummary`). `messageDePause` sait déjà fabriquer la phrase
(`src/campaign/pause.ts`), personne ne l'affiche dans la liste. C'est encore le même motif que
celui du bloc au-dessus, dans l'autre sens : le serveur SAIT, l'écran ne le dit pas.

⚠️ **ET LE PIÈGE QUI SUIT** : changer ses heures d'ouverture ne réveille PAS une campagne déjà en
pause, `paused_until` ayant été calculé au moment de la pause. Le geste existe (le bouton
« Reprendre » de la liste, que Julien a trouvé seul), mais rien ne l'indique à qui vient de corriger
ses horaires en croyant avoir résolu le problème.

À faire : exposer les deux colonnes dans le résumé, afficher la phrase et l'échéance sous le badge
« en pause », et nommer le bouton « Reprendre » comme le geste qui rattrape un horaire corrigé.

## Un test qui désigne par le TEXTE ne nomme aucun symbole (2026-09-13)

Trouvé par la CI, pas par la revue, et c'est bien le problème. En retirant la question « Ne pas envoyer
le rattrapage en dehors des heures d'ouverture », la revue a cherché ses lecteurs par `grep` sur le
champ (`rattrapageHorsHoraires`), sur le `data-testid` (`bloc-rattrapage`) et sur la fonction
(`rattrapagePossible`). Zéro reste. **Deux e2e la gardaient pourtant**, en la désignant par son
libellé : `getByRole('checkbox', { name: /heures d.ouverture/i })`.

🔴 **ET LE PIÈGE EST PLUS FIN QUE « J'AI OUBLIÉ UN GREP »** : ce libellé ressemblait à celui de la case
qui RESTE (« Envoyer uniquement pendant les heures **ouvrées** »). En lisant le test, on croit qu'il
parle de la survivante. Il fallait comparer les deux libellés au caractère près pour voir que
`/heures d.ouverture/i` ne correspond qu'à la disparue.

⚠️ **LA PARADE** : quand on retire un élément d'interface, chercher aussi son **LIBELLÉ** dans les
tests, pas seulement son identifiant. Et si un cas réécrit se met à ressembler à un cas déjà présent,
c'est qu'il faut le SUPPRIMER en nommant son remplaçant, pas le réécrire : les deux exemplaires ont été
retirés une fois constatée cette duplication.

## L'espace ne sait pas distinguer « horaires réglés » de « jamais réglés » (2026-09-13)

`tenant_settings.business_hours` valait `null` pour l'espace Demo, et l'API rend
`DEFAULT_BUSINESS_HOURS` (lundi-vendredi 9 h-18 h) à la place. Conséquences mesurées :

- l'espace se voit appliquer des heures d'ouverture **qu'il n'a jamais choisies**, et une campagne
  « heures ouvrées » lancée un dimanche attend le lundi ;
- l'avertissement « aucune heure d'ouverture n'est réglée pour cet espace » de l'étape Canal ne peut
  donc **JAMAIS s'afficher** : `heuresDOuvertureReglees` reçoit le défaut et répond « oui ».

Le code de cet écran est juste, sa garde est inerte. Pour la rendre vivante il faut que l'API dise si
la colonne est nulle (un drapeau à côté des heures), sans quoi le front ne peut pas faire la différence.

## Une bulle SORTANTE change de contenu selon un réglage sur les messages REÇUS (2026-09-13)

Signalé par le lot de la tâche 6, confirmé en revue. L'interrupteur s'appelle « Traduire les messages
reçus », et pourtant il change aussi ce qu'affichent les bulles **envoyées** :

- **éteint** : la bulle montre `body`, c'est-à-dire **ce qui est PARTI** (donc le texte traduit, si
  l'opérateur avait utilisé le bouton de traduction sortante) ;
- **allumé** : elle montre `redaction_origine`, c'est-à-dire **ce que l'opérateur avait écrit**.

🔴 **LES DEUX SONT DÉFENDABLES, MAIS PAS SOUS LE MÊME INTERRUPTEUR, ET SURTOUT PAS EN SILENCE.** Rien
à l'écran ne dit laquelle des deux versions on regarde. Un opérateur qui cherche à savoir ce que son
client a réellement reçu peut lire l'autre texte sans s'en apercevoir, et c'est précisément la question
qui se pose le jour d'un litige.

✅ **TRANCHÉ PAR JULIEN LE 2026-09-13 : une bulle sortante montre TOUJOURS ce qui est PARTI**, quel que
soit le réglage de traduction, avec un moyen de déplier ce que l'opérateur avait écrit. C'est la vérité
de l'échange, celle qui compte le jour d'un litige, et elle cesse de dépendre d'un interrupteur qui ne
parle que des messages REÇUS.

⚠️ **CE N'EST PAS QU'UN CHANGEMENT D'AFFICHAGE** : `texteOriginal` (`src/traduction/fil.ts`) rend
aujourd'hui `redactionOrigine ?? body` pour un sortant. C'est CETTE ligne qui s'inverse, et le test qui
la garde doit exercer les deux sens, réglage allumé comme éteint.

## Le bouton « Envoyer » est recouvert par la bulle d'aide en 13 pouces (2026-09-13)

Mesuré pendant la tâche 6, et **ce n'est pas une régression de ce lot** : la bulle flottante du bot
d'aide se pose au-dessus du coin bas-droit, donc par-dessus la droite du bouton « Envoyer » de l'Inbox
à 1280 x 800.

⚠️ **AUCUNE DES DEUX GARDES DE LARGEUR NE PEUT LE VOIR** : `pasDeDebordement` regarde le débordement du
document, `pasDeChevauchement` compare des éléments qu'on lui NOMME, et personne n'a jamais pensé à
nommer la bulle d'aide en face du bouton d'envoi. C'est le trou de la méthode plus que celui de
l'écran : une garde qui exige qu'on nomme les paires ne trouve que ce à quoi on pensait déjà.

✅ **TRANCHÉ PAR JULIEN LE 2026-09-13 : LA BULLE SE DÉCALE SUR L'INBOX.** Le bot d'aide remonte ou se
décale quand une conversation est ouverte, là où il gêne ; les autres écrans ne bougent pas. On corrige
la cause sans toucher à la zone de saisie, qui est l'élément le plus utilisé du produit et dont la
largeur ne doit pas payer pour un problème qui n'existe que sur un écran.

⚠️ **ET ON AJOUTE LA PAIRE À LA GARDE**, sinon on corrige le symptôme sans empêcher son retour :
`pasDeChevauchement(page, ['bouton-envoyer', 'bulle-aide'])` en 1280 x 800.

---

# Demandes de Julien du 2026-09-13 (après l'essai réel de la traduction)

## 🔴 BUG — « Modèle et scénario » demande DEUX choix au lieu d'un

**Constaté par Julien, vérifié dans le code.** Dans l'étape Contenu d'une campagne, choisir la formule
« Modèle et scénario » laisse le sélecteur **Modèle** affiché (il est rendu inconditionnellement dans
`CadreWhatsApp`, `web/components/campagne/EtapeContenu.tsx`) EN PLUS du sélecteur de scénario.

Julien : « le user ne doit pas choisir un modèle puis un scénario, il doit choisir uniquement un
scénario, et un scénario qui commence par un Template. On avait déjà répondu à ce bug depuis
longtemps. » C'est donc une RÉGRESSION : l'assistant a réintroduit ce que l'ancien formulaire avait réglé.

🔴 **CE N'EST PAS QU'UNE QUESTION DE TROP, C'EST UNE SOURCE DE CONTRADICTION.** Le modèle qui part
réellement est celui du PREMIER BLOC du scénario ; celui que l'écran fait choisir à côté ne sert qu'à
compter des variables. Les deux peuvent différer, et alors l'association des variables est faite sur le
mauvais modèle, ce qui fait refuser la campagne entière par Meta (`resolveHintParams`).

⚠️ **LA BRIQUE POUR LE CORRIGER EXISTE DÉJÀ** : `scanOpening(graph)` (`web/lib/campaign-eligibility.ts`)
rend `firstTemplate` (avec son `templateName`) et `rcsOpen`. Le modèle d'ouverture se DÉDUIT donc du
scénario choisi, au lieu d'être demandé. Corollaire à ne pas oublier : c'est ce même scan qui doit
refuser un scénario dont le premier bloc ne convient pas au canal de l'étage.

## ÉVOL — « Créer un scénario » depuis la campagne, sans la quitter

Dans la liste des scénarios d'une campagne « Modèle et scénario », le **premier choix**, avant les
scénarios existants, doit être **« Créer un scénario »**. Il ouvre une fenêtre qui occupe environ les
trois quarts de l'écran et reprend l'écran de construction (les blocs qu'on relie).

- **Le nom se demande d'abord** : dans le parcours normal, c'est la première étape avant que l'écran de
  construction apparaisse. En arrivant directement sur le graphe, il faut donc le demander quelque part.
- **« Publier » ferme la fenêtre et revient à la campagne**, avec le scénario choisi.
- 🔴 **Le scénario doit se retrouver dans l'onglet Scénario** : ce n'est pas un objet jetable propre à
  la campagne, c'est un scénario de l'espace comme un autre.
- 🔴 **LA GARDE DU PREMIER BLOC, ET ELLE EST LE CŒUR DE LA DEMANDE.** Sur un étage **WhatsApp**, on ne
  doit pas pouvoir publier un scénario qui ne commence pas par un **Template** ; sur un étage **RCS**,
  il doit commencer par un bloc **RCS**. La même règle vaut pour **les étages de repli** d'une campagne
  à chaîne, qui utilisent eux aussi des scénarios.
- ⚠️ `isCampaignEligible` / `scanOpening` portent déjà la moitié de cette règle (ils savent dire si un
  graphe ouvre par un template nommé ou par un bloc RCS). Ce qui manque, c'est de l'appliquer AU MOMENT
  DE PUBLIER depuis la campagne, et par CANAL d'étage.

## ÉVOL — Un menu « Sécurité », à côté de Paramètres, Support et Developers

🔴 **LIVRÉ LE 2026-09-13, TÂCHES 1 À 6** (`623e6a5`). La page d'accueil, le menu et ses trois sous-menus
(Consentement, Audit trails, Journal des erreurs) existent. Un opt-out bloque désormais scénario, automation
et agent IA, l'envoi d'un modèle marketing depuis l'Inbox et la réponse d'un agent MCP. La liste des
désabonnés porte la date (migration 0138) et les « refus possibles à confirmer » remontent sans désabonner
personne. Le détail et les écarts : [plan](docs/superpowers/plans/2026-09-13-centre-securite.md).

**Ce qui RESTE de ce chantier**, et rien d'autre :

1. **L'opt-out déclenche un APPEL D'OUTIL** (tâche 7) : au moment où un refus est déclaré, l'espace peut
   pousser l'information vers son propre système via un connecteur déjà déclaré dans Tools. C'est ce qui rend
   le refus opposable ailleurs que chez nous. ⚠️ L'appel ne doit JAMAIS bloquer l'écriture de l'opt-out.
2. **Le sous-menu IA** (tâche 8) : remonter « l'IA se déclare comme telle » de la fiche d'agent au niveau de
   l'ESPACE, sans changer le comportement des agents existants. ⚠️ Le Meta Business Agent n'est pas concerné,
   Meta écrit déjà « IA » sous ses messages.
3. **Le journal des erreurs, la moitié SYSTÈME** (tâche 9) : les retours d'API qui n'ont pas fonctionné et les
   échecs d'avancement de parcours (`workflow_advance_failures`, migration 0108, déjà en base). La moitié
   client existe déjà et a déménagé.
4. 🔴 **L'ESSAI RÉEL, qui n'est pas une tâche mais la seule preuve** : écrire « stop » depuis un vrai
   téléphone, constater l'opt-out, PUIS tenter d'atteindre ce contact par un scénario ET par une automation.
   Puis l'essai inverse : un opérateur doit encore pouvoir lui répondre à la main.

🔴 **ET UN ARBITRAGE EN ATTENTE, découvert le 2026-09-13** : la règle STOP désabonne « arrêt maladie »,
« arrêt du traitement », « stop covid » et « stopper la commande », parce que l'ancrage en début de message
ne protège pas d'un message qui COMMENCE par le mot-clé. Sur un espace d'assureur, c'est un message ordinaire.
Resserrer l'ancrage ferait perdre « stop merci », qui est un vrai refus : c'est un choix produit, et le
comportement actuel est figé par `tests/consentement-observation.test.ts` en attendant.

## ÉVOL — Déplacer « Scénario » dans Contenu, juste après Email

Le menu Scénario quitte sa place actuelle pour le menu **Contenu**, immédiatement après Email.

## ÉVOL — Une RÉPONSE est un engagement, au même titre qu'un clic

Performance lab, page d'accueil, « ce que coûte l'engagement ». Constaté par Julien sur l'envoi
« Testjulien2 » : le destinataire d'un message marketing n'a **pas cliqué**, mais il a **répondu**.

🔴 **UNE RÉPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU, et ne pas la compter sous-estime exactement ce que
la page prétend mesurer.** Quelqu'un qui prend la peine d'écrire s'est engagé plus fort que quelqu'un
qui clique. Le coût par engagement doit donc compter les réponses avec les clics.

## Relevés du 2026-09-25 (relectures et essai réel de l'API)

- Écran de choix d'espace à la connexion : afficher un discriminant en plus du nom et du rôle (le code public de
  l'espace). Aucune unicité ne pèse sur `tenants.name`.
- `GET /v1/sends/{id}` : exposer le motif d'une pause. Une cible qui ouvre en RCS avec un repli WhatsApp peut encore
  être acceptée puis rester en pause sans raison lisible par l'API.
- `GET /v1/sends/{id}` pour une cible `scenario` ou `node` : `messageId` et `delivery` valent `null`, l'intégrateur
  ne sait pas si le premier message est livré.
