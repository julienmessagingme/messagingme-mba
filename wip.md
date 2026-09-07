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

## Lot « lancer un scénario ferme le précédent » (2026-09-07, en cours de déploiement)

Règle de Julien : « on ne bloque personne sur un scénario, surtout quand on lance un nouveau scénario », et
son arbitrage du cas ambigu : quand un message est à la fois une réponse attendue et un déclencheur, **le
déclencheur gagne, toujours**.

**Le défaut vécu.** Un lien de chaîne cliqué pendant qu'un autre parcours attendait n'ouvrait jamais son
scénario : `hasWaitingRun` sautait le déclenchement, et la fenêtre de cette garde était de SEPT JOURS. Le
numéro serait resté muet jusqu'au 14 septembre. Diagnostiqué en base, pas supposé.

**Ce qui change.**
- la fermeture du parcours actif descend dans `runFrom`, passage commun des quatre chemins de démarrage
  (Inbox, jeton de test, automation, campagne et cible node). Elle vivait chez UN appelant sur quatre ;
- 🔴 elle est posée APRÈS les gardes et AVANT la persistance, et seulement si quelque chose remplace
  vraiment (`partis > 0` ou parcours persisté) : un démarrage refusé, ou un scénario d'actions seules qui
  n'envoie rien, ne doit pas tuer une conversation vivante sans rien mettre à la place ;
- 🔴 les automations passent AVANT l'avance dans le webhook et CONSOMMENT le message qui a démarré un
  scénario. Sans ça, l'ancien parcours avançait et envoyait son bloc suivant avant d'être tué : le client
  recevait deux messages, dont un venant d'un parcours abandonné ;
- `resume` écrit par `setStateSiVivant` : entre le claim du balayage et son écriture, un autre chemin peut
  avoir clos le parcours, et une écriture inconditionnelle le RESSUSCITAIT avec son échéance ;
- la session d'agent suit son parcours quand il est clos (elle restait `en_cours` jusqu'à la purge) ;
- `hasWaitingRun`, sa config et `endWaitingRun` (le doublon du jeton de test) disparaissent.

⚠️ **Migration 0115** : l'index qui sert la clause de `closeActiveByWaId`. Mesuré : AUCUN index existant ne
la servait, et elle passe d'un appel occasionnel à un par destinataire de campagne. `CONCURRENTLY`, donc
hors transaction. **Vérifier `indisvalid` après le déploiement** : `if not exists` saute un index invalide
au lieu de le réparer.

## Rien n'est en cours au 2026-09-07

Tout ce qui a été fait entre le 2026-09-02 et le 2026-09-07 est **livré, déployé et vérifié** : les sept lots
du plan post-audit, le renommage en Engage Me, la bascule du front sur Vercel, les huit constats du
contre-rapport, les quatre du contre-contre-rapport (migration 0113 comprise), l'audit de rayon de souffle
qui a suivi, puis l'audit sécurité du 2026-09-07 (plafond de débit des routes authentifiées, dépendances
`web/` remontées, script d'auto-attaque branché dans la CI). Où lire quoi :

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
