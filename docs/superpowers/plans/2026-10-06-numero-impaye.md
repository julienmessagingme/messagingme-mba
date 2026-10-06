# Lot 4 : ce que devient un numéro fourni dont l'abonnement tombe, plan

Spec : `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`. Plan court : tâches, interfaces, tests attendus,
ordre de déploiement. Le code se lit dans origin (l'arbre partagé peut être en retard) ; commits en plomberie depuis
une extraction, jamais depuis l'arbre partagé.

**Objectif** : un numéro fourni impayé depuis 7 jours, ou dont l'abonnement est fini, ne peut plus rien envoyer ; le
client est prévenu et peut se réabonner ; 7 jours après la fin, le numéro est libéré (délié, résilié chez DIDWW).

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante par livraison (A, puis B), parce que la
production emprunte ces chemins : le point d'envoi unique, le webhook de Stripe, une migration, des écritures chez
DIDWW et chez Stripe. Le code porte des invariants invisibles : la suspension se calcule sur des dates et une seule
lecture fait foi ; un numéro apporté n'est jamais suspendu ; une libération ne se fait qu'une fois. Aucun workflow
multi-agents pour coder.

**L'essai réel qui clôt chaque livraison** : A, au déploiement, l'espace de l'essai du 2026-10-06 (abonnement résilié
à 15 h 14 UTC) est suspendu : une réponse depuis l'Inbox refusée avec le message, le bandeau, le rappel dans Claude
Code, l'alerte Telegram ; B, sa libération (due dès le 13 octobre) : le numéro délié, `terminated` chez DIDWW relu en
lecture seule, `resilie` dans la réserve, les e-mails reçus sur le Gmail de l'essai.

## Contraintes globales

- Aucun tiret long dans le code, les commentaires et les docs.
- `tenant_id = $1` sur chaque requête d'espace ; dépendances requises, jamais optionnelles (les fixtures disent leur
  hypothèse, comme `jamaisDelie`).
- Tout objet de Stripe passe par Zod (`safeParse`) ; seuls ceux qui portent `produit: numero` nous concernent. La forme
  de `customer.subscription` pour la version épinglée (`2025-11-17.clover`) se LIT dans la documentation de Stripe
  avant d'écrire le schéma (la fin de période a quitté la racine dans les versions récentes).
- Délais : coupure à **7 jours** après le premier échec ; libération à **7 jours** après la fin ; rappel par e-mail
  **2 jours** avant la libération. Constantes nommées, une seule fois.
- Migration au numéro libre relu dans origin au moment de l'écrire (0215 au 2026-10-06), appliquée AVANT le `up` ;
  la ligne du compteur de `CLAUDE.md` part dans le commit qui prend le numéro.
- La console n'est poussée qu'après le déploiement de l'API qui porte ses routes.
- Toute retouche de `features.md` part avec la fiche d'aide qui cite la section et son empreinte
  (`tests/aide-proposer.test.ts` vert avant de pousser).
- Le registre de routes change : `scripts/auto-attaque.mts` se lance en local avant de pousser.
- Aucune écriture réelle chez DIDWW, Stripe ou Meta pendant le développement : transports simulés dans les tests.

## Points de vigilance (chacun avec son test dans sa tâche)

1. Le client se réabonne pendant que le balayage libère son numéro : la libération relit l'abonnement sous verrou et
   renonce si un abonnement vivant est apparu (tâche 9).
2. Deux copies du worker libèrent en même temps : une seule libération, un seul appel à DIDWW (tâche 9).
3. `customer.subscription.updated` (résiliation programmée) arrive APRÈS `customer.subscription.deleted` : la fin
   effective reste, rien ne ressuscite (tâche 2).
4. Un espace qui a connecté SON numéro et garde un ancien abonnement fini : jamais suspendu (tâches 1 et 3).
5. Une campagne en cours au moment où la suspension prend effet : le destinataire est rendu à la file, jamais en
   échec, et la campagne reprend au paiement (tâche 3).

## Livraison A : la suspension (migration 0215)

**Tâche 1. Migration 0215 et l'état calculé** (`db/migrations/0215_numero_impaye.sql`, `src/stripe/abonnements.pg.ts`)
- Colonnes `premier_echec_le`, `fin_prevue_le`, `fini_le`, `libere_le` (`timestamptz`, nullables, sans défaut) ; table
  `abonnements_numero_avis (stripe_subscription_id, avis, envoye_le)`, clé primaire sur les deux premiers, cascade ;
  CHECK `campaigns_pause_reason_check` élargi à `numero_suspendu` sous le même nom ; reprise `fini_le = maj_le` des
  abonnements `resilie`.
- Un seul fragment SQL de « l'abonnement courant de l'espace » (le vivant, sinon le dernier fini, comme `deLEspace`),
  et un seul calcul de l'état, partagés par toutes les lectures.
- `EtatAbonnementNumero = 'actif' | 'fin_prevue' | 'en_retard' | 'suspendu' | 'libere'` ;
  `etatDeLEspace(tenantId): Promise<{ etat, finPrevueLe, liberationLe } | null>` ;
  `noterEchec(abonnementId)`, `noterPaiement(abonnementId, periodeFin)`, `noterFinPrevue(abonnementId, Date | null)`,
  `noterFin(abonnementId)` ; `noterAvis(abonnementId, avis): Promise<boolean>` (`true` la première fois seulement).
- Tests (intégration et unitaires) : chaque ligne du tableau de la spec, aux bornes (6 j 23 h ouvert, 7 j coupé) ; la
  reprise ; un réabonnement (nouvel abonnement vivant) efface la suspension ; `noterAvis` une seule fois.

**Tâche 2. Le webhook** (`src/http/credit-stripe.ts`)
- `customer.subscription.updated` (neuf) : la résiliation programmée posée ou retirée ; `invoice.payment_failed` :
  `noterEchec` ; `invoice.paid` : `noterPaiement` puis les pauses `numero_suspendu` de l'espace levées ;
  `customer.subscription.deleted` : `noterFin`.
- Tests : chacun des quatre, rejoué, dans le désordre (vigilance 3), sans nos métadonnées ignoré, objet illisible 422.

**Tâche 3. La garde au point d'envoi unique** (`src/meta/numero-delie.ts`, `src/account/numero-delie.pg.ts`,
`src/meta/factory.ts`, `src/campaign/{run-job,engine,pause}.ts`, `src/server.ts`, `src/http/v1-messages.ts`,
`src/http/v1-sends.ts`, `src/mcp/outils.ts`, `src/automation/runner.ts`, `src/workflow/executor.ts`, `src/socle.ts`)
- `MotifBlocage = 'numero_delie' | 'numero_suspendu'` ; la fabrique demande `numerosBloques.blocage(phoneNumberId):
  Promise<MotifBlocage | null>` (une requête, cache court de 5 s comme aujourd'hui) et lève `NumeroBloqueError`
  (`phoneNumberId`, `motif`, `message`), dont `NumeroDelieError` et `NumeroSuspenduError` héritent. Le filtre des
  ENTRANTS du webhook garde `estDelie` seul : les entrants d'un numéro suspendu restent enregistrés.
- Chaque appelant qui traitait `NumeroDelieError` traite `NumeroBloqueError` et son motif : pause de campagne
  `numero_suspendu` (conditionnelle, comme pour le délié) et levée au paiement, 409 de l'Inbox avec le message, 409
  `number_suspended` de l'API, refus MCP, scénario arrêté avant effet.
- Tests : un test d'inventaire (plus aucun `instanceof NumeroDelieError` hors de son fichier) ; chaque appelant sur
  un numéro suspendu ; vigilances 4 et 5.

**Tâche 4. L'agent IA et le répondeur** (`src/agent/run-turn.ts`, `src/workflow/wiring.ts`,
`src/repondeur/demarrer.ts`, `src/inbox/fil.ts`)
- Le numéro est vérifié (`verifierNumero` de la fabrique) AVANT l'appel du modèle ; bloqué : aucun débit, le fil
  passe à l'équipe comme quand le répondeur est indisponible. Vaut pour le délié comme pour le suspendu.
- Tests : tour sur un numéro délié puis suspendu : zéro appel au modèle, zéro débit, le fil à l'équipe.

**Tâche 5. Se réabonner, et l'état pour Claude et la console** (`src/http/numero-fourni.ts`,
`src/stripe/abonnement.ts`, `src/mcp/outils-numero.ts`, `src/mcp/serveur.ts`, `src/http/account.ts`, `src/index.ts`)
- `RetourAbonnement` gagne `'claude'` (page publique `/paiement-recu`). La route de paiement accepte l'espace dont le
  numéro connecté EST le numéro fourni et dont l'abonnement est fini (réabonnement du même numéro).
- `resubscribe_number` (personne exigée, plafond coûteux) : impayé, le portail ; fini, un nouveau paiement ; actif ou
  fin prévue, le portail ; libéré, la consigne du nouveau numéro. `get_number_subscription` rend l'état et les dates.
- `GET /tenants/:tenantId/abonnement-numero` (tout membre de l'espace) : `{ etat, finPrevueLe, liberationLe }`.
- `traiterMessage` ajoute un rappel à chaque réponse d'outil quand l'état est `en_retard` ou `suspendu` (dépendance
  requise dans `DepsMcp`).
- Tests : le réabonnement rend le même numéro ; la route refuse toujours un espace dont le numéro connecté n'est pas
  le numéro fourni ; chaque branche de `resubscribe_number` ; le rappel présent ou absent ; la route d'état refuse un
  autre espace (`tests/scope-tenant.test.ts`), `ROUTES_DU_LIEN` inchangée ; auto-attaque.

**Tâche 6. Le balayage, première moitié** (`src/numero/balayage-abonnements.ts`, `src/worker.ts`,
`src/worker/roles.ts`)
- Tâche `abonnements-numero` (rôle principal, toutes les 15 minutes) : l'alerte Telegram à la suspension, une fois
  (`noterAvis`). La livraison B y ajoute la libération et les e-mails.
- Tests : une alerte par suspension, aucune au tour suivant ; la tâche déclarée dans `TACHES_PAR_ROLE`.

**Tâche 7. La console** (`web/components/AppShell.tsx`, `web/components/BandeauAbonnement.tsx`,
`web/app/connecter-whatsapp/page.tsx`, `web/app/paiement-recu/page.tsx`, `web/lib/api/`)
- Le bandeau sur toutes les pages (`en_retard`, `suspendu`, et `fin_prevue` en discret), avec « Se réabonner » pour
  un admin et « prévenez un admin » pour un membre ; le bouton de réabonnement sur `/connecter-whatsapp` ;
  `/paiement-recu` sans session. Tolère l'absence de la route (API plus ancienne).
- Tests : e2e de chaque état du bandeau, du réabonnement et de la page publique.

**Tâche 8. Docs, réglages de Julien, déploiement de A**
- `features.md` et la fiche d'aide (empreinte), `documentation.md`, `todo.md`, `wip.md`, le journal, la ligne du
  compteur de migrations.
- Julien, chez Stripe : l'événement `customer.subscription.updated` sur le webhook, « annuler l'abonnement » après le
  dernier essai.
- Ordre : 0215 appliquée et relue en base, `up` de l'API et des deux workers, contrôles publics, puis la console.
  Essai réel de A.

## Livraison B : la libération et les e-mails (aucune migration)

**Tâche 9. La libération** (`src/didww/client.ts`, `src/numero/balayage-abonnements.ts`,
`src/account/numero-delie.pg.ts`, `src/http/embedded-signup.ts`, `src/worker.ts`, `src/config.ts`)
- `ClientDidww.resilier(didId): Promise<void>` (`PATCH /dids/{id}`, `terminated: true`) ; la clé DIDWW câblée dans le
  worker.
- Le balayage libère chaque abonnement fini depuis 7 jours, ligne prise en `for update skip locked`, abonnement relu
  sous verrou : connecté, délié puis résilié chez DIDWW puis `resilie` dans la réserve ; jamais connecté, `libre` dans
  la réserve ; puis `libere_le` et l'alerte. Un échec chez DIDWW laisse `libere_le` vide et se rejoue.
- « Relier » refuse un numéro libéré (409 `numero_libere`), et le message du délié dit la libération.
- Tests : les deux cas, l'échec rejoué, vigilances 1 et 2, « Relier » refusé.

**Tâche 10. « Abandonner » d'un abonné** (`src/stripe/client.ts`, `src/stripe/abonnement.ts`,
`src/http/numero-fourni.ts`)
- `programmerFinAbonnement(transport, { cle, abonnementId })` (`POST /v1/subscriptions/{id}`,
  `cancel_at_period_end=true`) ; appelé par « Abandonner » quand l'abonnement court ; un refus de Stripe n'empêche pas
  l'abandon et alerte Julien.
- Tests : abonné, non abonné, refus de Stripe.

**Tâche 11. Les e-mails** (`src/numero/avis-abonnement.ts`, sur le modèle de `src/repondeur/alerte-credit.ts`)
- À chaque admin de l'espace, par Resend, une fois chacun : à la suspension, 2 jours avant la libération, à la
  libération ; un envoi raté se rejoue, aucun n'empêche la libération.
- Tests : chaque e-mail une seule fois, un admin désactivé exclu, un échec de Resend rejoué.

**Tâche 12. Docs, réglage de Julien, déploiement de B**
- Docs comme en tâche 8. Julien : le droit d'écrire les abonnements sur la clé restreinte de Stripe.
- Ordre : `up` de l'API et des deux workers, contrôles publics. Essai réel de B.
