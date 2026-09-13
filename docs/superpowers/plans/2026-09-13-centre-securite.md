# Le centre de Sécurité & compliance : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> ou `superpowers:executing-plans`, tâche par tâche.

**But :** un menu « Sécurité » avec sa page d'accueil et quatre sous-menus, et surtout : un opt-out qui
bloque réellement tous les envois automatiques.

**Spec :** [../specs/2026-09-13-centre-securite-design.md](../specs/2026-09-13-centre-securite-design.md)

## Méthode de livraison

**Retenue : implémenteur par lot, puis revue humaine sur le DIFF, en TROIS lots livrés séparément.**
Lot 1, le menu et sa coquille (tâches 1 et 2). Lot 2, le blocage réel des envois (tâches 3 et 4). Lot 3,
l'écran Consentement et l'observation (tâches 5 à 7). Le sous-menu IA et le journal des erreurs
(tâches 8 et 9) viennent après ; les deux sont cadrés depuis les arbitrages de Julien du 2026-09-13.

**Pourquoi** : la deuxième question tranche à elle seule. **Rien n'est réversible ici.** Un envoi bloqué
à tort est une campagne que le client croit partie ; un envoi passé à tort est un message reçu par
quelqu'un qui avait demandé qu'on le laisse tranquille, c'est-à-dire précisément le manquement que ce
menu existe pour empêcher. La production emprunte ce chemin sur **quatre** points d'envoi différents, et
`optInAllows` n'est aujourd'hui appelée qu'à deux d'entre eux : l'ajouter aux autres, c'est toucher au
scénario, à l'automation et à l'agent, chacun avec ses propres chemins de sortie.

**Pourquoi surtout pas feature-loop** : les critères sont testables, mais ce qu'il faut vérifier n'est
pas « le test passe », c'est **« a-t-on trouvé TOUS les chemins d'envoi ? »**. Une liste exhaustive ne se
prouve pas par un test vert : c'est une question qu'on pose au dépôt, et qu'un œil doit valider.

🔴 **L'essai réel qui clôt la feature** : écrire « stop » depuis un vrai téléphone, constater le passage
en opt-out, **puis tenter d'atteindre ce contact par un scénario ET par une automation**, et constater
que rien ne part. Puis l'essai inverse, celui qui protège l'usage : un opérateur doit encore pouvoir lui
répondre à la main dans l'Inbox.

## Contraintes globales

Celles des plans du 2026-09-12 s'appliquent à l'identique. Trois ajouts propres à ce lot :

- 🔴 **UN OPT-OUT NE SE DEVINE JAMAIS EN SILENCE.** Toute écriture automatique de `opted_out` doit être
  traçable : qui l'a posée, depuis quel message, à quelle date. C'est un sujet de conformité.
- 🔴 **LA RÈGLE ÉLARGIE N'AGIT PAS, ELLE OBSERVE** (tâche 6). Mesure du 2026-09-13 : sur 135 messages
  entrants réels, **zéro** opt-out sous la règle actuelle comme sous une règle élargie. Il n'y a rien
  sur quoi calibrer, et élargir au jugé est exactement ce que `src/crm/consentement.ts` déconseille.
- ⚠️ **AUCUNE ADRESSE EXISTANTE NE DOIT CASSER.** Les audit trails changent de menu, pas d'URL, ou alors
  l'ancienne redirige.

---

### Tâche 1 : le menu « Sécurité » et sa page d'accueil

**Fichiers**
- Modifier : `web/lib/nav.ts` (dans `NAV_ADMIN_BAS`, entre Support et Developers)
- Créer : `web/app/securite/page.tsx`
- Test : `web/e2e/securite-navigation.spec.ts`

**Produit** : « Bienvenue au centre de sécurité & compliance de Engage Me », puis une boîte par
sous-menu. La barre latérale reste à gauche et déplie les sous-menus sous « Sécurité ».

- [x] **Étape 1 : les tests** (l'entrée existe au BAS, les sous-menus se déplient, la page d'accueil
      porte une boîte par sous-menu, rien ne déborde en 1280 x 800)
- [x] **Étape 2 : implémenter, relancer**
- [x] **Étape 3 : MUTER** : retirer un sous-menu de la nav sans retirer sa boîte, constater que le test
      de correspondance rougit. ⚠️ C'est le défaut qui arrive vraiment : une boîte qui mène nulle part.
- [x] **Étape 4 : commit**

---

### Tâche 2 : les audit trails ET le journal de livraison déménagent

**Fichiers**
- Modifier : `web/lib/nav.ts`, `web/app/parametres/`, `web/app/securite/`

⚠️ **LES DEUX ENSEMBLE, parce qu'ils sont déjà au même endroit** (mesuré le 2026-09-13 : le journal des
erreurs de livraison est rangé « au même endroit que le journal des actions »). Les séparer coûterait
deux déménagements et laisserait Paramètres à moitié vidé.

⚠️ **LE JOURNAL DE LIVRAISON PORTE LES NUMÉROS DE TÉLÉPHONE, délibérément**, et il est admin-only. Le
déplacer ne doit pas l'ouvrir plus largement.

- [x] **Étape 1 : le test qui garde l'ANCIENNE adresse** (elle redirige, ou elle marche encore)
- [x] **Étape 2 : déplacer, relancer**
- [x] **Étape 3 : vérifier qu'aucun lien du produit ne pointe encore sur l'ancienne place** (`grep`)
- [x] **Étape 4 : commit**

---

### Tâche 3 : l'inventaire des chemins d'envoi

**Fichiers**
- Créer : `tests/optout-chemins.test.ts`

🔴 **CETTE TÂCHE NE PRODUIT PAS DE FONCTIONNALITÉ, ELLE PRODUIT UNE LISTE, ET C'EST LA PLUS IMPORTANTE
DU LOT.** Mesure du 2026-09-13 : `optInAllows` n'est appelée QUE dans `src/campaign/build.ts` et
`src/api/sends-build.ts`. Il faut établir la liste EXHAUSTIVE des chemins par lesquels un message
sortant peut partir, et dire pour chacun s'il doit être bloqué.

Décision de Julien du 2026-09-13 : **tout sauf la réponse manuelle d'un opérateur.**

- [x] **Étape 1 : établir la liste** en partant des appels réels d'envoi (`sendText`, `sendTemplate`,
      le sender RCS, le bloc e-mail), pas en partant de ce qu'on croit savoir
- [x] **Étape 2 : l'écrire dans un test qui la TIENT**

```ts
// 🔴 UNE LISTE ECRITE A LA MAIN DERIVE DES QU ON AJOUTE UN CHEMIN D ENVOI. Ce test derive la liste
// du CODE (les appelants reels du client Meta) et rougit quand un chemin neuf n a pas ete classe.
it('tout chemin d envoi est CLASSE : bloque par un opt-out, ou explicitement exempte', () => { /* ... */ });
```

- [x] **Étape 3 : MUTER** : ajouter un faux chemin d'envoi non classé, constater le rouge
- [x] **Étape 4 : commit**

---

### Tâche 4 : le blocage, sur tous les chemins sauf la main de l'opérateur

**Fichiers**
- Modifier : les chemins établis en tâche 3 (scénario, automation, agent IA)
- Test : `tests/optout-blocage.test.ts` + intégration

- [x] **Étape 1 : les tests, un par chemin, ET le cas d'exemption**

```ts
it('un scenario n envoie RIEN a un contact opted_out', async () => { /* ... */ });
it('une automation non plus', async () => { /* ... */ });
it('l agent IA non plus', async () => { /* ... */ });

// 🔴 LE CAS QUI PROTEGE L USAGE, et il est aussi important que les trois precedents : sans lui, un
// operateur ne pourrait meme plus accuser reception d un opt-out, ni repondre a une reclamation
// posee juste apres. La machine se tait ; la personne peut encore repondre a la personne.
it('mais un operateur PEUT encore repondre a la main dans l Inbox', async () => { /* ... */ });
```

- [x] **Étape 2 : implémenter, relancer, MUTER** (retirer la garde d'un seul chemin, constater que
      seul son test rougit : c'est ce qui prouve que les trois sont indépendants)
- [x] **Étape 3 : commit**

---

### Tâche 5 : la liste des opt-out, et ce qu'on en fait

**Fichiers**
- Créer : `web/app/securite/consentement/page.tsx`, la route de liste et d'export

- [x] La liste, **exportable**
- [x] Un clic donne le **résumé de la conversation** qui a mené au refus
- [x] Un clic de plus ouvre **la conversation dans l'Inbox**
- [x] Le **téléchargement de la conversation entière** qui a abouti à l'opt-out
- [x] ⚠️ **`tenant_id = $1` sur CHAQUE requête**, et le contrôle d'accès : cet écran donne des
      conversations complètes. Réservé aux admins et managers.
- [x] Tests, mutation, commit

---

### Tâche 6 : la règle élargie, EN OBSERVATION

**Fichiers**
- Modifier : `src/crm/consentement.ts`
- Test : `tests/consentement-observation.test.ts`

🔴 **ELLE NE DÉSABONNE PERSONNE.** Quand elle reconnaît un refus que la règle actuelle n'aurait pas vu,
elle journalise le message et le fait remonter dans l'écran Consentement, sous « refus possibles à
confirmer ». L'opérateur confirme ou écarte, et chaque geste devient une donnée de calibrage.

- [x] **Étape 1 : les tests, dont le plus important**

```ts
// 🔴 L ELARGISSEMENT N AGIT PAS. Sans ce cas, un jour de distraction transformerait l observation en
// desabonnement automatique, sur une regle que PERSONNE n a calibree faute de donnees.
it('un refus reconnu par la seule regle ELARGIE ne pose PAS opted_out', () => { /* ... */ });
it('mais il est journalise et remonte a confirmer', () => { /* ... */ });
// L AUTRE SENS : la regle ACTUELLE, elle, continue de desabonner toute seule.
it('« stop » en debut de message desabonne toujours, sans confirmation', () => { /* ... */ });
```

- [x] **Étape 2 : implémenter, relancer, MUTER, commit**

---

### Tâche 7 : l'opt-out déclenche un APPEL D'OUTIL

**Tranché par Julien le 2026-09-13** : au moment où un opt-out est déclaré, l'espace peut déclencher un
**outil / connecteur API** déjà déclaré dans Tools, pour pousser le refus vers son propre système (CRM,
HubSpot, back-office).

🔴 **C'EST CE QUI REND LE REFUS OPPOSABLE AILLEURS QUE CHEZ NOUS.** Un opt-out qui ne vit que dans notre
base laisse le client continuer à écrire à cette personne depuis ses autres outils, et c'est lui qui en
répond. C'est la raison pour laquelle Julien a nommé les Tools dans sa demande.

⚠️ **L'APPEL NE DOIT JAMAIS BLOQUER L'OPT-OUT LUI-MÊME.** On écrit `opted_out` d'abord, on appelle
ensuite. Un connecteur en panne ne doit pas faire échouer le respect d'un refus : ce serait exactement
l'inverse de ce que ce menu existe pour garantir. L'échec se journalise et se réessaie.

- [x] Le réglage (quel outil, ou aucun), avec la liste venue de Tools
- [x] L'appel APRÈS l'écriture, jamais avant, et jamais bloquant
- [x] Un test qui MUTE l'ordre : l'appel avant l'écriture, et un connecteur en panne -> l'opt-out doit
      quand même être posé
- [x] Tests, mutation, commit

---

### Tâche 8 : le sous-menu IA

Remonter la bascule « l'IA se déclare comme telle » de la fiche d'agent au niveau de l'ESPACE.

- [x] 🔴 **NE PAS CHANGER LE COMPORTEMENT DES AGENTS EXISTANTS** : c'est une migration de réglage. Un
      agent déjà configuré doit continuer à faire exactement ce qu'il faisait. Le défaut `session` et
      le choix `jamais` ont été tranchés le 2026-09-09 en connaissance de cause.
- [x] ⚠️ **LE META BUSINESS AGENT N'EST PAS CONCERNÉ** : Meta écrit déjà « IA » sous ses messages, notre
      propre déclaration en ferait deux.

---

### Tâche 9 : le journal des erreurs, LES DEUX

**Tranché par Julien le 2026-09-13** : « on a déjà un log d'erreurs [...] donc il faut les 2 ».

🔴 **LA MOITIÉ CLIENT EXISTE DÉJÀ ET DÉMÉNAGE EN TÂCHE 2** : `GET /tenants/:tenantId/erreurs-livraison`
rend ce que Meta a répondu quand un message n'est pas parti, avec sa recherche par téléphone et par code,
et son écran `ErreursLivraison.tsx`. **Ne rien recréer.** Le vérifier avant d'écrire une ligne : un
second journal à côté du premier se contredirait le jour où l'un filtre autrement que l'autre.

Ce qui s'AJOUTE ici, c'est la moitié SYSTÈME : les retours d'API qui n'ont pas fonctionné, et les échecs
d'avancement de parcours (`workflow_advance_failures`, migration 0108, déjà en base).

- [x] **Étape 1 : inventorier ce qui est DÉJÀ journalisé** avant d'en journaliser plus. Le dépôt porte
      des DLQ, `/ops` et des alertes Telegram : la question n'est pas « que journaliser » mais « qu'est-ce
      qui est déjà écrit quelque part et que personne ne montre au client »
- [x] **Étape 2 : les deux moitiés dans le même écran**, distinguées par leur NATURE et non mélangées
- [x] ⚠️ **Ce qui porte des numéros reste admin-only**
- [x] Tests, mutation, commit

## Revue

Revue `/revue` systématique, plus le rayon de souffle :

- **Qui écrit `opted_out` aujourd'hui ?** Quatre chemins connus (la fiche contact, l'action en masse, le
  bloc Action d'un scénario, le mot-clé entrant). Chacun doit rester traçable.
- **Qui LIT `opt_in_status` ?** Ajouter un blocage change ce que ces lecteurs voient partir.
- **Les compteurs de campagne** : un destinataire écarté pour opt-out doit apparaître comme écarté AVEC
  son motif, pas disparaître du compte. Sinon le client voit une audience qui fond sans explication.

---

## Ou en est ce plan (2026-09-13 au soir)

| Tache | Etat |
|---|---|
| 1. Le menu « Securite » et sa page d accueil | ✅ `23fb288` |
| 2. Les deux journaux demenagent | ✅ `23fb288` |
| 3. L inventaire des chemins d envoi | ✅ `edd6a7f` |
| 4. Le blocage sur tous les chemins sauf la main de l operateur | ✅ `edd6a7f` + `2786599` |
| 5. La liste des opt-out | ✅ `b13456e`, avec la migration 0138 |
| 6. La regle elargie EN OBSERVATION | ✅ `623e6a5` |
| 7. L opt-out declenche un APPEL D OUTIL | ✅ (migration 0139) |
| 8. Le sous-menu IA | pas commence |
| 9. Le journal des erreurs, les DEUX | pas commence |

### Les ecarts avec ce plan, et pourquoi

1. **LES SOUS-MENUS SONT MONTES AVEC LEUR CONTENU, PAS AVANT.** Le plan montait les quatre d un coup en
   tache 1. Une entree de menu qui ouvre une page vide est pire que pas d entree : lot 1 n a monte que les
   deux journaux, dont l ecran existait deja, et « Consentement » est arrive avec le sien. Un e2e garde la
   correspondance dans les deux sens (chaque boite mene a un sous-menu, chaque sous-menu a sa boite).
2. **LA TACHE 4 A DEMANDE UNE MIGRATION QUE LE PLAN NE PREVOYAIT PAS** (0138, `contacts.opt_out_at`). Le
   plan exigeait qu un opt-out soit tracable « qui, depuis quel message, a quelle date » ; le depot savait
   QUI (`opt_in_source`) et pas QUAND. `updated_at` ne repond pas a la question, il bouge a la moindre
   modification de la fiche.
3. **DEUX CHEMINS ETAIENT A LA FRONTIERE** et ont ete poses a Julien plutot que tranches seul : l envoi d un
   MODELE depuis l Inbox (marketing refuse, service autorise) et la reponse d un agent tiers par MCP
   (bloquee). Les deux sont implementes avec leurs tests.
4. **LA TACHE 7 DESIGNE UNE REQUETE, PAS UN OUTIL D AGENT.** Le plan disait « outil / connecteur API deja
   declare dans Tools » ; un OUTIL est une surface exposee a un MODELE (nom expose, description pour le modele,
   parametres que le modele remplit), et il n y a aucun modele ici. C est exactement le cas du bloc « Appel
   HTTP » d un scenario, qui DESIGNE une requete de la bibliotheque : les trois passent donc par
   `creerAppelConnecteur`, avec les memes sept gardes.
5. **LA TACHE 7 A DEMANDE UNE MIGRATION QUE LE PLAN NE PREVOYAIT PAS** (0139, `tenant_settings.optout_request_id`),
   et un refus de suppression que le plan ne prevoyait pas non plus : le compteur `outils` d une requete ne voit
   que les outils d agent, donc une requete branchee sur le consentement y compte ZERO et se supprimait, la cle
   etrangere `on delete set null` debranchant la conformite EN SILENCE.
6. **L ANNONCE EST POSEE SUR LE DEPOT, PAS SUR LES APPELANTS.** Trois methodes ecrivent `opted_out`
   (`setOptInByWaId`, `applyEdits`, `applyEditsMany`) ; la couvrir chez les appelants l aurait fait oublier au
   prochain bouton, exactement comme l invariant de 0138. Un test DERIVE du fichier la liste des methodes qui
   posent `opt_out_at = now()` et exige qu elle soit celle des methodes qui annoncent.
7. 🔴 **UN DOCBLOCK FAUX A ETE RECOPIE DANS UNE ROUTE NEUVE.** `registerSettings` annoncait « GET ouvert
   (lecture), PUT admin-only » ; le module entier est monte avec `requireAdmin` depuis longtemps. La phrase a ete
   reprise telle quelle dans la route de la tache 7, et seul le TEST l a montree. Les deux docblocks sont corriges.
8. 🔴 **UN DEFAUT DE LA REGLE QUI AGIT, TROUVE EN ECRIVANT LE TEST DE LA TACHE 6.** « arret maladie »,
   « arret du traitement », « stop covid » et « stopper la commande » DESABONNENT aujourd hui, alors que le
   docblock citait « arret de bus » comme un cas evite. Sur un espace d assureur, c est un message ordinaire.
   La regle n est PAS modifiee (resserrer l ancrage ferait perdre « stop merci ») : c est un arbitrage pose a
   Julien, le docblock faux est corrige, et un test fige le comportement actuel.

🔴 **CE QUI RESTE DU AU-DELA DES TACHES : l essai reel.** Ecrire « stop » depuis un vrai telephone, constater
le passage en opt-out, PUIS tenter d atteindre ce contact par un scenario ET par une automation, et constater
que rien ne part. Puis l essai inverse : un operateur doit encore pouvoir lui repondre a la main.
