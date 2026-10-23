# Filière application : les jaunes (2026-10-23)

**But :** solder les jaunes de la filière application qui peuvent perdre un message, répondre au mauvais endroit ou
envoyer un faux signal. Sources : la relecture finale du lot 1 (registre du lot), celles des correctifs de l'essai et
de l'adressage masqué (`todo.md`, section du 2026-10-22).

## Tâches

**1. Un parcours gelé n'avale plus le message.** Après une prise de main, le parcours du répondeur reste en attente ;
l'avance, gelée faute que le fil soit à nous, rendait quand même « un parcours attendait » : la remise sautait, et la
demande de réouverture d'une conversation « Traité » ne s'ouvrait jamais. L'avance des parcours (une fonction exportée
de `src/webhooks/workflow-advance.ts`, que `avanceDesParcours` câble dans le worker pour les deux réceptions) rend
`false` quand le fil n'est pas à nous (`fil.peutAgir`), et la remise décide, avec ses gardes existantes.
- Tests : un parcours en attente sur un fil à nous rend `true` ; sur un fil tenu par l'équipe, l'avance est tentée et
  rend `false` ; sans parcours, `false` sans avance.

**2. Un espace sur les deux filières ne mélange plus les canaux.** Quand un numéro de Meta est relié (`filiereDe` rend
`api`), un message reçu par la session de l'application est ignoré et journalisé, au lieu d'avancer des parcours de
l'API ou de démarrer un répondeur.
- Test (`tests/application-entrant.test.ts`) : filière `api`, rien n'est enregistré, avancé ni remis.

**3. Un numéro de Meta délié ne bloque plus un espace passé à l'application.** La garde « numéro bloqué » (remise et
tour d'agent) consulte la filière quand le numéro de Meta est bloqué : sur la filière `application`, il ne bloque rien.
- Test : bloqué chez Meta et filière `application` rend `false` ; filière `api` rend `true` ; non bloqué ne lit pas la
  filière.

**4. L'adressage masqué, ses finitions** (`src/application/transport/etat-auth.ts`, `session.ts`) :
- `retenir` réécrit tant que les DEUX sens ne sont pas en mémoire (un contact connu avant le redémarrage avait son sens
  direct en mémoire par `numeroDe`, et l'inverse n'était jamais écrit) ;
- `lidDe` ne rend un identifiant que si les deux sens concordent (un compte qui a changé de numéro garde son
  identifiant, et l'ancienne ligne enverrait au nouveau titulaire) ;
- la clé de ligne de `lid-du-numero` est un HMAC-SHA256 du numéro sous la clé du compte, plus le numéro en clair ; une
  ancienne ligne en clair est effacée à la réécriture ;
- sans identifiant masqué propre (`creds.me.lid` absent), l'adresse reste le numéro : Baileys 6.7.23 lèverait sinon à
  tout envoi vers `@lid`.
- Tests (`tests/application-adresse-reponse.test.ts`) : les quatre cas, dont la ligne en clair absente après réécriture.

**5. Ce que la relecture du lot 1 avait reporté et qui perd ou trompe :**
- la mise en file d'un message reçu (`rappels.message`) est retentée trois fois avant d'abandonner (un pool de deux
  connexions pouvait refuser en rafale, et le message était perdu) ;
- un 401 pendant l'appairage n'envoie plus l'e-mail « appareil retiré » : seulement pour un compte qui avait été relié ;
- un e-mail de mise en sommeil en échec n'arrête plus le balayage des autres comptes ;
- le code mort de `src/application/transport/connexion.ts` (`surDeconnexion`, `estStatutTerminal`, `surOuverture`) et
  `estRelie` sortent, avec leurs tests.
- Tests : `tests/application-sessions.test.ts` (trois essais, le premier en échec ; pas d'e-mail sur un 401 d'appairage,
  un e-mail sur un 401 d'un compte relié), le balayage qui continue après un échec.

**6. `todo.md`** : les jaunes du lot 1 qui restent (suppression d'un espace sans retrait de l'appareil, compte banni
re-préparé, numéro déclaré jamais comparé au jid, prise de main perdue si elle échoue puis est rejouée, contact masqué
sans correspondance, `/envoyer` rejouable 60 s, empreinte d'état, textes avant la connexion Meta) et la limite de
Baileys sur les renvois de nos appareils secondaires ; les items soldés sortent.

## Ordre de déploiement

Le push (sans CI d'un pair en cours), la CI lue job par job, puis `up -d --build` de `mba-api` (la garde du numéro
bloqué y sert la remise), `mba-worker` et `mba-application` sur le même commit. Aucune migration.

## Méthode de livraison

**Implémenteur (moi), puis une relecture indépendante du diff en fin de lot**, parce que la tâche 1 change ce que
l'avance rend sur la réception de Meta comme sur celle de l'application, et que la tâche 3 touche une garde de
l'envoi : deux chemins que la production emprunte à chaque message.

**L'essai réel qui clôt le lot**, sur l'espace « newCompany » : deux messages depuis le mobile, l'agent répond aux deux
(la conversation rendue à l'agent d'abord, par `control_conversation`) ; une réponse depuis le téléphone du compte fait
se retirer l'agent ; Claude relit en base que la correspondance inverse est rangée sous sa clé HMAC et que l'ancienne
ligne en clair a disparu.
