# Campagnes : la chaîne de repli, et le parcours de création

> Spec de conception. Date : 2026-09-12. Cadrage de Julien, rédaction Claude.
> Statut : **à relire par Julien** avant écriture du plan d'exécution.

## Le but

Refaire le parcours de création d'une campagne autour d'une question unique, « par quel canal
essaie-t-on de joindre cette personne, et que fait-on si ça ne passe pas », et poser la tuyauterie
qui rend cette promesse vraie : un message qui échoue techniquement sur un canal repart sur le
suivant, sans double envoi, sans double facturation, et sans que l'opérateur ait à y penser.

Ce n'est pas un ajout d'option à l'écran existant. Le formulaire actuel
(`web/components/CampaignCreateForm.tsx`, 1 906 lignes) pose ses questions dans un ordre hérité, et
la campagne ne connaît qu'un seul canal (`campaigns.channel`, un enum à deux valeurs).

## Ce qui existe déjà, et qu'on ne réécrit pas

Trois briques portent l'essentiel du travail. Les ignorer produirait une seconde façon de faire la
même chose, ce que ce dépôt paie cher à chaque fois.

**Le mécanisme de bascule existe, sous le nom de relance.** `src/campaign/retry-sweep.ts` fait déjà :
erreur 131026, on relance une fois, et au second échec on clôt le destinataire en « injoignable ».
Le repli, c'est ce même mécanisme où l'étape finale **change de canal au lieu de clore**. Tout le
reste est acquis et ne bouge pas : le verrou de run (`run-lock.ts`), le claim atomique par
destinataire qui interdit le double envoi, le débit, la reprise après pause.

**Le verdict de joignabilité WhatsApp est déjà calculé, et on le jette.** `flagUnreachable` l'écrit
dans HubSpot et nulle part chez nous : la table `contacts` n'a aucune colonne de joignabilité
(vérifié sur les migrations 0001 à 0132). Le signal existe depuis la migration 0048, on le donne à
un tiers et on l'oublie.

**Le cache de joignabilité RCS existe**, `src/rcs/reachability.ts`, indexé par agent RCS, TTL de
7 jours, avec une dégradation correcte (fournisseur en panne, on sert la vieille réponse plutôt que
d'arrêter la campagne). Il ne change pas.

## Les décisions déjà prises (Julien, 2026-09-12)

| Question | Décision | Ce qu'elle achète |
|---|---|---|
| Quand bascule-t-on ? | **À l'échec technique de l'envoi**, plus la joignabilité mémorisée d'une campagne précédente | Le message n'est jamais parti, donc le double envoi est **structurellement impossible**, sans aucune machinerie de déduplication |
| Bascule au premier ou au second échec ? | **Au PREMIER, et pour TOUT code d'échec** | Retenter un canal qui vient de refuser retarde la seule chose qui compte, joindre la personne. Sans risque : les incidents temporaires sont déjà rejoués par la couche transport |
| 131026 avec l'option de réessai cochée | **Terminal quand même** | Le numéro n'est pas un numéro WhatsApp. Réessayer ne peut rien changer, ni maintenant ni demain |
| Ordre des étapes | Nom, Canal et repli, Contenu, Audience, Récapitulatif | Ordre choisi contre la recommandation de mettre l'audience avant le contenu. Conséquence assumée et compensée à l'étape 5 |
| Présentation du canal | Une liste à trois entrées, puis sous-questions | WhatsApp seul, RCS seul, ou les deux avec repli |
| Réessai sur campagne SANS repli | Une question à la création, **« Réessayer les envois qui échouent »** | Sans chaîne, c'est le seul rattrapage possible. Avec chaîne, le repli tient déjà ce rôle |
| Péremption | **90 jours** pour WhatsApp, **7 jours** (existant) pour le RCS | Asymétrie voulue : le RCS dépend du terminal et de l'opérateur, il est volatil ; un numéro qui gagne WhatsApp est rare mais réel |
| Analytics | **Par canal**, pas dédoublonné par contact | « envois WhatsApp : 1, réussi : 0 ; envois RCS : 1, réussi : 1 » |
| Débit RCS | **60 par minute** en attendant la réponse de smsmode | Valeur actuelle de fait, réglable en configuration, à réviser dès que le vrai plafond est connu |
| Assignation | Sans assignation, à une personne, ou **à tour de rôle dans l'équipe** | Les trois sont dans le périmètre |
| Campagnes existantes | **Aucune à préserver** : le parc actuel est du test, il sera effacé | Retire l'exigence de démontrer la reprise d'une campagne en vol |

## Le parcours de création

Cinq étapes, une question par écran, retour arrière libre à tout moment.

### Étape 1 : le nom

Obligatoire, premier. Rien d'autre sur l'écran.

### Étape 2 : le canal et le repli

Une liste à trois entrées :

1. WhatsApp
2. RCS
3. WhatsApp et RCS, avec repli

Le choix 3 ouvre deux sous-questions, dans cet ordre :

- **Lequel part en premier ?** WhatsApp ou RCS. Le second s'en déduit et s'affiche, il ne se
  choisit pas.
- **Un troisième niveau ?** Non (défaut), E-mail, ou SMS. **SMS est affiché grisé avec la mention
  « bientôt »** : montrer ce qui arrive vaut mieux que laisser croire que ça n'existera jamais, et
  l'emplacement est celui où l'utilisateur le cherchera le jour venu.

Le choix de l'e-mail affiche tout de suite que le destinataire sera l'adresse portée par la fiche
du contact, et qu'un contact sans adresse sortira de la chaîne.

**Les choix 1 et 2 (canal seul) ouvrent une question de plus** : « Réessayer les envois qui
échouent ? », cochée par défaut. Sans chaîne de repli, c'est le seul rattrapage disponible.

🔴 **Ne JAMAIS écrire « relancer » à cet endroit.** Dans le vocabulaire marketing, relancer
quelqu'un veut dire lui renvoyer un message parce qu'il n'a pas répondu. Ici il s'agit de retenter
un envoi qui a échoué techniquement, avant même que le destinataire ait vu quoi que ce soit. Un
utilisateur qui lit « relancer automatiquement la campagne » comprendra la première chose et
cochera pour une raison qui n'est pas la bonne. Le libellé porte le mot **réessayer**, jamais
**relancer**.

⚠️ **La question n'apparaît pas sur le choix 3**, parce que le repli tient déjà ce rôle. Conséquence
à assumer et à ne pas découvrir plus tard : le **dernier** étage d'une chaîne ne réessaie donc pas.
Un contact dont l'e-mail échoue est terminal du premier coup.

⚠️ **Un canal que l'espace n'a pas configuré est grisé AVEC SA RAISON, pas masqué.** Sans agent RCS
relié, l'entrée 3 doit dire pourquoi elle ne s'ouvre pas et où aller la régler. Une option absente
fait croire que la fonctionnalité n'existe pas.

### Étape 3 : le contenu

Un cadre par étage, dans l'ordre de la chaîne, chacun replié sauf celui en cours.

- **Cadre WhatsApp** : au choix, un modèle seul (choisi dans la liste ou édité à la volée, le
  parcours de soumission existant est conservé), ou un modèle **plus un scénario**.
- **Cadre RCS** : au choix, un message RCS seul (modèle existant ou édité, avec ses suggestions,
  jusqu'à 11) ou un message **plus un scénario**. ⚠️ Le RCS ne se réduit pas à un lien : l'éditeur
  de suggestions (`web/components/RcsButtonsEditor.tsx`) reste de la partie.
- **Cadre E-mail** : un modèle d'e-mail parmi ceux de l'espace. Pas de scénario à cet étage.

Puis, **une seule fois pour toute la campagne** et non par étage, la question du devenir de la
conversation :

- le Meta Business Agent prend la main,
- un agent IA existant prend la main (liste des agents de l'espace),
- ou ça tombe dans l'Inbox. Dans ce cas, un second choix à trois entrées : **sans assignation** (la
  conversation arrive dans « À traiter »), **assignée à une personne**, ou **répartie à tour de
  rôle** entre les membres de l'espace.

⚠️ **Le tour de rôle se joue à l'ARRIVÉE de la réponse, pas au lancement.** Répartir cinq mille
conversations d'avance attribuerait des conversations qui n'existeront jamais (la plupart des
destinataires ne répondront pas) et fausserait tous les compteurs de charge. Le rang du tour de
rôle se garde sur la campagne et s'incrémente au moment où une conversation devient réelle.

🔴 **L'assignation affiche le nombre de conversations concernées avant de valider.** Assigner cinq
mille conversations à quelqu'un doit se voir au moment où on le décide, pas le lendemain matin.

⚠️ Cette question vaut pour les deux formules, modèle seul comme modèle plus scénario. Un scénario
finit, lui aussi, et la conversation doit alors aller quelque part. La poser uniquement pour la
campagne simple aurait laissé le cas scénario sans réponse.

### Étape 4 : l'audience

Inchangée dans son principe (filtres CRM, liste de contacts, import). Un filtre nouveau devient
possible grâce à la joignabilité mémorisée : **exclure les contacts qu'on sait injoignables** sur
le premier canal. Non coché par défaut, parce que l'intérêt de la chaîne est justement de les
rattraper.

### Étape 5 : le récapitulatif

🔴 **C'est l'écran qui rachète l'ordre choisi.** L'audience arrivant après le contenu, l'opérateur a
configuré ses étages sans savoir combien de monde chacun couvre. Cet écran n'est donc pas un
résumé, c'est **la répartition prévue** :

- sur N contacts retenus, combien partent à l'étage 1,
- combien on **sait déjà** qu'ils basculeront à l'étage 2 (joignabilité mémorisée non périmée),
- combien n'ont pas d'adresse e-mail et sortiront de la chaîne avant le dernier étage,
- la durée estimée et le coût estimé, ventilés par canal.

Chaque ligne est cliquable et ramène à l'étape concernée. Si cet écran est bon, l'ordre choisi ne
coûte rien ; s'il est mou, il coûte cher.

## Le modèle de données

### La contrainte qui commande tout

`campaign_recipients` porte `unique (campaign_id, contact_id)`, et ce n'est pas un détail
d'implémentation : le `on conflict (campaign_id, contact_id) do nothing` de `insertRecipients`
**est** le dédoublonnage des destinataires (« la même personne qui repasse »,
`src/campaign/store.pg.ts:848`). 78 références réparties dans 12 fichiers source lisent cette table
en supposant une ligne par contact.

Trois conceptions ont été pesées.

**A. Une ligne par contact, colonne `etage` qui mute.** Ne casse rien, mais perd l'historique : la
ligne finit par dire « RCS, envoyé » et l'échec WhatsApp disparaît. **L'analytics par canal devient
impossible.** Écartée.

**B. Une ligne par tentative**, clé `(campaign_id, contact_id, etage)`. L'analytics tombe tout seul,
mais **change la GRANULARITÉ de la table** : tout agrégat qui compte des destinataires (plafond de
campagne, coût, historique de contact, statistiques) se met à double-compter les contacts retombés,
en silence, sur 78 points d'appel. Écartée.

**C. Retenue. Deux tables, deux grains, chacun avec sa question.**

- `campaign_recipients` **ne change pas de sens ni de clé** : une ligne par contact, qui répond à
  « où en est cette personne dans cette campagne ». Elle gagne seulement `etage_courant`. Les 78
  références continuent de dire vrai.
- `campaign_envois` (nouvelle) : **une ligne par tentative d'envoi**, en ajout seul. Elle répond à
  « combien d'envois sur quel canal, et avec quel résultat ». C'est la **seule** source de
  l'analytics par canal.

Le précédent existe dans le dépôt : `workflow_node_events` (migration 0063) est exactement ce
motif, un journal en ajout seul à côté d'une table d'état.

### Les changements de schéma

**`campaign_etages`** (nouvelle) : le contenu de chaque étage, y compris le premier.

```
campaign_id  uuid     not null references campaigns(id) on delete cascade
rang         smallint not null            -- 1, 2, 3
canal        text     not null            -- 'whatsapp' | 'rcs' | 'email'
-- contenu selon le canal : modèle et langue, message RCS, modèle d'e-mail, scénario
primary key (campaign_id, rang)
```

⚠️ **Une seule source pour le contenu d'un étage.** Les colonnes actuelles de `campaigns`
(`template_name`, `workflow_id`, le message RCS) décrivent aujourd'hui ce qui devient l'étage 1. La
migration **reprend** les campagnes existantes dans `campaign_etages` au rang 1. Les anciennes
colonnes restent en place, lues par plus rien de neuf, et se retirent dans une migration ultérieure
**après** le déploiement, conformément à la règle du dépôt (une migration qui retire passe après).

**`campaign_envois`** (nouvelle), en ajout seul :

```
id, campaign_id, recipient_id, contact_id, rang, canal,
statut ('sent' | 'failed' | 'saute'), message_id, error_code, error,
delivery_status, sent_at
```

Le statut `saute` porte le cas « on savait qu'il était injoignable, on n'a pas consommé d'envoi ».
Sans lui, l'analytics ne sait pas expliquer pourquoi personne n'a reçu l'étage 1.

**`campaign_recipients`** : `+ etage_courant smallint not null default 1`.

**`campaigns`** : `+ reessayer boolean not null default true` (l'option de l'étape 2, sans effet
quand une chaîne existe), `+ assignation text` (`null` | `'personne'` | `'tour_de_role'`),
`+ assignation_user_id uuid` et `+ tour_de_role_rang smallint not null default 0`, ce dernier
incrémenté à l'arrivée de chaque conversation réelle.

**`contacts`** : `+ whatsapp_joignable boolean`, `+ whatsapp_joignable_le timestamptz`. Les deux
nullables ; `null` veut dire **inconnu**, et ce n'est pas `false`.

🔴 **`null` n'est pas `false`, comme en 0121.** Un contact jamais sollicité est inconnu, pas
injoignable. Traiter l'inconnu comme injoignable ferait sauter tout le parc historique au premier
étage. Traiter l'injoignable comme inconnu ferait juste perdre le bénéfice. Les deux sens sont
tenus par des tests.

> **Numéro de migration** : à lire en base au moment d'écrire (`select name from
> public.schema_migrations order by name desc`), jamais depuis un fichier. Le compteur de
> `CLAUDE.md` annonce 0132 appliquée et 0133 libre ; il a dérivé cinq fois.

## Le moteur de repli

### Deux couches, et la plus basse existe déjà

🔴 **Le rejeu des incidents temporaires n'est PAS l'affaire de la campagne, et il est déjà fait.**
`src/meta/errors.ts` porte un classement `retryable` : HTTP 429, 408, 425 et tous les 5xx sont
rejouables, et `src/meta/http.ts` rejoue en plus les coupures réseau (`ECONNRESET`, `ETIMEDOUT`).

Conséquence, et c'est ce qui rend la règle de campagne simple : **quand un destinataire arrive en
`failed`, les incidents temporaires ont déjà été rejoués.** Une première version de cette spec
prévoyait une famille « incident temporaire » au niveau campagne pour éviter qu'un hoquet de Meta
ne bascule une campagne entière sur le RCS. Cette protection existe, une couche plus bas. La famille
a été retirée.

### La règle de campagne

Un destinataire échoue, après rejeu du transport.

| Cas | Avec chaîne de repli | Sans chaîne |
|---|---|---|
| **131026** (le numéro n'est pas un numéro WhatsApp) | Bascule à l'étage suivant, **dès le premier échec** | **Terminal, jamais de réessai, même si l'option est cochée.** Écrit la joignabilité sur le contact |
| **131049** (plafond marketing par utilisateur chez Meta) | Bascule à l'étage suivant, **dès le premier échec** | Réessai **le lendemain matin**, mécanisme existant de `retry-sweep` |
| **Tout autre échec** | Bascule à l'étage suivant, **dès le premier échec** | Réessai si l'option « Réessayer les envois qui échouent » est cochée |

🔴 **Avec une chaîne, tout échec bascule au premier coup, sans exception de code.** C'est la
décision de Julien, et elle est juste : retenter un canal qui vient de refuser retarde la seule
chose qui compte, joindre la personne. Le rejeu des incidents est déjà couvert plus bas.

🔴 **131026 DOIT SORTIR DE `RETRYABLE_CODES`** (`src/meta/errors.ts:65`). Il y est aujourd'hui, donc
un numéro sans WhatsApp est rejoué dans le transport **en plus** de la relance du balayage. Or Meta
dit textuellement que ce code veut dire que le numéro n'est pas un numéro WhatsApp, ou que la
personne n'a pas accepté les conditions : aucune de ces causes ne change dans la seconde. C'est du
gaspillage d'appels sur chaque numéro sans WhatsApp, et c'est un correctif de ce lot.

⚠️ **131046 n'existe pas.** Le code « Meta bloque une fois, on peut renvoyer le lendemain », fréquent
hors de France, est **131049**, « Marketing message limit reached ». Vérifié dans la documentation
Meta le 2026-09-12. Son traitement est déjà codé dans `retry-sweep.ts` (une relance, plus de 24 h
après, dans une fenêtre de début de journée, sous le réglage d'espace « Relancer automatiquement les
échecs »). ⚠️ À ne pas confondre avec le bouton « Corriger + renvoyer » du détail de campagne, qui
ne sert qu'aux erreurs de **variable de template**.

### Deux conséquences de la bascule sur 131049, à connaître

1. **Sur les marchés où 131049 est fréquent, une part notable d'une campagne WhatsApp deviendra du
   RCS**, et **ça ne se prédit pas** : le plafond est par utilisateur et vit chez Meta. Le
   récapitulatif de l'étape 5 ne peut pas l'annoncer, seule la facture le dira.
2. **La fenêtre matinale ne sert plus que pour les campagnes mono-canal.** Avec une chaîne, on ne
   patiente pas jusqu'au lendemain, on change de canal tout de suite.

### Ce que la bascule fait, mécaniquement

- On n'écrit pas terminal. On incrémente `etage_courant`, on remet le destinataire en attente, on
  ré-enfile. Le prochain tour l'envoie par le canal de l'étage suivant.
- **Plus d'étage disponible** : terminal.

### L'ordre des gardes avant chaque envoi

1. La joignabilité mémorisée dit « non » et n'est pas périmée : on saute l'étage sans consommer
   d'envoi, et on écrit une ligne `campaign_envois` au statut `saute`.
2. Pour le RCS, le cache de joignabilité existant s'applique comme aujourd'hui.
3. Pour l'e-mail, absence d'adresse sur la fiche : terminal, avec sa raison.

### Ce que le repli ne fait pas

Il ne se déclenche **jamais** sur une absence d'accusé de livraison. Décision de Julien, et elle est
bien fondée : nos accusés sont incomplets (relevé le 2026-09-11, une campagne à trois envoyés, zéro
délivré et trois répondus), et bâtir un renvoi automatique sur un signal défaillant enverrait un
second message à des gens qui ont parfaitement reçu le premier.

## La joignabilité mémorisée

### Un point de passage, pas un champ

Un module unique répond à « ce contact est-il joignable sur ce canal », et lit les deux sources
existantes plutôt que d'en créer une troisième :

```
joignabilite(tenantId, contactId, canal) -> 'oui' | 'non' | 'inconnu'
```

- canal RCS : le cache existant (`src/rcs/reachability.ts`, TTL 7 jours), inchangé ;
- canal WhatsApp : les deux nouvelles colonnes, avec péremption à **90 jours**.

Au-delà de la péremption, la réponse est `inconnu` et on retente : le coût d'un essai est un message
raté, le coût d'un faux définitif est un contact exclu pour toujours sans que personne ne puisse le
voir.

### Où la valeur s'écrit

Là où le verdict est déjà calculé et actuellement jeté : le second échec 131026 de
`retry-sweep.ts`, qui aujourd'hui n'écrit que dans HubSpot. L'écriture chez nous vient **en plus**,
et l'écriture HubSpot ne change pas.

Un envoi WhatsApp **réussi** écrit `whatsapp_joignable = true` : sans ça, le champ n'est qu'une
liste noire et ne sait jamais dire « oui ».

### Où elle se voit

- Fiche contact du mini-CRM : la joignabilité par canal, avec sa date, en clair.
- Filtre d'audience : « exclure les injoignables ».
- Récapitulatif de campagne : le comptage de l'étape 5.

## L'analytics

🔴 **Le funnel actuel compterait faux.** `getCampaignFunnel` (`src/stats/store.pg.ts:450`) agrège
`campaign_recipients`, une ligne par contact. Avec une chaîne, un contact produit un envoi WhatsApp
raté **et** un envoi RCS réussi, et la ligne unique n'en garde qu'un.

La requête lit désormais `campaign_envois` et **groupe par canal** :

```
WhatsApp : 1 envoi, 0 réussi, 0 délivré, 0 lu
RCS      : 1 envoi, 1 réussi, 1 délivré, 1 lu, 1 réponse
```

Une ligne de tête reste au grain du contact (« N contacts visés, M touchés »), parce que c'est la
seule qui répond à « combien de gens ai-je atteints » sans se faire piéger par les doublons.

⚠️ **La distinction « zéro » contre « on ne sait pas » est conservée** (colonne `sans_accuse`, posée
le 2026-09-11) et s'applique **par canal** : un canal sans aucun accusé affiche « — » et non « 0 ».

## Le débit

🔴 **Défaut actuel à corriger dans ce lot.** La jauge du formulaire est bornée à 80 avec 60 par
défaut, et son commentaire dit « plafond WhatsApp » (`web/components/CampaignCreateForm.tsx:157`).
Elle vient de `PHONE_RATE_PER_MINUTE_MAX` (`src/config.ts:216`) et s'applique **sans regarder le
canal**. Une campagne RCS se voit donc imposer aujourd'hui, en production, une contrainte de l'API
Meta.

Deux changements :

1. **Le plafond se résout par canal.** WhatsApp garde le sien, dérivé de Meta. Le RCS prend le
   sien, **60 par minute pour commencer** : c'est la valeur de fait d'aujourd'hui, et smsmode ne
   publie aucun chiffre (leur documentation répond que l'infrastructure « s'ajuste automatiquement
   au volume »). ⚠️ **60 est un point de départ, pas une mesure.** Julien pose la question à
   smsmode ; la valeur vit en configuration pour se corriger sans déploiement, et ne doit jamais
   être recopiée en dur.
2. **L'écran cesse de demander un nombre de messages par minute.** Un marketeur ne peut pas choisir
   ce nombre correctement, il n'a aucun moyen de connaître les plafonds des opérateurs. Il choisit
   une intention (« au plus vite », « étalé sur la journée », « heures ouvrées seulement », ce
   dernier existant depuis 0122) et l'écran affiche la durée estimée. Le plafond technique reste en
   coulisse.

## Hors périmètre

- **Le SMS.** Déclaré à l'écran, grisé, non implémenté. Aucune brique fournisseur.
- **La bascule sur absence d'accusé.** Écartée, avec sa raison.
- **Le retrait des anciennes colonnes de `campaigns`.** Migration ultérieure, après déploiement.

## Rayon de souffle

Ce que ce lot change et qui a des lecteurs ailleurs. À vérifier un par un pendant l'exécution.

- **`campaigns.channel`** cesse d'être la vérité du canal dès qu'il y a une chaîne. Qui le lit ? Au
  moins `src/stats/cost.ts`, `src/campaign/build.ts`, `src/campaign/sender.ts`, et l'étanchéité des
  canaux (lot du 2026-08-25). Chaque lecteur doit soit lire l'étage, soit être démontré indifférent.
- **`campaign_recipients.status`** ne veut plus dire « résultat de l'envoi » mais « état du contact
  dans la chaîne ». Tout écran qui affichait « échoué » doit distinguer « échoué à cet étage » de
  « échoué partout ».
- **Le plafond de campagne** (`src/campaign/plafond.ts`) compte des contacts : vérifier qu'il ne se
  met pas à compter des envois.
- **Le coût** (`src/stats/cost.ts`) : un contact passé par deux canaux coûte deux fois, et c'est
  correct. Vérifier que l'estimation le dit **avant** l'envoi.
- **`retry-sweep`** change de comportement terminal : son test actuel affirme « clôt en
  injoignable ». Ce cas doit être **conservé** pour les campagnes sans chaîne, pas remplacé.
- 🔴 **`RETRYABLE_CODES` perd 131026, et cette constante ne sert PAS qu'aux campagnes.** Elle est
  lue par tout ce qui appelle Meta (envoi d'un message rapide depuis l'Inbox, tour d'agent IA,
  scénario). Retirer 131026 supprime donc un rejeu **partout**, pas seulement en campagne. C'est
  voulu (le code veut dire la même chose sur tous les chemins), mais la liste des appelants se
  vérifie avant, pas après.
- **L'index `campaign_recipients_pending_idx`** (partiel, `where status = 'pending'`) sert la
  réclamation. Une bascule remet en `pending` : vérifier que le prédicat couvre toujours la requête.
- **L'historique de contact** (`src/crm/contact-history.pg.ts`) et le bilan par niveau livré le
  2026-09-11 comptent des départs de campagne : vérifier qu'une bascule ne crée pas un second
  départ.

## Tests

Chaque test est vérifié **par mutation dans les deux sens** (remettre le code fautif, constater
l'échec et son symptôme, restaurer), conformément à la règle du dépôt.

**Unitaires**

- **Avec chaîne, tout code bascule au premier échec** : 131026, 131049 et un code quelconque donnent
  le même geste. Un test par cas, pour que personne ne « rétablisse » une exception plus tard.
- **131026 est terminal même avec l'option de réessai cochée**, sans chaîne. 🔴 Ce test est celui
  qui casserait si quelqu'un remettait 131026 dans `RETRYABLE_CODES` : il tient les deux couches à
  la fois.
- **131026 ne vaut PAS `retryable`** au niveau transport (test direct sur `classify`), et 429, 425,
  408 et 5xx le valent toujours. Sans le second, on retire 131026 en cassant le rejeu des incidents.
- **131049 sans chaîne réessaie le lendemain matin**, pas tout de suite : le mécanisme existant est
  conservé, pas remplacé.
- L'option « Réessayer les envois qui échouent » décochée : aucun réessai, terminal du premier coup.
- Péremption : 89 jours lit la valeur, 91 jours rend `inconnu`.
- `null` n'est pas `false` : un contact jamais sollicité n'est pas sauté.
- Plus d'étage disponible : terminal, pas de boucle.
- Contact sans e-mail à l'étage 3 : terminal avec sa raison, pas d'envoi vide.
- Le débit résolu par canal : une campagne RCS n'hérite pas du plafond WhatsApp.

**Intégration (CI, Postgres jetable)**

- Chaîne complète sur une vraie base : un contact qui échoue à l'étage 1 et réussit à l'étage 2
  produit **deux** lignes `campaign_envois` et **une** ligne `campaign_recipients`.
- Le funnel par canal rend exactement la forme attendue.
- Le dédoublonnage à l'insertion survit : le même contact deux fois dans la cible donne une ligne.
- Les agrégats de plafond et de coût ne double-comptent pas.

**Bout en bout (Playwright)**

- Le parcours à cinq étapes, chaque branche de la liste de canal.
- Le récapitulatif affiche la répartition et ses liens de retour.
- Le troisième niveau SMS est visible et non sélectionnable.

## Ce qui reste ouvert

Plus aucune décision de conception. Trois choses à obtenir ou à établir pendant l'exécution.

1. **Le débit RCS réel.** Julien pose la question à smsmode. 60 par minute en attendant, en
   configuration. Ne bloque rien.
2. **Les codes d'échec de smsmode.** La chaîne se pense depuis WhatsApp, et on oubliera que le RCS a
   ses propres codes. La question à leur poser est la même qu'à Meta : lesquels veulent dire « ce
   destinataire est inapte » (donc joignabilité à mémoriser, et étage suivant) plutôt que
   « réessaie » (donc `retryable` au niveau transport, comme les 5xx de Meta). Sans ce classement,
   l'étage RCS d'une chaîne à trois niveaux basculera vers l'e-mail sur des incidents passagers.
3. **La validation de la bascule sur 131049**, présentée à Julien le 2026-09-12 avec ses deux
   conséquences (une part imprévisible de campagne WhatsApp devient du RCS hors de France, et la
   fenêtre matinale ne sert plus que pour le mono-canal).

⚠️ **Le parc actuel de campagnes est du test et sera effacé avant la mise en service.** La migration
reprend quand même les campagnes existantes dans `campaign_etages` au rang 1 : la reprise coûte
trois lignes de SQL, et parier sur un nettoyage manuel fait de l'ordre des gestes une condition de
correction.
