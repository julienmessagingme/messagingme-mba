# Architecture cible : conteneurs élastiques et base co-localisée

> Écrit le 2026-09-15, à la demande de Julien : « imagine qu'on va bientôt aller sur Scaleway, projette-toi,
> j'essaie de faire un exercice d'anticipation pour ne pas avoir à tout reconstruire quand on sera déployé
> pour de vrai ».

Ce document ne décrit PAS ce qui tourne aujourd'hui (voir `documentation.md`). Il décrit la forme visée, et
surtout **les trois choses qui, si on ne les traite pas, obligeraient à reconstruire** au lieu de déplacer.

## La cible

```
                         Cloudflare
                              |
         +--------------------+--------------------+
         |                                         |
   Console (Vercel)                      api.messagingme.app
   engageme.messagingme.app                        |
                                    Scaleway Serverless Containers
                                        API x N  (ELASTIQUE, 0..N)
                                                   |
                                          [ POOLER, transaction ]
                                                   |
                                     PostgreSQL manage, region PAR
                                                   |
                                          [ SESSION, direct ]
                                                   |
                                        Workers x M  (FIXE, min 1)
```

## 🔴 La règle qui gouverne tout le reste : deux tiers, deux besoins OPPOSÉS

**L'API est élastique et sans mémoire.** Elle peut passer d'un à vingt exemplaires en une minute, et chaque
exemplaire peut mourir entre deux requêtes.

**Le worker est fixe et permanent.** Il tient des abonnements aux files et une écoute de notifications ; il ne
se réveille pas sur une requête HTTP. Un worker « scale-to-zero » ne dépile rien, par construction.

Ces deux besoins ne se mélangent pas, et trois conséquences en découlent mécaniquement :

1. 🔴 **Un tiers élastique DOIT passer par un pooler.** Le nombre d'exemplaires est élastique, le nombre de
   connexions à la base ne l'est pas. Ce n'est pas une optimisation, c'est la condition d'existence de
   l'élasticité. Sans pooler, le dixième exemplaire tue la base au lieu d'ajouter de la capacité.
2. 🔴 **Un tiers élastique ne peut tenir AUCUNE connexion de session.** Une connexion de session est retenue
   pour la vie du processus et ne se partage pas ; multipliée par un nombre d'exemplaires variable, elle donne
   une consommation que personne ne peut borner.
3. 🔴 **Un tiers élastique ne peut porter AUCUN compteur en mémoire qui gouverne une décision.** Un plafond de
   débit compté dans un processus est un plafond multiplié par le nombre d'exemplaires, sans que ni l'écran ni
   la configuration ne le disent.

⚠️ Ces trois règles ne dépendent d'AUCUN fournisseur. Elles valent chez Scaleway, chez Fly, chez n'importe qui,
et c'est pour ça qu'elles sont la partie ferme de ce document. Les détails de produit (taille d'instance,
pooler intégré ou non, `min-scale`) se décident le jour venu et ne changent rien à ces trois-là.

## 🔴 Les trois chantiers qui forceraient une reconstruction

Ils sont détaillés dans `todo.md`. Résumés ici parce que c'est leur RAISON commune qui compte : **tous les
trois sont des états qui vivent dans un processus alors que le processus va devenir multiple.**

| Quoi | Où | Sans quoi |
|---|---|---|
| L'API tient un client pg-boss en mode SESSION pour empiler | `src/index.ts` | l'API ne peut pas être élastique, du tout |
| Les 23 balayages minutés vivent dans le worker | `src/worker/taches.ts` + `src/worker.ts` | un second worker fait tourner chaque balayage deux fois |
| Les plafonds de débit sont comptés en mémoire | `makeRequireAuth`, préfiltre des clés d'API | N exemplaires servent N fois le plafond annoncé |

⚠️ **Aucun des trois n'est urgent, et aucun ne se voit aujourd'hui.** Ils se découvriraient tous les trois EN
PRODUCTION, le jour du premier `scale`, ce qui est exactement le moment où l'on n'a pas envie de les
découvrir. Le premier est le seul bloquant absolu : les deux autres produisent du travail en double et des
plafonds trop larges, pas une panne de démarrage.

## ✅ Ce qui est déjà juste, et qu'il ne faut surtout pas casser

Vérifié dans le code le 2026-09-15. C'est la vraie réponse à « est-ce qu'on devra tout reconstruire » : non,
parce que ces sept propriétés sont déjà là, et aucune n'est un hasard.

- **L'API et le worker sont déjà deux points d'entrée distincts** (`src/index.ts`, `src/worker.ts`) qui
  partagent le code sans partager le cycle de vie. Le découpage que la cible exige est déjà fait.
- **`tenant_id = $1` sur chaque requête**, tenu par `tests/scope-tenant.test.ts`. C'est la clé d'isolation
  aujourd'hui et la clé de découpage le jour où une base ne suffira plus. Un produit qui interroge déjà par
  client se découpe par client.
- **Aucun état sur disque.** Les médias RCS vivent en base (`rcs_media`), pas dans un volume. Un conteneur qui
  meurt n'emporte rien.
- **Aucun websocket**, l'Inbox interroge en HTTP. Donc aucune session collante à gérer devant N exemplaires.
- **Le schéma vit dans `db/migrations/`**, pas dans un tableau de bord. Une base neuve plus `npm run migrate`
  le reproduit entièrement, configuration de recherche comprise.
- **Aucune dépendance spécifique à Supabase** : ni bibliothèque maison, ni Storage, ni Auth, ni PostgREST.
  Du PostgreSQL nu. ⚠️ C'est la propriété la plus fragile de cette liste : elle se perd le jour où quelqu'un
  branche une brique propriétaire pour aller vite, et personne ne s'en aperçoit avant le devis de migration.
- **`api.messagingme.app` est un NOM derrière Cloudflare.** Changer d'hébergeur coûte un enregistrement DNS,
  et le webhook de Meta n'a jamais à être reconfiguré.

## Ce qui se décide le jour du déménagement, pas avant

- **La taille de l'instance Postgres**, donc son nombre de connexions. Se calcule à partir de la charge
  mesurée à ce moment-là, pas d'une projection.
- **Le pooler** : celui du fournisseur s'il existe, un PgBouncer à nous sinon. La cible exige un pooler, pas
  un pooler particulier.
- **`min-scale` du worker**, et s'il reste un conteneur ou devient une machine.
- **pgvector chez la destination** : la seule extension non universelle dont ce produit dépend
  (`agent_knowledge.embedding`, fiches d'aide). À vérifier AVANT de s'engager.

## 🔴 La base part AVEC le calcul, jamais après

Calcul à Paris et base à Londres, chaque requête traverse internet. L'aller-retour est aujourd'hui de 11 ms
mesurés ; entre deux fournisseurs il serait bien pire, et il serait payé sur chacune des 131 transactions par
minute mesurées AU REPOS, avant tout client. **Le calcul et la base dans la même région, toujours.** Déménager
l'un sans l'autre serait un pas en arrière, pas un demi-pas en avant.

## Ce qu'on ne fait PAS, et pourquoi

- **Kubernetes.** Il résout l'orchestration de nombreux services sur de nombreuses machines. La marche d'avant,
  c'est un hébergeur de conteneurs avec un curseur « nombre d'exemplaires » : on déplace le curseur, on ne
  construit rien. K8s ajouterait une charge d'exploitation permanente sans ajouter une seule unité de capacité.
- **Plusieurs bases avant qu'un client ne gêne un autre.** Le découpage par client est PRÉPARÉ (voir
  `tenant_id`), il n'est pas à faire. Le faire tôt coûterait des requêtes croisées impossibles et une
  exploitation doublée, pour un problème que personne n'a.
- **Redis pour les plafonds partagés.** Postgres tient ce volume sans difficulté, et ajouter un composant
  ajoute une panne possible. On y viendra si la mesure le demande, pas avant.

## La règle de fond

**On ne construit pas pour une échelle qu'on n'a pas mesurée.** Chaque plafond réel de ce produit a été trouvé
par la mesure, jamais par le raisonnement. Ce document ne demande donc RIEN à construire aujourd'hui : il
nomme trois états-dans-un-processus à supprimer avant de multiplier les processus, et sept propriétés à ne pas
casser d'ici là. Tout le reste se décidera avec des chiffres qu'on n'a pas encore.
