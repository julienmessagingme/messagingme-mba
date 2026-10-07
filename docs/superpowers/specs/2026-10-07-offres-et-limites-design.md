# Les offres et leurs limites (lot 6 de « Messaging Me pour Claude Code »)

Spec écrite le 2026-10-07 après le grill de Julien (cinq rondes, plus le design présenté en conversation), à relire par
lui avant le plan. Plan de référence : `docs/prive/2026-10-02-engageme-claude-code.md`, section « Les offres ». Elle
s'appuie sur les lots 3c et 4 (l'abonnement du numéro fourni, `abonnements_numero`, et son état calculé
`etatDeLEspace`), en production.

## 1. Ce que veut Julien

Une offre gratuite assez riche pour qu'un développeur (le plus souvent un vibe coder, dans Claude Code, Cursor ou
Lovable) construise et lance son app sans payer, et qui le fasse passer en Pro quand son app réussit : par le volume,
par l'équipe et par les fonctions. Jamais en bloquant les clients de son client : un contact qui écrit n'est jamais
refusé, et une réponse dans la fenêtre de 24 h n'est jamais bloquée.

| | Base (gratuite) | Pro | Entreprise |
| --- | --- | --- | --- |
| Prix | Gratuit | 49 € HT par mois, ou 490 € HT par an | Sur devis, activée par nous |
| Utilisateurs | 1 | 3, dont 2 admins au plus | 10, réglable |
| Contacts créés (import, API, MCP, console, scénario) | 100 | Illimités | Illimités |
| Contacts nés d'un message entrant | Jamais refusés, jamais comptés | Idem | Idem |
| Envois de modèles | 1 000 par mois civil | Plafond de Meta | Plafond de Meta |
| Messages dans la fenêtre de 24 h | Jamais bloqués par l'offre | Idem | Idem |
| Commission sur le crédit IA | 50 % | 10 % | 10 % |
| Analyse des conversations | Éteinte | Allumée | Allumée |
| Conservation des conversations | 30 jours | 90 jours | Réglable |
| Automations | 10 | Illimitées | Illimitées |
| Suppressions de contacts | 10 par jour | Sans limite | Sans limite |
| Webhooks sortants (lot à venir) | 1 adresse, journal sur 3 jours | 5 adresses, journal sur 30 jours | Réglable |
| Console | Modèles, campagnes, clés d'API, offre ; Inbox, scénarios et statistiques grisés | Tout, plus l'agent de Meta | Plus CRM, RCS, Performance Lab |
| Bot d'aide et assistants de configuration | Fermés | Ouverts | Ouverts |
| Numéro fourni | 3,50 € HT par mois | Inclus | Inclus |
| Badge du widget | Affiché | Retiré | Retiré |
| Crédit IA offert | 1 €, garde actuelle | | |
| Limite atteinte | Refus net, avec le lien « Passer en Pro » | | |
| Essai du Pro | Aucun | | |

Décisions annexes du même grill : le plafond de Meta sur les nouveaux clients connectés (200 par semaine) ne fait l'objet
d'aucun mécanisme pour l'instant ; les espaces qui existent au déploiement passent en Entreprise ; la tenue en charge
fait l'objet d'un lot à part, AVANT l'ouverture du site (section 10).

## 2. Les trois couches de limites

Elles ne se confondent pas, et seule la troisième dépend de l'offre.

| Couche | Ce qu'elle protège | Valeur, pour toutes les offres |
| --- | --- | --- |
| 1. Débit | La machine | 60 appels par minute et 1 000 par heure par espace, clés et MCP confondus (`API_PLAFOND_*`) |
| 2. Quotas quotidiens de l'API publique | L'abus | 2 000 envois et 20 000 fiches par jour civil de Paris (`API_QUOTA_*`, décision du 2026-10-04) |
| 3. Offre (neuf) | Le passage en Pro | La grille ci-dessus |

Les couches 1 et 2 restent les MÊMES dans toutes les offres (décision de Julien) ; un espace qui a besoin de plus est
réglé dans `/ops`, comme aujourd'hui. Aucune n'est relevée avant la mesure du lot de tenue en charge.

## 3. L'offre d'un espace, calculée

**Un module pur** (`src/offres/`) porte, par offre, les fonctions ouvertes et les limites chiffrées, en constantes dans le
code. Une limite `null` veut dire « sans limite », et aucun contrôle ne tourne alors. Les fonctions nommées : `inbox`,
`scenarios`, `statistiques`, `agent_meta`, `aide`, `assistants`, `analyse`, `crm`, `rcs`, `performance_lab`.

**L'offre se CALCULE sur des dates**, comme l'état du numéro au lot 4 ; aucun balayage ne l'écrit.
- **Pro** : un abonnement Pro dont Stripe n'a pas annoncé la fin (`customer.subscription.deleted`). Pendant les relances
  d'un impayé, l'espace reste en Pro : c'est Stripe qui décide de la fin, sans suspension à 7 jours comme pour le numéro.
- **Entreprise** : une surcharge posée dans `/ops`, avec ses limites réglables (utilisateurs, conservation).
- **Base** : tout le reste.

**Une seule définition, en SQL** (une fonction ou une vue, nom au plan), lue par la garde du code ET par les balayages
qui en dépendent (l'analyse, la purge des conversations). Deux définitions, l'une en TypeScript et l'autre en SQL,
finiraient par diverger. La garde la lit avec un cache court par espace, comme les quotas de l'API.

**Migration** (numéro pris à l'écriture) : la table des abonnements à l'offre (`abonnements_offre` : espace,
abonnement Stripe au format `^sub_[A-Za-z0-9]+$`, périodicité `mois` ou `an`, statut, fin de période, fin prévue, fin
effective, `livemode`, au plus un abonnement vivant par espace) ; la surcharge Entreprise sur les réglages de l'espace ;
l'origine d'une fiche (section 4) ; et la reprise qui passe tous les espaces existants en Entreprise. Elle AJOUTE, et
l'ancien code y survit : elle passe AVANT le `up`.

## 4. Ce que l'offre garde, et où

La règle du plan : **le contrôle est là où l'action s'exécute**, pas seulement à l'écran. Les vibe coders appellent
l'API directement.

| Garde | Où | Détail |
| --- | --- | --- |
| Fonctions | Registre des routes (`src/server.ts`) | Chaque module déclare la fonction qu'il exige, contrôlée au montage comme l'isolation entre espaces ; un test appelle chaque route gardée avec un espace Base |
| Fonctions | Outils MCP | Chaque outil déclare sa fonction. À la différence des droits de clé, un outil hors offre RESTE listé et refuse avec le lien : l'assistant peut alors l'expliquer |
| Fonctions | Console | Menus grisés avec la raison et un bouton « Passer en Pro » |
| Envois de modèles | Point d'envoi unique (`sendTemplate`, `sendMarketing` de `src/meta/factory.ts`) | Compteur partagé (`compteurs_debit`) sur le mois civil de Paris. Couvre tous les chemins : console, API, MCP, automations, scénarios |
| Campagne | Lancement | Refusée si ses destinataires dépassent le reste du mois ; si le reste s'épuise en cours (un envoi d'API concurrent), les destinataires restants sont écartés avec le motif de la limite |
| Contacts | Les chemins de création, sauf l'entrant | Une colonne d'origine posée à l'insertion : une fiche née d'un message entrant ne compte jamais. On compte les fiches actives, non supprimées |
| Automations | Création et rallumage | On compte celles du client ; celles que possède un lien de chaîne, une publicité ou un widget (`possede_par`) ne comptent pas |
| Utilisateurs | Invitation | Membres actifs plus invitations en attente, et 2 admins au plus en Pro |
| Suppressions | Suppression d'une fiche | 10 par jour en Base, compteur partagé |
| Badge du widget | Script du widget | Lu dans l'offre (`src/widgets/gestion.ts` le réserve déjà au Pro) |

**Ce qui n'est jamais compté** : un message dans la fenêtre de 24 h (réponse de l'agent IA, du répondeur, de l'Inbox, de
l'API, du MCP, d'un bloc de scénario). Seul un modèle, c'est-à-dire un message à l'initiative de l'entreprise, compte.

**Si le compteur ne répond pas**, l'envoi passe et l'incident est journalisé, comme les quotas de l'API aujourd'hui :
une panne de la base ne doit pas couper les envois de tout le monde pour une limite commerciale.

## 5. Les coûts selon l'offre

- **La commission** dépend de l'offre (50 % en Base, 10 % en Pro et en Entreprise). Elle reste calculée en un seul
  endroit (`prixClientMicroEur`, `src/agent/devise.ts`), qui reçoit celle de l'offre ; le catalogue des modèles affiché
  dans la console montre le prix de l'offre de l'espace.
- **L'analyse des conversations** (sur notre clé) ne part pas pour un espace Base : la réclamation des conversations à
  analyser lit l'offre en SQL. Passer en Pro n'analyse pas le passé (pas de rafale sur la file commune).
- **La recherche dans la connaissance** (vecteur de la question, reranker), **la vectorisation des fiches** et **la
  transcription des vocaux** passent sur le crédit du client, au prix de son offre, DANS TOUTES LES OFFRES : un seul
  calcul du prix d'un tour. Exception : la transcription du pont des codes de Meta (numéros fournis) reste à nos frais,
  c'est notre infrastructure. Le coût réel de chacune est à mesurer avant le plan.
- **Le bot d'aide et les deux assistants de configuration** (notre clé) sont fermés en Base ; en Pro et en Entreprise,
  ils gardent leur plafond actuel (`ASSISTANT_PLAFOND_EUROS_MOIS`).
- **Le crédit offert** est de 1 € pour tous les espaces, quelle que soit leur origine, avec la garde actuelle. Le défaut
  du code passe à 1 € ; Julien vérifie qu'aucun réglage de `.env.prod` ne le surcharge.
- **La conservation des conversations** : 30 jours en Base, 90 en Pro (le défaut de l'instance), réglable en
  Entreprise. La purge lit l'offre en SQL.

## 6. Stripe

- **Les prix** : Julien crée chez Stripe le produit « Messaging Me Pro » et ses deux prix (49 € HT par mois, 490 € HT
  par an). Leurs identifiants vont dans `.env.prod` (deux variables, noms au plan), comme `STRIPE_PRIX_NUMERO`.
- **Le paiement** : une session Checkout en mode abonnement, avec les mêmes réglages que le numéro (taxe automatique,
  numéro de TVA, facture), et une métadonnée qui distingue le Pro du numéro dans le webhook.
- **Le webhook** : les mêmes événements que l'abonnement du numéro (`customer.subscription.*`, `invoice.*`), signés et
  validés par Zod, écrivent `abonnements_offre`. Le passage en Pro est immédiat à la réception ; le retour en Base suit
  la fin effective.
- **Mensuel ou annuel** : le changement se fait dans le portail de Stripe, qui gère le prorata.
- **Le numéro inclus** :
  - un numéro fourni est couvert si son propre abonnement est actif OU si le Pro l'est. La règle vit dans
    `etatDeLEspace`, la seule lecture qui fait foi : sans elle, le balayage du lot 4 suspendrait puis libérerait le
    numéro d'un client Pro ;
  - au passage en Pro, l'abonnement du numéro seul s'arrête, avec un avoir au prorata ;
  - à la résiliation du Pro, la console, le portail et le MCP annoncent que le numéro restera actif à 3,50 € HT par mois
    sur la même carte, avec un bouton pour le rendre ; sans geste, l'abonnement du numéro seul démarre à la fin du Pro ;
  - un Pro qui finit sur un impayé suit le chemin du lot 4 (le numéro n'est plus couvert : suspension, puis libération
    à J+7 sauf réabonnement).
- ⚠️ **À mesurer** : les droits de la clé restreinte de Stripe pour l'enchaînement « Pro, puis numéro seul » (planning
  d'abonnement ou création différée), avant d'écrire le plan.

## 7. Le retour en Base : on gèle, on n'efface rien

Quand le Pro finit, rien n'est supprimé, et tout revient au réabonnement :
- les contacts au-delà de 100 restent, mais aucune création n'est possible ;
- les membres en trop perdent l'accès, le plus ancien admin garde le sien ;
- les scénarios construits par le client cessent de démarrer de nouveaux parcours (ceux en cours finissent) ; les
  scénarios système (le répondeur) continuent ;
- les automations au-delà des 10 plus anciennes se mettent en pause ;
- l'agent de Meta ne reçoit plus la main ; le répondeur par défaut de l'espace reprend ;
- les adresses de webhook au-delà de la première se mettent en pause (lot des webhooks) ;
- la conservation à 30 jours ne s'applique qu'à partir de 30 jours après le retour en Base : le temps de se réabonner
  ou d'exporter.

Le statut `locked` actuel ne sert pas de modèle : il ferme les portes sans arrêter le travail du worker. Le gel se pose
aux points d'exécution (démarrage de parcours, déclenchement d'automation, passage de main à Meta).

## 8. Les refus

- **API** : un code stable et un lien, dans la forme d'erreur existante (`src/api/erreurs.ts`) : `plan_feature_unavailable`
  pour une fonction hors offre, `plan_limit_reached` pour une limite atteinte, avec `upgradeUrl`. La phrase dit quoi
  faire, pour que l'assistant du développeur la relaie. Statut 402 pour les deux : il ne se confond pas avec le 403 d'un
  droit de clé manquant (`missing_scope`), qui ne se règle pas en payant.
- **MCP** : « Disponible en Pro » avec le lien, et l'outil reste listé.
- **Console** : grisé avec la raison, bouton « Passer en Pro ».
- **E-mail à 80 %** d'une limite : avec le lot 7 (la file d'e-mails). D'ici là, le refus net seul.

## 9. Les espaces existants

La migration les passe tous en Entreprise : rien ne change pour eux au déploiement. Julien ramène ensuite en Base, dans
`/ops`, ceux qu'il veut (un espace d'essai, par exemple).

## 10. Hors du lot 6

- **Les limites des webhooks** : déclarées dans le module des offres, appliquées par le lot des webhooks sortants.
- **L'e-mail à 80 %** : lot 7.
- **La tenue en charge**, lot à part avant l'ouverture du site : mesurer la capacité réelle sur une copie ; poser un
  plafond GLOBAL, tous espaces confondus, sur `/v1` et `/mcp` (429 avec `Retry-After` au-delà) ; réserver une part du
  pool de connexions à la réception des webhooks de Meta, qui ne doit jamais attendre l'API publique ; recalibrer la file
  des statuts, la purge des conversations, la relecture de la note de qualité et l'équité entre espaces de l'analyse ;
  une alerte sur le plafond d'équipe de la passerelle d'IA.
- **L'OAuth ouvert aux autres clients** (Cursor, Lovable) : lot à part.

## 11. Découpage et ordre de déploiement

| Livraison | Contenu |
| --- | --- |
| A | Le module des offres, l'offre calculée, la migration (dont la reprise en Entreprise), les fonctions gardées (routes, MCP, console), les compteurs (envois du mois, contacts, automations, membres, suppressions), les refus |
| B | Stripe : le Pro mensuel et annuel, le webhook, le numéro inclus dans `etatDeLEspace`, la bascule annoncée, le gel du retour en Base |
| C | Les coûts : la commission par offre, l'analyse éteinte en Base, la conservation par offre, la recherche, la vectorisation et la transcription sur le crédit, l'aide et les assistants fermés en Base, le crédit offert à 1 € |

Ordre de chaque livraison : la migration AVANT le `up` (relue en base juste après), l'API et les deux workers, puis la
console APRÈS l'API (un écran qui appelle une route neuve casse dès le push). La livraison A ne change rien pour
personne au déploiement, puisque tous les espaces existants sont en Entreprise.

## 12. Méthode de livraison

Implémenteur par livraison, puis une relecture du diff par livraison : le lot touche le point d'envoi unique, le webhook
de Stripe, une migration et des montants affichés, donc des chemins que la production emprunte, avec des invariants
invisibles (l'état du numéro du lot 4, le compte des contacts nés d'un entrant).

## 13. Les tests attendus

- Le module des offres : chaque offre, chaque fonction, chaque limite ; `null` ne déclenche aucun contrôle.
- La définition SQL de l'offre : Pro vivant, Pro fini, Pro en impayé, Entreprise, Base (intégration).
- Le registre : toute route d'un module gardé refuse un espace Base, comme `tests/scope-tenant.test.ts` pour l'isolation.
- Le point d'envoi : un modèle compte, un message dans la fenêtre ne compte pas ; le 1 001e modèle du mois est refusé ;
  le mois suivant repart à zéro.
- Les contacts : une fiche née d'un entrant ne compte pas ; la 101e fiche créée par l'API est refusée ; une fiche
  supprimée libère sa place.
- Le numéro inclus : un Pro vivant couvre un numéro dont l'abonnement seul est fini (ni suspension ni libération).
- Le gel : un espace revenu en Base ne démarre plus de parcours client, le répondeur continue.
- La commission : le même tour coûte plus cher en Base qu'en Pro, par le seul calcul.
- L'analyse : une conversation d'un espace Base n'est jamais réclamée.

## 14. Les essais réels qui closent

- **A** : un espace d'essai ramené en Base dans `/ops` ; la 101e fiche refusée par l'API et par le MCP, avec le lien ;
  l'Inbox grisée ; la 11e automation refusée.
- **B** : Julien prend le Pro sur cet espace avec un code promo à 100 % qu'il crée ; les fonctions s'ouvrent, le numéro
  fourni reste couvert ; puis une résiliation immédiate depuis le tableau de bord de Stripe : le gel s'applique et
  l'abonnement du numéro seul démarre.
- **C** : le prix d'un tour lu dans le journal du crédit, en Base puis en Pro ; une conversation de l'espace Base reste
  non analysée.

## 15. Ce que Julien règle chez Stripe

- Le produit « Messaging Me Pro » et ses deux prix, puis leurs identifiants dans `.env.prod`.
- Le portail : autoriser le changement entre le mensuel et l'annuel, et la résiliation en fin de période.
- Les droits de la clé restreinte, selon la mesure de la section 6.
- Le code promo à 100 % de l'essai réel B.
