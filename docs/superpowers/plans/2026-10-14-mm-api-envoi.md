# Marketing Messages API : l'envoi (plan)

**Statut : validé par Julien le 2026-10-14** (trois choix, ci-dessous). Premier des deux lots qui rendent possibles
l'en-tête GIF et la durée de validité des modèles marketing, deux fonctions que seule la Marketing Messages API
(ex-MM Lite, « MM API ») accepte. Le second lot, l'éditeur de modèles, viendra après celui-ci.

**But :** quand l'interrupteur `META_MM_LITE` est allumé, tout modèle de catégorie marketing part par
`/marketing_messages` sur les trois chemins qui envoient un modèle : la campagne, le bloc de scénario, l'Inbox.
Tout le reste (utility, messages de service, agent, réponses libres) reste sur `/messages`, avec le même numéro.

## Ce que dit Meta (pages relues le 2026-10-14)

- `/marketing_messages` n'accepte QUE les modèles marketing. Tout autre type est refusé (134100).
- Un compte qui n'a pas signé les conditions de la MM API repasse par la Cloud API, sauf si l'envoi demande
  `product_policy: STRICT`. Le défaut est `CLOUD_API_FALLBACK`.
- Même schéma d'envoi, même modèle de facturation que la Cloud API. Les accusés d'un envoi par la MM API portent
  `pricing.category = marketing_lite`, et `pricing_analytics` rend la catégorie `MARKETING_LITE`.
- Un modèle créé il y a moins de 10 minutes est refusé (134101, synchronisation), et de même au premier envoi d'un
  modèle resté plus de 7 jours sans servir, pendant 10 minutes. Un modèle que la synchronisation n'a pas pu traiter
  est refusé en 134102, que Meta rend en HTTP 500.
- En Europe : ni optimisation de la livraison, ni mesure des clics et conversions. Restent la durée de validité,
  le GIF, les liens profonds Android, les comparaisons et recommandations par modèle.

## Les trois choix de Julien

1. **Éteint au déploiement, puis allumé** : le défaut de `META_MM_LITE` reste `false`, donc déployer ne change
   rien. L'allumage se fait par `META_MM_LITE=true` dans `.env.prod` et un `--force-recreate` de `mba-api` ET
   `mba-worker` (les deux construisent des clients d'envoi). Le retour arrière est la même variable.
2. **Tout le marketing vers la MM API**, sans lire le statut du compte : Meta repasse lui-même un compte non activé
   par la Cloud API. L'envoi pose `product_policy: CLOUD_API_FALLBACK` explicitement, pour qu'un changement de
   défaut chez Meta ne coupe pas les comptes non activés.
3. **Un refus de la MM API compte en échec**, comme toute erreur d'envoi (134100, 134101, 134102) : aucun repli de
   notre côté.

⚠️ **Le choix 3 a été pris sur « modèle créé il y a moins de 10 minutes », puis amendé par Julien le même jour.**
La doc de Meta étend 134101 au premier envoi d'un modèle resté 7 jours sans servir : une campagne sur un tel modèle
aurait perdu ses destinataires des 10 premières minutes, et se serait mise en pause après 20 échecs. **Décision :
134101 seul repart aussitôt par la Cloud API** (même modèle, même prix, Meta n'avait rien envoyé), dans
`MetaClient.sendMarketing`, donc pour les trois chemins ; 134100 et 134102 restent des échecs. Le modèle ne consomme
qu'une unité du quota du mois. Limite : un futur modèle GIF ne pourra pas se replier, la Cloud API refusant les GIF.

## Trouvé par la relecture, corrigé dans le lot

1. 🔴 **Un refus d'envoi pouvait invalider le jeton de tout un espace.** `isMetaAuthError` tenait le seul type
   `OAuthException` pour un jeton mort, or Meta le pose sur la plupart de ses refus d'envoi (100, 132000, quota, et
   probablement 134101). L'intercepteur de la fabrique invalidait alors le jeton d'un espace Embedded Signup, et
   coupait tous ses envois jusqu'à une reconnexion : c'est ce qui est arrivé à « Test DIDWA claude code » le
   2026-10-05. Désormais : code 190 ou HTTP 401, et `pullFromError` importe la même règle au lieu de la recopier.
2. 🔴 (dès l'allumage) **La campagne routait sur sa propre catégorie**, un choix de CONSENTEMENT coché
   « Marketing » par défaut dans l'assistant de la console, sans lien avec le modèle : une campagne de rappel de
   rendez-vous (modèle utility) laissée sur le défaut aurait été refusée en bloc (134100). Le moteur lit désormais la
   catégorie du modèle chez Meta une fois par run (`categorieDuModele`, par le cache `templateVarInfo` du worker), et
   route sur elle. La limite que ce plan « assumait » disparaît.
3. 134102 arrive en HTTP 500, que la règle des 5xx rejouait quatre fois : les trois refus de la MM API sont
   terminaux même en 5xx (`TERMINAUX_MEME_EN_5XX`).
4. Les libellés d'erreur de la console (`web/lib/meta-errors.ts`) affirmaient encore la cause non prouvée du 131042,
   et ignoraient 134100 à 134102 ; quatre commentaires disaient que la catégorie de l'Inbox « ne sert qu'aux
   statistiques » ou que `OAuthException` invalide un jeton.

## Tâches

1. **Client Meta** (`src/meta/client.ts`, `src/config.ts`) : `sendMarketing` vers `/marketing_messages` quand
   l'interrupteur est allumé, avec `product_policy: CLOUD_API_FALLBACK` ; vers `/messages` sinon, sans ce champ.
   Les commentaires cessent d'affirmer que « sans onboarding, Meta rend 131042 » : la cause n'est pas prouvée
   (`brain/LEARNINGS.md`, entrée du 2026-07-08 révisée).
   Tests : adresse et corps dans les deux états ; `sendTemplate` reste sur `/messages` dans les deux états.
2. **Bloc de scénario** (`src/workflow/envois-bloc.ts`) : ses deux branches envoient par `sendMarketing` quand la
   catégorie lue chez Meta est `marketing`, par `sendTemplate` sinon (catégorie absente comprise). Le destinataire
   passe par `messagingTarget`, comme dans le moteur de campagne. `ClientDesEnvois` gagne `sendMarketing`.
   Tests : marketing par `sendMarketing` (même destinataire, même modèle, mêmes composants), utility et inconnue
   par `sendTemplate`, dans les deux branches.
3. **Inbox** (`src/http/inbox.ts`, `src/inbox/envoi-modele.ts`) : la catégorie déclarée par l'écran, déjà
   normalisée par la route, voyage jusqu'à l'envoi ; marketing par `sendMarketing`, le reste par `sendTemplate`.
   Aucune nouvelle lecture chez Meta : une catégorie fausse ne fait pas pire que le cas de la limite ci-dessus.
   Tests : idem.
4. **Coûts** (`src/meta/pricing.ts`) : `parsePricing` compte `MARKETING_LITE` dans `marketing` (même prix chez
   Meta), sinon les écrans de coût d'un compte activé n'auraient plus de tarif marketing.
   Test : volumes et coûts additionnés, tarif par message recalculé sur le total.
5. **Documentation** : `documentation.md` dit l'interrupteur, le routage, le repli de Meta et la limite.

**Interfaces qui changent :** `ClientDesEnvois` et `DepsEnvoiModeleInbox.client` exposent `sendMarketing` ;
`OutboundTemplate` porte la catégorie ; `EngineDeps` gagne `categorieDuModele` (donc `CapacitesMoteur`). La fabrique
rend déjà un `MetaClient` complet, dont `sendMarketing` passe par les mêmes gardes que `sendTemplate` (quota de
modèles, liste de l'agent, numéro délié ou suspendu, frein de débit). **Deux fichiers de câblage partagé** sont
touchés, après la relecture : `src/worker.ts` (la capacité, dans le bloc gardé par `satisfies`) et `src/index.ts`
(deux commentaires). Le commit se construit en plomberie, sur `origin`.

## Ordre de déploiement

Un seul commit, aucune migration, aucun écran. L'API se déploie comme d'habitude ; tant que `META_MM_LITE` vaut
`false`, rien ne change en production. L'allumage est un geste à part, après le déploiement.

## Méthode de livraison

**Implémenteur par lot, avec relecture du diff**, parce que le lot touche les trois chemins d'envoi de modèles que
la production emprunte, et un montant affiché (les coûts). Les critères se testent en unitaire, mais le repli de
Meta sur un compte non activé ne se prouve qu'en vrai : c'est lui que l'incident du 8 juillet a mis en doute. Une
relecture indépendante en fin de lot, puis le diff relu par Julien avant l'allumage. Interrupteur éteint, le
déploiement ne change qu'une chose : un refus d'envoi n'invalide plus le jeton d'un espace (correctif 1 de la
relecture). Le reste part par `/messages` comme avant, `sendMarketing` et `sendTemplate` y envoyant le même corps.

**Essai réel qui clôt le lot**, interrupteur allumé :
1. Un espace de test ACTIVÉ (conditions de la MM API signées par Julien) envoie un modèle marketing par une
   campagne, par un bloc de scénario et depuis l'Inbox : chaque message arrive sur un vrai téléphone, et son accusé
   porte `marketing_lite` dans `tarifs_meta`.
2. Un espace de test NON activé (`ELIGIBLE`) envoie une campagne marketing : le message arrive, et son accusé porte
   `marketing`. C'est la preuve du repli de Meta, et la réponse à l'incident du 8 juillet.
3. Un modèle utility envoyé par un scénario garde `utility`.
4. Une campagne de la console sur un modèle utility, laissée sur « Marketing » (le défaut) : elle part, et ses
   accusés portent `utility` (route sur la catégorie de Meta, pas sur celle de la campagne).
5. La carte des coûts de l'espace activé affiche un tarif marketing.
