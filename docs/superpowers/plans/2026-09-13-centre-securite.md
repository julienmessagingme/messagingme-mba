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

- [ ] **Étape 1 : les tests** (l'entrée existe au BAS, les sous-menus se déplient, la page d'accueil
      porte une boîte par sous-menu, rien ne déborde en 1280 x 800)
- [ ] **Étape 2 : implémenter, relancer**
- [ ] **Étape 3 : MUTER** : retirer un sous-menu de la nav sans retirer sa boîte, constater que le test
      de correspondance rougit. ⚠️ C'est le défaut qui arrive vraiment : une boîte qui mène nulle part.
- [ ] **Étape 4 : commit**

---

### Tâche 2 : les audit trails ET le journal de livraison déménagent

**Fichiers**
- Modifier : `web/lib/nav.ts`, `web/app/parametres/`, `web/app/securite/`

⚠️ **LES DEUX ENSEMBLE, parce qu'ils sont déjà au même endroit** (mesuré le 2026-09-13 : le journal des
erreurs de livraison est rangé « au même endroit que le journal des actions »). Les séparer coûterait
deux déménagements et laisserait Paramètres à moitié vidé.

⚠️ **LE JOURNAL DE LIVRAISON PORTE LES NUMÉROS DE TÉLÉPHONE, délibérément**, et il est admin-only. Le
déplacer ne doit pas l'ouvrir plus largement.

- [ ] **Étape 1 : le test qui garde l'ANCIENNE adresse** (elle redirige, ou elle marche encore)
- [ ] **Étape 2 : déplacer, relancer**
- [ ] **Étape 3 : vérifier qu'aucun lien du produit ne pointe encore sur l'ancienne place** (`grep`)
- [ ] **Étape 4 : commit**

---

### Tâche 3 : l'inventaire des chemins d'envoi

**Fichiers**
- Créer : `tests/optout-chemins.test.ts`

🔴 **CETTE TÂCHE NE PRODUIT PAS DE FONCTIONNALITÉ, ELLE PRODUIT UNE LISTE, ET C'EST LA PLUS IMPORTANTE
DU LOT.** Mesure du 2026-09-13 : `optInAllows` n'est appelée QUE dans `src/campaign/build.ts` et
`src/api/sends-build.ts`. Il faut établir la liste EXHAUSTIVE des chemins par lesquels un message
sortant peut partir, et dire pour chacun s'il doit être bloqué.

Décision de Julien du 2026-09-13 : **tout sauf la réponse manuelle d'un opérateur.**

- [ ] **Étape 1 : établir la liste** en partant des appels réels d'envoi (`sendText`, `sendTemplate`,
      le sender RCS, le bloc e-mail), pas en partant de ce qu'on croit savoir
- [ ] **Étape 2 : l'écrire dans un test qui la TIENT**

```ts
// 🔴 UNE LISTE ECRITE A LA MAIN DERIVE DES QU ON AJOUTE UN CHEMIN D ENVOI. Ce test derive la liste
// du CODE (les appelants reels du client Meta) et rougit quand un chemin neuf n a pas ete classe.
it('tout chemin d envoi est CLASSE : bloque par un opt-out, ou explicitement exempte', () => { /* ... */ });
```

- [ ] **Étape 3 : MUTER** : ajouter un faux chemin d'envoi non classé, constater le rouge
- [ ] **Étape 4 : commit**

---

### Tâche 4 : le blocage, sur tous les chemins sauf la main de l'opérateur

**Fichiers**
- Modifier : les chemins établis en tâche 3 (scénario, automation, agent IA)
- Test : `tests/optout-blocage.test.ts` + intégration

- [ ] **Étape 1 : les tests, un par chemin, ET le cas d'exemption**

```ts
it('un scenario n envoie RIEN a un contact opted_out', async () => { /* ... */ });
it('une automation non plus', async () => { /* ... */ });
it('l agent IA non plus', async () => { /* ... */ });

// 🔴 LE CAS QUI PROTEGE L USAGE, et il est aussi important que les trois precedents : sans lui, un
// operateur ne pourrait meme plus accuser reception d un opt-out, ni repondre a une reclamation
// posee juste apres. La machine se tait ; la personne peut encore repondre a la personne.
it('mais un operateur PEUT encore repondre a la main dans l Inbox', async () => { /* ... */ });
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (retirer la garde d'un seul chemin, constater que
      seul son test rougit : c'est ce qui prouve que les trois sont indépendants)
- [ ] **Étape 3 : commit**

---

### Tâche 5 : la liste des opt-out, et ce qu'on en fait

**Fichiers**
- Créer : `web/app/securite/consentement/page.tsx`, la route de liste et d'export

- [ ] La liste, **exportable**
- [ ] Un clic donne le **résumé de la conversation** qui a mené au refus
- [ ] Un clic de plus ouvre **la conversation dans l'Inbox**
- [ ] Le **téléchargement de la conversation entière** qui a abouti à l'opt-out
- [ ] ⚠️ **`tenant_id = $1` sur CHAQUE requête**, et le contrôle d'accès : cet écran donne des
      conversations complètes. Réservé aux admins et managers.
- [ ] Tests, mutation, commit

---

### Tâche 6 : la règle élargie, EN OBSERVATION

**Fichiers**
- Modifier : `src/crm/consentement.ts`
- Test : `tests/consentement-observation.test.ts`

🔴 **ELLE NE DÉSABONNE PERSONNE.** Quand elle reconnaît un refus que la règle actuelle n'aurait pas vu,
elle journalise le message et le fait remonter dans l'écran Consentement, sous « refus possibles à
confirmer ». L'opérateur confirme ou écarte, et chaque geste devient une donnée de calibrage.

- [ ] **Étape 1 : les tests, dont le plus important**

```ts
// 🔴 L ELARGISSEMENT N AGIT PAS. Sans ce cas, un jour de distraction transformerait l observation en
// desabonnement automatique, sur une regle que PERSONNE n a calibree faute de donnees.
it('un refus reconnu par la seule regle ELARGIE ne pose PAS opted_out', () => { /* ... */ });
it('mais il est journalise et remonte a confirmer', () => { /* ... */ });
// L AUTRE SENS : la regle ACTUELLE, elle, continue de desabonner toute seule.
it('« stop » en debut de message desabonne toujours, sans confirmation', () => { /* ... */ });
```

- [ ] **Étape 2 : implémenter, relancer, MUTER, commit**

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

- [ ] Le réglage (quel outil, ou aucun), avec la liste venue de Tools
- [ ] L'appel APRÈS l'écriture, jamais avant, et jamais bloquant
- [ ] Un test qui MUTE l'ordre : l'appel avant l'écriture, et un connecteur en panne -> l'opt-out doit
      quand même être posé
- [ ] Tests, mutation, commit

---

### Tâche 8 : le sous-menu IA

Remonter la bascule « l'IA se déclare comme telle » de la fiche d'agent au niveau de l'ESPACE.

- [ ] 🔴 **NE PAS CHANGER LE COMPORTEMENT DES AGENTS EXISTANTS** : c'est une migration de réglage. Un
      agent déjà configuré doit continuer à faire exactement ce qu'il faisait. Le défaut `session` et
      le choix `jamais` ont été tranchés le 2026-09-09 en connaissance de cause.
- [ ] ⚠️ **LE META BUSINESS AGENT N'EST PAS CONCERNÉ** : Meta écrit déjà « IA » sous ses messages, notre
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

- [ ] **Étape 1 : inventorier ce qui est DÉJÀ journalisé** avant d'en journaliser plus. Le dépôt porte
      des DLQ, `/ops` et des alertes Telegram : la question n'est pas « que journaliser » mais « qu'est-ce
      qui est déjà écrit quelque part et que personne ne montre au client »
- [ ] **Étape 2 : les deux moitiés dans le même écran**, distinguées par leur NATURE et non mélangées
- [ ] ⚠️ **Ce qui porte des numéros reste admin-only**
- [ ] Tests, mutation, commit

## Revue

Revue `/revue` systématique, plus le rayon de souffle :

- **Qui écrit `opted_out` aujourd'hui ?** Quatre chemins connus (la fiche contact, l'action en masse, le
  bloc Action d'un scénario, le mot-clé entrant). Chacun doit rester traçable.
- **Qui LIT `opt_in_status` ?** Ajouter un blocage change ce que ces lecteurs voient partir.
- **Les compteurs de campagne** : un destinataire écarté pour opt-out doit apparaître comme écarté AVEC
  son motif, pas disparaître du compte. Sinon le client voit une audience qui fond sans explication.
