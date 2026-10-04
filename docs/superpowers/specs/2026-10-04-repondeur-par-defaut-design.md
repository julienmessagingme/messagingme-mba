# Le répondeur par défaut : un agent IA qui répond comme l'agent de Meta (lot 5)

Lot 5 de « Engage Me pour Claude Code » (cadrage privé : `docs/prive/2026-10-02-engageme-claude-code.md`, § « L'agent
IA répondeur par défaut »). Cadré avec Julien le 2026-10-04, ses réponses sont citées à chaque décision.

## 1. Le besoin

Aujourd'hui un agent IA ne parle qu'à l'intérieur du bloc Agent IA d'un scénario publié. L'agent de Meta, lui, répond à
tout message que personne ne tient. Le lot donne ce rôle à un agent IA de la console : **un espace choisit son
répondeur, et l'agent IA choisi répond à tout message entrant que ni un scénario, ni un mot-clé, ni un humain ne
tient**, sans que le client ait construit quoi que ce soit. Pour tous les clients de la console, pas seulement le
parcours Claude Code, où c'est l'étape « en faire le répondeur par défaut ».

**Ce qui dit que c'est réussi** : on écrit depuis un téléphone à un numéro d'un espace sans aucun scénario, et l'agent
répond en tenant compte du message qu'on vient d'envoyer, pas par une phrase toute faite.

**Deux constats du code, mesurés avant d'écrire** :
- **Sans l'agent de Meta, personne ne répond** : `remettreSiPersonneNeSuit` (`src/inbox/fil.ts`) rend la main tout de
  suite quand `mba_enabled` est faux, la conversation reste `app_workflow`, hors « À traiter ». C'est là que le
  répondeur se branche.
- **Le premier tour d'un agent parle à froid**, dans les scénarios aussi : `run-turn` lit la conversation depuis
  `agent_sessions.created_at` (`messagesDepuis`, `created_at >= ouvertLe`), or le message qui a déclenché le parcours
  est enregistré AVANT l'ouverture de la session. Le modèle ne reçoit que sa consigne système. Le lot le répare pour
  tous les agents.

## 2. Ce qui est décidé

| Question | Réponse de Julien |
|---|---|
| Que font les sorties de l'agent sans scénario derrière ? | Toutes ferment la conversation de l'agent, leur code est noté sur la conversation ; le transfert l'envoie dans l'Inbox ; le prochain message relance l'agent. |
| De quoi se souvient l'agent quand le contact réécrit plus tard ? | Des 30 derniers messages échangés avec ce contact, dans la limite de 30 jours, quelle que soit la conversation. |
| Crédit IA épuisé ? | La conversation passe à l'équipe (« À traiter »), sans réponse automatique, et les admins reçoivent une alerte e-mail, une par jour au plus. |
| « L'agent de Meta prend la main » dans les campagnes, le widget et les publicités ? | Devient « le répondeur automatique prend la main » : l'agent de Meta ou l'agent IA selon le réglage de l'espace. |
| Comment faire tourner un agent sans scénario du client ? | Un scénario système caché par espace (approche 1, retenue le 2026-10-04). |

## 3. Le réglage : une seule voix, tenue par la base

- **`tenant_settings.repondeur_agent_id`** (`uuid`, nullable, clé étrangère vers `agents` en `on delete set null`).
  Non nul = l'agent IA désigné est le répondeur de l'espace. Nul = le comportement d'aujourd'hui (l'agent de Meta si
  `mba_enabled`, sinon personne).
- **Une seule voix, garantie par un CHECK** : `repondeur_agent_id is null or mba_enabled = false`. Deux répondeurs ne
  peuvent pas coexister, quel que soit le chemin d'écriture.
- **Le seul écrivain de `mba_enabled` est `PgSettingsStore.setMbaEnabled`** (ses quatre appelants : `http/mba.ts` deux
  fois, `http/settings.ts`, `mba/assistant/application.ts`). Allumer l'agent de Meta y remet `repondeur_agent_id` à
  nul dans la même instruction : le geste qui allume l'un éteint l'autre, sans 500 sur le CHECK.
- **Choisir un agent IA éteint l'agent de Meta** par le chemin existant (`appliquerActivation(false)`, qui fait le
  nécessaire chez Meta), puis retire de la liste de Meta tous les contacts qu'il tenait (`mba_liste`, par
  `liste.retirer`), puis écrit `repondeur_agent_id`. Sans le retrait, Meta continuerait de répondre aux contacts déjà
  sur sa liste, et leurs messages arriveraient en `standby`, que nos étapes ignorent.
- **Seul un agent ACTIF peut être désigné.** Un agent désactivé ou supprimé : la clé étrangère remet à nul, et la
  désactivation remet à nul elle aussi (dans `changerStatut`), avec un avertissement à l'écran. Personne ne répond
  alors, comme un espace sans agent de Meta aujourd'hui.
- **Où on le règle** : sur la page des agents (« Répondeur de l'espace » : aucun, ou un des agents actifs ; l'agent de
  Meta y est affiché quand il est allumé, avec un lien vers son écran), et par l'outil MCP `set_default_responder`
  (`agent_id` ou `null`), réservé à une personne (`exigePersonne`) et journalisé. `list_agents` dit lequel est le
  répondeur.

## 4. Le scénario système

- **`workflows.systeme`** (`text`, nullable, CHECK `systeme in ('repondeur')`, index unique partiel
  `(tenant_id) where systeme = 'repondeur'`) : une ligne par espace, créée à la première utilisation, jamais montrée.
- **Le graphe n'y est pas tenu à jour** : il est construit à chaque démarrage depuis le réglage (l'agent désigné, ses
  règles d'arrêt) et figé dans le parcours (`workflow_runs.graphe_fige`, 0151, `runFrom(..., { figerLeGraphe: true })`).
  Changer d'agent ou de règles d'arrêt ne demande donc aucune écriture sur cette ligne, et un parcours en cours garde
  le graphe avec lequel il a commencé. La ligne n'est que l'ancre que `workflow_runs.workflow_id` exige.
- **Le graphe** : un bloc Agent IA ; chacune de ses règles d'arrêt mène à une fin qui note le code (§ 6) ; `humain`
  (escalade) et `echec` mènent à l'équipe ; `plafond` mène à l'équipe avec l'alerte de crédit (§ 7) ; `timeout`
  (inactivité) mène à une fin silencieuse.
- **Invisible partout, par le magasin et non par les appelants** : `listResume`, `list`, `listPublies` et `getById`
  du magasin des scénarios excluent `systeme is not null`. Cela couvre d'un coup `GET /workflows`, `/nodes`, la
  détection de doublon de nom, la résolution par nom ou code de `/v1`, le catalogue `/v1`, l'outil MCP
  `list_scenarios` et les outils de l'agent de Meta. La frise et le journal des échecs disent « Répondeur
  automatique » au lieu d'un nom de scénario.
- **Un nouveau type de lancement, `repondeur`** (`src/workflow/lancements.ts`, liste fermée tenue par
  `tests/workflow-lancements.test.ts`) : reprise du fil `sauf_operateur` (jamais à un opérateur), garde de fenêtre
  prouvée par l'entrant, graphe figé.

## 5. Le branchement dans `fil.ts`

Les gestes qui confient aujourd'hui à l'agent de Meta lisent le réglage, et seul l'entrant non pris démarre l'agent :

- **`remettreSiPersonneNeSuit`** (l'entrant que personne ne tient) : mêmes gardes qu'aujourd'hui, dans le même ordre
  (fil d'un opérateur dans son délai de reprise, parcours en attente, contact désabonné ou bloqué, fil de test sur un
  chemin automatique, aucun numéro), puis, si l'espace a un répondeur IA, **démarrer le scénario système** au lieu de
  confier à Meta. Le solde est lu AVANT : épuisé, la conversation passe directement à l'équipe (§ 7), sans parcours ni
  session.
- **`rendreApresParcours`, `rendreLaMain`, `rendreApresInactivite`** (fin de scénario, l'humain rend la main, le
  balayage) : avec un répondeur IA, ils remettent le fil en `app_workflow` sans démarrer l'agent ; c'est le prochain
  message du contact qui le démarre, exactement comme l'agent de Meta répond au prochain message. `rendreLaMainAMba`
  de l'exécuteur, qui ne fait rien quand l'agent de Meta est éteint, suit la même règle.
- **Le balayage** (`control-sweep`) ne doit pas rendre ailleurs un fil tenu par le répondeur : un `app_workflow` vieux
  de plus de 24 h avec un message récent est aujourd'hui rendu à l'agent de Meta s'il est allumé ; avec un répondeur
  IA, il est laissé tel quel.
- **Les choix « l'agent de Meta prend la main »** des campagnes, du widget et des publicités ne changent pas de valeur
  en base : ils ne prenaient rien, c'est la remise « personne ne suit » qui confiait, donc ils mènent désormais au
  répondeur de l'espace, quel qu'il soit. Seul leur libellé change dans la console : « le répondeur automatique prend
  la main ». Le choix « agent IA » du widget, grisé « à venir », disparaît.

## 6. Ce que lit l'agent, et ce qui reste de sa sortie

- **Le premier tour lit le message qui l'a déclenché**, pour tous les agents. Le tour reçoit une borne de lecture :
  pour le répondeur, les 30 derniers messages du contact sur 30 jours ; pour un bloc de scénario, la conversation
  depuis le message entrant qui a démarré ou repris le parcours (pas plus loin : un agent de scénario ne doit pas
  changer de comportement en relisant l'historique d'une autre campagne). Le plafond de 30 messages reste.
- **La sortie est notée** par un événement de frise `sortie_agent` portant le code de la règle d'arrêt (élargissement
  du CHECK de `conversation_evenements.type`, sous son nom). L'Inbox le montre dans le panneau Détail.
- **La mention d'IA sur le dernier message** (jaune de la relecture du correctif de `terminer`, constaté à l'essai réel
  du 2026-10-04) : quand le texte de sortie vient du paramètre `message` et que l'annonce est due, la phrase est
  ajoutée devant. Le répondeur parle souvent à des inconnus au premier message, c'est le cas où elle compte.

## 7. Crédit épuisé

- Lu avant de démarrer : solde nul ou négatif, la conversation passe à l'équipe par `passerAUnHumain` (« À traiter »,
  demande ouverte, cause « crédit IA épuisé »), sans parcours ni session.
- Pendant une conversation, le tour existant sort déjà par `plafond` : le graphe système mène à l'équipe.
- **Une alerte e-mail aux admins de l'espace, une par jour au plus** (Resend, le canal des e-mails transactionnels),
  avec le lien de recharge. Le « une par jour » se tient en base (une ligne par espace et par jour), pas en mémoire :
  l'API et les workers sont plusieurs copies.

## 8. Pièges retenus (exploration du 2026-10-04)

- **Deux voix** : tenu par le CHECK et par le retrait de la liste de Meta (§ 3).
- **Un entrant redélivré par Meta** ne doit pas lancer un second tour : le démarrage passe par la déduplication des
  évènements (`alreadySeen`), et un parcours déjà en attente coupe court (garde existante).
- **Un opérateur qui écrit pendant un tour** : `main_perdue`, existant.
- **Un mot-clé, ou une étiquette posée par l'agent, qui démarre un autre scénario** ferme le parcours du répondeur et
  sa session : comportement voulu (le scénario du client a la priorité).
- **Gateway absente** (`AI_GATEWAY_API_KEY` vide, la file `agent-turn` n'est pas consommée) : le réglage est refusé à
  l'écriture, et le démarrage n'a pas lieu (la conversation reste à l'équipe), sinon le contact resterait muet pour
  toujours derrière un parcours en attente.
- **RCS** : hors périmètre, le répondeur ne répond qu'aux entrants WhatsApp.

## 9. Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, en deux livraisons, une relecture indépendante à la fin de chacune :
le lot change qui répond aux clients sur tout entrant non pris (chemin que la production emprunte), et `fil.ts` porte
des invariants invisibles (gardes ordonnées, écritures gardées, événements de frise). Aucun workflow multi-agents.

- **Livraison A, le serveur** : la migration (§ 3, § 4, § 6), le réglage et son écrivain unique, le scénario système et
  son type de lancement, le branchement dans `fil.ts` et l'exécuteur, le premier tour, la mention d'IA du dernier
  message, le crédit et son alerte, l'outil MCP. La migration ajoute et relâche : elle passe AVANT le `up`.
- **Livraison B, la console** : le réglage sur la page des agents, les libellés « répondeur automatique », la frise.
  Poussée APRÈS le déploiement de A (un écran qui appelle une route neuve casse dès le push).

**L'essai réel qui clôt** : depuis le téléphone de Julien, sur le numéro d'un espace sans scénario qu'il choisit (désigner
un agent IA y ÉTEINT l'agent de Meta pour tous les contacts de cet espace), avec Gan PrevMCP en répondeur : (1) un premier message auquel l'agent répond en le prenant en compte ; (2) une demande d'humain qui arrive
dans « À traiter » ; (3) l'humain rend la main, le message suivant est repris par l'agent ; (4) l'agent de Meta est
bien éteint sur l'espace et ne répond pas en double. La mémoire de 30 jours se vérifie par un second échange le
lendemain.
