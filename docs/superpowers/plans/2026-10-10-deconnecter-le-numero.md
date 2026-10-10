# « Déconnecter le numéro » : détacher pour de vrai le numéro WhatsApp d'un espace

Décisions de Julien du 2026-10-10 (rondes de questions, pas de spec séparée : le geste réutilise des pièces existantes) :

1. **Détacher pour de vrai**, depuis un bouton « Déconnecter le numéro » placé à côté de « Renouveler la connexion Meta »
   (carte du numéro, Accueil, admin). Le numéro quitte l'espace : numéro, compte WhatsApp et jeton oubliés, l'espace
   peut ensuite en connecter un autre. Chez Meta : l'agent de Meta éteint, sa liste vidée, notre app désabonnée du
   compte WhatsApp. Le client garde son numéro chez Meta. « Délier » (Canaux et services) reste la coupure réversible.
2. **Les conversations sont purgées** : les fils entiers de l'espace, messages RCS compris (un fil réunit les deux
   canaux), avec leur analyse, par le même effacement que la purge par ancienneté. Contacts, campagnes passées,
   scénarios, agents et réglages restent.
3. **Un numéro fourni se déconnecte aussi** : il quitte l'espace tout de suite et il est perdu ; son abonnement
   s'arrête à la fin de la période payée, sans remboursement.

## Méthode de livraison

Implémenteur (moi, en direct) puis UNE relecture du diff par un relecteur indépendant, parce que le geste emprunte des
chemins de production et qu'il est irréversible : il efface des conversations, appelle Meta, Stripe et DIDWW, et retire
une ligne que l'envoi, la réception et les campagnes lisent. Les critères se vérifient par des tests (unitaires de la
route, intégration du dépôt en CI, e2e de l'écran), mais l'ordre des étapes porte des invariants invisibles (le jeton
doit être lu avant d'être effacé, le numéro fourni jugé « vu de Meta » avant que sa ligne parte). Aucune migration.

**L'essai réel qui clôt le geste** : sur un espace d'essai (jamais MessagingMeEmbdedded), Julien connecte un numéro,
échange un message, puis « Déconnecter le numéro » : la carte repasse en « Connecter », l'Inbox est vide, la fiche du
contact est là, et un AUTRE numéro se connecte ensuite sur le même espace. Contrôle en lecture seule : l'app n'est plus
abonnée au compte WhatsApp (`subscribed_apps`).

## Ce que le geste fait, dans cet ordre

0. Garde : admin, un numéro rattaché (sinon 404), corps `{ confirme: true }` (sinon 400), un verrou court par espace
   (un double clic ne joue pas deux fois), et l'objet Meta **partagé** avec un autre espace fait sauter les étapes chez
   Meta (la règle de la suppression d'espace, même requête, extraite pour être partagée, pas recopiée).
1. **La purge des conversations**, par lots de 500 (la purge par ancienneté borne ses passages pour la même raison). Un
   échec arrête tout : rien n'est encore détaché, le geste se rejoue.
2. **Chez Meta, au mieux** (chaque étape notée, aucune n'arrête la suite) : l'agent de Meta éteint, sa liste vidée,
   l'app désabonnée du compte WhatsApp. AVANT l'effacement : le jeton se lit dans `waba_credentials`, que l'étape 4
   emporte. Sautées sur un objet partagé ou un jeton global, comme à la suppression d'espace.
3. **Le numéro fourni** (s'il y en a un) : jugé « vu de Meta » AVANT que sa ligne parte, puis sorti comme à la
   suppression d'espace (jamais vu : rendu à la réserve et servi à l'abonné qui attend ; vu : résilié chez DIDWW, ou
   `bloque` avec la cause pour Julien). Puis la fin de son abonnement programmée à la fin de la période (le geste
   « Abandonner » existant). Ruling : la résiliation DIDWW part tout de suite et non 7 jours après comme annoncé à
   Julien, puisque le numéro est perdu de toute façon ; coût si faux : aucun pour le client, quelques jours de DIDWW
   en moins pour nous.
4. **Une transaction** : les campagnes de canal principal WhatsApp pas finies passent `failed` (elles ne pourront plus
   jamais partir de ce numéro ; une campagne RCS, repli WhatsApp compris, ne bouge pas : relecture du 2026-10-10) ; les
   conversations arrivées entre-temps purgées ; les webhooks bruts du numéro (`webhook_events`, ils portent le texte
   des messages) effacés ; les consentements des outils de l'agent de Meta pour ce numéro (`mba:<numéro>`) retirés ; le
   répondeur repassé de `mba` à `equipe` ; enfin le compte WhatsApp de l'espace supprimé, ce qui emporte le numéro et
   le jeton par les cascades. `credits_offerts` n'est PAS touché : le crédit offert reste « une fois par numéro ».
5. Les caches du process vidés (garde du numéro délié, jetons), la trace au journal des actions (`numero.deconnecte`,
   sans le numéro affiché : le journal ne se purge jamais), la réponse avec les étapes jouées.

## Tâches

1. **Le dépôt** `src/account/deconnexion-numero.pg.ts` : `bilan(tenantId)` (numéro, compte, numéro fourni, partagé,
   conversations à effacer, campagnes WhatsApp vivantes) et `detacher(tenantId)` (l'étape 4), `purgerConversations
   (tenantId, parLot)`. La requête « partagé » sort de `src/ops/suppression-espace.pg.ts` dans une fonction commune.
   Tests d'intégration (CI) : chaque effet de l'étape 4 ; ce qui reste (contacts, campagnes RCS, campagnes finies,
   crédit offert) ; un AUTRE espace intact ; puis `linkTenant` d'un autre numéro accepté sur l'espace détaché.
2. **La route** `POST /tenants/:tenantId/numero/deconnecter` et la lecture `GET /tenants/:tenantId/numero/deconnexion`
   (le bilan que montre la confirmation), dans `src/http/embedded-signup.ts` à côté de Délier/Relier, admin. Le
   déroulé est une fonction pure de ses gestes (comme la suppression d'espace). Tests : garde admin, 404, 400, verrou,
   ordre des étapes, échec chez Meta noté sans arrêter, échec de la purge qui arrête AVANT tout détachement, numéro
   fourni sorti puis fin programmée, objet partagé qui saute Meta. Auto-attaque lancée en local.
3. **L'écran** : « Déconnecter le numéro » à côté de « Renouveler la connexion Meta », une confirmation qui charge le
   bilan et dit ce qui part (conversations comptées, campagnes arrêtées, numéro fourni perdu) et exige de taper le
   numéro affiché. Après succès, la carte repasse en « Connecter ». e2e : le geste complet, le refus affiché, la
   saisie fausse qui laisse le bouton éteint, le numéro fourni annoncé perdu.
4. **La doc** : `features.md` et la fiche d'aide `connecter-mon-numero-whatsapp.md` (empreinte), `documentation.md`
   (un numéro détaché quitte l'espace, invariant de l'ordre), le message du second numéro (« déconnectez d'abord le
   numéro » devient vrai), `docs/prive/ESSAIS-REELS.md`, journal technique.

## Ordre de déploiement

Commit serveur (tâches 1, 2, 4 côté serveur) → CI lue job par job → `up` de l'API et des workers → commit console
(tâche 3) : l'écran appelle des routes neuves, il part après elles. Puis `aide:charger` (la fiche a changé) et les cinq
portes.
