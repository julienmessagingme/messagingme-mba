# L'agent IA : document produit

Public : un chef de produit. Aucun détail technique, aucun code. Ce document décrit ce que le
client voit, comment il construit son agent, ce que l'agent sait faire, ce qui se passe quand ça
tourne mal, et ce qu'il paie. La version technique (schéma, moteur, sécurité) vit dans
[AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md).

Statut : cadrage validé, développement pas encore livré. Les décisions prises sont marquées
« tranché », celles qui restent ouvertes sont regroupées en fin de document.

---

## En une phrase

La console sait déjà envoyer des campagnes WhatsApp et faire tourner des scénarios. L'agent IA
ajoute la brique qui manquait : un répondeur intelligent que le client construit en parlant, qu'il
place où il veut dans ses parcours, et qui peut à son tour déclencher un scénario scénarisé.

Ce n'est pas &laquo; encore un chatbot &raquo;. Quatre choses le distinguent du marché.

1. **Un bloc dans un scénario, pas un cerveau global.** Le client a déjà un parcours qu'il dessine
   et qu'il voit. Un bloc &laquo; SAV commande &raquo; n'a pas besoin des outils du bloc &laquo; prise
   de rendez-vous &raquo;. On place l'intelligence là où elle sert, pas partout.
2. **L'agent peut déclencher un scénario complet.** Quand il a cerné le besoin, au lieu de répondre,
   il pousse un scénario avec ses images, ses boutons, ses actions. L'agent n'est pas un simple
   répondeur, c'est le cerveau qui décide quand lancer un parcours scénarisé.
3. **Construit en conversation, pas dans des écrans arides.** Le client raconte son métier, l'agent
   propose plusieurs options, le client choisit et corrige. Il ne rédige jamais un &laquo; prompt &raquo;.
4. **Facturé aux jetons réellement consommés, plus 10 %, sur compte prépayé.** Pas de facturation
   &laquo; à la résolution auto-déclarée &raquo;, le grief le plus documenté du marché. Un jeton
   consommé se vérifie, il ne se discute pas.

L'agent IA **complète** le répondeur natif de Meta, il ne le remplace pas. Les deux peuvent vivre sur
le même numéro, et le client choisit qui fait quoi.

---

## Le modèle mental : deux IA, deux moments

C'est la clé pour comprendre tout le reste.

**Deux IA distinctes.**

- **L'agent runtime** : celui que le client déploie, qui parle à ses clients finaux à l'échelle. Un
  seul agent, un seul modèle de langage à la fois, du tool calling ou pas selon le cas.
- **L'IA de construction** : notre copilote de setup. Elle tourne rarement (à la création, puis pour
  optimiser), elle est sophistiquée, et c'est elle qui aide à bâtir l'agent runtime en conversation.

**Deux moments.**

- **Temps 1, le démarrage à froid** : le client n'a pas forcément d'historique. On construit par ce
  qu'il sait dire et par des choix concrets.
- **Temps 2, avec du recul** : l'agent tourne depuis un moment, il y a de vraies conversations. Le
  client revient sur son écran de setup et demande une analyse. C'est là, et seulement là, qu'on
  exploite l'historique.

Ne pas confondre les deux moments est important : miner l'historique au démarrage n'aurait aucun
sens quand il n'y a pas encore d'historique.

---

## Ce que le client voit

### Un groupe &laquo; AI Agent &raquo; dans le menu

La barre latérale gagne un groupe qui rassemble les deux répondeurs intelligents, le nôtre et celui
de Meta. Deux réponses au même besoin, le client arbitre.

| Groupe | Entrées |
|---|---|
| AI Agent | MBA, guide &nbsp;&middot;&nbsp; MBA, paramètres &nbsp;&middot;&nbsp; **Other AI agent** |

L'entrée &laquo; Other AI agent &raquo; est l'écran où l'agent se construit en parlant.

### Visible sur l'accueil, comme le répondeur Meta

Quand un agent IA est configuré, le client le voit sur son accueil, avec le même interrupteur
réservé aux administrateurs. Le mot &laquo; activé &raquo; ne veut pas dire la même chose pour les
deux : le répondeur **Meta** activé veut dire &laquo; il répond à tout &raquo;, l'agent **IA** activé
veut dire &laquo; il est prêt à servir dans les scénarios &raquo;.

### Brancher vos outils : Tools &gt; brancher un outil

Un espace où le client (aidé, ou avec nous) connecte les systèmes que l'agent pourra interroger,
**avant** de construire l'agent. Deux sous-menus :

- **MCP** : on connecte le service une fois, ses outils se décrivent tout seuls. C'est le chemin le
  plus simple, et c'est pour ça qu'il est central.
- **API** : on branche un point d'accès précis (un peu plus de réglage par point).

C'est ici que l'IA de construction sait dans quoi l'agent pourra taper. Elle ne propose jamais une
source qui n'est pas réellement branchée.

### Les fiches de connaissance, lisibles et éditables

Quand on lit le site d'un client pour en faire une base de connaissance, le résultat n'est pas une
boîte noire : le client voit **les fiches** produites, une par une, et les corrige. Une mauvaise
réponse de l'agent se répare en éditant une fiche, en trente secondes.

### Le bloc &laquo; agent &raquo; dans le constructeur de scénario

Dans l'éditeur de parcours, un bloc &laquo; agent &raquo; apparaît. Grisé tant qu'aucun agent n'est
configuré, avec une explication au survol, comme les blocs RCS et email aujourd'hui.

### Deux façons de régler l'agent : en parlant, ou dans un écran

Un seul agent, deux entrées sur la même configuration. **En parlant** (la construction
conversationnelle) pour le créer et pour revenir l'améliorer. Et **dans un écran de réglage
classique**, à onglets, calqué sur celui du répondeur Meta d'aujourd'hui, où l'on retrouve **dans les
bonnes cases** tout ce que la conversation a réglé : identité et ton, objectif et transferts, base de
connaissance, outils, garde-fous, modèle, test.

Les deux sont **toujours accessibles** et **synchronisés** : ce que le chat a produit apparaît dans
les cases, ce qu'on change dans les cases est repris par le chat. Le but : comprendre ce qui a été
réglé et corriger un détail **sans avoir à réinterroger l'IA à chaque fois**.

---

## Construire son agent en parlant (temps 1)

Le principe : l'agent part de ce que le client sait dire, et déduit le reste. Il pose peu de
questions et **propose beaucoup**, à la manière d'un assistant de code : à chaque étape il pose une
question et propose plusieurs options, **chacune techniquement applicable** (une option ne peut
pointer que vers ce qui est réellement branché). Le client choisit, corrige, ou fait réessayer.
Jamais d'écriture silencieuse : chaque proposition passe par un aperçu.

L'ordre compte, parce qu'il va du sens vers le détail.

1. **L'objectif de l'agent.** La première question, et la plus importante. &laquo; À quoi sert votre
   agent, au-delà de répondre ? &raquo; Si le client dit &laquo; répondre aux questions &raquo;, on
   creuse : Gan Prévoyance oriente vers la prise de rendez-vous avec un conseiller ; Odalys est un bot
   commercial qui propose des résidences ; Hyundai cerne le besoin puis oriente vers un test drive.
   L'objectif est la colonne vertébrale : il décide quand transférer, quel scénario lancer, ce que
   &laquo; réussi &raquo; veut dire. On en profite pour poser son **identité** : un nom éventuel,
   comment il se présente, s'il tutoie ou vouvoie, plutôt direct ou chaleureux. Ça reste borné (un
   nom, un registre, quelques traits), pas un éditeur de persona libre.
2. **Les règles de transfert. C'est là que ça démarre concrètement.** Trois questions oui-non :
   voulez-vous que l'agent transfère certaines conversations ? Quand le client demande à parler à
   quelqu'un, on transfère à un conseiller ? Quand le client s'énerve et reste insatisfait après
   quelques réponses (détection du mécontentement en temps réel, un mécanisme qui tourne déjà), on
   transfère à un humain ? Ces trois réponses ne demandent aucun historique.
3. **Les sources d'information, sans dire le mot outil.** &laquo; Quand un client vous pose cette
   question, vous regardez où ? &raquo; Deux cas. Soit l'info vient d'un **outil déjà branché** (le
   client dit &laquo; je vais voir dans Shopify si c'est livré &raquo;, et Shopify doit avoir été
   connecté dans Tools au préalable). Soit elle vient de **sources simples** : documents, site. Sur le
   site, on cadre le cœur avec le client (Hyundai = tout ce qui touche aux véhicules ; Odalys = les
   descriptions de résidences), jamais &laquo; tout le site &raquo; par défaut.
4. **À quoi servent ces sources.** Une fois les sources posées, on les relie à l'objectif. Le site
   Odalys ne sert pas &laquo; à répondre &raquo;, il sert à proposer des résidences. Si l'objectif
   reste flou, on met toutes les ressources à disposition pour répondre, mais on aura essayé de le
   préciser.
5. **Les scénarios que l'agent déclenche.** &laquo; Dans quel cas, au lieu de répondre, l'agent
   doit-il lancer un parcours ? &raquo; Exemple Hyundai : quand le besoin est cerné, l'agent pousse le
   scénario de prise de rendez-vous, avec ses images, ses boutons, ses actions. La réponse tirée des
   sources peut être stockée et injectée dans le scénario. C'est ce qui fait de l'agent un chef
   d'orchestre, pas un répondeur.
6. **La fin.** &laquo; Quand est-ce que c'est bien terminé ? &raquo; et &laquo; À quel moment ça doit
   s'arrêter et vous revenir ? &raquo; Le client sait dire ce qu'il attend à la fin, pas décrire un
   enchaînement.
7. **Les cas limites.** Cinq situations concrètes par secteur (&laquo; je veux me faire rembourser
   &raquo;, &laquo; si je n'ai pas de réponse je saisis un avocat &raquo;, &laquo; vous me faites 20 %
   ? &raquo;), trois boutons chacune : l'agent répond, il refuse et vous passe la main, il pose une
   question avant. Chaque clic écrit une règle, le client ne rédige rien. En temps 1 ces cas sont
   proposés par nous ; en temps 2 ils viennent des vraies conversations.
8. **Le périmètre par ses bords, en cases pré-cochées.** Cinq garde-fous selon le secteur, que le
   client décoche : ne jamais négocier un prix, jamais s'engager sur un délai ferme, jamais confirmer
   un remboursement, jamais donner un avis médical ou juridique, jamais inventer.
9. **Relire et montrer.** &laquo; Voilà ce que j'ai compris. Dites-moi ce qui est faux. &raquo; Puis
   on rejoue des cas de test générés à partir de la fiche (en temps 2, de vraies conversations). On
   dit &laquo; ce que j'ai compris &raquo;, pas &laquo; votre agent est prêt &raquo;.
10. **La recommandation de modèle**, à la fin, une fois le tour des besoins fait (voir plus bas).

**Le seul blocage dur** : on ne peut ni tester ni publier tant que la fiche n'a pas un objectif, une
règle de transfert, une source de connaissance et une règle d'arrêt. On bloque sur des cases vides,
jamais sur une question de qualité, qui serait un mur arbitraire.

### La porte custom, quand un seul agent ne suffit pas

L'IA de construction sait détecter quand le besoin dépasse un agent unique (une vraie chaîne d'agents
spécialisés qui se passent le relais). Dans ce cas elle le dit franchement : soit vous restez en
mono-agent en self-service, soit votre besoin est trop complexe et passe à l'équipe MessagingMe pour
du sur-mesure. C'est ce qui protège la promesse &laquo; vous le construisez vous-même &raquo;.

---

## Ce que l'agent sait faire

### Répondre avec la connaissance du client

Deux façons d'alimenter l'agent, présentées en deux phrases, pas en choix technique.

> **On lit votre site une fois et on en fait des fiches.** Vous les voyez, vous les corrigez, et
> l'agent répond avec. Plus rapide, moins cher. En échange, quand votre site change, il faut relire.

> **Ou l'agent va chercher sur votre site à chaque question.** Toujours à jour, mais plus lent, plus
> cher, et vous ne pouvez pas corriger une mauvaise réponse : elle vient de ce qu'il a lu.

On recommande la première, parce qu'elle est corrigible (les fiches lisibles ci-dessus) et moins
chère. La date de dernière lecture est visible par source, avec une alerte quand une source n'a pas
été rafraîchie : la première cause de mauvaises réponses n'est pas le modèle, c'est le contenu
périmé.

### Agir, grâce à quatre familles d'outils

Le client ne choisit jamais entre &laquo; HTTP &raquo; et &laquo; MCP &raquo;. Il dit ce qu'il veut,
l'IA choisit la famille.

| Le client dit | Ce qu'on lui propose |
|---|---|
| &laquo; qu'il envoie la fiche produit, la photo, le formulaire &raquo; | déclencher un bloc de votre scénario |
| &laquo; qu'il lance le parcours de prise de rendez-vous &raquo; | déclencher un scénario complet, avec ses images et ses boutons |
| &laquo; qu'il aille voir où en est la commande &raquo; | un connecteur vers votre système (API ou MCP, déjà branché dans Tools) |
| &laquo; qu'il tague, remplisse une fiche, passe la main &raquo; | inclus d'office |

Les deux premières lignes n'existent nulle part ailleurs : l'agent peut déclencher un bloc ou un
scénario entier que le client a déjà dessiné et testé. Rien à configurer, rien à sécuriser.

### S'arrêter au bon moment

L'agent tient la conversation sur plusieurs tours, jusqu'à une sortie prévue (la demande est traitée,
ou le client réclame un humain) ou une inactivité (le client ne répond plus). Dans les deux cas, la
main revient au scénario.

### Savoir qu'il ne sait pas

C'est le point que tout le monde rate : la tentation d'un modèle, c'est toujours de trouver une
réponse. On ne lui fait pas confiance pour juger sa propre ignorance, **on le rend incapable de
répondre hors de ses sources** :

- Sur une question factuelle, il ne répond que depuis une source récupérée. Pas de source qui
  correspond, pas de réponse inventée : il bascule sur le repli (renvoi vers vos coordonnées ou
  transfert).
- On lui fait citer la fiche utilisée. Si la citation ne correspond à rien de réel, on considère
  qu'il ne sait pas.
- Si la réponse dépend d'un outil et que l'outil ne répond pas, message de repli, jamais une réponse
  au doigt mouillé.
- Filet : dès qu'il détecte du mécontentement ou une demande d'humain, il transfère.

---

## Revenir l'améliorer (temps 2)

C'est la moitié de la promesse, et ce que le démarrage à froid ne peut pas faire. Une fois l'agent en
service, le client revient sur son écran de setup et demande une analyse. L'IA de construction a accès
à ce qui existe déjà : les conversations, le journal des outils appelés, le signal de mécontentement
temps réel, et quelle fiche a servi à chaque réponse. Elle en tire des conseils **techniquement
réalistes** :

- &laquo; Ces 12 questions reviennent et aucune source n'y répond, il manque ça dans votre base. &raquo;
- &laquo; Ce connecteur revient souvent en erreur, ou suivi d'un mécontentement. &raquo;
- &laquo; Sur ce sujet l'agent invente au lieu de transférer. &raquo;

Elle propose des corrections (jamais une réécriture silencieuse) et **rejoue les cas de test avant
d'appliquer**, pour montrer ce qui casse.

---

## Quand ça se passe mal

- **L'agent ne sait pas** : voir &laquo; savoir qu'il ne sait pas &raquo;. Repli déterministe, pas
  d'improvisation.
- **Un outil externe est lent ou en panne** : délai maximum par appel, plafond d'appels par tour,
  écran d'état par connecteur, et un message de repli que le client écrit au moment où il ajoute
  l'outil, jamais improvisé.
- **Une action irréversible** &laquo; tranché &raquo; : l'autonomie de l'agent est un réglage du
  client, outil par outil, réservé aux administrateurs. Par défaut, une action sensible passe par la
  validation humaine. Chaque action est journalisée. Cocher la case déplace la responsabilité vers le
  client qui l'a cochée.
- **Un humain reprend la conversation** : permis et normal. On ne peut pas empêcher un humain de
  reprendre, ni empêcher l'agent de décider un transfert.
- **Le compte prépayé tombe à zéro** : c'est entièrement dans notre main, de façon déterministe.
  L'agent sort proprement avec le message de repli du client, une alerte part à l'administrateur, et un
  tout petit découvert est toléré sur la seule conversation en cours. Une conversation coupée net coûte
  plus cher en réputation qu'en jetons.

---

## Le modèle et le prix

**Le nom du modèle est caché par défaut.** Le client voit un profil recommandé et un ordre de grandeur
en conversations, pas un nom technique ni un prix au million de mots. Celui qui veut voir ou choisir
peut.

**On choisit le meilleur rapport qualité/prix, sans fausse pudeur.** Les meilleurs modèles chinois
sont souvent le bon choix, et on les prend. On les sert depuis l'Europe ou les États-Unis via notre
passerelle, jamais depuis la Chine, donc on a le prix et la performance sans envoyer les données de vos
clients en Chine. Un routage vers la Chine ne se ferait que sur accord explicite.

**Une préférence à trois niveaux**, que le client règle selon sa sensibilité :

- **Performance** : le meilleur rapport, servi là où c'est optimal (pour ceux qui s'en moquent).
- **Résidence UE** : la donnée reste en Europe.
- **Souverain** : éditeur européen, Mistral.

Dans le niveau choisi, on dérive le meilleur modèle du besoin réel (le nombre d'outils que l'agent
doit manier).

**Le modèle évolue avec le besoin.** On démarre simple et pas cher (type Gemini Flash) pour de la FAQ
sans outil, et on monte en gamme quand le tool calling s'accumule (le palier haut n'est pas un modèle
occidental hors de prix par principe, mais le meilleur rapport à ce régime). **Changer de palier
implique de rejouer les tests, et on le dit au client** : &laquo; vous avez ajouté des outils, on
recommande de monter d'un cran, ça implique de rejouer vos cas de test. &raquo;

**La facturation, au réel plus 10 %.** Compte prépayé : le client recharge, l'agent consomme, le solde
baisse. On récupère le coût exact de chaque échange (mécanisme vérifié en conditions réelles), on
ajoute 10 %, c'est ce qu'on décompte. Le +10 % est notre marge, écrite dans les conditions, invisible
à l'écran.

---

## Ce qu'on promet, ce qu'on ne promet pas

**On promet :**

- Un agent construit en conversation, avec des choix concrets et applicables, qui produit une
  configuration lisible et corrigible, pas un prompt opaque.
- Le contrôle : chaque proposition est validée avant de s'appliquer, tout s'édite champ par champ dans
  un écran, l'autonomie de chaque outil est un réglage explicite.
- L'agent annonce qu'il est une IA dès son premier message (obligation légale, déjà tenue ailleurs en
  production).
- Un accompagnement dans la durée (le temps 2).

**On ne promet pas :**

- **Bloquer sur la qualité.** On bloque sur des cases vides, jamais parce qu'une formulation semble
  &laquo; pas assez bonne &raquo;.
- **Le monde symétrique.** Le répondeur Meta peut tout attraper, mais ne peut pas être glissé comme un
  bloc de scénario (Meta ne fournit pas ce levier). Un monde sans Meta, où l'agent IA répond à tout,
  reste possible : un scénario à un seul bloc qui attrape tout.
- **Verrouiller les humains.** Empêcher un humain de reprendre, ou l'agent de transférer, n'est pas
  tenable.

---

## Ce qui reste ouvert

- **Les branchements MCP** : par défaut une liste de services validés par nous ; l'ouverture à
  n'importe quel service, sur demande, derrière un réglage par client.
- **La résidence UE par modèle** : promettre &laquo; Résidence UE &raquo; suppose de confirmer, modèle
  par modèle, que la passerelle sait le servir depuis l'Europe. À vérifier avant de le vendre.
- **Le banc** : tout modèle qu'on ajoute au catalogue (Mistral en souverain, un modèle chinois en
  performance) passe d'abord notre test de tool calling. Notre catalogue n'est mesuré nulle part
  ailleurs.

---

## Dans quel ordre ça arrive

Chaque étape est utile seule et livrable seule.

| Étape | Ce que le client y gagne |
|---|---|
| Fondations | Rien de visible, de la plomberie qui débloque le reste. |
| L'agent et sa construction | L'agent avec ses outils maison (déclencher un bloc ou un scénario), et la construction en conversation. La plus grande part de la valeur. |
| Brancher vos outils | Le connecteur API et MCP dans Tools, plus les sources de connaissance. L'agent interroge vos systèmes. |
| L'optimisation (temps 2) | L'analyse des vraies conversations et les suggestions de correction. |
| L'élargissement | Plus de services branchables, la préférence de souveraineté, l'autonomie fine des outils. |

---

## Pour un décideur pressé

L'agent IA est un répondeur intelligent que le client **construit en conversation**, sans jamais
écrire de &laquo; prompt &raquo;. Il le **place où il veut dans ses parcours**, à côté ou à la place du
répondeur Meta, et il peut **déclencher un scénario scénarisé** quand il a cerné le besoin. Il
**s'arrête** proprement quand il ne sait pas, parce qu'on l'a rendu incapable de répondre hors de ses
sources. Il se **facture aux jetons réellement consommés plus 10 %**, sur compte prépayé, sans nom de
modèle ni prix abscons. Et on choisit pour lui **le meilleur rapport qualité/prix**, modèles chinois
compris, servis hors de Chine, avec une option de souveraineté pour ceux qui la demandent.
