# Les dépôts publics passent du compte personnel à l'organisation `messagingme` (2026-10-30)

**But** : plus aucune adresse publique en `github.com/julienmessagingme/...`. Les trois dépôts que voient les
intégrateurs (`messagingme-mba`, `messagingme-plugin`, `messagingme-sdk`) passent à l'organisation `messagingme`,
sous le même nom. Le compte `julienmessagingme` reste le propriétaire de l'organisation et l'auteur des commits.

**Hors périmètre** : les dépôts privés (`leadgen`, `odalys`, `repomain`, `messagingme-pilot`...), que personne ne voit ;
le nom technique `messagingme-mba` (même nom que l'identifiant du serveur MCP, décision du `CLAUDE.md`) ; le journal,
les plans et les specs datés, qui racontent le passé et gardent l'adresse d'alors.

## Ce que dit GitHub d'un transfert (documentation lue le 2026-10-30)

- Partent avec le dépôt : tickets, PR, étoiles, webhooks, **secrets** et **clés de déploiement**.
- Les anciennes adresses **redirigent** (web, `git clone`, `fetch`, `push`). La redirection ne tombe que si un dépôt
  du même nom est recréé à l'ancienne adresse ; au-delà de 100 clones la semaine précédente, GitHub retire même
  définitivement l'ancien couple propriétaire/nom.
- **La documentation ne dit rien** des environnements (dont `scaleway` et son relecteur), des variables d'Actions,
  des installations d'applications GitHub (Vercel) ni des statistiques de trafic : tout ça se **relit** après le
  transfert, rien ne se suppose.

## Tâches, dans l'ordre

1. **Relevé avant** (moi, lecture seule) : clones des 14 derniers jours des trois dépôts (`traffic/clones`, la mesure
   de la pub Meta), environnements et leurs règles, noms des secrets, clés de déploiement. C'est la référence de
   l'étape 4.
2. **Créer l'organisation** (Julien, dans GitHub) : `messagingme`, offre gratuite, Julien propriétaire. Installer
   l'application GitHub de Vercel sur l'organisation, avec accès à `messagingme-mba`.
3. **Transférer** (Julien, Settings du dépôt, Transfer) : `messagingme-sdk`, puis `messagingme-plugin`, puis
   `messagingme-mba`, sous le même nom. Le dépôt principal en dernier, parce que c'est lui qui déploie.
4. **Relire après chaque transfert** (moi) : l'ancienne adresse répond (`git ls-remote`), les secrets et les clés de
   déploiement sont là, et pour `messagingme-mba` l'environnement `scaleway` garde Julien comme seul relecteur et
   la branche `main` seule. ⚠️ Un workflow qui nomme un environnement absent le RECRÉE sans protection : si
   `scaleway` manque, on le refait avant tout déploiement. Les deux projets Vercel (`messagingme-mba`,
   `engageme-site`) pointent vers `messagingme/messagingme-mba` ; sinon on les rebranche.
5. **Un commit qui remplace l'adresse** (moi) dans tout ce qui est vivant : `site/` (pages, `llms.txt`,
   `vercel.json`), `web/` (docs publiques, `exemples-code.ts`, `demarrer.ts`, pages Développeurs), `plugin/`, `sdk/`,
   `scripts/` (`plugin/generer.ts`, `vitrine/aide.ts`, `banc-api.sh`), les deux workflows de publication, les tests
   qui l'affirment, `documentation.md`, `features.md`, `DEPLOY.md`, `todo.md`. Puis les générateurs, dans le même
   commit : `npm run vitrine:anglais`, `vitrine:aide`, `plugin:generer`. Fiches d'aide publiques touchées : empreinte
   dans le même commit. Avant de pousser : suite racine entière, suite `web/`, `typecheck`, `auto-attaque`.
6. **Remote local** : `git remote set-url origin` vers la nouvelle adresse, annoncé aux sessions voisines (la
   configuration git est partagée par l'arbre). La redirection rend ce pas sans urgence.
7. **Republier** : `plugin.json` monte d'une version, puis `plugin.yml` (après avoir vérifié que la tête de `main`
   n'emporte rien de non déployé) ; même chose pour le SDK par `sdk.yml`, pour que son `package.json` publié porte
   la nouvelle adresse.
8. **Doc transversale** : `brain/INFRA.md`, section « Identité GitHub », nomme l'organisation.

## Méthode de livraison

**En direct**, sans agent, parce que le changement est réversible (un dépôt se retransfère, les anciennes adresses
redirigent pendant toute l'opération) et que ses critères se vérifient mécaniquement : les tests de la vitrine et du
plugin affirment déjà l'adresse, et un `grep julienmessagingme` sur les fichiers vivants doit rendre zéro. Le seul
chemin de production touché est la chaîne de déploiement (Vercel, environnement `scaleway`), et l'étape 4 la relit
avant tout push de code.

**Essai réel qui clôt** : dans un vrai Claude Code, sur un dossier vierge, `/plugin marketplace add
messagingme/messagingme-plugin` puis l'installation du plugin, ET l'ancienne commande `julienmessagingme/...` qui
doit encore marcher (c'est elle qu'ont les développeurs déjà installés) ; `npm install
github:messagingme/messagingme-sdk#v<version>` dans un projet vide ; enfin le push de l'étape 5 qui redéploie bien la
console et la vitrine chez Vercel.

## Rayon de souffle

- Les développeurs qui ont déjà ajouté la marketplace gardent l'ancienne adresse dans leur configuration : la
  redirection les sert, c'est pour ça qu'on ne recrée JAMAIS de dépôt sous l'ancien nom.
- Les `package-lock.json` des intégrateurs citent `github:julienmessagingme/messagingme-sdk` : même redirection.
- L'Ignored Build Step de la vitrine va chercher un commit sur l'adresse publique : il suit la redirection, puis
  l'étape 5 le remet à jour.
- Les statistiques de clones peuvent repartir de zéro : le relevé de l'étape 1 garde la mesure de la pub.
