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

## 🔴 LE VPS EST SUR UN COMMIT DÉTACHÉ, EN RETARD SUR `main` (2026-09-07, 17 h)

**À lire avant tout déploiement de l'API.** `/home/ubuntu/mba` est sur **`97a67fe`**, pas sur `main`
(`git status` y annonce « HEAD detached »). Un `git pull` n'y fera RIEN d'utile : il faudra
`git checkout main && git pull` une fois que `main` sera verte.

**Pourquoi.** `main` est **ROUGE en CI** depuis `c24ae0e` (lot analytics « les erreurs se filtrent par
campagne et ouvrent les contacts touchés ») : `tests/integration/stores.integration.test.ts:977` échoue, et
ce qu'il dit est précis : **une ligne enregistrée en 131026 ressort quand on demande 131049**, donc
`journal.lister` n'applique pas son filtre par code. Le test est formulé sur SON destinataire plutôt que sur
le vide, justement parce que le tenant est partagé entre les cas.

⚠️ **Ce défaut ne se voit QUE dans le job `integration`** : `npm test` en local reste vert, comme toujours.

Il fallait déployer le plafond de débit sans embarquer ce lot. `97a67fe` est le dernier commit vert et il
porte tout le travail de sécurité du jour. Le lot analytics reste donc DEHORS de la production, c'est
volontaire, et le plafond de débit est actif en production depuis ce déploiement.

**Ce qu'il reste à faire, dans cet ordre :** corriger le filtre par code, voir la CI verte sur `main`, puis
`cd /home/ubuntu/mba && git checkout main && git pull && sudo docker compose up -d --build`.

⚠️ Ce déploiement-ci n'a eu AUCUNE migration à jouer (base à 0114, dépôt à 0114, vérifié des deux côtés). Ce
ne sera pas forcément vrai au prochain : la question se repose à chaque fois.

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
