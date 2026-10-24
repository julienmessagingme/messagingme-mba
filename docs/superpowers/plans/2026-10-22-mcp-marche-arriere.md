# La marche arrière des outils MCP (lot 1) : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** sept outils MCP, des retouches à cinq outils existants et un e-mail, pour qu'un espace finisse depuis
l'assistant ce qu'il y commence : prendre et rendre la main sur un fil, gérer son adresse de webhook, corriger et
supprimer un modèle, bloquer un contact, freiner et reprendre une campagne, une mention d'IA en anglais. La Free d'abord :
sa console est fermée (`MODULES_OUVERTS_AU_FREE`, `src/server.ts`), donc tout geste qu'un outil laissait « à la
console » n'a aujourd'hui aucun chemin pour elle.

**Architecture :** aucune logique neuve. Chaque outil appelle la fonction du bouton de la console (liste dans les
contraintes). Deux ajouts seulement : les deux phrases de mention relues, à côté de `MENTION_IA_DEFAUT`
(`src/agent/gestion.ts`), et la clé d'e-mail de la Free.

**Spec :** l'analyse du catalogue MCP du 2026-10-21, son tableau par offre validé par Julien le 2026-10-22, et le grill
du 2026-10-22 ci-dessous. La règle qui motive le lot : ce qu'une offre permet de commencer, elle permet de le finir.

## Décisions de Julien (grill du 2026-10-22)

1. **La campagne : les freins et la reprise.** Pause et déprogrammation tout de suite ; la reprise montre d'abord le
   récapitulatif des destinataires restants et exige un code, comme le lancement.
2. **Supprimer un modèle : comme la console.** Refus seulement si une campagne active l'utilise ; la description dit à
   Claude de vérifier avant les messages Shopify (`get_shopify_state`) et les scénarios publiés.
3. **`update_template` entre dans le lot**, pour corriger un modèle refusé sans changer de nom.
4. **La mention d'IA : un choix entre deux phrases relues**, « Vous échangez avec un assistant automatique. » et « You are
   chatting with an automated assistant. ». Le texte libre reste dans la console.
5. **L'e-mail « une conversation attend votre équipe » en Free** dit de répondre depuis Claude ou l'application, et son
   bouton mène à l'offre Pro au lieu d'une Inbox fermée.
6. **L'essai réel se fait à deux** : je pilote les outils depuis Claude sur un espace de test, Julien joue le client
   depuis son téléphone.

## Mes choix (à relire)

- **Un seul outil pour la main du fil, `control_conversation`** (`take_over` ou `hand_back`), les deux boutons de la
  console (`reprendreLaMain` et `rendreLaMain`, `src/inbox/fil.ts`). Sans personne exigée, comme `reply_in_open_window`
  qui prend déjà le fil : une clé qui peut répondre peut aussi rendre la main.
- **Deux outils pour le webhook**, `update_webhook_endpoint` (types, description, pause, nouveau secret) et
  `delete_webhook_endpoint` : une suppression se lit seule dans la demande d'accord de claude.ai. Changer d'URL reste
  « supprimer puis recréer », comme la console et la spec des webhooks (`modifierAdresse` ne touche pas l'URL).
- **Le blocage se désigne par numéro ou par fiche**, et `get_contact` et `search_contacts` rendent `blocked` : un contact
  bloqué n'apparaît plus dans la console hors de son écran, Claude doit pouvoir le retrouver pour le débloquer.
- **Le filtre « qui tient le fil » sort du lot** : `list_conversations` rend déjà `handled_by` sur chaque conversation.
  `get_messages` rend en plus l'identifiant de chaque message, pour enchaîner `get_message_status`.
- **La reprise passe par `launch_campaign`.** `control_campaign` (`prepare_resume`) pose un code sur la ligne de
  `campagne_confirmations`, lié à l'état en pause (statut, destinataires restants). `poser` est déjà un upsert qui remet
  `utilise_le` à nul : aucune migration. Une campagne en pause repart tout de suite, sa date prévue passée est ignorée
  (sinon `lancerCampagne` la refuserait en « date passée »). Un seul outil fait donc partir des messages en masse, et
  toujours avec un code.
- **La langue de la mention est facultative à la création** (le français par défaut, comme aujourd'hui) : la description
  de `create_agent` dit de choisir celle des clients de l'agent.
- **L'e-mail de la Free est une clé à part, `transfert_equipe_free`**, de la même catégorie (le désabonnement
  « conversations qui attendent » la couvre), choisie quand l'offre de l'espace n'ouvre pas l'Inbox. 🔴 Le plafond de dix
  par jour (`transfertsDuJour`, `src/emails-produit/store.pg.ts`) compte aujourd'hui `cle = 'transfert_equipe'` : il doit
  compter les deux clés, sinon la Free y échappe. Les deux textes restent réglables dans `/ops`.
- **Aucune migration, aucune route neuve.**

## Global Constraints

- Les fonctions appelées, sans recopie : `reprendreLaMain` et `rendreLaMain` (`src/inbox/fil.ts`) ; `modifierAdresse`,
  `tournerSecret` et `supprimerAdresse` (`src/evenements/gestion.ts`) ; `modifierUnModele` et `supprimerUnModele`
  (`src/templates/gestion.ts`) ; `setBlocked` (`src/crm/contact-store.pg.ts`) ; `pauseCampaign` et `cancelSchedule`
  (`src/campaign/store.pg.ts`), `lancerCampagne` (`src/campaign/lancement.ts`) ; `modifierAgent` pour la mention.
- L'offre : `fonction: null` partout, sauf `control_campaign` (`console`, comme `launch_campaign`). Le tableau par offre du
  2026-10-22 fait foi.
- `exigePersonne` sur tous, sauf `control_conversation`.
- Les annotations : `destructiveHint: true` sur chaque écriture (règle du répertoire de Claude), titres et descriptions
  en anglais (`tests/mcp-repertoire.test.ts`), toute borne appliquée annoncée dans le schéma.
- Le plafond des opérations lourdes : `update_template` et `delete_template`, avant l'appel à Meta, comme
  `create_template`.
- Aucune émission d'automation ; chaque écriture laisse la trace de la route de la console, signée de la personne, avec
  `via: 'mcp'`.

## Review Focus

1. La reprise : un code tiré d'un état en pause ne relance que cet état ; une reprise faite dans la console entre le
   récapitulatif et l'appel l'invalide ; une campagne en pause ne repart jamais sans code ; sa date passée ne la fait pas
   refuser.
2. `control_conversation` : une main rendue sans numéro connecté (`aucun_numero`) ou refusée par Meta se lit comme un
   refus, et rien n'est écrit.
3. Le nouveau secret d'un webhook n'est montré qu'une fois et l'ancien signe encore 24 h ; une réactivation au-delà de la
   limite de l'offre est refusée en `plan_limit_reached`.
4. La mention : seulement « fr » ou « en », un texte libre reste refusé, la fréquence n'est pas touchée ; un agent à
   phrase personnalisée se lit `personnalisee` et n'est pas réécrit par une modification qui ne le demande pas.
5. L'e-mail : un espace sans Inbox reçoit la version Free, les autres celle d'aujourd'hui ; le plafond compte les deux
   clés.

## Méthode de livraison

**Implémenteur (moi), puis une relecture indépendante du diff en fin de lot, et Julien qui juge l'essai réel**, parce
que le lot touche des chemins que la production emprunte (le fil d'une conversation, un envoi de masse par la reprise,
des modèles chez Meta, la phrase en tête des réponses d'un agent, un e-mail aux administrateurs) et des invariants
invisibles (un code lié à un état, qui tient le fil, un plafond compté par clé). Pas de feature-loop : chaque outil
enveloppe une fonction déjà en production, sans migration ni route neuve, et ce qui compte se juge face à un vrai
contact.

**L'essai réel qui clôt (à deux)**, sur un espace de test, celui du connecteur de la session, vérifié par `get_plan`
avant de commencer :

1. Julien écrit au numéro, l'agent IA répond ; je réponds par `reply_in_open_window` ; il réécrit, l'agent se tait ;
   `control_conversation` rend la main ; il réécrit, l'agent répond.
2. `block_contact` sur son numéro : il écrit, rien ne lui répond et son message est enregistré (`get_messages`) ; une
   fois débloqué, l'agent lui répond de nouveau.
3. Un modèle de test : `create_template`, `update_template` (le corps corrigé), `get_template_status`, puis
   `delete_template` ; la console ne le montre plus.
4. Le webhook : `update_webhook_endpoint` (types, pause, nouveau secret, puis `send_test_event` signé du nouveau), puis
   `delete_webhook_endpoint` et une adresse recréée.
5. Une campagne de trois contacts de Julien ou de l'équipe, au débit d'un message par minute : `launch_campaign`, la
   pause après le premier envoi, `prepare_resume`, puis `launch_campaign` avec le code ; les deux restants partent et
   personne ne reçoit deux fois. Puis une campagne programmée, déprogrammée.
6. La mention passée en anglais : `test_agent`, puis le téléphone de Julien, montrent « You are chatting with an
   automated assistant. ».
7. L'e-mail de la Free par l'envoi d'essai de `/ops` (`transfert_equipe_free`), dans les deux langues.

L'essai entre dans `docs/prive/ESSAIS-REELS.md` à la livraison.

## Ordre de déploiement

1. Annoncer aux sessions voisines avant d'éditer `src/index.ts` et `src/socle.ts` (câblage partagé) ; commit en
   plomberie, le patch appliqué sur `origin/main`, jamais un blob reconstruit depuis l'arbre.
2. Suite racine, auto-attaque, typecheck ; dans `web/`, `npm run doc:md` puis la suite vitest entière ; `aide-proposer`
   si `features.md` bouge ; push ; la CI lue job par job (`gh run view --json jobs`).
3. Aucune migration. `up -d --build` de `mba-api` (les outils) et de `mba-worker` (les deux lisent `src/socle.ts`, d'où
   part l'e-mail), avec la même `REVISION`.
4. Le plugin : version de `plugin.json` montée, `npm run plugin:generer`, push, puis `gh workflow run plugin.yml --ref
   main`.
5. L'essai réel à deux.

### Tâche 1 : la main du fil, `control_conversation`, et l'identifiant des messages

**Fichiers :** `src/mcp/outils.ts` (l'outil, `DepsMcp`), `src/index.ts` (câblage du contrôle du fil, annoncé),
`web/lib/partage/catalogue-mcp.ts`, `web/lib/mcp-outils.ts`, `scripts/plugin/familles-outils.ts` ; tests
`tests/mcp-control-conversation.test.ts` (nouveau), `tests/mcp-serveur.test.ts` (table des annotations).

- [ ] Tests : `take_over` appelle `reprendreLaMain`, `hand_back` appelle `rendreLaMain`, avec l'auteur (la personne, ou
      « agent tiers (MCP) » derrière une clé) ; `refuse` et `aucun_numero` deviennent des refus lisibles ; une
      conversation d'un autre espace est refusée comme une inconnue. `get_messages` rend `message_id`. Rouges, puis verts.

### Tâche 2 : les webhooks, `update_webhook_endpoint` et `delete_webhook_endpoint`

**Fichiers :** `src/mcp/outils-evenements.ts`, le catalogue, `web/lib/mcp-outils.ts`, les familles ; tests
`tests/mcp-evenements.test.ts`.

- [ ] Tests : la modification passe par `modifierAdresse` (types, description, `active`), le nouveau secret par
      `tournerSecret` (rendu une fois, avec la fin de validité de l'ancien), la suppression par `supprimerAdresse` ;
      réactiver au-delà de la limite rend le refus de l'offre ; une `url` dans la saisie est refusée, et la description
      dit « supprimer puis recréer » ; la trace de la console, avec `via: 'mcp'`.

### Tâche 3 : les modèles, `update_template` et `delete_template`

**Fichiers :** `src/mcp/outils-modeles.ts`, le catalogue, `web/lib/mcp-outils.ts`, les familles ; tests
`tests/mcp-modeles.test.ts` (nouveau).

- [ ] Avant : relire `~/.claude/brain/LEARNINGS.md` et `MESSAGINGME.md` sur l'édition et la suppression d'un modèle chez
      Meta (combien d'éditions d'un modèle approuvé, délai avant de réutiliser un nom supprimé), le vérifier dans la doc
      de Meta, et le dire dans les deux descriptions.
- [ ] Tests : `update_template` passe par `modifierUnModele` (le format de Meta de `create_template`, les statuts
      éditables, le refus d'une campagne active, l'en-tête ou le pied qui sauterait) ; `delete_template` par
      `supprimerUnModele` (toutes les langues du nom, refus d'une campagne active avec ses campagnes) ; les deux comptent
      dans le plafond lourd avant l'appel à Meta.

### Tâche 4 : le blocage, `block_contact`

**Fichiers :** `src/mcp/outils.ts`, `src/index.ts` (annoncé), le catalogue, `web/lib/mcp-outils.ts`, les familles ;
tests `tests/mcp-block-contact.test.ts` (nouveau).

- [ ] Tests : bloquer et débloquer passent par `setBlocked` avec la personne ; un numéro ou une fiche inconnus de l'espace
      sont refusés ; `get_contact` et `search_contacts` rendent `blocked`. La garde existante (un contact bloqué n'est
      confié à aucune machine) n'est pas retouchée : un test l'exerce depuis l'outil.

### Tâche 5 : les freins et la reprise d'une campagne, `control_campaign`

**Fichiers :** `src/mcp/outils-campagnes.ts`, le catalogue, `web/lib/mcp-outils.ts`, les familles ; tests
`tests/mcp-control-campaign.test.ts` (nouveau), `tests/mcp-launch-campaign.test.ts`.

- [ ] Tests : `pause` passe par `pauseCampaign` (une campagne qui n'envoie pas donne un refus lisible), `unschedule` par
      `cancelSchedule` ; `prepare_resume` rend le récapitulatif (destinataires restants, modèle, catégorie) et un code
      posé sur l'état en pause ; `launch_campaign` reprend avec ce code par `lancerCampagne`, tout de suite même si la
      date prévue est passée ; un code d'avant une reprise faite dans la console est refusé ; une campagne d'un autre
      espace n'existe pas ; en Free, le refus avec le lien de l'offre. Chaque test de garde vérifié dans les deux sens.

### Tâche 6 : la mention d'IA en anglais

**Fichiers :** `src/agent/gestion.ts` (les deux phrases, à côté de `MENTION_IA_DEFAUT`), `src/mcp/outils-agent.ts`
(`create_agent`, `update_agent`, `get_agent`) ; tests `tests/mcp-agent.test.ts`.

- [ ] Tests : `mention_ia_langue` à `en` écrit la phrase anglaise par `modifierAgent` (sa trace `agent.mention_modifiee`
      comprise), `fr` la française ; toute autre valeur et tout texte libre sont refusés ; `get_agent` rend `fr`, `en` ou
      `personnalisee` ; un agent à phrase personnalisée garde sa phrase quand on modifie autre chose. La phrase part telle
      quelle en tête de la réponse (`pourLeContact`), sans autre retouche.

### Tâche 7 : l'e-mail d'attente en Free

**Fichiers :** `src/emails-produit/catalogue.ts` (la clé `transfert_equipe_free`, en français et en anglais),
`src/emails-produit/alertes.ts` (`creerPrevenirEquipe` choisit la clé selon l'offre), `src/emails-produit/store.pg.ts`
(`transfertsDuJour` compte les deux clés), `src/socle.ts` (le câblage reçoit l'offre, annoncé) ; tests
`tests/emails-produit-alertes.test.ts`, `tests/emails-produit.test.ts`, et le test d'intégration du store (CI seulement).

- [ ] Tests : un espace dont l'offre n'ouvre pas l'Inbox reçoit la clé Free, avec le lien de l'offre ; un Pro et une
      Entreprise reçoivent l'e-mail d'aujourd'hui ; une offre illisible se replie sur l'Entreprise, donc sur l'e-mail
      d'aujourd'hui ; le onzième passage du jour n'envoie rien, quelle que soit la clé (vérifié dans les deux sens : le
      compte remis à une seule clé laisse partir le onzième) ; les deux langues et leurs variables passent les tests du
      catalogue.

### Tâche 8 : la doc, le plugin, la livraison

- [ ] `features.md` (la section du serveur MCP, celle des e-mails aux administrateurs, la mention d'IA), avec chaque fiche
      d'aide qui cite une section retouchée et son empreinte dans le même commit (`recevoir-les-e-mails-de-messaging-me.md`
      au moins) ; `documentation.md` (l'item du MCP) ; la doc Markdown régénérée (`npm run doc:md`) ; le README du plugin
      (`npm run plugin:generer`).
- [ ] Les suites, la relecture du lot, le push, le déploiement, le plugin, l'essai réel.

## Suite : les jaunes de la relecture (2026-10-22, lot 2)

La relecture des tâches 1 à 8 a rendu deux rouges, corrigés avant le déploiement (2bf50c54), et huit jaunes. Julien
demande de les traiter en un lot relu, avec un constat de la session du plugin : une réponse par `reply_in_open_window`
ne lève pas `escaladee_le`.

1. `control_conversation` (`hand_back`) refuse un contact qui a dit STOP ou qui est bloqué : en mode `mba`,
   `rendreLaMain` le confierait à l'agent de Meta sans la garde du consentement, et l'outil s'ouvre aussi derrière une
   clé d'API. Il refuse aussi en mode « équipe », où aucun robot ne reprendrait le fil. Le refus de `take_over` ne
   pousse plus à écrire au contact.
2. `control_campaign` (`prepare_resume`) rend le motif de la pause et la phrase de la console (`messageDePause`), refuse
   une pause que seule une autre action lève (numéro délié, abonnement impayé), et refuse selon le statut au lieu de
   « mettez-la en pause d'abord ». Le refus d'un code déjà utilisé sur une campagne en pause ne dit plus que la reprise
   est partie.
3. `update_template` refuse un modèle à bouton Flow : ce format ne le renvoie pas, et les composants remplacent ceux
   d'avant.
4. Les textes qui renvoient encore à la console un geste que le lot a outillé : `reply_in_open_window`,
   `ACTION_WEBHOOK` (et sa version anglaise), la FAQ du plugin (l'agent muet, les actions), la mise en service,
   `features.md` (ce que Claude ne règle pas, le blocage) avec la fiche « signaler ou bloquer » et son empreinte, la
   page `/developers/mcp` (« Pas de campagne »).
5. L'e-mail de la Free : ne plus faire recopier un nom qui peut être un numéro masqué, et borner la règle des 24 heures
   à ce qui répond par l'API.
6. `escaladee_le` : une réponse de Claude signée d'une personne (jeton OAuth) vaut une réponse de l'Inbox, elle lève
   l'escalade et relance le délai de reprise ; une clé d'API (agent tiers) reste un automate.
7. Deux tests qui tiennent enfin ce qu'ils disent : le plafond des transferts lu dans les paramètres de la vraie
   requête, et une mention d'IA personnalisée gardée par une autre modification.

**Méthode** : en direct, dans une copie à part de `main` (la session du plugin a du travail non poussé sur deux fichiers
du lot), puis une relecture indépendante du lot entier ; chaque test de garde vérifié dans les deux sens. Aucune
migration. **Déploiement** : API et worker, puis le plugin (0.3.5 ou 0.3.6, selon qui publie le premier avec la session
du plugin), puis la fiche d'aide rechargée. **Essai réel** : rattaché à celui du lot 1 (étape 1 : un contact qui a dit
STOP n'est pas rendu ; une réponse de Claude après une escalade laisse revenir l'agent après le délai).

## Suite : les jaunes du lot 2 et de l'essai réel (2026-10-23, lot 3)

La relecture du lot 2 a laissé six jaunes (`todo.md`), l'essai réel du 2026-10-23 deux de plus. Julien demande de les
traiter en un lot relu.

1. **Les statistiques** comptent comme « répondue » une demande à laquelle une personne a répondu par Claude, comme le
   fil le fait depuis le lot 2 : un seul fragment SQL (`REPONSE_DE_L_EQUIPE_SQL`, à côté de `vautReponseDeLEquipe`), lu
   par les trois endroits de `src/stats/performance.pg.ts`. La frise signe la prise du fil de la personne.
2. **Une réaction** envoyée par Claude ne lève plus l'escalade (`vautReponseDeLEquipe` lit le type).
3. **Un modèle envoyé par Claude** (`send_template_to_contact`) ne lève pas l'escalade (il part en différé, par le
   moteur de campagne, et peut encore échouer) : sa description dit le geste qui la lève, `control_conversation`.
4. **`hand_back` en mode « équipe »** n'est plus refusé : il sort la conversation d'« À traiter » et rend un parcours en
   attente, et son résultat dit qu'aucun répondeur automatique ne répondra.
5. **`update_template`** relit le modèle sans le cache, refuse un bouton d'URL dynamique, et un modèle à bouton que la
   lecture ne sait pas renvoyer (téléphone, code à copier, appel, catalogue) devient non éditable, console comprise.
6. **Les textes** : les refus de `control_conversation` derrière une clé d'API, la description de
   `reply_in_open_window`, et la règle des 24 heures des deux e-mails de transfert, fausse pour un numéro relié par
   l'application WhatsApp Business.
7. **`list_templates`** n'affiche plus l'ancien état après une création, une correction ou une suppression par Claude :
   le cache d'une minute s'oublie après chacune.
8. **`rotate_secret`** rend la vue de l'adresse relue après la rotation.

**Méthode** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde vérifiée dans
les deux sens. Le câblage partagé (`src/index.ts`, une ligne pour le cache) s'annonce aux sessions voisines. Aucune
migration. **Déploiement** : API et workers, avec l'accord de Julien. **Essai réel** : `list_templates` juste après une
correction, et `hand_back` en mode « équipe ».

## Suite : les jaunes de la relecture du lot 3 (2026-10-23, lot 4)

La relecture du lot 3 a laissé douze jaunes (`todo.md`). Julien en a tranché quatre le même jour : le point 12
(accepter), le point 9 (exclure la réaction pour tous), le point 3 (l'écrire comme limite) et le point 11 (garder la
phrase).

1. **`update_template`** reconnaît nos liens tracés quel que soit l'hôte (`codeDuLienTrace`), et ses deux gardes (bouton
   Flow, lien à variable) passent dans `modifierUnModele`, sur le modèle qu'il lit déjà chez Meta : une seule lecture
   (point 7), par un refus propre à l'appelant, la console gardant son comportement.
2. **L'écran Modèles** : l'infobulle du « Modifier » grisé dit ce qui bloque vraiment, et « Dupliquer » prévient quand le
   modèle a un élément que la console ne recopie pas tel quel.
3. **Une réaction n'est jamais une réponse de l'équipe**, qu'elle vienne de Claude ou d'un humain (escalade et
   statistiques) ; un test d'intégration prouve le fragment SQL en base.
4. **`hand_back` en mode « équipe »** est accepté pour un contact STOP ou bloqué (aucun robot ne lui écrit, la garde à
   l'envoi le tient) ; son `a_savoir` le dit, et nomme `set_default_responder` comme un geste d'une personne connectée.
5. **`update_webhook_endpoint`** : une relecture ratée après la rotation ne perd pas le secret neuf.
6. **Les textes** : l'oubli de la liste ne vaut que dans une copie de l'API (et la console ne l'oublie pas) ; la
   suppression du compte d'un collaborateur qui répondait par Claude, limite écrite ; les phrases devenues fausses.

**Méthode de livraison** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde
vérifiée dans les deux sens. Pas de câblage partagé touché, aucune migration ; la console (`web/`) se publie au push,
un texte et un avertissement sans route neuve. **Déploiement** : API et workers, avec l'accord de Julien. **Essai
réel** : `hand_back` en mode « équipe » sur un contact bloqué, et l'infobulle de l'écran Modèles.

## Suite : les jaunes de la relecture du lot 4 (2026-10-23, lot 5)

La relecture du lot 4 a laissé neuf jaunes (`todo.md`). Julien demande de commencer par la double lecture du mode.

1. **`hand_back` ne confie jamais un contact STOP ou bloqué à l'agent de Meta**, même si le mode passe à `mba` entre la
   lecture de l'outil et celle du fil : `rendreLaMainSousConsentement` (`src/inbox/fil.ts`) fait jouer la garde de
   `confier` (`contact_muet`) sur le mode qu'il relit lui-même, et l'outil refuse ce retour. Le bouton de la console
   garde `rendreLaMain`. Tenu dans le vrai contrôle du fil (`tests/repondeur-modes.test.ts`).
2. **La rotation du secret** : l'audit raté ne fait plus échouer l'outil (journal en erreur), le secret neuf est rendu.
3. **Nos liens tracés** : un lien de la forme `/r/<code>/{{1}}` ne passe que si son code est l'un des liens tracés
   confirmés de cette langue du modèle.
4. **Les textes** : `features.md` (édition et duplication des modèles, et l'empreinte des deux fiches qui citent la
   section), l'infobulle et le refus de l'édition (un composant inconnu), le `a_savoir` (« de lui-même »), les
   commentaires (la garde des robots, `machineSeTaitParWaId` ; « sans garde de plus »).

**Méthode de livraison** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde
vérifiée dans les deux sens. Pas de câblage partagé (le fil passe entier aux outils), aucune migration. La console
(`web/`) se publie au push, un texte. Les deux fiches ne changent que d'empreinte, leur page publique est identique
(`vitrine:aide` vérifié). **Déploiement** : API et workers, avec l'accord de Julien. **Essai réel** : `hand_back` en
mode « équipe » sur un contact bloqué (la phrase dit « de lui-même »), et sous l'agent le refus.

## Suite : les jaunes de la relecture du lot 5 (2026-10-24, lot 6)

La relecture du lot 5 a laissé huit jaunes (`todo.md`), dont deux restes du lot 4.

1. **`update_template`** : un lien `/r/<code>/{{1}}` est l'un des nôtres si son code appartient à l'espace, confirmé ou
   non (`getByCode`, la lecture de la redirection publique) ; la lecture n'a lieu que pour un lien de cette forme, et
   une base qui ne répond pas est un refus « réessayez ». La garde de l'appelant de `modifierUnModele` devient asynchrone.
2. **`hand_back`** : le refus `contact_muet` est neutre ; si le fil confie à l'agent de Meta un contact libre après un
   mode relu à `mba`, le résultat ne parle plus du mode « équipe » ; la phrase se limite à nos robots (scénario, agent
   IA). Un test monte le vrai contrôle du fil sous l'outil.
3. **`confier`** : un geste non automatique dit s'il garde le consentement (le type l'exige).
4. **Un modèle sans corps** : le refus de l'édition et l'infobulle le disent.
5. **Commentaires** : la règle du fil de test, la doc du consentement, l'en-tête des dépendances du MCP.

**Méthode de livraison** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde
vérifiée dans les deux sens. Pas de câblage partagé (les liens tracés passent à la gestion sous la forme du dépôt
entier), aucune migration ; la console (`web/`) se publie au push, un texte. **Déploiement** : API et workers, avec
l'accord de Julien. **Essai réel** : `hand_back` en mode « équipe » sur un contact bloqué (la phrase nomme scénario et
agent IA), et sous l'agent le refus.

## Suite : le fil que l'agent de Meta tient en veille (2026-10-24, lot 7)

Le jaune 1 de la relecture du lot 6, seul (décision de Julien). L'essai réel sur « Messaging Me Tech SANDBOX » l'a
cerné : la console n'y mène pas (sur un fil que l'agent de Meta tient hors du mode `mba`, l'Inbox n'offre que
« Reprendre la main », qui retire le contact de sa liste) ; l'outil `control_conversation` (`hand_back`), qui ne regarde
pas le détenteur, écrivait `app_workflow` sans rien demander à Meta, et l'agent gardait le fil (essai : tant qu'il le
tient, il répond).

1. **`rendre` (`src/inbox/fil.ts`)** : sur un fil `mba` alors que l'agent n'est pas le répondeur, le lui reprendre
   (retrait de la liste, comme « Reprendre la main »), puis écrire `app_workflow` (la frise dit `prise_mba`) ; Meta qui
   refuse le retrait lève `AgentDeMetaGardeLeFil`, rien n'est écrit. En mode `mba`, rien ne change. Vaut pour l'outil et
   pour la console (décision de Julien : « le reprendre à l'agent »).
2. **Les refus lisibles** : l'outil et la route `/release` de la console disent que l'agent garde la conversation.

**Méthode de livraison** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde
vérifiée dans les deux sens, sur le vrai contrôle du fil (`bancDuFil`). Pas de câblage partagé, aucune migration.
**Déploiement** : API et workers, avec l'accord de Julien. **Essai réel** : Claude connecté à la SANDBOX (mode
« équipe », agent de Meta en veille) : ESSAI17, puis `hand_back` par Claude, puis une question : l'agent de Meta se tait.

## Suite : les jaunes qui touchent un client, et les textes faux (2026-10-24, lot 8)

Un lot court (décision de Julien) : les trois jaunes qui peuvent atteindre un client, et les textes que les lots 6 et 7
ont rendus faux. Le reste attend dans `todo.md`.

1. **La confirmation des liens tracés (`src/templates/gestion.ts`)** : après une soumission acceptée, elle est retentée
   (trois essais) puis, si elle échoue encore, journalisée en ERREUR (`liens_traces_non_confirmes`) : sans elle, chaque
   envoi du modèle part sans son suffixe (131008), et rien ne le disait.
2. **Un contact STOP ou bloqué que l'agent de Meta tient en veille** : le refus de `hand_back` nomme `take_over`, qui
   le lui reprend sans rien écrire au contact.
3. **`restaurer` ne remet que les liens confirmés** : écrit comme limite connue (le point 1 rend son préalable rare ; le
   corriger demande une lecture neuve du store et son test d'intégration).
4. **Les textes** : la puce « Rendre la main » de `features.md` (et l'empreinte de sa fiche), `rendAgentDeMeta`
   (`fil.ts`, `store.pg.ts`, manuel), la doc de `releaseControl` et le journal de `/release`, deux phrases du manuel.

**Méthode de livraison** : en direct, dans une copie à part de `main`, puis une relecture indépendante ; chaque garde
vérifiée dans les deux sens. Pas de câblage partagé, aucune migration, aucune route neuve. **Déploiement** : API et
workers, avec l'accord de Julien, puis `aide:charger` (l'empreinte d'une fiche publique change). **Essai réel** : aucun
geste client nouveau à cliquer ; la journalisation de l'échec de confirmation ne se provoque pas en production sans
casser la base, elle est tenue par son test vérifié dans les deux sens.
