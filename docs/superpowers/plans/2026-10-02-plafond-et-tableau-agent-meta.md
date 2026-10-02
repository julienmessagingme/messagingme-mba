# Le plafond et le tableau de l'agent de Meta

Demande de Julien du 2026-10-02, après une facture de l'agent jugée très chère et avant une démo à un interlocuteur de
Meta : régler un plafond de dépense de l'agent, et voir ce qu'il fait. Les deux s'appuient sur des routes de Meta
apparues après notre récolte du 2026-09-10 (`messagingme-pilot/docs/META-BUSINESS-AGENT-API.md`, récolte du 2026-10-02).

## Méthode de livraison

**Implémenteur par lot (la session elle-même) puis UNE relecture indépendante du diff**, parce que le plafond écrit
chez Meta un réglage qui COUPE l'agent de tout un Business Manager, et que le tableau affiche une estimation de coût.
Aucune migration. L'essai réel qui clôt le lot est décrit en fin de plan.

## Ce qui est mesuré avant d'écrire (2026-10-02, notre numéro, lecture seule)

- `GET {id}/agent_budget` : le Business Manager rend `{"budgets":[]}`, le numéro rend 404 « Business not found ». Le
  plafond est donc PAR BUSINESS MANAGER, comme la facture. Notre base ne garde que son nom : l'identifiant se relit
  chez Meta (`owner_business_info.id` du compte WhatsApp).
- `insights/conversations` rend `data[0].ai_threads.count` et `ai_handoffs.count` ; `insights/tool_calls` une ligne
  par outil (`1210015078858994_EngageMe__add_tag`, `thread_count`, `avg_latency_ms`, `success_rate`, `error_rate`,
  `timeout_rate`) ; `insights/agent_events` une ligne par type (`received`, `successfully_processed`,
  `avg_e2e_latency_ms`). Aucune ne rend de jetons ni de coût.

## Tâches

1. **Client** (`src/mba/client.ts`) : `lireBudgets`, `ecrireBudgets` (le POST REMPLACE tout), `insightsConversations`,
   `insightsOutils`, `insightsEvenements`, chacune avec son `safeParse` ; une réponse illisible LÈVE (un plafond
   illisible rendu vide dirait « illimité »).
2. **Routes** (`src/http/mba.ts`, garde admin) : `GET|PUT /tenants/:id/mba-budget` (le serveur résout le compte
   WhatsApp puis son Business Manager ; 409 sans compte) et `GET /tenants/:id/mba-insights` (30 derniers jours, le
   numéro résolu côté serveur, chaque lecture indépendante des autres, plus notre compte des messages de l'agent sur
   la même fenêtre et le prix public par message).
3. **Comptage** : `messagesEcritsParMba(tenant, depuis?)`, la fenêtre facultative.
4. **Console** : le plafond dans l'onglet Activation (unité réponses ou jetons, fenêtre 1, 7, 14 ou 30 jours, maximum,
   ordre de grandeur en dollars, retrait) ; une carte « Agent de Meta » dans Performance lab (conversations tenues, en
   attente de l'équipe, messages écrits et leur coût ESTIMÉ, outils et événements). La carte se tait sans numéro.

## Tests attendus

Le client (formes mesurées, réponses illisibles, nom lisible d'un outil) ; les routes (garde, Business Manager
introuvable, validation du plafond, retrait, remplacement, une statistique en panne n'éteint pas les autres) ; le
comptage avec fenêtre (intégration).

## Ordre de déploiement

CI verte, `up -d --build mba-api mba-worker`, contrôle public. ⚠️ La console part sur Vercel au push : jusqu'au `up`,
les deux routes rendent 404, le plafond le dit et la carte se tait.

## Essai réel qui clôt le lot

Julien règle un plafond bas (par exemple 3 réponses sur 1 jour), écrit à l'agent jusqu'à le dépasser et voit la
conversation passer à l'équipe ; puis il retire le plafond. Il ouvre Performance lab et compare la carte aux
conversations qu'il a eues avec l'agent.
