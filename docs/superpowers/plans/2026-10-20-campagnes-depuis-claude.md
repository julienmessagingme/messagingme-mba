# Campagnes depuis Claude : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** quatre outils MCP (`find_contacts`, `tag_contacts`, `prepare_campaign`, `launch_campaign`) et l'extension de
`list_conversations`, pour qu'une phrase dite à l'assistant donne une campagne WhatsApp de modèle, préparée en brouillon
puis lancée sur confirmation.

**Architecture :** aucun moteur neuf. Les outils appellent ce que la console appelle : `parseBulkTarget` et l'action en
masse pour la cible et l'étiquetage, `preparerCampagne` puis `createCampaignWithRecipients` pour le brouillon, et une
fonction de lancement extraite de la route `/campaigns/:campaignId/run`, partagée par la route et l'outil. Deux
ajouts en base : la date prévue d'un brouillon et la confirmation (code haché, empreinte de l'état).

**Tech Stack :** TypeScript, Fastify, pg, vitest ; console Next.js.

**Spec :** `docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md` (051b0bc4). Ses « choix de Claude
après la relecture constructeur » priment sur le texte qui les précède.

## Global Constraints

- Fonction d'offre des quatre outils : **`console`**, celle qui garde les campagnes de la console (spec, choix 9 et
  « laissé au constructeur ») ; aucune fonction neuve. Filtres d'analyse : **`analyse`**. Hors offre : l'outil reste
  listé et refuse avec le lien de l'offre (`corpsRefusFonction`), comme ses voisins.
- `tag_contacts`, `prepare_campaign`, `launch_campaign` : `scope: 'mcp:write'`, `exigePersonne: true`,
  `ecriture(title, false, true)` (donc `destructiveHint: true`), `plafondCouteux` avant tout travail.
  `find_contacts` : `mcp:read`, `lecture(title)`.
- Code de confirmation : **6 caractères**, alphabet sans caractère ambigu (ni 0, O, 1, I), `crypto.randomInt`,
  **usage unique**, **30 minutes**, stocké HACHÉ (sha256), lié à la campagne et à l'empreinte de son état.
- `find_contacts` rend au plus **100** contacts ; le récapitulatif montre **5** noms ; `tag_contacts` accepte au
  plus **500** identifiants (choix du plan : « quelques centaines par passage », spec choix 7).
- Pas de montant en euros : le récapitulatif dit « jusqu'à N messages facturables par Meta » (spec choix 5).
- `modelesJour` ne s'applique pas (spec choix 3). La catégorie vient du modèle chez Meta par `categoriePlusStricte`
  (spec choix 4) ; un modèle non approuvé ou d'une autre langue est refusé (spec choix 8).
- Une date sans fuseau est refusée ; le récapitulatif l'écrit en heure de Paris.
- Aucun outil n'émet d'événement d'automation ; `tenant_id = $1` sur chaque requête neuve.
- Descriptions des outils en anglais, comme leurs voisins ; noms de paramètres en anglais `snake_case`.
- Doc et messages : pas de tiret cadratin ni demi-cadratin.

## Review Focus

1. **Une cible sans critère ne vise jamais tout l'espace.** `preparerCampagne` sans `contactTarget` prend « tous les
   contacts », et `filters: {}` passe `parseBulkTarget` : une cible MCP sans étiquette, sans filtre et sans
   identifiant est REFUSÉE avant tout appel (test en tâche 4).
2. **Deux `launch_campaign` simultanés avec le même code : un seul lancement.** La réclamation est atomique
   (`update ... where utilise_le is null and expire_le > now() returning`) ; test d'intégration en tâche 7.
3. **La date.** Sans fuseau : refus. Passée à la préparation ou au lancement : refus avec « préparez à nouveau ».
   Le 25 octobre 2026 (passage à l'heure d'hiver) : « demain 10 h » rendu en heure de Paris. Tests en tâche 7.
4. **Un identifiant d'un autre espace** (`campaign_id`, `replaces`, `conversation_ids`, `contact_ids`) : refus
   « inconnu », rien de supprimé, rien d'étiqueté. Tests en tâches 4, 7 et 8.
5. **Re-préparer un brouillon déjà lancé, ou créé dans la console** : refus, rien de supprimé ; le nouveau brouillon
   est créé AVANT la suppression de l'ancien, donc un échec laisse deux brouillons, jamais zéro. Test en tâche 7.

## Méthode de livraison

**Implémenteur par lot, puis une relecture indépendante du diff en fin de lot**, parce que le lot touche le chemin
d'envoi de masse que la production emprunte (la route de lancement est refactorée) et porte des invariants
invisibles d'un test monté sur des faux : une cible vide qui deviendrait « tout le monde », un code qu'on rejouerait,
un brouillon d'un autre espace qu'on supprimerait. La relecture regarde d'abord ces trois points et le câblage de
`src/index.ts`.

**L'essai réel qui clôt** : sur un espace de test Pro, trois contacts de test (le téléphone de Julien parmi eux),
dont un sans consentement marketing. Depuis Claude Code connecté au MCP, la phrase de la spec, adaptée : « Analyse
mon inbox de la semaine et prépare une campagne pour les clients qui ont parlé de X, envoi demain 10 h ». On vérifie
le récapitulatif (ciblés, partants, l'écarté et son motif, cinq noms au plus, la date en heure de Paris, le code), on
répond oui, on voit la campagne « programmée » dans la console à la bonne date, et le message arrive sur le téléphone
à 10 h. Puis : un brouillon daté lancé depuis la console (« Programmer pour … »), et sur un espace Free l'outil listé
qui refuse avec le lien.

---

### Tâche 1 : la migration (date prévue, confirmation)

**Fichiers :** créer `db/migrations/<n>_campagnes_assistant.sql` (`<n>` lu par `npm run migrations`) ; test
`tests/migration-campagnes-assistant.test.ts`.

**Interfaces, produit :**
- `campaigns.prevue_le timestamptz` nullable : la date choisie dans l'assistant, sur un brouillon seulement.
- table `campagne_confirmations` : `campaign_id uuid primary key references campaigns(id) on delete cascade`,
  `tenant_id uuid not null`, `code_empreinte text not null`, `etat_empreinte text not null`,
  `expire_le timestamptz not null`, `utilise_le timestamptz`, `cree_le timestamptz not null default now()`.
  Une ligne présente = le brouillon vient de l'assistant (une seule source, pas de drapeau en plus).

- [ ] Test : le fichier existe, ajoute `prevue_le` nullable et la table avec sa clé étrangère `on delete cascade`,
      `if not exists` partout (rejouable). Le lancer : rouge.
- [ ] Écrire la migration. Test vert ; `npm run migrations` montre le numéro pris.
- [ ] Commit SEUL, poussé seul : elle passe sur le VPS AVANT le code qui écrit `prevue_le` (ajout de colonne écrite par
      le code). Après `migrate` : relire en base colonnes, nullabilité, `confdeltype = 'c'`, clé primaire.

### Tâche 2 : le lancement partagé

**Fichiers :** créer `src/campaign/lancement.ts` ; modifier `src/http/campaigns.ts` (la route `/run` l'appelle) ;
test `tests/campagne-lancement.test.ts`.

**Interfaces, produit :**
`lancerCampagne(deps: DepsLancement, tenantId: string, campaignId: string, quand: Date | null): Promise<IssueLancement>`
avec `IssueLancement = { ok: true; programmee: Date } | { ok: true; enfilee: true } | { ok: false; raison: 'inconnue'
| 'date_passee' | 'non_programmable' | 'limite'; detail?: ... }`. `DepsLancement` = ce que la route utilise
aujourd'hui (`repo.campaignBelongsTo`, `scheduleCampaign`, `resumeCampaign`, `pauseCampaign`, `modelesDuLancement`,
`queue`, `expirationDuRun`). Le corps est celui de la route, déplacé : même ordre, même `groupId` d'espace, même
rétablissement de la pause si l'enfilement échoue.

- [ ] Tests : `inconnue` pour la campagne d'un autre espace ; date passée ; `programmee` appelle `scheduleCampaign` et
      n'enfile rien ; lancement immédiat : `resumeCampaign` puis un `enqueue` avec `groupId` ; enfilement en échec :
      `pauseCampaign` rappelée et l'erreur remonte. Rouges.
- [ ] Extraire. La route traduit `IssueLancement` dans les MÊMES codes et corps qu'aujourd'hui (404, 400, 409, 202,
      refus d'offre). Verts, plus les tests existants de la route sans retouche (`grep -l "/run" tests`).

### Tâche 3 : `list_conversations` étendu

**Fichiers :** modifier `src/inbox/store.pg.ts` (`ConversationSummary.contactId`, options `depuis?: string`,
`jusqua?: string` sur le dernier message), `src/mcp/outils.ts` (l'outil) ; tests
`tests/mcp-list-conversations.test.ts`, `tests/integration/inbox-periode.integration.test.ts`.

**Interfaces, produit :** paramètres `since`, `until` (ISO avec fuseau), `cursor` (la valeur `next_cursor` rendue
par l'appel précédent, décodée comme la route Inbox décode `curseur`) ; chaque conversation rend `contact_id` ; la
réponse rend `next_cursor` (absent en fin de liste).

- [ ] Tests unitaires (faux store) : les paramètres arrivent au store ; `contact_id` et `next_cursor` rendus ; une
      date sans fuseau refusée. Test d'intégration : la période borne bien la liste. Rouges.
- [ ] Implémenter. Vérifier par `EXPLAIN` en lecture seule (méthode « faux pool ») que l'index existant sert le
      filtre de période ; sinon le dire dans le commit, ne pas créer d'index dans ce lot. Verts.

### Tâche 4 : la cible de l'assistant, et `find_contacts`

**Fichiers :** créer `src/mcp/cible.ts`, `src/mcp/outils-campagnes.ts` ; modifier `web/lib/partage/catalogue-mcp.ts`
(les quatre entrées), `src/mcp/outils.ts` (spread `...OUTILS_CAMPAGNES`, `DepsMcp` étend `DepsCampagnesMcp`, et la
phrase d'en-tête « pas de campagne » réécrite) ; test `tests/mcp-campagnes-cible.test.ts`.

**Interfaces, produit :**
- `lireCibleMcp(args, fonctions: ReadonlySet<Fonction>, deps): Promise<{ ok: true; cible: BulkTarget } | { ok: false;
  refus: RefusOutil }>` ; paramètres `tags: string[]`, `tag_mode: 'all' | 'any'`, `opted_in: boolean`,
  `analysis: Array<{ field, op, value }>` (clés de `CLES_FILTRABLES`, lues par `lireFiltreFiche`), ou
  `contact_ids` / `conversation_ids` (au plus 500). La cible finale passe par `parseBulkTarget`.
- store : `contactIdsDesConversations(tenantId: string, conversationIds: string[]): Promise<string[]>`.
- `find_contacts` : `{ total, contacts: [{ contact_id, name, phone, tags, analysis? }] }`, au plus 100, `analysis`
  seulement si l'offre a `analyse`, par `contacts.count` et `contacts.query`.

- [ ] Tests : aucun critère (ni étiquette, ni filtre, ni identifiant) refusé ; `analysis` sur une offre sans
      `analyse` refusé avec le lien ; clé d'analyse hors de la carte refusée ; `conversation_ids` d'un autre espace
      ne rend aucun contact ; 501 identifiants refusés ; Free : refus de fonction `console` avec le lien ;
      `find_contacts` borne à 100 et rend le total. Rouges, puis implémenter, verts.

### Tâche 5 : `tag_contacts`

**Fichiers :** `src/mcp/outils-campagnes.ts` ; test `tests/mcp-tag-contacts.test.ts`.

**Interfaces :** consomme `lireCibleMcp` ; appelle `contacts.applyEditsMany(tenantId, cible, { addTags })`, la
normalisation des étiquettes de la route `/contacts/bulk` (importée, pas recopiée) ; rend `{ tagged: number }`.

- [ ] Tests : `plafondCouteux` consulté avant l'écriture ; aucune publication d'événement (le faux de publication
      n'est jamais appelé) ; une clé d'API sans personne refusée ; étiquette vide refusée. Rouges, puis verts.
- [ ] Ajouter `tag_contacts` à l'inventaire des chemins de masse de `tests/contacts.test.ts` s'il les énumère.

### Tâche 6 : le modèle envoyable, partagé

**Fichiers :** créer `src/envoi/modele-envoyable.ts` (déplacer `modeleEnvoyable`, `categoriePlusStricte`,
`numeroDEnvoi` de `src/http/v1-sends.ts`, exportés) ; `v1-sends.ts` les importe.

- [ ] Déplacement pur : les tests de `/v1/sends` restent verts sans retouche ; `npm run typecheck` vert.

### Tâche 7 : `prepare_campaign` et la confirmation

**Fichiers :** créer `src/campaign/confirmation.ts` (pur), `src/campaign/confirmation.pg.ts` ; modifier
`src/campaign/create.ts` et le store (`CreateCampaignInput.prevueLe?: Date | null`, écrit par l'insertion, une seule
écriture), `src/mcp/outils-campagnes.ts`, le câblage dans `src/index.ts` ; tests
`tests/campagne-confirmation.test.ts`, `tests/mcp-prepare-campaign.test.ts`,
`tests/integration/campagne-confirmation.integration.test.ts`.

**Interfaces, produit :**
- `empreinteEtat(e: { templateName; templateLanguage; category; prevueLe: string | null; paramMapping;
  recipientCount }): string` (sha256 d'un JSON à clés ordonnées) ; `nouveauCode(): string`.
- `ConfirmationStore` : `poser(tenantId, campaignId, etat): Promise<{ code: string; expireLe: Date }>` (remplace la
  ligne), `reclamer(tenantId, campaignId, code, etat): Promise<'ok' | 'invalide' | 'expire' | 'utilise' | 'modifie'>`
  (atomique), `rendre(tenantId, campaignId): Promise<void>`, `existe(tenantId, campaignId): Promise<boolean>`.
- repo : `apercuDestinataires(tenantId, campaignId, n): Promise<string[]>`,
  `desabonnesParmiLesDestinataires(tenantId, campaignId): Promise<number>` (même source que `estDesabonne`).
- `prepare_campaign` : paramètres de cible (tâche 4), `template_name`, `template_language`, `variables` (la forme
  `paramMapping` de la console), `scheduled_for?` (ISO avec fuseau), `name?`, `phone_number_id?` (requis seulement
  si l'espace a plusieurs numéros), `replaces?` (un brouillon à remplacer). Rend `{ campaign_id, template, category,
  scheduled_for: { iso, paris } | null, targeted, will_send, excluded: { not_opted_in, missing_variable,
  unsubscribed }, sample: string[], billable_messages_up_to, confirmation_code, code_expires_at }`. Sa description
  dit à l'assistant de montrer ce récapitulatif et d'attendre un oui explicite avant `launch_campaign`.
- Ordre : offre, personne, plafond coûteux, cible, modèle envoyable, numéro, date, `preparerCampagne` (corps avec
  `contactTarget`, JAMAIS sans), `createCampaignWithRecipients`, puis suppression de `replaces`, puis `poser`.

- [ ] Tests purs : l'empreinte change si un seul champ change ; le code a 6 caractères de l'alphabet. Rouges, verts.
- [ ] Tests de l'outil (faux) : modèle absent ou non approuvé refusé ; MARKETING annoncé quand Meta dit MARKETING ;
      date sans fuseau, date passée refusées ; le 2026-10-24 à 22 h, « 2026-10-26T10:00:00+01:00 » rendu « lundi 26
      octobre à 10 h » ; `replaces` d'un autre espace, déjà lancé ou sans confirmation (console) : refus, rien
      supprimé ; récapitulatif complet avec cinq noms au plus. Rouges, puis implémenter, verts.
- [ ] Test d'intégration : deux `reclamer` simultanés sur le même code, un seul `'ok'` ; un code expiré rend
      `'expire'` ; une ligne d'un autre espace rend `'invalide'`.
- [ ] Câblage : annoncer l'édition de `src/index.ts` aux sessions voisines, `satisfies` posé sur l'objet du spread
      (règle du dépôt), commit en plomberie.

### Tâche 8 : `launch_campaign`

**Fichiers :** `src/mcp/outils-campagnes.ts` ; test `tests/mcp-launch-campaign.test.ts`.

**Interfaces :** paramètres `campaign_id`, `confirmation_code`. Consomme `ConfirmationStore.reclamer` (état recalculé
depuis la campagne en base), puis `lancerCampagne(deps, tenantId, campaignId, prevueLe)` ; sur un refus de
lancement, `rendre` le code. Rend `{ status: 'scheduled', scheduled_for } | { status: 'sending' }`.

- [ ] Tests : code faux, expiré, déjà utilisé, ou état modifié depuis le récapitulatif : refus et rien n'est lancé ;
      campagne d'un autre espace : « inconnue » ; daté : `programmee` à `prevue_le`, rien d'enfilé ; date devenue
      passée : refus « préparez à nouveau » et code rendu ; non daté : enfilé. Rouges, puis implémenter, verts.

### Tâche 9 : la console, brouillon daté

**Fichiers :** le mapping de `src/campaign/store.pg.ts` (`prevueLe` rendu) ; l'écran du brouillon qui porte
« Lancer » (`web/app/campaigns/...`, à localiser) ; tests `tests/web-campagne-prevue.test.ts` et l'e2e qui clique
« Lancer » s'il en existe (`grep -rn "Lancer" web/e2e`).

- [ ] Tests : un brouillon avec `prevueLe` futur montre « Préparée pour le … » et le bouton « Programmer pour … », qui
      appelle `/run` avec `scheduledAt = prevueLe` ; `prevueLe` passé ou absent : « Lancer » comme aujourd'hui (et
      la date passée est dite) ; champ absent de la réponse (API pas encore déployée) toléré. Rouges, puis verts.
- [ ] Suite racine entière avant de pousser (lot console : `web-vouvoiement`, etc.).

### Tâche 10 : documentation, plugin

- [ ] `documentation.md` (section MCP : les quatre outils, la confirmation, la fonction `console`) ; `features.md`
      (vue utilisateur, puis `tests/aide-proposer.test.ts` vert, fiche et empreinte dans le même commit si une
      section citée bouge) ; `docs/JOURNAL-TECHNIQUE.md` (la migration, dans le commit qui la déploie).
- [ ] Plugin : FAQ dans `scripts/plugin/faq.ts` (« préparer une campagne depuis Claude »), `npm run plugin:generer`,
      version de `plugin.json` montée ; publication par `gh workflow run plugin.yml --ref main` APRÈS le `up` de l'API.
- [ ] Lancer `tests/vitrine-developpeurs.test.ts` et les tests de la doc MCP s'ils lisent le catalogue ;
      `npx tsx scripts/auto-attaque.mts` (aucune route neuve attendue, à confirmer).

## Ordre de déploiement

1. Tâche 1 seule : push, image construite, migrations vérifiées dans l'image, `migrate`, relecture en base.
2. Tâches 2 à 8 et 10 : CI lue job par job, relecture du lot, puis `up -d --build` de `mba-api` et `mba-worker` avec la
   même `REVISION`. Le catalogue partagé part sur Vercel au push : déployer l'API dans la foulée de la relecture.
3. Tâche 9 (console) poussée APRÈS le déploiement de l'API, même si elle tolère l'absence du champ.
4. Plugin publié après le `up`.
5. L'essai réel (section « Méthode de livraison »), puis `docs/prive/ESSAIS-REELS.md` mis à jour.
