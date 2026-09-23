# Synthèse des audits structure et scalabilité — 2026-08-31

> Destinataire principal : Claude, pour préparation et exécution des prochains chantiers.
>
> Sources : `AUDIT-ANTI-SLOP-2026-08-18.md`, `AUDIT-SCALE-2026-08-25.md`, état courant du code,
> `PLAN.md` et `todo.md`. Les audits historiques gardent leurs constats d'origine ; ce document les remet à
> jour et ne doit pas faire rouvrir ce qui a déjà été corrigé.

## 1. Verdict exécutif

Le dépôt n'a pas besoin d'une refonte générale. Son architecture profonde est saine : logique métier testable,
IO injectées, scoping tenant largement systématique, claims atomiques sur les destinataires de campagne,
idempotence des webhooks, stores PostgreSQL cohérents et nombreux tests de parité front/back.

Les deux audits mettent cependant en évidence deux dettes différentes :

1. **Dette de capacité et de partage** : le système est fiable tant qu'il traite peu de choses à la fois, mais
   plusieurs chemins restent globalement séquentiels. Une campagne longue ou une rafale d'accusés peut retarder
   les autres clients. C'est le vrai sujet avant d'augmenter le nombre de clients.
2. **Dette de concentration du code** : quelques fichiers concentrent trop de responsabilités. Cela ralentit les
   changements et augmente le risque de régression, mais ce n'est généralement pas ce qui limite le débit de la
   plateforme.

La priorité n'est donc pas « découper tous les gros fichiers ». La priorité est :

1. protéger le débit d'un numéro ;
2. rendre le travail partageable et borné ;
3. sécuriser l'exécution concurrente des scénarios ;
4. figer la version d'un scénario exécuté ;
5. seulement ensuite augmenter la concurrence et le nombre de workers ;
6. mener les refactors structurels par petites passes indépendantes.

## 2. État actuel à ne pas confondre avec les constats historiques

Les rouges et oranges opérationnels de l'audit de scalabilité du 25 août ont été corrigés depuis :

- expiration pg-boss des longues campagnes plafonnée ;
- `Retry-After` borné ;
- alerte sur les DLQ ;
- pool applicatif relevé et passé par le pooler transactionnel ;
- verrou applicatif empêchant deux runs de la même campagne ;
- pause et reprise des campagnes ;
- reprise après arrêt ou déploiement ;
- claim du déclencheur `avant_date` ;
- import CSV écrit par lots ;
- micro-cache et index du compteur de non-lus ;
- attribution et purge à 30 jours des événements Meta bruts (`0093`, commit `5456d14`).

Le socle anti-double-envoi des campagnes est notamment solide : un destinataire passe atomiquement de
`pending` à `sending` avant l'appel fournisseur. Il ne faut pas réécrire ce mécanisme.

L'audit anti-slop du 18 août a lui aussi été presque entièrement traité. Les nouveaux constats structurels sont
surtout des repousses de concentration :

| Fichier courant | Taille observée | Constat |
|---|---:|---|
| `web/lib/api.ts` | 1 834 lignes | Hub de 275 exports, dette déjà connue et en croissance |
| `web/components/CampaignCreateForm.tsx` | 1 686 lignes | Extraction faite, mais monolithe interne conservé |
| `web/components/WorkflowBuilder.tsx` | 1 860 lignes | Trois composants majeurs dans le même fichier |
| `src/worker.ts` | 1 151 lignes dans l'état courant | Composition, consommateurs et nombreux sweepers/timers |
| `src/workflow/executor.ts` | 1 322 lignes | Complexe, mais environ la moitié documente des incidents réels |
| `src/campaign/store.pg.ts` | 1 042 lignes | Plusieurs responsabilités et plusieurs classes |
| `src/crm/contact-store.pg.ts` | 966 lignes dans l'état courant | Identité, CRM, bulk, consentement et purge |

### Changement intégré pendant la rédaction

La rétention de `webhook_events` a été intégrée pendant la rédaction de ce document par le commit `5456d14`.
Le commit de suivi `0532f0d` confirme l'application de 0093 et une première purge de 62 événements. La migration
ajoute le numéro destinataire, les index, une purge à 30 jours et l'effacement scopé lors d'une purge contact.

Il ne faut donc pas rouvrir ce chantier. Le reste de l'item 5.2 concerne la rétention des **conversations et
analyses**, qui attend encore une durée décidée par le produit. Les limites documentées de 0093 — anciennes lignes
sans discriminant et certains handovers — restent à connaître et à surveiller.

## 3. Échelle de décision

Les tableaux utilisent trois axes distincts :

- **Impact** : valeur obtenue si le chantier réussit, de 1 à 5.
- **Risque si ignoré** : probabilité et gravité du problème en cas de montée en charge, de 1 à 5.
- **Risque de changement** : probabilité d'introduire une régression pendant le chantier, de 1 à 5.

Un risque de changement élevé ne signifie pas « ne pas faire ». Il signifie : isoler le chantier, poser les
tests avant, prévoir un déploiement progressif et ne pas le mélanger à un refactor esthétique.

## 4. Ordre global recommandé

### Niveau A — doit être fait absolument pour scaler

| Ordre | Sujet | Impact | Risque si ignoré | Risque de changement | Déclencheur |
|---:|---|---:|---:|---:|---|
| 1 | Contrat de capacité et décisions produit | 5 | 5 | 1 | Avant de dimensionner quoi que ce soit |
| 2 | Throttle partagé par numéro | 5 | 5 | 4 | Avant toute concurrence de campagne |
| 3 | Campagnes en lots courts et équitables | 5 | 5 | 4 | Avant plusieurs campagnes actives |
| 4 | Claim atomique de l'avance d'un scénario | 5 | 5 à deux workers, 3 aujourd'hui | 4 | Avant le second worker ; course RCS déjà possible |
| 5 | Version publiée immuable des scénarios | 5 | 4 | 4 | Avant l'édition massive de scénarios vivants |
| 6 | Séparation et partition des files webhook | 5 | 4 | 4 | Avant une forte activité conversationnelle |
| 7 | Prise en compte des limites Meta | 4 | 5 | 3 | Avant des campagnes volumineuses sur des numéros neufs |
| 8 | Trancher le multi-numéro | 5 si vendu | 5 si vendu | 5 | Avant de connecter un second numéro à un tenant |

### Niveau B — obligatoire avant la réplication horizontale

| Sujet | Impact | Risque si ignoré | Risque de changement |
|---|---:|---:|---:|
| Heartbeat par instance, et non ligne unique | 4 | 4 | 2 |
| Rate limits distribués ou explicitement locaux | 4 | 4 | 3 |
| Advisory lock des migrations | 5 | 5 | 2 |
| Audit de tous les sweepers en multi-réplique | 5 | 5 | 4 |
| Concurrence pg-boss coordonnée entre replicas | 5 | 5 | 4 |
| Recalcul du budget de connexions par nombre de process | 5 | 5 | 2 |
| Test de charge et test de reprise après kill | 5 | 4 | 2 |

### Niveau C — fort retour sur investissement, mais non bloquant pour le débit

| Sujet | Impact | Risque si ignoré | Risque de changement |
|---|---:|---:|---:|
| Mutualiser la recherche de connaissance production/simulation | 3 | 3 | 1 |
| Découper `web/lib/api.ts` derrière un barrel | 4 sur la vélocité | 2 | 2 |
| Découper `CampaignCreateForm` par responsabilités | 4 sur la fiabilité des évolutions | 3 | 3 |
| Extraire `WorkflowConfigPanel` et la carte de nœud | 3 | 3 | 2 |
| Registre des timers et fonctions `register*Jobs` dans le worker | 4 | 3 | 3 |
| Composant `Modal` commun et constantes UI existantes | 2 | 2 | 2 |

### Niveau D — bien, mais peut attendre

| Sujet | Pourquoi attendre |
|---|---|
| Découpage profond de `workflow/executor.ts` | Fort risque de déplacer la complexité et de perdre des invariants documentés |
| Découpage des gros stores PostgreSQL | Utile, mais exige une validation DB plus coûteuse et ne débloque pas le débit immédiat |
| Hook générique pour les panneaux MBA | Confort de maintenance, faible effet produit |
| Petits helpers `escapeHtml`, `isRecord`, styles locaux | Nettoyage valable, mais à faire lorsqu'un fichier concerné est déjà ouvert |
| File dédiée aux imports | À rouvrir seulement si les imports dépassent régulièrement environ 100 000 lignes |
| Colonne `unread` dénormalisée | À rouvrir si un tenant dépasse environ 10 000 conversations ou si la mesure montre un coût réel |

## 5. Analyse détaillée des sujets de niveau A

### A1. Contrat de capacité et décisions produit

**Constat.** « Scaler » ne définit pas une capacité. Le dimensionnement change complètement entre 20 tenants
ayant chacun un numéro à 30 messages/minute et 100 tenants partageant quelques gros comptes Meta.

**Décisions à écrire avant le code :**

- nombre cible de tenants à 6 et 18 mois ;
- utilisateurs simultanés par tenant ;
- campagnes simultanées et taille p95/p99 ;
- délai maximal acceptable entre « Lancer » et le premier envoi ;
- délai maximal acceptable pour un message entrant ;
- nombre de numéros autorisés par tenant ;
- comportement d'une modification de scénario avec des runs vivants ;
- priorité relative : message humain, scénario, automation, campagne ;
- politique de rétention et RPO/RTO contractuels.

**Angle mort principal.** Sans SLO, augmenter `concurrency` donne une impression de progrès mais ne dit ni si un
client peut affamer les autres ni si la base reste stable.

**Définition de terminé.** Une page de contrat de capacité avec trois profils de charge et des SLO mesurables.

### A2. Throttle partagé par numéro

**Constat vérifié.** `src/campaign/run-job.ts` instancie un limiteur par run de campagne. Deux campagnes du même
numéro possèdent donc deux budgets indépendants. Les envois Inbox, scénario et automation ne partagent pas ce
budget. Le verrou `src/campaign/run-lock.ts` empêche deux runs de la même campagne, pas deux campagnes distinctes.

**Impact.** Permettre plusieurs travaux concurrents sans multiplier le débit réel ni dégrader la réputation du
numéro. C'est le prérequis de toute concurrence de campagne.

**Risque si ignoré.** Une configuration à 30 messages/minute peut devenir 60, 90 ou plus selon le nombre de
campagnes et de chemins d'envoi actifs. Les limites Meta et la qualité du numéro deviennent incontrôlables.

**Risque de changement.** Élevé : le limiteur est sur le chemin de chaque envoi. Une panne du mécanisme partagé
peut soit laisser tout partir, soit bloquer tous les envois.

**Préconisation.** Définir un arbitre de débit par `phone_number_id`, couvrant au moins campagne, workflow,
automation et Inbox. Avec un seul worker, un registre en mémoire par numéro peut être une étape. Avant plusieurs
workers, le budget doit devenir distribué ou l'affectation d'un numéro à un seul worker doit être garantie.

**Angles morts à traiter :**

- ne pas confondre cadence technique en messages/seconde et palier Meta en conversations uniques sur 24 h ;
- donner une priorité aux messages humains sur les campagnes ;
- décider si RCS partage ou non la même abstraction, avec ses propres quotas fournisseur ;
- gérer le redémarrage : un limiteur mémoire oublie son historique ;
- gérer les horloges et le délai d'attente maximal ;
- définir le mode dégradé si PostgreSQL ou Redis servant le quota est indisponible ;
- éviter une écriture SQL par message si les mesures montrent qu'elle devient le nouveau goulot ;
- tenir compte des numéros appartenant au même WABA si Meta applique aussi une limite à ce niveau.

**Définition de terminé.** Un test concurrent prouve que deux campagnes et un envoi Inbox sur le même numéro ne
dépassent pas le budget, tandis que deux numéros distincts peuvent avancer en parallèle.

### A3. Campagnes en lots courts et équitables

**Constat vérifié.** `queue.work('campaign-run', ...)` n'active actuellement aucune concurrence. Un job traite sa
campagne en ligne jusqu'à épuisement. À 30 messages/minute, 5 000 destinataires représentent environ 2 h 47 de
traitement avant que la file ne serve normalement la campagne suivante.

**Impact.** Réduire le temps d'attente inter-client, borner la durée des jobs, faciliter pause/reprise et rendre
possible une concurrence contrôlée.

**Préconisation.** Un run doit réclamer un lot borné, par exemple 50 à 200 destinataires, le traiter, puis se
réenfiler s'il reste du travail. Une campagne ne doit plus être un job de plusieurs heures.

Ensuite seulement :

- poser `groupId = tenantId` à tous les enfilements concernés ;
- activer une concurrence globale ;
- limiter la concurrence par tenant ;
- mesurer l'équité par âge du plus vieux job, pas seulement par profondeur de file.

**Angles morts à traiter :**

- le verrou actuel porte sur toute la campagne ; il faut décider s'il protège un coordinateur ou un lot ;
- la transition finale vers `completed` doit être atomique et vérifier qu'il ne reste ni `pending` ni `sending` ;
- pause, arrêt et déploiement doivent être lus entre deux destinataires et entre deux lots ;
- un échec d'enfilement du lot suivant ne doit pas figer la campagne ;
- ne pas mettre des milliers de destinataires dans le JSON du job : la base contient déjà la source de vérité ;
- les campagnes au fil de l'eau n'ont pas de « dernier lot » naturel ;
- une taille de lot fixe peut être trop longue à 1/minute et trop petite à 80/minute ; viser plutôt une durée
  maximale de lot ;
- plusieurs lots du même numéro restent soumis au throttle partagé de A2 ;
- les compteurs de progression doivent tolérer les retries et les claims déjà effectués.

**Définition de terminé.** Sous charge synthétique, plusieurs tenants voient leurs campagnes progresser sans
famine ; pause/reprise, kill du worker et retry ne produisent ni double envoi ni campagne figée.

### A4. Claim atomique de l'avance d'un scénario

**Constat vérifié.** `WorkflowExecutor.advance` lit le run en attente, calcule la suite, effectue des actions puis
écrit l'état. Le store possède `setStateSiEncoreSur`, mais le chemin général utilise encore des écritures
inconditionnelles. Une course est déjà possible entre le process API pour certains retours RCS et le worker
webhook ; elle devient structurelle avec deux workers.

**Impact.** Empêcher deux messages ou deux workers d'avancer le même run deux fois, d'envoyer deux branches ou
d'écraser le `current_node` en dernier écrivain gagnant.

**Préconisation.** Introduire un claim ou une version optimiste sur l'état attendu : tenant, run, statut,
`current_node`, éventuellement dernier message traité. Le perdant doit constater que l'état a bougé et sortir
sans effet.

**Angles morts à traiter :**

- un verrou DB autour de tout le traitement ne doit pas rester ouvert pendant un appel Meta ou LLM ;
- l'effet externe peut réussir puis le process mourir avant l'écriture de l'état ; il faut des clés
  d'idempotence stables ou un outbox, pas seulement un verrou ;
- deux messages différents et légitimes peuvent arriver très vite : il faut préserver l'ordre, pas seulement
  dédupliquer un `messageId` ;
- WhatsApp et RCS peuvent produire des événements concurrents pour le même contact ;
- les reprises de questions, de sommeil et de bloc agent doivent partager la même doctrine ;
- mesurer et journaliser les claims perdus afin de distinguer une course normale d'une anomalie.

**Définition de terminé.** Un test d'intégration lance deux avances concurrentes sur le même run et prouve qu'une
seule branche produit des effets. Le test doit aussi couvrir le crash entre effet externe et persistance.

### A5. Version publiée immuable des scénarios

**Constat vérifié.** `workflow_runs` conserve un `workflow_id` et un `current_node`, mais pas de version du graphe.
Lorsqu'un contact répond ou qu'un run se réveille, l'exécuteur recharge le graphe courant depuis `workflows`.
Modifier ou supprimer un bloc modifie donc implicitement les parcours déjà démarrés.

**Impact.** Rendre les parcours reproductibles, les analytics interprétables et les modifications sans danger
lorsque plusieurs administrateurs créent ou éditent des scénarios.

**Préconisation.** Séparer :

- un brouillon éditable ;
- une version publiée immuable dans `workflow_versions` ;
- `workflow_runs.workflow_version_id` ;
- campagnes et automations rattachées explicitement à une version publiée.

Éviter de copier le graphe dans chaque run : une version partagée référencée par plusieurs runs est beaucoup plus
économe.

**Angles morts à traiter :**

- versionner le graphe ne fige pas les dépendances externes : template, email, agent IA, champ, tag ou média peut
  encore être modifié ou supprimé ; décider lesquelles sont référencées et lesquelles sont snapshotées ;
- définir la sémantique d'un rollback ;
- migrer les runs existants vers une version initiale ;
- conserver des codes de nœuds stables ou versionnés afin de ne pas mélanger les analytics ;
- définir si une campagne créée puis lancée plus tard utilise la version de création ou la dernière version ;
- ajouter une concurrence optimiste à l'autosauvegarde du builder afin que deux onglets ne s'écrasent pas ;
- prévoir la rétention des anciennes versions sans supprimer celles référencées par des runs ou rapports ;
- afficher clairement « brouillon » versus « publié » dans l'UI.

**Définition de terminé.** Un run démarré sur V1 termine sur V1 après publication de V2 ; un nouveau run utilise
V2 ; les rapports identifient la version.

### A6. Séparation et partition des files webhook

**Constat vérifié.** Une seule file `webhook` traite les messages entrants, les accusés de livraison et des
actions de scénario en ligne. Une campagne volumineuse produit plusieurs accusés par message et peut retarder les
conversations réelles.

**Impact.** Isoler les chemins critiques, réduire la latence des messages entrants et permettre le parallélisme
entre contacts.

**Préconisation.** Après parsing durable du webhook brut, router vers des files distinctes :

- messages entrants ;
- statuts de livraison ;
- contrôle/handover ;
- éventuellement déclenchements secondaires lourds.

Les messages entrants doivent être ordonnés par une clé telle que
`tenantId + phoneNumberId + waId`, tout en permettant la concurrence entre clés.

**Angles morts à traiter :**

- un statut peut arriver avant que l'envoi correspondant soit visible dans la table cible ;
- séparer les files change l'ordre relatif de deux types d'événements ;
- `groupId` sans mécanisme cluster-wide ne protège que le process courant ;
- les accusés doivent être batchables sans perdre leur idempotence ;
- le receiver doit répondre rapidement à Meta, même si une file secondaire est dégradée ;
- une DLQ par type exige un outil de diagnostic et de rejeu explicite ;
- les messages d'un même contact ne doivent jamais être exécutés en parallèle ;
- une priorité trop forte des entrants ne doit pas affamer indéfiniment les statuts.

**Définition de terminé.** Une rafale d'accusés de campagne ne dégrade pas le p95 de prise en charge des messages
entrants, et deux messages successifs d'un même contact restent ordonnés.

### A7. Paliers et erreurs Meta

**Constat vérifié.** `messaging_limit_tier` est récupéré, persisté et affiché, mais pas utilisé par les campagnes.
Les codes de plafond `130429` et `131048` ne figurent ni dans les codes rejouables ni dans les codes terminaux de
`src/meta/errors.ts`.

**Impact.** Éviter de transformer un plafond temporaire en centaines d'échecs définitifs et protéger les numéros
neufs.

**Préconisation.** Avertir à la création/lancement, adapter le débit et surtout mettre la campagne en pause sur
un signal explicite de plafond. Ne pas refuser aveuglément une audience sur la seule valeur du tier.

**Angles morts à traiter :**

- le tier est rafraîchi périodiquement et peut être périmé ;
- Meta compte des conversations uniques, pas les lignes de destinataires de cette seule campagne ;
- Inbox, workflows et autres campagnes consomment le même budget ;
- la qualité du numéro et le palier peuvent changer pendant le run ;
- certains codes doivent provoquer une pause globale du numéro plutôt qu'un retry par destinataire ;
- l'heure de réouverture du budget n'est pas nécessairement connue précisément ;
- l'UI doit distinguer plafond, qualité, token invalide et taux d'échec métier.

**Définition de terminé.** Une simulation d'erreur de plafond met en pause sans brûler les destinataires restants,
affiche une raison explicite et permet une reprise sûre.

### A8. Multi-numéro : implémenter ou refuser

**Constat.** Le modèle historique suppose encore largement un fil par `(tenant_id, wa_id)`. Tous les runs et
chemins métier ne portent pas explicitement `phone_number_id`.

**Impact.** Si le produit vend plusieurs numéros à un client, ce chantier est bloquant. Sinon, une validation
explicite refusant le second numéro est préférable à un comportement partiellement fonctionnel.

**Angles morts à traiter si la réponse est oui :**

- migration et backfill des conversations existantes, parfois ambigus ;
- unicité `(tenant_id, phone_number_id, wa_id)` ;
- propagation dans `workflow_runs`, automations, inbox, analytics et permissions ;
- choix du numéro par défaut et choix explicite dans les campagnes ;
- portée du consentement : globale au contact ou spécifique au numéro/canal ;
- templates et WABA disponibles par numéro ;
- même personne écrivant à deux numéros du même tenant ;
- throttling et paliers propres à chaque numéro ;
- réaffectation d'un numéro entre tenants et historique associé.

**Définition de terminé.** Soit le second numéro est refusé clairement, soit tous les chemins ont un test
d'isolation prouvant que deux numéros du même tenant ne fusionnent ni conversation ni exécution.

### Sujet récemment livré : rétention de `webhook_events`

**État.** Le chantier a été livré dans `5456d14` via la migration 0093 et un sweeper borné, puis observé en
production avec une première purge de 62 événements (`0532f0d`). Il ajoute `phone_number_id`, des index et une
purge par ancienneté, ainsi qu'un effacement dans la purge contact. Ce n'est plus une action ouverte de cette
feuille de route.

**Impact.** Fermer une croissance non bornée et rendre les données brutes attribuables puis effaçables par tenant.

**Risques et angles morts à revoir avant livraison :**

- les anciennes lignes n'ont pas de `phone_number_id` et ne sont traitables que par rétention ;
- un `DELETE` massif produit du WAL, du bloat et du travail d'autovacuum ; valider la taille du lot ;
- l'index sur une grosse table peut verrouiller en migration transactionnelle ;
- vérifier que tous les types de payload extraient correctement le numéro destinataire ;
- la durée de rétention doit être une décision légale/produit, pas seulement une valeur technique ;
- les backups peuvent conserver les données plus longtemps que la base primaire ;
- la suppression réduit la capacité de rejeu ou de diagnostic d'un incident ancien ;
- le sweeper doit être protégé contre la ré-entrance et audité avant plusieurs workers ;
- tester la purge croisée : une même personne présente chez deux tenants ne doit être effacée que chez le tenant
  demandé.

**Surveillance résiduelle.** Observer la purge bornée et le volume de WAL/autovacuum, conserver la procédure pour
les anciennes lignes sans discriminant, puis décider séparément de la rétention des conversations et analyses.

## 6. Passage à plusieurs workers : checklist non négociable

Ne pas augmenter le nombre de replicas du worker avant que tous les points suivants soient vrais :

1. `WorkflowExecutor.advance` possède un claim atomique ou une version optimiste.
2. Les effets externes importants disposent d'une clé d'idempotence stable ou d'un outbox.
3. Le throttle par numéro est distribué, ou chaque numéro est assigné de façon exclusive à un worker.
4. Les `groupId` sont posés à l'enqueue et la concurrence est réellement coordonnée entre replicas ;
   `localGroupConcurrency` seul ne suffit pas.
5. Chaque sweeper est soit atomique avec `SKIP LOCKED`/claim, soit protégé par un leader/verrou distribué.
6. Le heartbeat possède une ligne par instance. Une ligne globale masque un worker mort derrière un worker vivant.
7. Les migrations sont protégées par advisory lock.
8. Le budget de connexions est recalculé : les pools sont multipliés par le nombre de process et de replicas.
9. Le graceful shutdown a été testé avec une campagne, un run workflow et un job agent en vol.
10. Un kill brutal suivi d'un redémarrage ne produit ni doublon, ni run orphelin, ni travail figé.

## 7. Angles morts transversaux des deux audits

### 7.1 Priorités et noisy neighbor

Les audits parlent de concurrence, mais pas assez de priorité. Un client lançant dix campagnes ne doit pas
retarder :

- la réponse d'un opérateur humain ;
- un message entrant ;
- un timeout de question ;
- une campagne d'un autre tenant.

Il faut définir des classes de service, des quotas par tenant et un indicateur d'âge du plus vieux travail.

### 7.2 Effet externe réussi, écriture locale échouée

Les claims empêchent deux traitements simultanés, mais ne ferment pas la fenêtre : fournisseur appelé avec
succès, process tué avant la persistance. Chaque canal doit documenter son mécanisme : identifiant fournisseur,
clé d'idempotence, journal/outbox ou réconciliation.

### 7.3 Rafales temporelles

Les campagnes programmées, réveils de scénarios, automations `avant_date` et tâches planifiées peuvent tous tomber
à une heure ronde. Tester une charge uniforme ne révèle pas ce pic. Les tests doivent inclure un « top of hour »
avec plusieurs tenants.

### 7.4 Coûts et crédits

Le débit technique n'est pas la seule borne. Les appels Meta, RCS, email et LLM ont des budgets distincts. Une
file fluide peut accélérer une erreur de configuration et augmenter rapidement la facture. Les quotas et alertes
doivent exister par tenant et par fournisseur.

### 7.5 Publication, permissions et audit

Versionner les scénarios pose la question : qui peut publier, annuler ou reprendre ? Il faut tracer l'auteur, la
version, l'heure et les campagnes/runs concernés. Sans cela, la reproductibilité technique ne suffit pas à
expliquer un incident client.

### 7.6 Sauvegarde et restauration

La rétention primaire ne dit rien de la durée des backups. La scalabilité ne dit rien non plus du temps de
restauration d'une base plus grosse. Le plan Supabase, le RPO, le RTO et un exercice de restauration restent à
documenter avant que le volume rende le premier exercice douloureux.

### 7.7 Observabilité à forte cardinalité

Des métriques par tenant, campagne, workflow et numéro sont utiles, mais les labels non bornés peuvent faire
exploser le système de métriques. Conserver les identifiants détaillés dans les logs/traces et limiter les labels
de métriques aux dimensions réellement agrégées.

### 7.8 Évolution du schéma en production

Les futures tables seront plus grosses. Le runner de migrations transactionnelles n'est pas adapté à tous les
`CREATE INDEX`. Prévoir une voie `no-transaction`/`CONCURRENTLY`, des migrations additives et des déploiements
compatibles ancien code/nouveau schéma.

### 7.9 Liste et recherche de milliers de scénarios

Le volume de définitions n'est pas un goulot aujourd'hui, mais `GET /nodes` dérive encore la liste des nœuds en
chargeant tous les workflows du tenant. Si un tenant possède des centaines ou milliers de scénarios, il faudra
pagination, recherche serveur et probablement un index/catalogue de nœuds. Ne pas construire ce catalogue avant
que la mesure ou le contrat de capacité le justifie.

## 8. Synthèse de l'audit simplicité et structure

### 8.1 Correctif immédiat, faible risque : recherche de connaissance

`src/agent/resolvers/mba.ts` et `src/agent/resolvers/simulation.ts` recopient la recherche, les limites et le
formatage. Le bac à sable est censé reproduire exactement la production, mais une divergence d'erreur existe déjà.

**Préconisation.** Extraire une fonction pure partagée et ajouter un test de parité production/simulation.

**Angle mort.** Ne pas mutualiser tout le resolver : seules les règles réellement identiques doivent être
partagées, afin que les dépendances spécifiques au sandbox restent explicites.

### 8.2 `web/lib/api.ts`

**Gain.** Réduire les conflits, faciliter la découverte des contrats et empêcher le hub de continuer à croître.

**Préconisation.** Modules par domaine derrière un `index.ts` réexportant exactement l'API actuelle. Migrer les
appelants progressivement.

**Angles morts.** Préserver `'use client'`, éviter les cycles d'import, conserver une seule implémentation du
transport dans `web/lib/http.ts` et ne pas mélanger cette extraction à une modification des contrats HTTP.

### 8.3 `CampaignCreateForm`

Le composant cumule destinataires, références, brouillon, autosauvegarde, variantes de contenu, programmation et
lancement, avec environ 48 états React.

**Gain.** Réduire les interactions invisibles entre effets et rendre brouillon/lancement testables.

**Préconisation.** Extraire `useCampaignDraft`, `useCampaignReferences`, les sections Audience/Contenu et un
réducteur pour l'état de lancement. Garder l'orchestration dans un parent unique.

**Angles morts.** Une extraction mécanique ne réduit pas la complexité d'état ; ne pas déplacer 48 `useState`
dans un hook opaque. Poser d'abord des tests sur hydratation, autosauvegarde, changement de type de contenu,
programmation et double clic de lancement.

### 8.4 `WorkflowBuilder`

**Préconisation.** Extraire la carte de nœud, le `WorkflowConfigPanel` et les conversions React Flow. Garder dans
le builder l'état du graphe, sélection, connexion et sauvegarde.

**Angles morts.** Le découpage du composant ne résout ni les conflits d'autosauvegarde ni le versionnement des
scénarios. Ces sujets fonctionnels doivent être conçus séparément. Ne pas fusionner `ScenarioCanvas`, dont la
séparation readonly protège l'écran analytics contre l'autosauvegarde.

### 8.5 `worker.ts`

**Préconisation.** Avant d'y ajouter de nouvelles files : registre de tâches récurrentes avec `stopAll()`, puis
fonctions `registerCampaignJobs`, `registerWorkflowJobs`, `registerAgentJobs`, etc. La composition reste visible
dans `main()`.

**Angles morts.** Ne pas introduire de service locator ni masquer les dépendances. Ne pas faire ce refactor dans
la même PR que le batching ou la concurrence ; une première PR doit être comportementalement neutre.

### 8.6 `workflow/executor.ts`

**Décision.** Ne pas le découper maintenant uniquement parce qu'il fait 1 322 lignes. Ses commentaires conservent
des incidents et invariants importants.

Le découpage devient pertinent après le claim atomique et le versionnement, lorsque les frontières sont stables :
dispatcher d'actions, résolution RCS, pont agent. Déplacer chaque commentaire avec le code qu'il protège.

**Angle mort.** Un petit fichier qui oblige à sauter entre six services peut être moins compréhensible que
l'exécuteur actuel. Mesurer le nombre de dépendances et les tests isolables, pas le nombre de lignes.

### 8.7 Stores PostgreSQL

`campaign/store.pg.ts` et `crm/contact-store.pg.ts` ont des frontières naturelles, mais leur découpage est de
maintenance. Le mener lorsqu'un chantier fonctionnel touche déjà les zones concernées, avec tests d'intégration
sur une base jetable.

**Angles morts.** Éviter un dossier de fragments SQL sans propriétaire, préserver les transactions multi-étapes,
introduire des interfaces de capacité étroites et ne pas dupliquer les projections lors du split.

## 9. Ordre de livraison proposé à Claude

Chaque ligne doit idéalement correspondre à une PR ou un petit groupe de PR cohérentes.

1. **Décisions** : capacité cible, multi-numéro oui/non, priorité des classes de trafic, sémantique de publication
   d'un scénario, rétention des conversations et analyses.
2. **Classer les erreurs Meta de plafond et définir la politique tier**, petit correctif de sécurité avant volume.
3. **Rendre l'avance workflow atomique**, avec tests de concurrence et clés d'idempotence des effets.
4. **Préparer `worker.ts` sans changement fonctionnel** : registre des timers et fonctions d'enregistrement, si
   cela aide directement les étapes suivantes.
5. **Introduire le throttle partagé par numéro** sur tous les chemins d'envoi, d'abord sous un seul worker.
6. **Découper `campaign-run` en lots de durée bornée**, avec pause/reprise/kill/retry.
7. **Poser `groupId = tenantId` et activer progressivement la concurrence**, protégée par le throttle.
8. **Séparer messages entrants et statuts**, puis partitionner les messages par conversation.
9. **Introduire brouillon/version publiée**, migrer les runs et pinner campagnes/automations.
10. **Traiter le multi-numéro** si la décision produit est oui ; sinon poser le refus explicite.
11. **Fermer la checklist multi-worker**, puis tester un second replica sous charge avant production.
12. **Réduire le polling du fil** avec delta `?after=` ou SSE avant une dizaine de clients simultanément actifs.
13. **Surveiller 0093 et fixer la rétention conversations/analyses**, sans rouvrir la rétention des événements bruts.
14. **Refactors de vélocité** : recherche agent partagée, `api.ts`, `CampaignCreateForm`, `WorkflowBuilder`, modales.
15. **Refactors différables** : executor profond et stores, uniquement avec une justification fonctionnelle.

## 10. Stratégie de validation

### Tests fonctionnels indispensables

- deux campagnes distinctes sur le même numéro respectent un budget commun ;
- deux numéros avancent en parallèle ;
- deux tenants ne s'affament pas ;
- pause et reprise au milieu d'un lot ;
- kill du worker après envoi fournisseur mais avant persistance ;
- deux messages concurrents n'avancent le run qu'une fois et dans le bon ordre ;
- publication V2 n'affecte pas un run V1 ;
- une rafale de statuts n'allonge pas excessivement le délai des entrants ;
- erreur Meta de plafond : pause sans perte des destinataires ;
- purge RGPD d'un même `wa_id` présent chez deux tenants.

### Charge minimale à simuler

- plusieurs tenants, pas seulement plusieurs campagnes d'un même tenant ;
- campagnes longues à faible cadence et campagnes courtes à forte cadence ;
- accusés `sent/delivered/read` en rafale ;
- messages entrants pendant les campagnes ;
- réveil simultané de nombreux runs et automations à une heure ronde ;
- un fournisseur lent, un `429`, un timeout et une coupure DB ;
- redémarrage volontaire d'un worker en plein traitement.

### Métriques à suivre

- âge p50/p95/p99 du plus vieux job par file ;
- temps lancement → premier envoi ;
- débit effectif par numéro et par canal ;
- taux de claims perdus ;
- campagnes sans progrès ;
- runs workflow en attente/sommeil au-delà de leur échéance ;
- DLQ et taux de retry ;
- acquisition et saturation du pool DB ;
- erreurs Meta par code, numéro et catégorie ;
- délai webhook reçu → traitement entrant terminé.

### Règles de test du dépôt

Ne jamais lancer les intégrations locales contre la configuration actuelle : le dépôt indique que `.env` peut
pointer vers la production. Les tests nécessitant PostgreSQL doivent utiliser une base explicitement jetable ou la
CI. Sur l'état courant incluant `0532f0d`, les typechecks backend et frontend réussissent, ainsi que 245 fichiers
et 3 125 tests backend, puis 13 fichiers et 125 tests web. Les tests d'intégration PostgreSQL n'ont volontairement
pas été lancés localement.

## 11. Consignes d'exécution pour Claude

1. Inspecter `git status` et le diff avant toute édition ; les changements présents appartiennent à une autre
   session tant que leur origine n'est pas établie.
2. Ne pas mélanger un changement de concurrence avec un découpage esthétique du même fichier.
3. Ajouter les tests de concurrence/idempotence avant ou dans la même PR que le mécanisme.
4. Garder les migrations additives et déployer le schéma compatible avant le code qui l'exige.
5. Introduire des feature flags ou variables de concurrence permettant un rollout `1 → 2 → 4`, avec retour à 1.
6. Mesurer avant/après ; ne pas déclarer un chantier « scalable » uniquement parce qu'il utilise une queue.
7. Conserver les commentaires d'incident qui expliquent un invariant ; corriger ceux qui promettent une garantie
   que le code ne fournit pas.
8. Mettre à jour `documentation.md`, `PLAN.md` et `todo.md` seulement après validation réelle, sans présenter un
   working tree ou une migration non appliquée comme déployée.

## 12. Conclusion

Le risque principal n'est pas que les fichiers soient trop gros. Le risque principal est d'augmenter la
concurrence sur une architecture dont le débit et certains états sont encore locaux au run ou au process.

Le chemin sûr est :

**quota partagé par numéro → campagnes en lots → équité par tenant → claims workflow → files partitionnées →
versions publiées → primitives distribuées → second worker.**

Les refactors de `CampaignCreateForm`, `WorkflowBuilder`, `api.ts` et `worker.ts` sont utiles pour exécuter ce plan
plus sûrement, mais ils ne doivent jamais être confondus avec le plan de scalabilité lui-même. L'exécuteur de
workflow et les stores peuvent attendre que les invariants de concurrence et de version soient stabilisés.
