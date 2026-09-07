# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique et ses gotchas dans [documentation.md](documentation.md) (section
> « Journal des lots livrés »), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA TROISIÈME FOIS le 2026-09-04**, et c'est le chiffre qui compte. Il l'avait déjà été le
> 2026-08-29 (1341 lignes, il remontait à juillet) et le 2026-08-31. Il était remonté à 230 lignes et douze
> sections, toutes marquées « LIVRÉ ET DÉPLOYÉ ». Trois fois, c'est que le problème n'est pas la négligence :
> **un lot terminé n'a aucune raison d'attendre ici**, il a une place ailleurs le jour même. Avant de retirer
> quoi que ce soit, chaque section a été vérifiée présente dans `documentation.md`, `todo.md` ou son plan
> dédié dans `docs/`.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vérifié en 2026-08-31 : la moitié de ce que
> le lot du 29 affirmait était déjà périmée deux jours plus tard.
>
> **Au-delà de cent lignes, ce fichier a recommencé à être une archive.**

## Déploiement du 2026-09-07 : TERMINÉ, le VPS est de nouveau sur `main`

Plus rien à faire côté déploiement. `/home/ubuntu/mba` est sur **`main`** (`f3d514d`), les trois conteneurs
sont reconstruits, l'API et le worker tournent le code de `main`. Le plafond de débit des routes
authentifiées est ACTIF en production.

**Vérifié** : appel interne 200, appels publics 200 sur `api.` et sur `mba./api/backend/`, webhook Meta 403
sur un POST non signé, origine CORS hostile refusée, route authentifiée 401 sans jeton, aucune erreur dans
les journaux. La preuve que le nouveau code tourne n'est pas ce silence mais l'en-tête
`access-control-expose-headers: retry-after, x-ratelimit-*`, qui n'existe que depuis `661e2ba`.

🔴 **LE 502 EST ARRIVÉ POUR DE VRAI, et le CLAUDE.md l'avait écrit mot pour mot.** Après le second
`up --build`, l'API répondait 200 en INTERNE et 502 en PUBLIC : NPM tenait l'ancienne IP du conteneur, qui
change à chaque recréation, parce que nginx résout son amont au CHARGEMENT de sa config. Le diagnostic en
deux appels (interne puis public) isole la couche coupable d'un coup, et le remède est
`sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`. ⚠️ Il n'était PAS apparu au premier
déploiement du jour : ce défaut est intermittent, donc **le contrôle public est obligatoire après CHAQUE
`up --build`**, pas seulement quand on se méfie.

⚠️ **Et le contrôle public se fait sur le BON chemin.** `mba.messagingme.app/webhooks/meta` rend 404 : le
routage par chemin de NPM l'envoie à `mba-web`. Le webhook Meta vit sous `/api/backend/webhooks/meta` (et
sur `api.messagingme.app/webhooks/meta`). Un 404 sur le mauvais chemin ressemble à une panne du chemin
critique des messages clients, et n'en est pas une.

⚠️ Aucune migration n'était à jouer (base 0114, dépôt 0114, vérifié des deux côtés). La question se repose à
chaque déploiement.

**Sur la rougeur de CI du jour, et mon erreur de diagnostic** : j'avais écrit ici que `journal.lister`
n'appliquait pas son filtre par code. C'était FAUX, le TEST avait tort et pas le code (`f470f47`). Deux
pièges à ne pas refaire : j'ai lu le fichier de test dans mon arbre de travail alors que la session
parallèle l'avait DÉJÀ corrigé, et j'en ai quand même conclu à un défaut produit. **Un échec de CI se lit
sur le commit qui a échoué (`git show`), jamais sur un arbre que quelqu'un d'autre modifie.** Et une
assertion « la liste est vide » dans un fichier à tenant partagé dépend de tout ce qui s'exécute avant elle.

## Rien n'est en cours au 2026-09-04

Tout ce qui a été fait entre le 2026-09-02 et le 2026-09-04 est **livré, déployé et vérifié** : les sept lots
du plan post-audit, le renommage en Engage Me, la bascule du front sur Vercel, les huit constats du
contre-rapport, les quatre du contre-contre-rapport (migration 0113 comprise), et l'audit de rayon de souffle
qui a suivi. Où lire quoi :

| Ce que tu cherches | Où c'est |
|---|---|
| le tri de chaque constat externe, et ce qui reste ouvert | [todo.md](todo.md) |
| les gotchas et le pourquoi de chaque lot | [documentation.md](documentation.md) § Journal des lots livrés |
| le détail migration par migration | [documentation.md](documentation.md) § Les migrations, une par une |
| le journal d'exécution de la bascule Vercel | [docs/PLAN-BASCULE-VERCEL-2026-09-03.md](docs/PLAN-BASCULE-VERCEL-2026-09-03.md) |
| les rapports envoyés en contradiction externe | `docs/RAPPORT-*.md` |

## Ce qui attend une action de Julien

- ⚠️ **Ajouter `engageme.messagingme.app` aux domaines autorisés de l'app Meta** (Connexion Facebook, « Valid
  OAuth Redirect URIs » ET « Allowed Domains for the JavaScript SDK », au format complet avec la barre
  finale). Ça ne bloque QUE l'écran qui connecte un NOUVEAU numéro WhatsApp, donc rien d'urgent. Google est
  déjà fait.
- **Facultatif : éteindre `mba-web`** et faire de `mba.messagingme.app/` une redirection vers `engageme`.
  Rien ne presse : le laisser tourner ne coûte presque rien et garde une porte de sortie.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3 à L7** (relecture des vraies conversations, MCP délégué, et la suite). Le cadrage
est écrit, rien n'est commencé. Détail dans [todo.md](todo.md).
