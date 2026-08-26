# L'agent IA dans un scénario : cadrage du 2026-08-23

**Statut : exploratoire.** Rien n'est engagé, rien n'est codé.

Ce document est la révision 2. La première version proposait une architecture correcte mais
sur-outillée. Elle a été repassée au filtre de trois questions : est-ce simple pour le client,
est-ce que ça tient à l'échelle côté tool calling, est-ce différenciant sans sur-ingénierie.
Six mécanismes en sont sortis. Ils sont listés en fin de document, avec la raison de chaque retrait,
pour que la décision reste révisable si le terrain la contredit.

## Vocabulaire, parce que « MBA » est un piège

Le nom du repo et le nom de l'agent de Meta se confondent, et ce document construit précisément une
**alternative** à l'agent de Meta. Convention tenue partout ici.

- **MBA**, ou **l'agent Meta** : le Meta Business Agent, celui de Meta, et rien d'autre. C'est déjà
  le sens du code : `mba_enabled`, `mba_handoff_mode`, `control_owner = 'mba'`, `rendreLaMainAMba`.
- **la console** : notre produit, ce qui tourne sur `mba.messagingme.app`. Les noms techniques
  (`mba-api`, `mba-worker`, `mba-web`) gardent leur graphie, ce sont des identifiants.
- **l'agent IA** : notre agent, la feature décrite ici.

**Les deux peuvent occuper le même fil, et le client choisit.** Proposer notre agent IA ne retire pas
la possibilité de configurer l'agent de Meta : ce sont deux occupants distincts, et `control_owner`
les distingue déjà. Notre agent IA vit **à l'intérieur** de `app_workflow`, donc il ne rend jamais la
main tant qu'il tient le fil, ce qui est vérifié au plan d'exécution.

Reste un arbitrage produit à trancher un jour, non bloquant pour les premiers lots : activer notre
agent IA sur un numéro doit-il forcer `mba_enabled` à faux, ou les deux cohabitent-ils scénario par
scénario ?

## Ce qui est tranché

1. **Format de l'agent** : une fiche structurée validée par Zod est la source de vérité, avec un
   rendu lisible côté client. L'IA de setup la modifie par outils, elle ne réécrit jamais un prompt
   libre. C'est le consensus du marché (Decagon AOP, Intercom Procedures, Voiceflow Playbooks), et
   l'échec le mieux documenté est l'inverse : le GPT Builder d'OpenAI écrase les instructions
   saisies à la main quand on lui demande une mise à jour.
2. **Deux rôles** : intégrateur (MessagingMe) qui voit et modifie tout, client borné au contenu.
   Le RBAC du repo sert de socle.
3. **Portée du node** : l'agent tient la conversation sur plusieurs tours jusqu'à une sortie
   prédéfinie ou une inactivité. L'inactivité rend la main au scénario.
4. **Outils** : les trois familles, outils maison + connecteurs API du client + MCP.

## Les deux vérifications à faire avant de s'engager

- **Un appel live au Vercel AI Gateway avec une clé**, pour confirmer que `gateway.cost` est bien
  présent sur la surface OpenAI-compat et voir ce que renvoie le Gateway à solde zéro. Toute la
  documentation le dit, personne ne l'a observé, et tout le modèle économique en dépend.
- **Le texte primaire Meta sur la clause « AI Providers »** des conditions WhatsApp Business
  Solution. Les fournisseurs dont l'IA est la fonctionnalité principale plutôt qu'accessoire sont
  interdits d'accès depuis le 15 janvier 2026 ; les bots métier bornés restent autorisés. La source
  est secondaire. Le cadrage retenu va dans le bon sens, le risque est commercial : la façon de
  présenter la feature peut suffire à faire restreindre le WABA.

Rappel réglementaire déjà vérifié : **l'AI Act article 50 est applicable et exécutoire depuis le
2 août 2026**. L'agent doit informer son interlocuteur qu'il parle à une IA, au plus tard au premier
message. Nous sommes fournisseur au sens de l'AI Act, le tenant est déployeur. Le pattern existe déjà en production sur
Gan Prévoyance.

---

## 1. Ce qui est différenciant, et ce qui est une case à cocher

**Différenciant, et c'est là que l'effort doit aller.**

1. **L'agent est un bloc DANS un scénario déterministe, pas un agent global.** Intercom, Decagon et
   Sierra ont tous un seul agent qui doit tout traiter, ce qui les oblige à inventer de la
   recherche d'outils et du routage. La console a déjà un graphe que le client construit et voit. Un bloc
   agent « SAV commande » n'a pas besoin des outils du bloc « prise de rendez-vous ». Cette
   différence de départ a une conséquence technique décisive, développée en section 2. Et elle
   donne une famille d'outils que personne d'autre ne peut offrir : **un outil qui déclenche un
   bloc du scénario** (envoyer la fiche produit, la photo, le formulaire). Zéro schéma, zéro
   secret, zéro appel réseau, et le bloc tourne déjà. Voir 5.4.
2. **La construction par conversation qui produit une fiche structurée**, et non un prompt libre.
   Le client revient, dit ce qu'il veut changer, et voit un diff avant que ça s'applique. Ce n'est
   pas du confort : la qualité des descriptions d'outils vaut environ +60 % de succès au niveau
   requête (Guo et al., avril 2026), et aucun client ne les écrira correctement seul. Voir
   section 5.
3. **La facturation au token réellement consommé, sur compte prépayé.** Intercom et Zendesk
   facturent à la résolution auto-déclarée, ce qui est le grief le plus documenté du marché
   (« Fin marque des tickets résolus qui ne le sont pas, et les facture »). Zendesk a dû ajouter un
   modèle d'évaluation indépendant pour valider chaque résolution facturée. Le token consommé est
   vérifiable et ne se discute pas.

**Utile mais pas différenciant : MCP.** Tout le monde l'aura d'ici douze mois. C'est une case à
cocher commerciale, pas un avantage. Il faut l'avoir, il ne faut pas y mettre l'effort en premier.

**À ne pas faire : un canvas visuel générique de construction d'agent.** OpenAI a lancé Agent
Builder puis annoncé son arrêt le 3 juin 2026, fermeture au 30 novembre 2026, en renvoyant vers le
code d'un côté et le langage naturel de l'autre. Le marché s'est scindé, le no-code générique n'a
pas tenu. Ça conforte la discipline anti-tailor-made déjà inscrite dans le CLAUDE.md du repo.

---

## 2. Le tool calling à l'échelle : le scénario est le routeur

C'est le point où la première version se trompait, et c'est le plus important du document.

**Ce qui était proposé et qui est retiré** : une présélection d'outils par embeddings, un outil
`chercher_un_outil` appelable par le modèle, un gel de la shortlist pour la conversation, une
détection de doublons sémantiques à la déclaration, et une métrique de rang dans la shortlist.

**Pourquoi c'était faux.** Deux raisons, la seconde étant la vraie.

D'abord, le mécanisme créait lui-même le problème qu'il devait résoudre. Les définitions d'outils
sont le premier segment du préfixe de cache chez Anthropic, et en modifier une invalide le cache
entier. Une shortlist qui bouge d'un tour à l'autre refacture donc tout à plein tarif, à chaque
tour, là où un préfixe stable se relit à 0,1x.

Ensuite, et surtout, ce mécanisme répond à un problème que la console n'a pas. Une recherche d'outils est
nécessaire quand un agent unique doit couvrir tout le périmètre d'un client. Ici, le périmètre est
déjà découpé par le graphe que le client a dessiné.

**La règle produit qui remplace tout ça.**

- **20 outils actifs au maximum par bloc agent.** Le seuil vient de la guidance éditeur (OpenAI
  « fewer than 20 functions at the start of a turn », Google « keep active set to 10-20 tools
  maximum ») et de l'étude Superhuman où `k=20` est la taille de shortlist qui récupère environ +10
  points de F1 sur un catalogue de 584 outils. Mais **sa vraie justification chez nous est le coût
  et la lisibilité**, pas la précision : voir plus bas.
- **128 outils déclarés au maximum**, contrôlé à l'enregistrement. Ce n'est pas un seuil de qualité,
  c'est une limite dure de portabilité : OpenAI et Gemini renvoient un 400 au-delà. Un agent à 200
  outils cesse d'être routable vers la moitié du catalogue du Gateway.
- **10 outils au maximum par serveur MCP connecté.** Le serveur MCP GitHub expose 93 outils pour
  environ 55 000 tokens de définitions. Un seul serveur branché sans sélection tue le budget d'un
  agent en une action.
- **Sous 10 outils, on n'ajoute aucun mécanisme.** Anthropic le dit explicitement : le tool calling
  standard est alors le bon choix, et une recherche d'outils est nuisible.

**Ce que l'interface dit quand un client dépasse 20.** Pas « ne t'inquiète pas, on cherchera pour
toi ». Elle dit : cet agent fait trop de choses, coupe-le en deux blocs dans ton scénario. C'est
plus simple à construire pour nous, ça donne un meilleur taux de bonne sélection d'outil, et ça
laisse au client un scénario lisible plutôt qu'une boîte noire. Le graphe existe déjà, il fait le
travail gratuitement.

**Bénéfice de bord, non négligeable.** Sans shortlist, le préfixe d'outils ne bouge jamais pendant
une conversation. Le cache de prompt joue à plein sur toute la session, et le risque de
refacturation identifié plus haut disparaît avec le mécanisme qui le créait.

**Ce qui casse vraiment un agent outillé, et ce n'est pas le nombre d'outils.** Correction apportée
par le terrain du 2026-08-26, contre la révision 2 de ce document : passer de « seulement les
schémas pertinents » à 128 schémas de fonctions coûte en moyenne **-2,3 %** sur 14 modèles de 2026,
et deux modèles s'**améliorent** (Claude Sonnet 5, +2,8 %). Le coude de dégradation mesuré se situe
vers 200 à 300 outils, pas à 20.

Ce qui casse, c'est le **régime** : choisir parmi des outils plausibles mais faux, puis enchaîner
plusieurs appels. La preuve tient en un chiffre : **`claude-haiku-4.5` est 6e sur 109 à BFCL V4
(68,70) et dernier sur 30 à MCP-Atlas (40,20)**. Même modèle, même prix. BFCL note l'appel isolé,
MCP-Atlas note l'orchestration de 3 à 6 appels parmi 10 à 25 outils dont 5 à 10 distracteurs
plausibles. Le nombre d'outils est notre **proxy observable** de ce régime, pas sa cause.

Conséquence directe, et elle est de l'honnêteté élémentaire : **on ne justifie jamais le plafond de
20 au client par une dégradation de sélection.** La littérature le dément frontalement. On le
justifie par le coût des définitions à chaque tour, par la latence, et par la lisibilité du
scénario. Ne jamais écrire dans une doc client une affirmation qu'une source publiée dément.

Trois leviers pour la qualité des appels, tous testables unitairement, tous peu coûteux :

- `strict: true` sur les outils **maison** uniquement, où l'on maîtrise le schéma. Les schémas MCP
  tiers ne le satisfont presque jamais et OpenAI retombe de toute façon en best-effort.
- **Énumérations fermées** partout où une valeur est bornée (statut, canal, langue, type de tag).
- **Un exemple d'appel** sur tout outil à objet imbriqué. Anthropic mesure 72 % vers 90 % de
  précision pour 20 à 200 tokens par exemple.

**Ce que l'interface garde.** Une jauge « 14 / 20 outils actifs », un blocage à l'enregistrement
au-delà de 20, et le coût des définitions affiché en tokens et en euros. Trois éléments, pas un
sous-système.

---

## 3. L'architecture : un descripteur, trois résolveurs

Les trois familles ne se distinguent **que par leur résolveur**. Validation des arguments,
résolution des paramètres non confiés au modèle, budget de temps, journalisation, assainissement,
transformation de l'erreur en résultat lisible par le modèle : tronc commun unique, écrit une fois.
C'est ce qui empêche la famille MCP, la plus chère, de contaminer la boucle avec ses cas
particuliers.

Corollaire posé d'emblée : **la boucle de tool calling est à nous.** Ce n'est pas un choix de
confort. Vercel dit explicitement que le AI Gateway gouverne l'appel modèle et pas l'appel outil,
et aucun type d'outil `mcp` n'est documenté sur ses trois surfaces. De toute façon, un compte
prépayé par tenant impose de voir chaque appel pour l'attribuer.

### 3.1 Le champ qui règle le problème du contact non authentifié

C'est le point de conception le plus important du descripteur, et le moins évident.

Chaque paramètre d'outil porte une **source** :

- `modele` : le LLM remplit. **Seuls ces paramètres entrent dans le schéma envoyé au modèle.**
- `contact` : dérivé du `wa_id` authentifié par la signature du webhook Meta, ou d'un champ de la
  fiche contact. Le modèle ne le voit pas et ne peut donc pas le fabriquer.
- `fixe` : constante du tenant (identifiant de compte, code boutique).

Conséquence : le modèle ne choisit **jamais** une cible réseau ni un identifiant de ressource. Une
injection réussie dans le message d'un contact ne lui donne pas la commande d'un autre. Intercom a
dû inventer exactement ce champ pour le même problème, et a même ajouté un OTP par email et la règle
« request by ID rather than name to avoid ambiguity ». Sans ça, un connecteur client est un IDOR
offert au premier venu qui écrit sur le numéro.

### 3.2 Le schéma

**Quatre tables**, pas six. Le catalogue d'outils appartient à l'agent, il n'y a pas de table de
jonction : personne n'a demandé à partager un outil entre plusieurs agents, et on l'ajoutera le jour
où quelqu'un le demandera.

```sql
-- 0075 : les sources externes (rien pour les outils maison)
create table agent_tool_sources (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  kind             text not null check (kind in ('http','mcp')),
  label            text not null,
  base_url         text not null,        -- figée côté console, le modèle ne la choisit jamais
  auth_kind        text not null check (auth_kind in ('none','bearer','header')),
  auth_header_name text,
  auth_secret      text,                 -- chiffré par src/crypto/secretbox.ts
  status           text not null default 'draft'
                   check (status in ('draft','active','disabled')),
  last_ok_at       timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index agent_tool_sources_label_idx on agent_tool_sources (tenant_id, lower(label));

-- 0075 : la fiche d'agent
create table agents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  label              text not null,
  -- ce que l'IA de setup peut écrire, validé par ficheAgentSchema (Zod safeParse)
  fiche              jsonb not null,
  fiche_version      int  not null default 1,
  -- ce qu'elle ne peut pas écrire : colonnes hors du jsonb, écrites par un admin authentifié
  mention_ia         text not null,
  max_tours          int  not null default 8  check (max_tours between 1 and 20),
  max_appels_outils  int  not null default 12,
  budget_micro_eur   bigint not null default 30000,
  inactivite_minutes int  not null default 30 check (inactivite_minutes between 1 and 1440),
  contact_inconnu    text not null default 'lecture_seule'
                     check (contact_inconnu in ('aucun_outil','lecture_seule','tous')),
  modele             text not null,
  status             text not null default 'draft' check (status in ('draft','active','disabled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index agents_label_idx on agents (tenant_id, lower(label));

-- 0075 : le catalogue, unifié pour les trois origines
create table agent_tools (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  agent_id      uuid not null references agents(id) on delete cascade,
  source_id     uuid references agent_tool_sources(id) on delete cascade,
  origin        text not null check (origin in ('mba','http','mcp')),
  name          text not null,        -- exposé au modèle : ^[a-z0-9_]{1,64}$, préfixé par famille
  title         text not null,
  description   text not null,
  ne_pas_utiliser text not null,      -- clause de non-usage, jamais vide
  params        jsonb not null,       -- nom, type, source, description, défaut, enum
  binding       jsonb not null,       -- méthode, gabarit de chemin, nom distant : jamais du modèle
  output_paths  text[] not null default '{}',
  risk          text not null check (risk in ('read','write','irreversible')),
  timeout_ms    int  not null default 8000 check (timeout_ms between 1000 and 30000),
  max_bytes     int  not null default 16384,
  actif         boolean not null default false,
  active_par    uuid references users(id),
  active_le     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index agent_tools_name_idx on agent_tools (agent_id, name);
alter table agent_tools add constraint agent_tools_origin_src_chk
  check ((origin = 'mba' and source_id is null) or (origin <> 'mba' and source_id is not null));
-- un outil n'est actif que si un humain l'a activé : la garde est en BASE, pas en code
alter table agent_tools add constraint agent_tools_actif_humain_chk
  check (actif = false or active_par is not null);
```

La dernière contrainte porte tout le dispositif de consentement. La spec MCP exige un consentement
humain avant l'invocation d'un outil, et notre agent n'a pas d'humain au runtime. On **déplace donc
le consentement du runtime vers la configuration**, et on le rend structurellement impossible à
contourner : un `UPDATE` qui passe un outil en actif sans main humaine échoue en base.

Le schéma JSON envoyé au modèle est **dérivé** de `params` par une fonction pure, il n'est pas
stocké. Une seule source de vérité, et c'est le seul endroit où l'on garantit les bornes de
portabilité (profondeur 10, `additionalProperties: false`, pas de `$ref` réseau, pas de mot-clé
2020-12 sans équivalent draft-07). Un schéma non conforme est refusé **à la déclaration**, pas au
premier appel en production.

```sql
-- 0076 : l'état multi-tours et le journal (qui est aussi le grand livre de facturation)
create table agent_sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  run_id            uuid not null references workflow_runs(id) on delete cascade,
  agent_id          uuid not null references agents(id) on delete cascade,
  node_id           text not null,
  wa_id             text not null,
  transcript        jsonb  not null default '[]'::jsonb,
  tours             int    not null default 0,
  appels_outils     int    not null default 0,
  tokens_in         bigint not null default 0,
  tokens_out        bigint not null default 0,
  cout_micro_eur    bigint not null default 0,
  status            text not null default 'en_cours'
                    check (status in ('en_cours','sortie','inactivite','plafond','erreur')),
  sortie            text,
  derniere_activite timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
-- une seule session vivante par parcours : l'invariant est en base, pas dans une convention
create unique index agent_sessions_run_vivante_idx
  on agent_sessions (run_id) where status = 'en_cours';

create table agent_tool_calls (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  session_id     uuid not null references agent_sessions(id) on delete cascade,
  tool_id        uuid references agent_tools(id) on delete set null,
  tool_name      text not null,
  origin         text not null,
  args_rediges   jsonb,
  status         text not null check (status in
                   ('ok','erreur_outil','refuse','timeout','erreur_protocole','budget')),
  http_status    int,
  duree_ms       int,
  taille_reponse int,
  erreur         text,
  at             timestamptz not null default now()
);
create index agent_tool_calls_session_idx on agent_tool_calls (tenant_id, session_id, at);
```

Les colonnes propres à MCP (nom distant, empreinte de définition approuvée, ère de protocole) et
celles propres à OAuth arrivent avec leur lot, par `alter table ... add column if not exists`. Le
repo étend `tenant_settings` de cette façon depuis huit migrations, c'est la convention maison.

### 3.3 Le tronc commun

```
1. RÉSOUDRE    catalogue.byName(tenantId, agentId, name), actif = true
               absent -> { refuse }, jamais une exception
2. AUTORISER   risque autorisé ? contact connu ? plafond d'appels ? budget restant ?
               risk = 'irreversible' -> jamais ici, sortie vers l'inbox
3. VALIDER     Zod safeParse dérivé des params source='modele'. Jamais de `as`.
               Échec = { args_invalides } rendu au modèle, pas un throw
4. COMPLÉTER   paramètres 'contact' et 'fixe' injectés par le runtime.
               C'est ici que le modèle perd la main sur la cible
5. JOURNALISER insert agent_tool_calls AVANT l'appel (at-least-once : on veut la trace
               d'une tentative même si le process meurt)
6. APPELER     résolveur selon binding.kind, sous AbortSignal = min(timeout, deadline du tour)
7. ASSAINIR    extraction des output_paths, troncature, résultat encadré en bloc délimité
8. CLORE       update du statut, de la durée, des compteurs de session
```

**`execute` ne lève jamais.** Une exception qui remonte tue le tour, alors que le modèle sait se
corriger sur une erreur d'exécution. C'est la leçon directe de hyundai, où un slug inconnu renvoie
`{ erreur: "slug inconnu, utilise un slug du catalogue" }` et où le modèle se rattrape seul. La spec
MCP l'exige d'ailleurs par le même mécanisme (`isError: true` est un résultat, pas une erreur).

Seule exception : une erreur de protocole, qui est un bug de notre client. Elle arrête le tour, elle
est journalisée et alertée, elle ne repart pas vers le modèle.

### 3.4 Ce que fait chaque résolveur, et lui seul

**`mba`.** Une table de correspondance `handler` vers fonction TypeScript, en dur. Aucun réseau.
Ces outils sont les seuls à mériter `strict: true`. Noyau proposé : terminer par une sortie,
escalader vers un humain, poser un tag, lire la fiche contact, enregistrer une réponse de
formulaire, et **`mba_envoyer_bloc`**, qui déclenche un bloc du scénario courant (`code` en
énumération fermée, validée contre le graphe). Ce dernier est la famille d'outils la plus utile et
la moins chère du produit, et elle n'existe que parce que le graphe existe.

**`http`.** Construit l'URL à partir de `source.base_url + binding.pathTemplate`, avec les seules
valeurs validées. Le gabarit d'URL n'est jamais un argument du modèle. Les en-têtes
d'authentification sont déchiffrés au moment de l'appel et n'entrent jamais dans le contexte. La
sortie passe obligatoirement par `output_paths`, jamais en entier : c'est le consensus de tout le
marché (Intercom, Zendesk en JSONata, ManyChat en JSONPath, Voiceflow en object path), et c'est
aussi une ligne de facturation directe.

**`mcp`.** `@modelcontextprotocol/client` 2.0.0, pas `@modelcontextprotocol/sdk` 1.x : le v1 embarque
express 5, hono, cors, ajv et jose pour un usage où l'on n'ouvre aucun serveur, et il ne parlera
jamais la révision 2026-07-28. Un client par job, fermé dans un `finally` : depuis le 2026-07-28 le
protocole est **sans état**, une connexion ouverte n'est ni une session ni une conversation, et le
verdict d'ère persisté rend `connect(transport, { prior })` gratuit, zéro aller-retour. Le résolveur
ne décide de rien : ni du nom exposé, ni du schéma, ni de l'autorisation, qui viennent tous de
`agent_tools`.

Point à ne pas rater : **on ne fait jamais `tools/list` pendant une conversation.** La liste est lue
dans la console au moment où le client choisit ses outils, figée en base avec son empreinte, et
rejouée telle quelle. C'est ce qui ferme d'un coup le rug pull, le line jumping et l'inflation de
contexte.

---

## 4. La boucle

### 4.1 Le bloc dans le graphe

Ajout de `'agent'` à `WORKFLOW_NODE_TYPES` (`src/workflow/graph.ts:29`) et d'un état au `WalkRest`,
**sur le modèle exact de `rcs_send`** : ce n'est pas un état de repos, c'est une main rendue. Le
`walk` est pur et ne peut pas savoir ce que le modèle décidera ; l'exécuteur enfile un tour et
reprend plus tard par le handle de sortie.

Ce statut ne doit jamais atteindre `restToState` (`src/workflow/executor.ts:191`), exactement comme
`rcs_send` aujourd'hui. Il y a déjà un précédent et un commentaire à recopier.

**Piège vérifié, et il est sérieux.** Ajouter `'agent'` à la liste des types sans toucher `walk`
produit un bloc que le moteur **traverse en silence** : après les cas explicites, `actionOf` rend
`null` et le parcours continue au node suivant (`src/workflow/engine.ts:487-495`). C'est le mode de
panne muet que le repo combat partout ailleurs. Et aucun test ne relie `WORKFLOW_NODE_TYPES` au type
miroir de `web/lib/api.ts:1282`.

Les **sorties prédéfinies** sont des handles d'arête, comme `btn:<i>` pour un template. Le client
les câble visuellement. Handles réservés par la plateforme, toujours présents :
`sortie:inactivite`, `sortie:plafond`, `sortie:echec`.

### 4.2 Où tourne le tour

**File dédiée `agent-turn`**, ajoutée à `BASE_QUEUES` et à `QUEUE_POLLING_SECONDS` avec 2 s, même
cadence que `webhook` puisque c'est un chemin conversationnel. Le test `tests/queue-names.test.ts`
casse sinon, c'est voulu.

Pourquoi pas en ligne dans `executor.apply` comme le reste du produit : un tour d'agent, c'est un
appel LLM plus N appels d'outils, soit 3 à 20 secondes. Le laisser dans le handler de webhook, c'est
tenir la connexion Meta ouverte et faire retenter le webhook par Meta pendant qu'on parle au modèle.
Le job `webhook` sert tous les messages entrants de tous les tenants, et sa cadence a déjà été
descendue à 2 s pour contenir l'egress Supabase : ce budget est surveillé de près.

### 4.3 L'inactivité, sans nouveau balayage

La première version proposait un second sweeper calqué sur `runWorkflowWakeSweep`. Retiré.

`pg-boss` sait différer un job (`startAfter`), et le `schedule: false` posé volontairement dans
`src/queue/pgboss.ts` ne désactive que le **cron** de pg-boss, pas les jobs différés, qui passent par
la requête de récupération normale. Le wrapper `Queue` du repo n'expose aujourd'hui que
`singletonKey` et `expireInSeconds` : y ajouter `startAfter` fait trois lignes dans `queue.ts`,
`pgboss.ts` et `fake.ts`.

Donc : quand l'agent pose une question et attend, on enfile un `agent-turn { raison: 'inactivite',
tours: N }` avec `startAfter = inactivite_minutes`. Si le contact répond avant, le compteur de tours
a avancé, et le job différé sort sans rien faire. **Zéro balayage, zéro colonne, zéro requête
nouvelle**, et le verrou optimiste dont on a besoin de toute façon fait le double travail.

Ce verrou, justement : pg-boss est at-least-once, et un tour rejoué enverrait un second message
WhatsApp et rappellerait les outils. La parade est la même mécanique que le `last_message_id` déjà
en place sur `workflow_runs` :

```sql
update agent_sessions set tours = tours + 1, derniere_activite = now()
 where id = $1 and status = 'en_cours' and tours = $2
returning id;
```

Zéro ligne rendue vaut rejeu, on sort sans rien faire. Et `retryLimit` bas (2) sur cette file :
mieux vaut une conversation qui sort par `sortie:echec` avec le message de repli déclaré par le
client qu'une conversation qui reçoit trois fois la même relance.

### 4.4 Le flux

```
scénario       walk atteint le bloc agent -> rest 'agent_turn'
executor       crée agent_sessions, run reste 'waiting' sur le bloc agent
               enfile agent-turn { raison: 'demarrage' }

job            appel modèle, appels d'outils, envoi WhatsApp, puis trois issues :
  (a) question posée      -> tours += 1, enfile agent-turn différé (inactivité)
  (b) sortie prédéfinie   -> session 'sortie', reprise du scénario sur sortie:<code>
  (c) plafond atteint     -> session 'plafond', reprise sur sortie:plafond

contact répond webhook -> advance() : le bloc courant est de type 'agent'
               -> branche unique : on n'appelle pas walk, on ajoute le message au
                  transcript et on enfile agent-turn { raison: 'message' }
```

Une seule branche à ajouter dans `advance()` (`src/workflow/executor.ts:637`). Le reste de la
machine à états du scénario est intact. C'est le chemin le plus chaud du produit et il porte déjà
la cicatrice de la régression du 2026-08-20, donc cette branche mérite son test de non-régression
vérifié dans les deux sens.

### 4.5 Anti-boucle

Le `Set visited` de `walk` protège un pas, pas un enchaînement de jobs. D'où les compteurs
explicites de `agent_sessions`, exactement comme `MAX_RCS_ENCHAINES` borne l'enchaînement de walks :
`tours`, `appels_outils`, `cout_micro_eur`, plus une deadline de tour de 30 s. Chaque plafond
franchi sort par `sortie:plafond`, jamais par un arrêt muet. C'est une garde de sécurité, pas un
détail de facturation : une injection qui fait boucler l'agent brûle le compte prépayé du tenant.

---

## 5. La conversation de construction

C'est le lot L3, et la brique différenciante numéro deux. La révision 2 la décrivait en un
paragraphe, ce qui était une erreur de proportion.

### 5.1 Le principe : elle propose, le client corrige

L'anti-pattern est un agent qui pose quarante questions à la file. Ce serait un formulaire avec plus
de friction. Le principe inverse : **la conversation part de ce que le client sait dire, et déduit
le reste.**

Ce qu'un client sait dire : son métier, ce que ses clients lui demandent, son site, ses fichiers.
Ce qu'il ne sait pas dire : son périmètre de refus, ses règles d'arrêt, un schéma d'outil, un modèle
de langage. Donc l'IA de setup pose peu de questions et **propose beaucoup**. Chaque proposition
passe par un diff que le client garde, jette ou fait réessayer. C'est le flux d'Intercom (« Let AI
draft your procedure », puis Keep / Clear / Try again), et c'est l'inverse du GPT Builder, qui
écrase en silence.

**Le chiffre qui justifie la brique à lui seul.** Guo et al. (arXiv 2602.20426, avril 2026) mesurent
l'effet de la qualité des descriptions d'outils sur un catalogue de plus de 150 outils candidats :
réécrire des descriptions écrites par des humains réduit la dégradation de précision de **29,23 %**
et améliore le succès au niveau requête de **60,89 %** en moyenne. Les cinq défauts récurrents
identifiés sont le périmètre flou, les contraintes de paramètres manquantes, les dépendances non
documentées, la sémantique de sortie ambiguë et les préconditions implicites. Aucun client ne les
évitera seul. L'IA de setup n'est donc pas un confort d'ergonomie, c'est ce qui produit un agent qui
marche.

### 5.2 Les dix premières minutes, concrètement

**Ce que l'historique WhatsApp nous évite de demander.** La console détient déjà les conversations du
tenant. C'est le seul actif que Decagon (téléversement de transcriptions), Voiceflow et Copilot
Studio n'ont pas par défaut. On l'exploite pour **ne poser aucune question dont on a la réponse** :
les cinq motifs les plus fréquents des trente derniers jours avec leur volume, les formulations
réelles des clients mot pour mot, les réponses que les humains ont effectivement écrites (donc le
ton, la longueur type et le vouvoiement, proposés déjà renseignés), la langue, les horaires, le
volume quotidien, et les questions restées sans réponse ou escaladées.

On inverse la charge : **le client ne décrit pas, il reconnaît et il corrige.** C'est la réponse au
constat de « Why Johnny Can't Prompt » sur dix non-techniciens : exploration opportuniste,
sur-généralisation après un seul essai, difficulté déclarée à formuler.

**Minute 0 à 1. On ne demande rien, on montre.** Les cinq motifs extraits, chacun avec son volume et
deux verbatims clients bruts, non reformulés.

> Voici ce que vos clients vous ont écrit ces trente derniers jours. Lequel de ces sujets voulez-vous
> confier à l'agent en premier ?

Un seul choix. Question fermée.

**Minute 1 à 2. Verrouiller le sujet par ses verbatims, pas par son intitulé.** Huit messages réels
tirés de son historique, proches du sujet choisi.

> Cochez ceux où l'agent doit prendre la main.

puis, écran suivant, même liste :

> Et maintenant, cochez ceux où il ne doit surtout **pas** répondre.

On récolte des exemples positifs **et négatifs**. Les négatifs sont la moitié qui protège, et c'est
la seule façon d'obtenir un contre-exemple d'un client qui n'en produira jamais spontanément.

**Minute 2 à 3. Définir la fin avant le milieu.** Deux questions, une à la fois.

> Quand est-ce que c'est bien terminé, pour vous ? Le client a eu quoi, exactement, à la fin ?

> Et à quel moment ça doit s'arrêter et vous revenir ?

Ce sont les règles d'arrêt. On ne demande **jamais** « quel est le parcours » ni « quelles étapes ».
Un patron de PME sait dire ce qu'il attend à la fin, il ne sait pas décrire un enchaînement.

**Minute 3 à 4. Les outils, sans prononcer le mot outil.**

> Pour répondre à ça, l'information est où aujourd'hui ? Vous, quand un client vous pose la
> question, vous regardez où ?

> Vous avez besoin de le savoir en direct, ou l'information ne bouge pas ?

Interdit absolu : « quels outils voulez-vous activer », « avez-vous une API », « avez-vous un
serveur MCP ». Ce sont deux fautes documentées d'entretien d'élicitation, la question technique et
la demande d'une solution plutôt que d'un besoin. Le mapping vers nos trois familles se fait après,
par nous. C'est aussi ici que se calcule le nombre d'outils, donc la recommandation de modèle de
5.5, qui s'affichera à la minute 9.

**Minute 4 à 7. Les cas limites. C'est le cœur.** Format imposé : **cinq cas concrets**, jamais une
question ouverte du type « et les cas particuliers ? ». Chaque cas est un message client, tiré de
son historique quand il existe, avec trois boutons : l'agent répond, l'agent refuse et vous passe la
main, l'agent pose une question avant.

1. « Bonjour, je veux me faire rembourser, le produit ne me convient pas. »
2. « Ça fait trois fois que je vous écris. Si je n'ai pas de réponse aujourd'hui, je saisis un avocat. »
3. « Vous vendez toujours le modèle X ? » (sur un produit retiré du catalogue)
4. « Vous pouvez me faire un geste, 20 % ? »
5. « C'est pour un cadeau, vous livrez avant le 24, c'est sûr ? »

Chaque clic écrit une ligne dans les refus ou dans les règles d'arrêt. **Le client ne rédige rien.**

Pourquoi des cas et pas un questionnaire : PolicyCraft mesure **74 % contre 23 %** et **73 % contre
37 %** de politiques obtenant un soutien majoritaire quand la délibération est ancrée sur des cas
concrets plutôt que sur des règles abstraites. Case Law Grounding mesure **+16,0 à +23,3 points**
d'exactitude côté humain sur le même mécanisme.

**Règle de dialogue à câbler ici** : si le client répond « ça dépend », **ne pas** enchaîner sur
« ça dépend de quoi ? », qui est la faute la plus fréquente du corpus d'entretiens. Basculer
immédiatement sur deux cas concrets à trancher. Le « ça dépend » est notre meilleur détecteur de cas
limite non spécifié.

**Minute 7 à 8. Le périmètre par ses bords, en cases pré-cochées.** Cinq cases pré-cochées par
secteur, que le client **décoche** : ne jamais négocier un prix, ne jamais s'engager sur un délai
ferme, ne jamais confirmer un remboursement, ne jamais donner un avis médical ou juridique, ne
jamais inventer. Le périmètre négatif est précisément ce qu'un client n'écrit jamais spontanément :
c'est au produit de le proposer.

**Minute 8 à 9. Relire la fiche comme une interprétation à corriger.** Titre exact à l'écran :

> Voilà ce que j'ai compris. Dites-moi ce qui est faux.

Chaque ligne porte un bouton « ce n'est pas ça », et le champ le plus incertain est mis en évidence.
La formulation « ce que j'ai compris » plutôt que « votre agent est prêt » est une contre-mesure
d'ancrage dont l'effet est mesuré (co-rédaction avec un modèle orienté : 45 % contre 35 %, p < 0,001),
et le prédicteur le plus fort de la sur-acceptation est l'enthousiasme du client envers
l'automatisation. C'est ici qu'apparaît le profil de modèle recommandé, avec sa phrase de
justification et un ordre de grandeur en conversations.

**Minute 9 à 10. Montrer avant de valider.** Rejouer **trois conversations réelles de son
historique** à travers l'agent tel que spécifié, côte à côte avec ce que l'humain avait
effectivement répondu à l'époque. Un bouton unique : « ce n'est pas ce que j'aurais dit », qui
rouvre le point concerné.

C'est le seul moment où les vrais critères du client apparaissent. Le phénomène est documenté sous
le nom de *criteria drift* : on a besoin de critères pour juger des sorties, mais c'est en jugeant
des sorties qu'on définit ses critères. Un questionnaire seul, avant toute sortie observée, ne peut
structurellement pas capturer le critère réel.

**Le seul blocage dur.** On ne peut ni tester ni publier tant que la fiche n'a pas : un rôle et un
périmètre, au moins un exemple positif **et** un exemple négatif de déclenchement, au moins une
règle d'arrêt, au moins une source de connaissance. Blocage sur champs vides, **jamais sur une
qualité sémantique** : aucun produit du marché ne bloque sur du flou, et un détecteur sémantique qui
refuse serait un mur arbitraire. La revue au moment d'enregistrer produit des recommandations, pas
un refus.

Puis le test. L'agent se joue dans le panneau existant, et l'IA de setup **génère elle-même les cas
limites** à partir de la fiche, comme les Simulations d'Intercom (« Fin generates Simulations
directly from your Procedures, suggesting realistic edge cases »). Ces cas sont stockés et
rejouables d'un bouton. Sans suite de tests rejouable, chaque re-conversation avec le constructeur
est une régression invisible.

### 5.3 Ingérer le site ou pointer dessus : comment le dire au client

Deux phrases, pas un choix technique.

> **On lit votre site une fois et on en fait des fiches.** Vous les voyez, vous les corrigez, et
> l'agent répond avec. Il ne relit pas votre site à chaque question, donc c'est plus rapide et ça
> coûte moins cher. En échange, quand votre site change, il faut relire.

> **Ou l'agent va chercher sur votre site à chaque question.** Toujours à jour, mais plus lent, plus
> cher, et surtout vous ne pouvez pas corriger une mauvaise réponse : elle vient de ce qu'il a lu.

**Recommandation : ingérer par défaut.** Trois raisons, la troisième étant la plus forte.

Le coût d'abord : une page entière entre dans le contexte à chaque appel, contre quelques extraits
pertinents si elle est découpée et indexée. La latence ensuite, dans une conversation WhatsApp où le
contact attend. Et surtout **le contrôle** : le contenu ingéré est éditable, donc une mauvaise
réponse se corrige en trente secondes. Une réponse tirée d'une lecture en direct ne se corrige qu'en
modifiant le site.

Le marché va dans le même sens, et personne ne pointe en direct comme source principale : Voiceflow
ingère URLs, sitemap, documents et tableurs avec une cadence de resynchronisation configurable par
source (jamais, quotidienne, hebdomadaire, mensuelle), Intercom impose un re-crawl hebdomadaire
fixe. Le constat récurrent du marché est que la cause dominante des mauvaises réponses est le
contenu périmé, pas le modèle. D'où une conséquence produit qui vaut plus qu'un meilleur modèle :
**la date de dernière lecture visible par source, et une alerte quand une source n'a pas été
rafraîchie.**

La lecture en direct garde un usage, mais **comme un outil et non comme une source** : un
`chercher_sur_le_site` pour les données volatiles (stock, horaires exceptionnels, disponibilité).
C'est l'agent qui décide d'y aller quand la question l'exige, pas à chaque tour.

### 5.4 Les quatre familles d'outils, dites en langage client

Le client ne choisit jamais entre HTTP et MCP. Il dit ce qu'il veut, l'IA choisit la famille.

| Le client dit | L'IA propose | Ce que c'est techniquement |
|---|---|---|
| « qu'il envoie la fiche produit, la photo, le formulaire » | un outil qui **déclenche un bloc de votre scénario** | outil maison, pointe un `node.data.code` du graphe |
| « qu'il aille voir où en est la commande » | un connecteur vers votre système | famille HTTP, formulaire en 4 phases plus test réel |
| « qu'il crée un ticket dans Linear, une page Notion » | un branchement à l'outil que vous utilisez déjà | famille MCP |
| « qu'il tague, qu'il remplisse une fiche, qu'il passe la main » | inclus d'office | outils maison |

**La première ligne n'existe nulle part ailleurs, et c'est la plus simple des quatre.** Le client a
déjà des blocs dans son scénario : un message rapide avec une photo, un formulaire WhatsApp, un
template. L'agent peut les déclencher. Pour lui c'est trivial à formuler : « quand on demande une
photo de la pièce, envoie le bloc Photo pièce ». Zéro schéma, zéro secret, zéro appel réseau, et
l'outil est déjà testé puisque le bloc tourne déjà dans son scénario.

Le patron est validé ailleurs : chez Make, un outil d'agent est un scénario existant enrobé d'un nom
et d'une description. La différence est que leur scénario est une automatisation abstraite, alors
qu'ici c'est **un bloc que le client a dessiné et qu'il voit sur son canevas.**

Concrètement, `mba_envoyer_bloc` prend un `code` de bloc parmi ceux du scénario courant, en
**énumération fermée**. Le modèle ne peut donc pas inventer un identifiant. Le rappel du parc est
utile ici : chez UChat, `send-node` répond `ok` même pour un node inexistant, donc aucun log ne
prouve une livraison. L'énumération fermée plus la validation contre le graphe rendent ce cas
impossible.

Pour la famille HTTP, le formulaire en quatre phases est le consensus du marché (Intercom : API,
Data, Fin, Security, avec convergence chez Voiceflow, Zendesk et Copilot Studio). L'IA de setup le
remplit à partir de ce que le client raconte et de la réponse d'un appel de test réel, comme le font
déjà Zapier Custom Actions et Macha. Deux points non négociables, tirés du terrain :

- **Un connecteur ne passe pas en actif tant qu'un appel de test n'a pas réussi**, et le test exécute
  la chaîne complète, sélection des champs de sortie comprise. Le piège documenté chez ManyChat est
  que leur test n'exécute pas le mapping : le client croit que ça marche.
- **La réponse ne remonte jamais en entier**, on coche les champs sur la réponse de test. Tout le
  marché a tranché ainsi (Intercom champ par champ, Zendesk en JSONata, ManyChat en JSONPath,
  Voiceflow en object path). Chez nous, `web/components/ArbreJson.tsx` et `web/lib/chemin-json.ts`,
  déjà écrits pour les webhooks entrants, font exactement ce travail.

### 5.5 Le modèle n'est pas choisi par le client, il est dérivé de la fiche

La révision 2 proposait trois profils au choix, rangés sur un seul axe économique vers capable.
C'est faux, et le terrain du 2026-08-26 le démontre par le contre-exemple donné en section 2
(`claude-haiku-4.5`, 6e à BFCL et dernier à MCP-Atlas). **On ne demande donc pas au client de
choisir : on dérive la recommandation de sa fiche, et on lui explique en une phrase.**

**Ce qu'on lit dans la fiche, et rien d'autre.** Trois champs, tous déjà présents.

| Champ | Pourquoi lui | Ce qu'on ne lit pas, et pourquoi |
|---|---|---|
| `outils.length` | Seule variable pour laquelle un banc existe dans notre régime exact (MCP-Atlas, 10 à 25 outils exposés) | La taille de la base de connaissance : aucune mesure ne la relie à la fiabilité d'appel |
| présence d'un outil d'écriture | L'effort de raisonnement fait 84,8 % contre 61,6 % sur tau2-bench, l'écart montant à 89,7 contre 57,2 sur le domaine le plus outillé. Une action irréversible mérite le cran supérieur | Le poids en tokens des définitions : il pilote le coût, pas la fiabilité. Il ne doit pas entrer dans le choix de modèle |
| résidence UE du tenant | Contrainte dure : `gpt-5.6-luna` et `gpt-5.6-sol` ne sont servis qu'en `us` | La criticité déclarée : elle change le réglage (confirmation avant action), pas le modèle |

**La règle.**

| Fiche | Modèle recommandé | Preuve |
|---|---|---|
| 0 outil | `google/gemini-3.1-flash-lite` | TTFT p50 623 ms, le moins cher disponible en UE. La preuve négative de la lignée porte sur la capacité d'**appeler**, elle ne s'applique pas sans outil |
| 1 à 4 outils | `anthropic/claude-haiku-4.5` | BFCL V4 rang 6 sur 109 (68,70), Irrelevance 85,11, TTFT 578 / 845 ms, le p95 le plus serré du catalogue. Régime que BFCL mesure : peu d'outils, séquences courtes |
| 5 à 20 outils | `openai/gpt-5.6-sol` | **MCP-Atlas 81,80**, protocole identique au nôtre. Confirmé par tau3-Banking 46,9 %, rang 4 sur 17. Seul modèle du catalogue avec deux mesures concordantes en multi-outils |
| 5 à 20 outils, résidence UE | `anthropic/claude-sonnet-5` | **Provisoire.** Une seule mesure connue, mais c'est l'un des deux seuls modèles sur 14 à s'**améliorer** sous inondation à 128 schémas (+2,8 %), soit exactement la propriété cherchée |

Plus une règle d'exclusion prioritaire sur tout le reste : **dès qu'il y a un outil, la lignée
flash-lite sort du catalogue.** Trois signaux convergents, dont deux internes : BFCL V4 donne à
`gemini-2.5-flash-lite` une Relevance de **43,75** pour une Irrelevance de 92,50 (le profil « il
n'appelle pas »), `gemini-3.1-flash-lite` est 26e sur 30 à MCP-Atlas, et odalys comme Gan
Prévoyance ont abandonné cette lignée pour ce motif exact.

**Le seuil de 4 est arbitraire et signalé comme tel.** Aucune source publiée ne donne de courbe
score contre nombre d'outils dans la plage 5 à 20, qui est précisément la nôtre. C'est la mesure la
plus rentable à faire en premier (voir 5.6).

**Le client garde la main, avec un seul garde-fou.** S'il choisit un flash-lite alors que sa fiche
porte au moins un outil, on affiche ceci et on demande une confirmation. Une case, pas un workflow.

> Le profil le plus économique sait tenir une conversation, mais il n'appelle pas vos outils de
> façon fiable : il répond de mémoire au lieu d'aller vérifier chez vous. Mesure indépendante :
> quand aucun outil ne convient, il sait se taire 9 fois sur 10 ; mais quand il faut en appeler un,
> il ne le fait que 4 fois sur 10. Deux de nos propres agents clients ont dû abandonner ce profil
> pour cette raison.

**Deux phrases à tenir, y compris commercialement.** Le modèle le plus capable n'est **pas** le plus
sûr : MCPTox mesure que les modèles les plus capables sont souvent plus vulnérables au détournement
d'outils. Et la fiabilité dépend du couple modèle et fournisseur, pas du modèle : jusqu'à **15
points** d'écart de fiabilité de tool calling entre deux endpoints du même modèle. D'où une règle
technique sans exception : **on épingle le fournisseur** (`providerOptions.gateway.only`), toujours.
Trois raisons chiffrées : jusqu'à 6x d'écart de p95 sur un même modèle, jusqu'à 3x de prix
(`gpt-5.6-sol` à 2,00 / 10,00 chez openai contre 5,00 / 30,00 chez azure, et `/v1/models` n'affiche
que le moins cher), et les 15 points ci-dessus.

**Ce qu'on affiche au client, jamais.** Pas de dollars par million de tokens, pas de nom de modèle
seul. Un profil, une phrase de justification, et un ordre de grandeur en conversations calculé sur
sa consommation observée.

### 5.6 Le banc, parce que le catalogue qu'on veut vendre n'est mesuré nulle part

**Six des huit modèles de notre liste de prix sont absents de BFCL V4**, et ni `gemini-3.7-flash`
ni `claude-sonnet-5` n'ont de score de tool calling conversationnel publié par leur éditeur.
Construire un banc n'est donc pas du confort, c'est la seule option. Le parc a déjà le précédent :
`compare.mjs` et `compare-results.md` du bot odalys ont servi à choisir `gemini-2.5-flash`.

Un script, un dossier de scénarios, un tableau markdown committé. Pas de base, pas de tableau de
bord, pas de file.

- **12 scénarios** tirés de conversations WhatsApp réelles, chacun avec un historique de 6 à 8 tours
  et **les 20 outils du bloc exposés à chaque fois**, dont 3 à 7 pertinents et le reste en
  distracteurs pris sur les mêmes connecteurs. Exposer les 20 même quand 4 suffisent est le cœur du
  test : c'est ce régime, et lui seul, qui sépare haiku à 68,70 de haiku à 40,20.
- **4 répétitions** par scénario et par modèle, non négociable. Sur tau2-bench, l'écart entre une
  passe et quatre passes va de **14,6 à 28,8 points** : un modèle à 85 % en une passe ne tient que
  66 % sur quatre. C'est la règle « un test se vérifie dans les deux sens » appliquée à un système
  stochastique.
- **192 conversations par passe complète, environ 15 dollars.** C'est le prix d'arrêter de deviner.
- **Critère** : 3 à 6 assertions par scénario, notées 0 / 0,5 / 1, le scénario passe au-dessus de
  0,75. Assertions **déterministes en majorité** (l'outil appelé et ses arguments sont observables
  puisque la boucle est chez nous), juge LLM uniquement pour le texte final, une assertion par
  scénario au maximum.
- **Règle de lecture** : un écart de moins de 5 points n'est pas un écart. Le banc sert à éliminer
  les effondrements (40 contre 82), pas à départager deux candidats proches. À moins de 5 points, on
  prend le moins cher et on le dit.
- **Trois déclencheurs, pas de cron** : avant d'ajouter un modèle, quand le fournisseur épinglé
  change, quand un modèle est déprécié.

Et une relecture manuelle de six conversations par passe reste obligatoire : un audit du 2026-06-30
trouve **18,5 % de désaccord entre juge automatique et humain** sur 496 tâches de bancs de tool
calling, et **18,9 points d'écart entre 23 exécutions du même dispositif**. Les scores publiés
peuvent refléter des artefacts d'évaluateur autant que la capacité de l'agent.

### 5.7 Ce qu'on ne fait pas, et pourquoi

**Pas de routage automatique entre modèles.** Sur le banc le plus proche de notre cas (145 tâches
multi-étapes avec outils), le routage économise 74 % mais fait perdre **6 points de précision**, et
**le classifieur de routage consomme à lui seul 21,2 % de la dépense totale**. Le graphe de scénario
est déjà notre routeur, et un modèle fixe par bloc est le bon défaut pour un agent qui parle à un
client final.

**Pas de changement de modèle en cours de conversation.** Trois murs. Le cache : le préfixe cachable
inclut les définitions d'outils, alterner deux modèles fait repayer plein tarif le prompt système et
les 20 schémas, alors que l'entrée fait 90 % de la facture. Le comportement : un prompt réglé pour
un modèle ne produit pas le même résultat sur un autre, et notre propre parc le prouve. Le
débogage : avec deux modèles, une régression n'a plus de cause unique.

**Pas de tier `flex`.** Google annonce une latence cible de 1 à 15 minutes, OpenAI le destine
explicitement au non-production. La remise de 50 % est inaccessible à une conversation où le contact
attend. En revanche flex reste pertinent pour **nos** traitements hors ligne (analyse de
conversation, résumés) : deux chemins d'appel dans le code, jamais un réglage exposé au client.

**Pas de tier `priority`.** 1,8x à 2,0x le prix pour « jusqu'à 2,5x plus rapide », alors que nos
meilleurs modèles sont déjà à 578 ms de TTFT. On n'achète pas de la latence, on choisit un modèle
rapide.

**Pas de Custom Reporting Vercel pour la facturation par tenant.** 0,075 dollar par 1000 écritures
de tag, soit à deux tags par appel **24 % de surcoût** sur une conversation économique. On compte
les tokens nous-mêmes depuis le champ `usage` de chaque réponse, et `gateway.cost` donne le chiffre
du fournisseur gratuitement.

**Pas de Routing Rules du Gateway en production**, documentées en beta avec la mention « avoid
relying on them in production », et un piège : un rewrite vers un autre fournisseur invalide
silencieusement les `providerOptions` de l'original. Seule exception retenue : la règle `deny`, pour
garantir qu'aucun modèle hors catalogue testé ne soit appelé.

### 5.8 Le retour du client trois mois après

C'est la moitié de la promesse, et ce que personne ne fait bien. Le client revient et dit « il
répond mal quand on lui demande X ». L'IA de setup, en quatre temps :

1. **Elle cherche les cas réels** dans les conversations. On a l'inbox et les messages en base, on
   n'a rien à redemander au client.
2. **Elle montre ce qui s'est passé** : ce que l'agent a répondu, quelle fiche de connaissance il a
   utilisée, quel outil il a appelé. Le journal `agent_tool_calls` existe pour la facturation, il
   sert ici gratuitement.
3. **Elle propose un diff** sur la fiche, jamais une réécriture silencieuse.
4. **Elle rejoue les cas de test** avant d'appliquer, et signale ce qui casse.

C'est le patron Decagon Duet (« automatically analyzing transcripts and suggesting changes »,
délibérément construit sur un artefact lisible plutôt que sur un modèle frontier, « pour que
n'importe qui puisse voir exactement ce qu'il fait et pourquoi ») croisé avec les Simulations
d'Intercom. Les deux briques nécessaires, l'inbox et le journal d'appels, existent déjà ou sont
prévues pour d'autres raisons.

### 5.9 Les garde-fous de la conversation elle-même

L'IA de setup est une surface d'attaque, et c'est le point le plus souvent oublié : elle lit du
contenu tiers (le site du client, les descriptions d'outils d'un serveur MCP) pour aider à
configurer. Un contenu hostile peut donc l'orienter.

- Elle écrit dans `agents.fiche` (jsonb, `safeParse`), **jamais dans les colonnes de sécurité** :
  mention IA, plafonds, classification de risque, activation d'un outil. Compromettre la
  conversation de setup ne compromet pas l'agent.
- **Aucune écriture silencieuse.** Toute proposition passe par un diff.
- **Le contenu tiers lui arrive en bloc de données délimité**, comme pour l'agent lui-même.
- **Un lint de fiche bloque l'activation** : description d'outil de moins de trois phrases, clause de
  non-usage vide, pronoms sans nom propre (« leur commande », « chez nous »), description de plus de
  300 caractères ou description de paramètre de plus de 700 (limites OpenAI). Copilot Studio bloque
  déjà la publication tant qu'une description est vide, Intercom plafonne à 100 règles actives de
  2500 caractères. Ce ne sont pas des tracasseries : ce sont les mécanismes concrets qui empêchent le
  prompt bloat de s'installer.
- **Le chat n'est jamais le seul chemin d'édition.** Tout ce que la conversation produit reste
  visible et modifiable champ par champ dans un écran. Le jour où l'onglet Create a disparu de
  l'interface d'OpenAI, des GPTs sont devenus non modifiables du jour au lendemain.

### 5.10 Ce que ça change au séquencement

L3 était placé après L2. Il faut le remonter partiellement : la conversation de setup n'a de sens
que sur des briques qui existent, mais elle est aussi ce qui rend L1 **démontrable**. Compromis
retenu : une version minimale livrée **avec L1** (mandat, connaissance, règles d'arrêt, modèle, et
les seuls outils maison, dont `mba_envoyer_bloc`), son extension aux connecteurs livrée avec L2, à
MCP avec L4. La partie « retour trois mois après » est un lot à part : elle n'a de valeur qu'une
fois qu'il existe de vraies conversations à analyser.

---

## 6. Sécurité : cinq règles de conception, puis ce que chaque lot ajoute

La première version listait seize garde-fous en bloc, ce qui donnait l'impression d'un chantier
infaisable. La réalité est plus simple : cinq règles ne coûtent rien parce qu'elles sont
structurelles, et le reste s'attache au lot qui en a besoin.

**Les cinq règles, gratuites parce qu'elles sont dans la forme du code.**

1. **Le modèle ne choisit jamais une cible réseau ni un identifiant de ressource.** Aucun outil
   n'accepte d'URL ni d'en-tête `Authorization` en argument. C'est le champ `source` de la
   section 3.1, validé à la déclaration.
2. **Aucun secret n'entre dans le contexte du modèle.** Déchiffrement à l'étape 6 uniquement. Test
   de garde : le prompt sérialisé ne contient aucune valeur de `auth_secret`.
3. **L'autorisation se relit en base à l'exécution**, sous `tenant_id = $1 and agent_id = $2 and
   actif = true`. Filtrer ce qu'on envoie au modèle n'est pas un contrôle : l'issue `vercel/ai#8653`
   documente exactement le cas où le filtrage d'exposition marchait pendant que l'exécuteur tapait
   dans le catalogue complet.
4. **Une sortie d'outil est une donnée, jamais une instruction.** Bloc délimité portant sa
   provenance, jamais concaténé au prompt système. La règle existe déjà dans le CLAUDE.md global
   pour l'entrée utilisateur, elle s'étend ici aux **définitions** d'outils et aux **résultats**.
5. **Tout plafond franchi sort par une branche du scénario**, jamais par un arrêt muet.

**Ce que chaque lot ajoute, quand il arrive.**

| Lot | Ce qui s'ajoute | Pourquoi à ce moment-là |
|---|---|---|
| L1 | Mention IA non désactivable, plafonds durs, journal d'audit | Obligation légale depuis le 2 août 2026, et le journal est de toute façon le grand livre de facturation |
| L2 | **Garde SSRF partagée** (`src/lib/egress.ts`) | C'est le lot qui crée le premier egress à destination arbitraire du produit. Avant, il n'y a rien à protéger |
| L4 | Épinglage des définitions d'outils, interdiction de `stdio` | Le rug pull est un problème de tiers. Un outil maison ou un connecteur écrit par le client ne dérive pas |
| L6 | Verrou de rafraîchissement en base | Deux conteneurs lisent les mêmes credentials, c'est la configuration du bug ouvert `typescript-sdk#1760` |

**Le cas central, à traiter une fois pour toutes : un contact WhatsApp inconnu tente de faire
appeler un outil.** Trois lignes de défense, dans cet ordre.

La surface est close avant qu'il parle : il ne peut déclencher que les outils activés sur **ce** bloc
agent, et `tools/list` n'est jamais appelé en conversation. Il ne peut pas désigner la ressource
d'un autre : tout identifiant est de source `contact`. Et le profil par défaut est dégradé : un
`wa_id` absent de `contacts` n'accède qu'aux outils `read`.

En filet, un plafond d'appels par numéro et par jour. Et **aucun classificateur d'injection présenté
comme une barrière**, ni à nous ni au client : « The Attacker Moves Second » (OpenAI, Anthropic et
DeepMind, octobre 2025) casse 12 défenses publiées avec plus de 90 % de succès sous attaque
adaptative, et MCPTox mesure moins de 3 % de refus chez le meilleur modèle testé.

---

## 7. Séquencement

Chaque lot est autonome et déployable seul. Rappel du rituel du repo : `compose build` **avant**
`compose run --rm --no-deps mba-api npm run migrate`, puis `up -d --build`, parce que les migrations
vivent dans l'image.

| Lot | Ce que ça apporte au client | Coût relatif |
|---|---|---|
| **L0** | Rien de visible : bump zod, `engines >= 22`, `startAfter` sur la file, file `agent-turn` | petit, bloquant |
| **L1** | Le node agent avec les outils maison, dont `mba_envoyer_bloc`, **plus la conversation de setup minimale** (mandat, connaissance, règles d'arrêt, modèle). C'est ce qui rend L1 démontrable | **1x** |
| **L2** | Connecteurs HTTP du client, la garde SSRF, et l'extension de la conversation de setup aux connecteurs | 0,7x |
| **L3** | Le retour du client dans la durée : analyse des vraies conversations, suggestions de diff, cas de test rejouables | moyen, et n'a de valeur qu'une fois qu'il y a des conversations |
| **L4** | MCP en jeton statique, sur allowlist | 0,4x |
| **L6** | MCP OAuth | **4x à 8x** |
| **L7** | URL MCP arbitraire, derrière un drapeau par tenant | décision commerciale |

**On peut s'arrêter après L2 et avoir un produit vendable.** L1 porte environ 80 % de la valeur
perçue, L2 porte l'argument commercial (« brancher mon système »). Le reste est de l'expansion.

**Le prérequis de L0 est réel et bloquant.** Le repo est en `zod ^3.24.1`, sous le plancher de tous
les candidats : MCP v1 exige `^3.25`, MCP v2 exige `^4.2.0`, `ai@7` exige `^3.25.76 || ^4.1.8`. Le
plus petit pas qui débloque est `^3.25.76`. Le pas propre, vu que la fiche d'agent sera validée par
Zod, est de passer à zod 4, et de le faire **avant** la feature, pas pendant.

**Pourquoi MCP se coupe en deux lots très inégaux.** Sur le parc réel mesuré, 40,5 % des serveurs
n'ont aucune authentification, 29 % un jeton statique, 30,5 % de l'OAuth. Le mode jeton couvre donc
déjà 70 % du parc pour un quart du prix. Et le coût de L6 n'est pas dans le développement, il est
dans la **supervision** : un jeton mort ne produit pas d'erreur applicative, l'agent dégrade en
silence, dans une conversation WhatsApp en cours.

Quand L6 arrivera, le premier serveur à brancher est **Linear** : CIMD annoncé, `S256` seul donc
aucun downgrade PKCE possible, scopes clairs, et un endpoint dédié en lecture seule pour démarrer.
**HubSpot est le pire premier candidat** malgré sa pertinence métier : ni CIMD ni DCR, un
`client_secret` à stocker par tenant, et surtout la console possède déjà son connecteur HubSpot
(`mm-hubspot`, en production sur le portail 139615673). Ce serait une deuxième façon de faire la
même chose.

---

## 8. Les décisions qui restent

Trois décisions produit, et une recommandation technique que j'assume.

**D1. Action irréversible : TRANCHÉ le 2026-08-26.** L'autonomie est **un réglage du client, outil
par outil**. Une case dans la console, réservée aux administrateurs, dit que l'agent peut exécuter
cet outil seul.

J'avais recommandé la bascule vers l'inbox par défaut, au motif que l'agent réunit les trois pattes
du lethal trifecta sans humain dans la boucle, que MCPTox mesure 72,8 % de succès d'attaque pour
moins de 3 % de refus, et que le repo a déjà son précédent maison (`conversation_analysis.abusive`
est un constat du modèle qui ne déclenche rien, `contacts.blocked_at` est une décision humaine qui a
des effets). Julien a tranché autrement, en connaissance de ces éléments.

Ce que ça implique, et qui est câblé en conséquence :

- La case est **admin seulement**. Le RBAC existant suffit, les écritures y sont déjà réservées.
- L'outil passe quand même par le tronc commun : arguments validés par Zod, identifiants en
  `source: 'contact'` donc dérivés du numéro authentifié par la signature du webhook Meta et jamais
  fabriqués par le modèle, budget de temps, plafond d'appels.
- Chaque appel est journalisé dans `agent_tool_calls` avec ses arguments rédigés. C'est la seule
  chose qui rende un incident instruisable après coup, et ce n'est pas facultatif.
- **La responsabilité se déplace vers le tenant qui coche.** C'est la contrepartie assumée de
  l'option, et elle doit être écrite dans les conditions. Action commerciale, pas technique.

**D2. Que se passe-t-il quand le compte prépayé est à zéro en pleine conversation ?**
*Recommandation : sortie par `sortie:plafond` avec le message de repli déclaré par le client, plus
alerte admin, plus un découvert très faible sur la conversation en cours uniquement.* Une
conversation coupée au milieu d'une fenêtre de service de 24 h coûte plus cher en réputation qu'en
tokens.

**D3. La famille MCP : allowlist de serveurs validés par nous, ou n'importe quelle URL saisie par le
tenant ?**
*Recommandation : allowlist par défaut, URL arbitraire derrière un drapeau par tenant.* Ça permet de
dire vrai commercialement sans ouvrir par défaut le SSRF sur trois sauts et un support non borné.

**Et la recommandation technique.** Pour l'appel modèle, étendre le client HTTP maison vers la
surface OpenAI Chat Completions du Gateway, sur le même `HttpTransport` injectable que les clients
Meta, plutôt que d'adopter l'AI SDK. Le repo n'utilise aujourd'hui aucun SDK LLM, le contrat
`HttpTransport` plus `FakeTransport` rend la boucle testable sans réseau, et le principal apport de
l'AI SDK (`activeTools`) perd son intérêt maintenant qu'il n'y a plus de shortlist. Chat Completions
est aussi la surface la plus portable entre fournisseurs, et c'est déjà celle qu'utilise hyundai.

---

## 9. Les trois risques

**R1. L'agent coche les trois pattes du lethal trifecta, sans humain dans la boucle.** Entrée
WhatsApp d'un inconnu, données privées du tenant, capacité d'exfiltration par la réponse et par les
outils. MCPTox mesure 72,8 % de succès d'attaque et moins de 3 % de refus sur 45 serveurs MCP
**réels**. Le cas GitHub MCP d'Invariant Labs montre qu'une simple **issue publique** suffit à faire
exfiltrer des dépôts privés, sans aucun serveur malveillant.
*Parade : casser une patte par défaut, pas au cas par cas.* Lecture seule en autonomie, écriture
irréversible par l'inbox, épinglage des définitions, allowlist de domaines sur tout lien émis (le
canal d'exfiltration le plus trivial ici est le message WhatsApp lui-même, et le repo a déjà
`tracked_links` et `/r/:code` en production).

**R2. Le SSRF depuis le réseau Docker `mcp-robot_default` casse le cloisonnement entre clients du
parc, pas seulement entre tenants de la console.** Vérifié dans le code : aujourd'hui tout le trafic sortant
vise des hôtes fixes, un grep de `fetch(` sur `src/` ne remonte que Meta et Telegram. Or
`mba-worker` tourne sur un réseau où `mba-api:8095`, `odalys-admin:3000`, `ganprev-app`,
`mm-hubspot-api:8096` et l'admin NPM sur le port 81 sont joignables **par nom**. Et ce n'est pas une
URL à filtrer mais quatre sauts successifs, tous fournis par le serveur distant.
*Parade : `src/lib/egress.ts`, module unique inscrit dans « Modules partagés », avec une denylist de
noms de conteneurs en plus des plages IP, et l'épinglage de l'IP résolue via `options.lookup` pour
supprimer la course TOCTOU du DNS rebinding. Ne pas écrire la validation d'IP à la main : la spec MCP
et OWASP le déconseillent explicitement.* Parade structurelle à moyen terme : un conteneur agent sur
un réseau Docker séparé.

**R3. Brancher un outil externe crée une dépendance externe sur le chemin conversationnel d'un
client.** Un serveur tiers lent ou mort ne produit pas d'erreur applicative visible : l'agent dégrade
en silence, dans une conversation en cours, avec des messages facturés. La latence P99 mesurée sur
un parc de 100 serveurs MCP de production est de 6,2 secondes, et 19 % des échecs sont des 401 ou
des 429, donc le quota du client peut sauter, pas seulement son jeton.
*Parade : timeout dur par appel, plafond d'appels par tour, écran d'état par connecteur, et surtout
un message de repli déclaré par le client au moment où il ajoute l'outil, jamais improvisé par le
modèle.*

À inscrire dans le `CLAUDE.md` du repo au même titre que « les liens tracés sont une porte à sens
unique ».

---

## 10. Ce qui a été retiré à la révision 2, et pourquoi

| Retiré | Raison |
|---|---|
| **Présélection d'outils par embeddings**, outil `chercher_un_outil`, gel de shortlist, détection de doublons sémantiques, métrique de rang | Résout un problème que la console n'a pas : le graphe de scénario fait déjà le routage. Et le mécanisme créait lui-même l'invalidation du cache de prompt qu'il fallait ensuite contourner. Remplacé par un plafond de 20 et un message d'interface qui invite à couper le scénario en deux blocs |
| **Colonne `embedding vector(1536)`** | Impose pgvector, que le repo n'a pas, pour un mécanisme retiré |
| **Table de jonction `agent_tool_grants`** | N'a de sens que pour partager un outil entre plusieurs agents. Personne ne l'a demandé. Remplacée par `agent_tools.agent_id` |
| **Colonne `input_schema` stockée** | Deux sources de vérité pour la même chose. Le schéma se dérive de `params` par une fonction pure, testable |
| **Second balayage `runAgentIdleSweep`** | Un balayage de plus, c'est une DLQ de plus et un mode de panne de plus. `startAfter` de pg-boss plus le verrou optimiste déjà nécessaire font le même travail sans rien ajouter |
| **Colonnes OAuth et épinglage dans la migration de base** | Elles servent des lots situés quatre à six lots plus loin. Elles arrivent avec eux, par `add column if not exists`, comme le repo étend `tenant_settings` depuis huit migrations |

Bilan : quatre tables au lieu de six, deux migrations au lieu de quatre, aucune extension Postgres
nouvelle, aucun balayage nouveau, et le lot L1 redevient une brique qu'on peut finir et déployer.

---

## Annexe : les chiffres du terrain, avec leur source

Tous relevés le 2026-08-23.

**Facturation.** `providerMetadata.gateway.cost` porte le coût en dollars de chaque appel dans le
corps de la réponse, plus un `generationId` qui permet de retrouver le coût définitif via
`GET /v1/generation`. `GET /v1/credits` donne le solde de l'équipe. Vercel ne prend aucune marge.
Trois pièges : le budget natif est un **soft cap** documenté comme tel (la requête qui franchit la
limite se termine, propagation jusqu'à 5 minutes) ; `gateway.cost` n'inclut pas les surcharges
Custom Reporting, que le marquage par tenant active ; et le prix dépend du fournisseur qui sert la
requête (`gpt-5.6-sol` à 2 $/M chez openai, 5 $/M chez azure et bedrock), donc on lit le coût rendu,
on ne le recalcule pas.

**Prix indicatifs** ($/M entrée-sortie, `GET /v1/models`, public sans authentification) :
`gemini-3.7-flash` 0,75 / 3,75 (promo -50 % jusqu'au 31/12/2026), `gemini-3.5-flash-lite` 0,30 /
2,50, `gpt-5.6-luna` 0,20 / 1,20, `claude-haiku-4.5` 1,00 / 5,00, `claude-sonnet-5` 2,00 / 10,00.
Les variantes `-fast` sont au double. Ne jamais figer une grille en dur : les promotions expirent à
date connue.

**Tool calling selon le modèle.** 222 des 237 modèles de langage du catalogue portent le tag
`tool-use`. Mais le terrain interne se contredit : hyundai fait 8 outils en production sur
`gemini-3-flash` sans problème, Gan Prévoyance a renoncé au tool calling avec `gemini-2.5-flash`
(« n'appelle pas l'outil de façon fiable », et `tool_choice` forcé inutilisable côté Gemini), odalys
a abandonné `gemini-2.5-flash-lite` pour la même raison. La fiabilité est une propriété du couple
(modèle, surface d'API), pas du produit. D'où une liste courte de modèles testés par nous, pas les
222.

**MCP.** Révision courante 2026-07-28, publiée le 28 juillet, annoncée comme cassant la
compatibilité. Suppression du handshake `initialize`, des sessions, de l'en-tête `Mcp-Session-Id` et
de la reprise de flux SSE. Protocole **stateless**. SDK TypeScript en v2 depuis le 27 juillet
(`@modelcontextprotocol/client` 2.0.0, `engines node >= 20`, dépendances légères). Les tool
annotations (`readOnlyHint`, `destructiveHint`) sont explicitement déclarées **non fiables** par la
spec : elles peuvent pré-remplir une proposition dans la console, jamais autoriser un appel.

**Attaques documentées.** Tool poisoning et rug pull caractérisés par Invariant Labs le 1er avril
2025. Line jumping (Trail of Bits, 21 avril 2025) : la charge est dans la description et entre dans
le contexte **dès le `tools/list`**, sans que l'outil soit jamais appelé. Rug pull **observé en
vrai** : paquet npm `postmark-mcp`, quinze versions légitimes puis la 1.0.16 ajoute un `Bcc` dans la
définition de `sendEmail`, environ 1500 organisations. EchoLeak (CVE-2025-32711, CVSS 9.3) :
exfiltration zéro-clic dans Microsoft 365 Copilot par un commentaire HTML dans un email.

**Coût en contexte.** Chaque définition d'outil coûte 200 à 500 tokens. Le serveur MCP GitHub expose
93 outils pour environ 55 000 tokens. Les configurations multi-serveurs consomment couramment 40 à
50 % de la fenêtre disponible avant tout travail utile. Précision de sélection : 19 sur 20 à vingt
outils, **échec complet à 107 outils**. GitHub Copilot est passé de 40 à 13 outils et a gagné 400 ms
de latence plus 2 à 5 points de précision.

**Ergonomie.** Voiceflow expose une cadence de resynchronisation configurable par source (jamais,
quotidienne, hebdomadaire, mensuelle), Intercom impose un re-crawl hebdomadaire fixe. Le constat
récurrent du marché : la cause dominante des mauvaises réponses est le contenu périmé, pas le
modèle. Intercom plafonne à 100 règles actives et 2500 caractères chacune, et fait relire les règles
par une IA qui détecte ambiguïté, redondance et contradictions. Ces plafonds sont le mécanisme
concret qui empêche le prompt bloat de s'installer.

**Promesse de délai.** Le seul produit qui tient 1 à 3 jours est Intercom Fin, et seulement « if
your help center is well organized ». Decagon et Sierra prennent 2 à 6 semaines. Le travail réel est
la mise au propre du contenu, pas la configuration. Ne pas promettre un setup en dix minutes.
