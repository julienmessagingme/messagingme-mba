# La filière « application WhatsApp Business » : conception

Date : 2026-10-22. Cadrage mené avec Julien en quatre rondes de questions, après un essai réel la veille au soir. Ce
document dit ce qu'il a décidé, ce que j'ai tranché à sa place (marqué **mon choix**), et ce qui reste au
constructeur.

## Intention

Aujourd'hui, brancher WhatsApp sur Messaging Me demande un compte Meta Business (un portefeuille d'entreprise) :
c'est la fenêtre de Meta (Embedded Signup) qui relie le numéro à l'API. Les premiers essais de Julien avec des
développeurs butent là : « est-ce que j'ai un compte business ? je ne sais pas ». Quand on ne le sait pas, on n'en a
généralement pas, et on s'arrête.

Julien veut une seconde porte d'entrée : **relier un compte de l'APPLICATION WhatsApp Business**, sans API et sans
compte Meta Business, et le piloter depuis Claude Code comme le reste. Le développeur essaie tout de suite ; le jour
où il veut la suite (le Pro, les modèles, les campagnes), il passe à l'API.

## Pour qui

Le **développeur qui teste** : il construit son app avec Claude Code, il veut voir WhatsApp marcher dans la session,
et il n'a pas (ou ne sait pas s'il a) de compte Meta Business. Ce n'est pas le commerçant qui gère son
WhatsApp au quotidien, même si rien ne l'empêche d'entrer par là.

## Ce que l'essai du 21 octobre a prouvé

Fait hors du dépôt, dans un dossier jetable (récit : `docs/JOURNAL-TECHNIQUE.md`, 2026-10-21 nuit).

- **Un numéro DIDWW de notre réserve est accepté par l'application WhatsApp Business.** Le code de vérification
  arrive par appel ; le pont des codes l'a capté une fois corrigé pour appuyer sur 5 (déjà en production).
- **Le compte se relie comme un appareil lié, par QR code**, par la bibliothèque Baileys déjà utilisée par wagroups.
  L'appairage par code à huit caractères expire en deux minutes environ et laisse une session que WhatsApp invalide
  (401) : le QR code est le bon geste.
- **Un serveur MCP à deux outils (lire, répondre) a lu une vraie conversation et y a répondu.** Le message est arrivé
  sur le WhatsApp personnel de Julien.
- **Le couplage marche** : le serveur voit aussi les réponses tapées à la main sur le téléphone, et la réponse de
  Claude apparaît sur le téléphone.
- **Limites vues** :
  - les messages reçus pendant que le serveur était déconnecté ne lui sont pas revenus à ses reconnexions brèves
    (quelques secondes à 25 s) ; on ne sait pas encore si WhatsApp les redonne à une connexion qui dure ;
  - WhatsApp désigne le client par un identifiant masqué (`…@lid`), pas par son numéro ;
  - relié par QR code, Baileys renseigne l'identité du compte (`creds.me`) mais pas `creds.registered`.

## Ce que Julien a décidé

| Question | Sa réponse |
|---|---|
| Pour qui | Le développeur qui teste |
| Deux filières | « quand les mecs ont un numéro API, ça change rien » : la filière API reste telle quelle (Free et Pro), la filière application s'ajoute, en Free |
| Le Pro | Toujours sur l'API |
| Quel numéro | Le sien (déjà sur WhatsApp Business) ou un numéro que nous fournissons |
| Sur quel téléphone vit le compte | Celui du développeur (le compte d'un numéro fourni s'y ajoute en second compte) |
| Ce que fait la filière application | L'agent IA qui répond seul, lire et répondre depuis Claude, la bulle sur le site, écrire en premier |
| La garde d'« écrire en premier » | Un plafond de premiers messages par jour |
| Le passage au Pro | En coexistence : le même numéro reste dans l'application et passe aussi sur l'API |
| Prix du numéro fourni | 3,50 € HT par mois, comme aujourd'hui |
| Bannissement | Arrêter et prévenir |
| Dire le risque | Une phrase dans la doc (pas d'accord à cocher) |
| Aiguillage | Claude pose la question au moment de relier le numéro |
| Outils MCP | Les mêmes pour les deux filières |
| Crédit IA offert | Oui, une fois par numéro, comme sur l'API |
| Premier lot | Relier, recevoir, répondre |
| Ouverture | Tout le monde, dès la livraison du premier lot (pas de drapeau par espace) |
| Numéro fourni en fin d'abonnement | On vend la connexion : on retire notre appareil lié et on résilie chez DIDWW, le compte survit sur son téléphone |
| Le Pro avant le lot de la coexistence | Refusé, avec une phrase qui dit que le passage arrive |
| Adresse IP | La même pour toutes les connexions au début ; un proxy par numéro plus tard si les bannissements le demandent |

## Deux filières

- **Filière API** : rien ne change. Free ou Pro, compte Meta Business, Embedded Signup, Cloud API (ou 360dialog).
- **Filière application** : Free seulement. Pas de compte Meta Business. Le numéro vit dans l'application WhatsApp
  Business du développeur ; Messaging Me s'y relie comme appareil lié et tient la connexion.

Un espace est dans l'une ou l'autre, jamais les deux à la fois (**mon choix** : un espace, un numéro, comme
aujourd'hui).

## Le parcours

1. **L'aiguillage.** Quand le développeur demande à relier son numéro, Claude (par `start_whatsapp_connection` et la
   skill de mise en service) demande s'il a un compte Meta Business. Oui : la filière API, telle qu'aujourd'hui.
   Non ou « je ne sais pas » : la filière application, avec le guide « Avez-vous déjà un compte Meta Business ? »
   pour qui veut vérifier (le tutoriel demandé par Julien, captures à fournir par lui).
2. **Le numéro.** Son propre numéro WhatsApp Business (déjà dans son application), ou un numéro fourni, payé
   3,50 € HT par mois comme aujourd'hui. Pour un numéro fourni, il ajoute un compte dans son application WhatsApp
   Business avec ce numéro, choisit la vérification par appel, et le code capté par le pont s'affiche (sur la page
   du lien et dans Claude), comme pour la filière API.
3. **Relier.** **Mon choix** : la page du lien (`/brancher`, ouverte depuis Claude) affiche le QR code de la session
   et se met à jour toute seule ; il le scanne depuis son application (Appareils connectés, Connecter un appareil).
   `watch_whatsapp_connection` dit à Claude quand c'est relié. Pas d'appairage par code à huit caractères (voir
   l'essai).
4. **Ensuite, tout passe par les mêmes outils** que la filière API : `get_setup_state`, l'agent, la bulle, les
   conversations.

## Ce que fait la filière application

**Premier lot (relier, recevoir, répondre)** :

- relier par QR code, connexion tenue en permanence par nos serveurs (sans elle, les messages reçus pendant une
  coupure sont perdus, l'essai l'a montré) ;
- chaque message reçu entre dans les conversations et les contacts de l'espace, comme un message de l'API ;
- les messages tapés sur le téléphone entrent aussi, comme réponses humaines ;
- répondre depuis Claude par les outils existants (`list_conversations`, `get_conversation`, `get_messages`,
  `reply_in_open_window`) ;
- l'agent IA maison répond seul, avec la connaissance de l'espace, sur le crédit IA comme aujourd'hui.

- **la détection du bannissement et ses conséquences** (voir « Bannissement ») : obligatoire dans ce lot, parce que
  la filière s'ouvre à tous dès sa livraison (décision de Julien) ;
- **le refus du Pro** pour un espace de la filière application, tant que la coexistence n'est pas construite ;
- la phrase de la doc et de la FAQ (voir « Ce que dit la doc »).

Le plugin (skill de mise en service, aiguillage) se publie EN DERNIER, après le déploiement de l'API et du service de
connexions qui portent tout ce qui précède : c'est sa publication qui ouvre la filière à tous.

**Ensuite, dans cet ordre (mon choix)** : la bulle sur le site ; écrire en premier, avec son plafond ; la coexistence
pour passer au Pro.

## Ce qui n'existe pas sur l'application

Les modèles approuvés, les campagnes, les Flows, l'agent de Meta (Meta Business Agent), les accusés et statistiques
de Meta, la fenêtre de 24 heures (elle n'existe pas sur l'application). Un outil qui n'a pas de sens sur cette
filière refuse avec une phrase qui le dit et propose le passage à l'API, comme un outil hors offre propose le Pro.

## Règles propres à la filière

- **La fenêtre de 24 heures ne s'applique pas** : sur l'application, répondre est toujours possible.
  `reply_in_open_window` répond, `get_conversation` dit que la fenêtre ne s'applique pas (**mon choix** : un champ
  qui le dit plutôt qu'un `window_open: true` qui mentirait sur la règle).
- **Le STOP reste la loi** : un contact désabonné ne reçoit plus rien, sur cette filière comme sur l'autre
  (`estDesabonne` est déjà requis sur chaque chemin d'envoi).
- **Écrire en premier** a un plafond de premiers messages par jour et par numéro, et un débit lissé. **Mon choix**
  pour les valeurs de départ, à valider avec Julien avant le lot qui l'ouvre : 20 premiers messages par jour, un toutes
  les 30 secondes au plus, réglables par variable d'environnement. Au-delà : un refus clair qui propose l'API.
- **Une réponse tapée sur le téléphone vaut une prise de main humaine** (**mon choix**) : l'agent IA se retire de la
  conversation comme quand un membre répond dans l'Inbox, selon les mêmes réglages de retour.
- **Groupes et statuts ignorés** : seules les conversations individuelles entrent.
- **Médias** (**mon choix**) : au premier lot, un média reçu entre comme un message de son type, sans téléchargement ;
  l'envoi de médias attend un lot suivant.

## Le client masqué

WhatsApp désigne souvent le client par un identifiant masqué (`…@lid`). On peut lui répondre par cet identifiant,
mais on n'a pas toujours son numéro. Les fiches contacts savent déjà distinguer un numéro et un identifiant masqué
de WhatsApp (`classifyWaId`, numéro ou BSUID) : l'identifiant de l'application y entre comme une forme de plus. Une
fiche sans numéro reste utilisable pour lire et répondre ; le constructeur relie l'identifiant au numéro quand
WhatsApp le donne.

## Bannissement

Arrêter et prévenir. La connexion reconnaît un bannissement (Baileys : 403, et 401 « déconnecté » à distinguer d'un
simple retrait de l'appareil par le développeur). À la détection : plus aucun envoi, l'état de l'espace le dit
(`get_setup_state`), le développeur est prévenu (Claude et e-mail), et **la session n'est jamais reliée de nouveau
automatiquement** (relevé de wagroups : un bannissement n'est réversible qu'une fois, un relien automatique le rend
définitif). Un numéro fourni banni est remplacé sur demande ; l'ancien est résilié chez DIDWW et ne se facture plus.

## Fin de l'abonnement d'un numéro fourni

On vend la connexion, pas le numéro (décision de Julien). En fin d'abonnement, le chemin existant s'applique (envois
coupés, délai, résiliation chez DIDWW, `src/numero/liberation.pg.ts`) avec une différence : il retire notre appareil
lié au lieu de délier le numéro chez Meta. Le compte de l'application survit sur le téléphone du développeur, sur un
numéro que nous ne payons plus et que DIDWW peut réattribuer ; les textes de fin d'abonnement (Claude, e-mail) le
disent.

## Le Pro, avant la coexistence

Refusé pour un espace de la filière application (`subscribe_pro`, page de paiement), avec une phrase qui dit que le
passage au Pro depuis l'application arrive, et qu'il demandera un compte Meta Business. Le refus tombe le jour où le
lot de la coexistence est construit et prouvé sur un numéro français.

## Les connexions abandonnées (mon choix)

Une connexion sans aucun message, reçu ni envoyé, pendant 30 jours se met en sommeil : notre appareil lié se
déconnecte, l'état de l'espace le dit, le développeur est prévenu (Claude, e-mail). Il la réveille en redemandant à
Claude de relier son numéro (un nouveau QR code si WhatsApp a retiré l'appareil). C'est la seule coupure voulue, et
elle est toujours dite : elle ne contredit pas l'anti-objectif « un message perdu en silence ». La règle se règle
par variable d'environnement.

## Crédit IA offert

Oui, une fois par numéro, avec les bornes existantes (une offre par espace, une par numéro affiché). Le moment :
**mon choix**, quand le compte est relié (l'équivalent du « Meta le dit vérifié » de la filière API). Le risque de
récolte en série par des numéros personnels est accepté par Julien.

## Passage au Pro : la coexistence

Le développeur passe au Pro sur l'API sans quitter son application : le sous-parcours officiel de Meta (Embedded
Signup, `featureType: whatsapp_business_app_onboarding`) relie le même numéro à l'API, et l'application continue de
marcher. Il faut alors un compte Meta Business (la fenêtre de Meta peut le créer). Avant de construire ce lot :

- **vérifier que les numéros français et britanniques y ont droit** (les sources divergent : l'UE et le Royaume-Uni
  étaient exclus jusqu'à mi-2025, un éditeur les dit ouverts depuis novembre 2025 ; la page de Meta ne liste plus
  d'exclusion). Ça se tranche par un vrai essai, avec l'accord de Julien ;
- s'abonner aux webhooks de la coexistence (`history`, `smb_app_state_sync`, `smb_message_echoes`, chez Meta : avec
  l'accord de Julien) ;
- décider ce qui arrive à la connexion par appareil lié une fois l'API branchée (**mon choix** : elle s'arrête, l'API
  prend le relais, l'historique vient de la synchronisation de Meta).

## Où vit la connexion (mon choix)

Un service de connexions qui tient une session par numéro relié, sur le modèle de wagroups : un superviseur qui
démarre et surveille un processus par compte, l'état d'authentification chiffré en base, la reconnexion avec attente
croissante, la détection du bannissement. Le transport de wagroups se **recopie** (règle de Julien : un moteur partagé
entre deux produits se recopie avec la référence du commit source, on n'en extrait un paquet commun qu'au troisième)
depuis `~/wagroups` au commit `526d3cc` : `src/transport/baileys/transport.ts`, `authState.ts`,
`src/transport/connectionState.ts`, `src/supervisor/workerPool.ts`, `src/worker/`.

Il tourne à côté de l'API et du worker, sur le VPS puis sur Scaleway, et il est le seul à parler à WhatsApp pour cette
filière. L'API et le worker lui demandent d'envoyer ; il leur remet chaque message reçu par la même ingestion que
l'API. Toutes les connexions sortent par la même adresse IP au début (décision de Julien) ; le transport de wagroups
sait déjà poser un proxy par compte, qu'on activera si les bannissements le demandent.

## Comment la filière se branche dans le code (relevé du 2026-10-22)

- **Réception** : la fonction d'ingestion commune `processInbound` (`src/webhooks/inbound.ts`) fait déjà la fiche
  contact, le STOP, l'écriture (`recordInbound`, déjà paramétré par canal), le détenteur du fil et la remise à l'agent.
  Le service de connexions y verse ses messages ; le canal RCS (`src/rcs/message-entrant.ts`) est le précédent d'un
  canal qui n'est pas Meta.
- **Envoi** : les trois portes de réponse (MCP, Inbox, `/v1`) passent par `repondreDansLaFenetre`
  (`src/inbox/repondre.ts`) et la fonction injectée `sendReply` ; l'agent IA envoie par `envoyerTexteAgent`
  (`src/workflow/wiring.ts`) et `clientWhatsApp`. Le fournisseur se résout aujourd'hui par `resolvePourEnvoi` (type
  `Fournisseur = 'meta' | '360dialog'`, colonne `waba_credentials.fournisseur`), et `MetaClient` choisit son hôte selon
  lui : il n'y a pas d'interface d'envoyeur. Le constructeur choisit entre un troisième fournisseur derrière ces
  points et une interface d'envoi propre ; dans les deux cas, chaque envoi garde ses gardes (STOP, numéro bloqué,
  détenteur du fil).
- **Connexion** : `start_whatsapp_connection` et `watch_whatsapp_connection` (`src/mcp/outils-numero.ts`), la page
  `/brancher` (`web/app/brancher/page.tsx`, `ParcoursNumero`), l'état lu par `lireEtatConnexion`
  (`src/otp/etat-connexion.ts`) et `lireMiseEnService` (`src/mcp/mise-en-service.ts`).
- **Bulle** : `lienDuWidget` construit un lien `wa.me` sur `phone_numbers.display_phone_number` : il vaut aussi pour
  un numéro de l'application.
- **Crédit offert** : `offrirAuNumeroVerifie` (`src/agent/credits.pg.ts`) et ses trois bornes.
- 🔴 **Un invariant à ne pas casser** : `phone_numbers.id` est le `phone_number_id` de Meta et beaucoup de chemins le
  lisent comme tel ; `waba_credentials` suppose un compte WhatsApp Business de l'API. Fabriquer un faux identifiant
  Meta pour un numéro de l'application exige d'avoir relu chacun de ces lecteurs ; une table à part pour les comptes
  de l'application est l'autre voie. Le constructeur tranche, en le disant dans le plan.

## Non-objectifs

- Toucher à la filière API.
- Les groupes WhatsApp (c'est wagroups).
- Une console pour la filière application : la Free n'a pas de console, tout passe par Claude et l'API.
- Plusieurs numéros par espace.

## Anti-objectifs (ce qui ferait échouer le projet même s'il marche)

- **Un développeur qui perd son numéro principal sans l'avoir su.** D'où la phrase dans la doc, et le numéro fourni
  proposé en premier par Claude (**mon choix** : Claude recommande le numéro fourni pour un essai, sans l'imposer).
- **Un relien automatique après un bannissement**, qui le rendrait définitif.
- **Un envoi qui contourne une garde de la filière API** (STOP, numéro bloqué, détenteur du fil) parce qu'il passe
  par un autre chemin.
- **Un message perdu en silence** parce que la connexion était tombée : une coupure se voit et se dit.
- **La filière API dégradée** par la nouvelle : mêmes tests, mêmes résultats.

## Ce que dit la doc

Une phrase, dans la doc développeurs et la FAQ du plugin (`scripts/plugin/faq.ts`), là où la filière est présentée :
la filière application passe par WhatsApp comme un appareil lié, ce n'est pas l'API officielle, et WhatsApp peut
couper un numéro. Les pages qui disent « l'API officielle de WhatsApp » (FAQ `api-officielle`, vitrine) se relisent
pour rester vraies des deux filières.

⚠️ Pour mémoire, sans revenir sur la décision : le relevé de wagroups (cerveau, 2026-09-10) dit que le risque
dominant d'un tel produit est contractuel et s'écrit dans les conditions d'utilisation avant le premier client payant.

## Ce qui est laissé au constructeur

- Le découpage exact des lots après le premier, et leur ordre interne.
- La forme du service de connexions (conteneur, nombre de processus, communication avec l'API et le worker).
- Le choix entre un troisième fournisseur et une interface d'envoi, et la table des comptes de l'application.
- Le texte exact des phrases (refus, doc, FAQ), dans le ton du produit.
- La manière de relier l'identifiant masqué au numéro quand WhatsApp le donne.

## L'essai réel qui clôt le premier lot

Il se fait AVANT la publication du plugin, puisque c'est elle qui ouvre la filière à tous : avec la version locale du
plugin (`claude --plugin-dir`), sur la production déployée.

Sur un espace neuf, depuis Claude Code et le plugin : demander à relier son numéro, répondre « je ne sais pas » au
compte Meta Business, prendre un numéro fourni, l'ajouter dans l'application WhatsApp Business d'un téléphone, scanner
le QR code. Puis, depuis un autre téléphone, écrire au numéro : l'agent IA répond seul. Demander à Claude qui a écrit
et répondre par lui ; répondre aussi à la main sur le téléphone, et voir l'agent se retirer. Couper le service de
connexions une minute pendant qu'un message arrive : soit il est dans la conversation après la reprise, soit la
coupure est visible (état de l'espace, prévenue) ; l'essai du 21 octobre n'a pas établi lequel des deux WhatsApp
permet, c'est cet essai qui le mesure.
