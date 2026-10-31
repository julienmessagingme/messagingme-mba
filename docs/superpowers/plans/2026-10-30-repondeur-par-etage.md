# Choisir le répondeur automatique d'un étage de campagne

Demande de Julien du 2026-10-30, sur l'étape Contenu de l'assistant : « quand on met répondeur automatique, il faut
demander quel répondeur automatique, que la personne puisse choisir un des agents IA dispo ou le MBA (si aucun n'est
setuppé, il faut griser cette option) ».

## Ce qui est décidé (cadrage du 2026-10-30)

| Question | Réponse de Julien |
|---|---|
| Combien de temps l'agent choisi garde la conversation ? | Jusqu'à ce qu'il la close (règle d'arrêt, transfert, inactivité) ; les messages suivants reviennent au répondeur de l'espace. |
| Que propose la liste ? | « Le répondeur de l'espace » en premier et par défaut (le comportement d'aujourd'hui), puis l'agent de Meta, puis chaque agent IA actif. |
| Widgets et publicités ? | Non, les campagnes seulement. |

Conséquences tirées sans nouvelle question :
- **L'agent de Meta choisi se comporte comme le bloc « Envoyer au MBA »** (`envoyerAuMba`, `src/inbox/fil.ts`) : il doit
  être ALLUMÉ (en veille suffit) et dans l'offre (`agent_meta`). Éteint au moment de la réponse : la frise le dit et la
  conversation va à l'équipe avec une demande, jamais à personne.
- **Un agent IA choisi passe par le démarreur du répondeur** (`creerDemarreurRepondeur`) avec SON identifiant : mêmes
  gardes de crédit, de modèle et de statut. Désactivé, ou crédit épuisé : à l'équipe, comme le mode « agent IA ».
  Supprimé : la clé étrangère remet à nul, l'étage retombe sur le répondeur de l'espace.
- **Seule la PREMIÈRE réponse à l'envoi décide** (`premiere_reponse`, la règle de la prise du fil des campagnes « Inbox ») :
  c'est ce qui rend « jusqu'à ce qu'il la close » vrai sans état de plus. Tant que le parcours de l'agent attend, les
  messages lui vont ; après sa sortie, la remise lit de nouveau le réglage de l'espace.
- **« Le répondeur automatique prend la main » n'est plus grisé par le mode de l'espace** : il est possible dès qu'un des
  trois répond (répondeur de l'espace automatique, agent de Meta allumé, un agent IA actif avec le modèle disponible), et
  grisé avec sa raison quand aucun ne le peut. Dans la liste, chaque entrée indisponible est grisée avec sa raison.

## Interfaces

- **Base (migration, en `avant`)** : sur `campaign_etages`, `repondeur text null` (CHECK `in ('mba','agent')`) et
  `repondeur_agent_id uuid null references agents on delete set null`. CHECK de cohérence : `repondeur is null or
  devenir = 'mba'`, et `repondeur_agent_id is null or repondeur = 'agent'`. 🔴 PAS de CHECK « `agent` exige un
  identifiant » : il ferait échouer en 23514 la suppression d'un agent (le `set null` le violerait). Nul partout = le
  répondeur de l'espace, donc aucune campagne existante ne change.
- **Entrée** (`EtageEntrant`, premier étage de `preparerCampagne`, `chaine[]`) : `repondeur?: 'mba' | 'agent'`,
  `repondeurAgentId?: string`. Refusés en 4xx : une valeur inconnue, un `repondeur` sans `devenir: 'mba'`, un agent qui
  n'est pas un agent ACTIF de CET espace (🔴 la clé étrangère ne scope pas l'espace : lecture `tenant_id = $1`).
- **Lecture à la réponse** : une méthode du magasin des campagnes, `repondeurDeLaReponse(tenantId, waId)`, même choix de
  ligne que `campagneAssignanteDuContact` (la campagne la plus récente servie, `c.tenant_id = $1` avant le `limit`),
  SANS le filtre `assigned_to is null`, filtrée sur `repondeur is not null` et `premiere_reponse`. Rend
  `{ nom, cible: 'mba' } | { nom, cible: 'agent', agentId } | null`.
- **La remise** (`remettreSiPersonneNeSuit`) : ses gardes d'abord, inchangées et dans leur ordre ; puis, si la réponse
  désigne un répondeur, il remplace le mode de l'espace pour CE message (`agent` avec cet agent, ou la remise à l'agent
  de Meta avec le repli de `envoyerAuMba`). La décision reste dans le seul module qui confie un contact.
- **MCP** (`prepare_campaign`) : le même couple, validé par la même fonction (`docs` de l'outil : la parité Free).
- **Console** : sous le choix « répondeur automatique » de chaque étage WHATSAPP (une réponse RCS ou e-mail ne passe pas
  par la remise), un sélecteur « Quel répondeur ? ». Ses données viennent de `GET /tenants/:id/repondeur` (agents actifs,
  agent de Meta allumé, modèle disponible) et de l'offre. Le brouillon, la fiche d'une campagne lancée et la fiche d'aide
  disent le choix ; le récapitulatif ne le reprend pas (décidé à la relecture de B : il ne montre aucun devenir).

## Tâches

**Livraison A, le serveur**
1. Migration et sa relecture en base (CHECK sous leur nom, `confdeltype` de la clé étrangère).
2. Validation et écriture des deux champs (étage 1 et chaîne), avec le contrôle d'espace et de statut de l'agent.
3. `repondeurDeLaReponse` et son test d'intégration (la campagne la plus récente gagne, l'isolation entre espaces, la
   seconde réponse ne décide plus).
4. Le branchement dans la remise, et ses tests unitaires : agent choisi lancé avec son identifiant, agent de Meta allumé
   puis éteint, contact muet ou fil de test qui ne part pas, opérateur dans son délai qui garde le fil, parcours en
   attente laissé tel quel, deuxième message rendu au répondeur de l'espace.
5. L'outil MCP et le catalogue généré (`doc:md`).

**Livraison B, la console** (poussée APRÈS le déploiement de A)
6. Le sélecteur, la règle de grisé (fonction pure dans `web/lib/`, testée), la création et le brouillon.
7. La fiche d'une campagne lancée, `features.md`, la fiche d'aide « Lancer une campagne » (publique : `vitrine:aide`, version `en/`,
   `aide:charger` après le push) et son empreinte.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante à la fin de chaque livraison : le lot change
qui répond aux clients qui répondent à une campagne (chemin que la production emprunte), ajoute une migration, et
touche `src/inbox/fil.ts`, qui porte des invariants invisibles (gardes ordonnées, écritures gardées par `only`,
événements de frise). Aucun workflow multi-agents. Ordre : migration `avant`, API et workers, puis la console.

**Essai réel qui clôt** : depuis le téléphone de Julien, sur la SANDBOX (mode « équipe », agent de Meta allumé en veille) :
(1) une campagne dont l'étage WhatsApp confie à un agent IA choisi ; la réponse du téléphone est prise par CET agent ;
(2) l'agent clôt, le message suivant suit le réglage de l'espace (« À traiter ») ; (3) une seconde campagne confiée à
l'agent de Meta : il répond à la réponse du téléphone ; (4) une campagne laissée sur « le répondeur de l'espace » se
comporte comme aujourd'hui.
