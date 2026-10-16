# Les offres Free, Pro et Entreprise, deuxième version (spec du 2026-10-16)

> Remplace la grille de [la spec du 2026-10-07](2026-10-07-offres-et-limites-design.md), dont le mécanisme reste
> (l'offre calculée sur des dates, `offre_de_l_espace`, le nom interne `base`, les compteurs, le gel au retour en Free).
> Cadrée avec Julien le 2026-10-16, après la comparaison des grilles publiques de onze concurrents et l'inventaire de ce
> que la grille touche (serveur, Stripe, console, textes). Plan : à écrire après la relecture de cette spec.

## Ce que veut Julien

« Faut donner une bonne raison d'aller vers le pro quand tu es free », et surtout « bien montrer qu'il y a une vraie
différence entre le pro et le entreprise… sinon pourquoi payer 500 € alors que ça marche pour 50 € ». La différence
Free et Pro tient au pilotage : la Free « ne se gère qu'à partir d'un outil IA, d'un pupitre de commande, jamais à partir
de notre appli, notamment pour répondre ». La différence Pro et Entreprise tient à ce que l'Entreprise seule ouvre :
l'acquisition (publicités, chaînes), l'analyse des conversations, le CRM, le RCS et des garanties d'acheteur.

## La grille

| | Free | Pro | Entreprise |
|---|---|---|---|
| Prix | gratuit | 49 € HT par mois ou 490 € HT par an ; 3 utilisateurs inclus, 15 € HT par utilisateur en plus ; essai de 14 jours avec carte | sur devis |
| Pilotage | l'API et le MCP ; la console ne sert qu'au numéro (achat, liaison à Facebook), aux clés d'API et à l'offre | console complète | console complète |
| Contacts créés (un contact né d'un message entrant ne compte jamais et n'est jamais refusé) | 100 | 5 000 | réglables par espace, sans limite par défaut |
| Modèles envoyés (une réponse dans la fenêtre de 24 h ne compte jamais) | 1 000 par mois | sans limite de notre part | sans limite |
| Automations | sans objet (elles se créent dans la console) | sans limite | sans limite |
| Historique des conversations | 30 jours | 90 jours | réglable |
| Indicateurs | de base, par le MCP | avancés : les statistiques de la console et le MCP | le Performance Lab, partie qualitative comprise |
| Fonctions | agents IA, bulle, webhooks (1 adresse), API, MCP | + Inbox, scénarios et formulaires, statistiques, agent de Meta, e-mail, assistants, aide | + analyse des conversations, publicités Click-to-WhatsApp, chaînes WhatsApp, CRM, RCS, Performance Lab |
| Accompagnement | | | un interlocuteur dédié (un engagement, pas du code) |
| Promis, à construire | | | la connexion SSO (sur la page des tarifs), l'API des groupes WhatsApp |
| Commission sur le crédit IA | 50 % | 20 % | 10 %, négociable par espace |
| Numéro fourni | 3,50 € HT par mois | inclus | inclus |

**Les limites invisibles** (dans le code, jamais sur la page des tarifs ni dans la doc publique) :

| | Free | Pro | Entreprise |
|---|---|---|---|
| Suppressions de contacts | 10 par jour (elle empêche de contourner les 100 contacts en supprimant et recréant) | sans limite | sans limite |
| Clés d'API | 2 | 10 | sans limite |
| Appels à l'API et au MCP | 30 par minute, 500 par heure | 60 par minute, 1 000 par heure | relevés sur devis |
| Modèles par jour par l'API | 500 | 2 000 | relevés sur devis |
| Réponses par jour par l'API | 2 000 (jamais moins : ne jamais bloquer les clients du client) | 2 000 | relevées sur devis |

## Ce que mesure la production (sonde en lecture seule, 2026-10-16)

8 espaces : 1 Free, 7 Entreprise, aucun Pro ; un seul abonnement Pro a existé, résilié. 18 analyses en 30 jours, toutes
en Entreprise (Groupama PJ : 2). Au plus 3 clés d'API et 21 contacts créés par espace. **Personne ne perd rien** : aucun
régime de transition, aucune reprise. Le seul espace Free perd la console à la livraison qui la ferme : le prévenir.

## La Free, sans console

**Fermée côté serveur, pas seulement à l'écran.** Une fonction `console` (Pro et Entreprise) garde par défaut chaque
module de routes d'espace ; une liste blanche déclarée au registre (`src/server.ts`) reste ouverte en Free : l'offre et
ses paiements (Pro, crédit), le numéro (Embedded Signup, connexion 360dialog, numéro fourni et son abonnement), les clés
d'API, le consentement OAuth, le compte, la session, les e-mails de l'utilisateur. Un module ajouté demain naît fermé au
Free. `/v1` et `/mcp` n'y passent pas et restent ouverts. Raison : une campagne lancée depuis la console échappe au
quota de l'API ; fermer l'écran seul laisserait ce contournement.

**Dans la console, en Free** : l'accueil (le numéro, et une page qui dit comment piloter par Claude Code, Cursor ou
l'API, avec le lien du plugin), les clés d'API, l'offre, le compte (mot de passe, second facteur) et le support. Tout le
reste est fermé, avec le lien « Passer en Pro ».

**Par le MCP et l'API** : tout le reste, dont la recharge du crédit (`buy_credit`, existant) et deux outils neufs :
- `create_api_key` : une clé à droits limités, affichée UNE fois, dont la description dit qu'elle passe par la
  conversation avec l'assistant ; mêmes gardes que la console (administrateur, plafond des opérations coûteuses) ;
- un outil qui ouvre le paiement du Pro (mois ou an), sur le modèle de `buy_credit`, avec retour vers la page « paiement
  reçu ».

## Le Pro

- **Sièges payants** : un second prix chez Stripe (« Siège Pro », 15 € HT par mois, 150 € HT par an), en quantité sur
  l'abonnement. La limite d'utilisateurs devient 3 plus les sièges, posée en un seul endroit (`droitsDe`) pour que
  l'invitation, le gel et la vue suivent ensemble. Au-delà, l'invitation est refusée avec le prix ; l'administrateur
  confirme, la quantité change chez Stripe d'abord, et seulement si le prorata est payé. 2 administrateurs au plus.
- **Essai de 14 jours avec carte**, par la session de paiement de Stripe, une fois par espace (jamais si l'espace a déjà
  eu un Pro). Le Pro est ouvert pendant l'essai, numéro fourni compris. 🔴 L'arrêt de l'abonnement du numéro seul (quand
  un espace passe en Pro) attend la PREMIÈRE FACTURE PAYÉE : sinon un client qui payait son numéro le perd si l'essai
  n'aboutit pas. À la fin d'un essai non payé, l'espace revient en Free comme à la fin d'un Pro.
- **Commission à 20 %**, **5 000 contacts créés**, **10 clés d'API**.
- **Ce que le Pro perd** par rapport à aujourd'hui : l'analyse des conversations, les publicités, les chaînes (les gardes
  existent déjà) ; l'outil MCP `get_conversation_insights` passe sous la fonction `analyse` ; les déclencheurs
  d'automation fondés sur l'analyse sont refusés à la création hors Entreprise.
- **Les phrases de refus dépendent de l'offre** : un Pro à sa limite lit « ajoutez un utilisateur » ou « passez en
  Entreprise », jamais « passez en Pro ». Même règle pour les e-mails d'alerte de limite.

## L'Entreprise

- Fonctions : tout, plus ce qui est listé dans la grille.
- **Réglages par espace** (page `/ops`), en plus des utilisateurs et de l'historique : les contacts créés et la
  commission (un entier de 0 à 100). Sans réglage : sans limite, 10 %.
- **La connexion SSO** est promise sur la page des tarifs et se construit dans un lot à part, avant le premier client qui
  l'exige. **L'API des groupes WhatsApp** se cadre après une lecture complète de la documentation de Meta (accès,
  tailles, envois, facturation).
- Une offre illisible se replie sur l'Entreprise (`src/offres/cache.ts`) : la console reste ouverte pendant une panne ; la
  commission par défaut de 10 % s'applique alors même à une Entreprise négociée plus bas. Le commentaire qui la dit « la
  plus basse » se corrige.

## Les limites d'API par offre

Les valeurs par défaut des plafonds d'appels et des quotas viennent de l'offre (`DROITS`) ; un réglage d'espace (`/ops`)
les remplace ; la variable d'environnement à 0 reste le levier d'urgence. Le quota quotidien d'envois se scinde en deux
familles : **modèles** (envoi de modèle, `send_template_to_contact`) et **réponses** (message libre dans la fenêtre), pour
borner les modèles de la Free sans jamais borner ses réponses. Conséquence connue : le compte du jour repart à zéro au
déploiement.

## Ce qui ne change pas

Un contact qui écrit n'est jamais refusé ni compté ; une réponse dans la fenêtre de 24 h n'est jamais bloquée par
l'offre ; l'offre se calcule sur des dates ; le nom interne `base` ; le gel au retour en Free (les clés au-delà de 2
restent, aucune nouvelle) ; les prix du Pro (49 et 490) ; le numéro fourni à 3,50 € HT hors Pro.

## Les textes à remettre au vrai (chacun avec la livraison qui le rend faux)

La page Développeurs (FR et EN : la section offre et la FAQ générée), `scripts/plugin/faq.ts` et les skills du plugin
(version montée), les fiches d'aide (choisir mon offre, recharger le crédit IA, recevoir les e-mails) avec leurs sections de
`features.md` et leurs empreintes, les e-mails produit (limites, Pro, essai), la doc publique de l'API (les bornes),
`documentation.md`, la ligne « QUI PAIE QUOI » du `CLAUDE.md` du dépôt, et la page des tarifs (lot 6, en attente de cette
grille). Les limites invisibles sortent de la doc publique.

## Les livraisons, dans l'ordre (le plan les détaille)

1. **Grille additive** : la fonction `console`, les réglages Entreprise (contacts, commission), `get_conversation_insights`
   sous `analyse`, les phrases de refus par offre. Migrations additives AVANT.
2. **Limites d'API par offre** : clés, plafonds, quotas scindés. Migration additive AVANT.
3. **Console fermée en Free**, serveur et écrans, avec la page d'accueil Free et les textes qu'elle rend faux.
4. **Les deux outils MCP** (clé d'API, paiement du Pro), puis le plugin.
5. **Le Pro resserré** : analyse, publicités et chaînes en Entreprise, 5 000 contacts, 20 %, les e-mails par offre.
6. **L'essai de 14 jours** (gestes Stripe de Julien d'abord).
7. **Les sièges payants** (gestes Stripe de Julien d'abord).
8. **Les textes publics** et la page des tarifs.

## Choix par défaut, à confirmer à la relecture

- Siège annuel à 150 € HT (comme 490 = 10 × 49) ; siège acheté à l'invitation ; un siège retiré se fait depuis la page
  Offre, sans remboursement du prorata.
- Le Pro reste ouvert pendant les relances de paiement, comme aujourd'hui.
- En Free, le compte et le support restent dans la console (la sécurité du compte n'attend pas le Pro).
- Les quotas du Pro : 2 000 modèles et 2 000 réponses par jour, chacun relevable.

## Hors du lot

La construction de la connexion SSO et de l'API des groupes (lots à part) ; l'interlocuteur dédié (un engagement
commercial) ; un quatrième palier ; les contacts actifs par mois (abandonnés : les contacts créés suffisent).
