# Bascule Scaleway : le document qu'on actionne

> Écrit le 2026-09-15 à la demande de Julien, qui a raison : la matière était éparpillée entre `todo.md`,
> `CLAUDE.md` et `documentation.md`. **Ceci est la source unique.** Ailleurs, on met un pointeur vers ce
> fichier, jamais une copie.
>
> **Enrichi le 2026-09-21** avec un mémo externe sur l'architecture et la sécurité (daté du 2026-09-19),
> **vérifié contre le code et la production avant d'être repris**. Ce qui en a été écarté, et pourquoi, est
> au §14. Deux décisions de Julien du même jour : **deux workers** (§5) et **les fichiers hors de Postgres**
> (§6).

Ce document ne décrit pas ce qui tourne aujourd'hui (voir `documentation.md`). Il décrit **ce qu'on vise**,
**les quatre chantiers à finir avant**, et **la séquence du jour J**.

---

## 1. La règle qui gouverne tout : deux tiers, deux besoins OPPOSÉS

**L'API est élastique et sans mémoire.** « Élastique » veut dire que l'hébergeur démarre et arrête tout seul
des copies du programme selon le trafic. Aujourd'hui rien ne l'est : il y a exactement un exemplaire de
chaque, en permanence.

**Le worker est fixe et permanent.** Il tient des abonnements aux files et une écoute de notifications. Il ne
se réveille pas sur une requête HTTP, donc **un worker qui descend à zéro ne dépile rien, par construction.**

🔴 **Ces deux besoins ne se mélangent pas, et trois conséquences en découlent mécaniquement.** Elles ne
dépendent d'AUCUN fournisseur : elles valent chez Scaleway, chez Fly, chez n'importe qui. C'est la partie
ferme de ce document.

1. **Un tiers élastique doit avoir un nombre de connexions BORNÉ.** Le nombre de copies varie, le nombre de
   connexions que la base accepte, non. Tant que le nombre de copies est plafonné bas (deux, §2), le budget
   se calcule à la main (§7.5). Au-delà, **un pooler devient obligatoire** : sans lui, la dixième copie tue
   la base au lieu d'ajouter de la capacité.
2. **Un tiers élastique ne peut tenir AUCUNE connexion de session.** Une connexion de session est retenue pour
   la vie du processus et ne se partage pas. Multipliée par un nombre de copies variable, elle donne une
   consommation que personne ne peut borner.
3. **Un tiers élastique ne peut porter AUCUN état en mémoire qui compte.** Un plafond compté dans un processus
   est un plafond multiplié par le nombre de copies, sans que rien ne le dise ; un fichier déposé sur une
   copie est introuvable depuis l'autre.

---

## 2. La cible

```
   Front public                               Backend public
   engageme.messagingme.app                   api.messagingme.app
            |                                          |
          Vercel                                  Cloudflare
   (direct, SANS Cloudflare)                           |
                                  jeton d'origine injecté par Cloudflare (§7.3)
                                                       |
                                  Scaleway Serverless Container, API
                                  PRIVÉ, min 1 copie, max 2 copies
                                                       |
                                     Private Network (VPC), région PAR
             +---------------------------+-------------+---------------+
             |                           |                             |
     PostgreSQL managé           worker PRINCIPAL               worker ANALYSE
     endpoint privé seul         (instance privée)             (instance privée)
                                             \                     /
                                          Public Gateway (sortie seule, §7.4)
                                          vers Meta, Anthropic, Vercel, HubSpot

   Object Storage privé (HTTPS + IAM, §6) : médias RCS, pièces jointes de l'assistant MBA
   Connecteur HubSpot ----> SA PROPRE base (§8)
```

🔴 **L'API garde TOUJOURS une copie allumée (min 1), et c'est une correction.** La version du 2026-09-15
prévoyait `min-scale 0`. C'était une erreur : l'application démarre via `tsx` et met plusieurs secondes à
être prête, et le premier appel après un silence est souvent le webhook de Meta, celui qui porte les
messages entrants. Une copie permanente coûte un petit conteneur allumé ; un démarrage à froid sur ce
chemin coûte des rejeux de Meta et une réponse en retard au client.

⚠️ **Le plafond de DEUX copies est délibéré, pas une limite technique.** Il borne le budget de connexions
tant qu'il n'a pas été mesuré à plus grande échelle, et c'est lui qui rend acceptables, pour l'instant,
l'absence de pooler (§1.1) et les plafonds de débit encore comptés en mémoire (§3.3). Le relever demande de
refaire ces deux arithmétiques, pas seulement de bouger un curseur.

🔴 **La base part AVEC le calcul, jamais après.** Calcul à Paris et base à Londres, chaque requête traverse
internet. L'aller-retour est aujourd'hui de 11 ms mesurés ; entre deux fournisseurs il serait bien pire, et il
serait payé sur chacune des 131 transactions par minute mesurées AU REPOS, avant tout client. **Le calcul et
la base dans la même région, toujours.** Déménager l'un sans l'autre est un pas en arrière.

---

## 3. 🔴 Les quatre chantiers à finir AVANT de basculer

Tous les quatre ont la MÊME cause : **un état qui vit dans un processus, alors que le processus va devenir
multiple.** Aucun ne se voit aujourd'hui ; tous se découvriraient en production le jour du premier `scale`,
c'est-à-dire au pire moment.

### 3.1 L'API ne doit plus réserver de connexion

⚠️ **RIEN N'EST CASSÉ AUJOURD'HUI, et il faut le dire avant tout le reste.** L'API réserve deux connexions
pour rien : c'est du gaspillage, pas une panne, et ça ne coûte aucune performance tant qu'il y a UN exemplaire.
Avec deux copies au plus (§2), la consommation reste bornée (quatre connexions de session) : ce chantier est
donc **obligatoire avant de relever le plafond au-delà de deux**, et recommandé avant la bascule, parce que
le chemin touché est celui du dépôt de TOUTES les tâches, donc de l'arrivée de tous les messages, et qu'il
est plus sûr de l'éprouver sans trafic que le jour J.

**Le problème.** `src/index.ts` construit un client pg-boss sur `DATABASE_URL`, donc en mode SESSION, pour la
seule raison qu'elle EMPILE des tâches. Elle n'en dépile aucune et ne fait aucune maintenance
(`supervise: false`). Chaque copie d'API retient donc jusqu'à `PGBOSS_MAX` connexions réservées.

⚠️ **La panne existe déjà en miniature** : `DEPLOY.md` documente `EMAXCONNSESSION` au démarrage à froid **avec
deux processus seulement**, quand le pooler tient encore les sessions des conteneurs qu'on vient de tuer.
Aujourd'hui ça se résout seul en trente secondes. Avec des copies élastiques, ça devient permanent.

**La solution, et elle est prévue par la bibliothèque** (vérifié dans pg-boss 12.25 le 2026-09-15) :
`DatabaseOptions.db?: IDatabase` accepte une connexion FOURNIE, dont la seule méthode obligatoire est
`executeSql(text, values)`. Notre pool applicatif la satisfait trivialement. 🔴 Et le point décisif est dans
le code de `start()` : `if (this.#db._pgbdb && !this.#db.opened) await this.#db.open()`. Un `db` fourni n'a
pas ce marqueur, donc **pg-boss n'ouvre aucun pool à lui**.

**Ce qui reste actif côté API avec cette option** : la vérification de version du schéma, et la mise en cache
des files (des `select`). Le superviseur, l'écouteur de notifications et le planificateur sont déjà désactivés.

⚠️ **Poser aussi `migrate: false` sur l'API.** Sinon chaque copie vérifie et migre le schéma pg-boss au
démarrage. C'est le worker qui migre.

### 3.2 Les balayages doivent être sérialisés (avant deux exemplaires d'un MÊME rôle)

**Le problème.** Les tâches minutées vivent dans le processus (`src/worker/taches.ts`). Deux exemplaires du
même worker, deux exemplaires de chaque balayage : deux reprises de contrôle, deux réveils de parcours, deux
relances d'échecs. Certains sont idempotents, d'autres non.

⚠️ **Le découpage en deux RÔLES (§5) ne pose pas ce problème**, parce qu'il RÉPARTIT les tâches : chacune
appartient à un seul rôle. Le problème revient dès qu'un rôle a deux exemplaires.

**La solution.** Un verrou d'exécution, et **le modèle existe déjà dans le dépôt** : `src/campaign/run-lock.ts`
(migration 0089). Trois pièces, chacune pour une raison écrite : un **bail** (sinon un worker tué bloque le
balayage à vie), un **jeton de garde** (sinon le porteur d'un bail périmé supprime le verrou de son
successeur), un **drapeau de relance** (sinon le travail arrivé pendant la passe est perdu).

⚠️ Le lissage des départs livré le 2026-09-15 ne protège de RIEN ici : il décale, il ne sérialise pas.

### 3.3 Les plafonds de débit doivent quitter la mémoire (avant de relever le plafond de copies)

**Le problème.** `RATE_LIMIT_USER_PAR_MINUTE`, `RATE_LIMIT_COUTEUX_PAR_MINUTE`, le plafond par clé de l'API
publique, son préfiltre, ses opérations lourdes simultanées et le compteur d'usage de `/ops/usage` comptent en
mémoire, par processus. N copies servent N fois le plafond annoncé, et `/ops` ne voit que la copie qu'il
interroge.

⚠️ **Avec deux copies au plus, le pire cas est un plafond DOUBLÉ, connu et borné** (120 appels par minute par
clé au lieu de 60). C'est acceptable à condition d'être écrit ; ce ne l'est plus au-delà de deux.

**La solution : Postgres d'abord, Redis quand la mesure le demande.** Voir §9.

### 3.4 Les pièces jointes de l'assistant MBA doivent quitter la mémoire

**Le problème, que la version du 2026-09-15 avait oublié** et que le mémo du 2026-09-19 a relevé.
`src/mba/assistant/pieces-jointes.ts` range en MÉMOIRE, pendant deux heures, les documents qu'un client dépose
dans la conversation de l'assistant, en attendant qu'il accepte le diff. Le fichier le dit lui-même (« LE
MAGASIN EST EN MÉMOIRE, DONC LOCAL AU PROCESS »). Avec deux copies d'API, le dépôt arrive sur l'une et
l'application sur l'autre : « document déposé plus disponible ».

**La solution** : l'Object Storage (§6), avec une expiration automatique de deux heures. Le magasin est déjà
derrière une interface (`MagasinPiecesJointes`) : c'est un remplacement d'implémentation, pas une réécriture.

---

## 4. Ce qui est DÉJÀ juste, et qu'il ne faut surtout pas casser

Vérifié dans le code le 2026-09-15. C'est la vraie réponse à « devra-t-on tout reconstruire » : **non**, parce
que ces sept propriétés sont déjà là, et aucune n'est un hasard.

- **L'API et le worker sont déjà deux points d'entrée distincts** (`src/index.ts`, `src/worker.ts`) qui
  partagent le code sans partager le cycle de vie. Le découpage que la cible exige est fait.
- **`tenant_id = $1` sur chaque requête**, tenu par `tests/scope-tenant.test.ts`. Clé d'isolation aujourd'hui,
  clé de découpage le jour où une base ne suffira plus.
- **Aucun état sur disque.** Les médias RCS vivent aujourd'hui en base (`rcs_media`). Un conteneur qui meurt
  n'emporte rien. ⚠️ Ils sortiront de Postgres vers l'Object Storage (§6), qui GARDE cette propriété : un
  bucket n'est pas un disque local.
- **Aucun websocket**, l'Inbox interroge en HTTP. Donc aucune session collante devant plusieurs copies.
- **Le schéma vit dans `db/migrations/`**, pas dans un tableau de bord. Base neuve + `npm run migrate` le
  reproduit entièrement, configuration de recherche `french_sans_accent` comprise.
- **Aucune dépendance spécifique à Supabase** : ni bibliothèque maison, ni Storage, ni Auth, ni PostgREST.
  Du PostgreSQL nu. ⚠️ **C'est la propriété la plus fragile de la liste** : elle se perd le jour où quelqu'un
  branche une brique propriétaire pour aller vite, et personne ne s'en aperçoit avant le devis de migration.
  L'Object Storage de §6 se parle en protocole S3, standard : il ne la casse pas.
- **`api.messagingme.app` est un NOM derrière Cloudflare.** Changer d'hébergeur coûte un enregistrement DNS,
  et le webhook de Meta n'a jamais à être reconfiguré.

---

## 5. Deux workers : décidé par Julien le 2026-09-21

« Je veux vraiment à terme deux workers. » **Deux RÔLES, pas deux microservices.**

**Le worker principal** porte tout ce qui fait fonctionner le produit dans l'instant : messages entrants
(`webhook`), accusés (`webhook-status`), campagnes (`campaign-run`), scénarios et automations, tours d'agent
(`agent-turn`), poussées d'opt-out, et les tâches d'exploitation indispensables.

**Le worker d'analyse** porte les traitements différés que personne n'attend : `analyze-conversation`,
`push-analysis`, `hubspot-catchup`, le balayage des conversations à analyser, les agrégats et la rétention
propres aux analyses.

### 5.1 Ce que ça apporte, et ce que ça n'apporte pas

- Une panne, une fuite mémoire ou un redémarrage de l'analyse ne touche plus les entrants ni les campagnes.
- Chaque rôle a son processeur, sa mémoire et ses concurrences ; l'analyse peut grandir seule.
- ⚠️ **Ça ne réduit PAS la charge de la base** : les deux rôles parlent à la même. Mal borné, ça l'augmente
  (un pool et une écoute de notifications de plus).
- ⚠️ **Ça ne débloque rien aujourd'hui** : un appel lent au modèle ne bloque déjà pas le worker (les places
  de chaque file sont séparées, et l'attente du modèle ne tient aucune connexion). Le gain est l'ISOLATION,
  pas le débit.

### 5.2 La forme, et elle reste simple

- Même dépôt, même image Docker, mêmes types, mêmes stores. **Aucun copier-coller** de `worker.ts`.
- Une variable **`WORKER_ROLE=principal|analyse`** décide seulement quelles files et quelles tâches minutées
  sont enregistrées.
- Aucune API HTTP entre les deux : pg-boss sur Postgres est déjà le contrat durable.

### 5.3 Les pièges à traiter au découpage, tous

1. **Un seul superviseur pg-boss** : le principal. L'analyse démarre avec `supervise: false`, sinon la
   maintenance des files est faite deux fois.
2. **Le heartbeat devient PAR RÔLE.** La table porte aujourd'hui une seule ligne `worker` : deux processus
   l'écraseraient à tour de rôle et `/ops` croirait les deux vivants tant que l'un l'est. `/ops` contrôle
   chaque rôle séparément.
3. **Les tâches minutées sont RÉPARTIES, jamais dupliquées** : chacune appartient à un rôle (§3.2).
4. **Arrêt propre** : chaque rôle n'arrête que ses consommateurs et ses minuteries, avec la garantie d'aujourd'hui.
5. **Alertes identifiables** : préfixes `[worker-principal]` et `[worker-analyse]`.
6. **Pools bornés par rôle**, et le total recalculé (§7.5), écoute de notifications comprise.
7. **Concurrence d'analyse bornée.** Sortir l'analyse n'autorise pas à vider la file en parallèle : la base et
   le fournisseur du modèle restent les mêmes.
8. **L'arbitre de débit Meta reste PARTAGÉ.** Aucun limiteur local par worker.

### 5.4 Pas de troisième worker pour `webhook-status`

La file est déjà séparée des entrants, et sa concurrence reste à un pour protéger la base. ⚠️ **Le mémo
affirmait que son seuil de rafale était « corrigé » : c'est faux.** Mesuré le 2026-09-16 dans `pgboss.job`, la
rafale ne se déclenche presque jamais sur les petits paquets d'accusés, parce que pg-boss décide sur un
compteur qui peut avoir deux minutes de retard (détail : `todo.md`). Elle fonctionne sur l'avalanche d'une
campagne, et **Julien a arbitré le 2026-09-16 que seul ce cas compte**. Un troisième processus ajouterait un
pool, un heartbeat et une surface d'exploitation sans rien régler de mesuré.

---

## 6. Les fichiers sortent de Postgres : décidé par Julien le 2026-09-21

« Avoir une base à part pour les fichiers RCS et MBA, ça nettoie l'architecture de la base Postgres. »

**« À part » veut dire l'Object Storage, pas une seconde base PostgreSQL.** Une seconde base garderait tous
les défauts qu'on veut retirer (sauvegardes alourdies, dump de bascule plus long, connexions en plus) ; un
stockage objet est fait pour des fichiers, se facture au volume et expire seul.

- **Médias RCS** : les originaux et les variantes nécessaires à l'envoi, bucket privé, conservés selon une
  durée métier **à décider** (§13).
- **Pièces jointes de l'assistant MBA** : bucket ou préfixe privé, **expiration automatique à deux heures**
  par une règle du bucket (c'est ce qui remplace le magasin en mémoire, §3.4).
- **Postgres ne garde que les métadonnées** : `tenant_id`, clé d'objet, type constaté, taille, expiration,
  statut.
- **Jamais un bucket public**, même pour simplifier une URL. L'accès tiers passe par une URL signée courte ou
  par une route contrôlée ; les droits IAM sont limités, par programme, à ses préfixes.

🔴 **LES ADRESSES `/m/` DÉJÀ ENVOYÉES DOIVENT CONTINUER DE RÉPONDRE.** Un visuel RCS parti dans un message
livré porte une adresse `/m/<code>` qui circule chez le destinataire : c'est une porte à SENS UNIQUE, comme
`/r/`. La route `/m/` reste donc, et va chercher l'objet dans le bucket au lieu de la table. On ne donne
jamais l'adresse du bucket à l'extérieur.

🔴 **LA SORTIE DE `rcs_media.bytes` SE FAIT EN DEUX MIGRATIONS**, selon la règle du dépôt (« l'ancien code
survit-il à ce changement ? ») : d'abord écrire les nouveaux fichiers dans le bucket et savoir lire les deux
emplacements, puis recopier l'existant, et SEULEMENT APRÈS retirer la colonne. Retirer d'abord casserait
chaque visuel déjà distribué.

⚠️ **Durée des URL signées, à décider (§13)** : elle doit couvrir un téléchargement TARDIF par l'opérateur RCS,
pas seulement l'envoi.

---

## 7. Réseau et sécurité à Scaleway

### 7.1 Le réseau privé n'est pas une adresse

Le VPC (Private Network) est le réseau commun des composants. Il n'est pas joignable depuis Internet et n'a pas
d'URL. Cloudflare n'y « entre » jamais. L'API serverless a deux côtés : une porte HTTP gérée par Scaleway,
appelée par Cloudflare, et une sortie vers le réseau privé, qu'utilise son code pour parler à la base.
**L'API ne doit jamais devenir un relais générique vers le réseau privé** : seul son code y appelle quelque
chose. (Scaleway permet ce rattachement d'un conteneur serverless à un réseau privé, vérifié dans sa
documentation le 2026-09-21.)

### 7.2 La base : endpoint privé, et l'endpoint public SUPPRIMÉ

À sa création, une base managée reçoit un endpoint public. La séquence est **obligatoire et dans cet ordre** :
créer l'endpoint privé, basculer les programmes dessus, puis **supprimer** l'endpoint public. ⚠️ Une liste
d'adresses autorisées sur l'endpoint public n'est pas équivalente : elle se desserre par erreur, une absence
d'endpoint ne se desserre pas.

### 7.3 Cloudflare reste la SEULE porte de l'API

```
Meta, opérateur RCS, client /v1
   -> api.messagingme.app -> Cloudflare (ajoute ou ÉCRASE X-Auth-Token)
   -> conteneur Scaleway PRIVÉ -> API Engage Me
```

- Le conteneur est **privé** : un appel direct sur son nom technique `*.scw.cloud`, sans le jeton, est refusé
  AVANT d'atteindre l'application. ⚠️ Le nom technique n'est pas un secret, il ne protège rien à lui seul.
- Le jeton est **un secret technique d'ORIGINE**, sans rapport avec les clés `mba_...` des clients : le
  premier autorise Cloudflare à joindre le conteneur, les secondes autorisent un client à se servir d'Engage Me.
- **Solution retenue : une règle de réécriture d'en-tête (Request Header Transform Rule) sur le nom
  `api.messagingme.app`**, qui ÉCRASE `X-Auth-Token` (écraser, pas ajouter : sinon un client pourrait envoyer
  le sien). **Disponible sur l'offre gratuite de Cloudflare**, dix règles actives, vérifié le 2026-09-21.
  Variante si l'on veut le jeton masqué dans l'interface : un Cloudflare Worker avec un secret (offre payante
  des Workers, qui n'est PAS Cloudflare Pro). Pas de Worker si la règle suffit.
- ⚠️ **Le format exact du jeton côté Scaleway est à relire le jour du chantier** : la documentation annonce une
  migration de l'authentification des conteneurs privés vers IAM, donc le jeton est vraisemblablement une clé
  IAM à droits restreints, à faire tourner comme telle.

### 7.4 Les workers sortent par une Public Gateway, et n'entrent par rien

Les workers vivent sur des instances **sans adresse publique**. Or ils APPELLENT l'extérieur : Meta, Anthropic,
le Gateway de Vercel, HubSpot, les connecteurs des clients. **Sans passerelle de sortie, ils ne joignent rien.**
Il faut une **Public Gateway** sur le réseau privé (sortie seule, aucune entrée), et son coût. ⚠️ Le mémo du
2026-09-19 l'avait oubliée : c'est la pièce qui aurait manqué le jour J.

### 7.5 Le budget de connexions se recalcule, il ne se recopie pas

```
  2 x API        (pool applicatif + producteur pg-boss, tant que §3.1 n'est pas fait)
+ worker principal (pool applicatif + consommateur pg-boss + écoute de notifications)
+ worker analyse   (pool applicatif + consommateur pg-boss, écoute seulement si elle sert)
+ marge pour les migrations et l'administration
  <= nombre de connexions de l'offre choisie, relu À LA CRÉATION de la base
```

⚠️ **Ne pas recopier `DB_POOL_MAX=8` sur chaque processus sans ce calcul.** Un pooler ne crée aucune capacité
Postgres : il fait partager des connexions qui, sinon, resteraient occupées pour rien.

### 7.6 Les webhooks ne subissent JAMAIS les quotas des clients

Les plafonds des clés clients s'appliquent à `/v1/*` et `/mcp`, et à rien d'autre. **Jamais** à
`/webhooks/meta`, `/rcs/callback/*`, `/w/*`, ni par effet de bord à `/r/*` et `/m/*`. Meta peut renvoyer une
rafale de statuts après un retard, et un appel de machine à machine ne passe pas de défi navigateur. Ces
chemins gardent leurs protections propres : signature Meta, code opaque RCS, secret du webhook entrant,
limites de taille, mise en file immédiate. C'est déjà le cas aujourd'hui (le plafond par utilisateur est posé
dans `makeRequireAuth`, que les webhooks ne traversent pas) : la règle est à ne pas casser dans les règles
Cloudflare de demain.

### 7.7 Deux vérités sur Cloudflare à ne pas perdre

- **La console n'est PAS derrière Cloudflare** : `engageme.messagingme.app` pointe directement sur Vercel
  (vérifié par DNS le 2026-09-21). On ne met pas Cloudflare devant Vercel pour rendre un schéma vrai.
- **L'adresse que Cloudflare annonce pour le client (`CF-Connecting-IP`) n'est fiable que si l'origine refuse
  tout ce qui ne vient pas de Cloudflare.** Sinon quiconque joint l'origine en direct l'invente. Notre code ne
  s'y fie nulle part (Fastify est construit sans `trustProxy`) : la règle vaut pour le jour où il s'y fierait.
- **L'offre gratuite de Cloudflare suffit.** Pro (20 à 25 $/mois constatés le 2026-09-19) ne se prend que pour
  une fonctionnalité précise dont on sait décrire la preuve attendue : une exigence d'appel d'offres ou de RSSI,
  des règles de pare-feu ou de débit en plus, des robots réellement observés.

---

## 8. Le connecteur HubSpot : sa propre base, et il dort quand personne ne s'en sert

**Le constat de Julien** : un client qui n'a pas HubSpot subit quand même les connexions du connecteur.
C'est exact. Mesuré le 2026-09-15 : **un seul portail branché**, le portail cobaye, pour 4 connexions de
session retenues (2 processus x 2).

⚠️ **Mais le grain n'est pas le client, c'est le PROGRAMME.** Le connecteur est UN programme qui sert TOUS
les clients : il tient ses connexions parce qu'il TOURNE, pas parce qu'un client s'en sert. « Un client sans
HubSpot ne prend pas de lignes » n'est donc pas réalisable tel quel, il faudrait un programme par client.

L'intention est juste, et elle s'obtient par deux gestes distincts :

**a) Sa propre base (la réponse structurelle).** Le connecteur a DÉJÀ son schéma séparé (`mmhs`), mais un
schéma est un DOSSIER : les connexions, la mémoire et le processeur appartiennent au SERVEUR, pas au dossier.
C'est pour ça que le partage se voit malgré la séparation déjà faite.

🔴 **« Sa propre base » veut donc dire SA PROPRE MACHINE, et une seconde base sur le MÊME serveur ne règle
rien** : la limite de connexions est celle du serveur. La nuance décide de tout, et elle a un prix, un second
serveur managé.

⚠️ **LA QUESTION N'EST DONC PAS TECHNIQUE, ELLE EST COMMERCIALE.** Tant que le connecteur est une démo à un
portail, lui payer une machine pour libérer quelques connexions serait absurde ; on baisse sa consommation,
c'est une variable d'environnement. Le jour où il porte de vrais clients, il prend sa machine et le couplage
disparaît pour toujours. **C'est la présence de clients réels qui déclenche, pas la bascule Scaleway.**

⚠️ Vérifier avant, dans les deux cas : `mba` lit `mmhs` en cross-schéma aujourd'hui (voir `CLAUDE.md`), il
faut savoir OÙ et remplacer ces lectures par un appel.

**b) L'endormir (l'économie, en bonus).** Un conteneur serverless peut descendre à zéro copie et se réveiller
à la première requête. Zéro portail branché, zéro copie, zéro connexion ; un client s'y branche, ça se
réveille. ⚠️ Sa partie WORKER ne peut pas dormir de la même façon (§1) : si elle doit tourner, elle tourne,
mais sur sa propre base ça n'impacte plus personne.

**(a) supprime le problème, (b) supprime le coût.** (a) est celle qui compte.

---

## 9. Redis : oui un jour, non maintenant, et pas pour la raison qu'on croit

⚠️ **Redis n'est PAS ce qui rend possible d'avoir plusieurs API.** Plusieurs copies fonctionnent sans lui ; ce
qui a besoin d'un état partagé, ce sont seulement les **compteurs** (§3.3). Redis est l'outil de l'état
partagé à haute fréquence et courte vie, ce que des plafonds par minute sont exactement.

**Pourquoi Postgres d'abord.** Un compteur de plafond, c'est une écriture PAR REQUÊTE sur le chemin chaud.
Postgres le tient sans difficulté à notre volume, et n'ajouter aucun composant, c'est n'ajouter aucune panne
possible.

⚠️ **Le mémo du 2026-09-19 tenait Redis pour OBLIGATOIRE avant deux copies d'API. Position non reprise** :
avec deux copies au plus, le pire cas est un plafond doublé, connu et borné (§3.3), et Redis ajouterait un
service payant et un mode de panne de plus pour le fermer.

**Le déclencheur qui ferait passer à Redis** : quand l'écriture du compteur devient elle-même une charge
visible, c'est-à-dire quand on mesure des écritures de plafond au même ordre de grandeur que le trafic métier,
ou le jour où l'on relève le plafond de copies au-delà de deux. Scaleway a un Redis managé, qui se rattache
au même réseau privé ; la bascule sera un changement d'implémentation derrière la même interface.

🔴 **Écrire le compteur derrière une interface DÈS le chantier 3.3**, précisément pour que ce jour-là ce soit
un remplacement et pas une réécriture.

---

## 10. Le jour J : la séquence

**Prérequis, à valider AVANT de commencer :**

1. Les quatre chantiers du §3 sont finis et déployés sur l'infrastructure actuelle (le §3.1 au minimum
   éprouvé, le §3.3 au minimum ÉCRIT comme borné à deux copies).
2. **pgvector existe chez la destination.** Seule extension non universelle dont ce produit dépend
   (`agent_knowledge.embedding`, fiches d'aide). `pg_trgm` et `unaccent` sont des contribs standard.
   `pgcrypto` ne sert qu'à `gen_random_uuid()`, natif depuis PostgreSQL 13.
3. On sait où `mba` lit le schéma `mmhs` en cross-schéma (§8a).
4. Les fichiers sont déjà dans l'Object Storage, ou le seront dans la même fenêtre (§6).

**La séquence :**

1. Créer le projet, le réseau privé et tous les composants dans **une seule région, PAR**.
2. Créer la base managée, relever son nombre de connexions, **créer l'endpoint privé**, et refaire le calcul
   du §7.5 avec le vrai chiffre.
3. Créer l'Object Storage privé et ses règles d'expiration.
4. `npm run migrate` sur la base neuve. Vérifier `schema_migrations` et la présence de `french_sans_accent`.
5. **Fenêtre de maintenance**, puis `pg_dump` / `pg_restore` des données.
   🔴 **À notre taille (30 Mo), quelques minutes de fenêtre suffisent, et c'est un luxe qu'on perd en
   grandissant.** C'est un argument pour basculer TÔT : à 30 Go il faudra de la réplication logique, donc un
   chantier au lieu d'une commande. Sortir les fichiers de la base (§6) garde ce luxe plus longtemps.
6. Poser la **Public Gateway**, puis déployer les deux rôles de worker sur des instances sans adresse publique.
7. Déployer l'API : conteneur **privé**, **min 1 / max 2**, rattaché au réseau privé, secrets fournis par le
   gestionnaire de secrets de Scaleway (jamais dans l'image), contrôle de vie léger qui ne dépend pas de la
   base.
8. **Supprimer l'endpoint public de la base.**
9. Brancher Cloudflare : pendant la validation du certificat chez Scaleway, l'enregistrement peut rester en
   « DNS only » ; ensuite, proxy activé, règle du jeton d'origine posée, et **vérifier que l'appel direct au
   conteneur est refusé**. ⚠️ Le webhook de Meta n'a rien à reconfigurer, c'est tout l'intérêt d'avoir un NOM.
10. Garder `mba.messagingme.app` : `/api/backend/webhooks/meta` vers la nouvelle API (préfixe retiré), les
    anciens `/r/`, `/m/` et `/mcp` vers la nouvelle API, le reste du site vers `engageme.messagingme.app`
    (l'ancien conteneur `mba-web` disparaît).
11. Le connecteur HubSpot part sur sa propre base (§8a), si des clients réels le justifient à cette date.
12. Dérouler les **tests d'acceptation du §11**.
13. **Ne couper OVH qu'après une période d'observation et un retour arrière ÉPROUVÉ**, pas seulement écrit.

**Ce qu'on garde à Supabase le temps de vérifier** : rien. Une base lue par deux endroits est une base qui
diverge. La bascule est franche, et le retour arrière est la restauration du dump.

---

## 11. Les tests d'acceptation : la bascule n'est finie que si ces preuves existent

**Le chemin public**
- `https://api.messagingme.app/live` répond, à travers Cloudflare.
- Le nom technique du conteneur, appelé en direct sans le jeton d'origine, **refuse**.
- `mba.messagingme.app/api/backend/webhooks/meta`, les anciens `/r/` et `/m/` fonctionnent toujours.

**Ce qui doit rester fermé**
- La base n'a plus d'endpoint public ; ni elle ni Redis (s'il existe) ne sont joignables d'Internet.
- Les buckets et les objets sont privés par défaut.

**Les vrais échanges**, jamais des simulations
- Un vrai message WhatsApp entrant est enregistré et traité.
- De vrais statuts `sent`, `delivered` et `read` sont consommés.
- Un vrai rappel RCS est traité, et un visuel RCS reste lisible pendant toute la durée qu'exige l'opérateur.
- Une pièce jointe de l'assistant MBA est lisible depuis les DEUX copies d'API, puis disparaît à expiration.

**L'API publique**
- `/v1` applique ses plafonds et rend un `429`, **sans que les webhooks en soient affectés**.
- Une clé révoquée est refusée par les DEUX copies d'API.

**Les deux workers**
- Tuer le worker d'analyse ne ralentit ni les entrants ni les campagnes.
- Tuer le worker principal déclenche l'alerte de heartbeat qui le NOMME.
- Les deux rôles sont visibles séparément dans `/ops`.

**L'exploitation**
- Le commit déployé se lit depuis `/ops`, sans être exposé publiquement.

---

## 12. Ce qu'on ne fait PAS, et pourquoi

- **Kubernetes, service mesh, Kafka, RabbitMQ.** Ils résolvent l'orchestration de nombreux services sur de
  nombreuses machines. La marche d'avant, c'est un hébergeur de conteneurs avec un curseur « nombre de
  copies » : on déplace le curseur, on ne construit rien.
- **Des microservices.** Deux workers sont deux RÔLES d'un même programme (§5).
- **Plusieurs bases métier avant qu'un client ne gêne un autre.** Le découpage par client est PRÉPARÉ (§4), il
  n'est pas à faire. Le faire tôt coûterait des requêtes croisées impossibles et une exploitation doublée,
  pour un problème que personne n'a. (Le cas HubSpot du §8 est différent : ce n'est pas un client, c'est un
  autre produit. Et l'Object Storage du §6 n'est pas une base métier.)
- **Redis maintenant** (§9).
- **Un troisième worker pour les accusés** sans mesure nouvelle (§5.4).
- **Plus de deux copies d'API** sans avoir refait les deux arithmétiques du §2.
- **Un bucket public** pour simplifier une adresse, **des fichiers dans une seconde base PostgreSQL**, **un
  endpoint public de base laissé ouvert** « derrière une liste d'adresses ».
- **Un plafond de débit global** qui toucherait aussi les webhooks (§7.6).
- **Cloudflare Pro** sans fonctionnalité précise et preuve attendue (§7.7).

---

## 13. Ce qui reste à décider, et qui revient à Julien

Aucun de ces choix ne doit être remplacé par une valeur technique arbitraire.

1. **Les quotas par espace de l'API publique** (contacts écrits, destinataires créés, appels MCP, période de
   calcul). Aujourd'hui le quota par espace est OBSERVÉ et jamais appliqué (`plafondUnitesParEspace = 0`).
2. **La durée de conservation des médias RCS**, et la purge qui va avec.
3. **La durée des URL signées RCS**, qui doit couvrir un téléchargement tardif par l'opérateur.
4. **Quand** les deux workers : la cible est décidée (§5), le moment ne l'est pas.
5. **Le niveau de disponibilité** acheté pour la base (développement, production, haute disponibilité) au
   premier client important.
6. **Le moment où Cloudflare Pro** apporte une preuve commerciale ou RSSI qui justifie son coût.
7. **L'accès à `/ops`.** La décision écrite est celle du 2026-09-03 : `/ops` est SURVEILLÉ, pas durci. Le plan
   de réduction RSSI du 2026-09-09 recommande des comptes nominatifs avec double authentification ; le mémo
   du 2026-09-19 le présentait comme « la cible décidée », ce qui n'est pas le cas.

---

## 14. Ce qui a été écarté du mémo du 2026-09-19, et pourquoi

- **« Le seuil de rafale de `webhook-status` a été corrigé »** : faux, mesuré le 2026-09-16 (§5.4). Sa
  conclusion (pas de troisième worker) reste juste.
- **« Redis est requis avant deux réplicas »** : non repris (§9).
- **« `/ops` avec MFA, cible décidée »** : c'est une recommandation, pas une décision (§13.7).
- **Les workers sans adresse publique, sans passerelle de sortie** : complété par la Public Gateway (§7.4).
- **L'absence de pooler dans son schéma** : acceptable avec deux copies au plus, à la condition écrite au
  §1.1 et au §2.

---

## 15. La règle de fond

**On ne construit pas pour une échelle qu'on n'a pas mesurée.** Chaque plafond réel de ce produit a été
trouvé par la mesure, jamais par le raisonnement : les 16 clients vers le pooler, les deux accusés par minute,
les dix-sept par seconde en rafale, les 738 000 jetons par minute du Gateway sans un seul refus.

Ce document ne demande donc rien à construire « au cas où ». Il nomme **quatre états-dans-un-processus à
supprimer avant de multiplier les processus**, **sept propriétés à ne pas casser** d'ici là, et **deux
décisions de structure** prises par Julien (deux workers, les fichiers hors de Postgres). Tout le reste se
décidera avec des chiffres qu'on n'a pas encore.
