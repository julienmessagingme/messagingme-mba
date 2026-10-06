# RC8 : supprimer un espace depuis /ops

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code.

**But :** depuis /ops, supprimer pour de bon un espace (les espaces d'essai qui s'accumulent), après avoir fait le
ménage chez les tiers, avec les liens Stripe sous les yeux.

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Définitive ou réversible | Définitive : purge réelle en base, confirmation par saisie du nom de l'espace |
| Un abonnement Stripe au numéro encore actif | On affiche les liens (client et abonnement, tableau de bord Stripe) et on supprime QUAND MÊME ; le webhook Stripe est corrigé pour ne plus boucler sur un espace disparu |
| Le ménage chez les tiers | Automatique, au mieux : révoquer la clé Vercel (BLOQUANT si échec), éteindre le MBA et vider sa liste, déconnecter Salesforce, sortir le numéro fourni, désabonner le compte WhatsApp de notre app ; chaque étape affichée avec son résultat, puis la purge |
| Les personnes | Une adresse qui n'a plus aucun autre espace est effacée (mot de passe, second facteur) ; une adresse qui en a d'autres les garde |
| La trace | Une ligne : nom de l'espace, dates, auteur, étapes chez les tiers et leur résultat, nombres de lignes purgées ; aucune donnée client |

## Faits qui cadrent le lot (lus sur `e5c338d7`, et par l'exploration du 2026-10-06)

- **Aucun chemin ne supprime un espace aujourd'hui** (le code, `CLAUDE.md` et `todo.md` le disent) ; l'espace d'essai du
  lot 3b a été supprimé le 2026-10-06 par un script hors dépôt, après avoir passé son numéro en `bloque`.
- Les 69 clés `references tenants` sont en `on delete cascade`, sauf `numeros_fournis.tenant_id` en `set null` (0210 :
  le numéro resterait `attribue` sans espace). Clés fragiles dans la cascade, l'ordre n'étant pas garanti :
  `channelsme_links.workflow_id`, `channelsme_posts.link_id` (0114 ; un test d'intégration supprime les enfants à la
  main pour cette raison), `connector_requests.source_id`, `agent_tools.request_id` (0105), la clé composite
  `agent_tools (source_id, source_kind)` (0152, NO ACTION).
- Hors de toute clé : `credits_offerts` (🔴 À GARDER : c'est la mémoire « jamais deux offres pour un numéro » ; l'effacer
  rendrait l'offre récoltable par suppression et recréation), `salesforce.orgs`, `mmhs.tenant_portals` (HubSpot),
  `webhook_events` (rétention), caches à clé texte, jobs pg-boss.
- Hors de notre base : la clé AI Gateway (`revoquerCleGateway`, `src/agent/provisionner-cle.ts:248`, qui supprime chez
  Vercel puis notre ligne seulement si Vercel confirme ; route `DELETE /ops/cle-modele/:tenantId`) ; chez Meta l'agent,
  sa liste (dont `mba_liste.entree_id` part avec la cascade, alors que sans lui on ne peut plus retirer l'entrée) et
  l'abonnement du compte WhatsApp à notre app (`POST /{waba}/subscribed_apps`, `src/meta/embedded-signup.ts:88`) ;
  Stripe ; Salesforce (`deconnecter`, `src/salesforce/connexion.ts`).
- Stripe : `stripe_clients (tenant_id, livemode) → customer_id`, `abonnements_numero.stripe_subscription_id`, partent en
  cascade, donc à LIRE avant. Liens : `https://dashboard.stripe.com/[test/]customers/cus_…` et
  `…/subscriptions/sub_…` (préfixe `test/` selon `livemode`). La clé restreinte ne lit pas les abonnements : on ne
  montre que ce que notre base sait.
- Webhook : une facture payée d'un abonnement dont l'espace a disparu tente une insertion qui viole la clé étrangère
  (`src/http/credit-stripe.ts`, `enregistrer`) ; seul 23505 est attrapé, donc 5xx et Stripe rejoue en boucle.
- 🔴 **Travail en parallèle** : le lot 4 du numéro fourni (spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`,
  une autre session) définit la libération d'un numéro. Si elle est livrée, on l'appelle ; sinon le numéro passe en
  `bloque`, comme le 2026-10-06.

## T1. La migration

- Table `espaces_supprimes (tenant_id uuid primary key, nom text not null, cree_le timestamptz, supprime_le timestamptz
  not null default now(), par text not null, etapes jsonb not null, comptes jsonb not null)`, SANS clé étrangère (l'espace
  n'existe plus). `par` est l'adresse de l'exploitant (comme la trace des autres écritures /ops).
- Elle CRÉE une table que seul le code neuf écrit : AVANT le `up`, relue en base juste après (colonnes, clé primaire,
  aucune clé étrangère, table vide).

## T2. Le bilan avant suppression

**Fichiers :** nouveau `src/ops/suppression-espace.ts`, `src/http/ops.ts` (ou un module voisin au registre, classe
`session-ops`), tests.

- `GET /ops/espaces/:tenantId/suppression` rend : nom, création, nombres (utilisateurs, contacts, conversations,
  scénarios), solde de crédit restant, client et abonnement Stripe (identifiants, statut connu, `livemode`, les deux
  liens), numéro fourni et son statut, MBA allumé, Salesforce relié, HubSpot relié, clé Vercel présente, et la liste des
  adresses : celles qui seront effacées (aucun autre espace) et celles qui seront gardées.

## T3. La suppression

- `DELETE /ops/espaces/:tenantId` `{ nom }` : refus si `nom` ne correspond pas exactement au nom de l'espace (sans
  tenir compte des espaces en tête et en fin). Étapes, dans cet ordre, chacune journalisée avec son résultat :
  0. **Verrouiller l'espace** (`tenants.status = 'locked'`, geste existant) pour que rien ne reparte pendant le ménage :
     vérifier que le verrou arrête les tours d'agent et la traduction, qui ROUVRENT une clé Vercel quand l'espace a du
     crédit (défaut connu, `todo.md`) ; sinon ajouter la garde dans ce lot.
  1. Lire et garder ce que la cascade emportera : Stripe, numéro fourni, `mba_liste`, identités concernées.
  2. Révoquer la clé Vercel. 🔴 **Échec = arrêt, rien n'est purgé** : une clé orpheline facture à vie et ne se retrouve
     plus.
  3. Au mieux : éteindre le MBA chez Meta et retirer chaque entrée de sa liste ; désabonner le compte WhatsApp de notre
     app ; déconnecter Salesforce ; sortir le numéro fourni (libération du lot 4 si livrée, sinon `bloque`). Un échec
     est noté et n'arrête pas.
  4. Purger dans UNE transaction : les enfants aux clés fragiles d'abord (liens de chaîne et leurs publications, outils,
     requêtes de connecteur, sources), puis `delete from tenants`, puis les identités devenues orphelines (relevées à
     l'étape 1, effacées seulement si elles n'ont plus aucun compte). `credits_offerts` n'est PAS touchée.
  5. Écrire la ligne `espaces_supprimes`, puis répondre avec les étapes.
- La route rend aussi les liens Stripe dans sa réponse : c'est le moment où Julien en a besoin.
- 🔴 Isolation : chaque requête de purge porte le `tenant_id` ; un test vérifie qu'un second espace, peuplé des mêmes
  tables, est intact après la suppression du premier.

## T4. Le webhook Stripe qui ne boucle plus

- Dans `src/http/credit-stripe.ts`, une violation de clé étrangère (23503) sur un espace disparu rend 200, journalise et
  envoie l'alerte Telegram « l'espace supprimé X paie encore son abonnement Y : à résilier chez Stripe » (lien direct).
  Même traitement pour une recharge de crédit d'un espace disparu.

## T5. L'écran

**Fichiers :** `web/app/ops/page.tsx` (`TenantTable`, l. 927-989), `web/lib/api/compte.ts`.

- Un bouton « Supprimer » par ligne, qui ouvre le bilan ; les liens Stripe en évidence quand un abonnement existe ; le
  champ « tapez le nom de l'espace » ; puis le déroulé des étapes avec leur résultat.

**Tests attendus (T2 à T5) :** intégration sur une base jetable : un espace peuplé de TOUTES les tables (dont les
chaînes et les connecteurs aux clés fragiles) se supprime sans erreur, l'espace voisin est intact, une identité
orpheline est effacée et une identité partagée gardée, `credits_offerts` reste, la ligne de trace est écrite ; échec de
Vercel : rien n'est purgé ; échec de Meta : purge faite, étape notée en échec ; nom erroné : refus ; session non ops :
refus ; le webhook sur un espace disparu rend 200 et alerte (vérifié dans les deux sens : sans le correctif, 500).

## T6. Documentation

`documentation.md` (la suppression d'un espace, ses étapes et ce qui reste chez les tiers), `CLAUDE.md` (retirer « aucun
chemin ne supprime un espace » et le « piège armé » de la clé Vercel, désormais traité ; dernière migration), `todo.md`,
journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot, parce que le geste est
IRRÉVERSIBLE, qu'il fait le tour de presque toutes les tables, qu'un ordre de cascade non garanti peut le faire échouer
à mi-chemin, et qu'une étape oubliée chez un tiers coûte de l'argent pour toujours (clé Vercel, abonnement Stripe) ou
rend une offre récoltable (`credits_offerts`).

**Ordre de déploiement :** CI verte job par job, `compose build`, migration appliquée avant le `up` et relue en base,
`up` de l'API et des deux workers, contrôle public ; la console part APRÈS.

**L'essai réel qui clôt :** créer un espace d'essai depuis une adresse jetable (avec un agent IA, donc une clé Vercel,
et quelques contacts), le supprimer depuis /ops, puis vérifier en vrai : la clé n'existe plus chez Vercel, l'espace et
ses données ont disparu de la base, l'adresse ne se connecte plus, la ligne de trace est là, et la file des jobs morts
de /ops ne porte aucun échec lié à cet espace dans l'heure qui suit.
