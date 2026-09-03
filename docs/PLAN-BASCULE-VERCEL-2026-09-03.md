# Plan : le front sur Vercel, l'API sur une adresse à elle

> Écrit le 2026-09-03, avant tout changement. À lire en entier avant de toucher quoi que ce soit.

## 1. L'idée qui débloque tout le reste

Tu as écrit : « si on fait des transferts entre le front engageme et le backend aujourd'hui sur VPS bientôt
sur Scaleway avec une autre adresse, je comprends pas le montage ».

**Il n'y a pas d'autre adresse.** C'est tout le montage, et c'est la seule chose à retenir.

Le front ne saura JAMAIS sur quelle machine tourne l'API. Il connaîtra un NOM : `api.messagingme.app`. Ce nom
t'appartient. Aujourd'hui il pointe sur le VPS OVH. Le jour où tu passes à Scaleway, tu changes **une ligne de
DNS chez Cloudflare** et le nom pointe ailleurs. Le front ne change pas, ne se redéploie pas, ne s'en aperçoit
même pas.

```
                    engageme.messagingme.app          (Vercel, le site)
                              |
                              |  le navigateur appelle
                              v
                    api.messagingme.app               (un NOM, pas une machine)
                              |
                              |  ce nom pointe vers...
                              v
              aujourd'hui : VPS OVH      demain : Scaleway
                                          ^
                                          |
                          le jour du déménagement, tu changes
                          UNIQUEMENT cette flèche, chez Cloudflare
```

C'est exactement pour ça qu'on introduit `api.messagingme.app` au lieu de laisser le front pointer sur
`mba.messagingme.app` ou sur une adresse IP. Un nom se déplace, une machine non.

**Le worker ne bouge pas et n'a pas d'adresse.** Personne ne l'appelle : il lit la base et travaille tout
seul. Il déménagera avec l'API, sans que rien d'autre ne le sache.

## 2. Ce que j'ai vérifié avant d'écrire ce plan

Ma première réaction a été trop prudente et tu as eu raison de me reprendre. J'avais appliqué la règle du
dépôt sur les « portes à sens unique » sans vérifier si elle s'était réalisée. Vérification faite en base :

- **Les deux seuls espaces sont `Demo` et `MessagingMeEmbdedded`.** Aucun client réel.
- Les neuf liens tracés pointent vers `google.fr`, `messagingme.fr` et le cinéma de Mérignac. **Tes propres
  essais.** Les 92 clics sont les tiens.

**Conclusion : on peut tout renuméroter maintenant, et c'est la dernière fois que ce sera gratuit.** Au premier
client réel, `/r/` et `/m/` deviennent des adresses figées à vie.

J'ai aussi trouvé trois choses qui rendent la bascule beaucoup plus simple que je ne le craignais :

1. **Le jeton de session est en `localStorage`, pas en cookie.** C'est le cas facile du cross-origine : aucun
   problème de `SameSite`, de cookie tiers ou de `credentials`. Le jeton part dans un en-tête `Authorization`.
2. **Le front n'appelle l'API que depuis le navigateur**, et par UNE seule constante :
   `web/lib/http.ts:15`, `export const BASE = '/api/backend'`. Une ligne à changer.
3. **`APP_URL` est le seul robinet** qui fabrique toutes les adresses publiques que le produit distribue.

## 3. L'architecture visée

| Nom | Sert | Hébergé où |
|---|---|---|
| `engageme.messagingme.app` | la console (le site) | **Vercel** |
| `api.messagingme.app` | l'API : `/v1`, `/r/`, `/m/`, `/mcp`, le webhook Meta | VPS aujourd'hui, Scaleway demain |
| `mba.messagingme.app` | rien, ou une redirection vers `engageme` | à retirer |

Le worker et la base ne changent pas.

## 4. Le piège principal, trouvé en lisant le code

🔴 **`APP_URL` fait deux métiers à la fois, et ils vont se séparer.**

Aujourd'hui `APP_URL = https://mba.messagingme.app` sert à fabriquer :

- les liens des **e-mails** (invitation `/invite/<jeton>`, réinitialisation `/reset/<jeton>`) → ce sont des
  pages **du FRONT** ;
- les **liens tracés** `/r/<code>` et les **visuels RCS** `/m/<fichier>` → ce sont des routes **de l'API**.

Tant que les deux vivaient sur le même hôte, une seule variable suffisait. Dès qu'on les sépare, **garder une
seule variable casse forcément un des deux côtés** : soit les e-mails envoient les gens vers l'API (page
blanche), soit les liens tracés font un détour inutile par Vercel.

**Il faut donc scinder `APP_URL` en deux variables** avant la bascule :

- `APP_URL` → `https://engageme.messagingme.app` (les e-mails, le front)
- `PUBLIC_API_URL` → `https://api.messagingme.app` (les liens tracés, les visuels RCS)

C'est un changement de code, petit mais obligatoire, et il doit être fait et déployé **avant** de toucher au
DNS. C'est l'étape 1.

## 5. Le plan, dans l'ordre

Chaque étape est vérifiable et réversible. On ne passe à la suivante que si la précédente est verte.

### Étape 1 : scinder `APP_URL` (code, sur le VPS actuel)

Ce qu'on fait :
- ajouter `PUBLIC_API_URL` dans `src/config.ts`, avec pour défaut la valeur d'`APP_URL` (donc **aucun
  changement de comportement** tant qu'on ne la pose pas) ;
- faire lire cette nouvelle variable aux deux endroits qui fabriquent des adresses d'API : les liens tracés
  (`src/index.ts`) et les visuels RCS (`src/rcs/image.ts`) ;
- laisser `APP_URL` aux e-mails.

**Pourquoi le défaut compte** : si on oublie de poser la variable en production, tout continue exactement
comme avant. Une variable dont l'oubli casse la prod est une mauvaise variable.

Vérification : les tests, puis en production, un lien tracé fabriqué doit toujours porter la même adresse
qu'avant. **Rien ne bouge encore pour l'utilisateur.**

### Étape 2 : ouvrir `api.messagingme.app` sur le VPS

Ce qu'on fait : un nouveau proxy host dans NPM, `api.messagingme.app` → `mba-api:8095`, avec son certificat
Let's Encrypt. Plus l'enregistrement DNS chez Cloudflare.

⚠️ **Ce que ça change vraiment** : aujourd'hui l'API n'a **aucune porte publique**, elle n'est joignable qu'à
travers le serveur Next. Après cette étape, elle est sur Internet. Ce n'est pas un problème (chaque route a
déjà son contrôle : JWT pour la console, `OPS_TOKEN` pour `/ops`, signature Meta pour le webhook), mais c'est
un changement de surface qu'il faut nommer plutôt que de le subir.

Vérification : `https://api.messagingme.app/live` répond 200, et `https://mba.messagingme.app` continue de
fonctionner **exactement comme avant**. Les deux coexistent. Retour arrière : supprimer le proxy host.

### Étape 3 : autoriser le front à appeler l'API depuis un autre nom (le CORS)

**Ce que c'est, en une phrase** : par défaut, un navigateur interdit à une page servie par
`engageme.messagingme.app` d'appeler `api.messagingme.app`. C'est une protection du navigateur, pas de nous.
Le CORS est la façon dont l'API dit « cette origine-là, je l'accepte ».

Concrètement : `@fastify/cors` enregistré sur l'API, avec une **liste blanche d'origines**, jamais `*`. Deux
origines au départ : `https://engageme.messagingme.app`, et l'aperçu Vercel si on veut pouvoir tester.

C'est simple **ici** parce que le jeton est en `localStorage` : il n'y a que l'en-tête `Authorization` à
autoriser, pas de cookie, donc aucun des pièges habituels.

Vérification : depuis le navigateur, un appel à `api.messagingme.app` doit passer. Retour arrière : retirer
l'enregistrement.

### Étape 4 : préparer le projet Vercel, sans DNS

Ce qu'on fait :
- projet Vercel branché sur le dépôt GitHub, **Root Directory = `web`** ;
- variable de build `NEXT_PUBLIC_API_URL = https://api.messagingme.app` ;
- `web/lib/http.ts` : `BASE` lit cette variable, avec repli sur `/api/backend` (donc **le déploiement VPS
  actuel continue de marcher à l'identique**) ;
- corriger les deux adresses en dur de la page « Développeurs » (`app/developers/api/page.tsx`), qui montrent
  `https://mba.messagingme.app/api/backend/v1` aux intégrateurs.

⚠️ **Deux points à vérifier au premier déploiement, que je ne veux pas affirmer sans l'avoir vu** :
- `output: 'standalone'` dans `next.config.mjs` existe pour le conteneur Docker. Vercel construit Next
  nativement. C'est probablement sans effet, mais c'est la première chose à regarder si le build se comporte
  bizarrement.
- les rewrites `/r/`, `/m/`, `/mcp` du `next.config.mjs` n'ont plus de raison d'être une fois que l'API a son
  propre nom. On les retire, mais **seulement à l'étape 6**, pas avant.

À la fin de cette étape, tu as une URL Vercel (`...vercel.app`) qui fonctionne, **et la production est
intacte**. Tu peux cliquer partout dessus tranquillement.

### Étape 5 : brancher `engageme.messagingme.app`

Ce qu'on fait : ajouter le domaine dans Vercel, puis le CNAME chez Cloudflare.

⚠️ **Le piège Cloudflare** : tes sous-domaines sont en mode **Proxied** (nuage orange). Vercel doit vérifier
que tu possèdes le domaine et émettre son certificat, et le proxy Cloudflare peut l'en empêcher. Le chemin sûr
est de créer l'enregistrement en **DNS only** (nuage gris), laisser Vercel valider et émettre son certificat,
et seulement ensuite décider si on remet le proxy. Vercel a déjà son propre CDN et son propre certificat :
remettre Cloudflare devant n'apporte pas grand-chose ici, et ajoute une couche qui peut casser.

Vérification : `https://engageme.messagingme.app` sert la console, tu te connectes, l'inbox charge, une
campagne se crée. **La production sur `mba.` marche toujours en parallèle**, c'est ça le filet.

### Étape 6 : basculer les adresses que le produit distribue

C'est ici, et seulement ici, qu'on coupe le cordon. Trois gestes, chacun réversible :

1. `.env.prod` sur le VPS : `APP_URL=https://engageme.messagingme.app` et
   `PUBLIC_API_URL=https://api.messagingme.app`, puis `up -d --force-recreate` (⚠️ un `up -d` simple ne
   recharge pas `env_file`).
2. **Le webhook Meta** : dans l'app Meta, remplacer
   `https://mba.messagingme.app/api/backend/webhooks/meta` par `https://api.messagingme.app/webhooks/meta`.
   ⚠️ C'est le geste le plus sensible du plan : entre les deux, des messages entrants peuvent être perdus. À
   faire à une heure creuse, et à vérifier tout de suite en s'envoyant un message.
3. L'adresse MCP : `https://api.messagingme.app/mcp`. Tu es le seul à l'avoir configurée.

Vérification : un message entrant réel arrive dans l'inbox, un lien tracé s'ouvre, un visuel RCS s'affiche.

### Étape 7 : retirer l'ancien montage

Retirer les rewrites devenus inutiles du `next.config.mjs`, arrêter le conteneur `mba-web`, et faire de
`mba.messagingme.app` une redirection vers `engageme.messagingme.app`. Le VPS ne fait plus tourner que l'API
et le worker.

## 6. Ce que ça donne le jour où tu passes à Scaleway

1. Tu montes l'API et le worker sur Scaleway (même image Docker, même `.env.prod`, même base Supabase).
2. Tu vérifies que la nouvelle machine répond, sur son adresse temporaire.
3. Tu changes **un enregistrement DNS** : `api.messagingme.app` pointe sur Scaleway.
4. Tu éteins le VPS OVH.

**Le front ne bouge pas. Le webhook Meta ne bouge pas. Les liens tracés ne bougent pas. Rien à redéployer.**

C'est exactement le bénéfice qu'on achète en faisant l'étape 2 maintenant, et c'est ce qui répond à ta
question.

## 7. Ce que je NE recommande pas, et pourquoi

- **Mettre le front sur `mba.messagingme.app` (ton schéma).** Ça obligerait Vercel à reproxifier les webhooks
  Meta vers le VPS : une fonction serverless sur le chemin des messages entrants de tes clients, pour aucun
  gain. Et ça t'empêcherait d'utiliser le nouveau nom, alors que c'est le bon moment pour le prendre.
- **Garder le proxy Next vers l'API** (l'option 2 de ma question). Ça évite le CORS, mais chaque appel de
  l'inbox consommerait une invocation Vercel et un aller-retour de plus. Tu as choisi l'appel direct, et c'est
  le bon choix : ton API a vocation à être publique de toute façon, pour les connecteurs et le MCP.
- **Déplacer la base.** Elle est chez Supabase, elle y reste, aucun rapport avec cette bascule.

## 8. Ce que ce plan ne dit pas encore

- **Le coût Vercel.** Le plan Hobby interdit l'usage commercial. Dès que la console sert un client payant, il
  faut passer en Pro (20 $/mois par membre). Tu as déjà tranché ce principe pour Supabase et pour le Gateway :
  on attend le premier client. Même règle ici, mais **il faut le savoir avant de mettre un client dessus**.
- **Le temps de coupure à l'étape 6.** Je ne l'ai pas mesuré. Il dépend surtout de la reconfiguration Meta.
- **Est-ce qu'on garde Cloudflare devant Vercel.** À décider à l'étape 5, sur ce qu'on observe.

---

## Journal d'exécution

**2026-09-03, étapes 1 à 4 faites. Rien de visible n'a changé pour les utilisateurs de `mba.`**

- **Étape 1** (`3b791d9`) : `APP_URL` scindée. `PUBLIC_API_URL` ajoutée, vide, donc sans effet.
- **Durcissements avant d'ouvrir** (`3e99437`, `f1e3776`), issus d'un audit des 235 routes : `scopeTenant`
  échoue fermé et le garde-fou du démarrage couvre les 36 modules ; le CORS existe, en liste blanche, sans
  credentials ; les limiteurs d'authentification sont bornés en nombre ET en taille de clé ; les refus sur
  `/ops` sont journalisés et alertés. Au passage, Fastify 5.10.0 vers 5.12.1 (deux vulnérabilités connues,
  dont une sur l'usurpation de `X-Forwarded`).
  🔴 **L'audit a corrigé la prémisse de ce plan** : le rewrite Next est un ATTRAPE-TOUT, donc l'API était
  DÉJÀ joignable depuis Internet, `/ops` compris. `api.messagingme.app` n'ouvre rien de neuf, il rend les
  adresses devinables. C'est ce qui a rendu ces durcissements urgents plutôt que confortables.
- **Étape 2** : `api.messagingme.app` ouvert dans NPM (proxy host 24, certificat 26), aligné sur `mba.`
  (HTTPS forcé, HSTS, HTTP/2). Toutes les routes publiques vérifiées sous le nouveau nom.
- **Étape 3** : `CORS_ORIGINS=https://engageme.messagingme.app` posé sur le VPS. Vérifié en production :
  l'origine inscrite reçoit ses en-têtes, une autre n'en reçoit aucun.
- **Étape 4** (`28cc4b8`) : le front lit `NEXT_PUBLIC_API_URL`, la page Développeurs dérive son adresse de la
  même source. Variable posée sur Vercel, redéployée.

**Preuve de bout en bout**, faite depuis la page réelle et non par un test :

```
fetch('https://api.messagingme.app/auth/config') depuis https://engageme.messagingme.app
-> 200, {"googleClientId":"...","googleEnabled":true}
```

**Le filet tient** : `mba.messagingme.app` sert toujours la console (200), l'API (200) et les liens tracés
(302). Deux consoles vivantes sur la même base, ce qui est l'état voulu.

⚠️ **`engageme.messagingme.app` n'est PAS un environnement de test** : même base, mêmes contacts, même numéro.
Une campagne lancée depuis là envoie de vrais messages.

🔴 **UN TROU DU PLAN, TROUVÉ EN PRODUCTION LE 2026-09-03.** Ce plan listait le webhook Meta comme le seul
tiers à reconfigurer. C'était faux : **tout tiers qui authentifie par le NAVIGATEUR tient sa propre liste
d'origines autorisées**, et une origine nouvelle y est inconnue. Découvert par un `origin_mismatch` de Google
à la première tentative de connexion depuis `engageme`.

La règle générale à retenir, elle vaut au-delà de cette bascule : **changer le nom du front casse tout tiers
qui vérifie l'ORIGINE, pas seulement ceux à qui on donne une URL.** Un webhook se reconfigure parce qu'on lui
a donné une adresse ; une liste d'origines se reconfigure parce que le tiers vérifie d'où vient l'appel. On
pense au premier, on oublie le second.

Les deux concernés, à ajouter SANS retirer l'ancienne origine (le filet doit tenir) :

| Tiers | Où | Quoi ajouter |
|---|---|---|
| Google Sign-In | Google Cloud, Identifiants, client OAuth 2.0 | `https://engageme.messagingme.app` dans « Origines JavaScript autorisées » |
| Meta Embedded Signup | developers.facebook.com, Connexion Facebook, Paramètres | `engageme.messagingme.app` dans « Domaines autorisés pour le SDK JavaScript » |

**HubSpot n'est PAS concerné**, vérifié : son lien d'installation se construit sur l'adresse du connecteur
(`HUBSPOT_CONNECTOR_PUBLIC_URL`), pas sur celle de la console.

⚠️ La connexion par e-mail et mot de passe, elle, ne passe par aucun tiers : elle fonctionne dès l'étape 4,
sans attendre aucune de ces deux reconfigurations.

**Reste l'étape 6**, à faire à un moment creux : `APP_URL` et `PUBLIC_API_URL` sur le VPS, puis l'URL du
webhook chez Meta, qui est le seul geste pendant lequel un message entrant peut se perdre.

### 2026-09-03, étape 6.1 et une étape 7 FAITE AUTREMENT, en mieux

**6.1** : `APP_URL=https://engageme.messagingme.app` et `PUBLIC_API_URL=https://api.messagingme.app` posées
sur le VPS. ⚠️ `APP_URL` n'était en fait posée NULLE PART : le code retombait sur son défaut codé en dur.
Les nouveaux liens tracés, visuels RCS et URL de webhook entrant portent désormais `api.messagingme.app`, et
les liens d'e-mail renvoient vers `engageme`.

🔴 **L'ÉTAPE 7 N'A PAS ÉTÉ FAITE COMME ÉCRITE, ET C'EST UNE AMÉLIORATION.** Le plan prévoyait de reconfigurer
l'URL du webhook chez Meta (étape 6.2), présentée comme « le seul geste vraiment sensible ». **Ce geste n'a
plus lieu d'être.**

`mba.messagingme.app` porte maintenant un routage par CHEMIN dans NPM :

| Chemin | Va vers | Effet |
|---|---|---|
| `/api/backend/*` | `mba-api`, préfixe RETIRÉ par nginx | le webhook Meta répond à son adresse ACTUELLE, pour toujours |
| `/r/`, `/m/`, `/mcp` | `mba-api` directement | les liens et visuels déjà envoyés continuent de résoudre |
| tout le reste | `mba-web` | **la console reste debout : le filet est intact** |

**Ce que ça achète, et qui dépasse la migration.** Jusqu'ici, le webhook de Meta traversait `mba-web` pour
atteindre l'API : **un conteneur de FRONT était sur le chemin critique de la réception des messages clients.**
Si le site tombait, plus aucun message entrant n'arrivait. Ce n'est plus le cas. C'est un gain de robustesse
qui aurait valu d'être fait même sans bascule.

Vérifié chemin par chemin sur les DEUX noms : console 200, `/api/backend/health` 200, webhook Meta 403 sur un
POST réel (donc la route travaille et refuse la signature), `/r/` 302 vers la bonne destination, `/m/` 200 en
`image/png` de 121 065 octets à l'identique, `/mcp` 401.

**Ce qui reste est facultatif** : un jour, éteindre `mba-web` et faire de `mba.messagingme.app/` une
redirection vers `engageme`. Rien ne presse, et le laisser tourner ne coûte presque rien.

