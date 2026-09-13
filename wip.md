# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> 🔴 **VIDÉ POUR LA CINQUIÈME FOIS le 2026-09-13 au soir**, et le chiffre est le sujet. Il avait atteint
> 245 lignes en portant SIX chantiers déjà déployés, c'est-à-dire en redevenant une archive. La règle n'est
> pas « y penser », c'est : **un lot déployé n'a aucune raison d'attendre ici**.
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.**

## 🔴 L'ÉTAT EXACT, AU 2026-09-13 AU SOIR

| | |
|---|---|
| `origin/main` | `8c22d96` |
| VPS (`mba-api`, `mba-worker`, `mba-web`) | `8c22d96`, déployé et vérifié en public |
| Dernière CI de CODE (`19367d2`) | ✅ verte, quatre jobs |
| Vercel (`engageme`) | suit `origin/main` tout seul, à chaque push |
| Migrations | **0139, 0140 et 0141 appliquées** dans la nuit du 2026-09-13, vérifiées en base. **Prochaine libre : 0142** |

⚠️ **LE 502 PUBLIC EST SYSTÉMATIQUE, PLUS INTERMITTENT.** Neuf déploiements le 2026-09-13, neuf fois le
même : conteneurs `healthy`, appel interne à 200, appel public à 502. Réparation :
`sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload`.

🔴 **ET UN SEUL RELOAD NE SUFFIT PAS TOUJOURS** (vu DEUX fois le 2026-09-13, dont le déploiement de la
tâche 7) : le contrôle public juste après rendait encore 502, le second reload l'a réglé. Le reload rend `0`
dans les deux cas, donc il ne dit rien. La séquence est : contrôler, réparer, **RE-CONTRÔLER**, recommencer
si besoin.

## 🔴 CE QUI EST EN COURS : chantier 6, le centre de Sécurité & compliance

[spec](docs/superpowers/specs/2026-09-13-centre-securite-design.md) ·
[plan](docs/superpowers/plans/2026-09-13-centre-securite.md)

**Tâches 1 à 8 livrées, relues et déployées** (`8c22d96`). Le menu, la page d'accueil, l'écran Consentement,
le blocage réel de l'opt-out sur tous les chemins automatiques, la règle élargie en observation, la poussée
du refus vers le système du client, et le sous-menu IA.

**Reste une tâche :**

1. **Tâche 9, la moitié SYSTÈME du journal des erreurs.** La moitié client existe et a déménagé. Inventorier
   d'abord ce qui est DÉJÀ journalisé (DLQ, `/ops`, alertes Telegram, `workflow_advance_failures`) : la
   question n'est pas « que journaliser » mais « qu'est-ce qui est écrit quelque part et que personne ne
   montre au client ».

## 🔴 CE QUI N'A JAMAIS TOURNÉ SUR DE VRAIES DONNÉES

C'est le seul vrai risque du moment : quatre chantiers sont déployés et verts sans qu'aucun n'ait été
exercé par un humain sur un vrai téléphone.

- **L'opt-out** : écrire « stop » depuis un vrai téléphone, constater le passage en opt-out, **puis tenter
  d'atteindre ce contact par un scénario ET par une automation**. Puis l'essai inverse, celui qui protège
  l'usage : un opérateur doit encore pouvoir lui répondre à la main.
- **Le récap d'hier** : ouvrir le bot avec un compte admin, cliquer, et **RECOMPTER À LA MAIN** les
  conversations de la veille. Puis rouvrir en `agent` et vérifier que le bouton n'est pas là.
- **La chaîne de repli** : aucune n'a jamais basculé. Zéro campagne à deux étages, zéro joignabilité mesurée.
  Une campagne à deux étages sur le numéro de Julien, avec un destinataire volontairement injoignable.
- **La traduction** : aucun message étranger n'a jamais été traduit. Un message espagnol reçu, lu en
  français, puis une réponse traduite, avec le contrôle EN BASE que `body` porte ce qui est PARTI et
  `redaction_origine` ce que l'opérateur a écrit.
- **Créer un scénario depuis une campagne** : le publier, vérifier qu'il apparaît dans l'onglet Scénario, et
  lancer la campagne sur un vrai numéro.
- **La politique d'annonce d'IA** (tâche 8, déployée) : ouvrir Sécurité > IA, passer l'espace à
  « à chaque message », écrire à l'agent depuis un vrai téléphone et **constater la phrase à chaque réponse**.
  Puis repasser à « une fois par conversation » et vérifier qu'elle ne part qu'au premier tour. ⚠️ Ce chemin
  n'a jamais tourné : le réglage existait depuis le 2026-09-09 sans qu'aucun essai réel ne l'ait exercé.
- **La poussée d'un opt-out vers un système tiers** (tâche 7, déployée) : déclarer un appel dans
  Tools > Connecteurs API vers un point de réception qu'on peut observer, le brancher depuis
  Sécurité > Consentement, écrire « stop » depuis un vrai téléphone, et **constater l'appel arrivé avec le
  bon numéro**. Puis l'essai qui compte autant : **débrancher le connecteur, ou le casser, et vérifier que
  l'opt-out est quand même posé**. C'est la promesse du lot, et elle ne vaut que mesurée.

⚠️ **UN POINT À REGARDER au premier essai d'un étage RCS avec scénario** : le contact reçoit le message de
l'étage **puis** le premier message du scénario, puisque les scénarios proposés là ouvrent par un envoi.
C'est la lecture littérale de « message plus scénario », mais ça se juge à l'usage.

## 🔴 UN ARBITRAGE EN ATTENTE : « arrêt maladie » désabonne aujourd'hui

Mesuré le 2026-09-13 **sur la règle qui agit déjà en production** :

```
"arrêt maladie" -> true   "arrêt du traitement" -> true
"arrêt de bus"  -> true   "stop covid" -> true   "stopper la commande" -> true
```

Le docblock d'`estDemandeArret` citait pourtant « arrêt de bus » comme un cas **évité** par l'ancrage : c'est
faux, la phrase COMMENCE par « arrêt ». **Gan Prévoyance est un assureur, en production** : « arrêt maladie »
y est un message ordinaire, et la personne cesserait de recevoir sans que personne ne le sache.

⚠️ **La règle n'a PAS été modifiée** : resserrer l'ancrage ferait perdre « stop merci », qui est un vrai
refus. C'est un choix produit. Le docblock faux est corrigé, et `tests/consentement-observation.test.ts` fige
le comportement ACTUEL en NOMMANT chaque cas, pour que celui qui le changera voie la liste de ce qu'il change.

## Ce que la session du 2026-09-13 a appris

🔴 **`abort()` n'annule pas ce que le SERVEUR a déjà lancé.** Un rafraîchissement toutes les 4 s, une
traduction qui s'accorde 20 s : chaque tour fermait la connexion du navigateur, jamais l'appel au modèle,
déjà parti et déjà facturé. Mesuré par mutation : quatre traductions payées en treize secondes. **Dès qu'un
rafraîchissement périodique déclenche un traitement plus long que sa période, le tour suivant PASSE SON
TOUR, il n'annule pas.** (Aussi dans `brain/LEARNINGS.md`.)

🔴 **UNE LISTE ÉCRITE À LA MAIN DÉRIVE, MÊME QUAND ELLE EST LE GARDE-FOU.** L'inventaire des chemins d'envoi
citait six méthodes quand le client Meta en expose HUIT ; il passait quand même, parce que les fichiers
concernés en appelaient d'autres par ailleurs. **Une liste qui définit un périmètre de sécurité se DÉRIVE du
code qui la définit** (ici `src/meta/client.ts`), sinon elle protège de ce qu'on avait en tête le jour où on
l'a écrite.

🔴 **UN INVARIANT ÉNONCÉ DANS UNE MIGRATION SE TIENT PARTOUT OU NULLE PART.** La migration 0138 écrit
« la date se remet à null au réabonnement » ; je ne la tenais que sur trois chemins d'écriture sur quatre,
le quatrième étant un upsert qui fait régresser un statut sans qu'on y pense. **Écrire un invariant, c'est
énumérer ses écritures, pas celles auxquelles on pense.**

🔴 **UN TEST QUI DÉSIGNE UNE PAGE (un `goto`) NE NOMME AUCUN SYMBOLE.** En déplaçant deux écrans, aucun
`grep` sur le composant ni sur son `data-testid` ne trouvait l'e2e qui les rejoignait par `/parametres` :
il n'a rougi qu'en CI. Même famille que le test qui désigne par LIBELLÉ. **Quand on DÉPLACE un écran, les
dépendants ne se lisent pas dans les imports, ils se lisent dans les `goto`.**

🔴 **UN `not.toHaveBeenCalled()` PASSE AUSSI QUAND RIEN NE SE PRODUIT.** Un test de garde écrivait `{ text }`
là où un bloc lit `body` : il ne produisait aucune action, et il validait donc du code sans garde. **Tout
test de blocage porte son TÉMOIN dans l'autre sens**, sinon il ne prouve que sa propre maladresse.

⚠️ **« Par cohérence » n'est pas une raison de transporter une donnée.** Les variables du rang 1 partaient
avec le scénario d'un étage de repli, parce que la branche voisine le faisait. Elles décrivent un autre
modèle : Meta refuse, ou remplit le bon nombre de trous avec les mauvaises valeurs.

🔴 **DEUX MIGRATIONS POUSSÉES ENSEMBLE NE S'APPLIQUENT PAS ENSEMBLE.** 0140 ajoute et reprend (avant le
déploiement), 0141 retire (après). Mais les migrations vivent DANS L'IMAGE et `migrate` applique TOUT ce
qu'il y trouve : un `build` puis un `migrate` les aurait passées d'un coup, et la colonne serait tombée
pendant que l'ancien code la lisait encore. **La parade est de mettre la migration différée DE CÔTÉ sur le
VPS avant le build**, de la remettre après le déploiement, et de reconstruire l'image pour elle seule.

🔴 **UN CHAMP QUI DÉMÉNAGE SE REFUSE, IL NE S'AVALE PAS.** `z.object()` retire une clé inconnue EN SILENCE :
un onglet resté ouvert sur l'ancienne console aurait continué d'envoyer le réglage sur le PATCH d'agent,
aurait reçu 200, et le choix du client aurait été perdu sans un mot. La route rend 400 en DISANT où il est
parti. **Un déménagement se garde des deux côtés : l'écran renvoie, et l'API refuse.**

🔴 **UN NOMBRE ÉCRIT À LA MAIN DANS UN COMMENTAIRE EST FAUX AVANT D'ÊTRE LU.** Trois exemplaires trouvés en
une soirée : « DEUX appelants » de `creerAppelConnecteur` quand il y en avait trois, « 9 clés » dans une
fixture qui en listait huit (l'ajout de ce lot l'a rendue vraie PAR ACCIDENT), et le compte de files. La
parade n'est pas de les corriger, c'est de **ne pas les écrire** : on nomme la source, on ne la recopie pas.

🔴 **UNE JUSTIFICATION FAUSSE SE RECOPIE, ET C'EST COMME ÇA QU'ELLE SE PROPAGE.** Le docblock de
`registerSettings` annonçait « GET ouvert (lecture), PUT admin-only » ; le module entier est monté avec
`requireAdmin` depuis longtemps. J'ai repris la phrase telle quelle dans une route neuve, en toute confiance,
et seul le TEST l'a montrée. **Un docblock voisin n'est pas une source, c'est un témoignage.**

⚠️ **`reuseExistingServer` DE PLAYWRIGHT PEUT FAIRE MENTIR UNE MUTATION.** Le serveur laissé vivant par le
tour précédent est réutilisé, donc on teste le build d'AVANT : après avoir restauré le code muté, le test
est resté rouge, et il a fallu relancer pour le voir vert. Dans l'autre sens, une mutation passerait pour
« non attrapée ». Sur un e2e, **la mutation se juge sur un serveur neuf**.

⚠️ **Le hook de rayon de souffle trouve ce que la revue manque**, et l'inverse est vrai aussi : la revue de
ce soir a trouvé deux défauts réels qu'aucun test ne voyait, et le hook a attrapé un commentaire devenu faux
qu'elle n'avait pas relevé. Les deux, à chaque fois.

## Ce qui attend une action de Julien

- 🔴 **Copier `ENCRYPTION_KEY` dans le coffre**, hors de toute infrastructure. Elle n'existe QUE dans
  `.env.prod` sur le VPS : si la machine disparaît, la base survit mais ses 8 secrets chiffrés deviennent
  illisibles pour toujours. Deux minutes, et c'est le seul point du plan RSSI sans code ni budget.
- 🔴 **Activer les deux outils de l'agent « Conseiller IA Gan Prevoyance »** (`mba_chercher_connaissance`,
  `mba_escalader_humain`), INACTIFS en base. C'est la cause de l'essai raté du 2026-09-08. Secteur régulé :
  la décision ne se prend pas sans lui.
- **Relire la phrase de passage de main du MBA** : celle en place a été posée pendant les essais, sans
  accents ni mots de la marque. C'est ce que LIT le client au moment du transfert.
- **Poser une photo de profil sur le numéro WhatsApp** : la pastille de l'Accueil n'affiche rien sans elle,
  et aucun des deux numéros du parc n'en a.
- **L'arbitrage « arrêt maladie »** ci-dessus.
- Le détail des décisions produit en attente (coût du MBA, allowlist, lancer un autre scénario depuis un
  agent) vit dans [todo.md](todo.md).

## Ce que le bot d'aide ne sait pas encore

Les fiches (`docs/aide/fiches/`) ne parlent ni du bilan d'un contact, ni du choix des blocs, ni du réglage de
silence, ni du funnel sans accusé, ni de la création d'un champ à la volée, **ni du centre de Sécurité**. Un
client qui pose la question obtiendra « je ne trouve pas la réponse dans le mode d'emploi » : honnête, inutile.

⚠️ **Les fiches ne se régénèrent PAS toutes seules, et c'est délibéré** : une régénération automatique
remplacerait un texte RELU par un texte que personne n'a validé. La détection de dérive, elle, fait son
travail : elle a rougi CINQ fois depuis sa création, dont trois le 2026-09-13.

## Ce qui est en PAUSE, et pourquoi

Le bloc **agent IA, lots L3, L4, L6 et L7**. Le cadrage est écrit, rien n'est commencé. ⚠️ L2 est LIVRÉ
depuis le 2026-08-28, et il n'y a pas de L5. Détail dans [todo.md](todo.md).
