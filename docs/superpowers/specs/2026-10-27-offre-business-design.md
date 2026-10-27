# L'offre Business, et le Pro resserré (spec du 2026-10-27)

> Ajoute une quatrième offre entre le Pro et l'Entreprise, et remplace la grille du Pro de
> [la spec offres v2](2026-10-16-offres-v2-design.md), dont le mécanisme reste : l'offre calculée en SQL sur des dates
> (`offre_de_l_espace`), le nom interne `base`, les compteurs, le gel au retour en Free. Source : le tableau
> « Messaging_Me_Tarifs_et_Business_299.xlsm » (colonne D, le Business à 349 € HT), dont les notes du bas datent d'une
> version précédente et ne font pas foi. Cadrée avec Julien le 2026-10-27 en huit séries de questions, puis relue à froid
par un constructeur qui n'avait que ce document (ses deux questions sont tranchées ici). Plan du lot 1 :
> [2026-10-27-offre-business-lot-1.md](../plans/2026-10-27-offre-business-lot-1.md).
>
> Dans ce document, **décision** = tranché par Julien ; **choix de Claude** = un défaut proposé, à relire.

## Ce que veut Julien

Un palier payant pour « les équipes en croissance : collaboration, CRM et pilotage », entre le Pro à 49 € et l'Entreprise
sur devis. Le Pro s'allège (moins de contacts, moins d'historique, ni l'agent de Meta ni les assistants, tout le monde
administrateur) pour donner une vraie raison de monter. Le Business se distingue par l'e-mail aller/retour : la réponse
d'un contact à un e-mail entre dans sa conversation, et l'équipe lui répond par e-mail depuis l'Inbox. L'Entreprise garde
ce qui fait sa différence : l'acquisition (publicités, chaînes), le RCS, le Performance Lab complet, tous les CRM, le SSO.

**Le Business se vend sur démo et Julien le pose dans `/ops`, comme l'Entreprise : aucun objet Stripe.**

## Ce que fait le code aujourd'hui (le delta, relevé le 2026-10-27)

- La grille vit dans `src/offres/offres.ts` (`DROITS`), lue par la vue de l'offre, les refus, les gardes de routes
  (`etapeOffre`) et la console ; la vitrine y est branchée par `tests/vitrine-pages.test.ts`. Trois offres sont énumérées
  à une soixantaine d'endroits (serveur, console, MCP, plugin, centre d'aide, vitrine, tests).
- `offre_de_l_espace` (migration 0218) rend `entreprise` (drapeau posé par `/ops`), sinon `pro` (un abonnement Stripe
  vivant dans `abonnements_offre`), sinon `base`.
- **La purge de l'historique ne lit pas la grille hors Free** : elle applique le réglage de l'espace, sinon le défaut de
  l'instance (`CONVERSATION_RETENTION_DAYS`, 90 jours), `src/inbox/retention.ts`. Les 90 jours du Pro n'ont jamais été lus.
- **Le droit au numéro fourni n'est accordé qu'à un Pro vivant** (`droitAuNumero`, `src/numero/reserve.ts`) ;
  `limites.numeroInclus` n'est lu par aucun code de droit.
- Rôles : `admin`, `manager`, `agent` (CHECK 0065). L'invitation propose toujours les trois ; le Pro limite à 2
  administrateurs. Le rôle est relu en base à chaque requête (`src/auth/middleware.ts`).
- Attribution : à la main, par le bloc de scénario « remettre à un humain » (qui peut viser un membre), et le tourniquet
  des campagnes. Ni tourniquet général, ni équipes, ni règles de routage.
- E-mail : un scénario envoie par la boîte SMTP du client (1 à 3 destinataires), sans trace dans la conversation et sans
  garder l'identifiant du message ; rien n'existe en réception. Le fil d'une conversation porte un canal par message
  (`conversation_messages.channel`, WhatsApp ou RCS), et une conversation n'existe que pour un contact qui a une identité
  WhatsApp.
- Widget : couleur, position, libellé et avatar se règlent dans toutes les offres, Free comprise (par le MCP).
- Analyse des conversations : fonction `analyse`, Entreprise seule, sur NOTRE clé Anthropic (`LLM_API_KEY`), sans
  plafond. Le Performance Lab est une autre fonction (`performance_lab`), qui garde aussi « Mes tableaux ».
- CRM : HubSpot, Salesforce et Batch sous une seule fonction `crm`.
- Crédit offert : 1 € au premier numéro vérifié, une seule valeur pour toutes les offres (`CREDIT_OFFERT_MICRO_EUR`,
  table `credits_offerts`, une ligne par espace).
- La commission sur le crédit IA s'affiche dans la grille de la page Offre de la console et dans la fiche publique
  « Choisir mon offre ».

## La grille

Ce que voit le public (la vitrine, la page Offre de la console, `get_plan`). Case vide = non.

| | Free | Pro | Business | Entreprise |
|---|---|---|---|---|
| Prix HT | gratuit | 49 € par mois ou 490 € par an | 349 € par mois | sur devis |
| Comment on l'obtient | sans rien | Stripe, en ligne | posé par Julien dans `/ops`, facturé hors Stripe | posé par Julien dans `/ops` |
| Essai | | 14 jours, carte demandée | 14 jours sur demande, posé et retiré à la main | |
| Modèles envoyés | 1 000 par mois | sans limite | sans limite | sans limite |
| Automations | | sans limite | sans limite | sans limite |
| Contacts créés | 100, ceux qui écrivent compris | **1 000** (5 000 avant) | 5 000 | réglables |
| Utilisateurs | 1 | 3, puis 15 € HT par mois (siège Stripe) | 5, puis 10 € HT par mois (réglés dans `/ops`) | réglables |
| Rôles | un administrateur | **tous administrateurs** | administrateur, manager, agent | idem |
| Adresses de webhook | 1 | 5 | 10 | sans limite |
| Historique des conversations | 30 jours | **60 jours** (90 avant) | 90 jours | réglable |
| Numéro fourni | 3,50 € HT par mois | inclus | inclus | inclus |
| Crédit IA offert | 1 € | 1 € | 10 € | 1 € |
| Console, Inbox, scénarios et formulaires, statistiques, e-mail envoyé par un scénario, Shopify dans la console | | oui | oui | oui |
| Meta Business Agent, assistants de configuration, assistant d'aide | | **non** (oui avant) | oui | oui |
| Widget | standard | standard | personnalisable | personnalisable |
| Analyse des conversations | | | par conversation (lot 2) | complète |
| Mes tableaux | | | 4, montés par nous (lot 2) | sans limite |
| CRM | | | HubSpot (lot 2) | tous |
| E-mail aller/retour | | | oui (lot 3) | oui |
| Publicités Click-to-WhatsApp, chaînes, RCS, Performance Lab complet, SSO | | | | oui |
| Accompagnement | | autonomie, tutoriels | onboarding de 2 h et 2 h de CSM sur les deux premiers mois, puis 120 € HT de l'heure ; support par e-mail prioritaire, jours ouvrés, sans SLA | interlocuteur dédié |

Les limites invisibles (dans le code, jamais sur une page) :

| | Free | Pro | Business (choix de Claude) | Entreprise |
|---|---|---|---|---|
| Commission sur le crédit IA | 100 % | 20 % | 15 % (décision) | 10 %, réglable |
| Administrateurs | 1 | autant que d'utilisateurs | sans limite | sans limite |
| Suppressions de contacts par jour | 10 | sans limite | sans limite | sans limite |
| Clés d'API | 2 | 10 | 20 | sans limite |
| Appels à l'API et au MCP | 30 par minute, 500 par heure | 60, 1 000 | 120, 3 000 | réglables |
| Modèles et réponses par jour par l'API | 500 et 2 000 | 2 000 et 2 000 | 5 000 et 5 000 | réglables |
| Médiathèque | 0 | 100 Mo | 250 Mo | 500 Mo |
| Journal des webhooks | 3 jours | 30 jours | 30 jours | 30 jours |

## Le Pro resserré (lot 1)

- **1 000 contacts créés, 60 jours d'historique** (décisions). Ses fonctions : `console`, `inbox`, `scenarios`,
  `statistiques`, `email`. Il perd `agent_meta`, `assistants` et `aide` (décision).
- **À la place des assistants et du bot d'aide, le tutoriel** : là où l'écran fermé dit « inclus dans l'offre Business »,
  il propose aussi la fiche d'aide qui fait la même chose pas à pas (choix de Claude). La configuration d'un agent IA reste
  possible à la main : l'assistant n'en est qu'un onglet.
- **Tous administrateurs (décision : « promus d'office », même un membre restreint d'un Business qui redescend).** Choix de
  Claude sur la façon : le rôle EFFECTIF d'un membre actif d'un espace Pro est `admin`, calculé là où le rôle est relu à
  chaque requête ; le rôle enregistré ne bouge pas et reprend effet si l'espace remonte en Business. Conséquences à couvrir
  : l'Inbox (un agent ne voyait que les conversations libres et les siennes), les e-mails du produit (envoyés aux
  administrateurs), l'écran « Compte & équipe » (plus de choix de rôle à l'invitation en Pro, « administrateur » affiché
  pour tous), le gel (plus de limite d'administrateurs à part : celle du Pro vaut sa limite d'utilisateurs).
- **Widget standard** (voir plus bas).
- **Personne ne perd rien** : a priori aucun Pro payant ; une sonde en lecture seule le vérifie avant le déploiement du
  lot 1. Si un espace est en Pro, la purge à 60 jours ne le touche qu'après 30 jours de grâce. Si la sonde trouve un Pro
  (payant ou en essai) ou une bulle déjà personnalisée en Free ou en Pro, le déploiement de la nouvelle grille s'arrête et
  Julien décide (choix de Claude) : sinon un client qui a payé perdrait le jour même l'agent de Meta ou l'apparence de sa
  bulle.

## Le Business

### Comment un espace devient Business (lot 1)

- **Posé et retiré par Julien dans `/ops`**, comme l'Entreprise : même autorité (session d'exploitation nominative avec
  second facteur), note obligatoire, ligne de journal signée de son auteur, cache de l'offre invalidé (décision).
- Réglage : la limite d'utilisateurs (vide = les 5 de la grille ; sinon la limite totale, les utilisateurs en plus étant
  facturés par Julien). Comme pour l'Entreprise, une limite posée dans `/ops` ne bloque que les invitations : personne
  n'est gelé sur un chiffre tapé (choix de Claude, le Business posé à la main est un contrat).
- Ordre : l'Entreprise prime sur le Business, le Business prime sur un Pro payé. Le retrait est daté, comme la sortie de
  l'Entreprise : l'offre d'arrivée (Pro s'il reste un Pro payé, sinon Free) n'applique sa conservation plus courte
  qu'après 30 jours ; ses limites de membres s'appliquent tout de suite (gel par ancienneté, comme aujourd'hui), et en Pro
  les restants passent administrateurs.
- **L'essai** : Julien pose le Business et le retire lui-même au bout de 14 jours (décision). Aucune date de fin
  automatique.
- **Aucun geste Stripe automatique** (décision : aucun objet Stripe). Quand Julien pose le Business sur un espace qui a
  un Pro payé vivant, ou qui paie son numéro à part (3,50 €), `/ops` le dit et rappelle de les résilier quand le Business
  est confirmé (choix de Claude ; même logique que l'essai du Pro, qui n'arrête l'abonnement du numéro qu'à la première
  facture payée).
- **Jamais de Business avant que tout le code le connaisse** : l'ancien code lit une offre inconnue comme la Free, donc
  un Business posé trop tôt serait purgé à 30 jours par d'anciens workers. Aucun Business n'est posé avant que l'API ET les
  workers qui connaissent `business` soient en service (la route de `/ops` qui le pose n'existe d'ailleurs qu'avec eux).

### Le numéro inclus (lot 1)

- Le droit au numéro fourni lit `limites.numeroInclus` de l'offre de l'espace au lieu de « un Pro est vivant » : le
  Business l'obtient, et l'Entreprise aussi, qui ne l'avait pas (choix de Claude ; le tableau dit « numéro fourni inclus »
  pour les trois offres payantes).
- Au passage en Business, ce que fait le passage en Pro sans toucher à Stripe : les avis de suspension du numéro sont
  oubliés et les campagnes en pause `numero_suspendu` repartent.
- À la sortie du Business (ou de l'Entreprise) sans Pro vivant ni abonnement du numéro vivant, le numéro fourni suit le
  chemin d'un impayé, comme à la fin d'un Pro sans carte : envois coupés, 7 jours pour s'abonner au numéro, puis
  libération. `/ops` le dit avant de valider le retrait.
- **La couverture du numéro compte l'offre posée à la main** (relevé par la relecture à froid). Aujourd'hui seul le Pro
  couvre un numéro dont l'abonnement est fini (`couvertureParLePro`, relue par la libération) : sans correctif, un Business
  dont Julien a arrêté l'abonnement du numéro verrait son numéro suspendu puis libéré. Une offre qui inclut le numéro et
  qui est vivante couvre donc le numéro comme un Pro vivant ; retirée, sa date de retrait sert de fin effective, comme la
  fin du dernier Pro. Et la fin d'un Pro payé pendant un Business ne recrée pas l'abonnement du numéro à 3,50 € sur sa
  carte : le Business le couvre.

### Le crédit offert (lot 1)

- **10 € au premier numéro relié et vérifié par Meta quand l'espace est en Business** (essai compris), au lieu du 1 €
  (décision). Une variable à part (`CREDIT_OFFERT_BUSINESS_MICRO_EUR`, défaut 10 €), avec le même levier d'urgence que
  celle du 1 € (0 coupe l'offre).
- **Complément au passage en Business** : un espace qui a déjà reçu une offre plus petite reçoit la différence jusqu'à
  10 €, une fois par espace, au moment où Julien pose le Business (décision). Les espaces marqués à 0 par la reprise de
  0191 reçoivent alors 10 € (choix de Claude : un seul Business par espace, la limite est la même).
- Chaque porte appelle `remonterPlafondApresRecharge` après sa transaction, comme les trois portes existantes.

### Rôles (lot 1)

Les trois rôles, sans limite d'administrateurs (choix de Claude). L'écran d'invitation dit enfin juste ce que peut un
manager (voir « À savoir »).

### L'analyse des conversations (lot 2)

- **Par conversation** (décision) : l'analyse qui tourne aujourd'hui pour l'Entreprise tourne pour le Business, visible dans
  la conversation et sur la fiche, poussée dans HubSpot, lue par l'outil MCP de la conversation. Choix de Claude : la même
  analyse, sans filtrer de champs ; la vitrine nomme « intentions, satisfaction et synthèses ».
- **Restent en Entreprise** : les automations déclenchées par l'analyse, le ciblage par l'analyse (MCP), l'écran « Analyse
  des conversations » et ses agrégats (décision). La fonction `analyse` se scinde donc entre ce qui calcule et montre
  (Business et Entreprise) et ce qui s'en sert ailleurs (Entreprise) ; le nommage se décide au plan du lot 2.
- **Qui paie** (décision) : le Business sur son crédit IA, au prix client (`prixClientMicroEur`, commission de 15 %),
  débité comme la traduction, les 10 € offerts y passant d'abord ; sans crédit, la conversation n'est pas analysée. Ni
  interrupteur ni réserve laissée aux agents (décision) : elle tourne tant qu'il y a du crédit, et « sans crédit, vos agents
  IA se taisent » vaut aussi pour elle.
  L'Entreprise reste sur notre clé, avec un plafond mensuel par espace (choix de Claude : 10 000 analyses, réglable),
  comme l'exige la règle « ce qui est sur notre clé porte un plafond ». Groupama PJ ne voit aucun changement.

### HubSpot seul (lot 2)

`crm` se scinde : une fonction pour HubSpot (Business et Entreprise), `crm` garde Salesforce et Batch (Entreprise). Les
lignes du choix des fonctions HubSpot suivent (les listes passent sous la fonction HubSpot ; l'analyse, sous `analyse`).
Le bouton « Connecter HubSpot » de la console reçoit la garde qui lui manque.

### Mes tableaux (lot 2)

« Mes tableaux » (le module des rapports et ses compteurs `/stats/workflow/*`) passe sous une fonction propre (Business et
Entreprise), avec une limite de tableaux : 4 en Business (décision), sans limite en Entreprise. Les quatre tableaux sont
montés par Messaging Me ; le client peut les modifier.

### Ce qui est du service, pas du code

- L'attribution et le routage : Messaging Me configure ce qui existe (les rôles, le bloc « remettre à un humain », le
  tourniquet des campagnes) (décision).
- L'équipe Messaging Me entre dans l'espace du client comme un membre invité, et Julien relève la limite d'un utilisateur
  dans `/ops` pour qu'elle ne prenne pas une place du client (décision) : rien à développer, la session d'observation de
  `/ops` reste en lecture seule.
- Les quatre tableaux, l'onboarding (2 h + 2 h de CSM sur deux mois, puis 120 € HT de l'heure), le support prioritaire.
- Seule trace dans le code (choix de Claude) : le formulaire de support de la console connaît le sujet « Passer en
  Business » et marque les demandes d'un espace Business comme prioritaires.

## Le widget personnalisable (lot 1)

- Décision : le widget est « personnalisable » (Business, Entreprise) ou non (Free, Pro). La vitrine ne parle pas de
  couleurs.
- Choix de Claude : « personnaliser », c'est l'apparence (couleur, position, libellé, avatar). Le nom, la phrase, la
  destination (agent de Meta ou scénario), l'activation et le débit restent ouverts à toutes les offres.
- Hors offre, une écriture qui change l'apparence est refusée avec la phrase de l'offre (console et MCP), et l'affichage
  public applique l'apparence standard (vert WhatsApp, en bas à droite, libellé et avatar par défaut). Ce qui est
  enregistré n'est pas effacé : un espace qui monte en Business retrouve son réglage.

## La marge IA n'apparaît nulle part (lot 1)

Décision : jamais affichée. Elle sort de la grille de la page Offre de la console, de la fiche publique « Choisir mon
offre » (française et anglaise, donc de la vitrine) et de la vue de l'offre que lisent la console et `get_plan` (choix de
Claude). Elle reste dans `DROITS` et s'applique ; les prix affichés des modèles restent « commission comprise », sans taux ;
`/ops` garde le réglage de la commission d'une Entreprise.

## La conservation lit la grille (lot 1)

En Pro et en Business, la durée de la grille s'applique, avec les deux règles qui valent déjà en Free : un réglage plus
court de l'espace est respecté, un plus long est plafonné ; une durée plus courte ne mord qu'après 30 jours de grâce depuis
l'entrée dans l'offre par le haut (sortie de l'Entreprise, sortie du Business). L'Entreprise garde son réglage de `/ops`.
Le levier d'urgence (le défaut de l'instance à 0) prime toujours. La purge, l'écran de synthèse et les coûts « hors
rétention » lisent toujours le même texte SQL.

## L'e-mail aller/retour (lot 3)

Décisions : la réponse revient à une adresse chez nous ; l'équipe répond par e-mail depuis l'Inbox (humains seulement,
pas l'agent IA) ; seuls les e-mails envoyés à l'adresse du contact ouvrent un aller/retour ; l'étage e-mail des campagnes
reste à part ; les pièces jointes reçues entrent, l'envoi de pièces jointes vient plus tard.

- **Une fonction propre** (Business et Entreprise). Le Pro garde l'envoi seul (`email`), tel qu'aujourd'hui.
- **L'aller** : un e-mail qu'un scénario envoie à l'adresse de la fiche du contact (le champ `email`), dans un espace qui a
  la fonction, part avec une adresse de réponse unique sur un domaine de réception Messaging Me, et s'inscrit dans la
  conversation du contact comme message sortant du canal e-mail (sujet, texte, identifiant du message gardé). Un e-mail à
  une adresse fixe (alerte interne) garde l'adresse de réponse de la boîte et n'entre pas dans le fil.
- **Le retour** : le fournisseur de réception (à choisir au plan du lot 3 : signature vérifiable, coût, domaine) remet la
  réponse à un webhook dont la signature est vérifiée avant toute lecture du corps. Le jeton de l'adresse désigne l'espace
  et la conversation, jamais l'adresse de l'expéditeur seule. Le texte nouveau (sans l'historique cité) s'affiche dans le
  fil, canal e-mail, avec l'adresse de l'expéditeur ; les pièces jointes sont stockées comme les médias WhatsApp (mêmes
  plafonds, même conservation). Un jeton inconnu est écarté et journalisé ; taille et débit sont bornés.
- **La réponse depuis l'Inbox** : sur une conversation qui a reçu un e-mail, l'opérateur choisit le canal e-mail ; l'e-mail
  part par la boîte SMTP vérifiée de l'espace (sans boîte, le choix est grisé avec sa raison), dans le même fil (« Re: »
  du sujet, références du message d'origine), avec la même adresse de réponse, et s'inscrit dans le fil. Texte seul. Pas
  de fenêtre de 24 h pour l'e-mail.
- **STOP** : la réponse par e-mail est un nouveau chemin d'envoi ; elle déclare `estDesabonne` et entre dans l'inventaire
  de `tests/optout-chemins.test.ts`.
- **Les données** : le canal `email` entre dans les types (la lecture range aujourd'hui tout ce qui n'est pas RCS en
  WhatsApp) ; la purge et l'effacement d'un contact couvrent les messages e-mail et leurs pièces jointes.
- La règle « pas de multicanal » du `CLAUDE.md` du dépôt se réécrit : le fil porte WhatsApp, RCS et e-mail.

## La vitrine (lot 1)

- Décisions : la carte Business sort tout de suite, ce qui n'est pas encore livré marqué « bientôt » ; quatre cartes de
  même poids (aucune mise en avant) ; le Business mène à « Demander une démo » (le formulaire de contact) ; « essai de
  14 jours sur demande » ; « widget personnalisable », jamais de couleurs ; jamais la marge.
- **Carte Business** : 349 € HT par mois ; « pour les équipes en croissance : collaboration, CRM et pilotage » ; essai de
  14 jours sur demande ; envois et automations illimités ; 5 000 contacts créés, entrants illimités ; 5 utilisateurs puis
  10 € HT par utilisateur et par mois ; 10 adresses de webhook ; 90 jours d'historique ; un numéro fourni inclus ; 10 € de
  crédit IA offert ; l'onboarding et le CSM ; le support prioritaire. « Tout ce que fait le Pro, plus » : le Meta Business
  Agent, les assistants de configuration, l'assistant d'aide, le widget personnalisable, puis, marqués « bientôt » jusqu'à
  leur lot : l'analyse des conversations, HubSpot, quatre tableaux de bord montés pour vous, l'e-mail aller/retour.
- **Carte Pro** : 1 000 contacts, 60 jours ; ses lignes MBA, assistants et aide passent au Business.
- **Carte Entreprise** : « Tout ce que fait le Business, plus » : publicités Click-to-WhatsApp, chaînes, RCS, tous les
  connecteurs CRM, le Performance Lab complet, SSO sur demande.
- Le chapeau, le titre et la description, les données structurées (une offre Business à 349 € par mois, hors taxe) et
  la FAQ (« Comment se paie le Business ? ») suivent ; la page anglaise se régénère par ses dictionnaires.
- Les marques `data-offre` et `data-fonction` couvrent le Business et le test les compare au code. Choix de Claude : une
  ligne « bientôt » porte une marque propre, et le test vérifie qu'elle ne nomme jamais une fonction déjà ouverte au
  Business (sinon « bientôt » mentirait), et qu'une fonction du Business n'est jamais marquée « bientôt ».
- Face publique nouvelle : le rendu (bureau et téléphone) est montré à Julien avant le push.

## Les textes à remettre au vrai

Chacun avec le lot qui le rend faux (l'inventaire complet, ligne par ligne, est dans le plan de chaque lot) :

- **Vitrine** (lot 1) : accueil (données structurées et FAQ), développeurs (section offre, FAQ générée par
  `scripts/plugin/faq.ts`), pages Shopify (`scripts/vitrine/boutique-textes.ts`), cas d'usage (`scripts/vitrine/cas-textes.ts`),
  centre d'aide (`scripts/vitrine/aide.ts` : « Avec l'offre Pro » devient l'offre la moins chère qui ouvre la fiche),
  « Choisir mon offre » et ses captures, `llms.txt`, chacune en français et en anglais.
- **Plugin** (lot 1) : la FAQ, le README généré, les skills qui nomment le Pro ou le MBA ; version montée, publiée après
  l'API.
- **Centre d'aide** (lot 1) : le champ `offre:` des fiches dit l'offre minimale au lieu d'un oui ou non ; les fiches qui
  citent le Pro, ses limites ou le MBA.
- **Console** (lot 1) : la liste des offres, la page Offre (grille, offre suivante, blocs), le formulaire de support,
  l'accueil, l'écran d'invitation, les pages développeurs, `/ops`, les composants qui nomment une offre, les docs publiques
  générées, les données des captures.
- **MCP et serveur** (lot 1) : `get_plan` et `subscribe_pro` (descriptions), les outils qui nomment une offre, les
  e-mails de limite (`src/emails-produit/`), les phrases « passez en Pro » écrites en dur (`src/api/fiche.ts`,
  `src/workflow/lancements.ts`, page Événements de la console).
- **Docs du dépôt** : `features.md` et ses fiches liées (empreintes), `documentation.md`, `CLAUDE.md` (« qui paie quoi »
  au lot 2, « pas de multicanal » au lot 3), `.env.example`.
- Lots 2 et 3 : les « bientôt » de la vitrine tombent, les fiches des fonctions livrées et la FAQ du plugin suivent.

## Les trois lots, dans l'ordre (décision)

1. **La grille, `/ops` et la vitrine** : le Business défini et posable à la main, le Pro resserré, tous administrateurs en
   Pro, la conservation et le numéro lus dans la grille, le crédit de 10 €, le widget personnalisable, la marge retirée,
   la vitrine à quatre cartes et les textes que cela rend faux.
2. **Les fonctions du Business** : l'analyse par conversation sur le crédit IA (et le plafond de l'Entreprise), HubSpot
   seul, Mes tableaux.
3. **L'e-mail aller/retour.**

## Ce qui ne change pas

La Free ; les prix du Pro, son essai Stripe et ses sièges à 15 € ; un contact qui écrit n'est jamais refusé ni compté hors
Free ; une réponse dans la fenêtre de 24 h n'est jamais bloquée par l'offre ; l'offre se calcule sur des dates ; le nom
interne `base` ; le gel au retour en Free ; l'Entreprise (fonctions, réglages de `/ops`, analyse sur notre clé) ; le numéro
fourni à 3,50 € HT hors offre payante ; Groupama PJ (Entreprise) ne voit rien changer.

## Hors du périmètre

- Stripe pour le Business : ni prix, ni paiement en ligne, ni souscription par Claude (décision).
- Tourniquet général, équipes, règles de routage (décision : du service).
- Les publicités en Business (décision : rien de plus que le Pro).
- Les campagnes e-mail, l'agent IA qui répond aux e-mails, l'envoi de pièces jointes depuis l'Inbox (décisions).
- Le SSO, la date de fin automatique d'un Business.

## Ce qui ferait échouer le projet même s'il marche

- Une page, un écran ou une réponse de Claude qui montre notre marge sur l'IA.
- Une ligne de la vitrine qui promet sans « bientôt » ce qui ne marche pas.
- Un client facturé deux fois (un Pro payé chez Stripe et un Business facturé à la main) sans que `/ops` l'ait signalé.
- Une purge d'historique déclenchée par un changement d'offre, sans grâce.

## À savoir (constaté pendant le relevé)

- Quatre fiches d'aide (publicités, RCS, chaînes, HubSpot) disent déjà « avec l'offre Pro » alors que ces fonctions sont
  réservées à l'Entreprise : le champ `offre:` du lot 1 les corrige.
- L'écran d'invitation et deux commentaires (0065, `src/http/users.ts`) disent qu'un manager n'a que l'Inbox, alors que le
  code lui donne davantage (affecter, réglages d'encadrement, contacts désabonnés, journal) : corrigé au lot 1, qui touche
  cet écran.
- Un espace qui descend de l'Entreprise garde son canal RCS actif, et les envois par scénario, campagne ou API ne
  vérifient pas la fonction `rcs` : choix de Claude, l'envoi RCS vérifie la fonction dès le lot 1.
- L'Entreprise reste à 1 € offert, moins que le Business (colonne E du tableau).
- Le dépôt est public : `features.md`, `documentation.md`, `CLAUDE.md` et `.env.example` citent les taux de commission.
  Hors du lot, à trancher par Julien.
