# Accueil : le bloc « Canaux et services »

Cadré avec Julien le 2026-09-25 (deux tours de questions). Plan COURT : tâches, interfaces, tests attendus,
ordre de déploiement.

## La demande

Sur l'Accueil, un interrupteur par canal ou service, dans un bloc « Canaux et services » : une ligne par service,
avec son interrupteur, son état en une phrase et le lien vers son écran. Éteindre demande une confirmation qui
dit ce qui s'arrête ; rallumer ne demande rien.

| Service | Allumer | Éteindre |
|---|---|---|
| Numéro WhatsApp | la connexion actuelle, ou la reconnexion d'un clic si le numéro a déjà été relié | DÉLIE le numéro de l'espace, sans rien toucher chez Meta, l'historique reste |
| Canal RCS | l'activation actuelle (`RcsChannelCard`) | « Couper le canal RCS » actuel, devenu un interrupteur |
| Chaîne | ouvre l'onglet Chaîne pour saisir les identifiants ; branchée, l'Accueil montre son nom et le nombre de publications | DÉBRANCHE : oublie les identifiants, les liens et publications déjà parus restent |
| Compte publicitaire | ouvre la connexion de l'écran Publicités | la déconnexion actuelle (révoque l'accès chez Meta) |
| HubSpot | l'interrupteur `hubspot_actif` (commit a586d324) | idem, refusé tant qu'un portail est relié |

## Méthode de livraison

**Implémenteur unique, puis une relecture indépendante**, parce que « délier le numéro » touche un chemin que la
production emprunte (le webhook de chaque message entrant, les campagnes en cours) et n'est pas anodin à
défaire. Le reste réutilise des gestes qui existent déjà. L'essai réel est décrit plus bas.

## Tâches

1. **Délier le numéro** : migration 0180, un état « délié » sur le numéro de l'espace (une date, nullable), jamais
   une suppression : les jetons restent chiffrés pour la reconnexion d'un clic. Tant qu'il est délié : aucun envoi
   ne part (le point de passage des envois le refuse avec une raison lisible), les campagnes en cours ou
   programmées passent en pause avec la raison « numéro délié », et les messages entrants de ce numéro ne sont
   PAS enregistrés (le webhook les écarte, en le journalisant). Routes : délier et relier, admin seulement.
2. **Débrancher la chaîne** : une route qui oublie les identifiants de la chaîne ; les liens et leurs
   automations restent. L'Accueil lit le nom de la chaîne et le nombre de publications par ce qui existe déjà
   (`/channels-me/connection`, `/channels-me/posts`).
3. **Le bloc de l'Accueil** : cinq lignes, cinq interrupteurs, chacun branché sur le geste existant ou neuf
   ci-dessus ; la confirmation d'extinction dit les conséquences propres à chaque service ; tout est réservé aux
   admins ; chaque ligne tolère une API qui ne connaît pas encore son geste.
4. **Doc** : `features.md`, `documentation.md` (l'état délié et ses effets, la route de débranchement de la chaîne).

## Tests attendus

- Délier : aucun envoi ne part (campagne, message simple, API, scénario), les campagnes passent en pause, un
  entrant n'est pas enregistré, relier rétablit tout ; isolation entre espaces ; un non-admin est refusé.
- Débrancher la chaîne : les identifiants disparaissent, les liens restent.
- Le bloc : chaque interrupteur, chaque confirmation, la tolérance d'une API ancienne (e2e).
- Chaque test de non-régression vérifié dans les deux sens.

## Déploiement

1. Push du serveur, CI lue job par job, relecture unique.
2. Sur le VPS : `migrate` (0180) AVANT le `up` de l'API et du worker, relecture en base.
3. Push de la console APRÈS le déploiement de l'API.

## Essai réel qui clôt le chantier

Sur l'espace d'essai : délier le numéro (une campagne programmée passe en pause, un message envoyé depuis le
téléphone d'essai n'apparaît pas dans l'Inbox), le relier d'un clic (tout repart) ; couper et rallumer le RCS ;
brancher la chaîne et voir son nom et ses publications sur l'Accueil, puis la débrancher ; déconnecter et
reconnecter le compte publicitaire ; allumer HubSpot et voir le bouton de connexion.
