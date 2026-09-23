# Lot 3 des publicités Click-to-WhatsApp : « Router, créer, suivre »

**Date** : 2026-09-23. **Spec** : `docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md` (§ 1, 2, 3.2 à 3.7,
4, 5). **Lots précédents** : `2026-09-22-pubs-ctwa-lot1-capter.md`, `2026-09-23-pubs-ctwa-lot2-connecter.md`,
tous deux en production.

## Ce que ce lot ajoute

Le lot 1 capte ce qui se perd (l'arrivée, le `ctwa_clid`, le tarif de chaque envoi). Le lot 2 connecte le
compte publicitaire du client. Il manque tout le reste : une pub n'existe pas dans Engage Me, un lead ne sait
pas où aller, et personne ne voit ce que la pub a coûté.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff**, et c'est la méthode que la spec a déjà tranchée (§ 7).
Les quatre questions du `CLAUDE.md` global y mènent, et je les repose ici parce que le lot 3 est le plus
exposé des trois : **la production emprunte ces chemins** (le webhook entrant change de comportement, l'argent
dépensé est celui du client, les chiffres affichés servent à décider d'arrêter une campagne) ; **créer une pub
n'est pas réversible**, une impression payée ne se rembourse pas ; **une partie des critères demande un œil**
(la revue de Meta, un vrai clic depuis un téléphone, la double réponse de l'agent de Meta) ; et **le code
touché porte des invariants invisibles** : l'ordre des étapes du job webhook, la doctrine « un message
`standby` ne déclenche rien » qu'on perce pour une seule ligne, la garde de consentement, et le contrat entre
un index partiel et sa requête. Deux oui en haut penchent vers la revue humaine, et ici les quatre sont oui.

⚠️ `feature-loop` est écarté pour une raison précise, pas par principe : sa porte est la complétude d'un
critère mécanique, et le critère qui compte ici (« l'agent de Meta n'a pas répondu à la place du scénario »)
ne s'observe que sur une vraie conversation. Aucun `Workflow` multi-agents : Julien ne l'a pas demandé.

**L'essai réel qui clôt la feature** (spec § 6) : la première campagne MessagingMe créée depuis Engage Me,
destination scénario, sur le numéro où l'agent de Meta répond à tout le monde. Il faut **voir en vrai** la pub
diffuser, un clic depuis un téléphone produire une arrivée avec son `ctwa_clid`, l'agent de Meta se taire
pendant que le scénario parle, le tag de qualification faire avancer l'entonnoir, la dépense affichée égaler
celle du Gestionnaire, et la pause depuis Engage Me arrêter la diffusion. Aucun test de ce plan ne remplace
cet essai réel, et c'est écrit ici pour que personne ne croie l'inverse en voyant la CI verte.

## Trois commits, dans cet ordre, et il n'est pas négociable

La spec (§ 1) : « L'écran de création ne doit jamais exister sans le routage derrière : une pub créée dont les
leads n'iraient nulle part serait le "proposé mais inerte" que le produit s'interdit. »

1. **Routage** : la migration, les tables, la règle de routage pure, la reprise à l'arrivée, la qualification.
2. **Création** : le client Marketing API, le formulaire, la création en pause, la publication.
3. **Suivi** : le balayage, l'entonnoir, la pause et la reprise, la page d'une pub.

## Commit 1 : router

### Migration 0170 (`pubs_router`)

**Prochaine libre = 0170**, et les deux sources concordent, relues le 2026-09-23 : le dossier
`db/migrations/` s'arrête à `0169_pub_connexion_noms.sql`, et `public.schema_migrations` rend 0169 appliquée
à 12 h 29 UTC. Le dossier tranche sur ce qui est PRIS, la base sur ce qui est APPLIQUÉ.

Elle AJOUTE uniquement, donc **avant le déploiement**, et l'ancien code y survit. Elle sera relue en base
point par point juste après `migrate`, jamais en écrivant cette ligne.

- `publicites` : une ligne par campagne connue d'Engage Me, **unique par (espace, campagne Meta)**. Les
  identifiants Meta (campagne, ensemble, créa, pub), l'origine, le nom, le statut et le motif de refus, le
  budget, les dates, la destination (`scenario` ou `agent_meta`), le scénario visé (`on delete set null`),
  le tag de qualification, l'automation possédée (`on delete set null`), la dépense et les clics de la
  dernière lecture, qui l'a créée et quand.
  - **CHECK à UN SEUL SENS** : un scénario n'existe que pour la destination `scenario`. L'inverse
    (destination `scenario` dont le scénario a été supprimé) est un état ATTEIGNABLE, et le refuser ferait
    échouer la suppression du scénario sur une contrainte de publicité. C'est mot pour mot la leçon de 0144.
- `pubs_connues` : la correspondance identifiant de pub vers campagne, par espace. C'est elle qui rend le
  lien « par campagne » vrai pour les copies faites dans le Gestionnaire. Écrite à la création, et à la
  résolution d'une copie inconnue.
- `arrivees_pub` gagne quatre colonnes : `campagne_id` (texte, nullable), `issue`, `reprise_le`,
  `qualifie_le`. Plus l'index partiel qui sert la qualification.
  - 🔴 **`campagne_id` est l'identifiant META, en texte, PAS une clé étrangère vers `publicites`.** Une
    arrivée est un FAIT daté : supprimer la pub ne doit pas effacer d'où venait le lead, et un
    `on delete set null` le ferait en silence, donc l'entonnoir d'hier changerait de valeur aujourd'hui.

### La règle de routage : une fonction PURE, et rien d'autre dedans

`src/pubs/routage.ts`, sur le modèle exact de `src/inbox/assignation-campagne.ts` (`devenirEffectif`) : les
faits entrent, une décision sort, aucune IO. Les six lignes du tableau de la spec (§ 3.3) deviennent six cas
d'un type somme, ce qui rend le « et si on ajoute une septième ligne » visible du compilateur.

| Campagne | Contact | Message | Décision | Issue |
|---|---|---|---|---|
| Inconnue | | | les déclencheurs ordinaires tournent, comme aujourd'hui | `inchange` |
| Destination agent de Meta | | | aucun déclencheur, ni « toutes les pubs », ni « nouveau contact » | `agent_meta` |
| Destination scénario | Bloqué | | rien | `bloque` |
| Destination scénario | Désabonné | | rien ne part, l'arrivée le dit | `desabonne` |
| Destination scénario | | `standby` | reprise du fil, puis SEULE l'automation de la pub | `reprise_reussie` / `reprise_refusee` |
| Destination scénario | | normal | SEULE l'automation de la pub | `scenario` |

L'ordre des tests est celui du tableau : bloqué avant désabonné, et la destination avant l'état du contact.

### Ce que le câblage fait de cette décision

Une étape neuve dans `handleWebhookJob`, **après l'arrivée** (qui écrit la ligne) et **avant les
déclencheurs** (qu'elle restreint). Elle rend une carte `messageId -> restriction`, que `processTriggers`
consulte. Trois valeurs : `tous`, `aucun`, `seule(automationId)`.

- 🔴 **La restriction ne passe PAS par `consumed`.** Ce jeu-là retire aussi le message à l'avance de
  parcours (`processWorkflowAdvance`), ce que la spec ne demande nulle part : un lead d'une pub « agent de
  Meta » qui répond à un scénario en cours doit continuer d'y répondre. Deux notions distinctes, deux
  canaux.
- 🔴 **L'exception à la doctrine du `standby` tient en une condition, et elle est nommée.**
  `processTriggers` ignore tout message `standby` ; il en traitera un, et un seul cas : celui dont le
  routage a repris le fil, donc dont la restriction vaut `seule`. Le commentaire de `triggers.ts` le dira,
  parce que c'est la seule ligne du dépôt qui perce cette règle.
- La reprise passe par `reprendreLeFilPourLApp` (`src/workflow/wiring.ts`), qui EXISTE : `take` avec un seul
  rejeu, puis `app_workflow` en local. On ne récrit pas le geste, on le câble. Un refus de Meta rend
  `reprise_refusee` et l'agent de Meta garde le lead.

### L'automation d'une pub

`automations.possede_par` prend la valeur `publicite`. Aucune migration : pas de CHECK sur cette colonne, et
`HORS_WEBHOOK` exclut DÉJÀ `possede_par is not null`, donc l'automation d'une pub est hors de portée de
l'écran Automations sans qu'on touche à rien. Le déclencheur `ctwa_ad` accepte `campaignId` dans sa config
(jsonb, pas de migration). `vientDuneChaine` devient `reprendLaMain`, qui couvre les DEUX propriétaires :
même chemin, pas un second.

### La qualification

Second consommateur de la file `automation-event`, à côté de l'alimentation des campagnes, et isolé comme
elle. Sur `tag_added`, on cherche l'arrivée la plus récente de ce contact dans les 28 derniers jours dont la
pub porte ce tag et qui n'est pas encore qualifiée. Une seule requête, donc idempotente par construction.

⚠️ **L'action en masse, l'import et l'outil MCP n'émettent pas `tag_added`, donc ils ne qualifient personne.**
C'est connu, voulu (un chemin de masse n'émet jamais, invariant du dépôt) et écrit à l'écran de la pub.

### Tests du commit 1

Unitaires : la règle de routage, ligne par ligne du tableau, plus l'ordre des tests (un contact à la fois
bloqué et désabonné rend `bloque`) ; la restriction des déclencheurs, y compris le `standby` qui passe et
celui qui ne passe pas ; `matchesTrigger` sur `campaignId`. Intégration : la qualification (28 jours, arrivée
la plus récente, une seule fois, contact sans arrivée) ; « toutes les pubs » qui ne part plus pour une
campagne reliée. **Chaque test de non-régression se vérifie dans les deux sens**, mutation posée, mutation
grepée avant de lancer la suite, restauration par copie de sauvegarde.

## Commit 2 : créer

Client Marketing API (`src/meta/pubs-creation.ts`) : image, campagne, ensemble de pubs, créa, pub. **Tout est
créé en pause chez Meta**, chaque identifiant est enregistré dès que Meta le renvoie, et si une étape échoue
on supprime la campagne (Meta supprime ce qu'elle contient). Si la suppression échoue aussi, la ligne reste
visible comme « création échouée » : une campagne en pause ne dépense rien.

Formulaire minimal (spec § 3.2), écran de confirmation avec la dépense maximale (« cette pub peut dépenser
jusqu'à X entre le D1 et le D2 »), et **Publier allume d'abord l'automation, puis active chez Meta** : un
échec ne laisse jamais une pub active sans routage.

L'optimisation (`CONVERSATIONS` ou `LINK_CLICKS`) est une CONSTANTE, mesurée une fois au pilote. Pas de repli
silencieux : une création refusée affiche le message de Meta.

La route de suppression d'un scénario gagne un refus 409 quand une pub active l'utilise.

## Commit 3 : suivre

Balayage toutes les 15 minutes (`taches.programmer`), par espace connecté ayant des pubs non terminées : un
appel pour les statuts et les motifs de refus, un appel pour la dépense et les clics. Un jeton rejeté marque
la connexion et alerte l'exploitation ; **le routage continue**.

Entonnoir : dépense, clics, leads, qualifiés, avec le coût de chaque étape et le taux de passage vers la
suivante. **Division par zéro : « non disponible »**, jamais 0, jamais l'infini. À part, les leads non pris en
charge (reprise refusée, désabonnés, bloqués), parce que ce sont des clics payés qui n'ont rien donné et que
les noyer dans le total les rendrait invisibles.

Pause et reprise sur la campagne, chez Meta. L'automation reste allumée : les leads tardifs arrivent encore.

## Rayon de souffle

Repéré par la spec (§ 9), et vérifié à chaque commit :

- `src/webhooks/triggers.ts` : la doctrine du `standby` perce pour une seule ligne, et une étape s'ajoute
  avant elle dans `handleWebhookJob`.
- Le runner d'automations : la valeur `publicite` de `possede_par`, et la reprise de main qu'elle hérite.
  `vientDuneChaine` a UN appelant (`runner.ts`) et un test qui lit la source
  (`tests/automation-chaine-reprend-la-main.test.ts`) : le renommer touche les deux.
- Le déclencheur « toutes les pubs » ne part plus pour une campagne reliée : **c'est un changement de
  comportement pour les automations DÉJÀ créées**, à dire dans `features.md` et à tenir par un test.
- `AutomationEvent` gagne `campagneId` : c'est le type partagé par six émetteurs. Champ optionnel, donc
  aucun ne casse, et seul le chemin du webhook le renseigne.
- La file `automation-event` gagne un consommateur. Isolé dans son propre `try` : une qualification ratée ne
  doit pas rejouer un scénario déjà démarré.
- La route de suppression d'un scénario gagne un refus.
- `web/lib/nav.ts` porte déjà « Publicités » (lot 2) : l'entrée ne bouge pas, la page gagne une liste.
- 🔴 **Une session voisine travaille dans cet arbre.** Annonce avant de toucher `src/index.ts`,
  `src/server.ts` ou `src/worker.ts`, `git commit --only` avec une liste construite depuis ce que j'ai
  touché MOI, et `git diff <mes chemins>` juste avant de commiter pour vérifier que le contenu est encore
  le mien.

## Déploiement

- Migration 0170 AVANT le `up -d --build`, relue en base point par point juste après `migrate`.
- **L'écran part APRÈS le déploiement de l'API qui porte ses routes.** Vercel publie la console à chaque
  `git push` : entre le push et le `up`, l'écran appellerait des routes que la production n'a pas. Les
  lectures neuves de l'écran tolèrent l'absence de leur route, comme `compte` au lot 2.
- `gh run list` avant le déploiement, verdict lu job par job sur `gh run view <id> --json jobs`, jamais sur
  le code de sortie d'un `watch`.
- `/revue` après chaque commit, `/revue-finale` avant le déploiement, et le déploiement ne part qu'avec zéro
  rouge attesté.
