# Créer un scénario sans quitter sa campagne : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> ou `superpowers:executing-plans`, tâche par tâche.

**But :** proposer « Créer un scénario » en tête du sélecteur d'un étage, ouvrir l'éditeur habituel
dans une fenêtre, et ne laisser publier qu'un scénario qui peut réellement ouvrir cet étage.

**Spec :** [../specs/2026-09-13-scenario-a-la-volee-design.md](../specs/2026-09-13-scenario-a-la-volee-design.md)

## Méthode de livraison

**Retenue : implémenteur par lot, puis revue humaine sur le DIFF.** Deux lots : le canal d'ouverture
côté serveur et le filtrage de la liste (tâches 1 à 3), puis la fenêtre et la création (tâches 4 à 6).

**Pourquoi** : les quatre questions répondent oui deux fois en haut de liste. **La production emprunte
ce chemin** (un scénario créé ici ouvre une campagne, donc part à de vraies personnes) et **ce n'est pas
réversible** : un scénario qui ouvre mal fait refuser la campagne ENTIÈRE par Meta, pas un destinataire.
Et le code touché porte des invariants qu'un relecteur générique ne connaît pas : `campaignEligible` est
un contrat entre le serveur et trois écrans, la liste des scénarios a DÉJÀ été allégée de ses graphes
pour une raison de charge, et un scénario non publié est un brouillon qui a son propre cycle de vie.

**Pourquoi pas feature-loop** : ses critères sont testables, mais son rayon de souffle ne l'est pas.
Ajouter un champ à la liste des scénarios touche tout ce qui la lit.

🔴 **L'essai réel qui clôt la feature** : créer un scénario depuis une campagne WhatsApp, le publier,
**vérifier qu'il apparaît dans l'onglet Scénario**, lancer la campagne sur un vrai numéro et constater
la réception du modèle d'ouverture. Puis l'essai qui protège : tenter de publier, depuis la fenêtre, un
scénario qui ne commence pas par un modèle, et constater le refus AVEC sa raison.

## Contraintes globales

Celles des plans du 2026-09-12 s'appliquent à l'identique (`git commit --only`, `tenant_id = $1`,
`safeParse`, 4xx jamais 5xx, pas de tiret cadratin, mutation dans les deux sens, migrations non
auto-appliquées et numéro lu EN BASE, `bg-violet/10`, garde de largeur en 1280 x 800). Un ajout :

- 🔴 **AUCUNE MIGRATION N'EST PRÉVUE.** Si l'exécution en révèle le besoin, elle s'ARRÊTE et le dit :
  le canal d'ouverture d'un scénario se CALCULE depuis son graphe, il ne se stocke pas. Une colonne
  serait une seconde vérité à tenir d'accord avec le graphe, et c'est le graphe qui fait foi.

---

### Tâche 1 : le canal d'ouverture, calculé côté serveur

**Fichiers**
- Modifier : le calcul qui pose déjà `campaignEligible` sur la liste des scénarios (`src/http/workflows.ts`)
- Test : `tests/workflow-ouverture.test.ts`

**Produit** : chaque scénario de la liste porte, à côté de `campaignEligible`, son **canal d'ouverture**.

```ts
/** Par quoi ce scenario OUVRE, quand il peut ouvrir une campagne. `null` = il ne le peut pas. */
export type CanalOuverture = 'whatsapp' | 'rcs' | null;
```

🔴 **IL SE CALCULE DEPUIS LE GRAPHE, IL NE SE STOCKE PAS.** `scanOpening` existe et rend déjà
`firstTemplate` et `rcsOpen` : la fonction à écrire les traduit, elle ne les recalcule pas.

- [x] **Étape 1 : les tests**

```ts
it('un scenario qui ouvre par un modele nomme rend whatsapp', () => { /* ... */ });
it('un scenario qui ouvre par un bloc RCS configure rend rcs', () => { /* ... */ });
// 🔴 LE CAS QUI COMPTE : un modele SANS NOM n ouvre rien, et c est deja ce que isCampaignEligible dit.
it('un modele sans nom rend null, pas whatsapp', () => { /* ... */ });
it('un scenario qui commence par une attente rend null', () => { /* ... */ });
```

- [x] **Étape 2 : implémenter, relancer**
- [x] **Étape 3 : MUTER** : faire rendre `whatsapp` sur un modèle sans nom, constater l'échec
- [x] **Étape 4 : vérifier que `campaignEligible` ne change pas de valeur** pour tous les cas existants.
      ⚠️ C'est un contrat lu par trois écrans : le modifier au passage casserait des campagnes valides.
- [x] **Étape 5 : commit**

---

### Tâche 2 : la liste d'un étage ne propose que ce qui peut l'ouvrir

**Fichiers**
- Modifier : `web/components/campagne/EtapeContenu.tsx` (`SelecteurScenario`), `web/lib/api/*`
- Test : `web/lib/campagne-scenario.test.ts` (fonction pure de filtrage)

- [x] **Étape 1 : la règle, PURE, dans `web/lib/`** (seul endroit testable hors navigateur)

```ts
export function scenariosPourEtage(
  scenarios: Array<{ id: string; name: string; canalOuverture?: 'whatsapp' | 'rcs' | null }>,
  canal: CanalEtage,
): typeof scenarios {
  // ⚠️ `undefined` = serveur plus ancien qui ne rend pas encore le champ. On GARDE le scenario
  // plutot que de le masquer : masquer ferait disparaitre toute la liste au premier deploiement
  // partiel, et le recapitulatif refuse de toute facon ce qui ne peut pas ouvrir.
}
```

- [x] **Étape 2 : les tests, dont le cas de tolérance ci-dessus**
- [x] **Étape 3 : brancher le filtre sur le sélecteur, par canal d'ÉTAGE**
- [x] **Étape 4 : MUTER** : filtrer sur le canal du rang 1 pour tous les étages, constater qu'un étage
      de repli RCS se voit proposer des scénarios WhatsApp
- [x] **Étape 5 : commit**

---

### Tâche 3 : le récapitulatif refuse aussi, par canal

**Fichiers**
- Modifier : `web/lib/campagne-creation.ts` (`problemeAvantLancement`)
- Test : `web/lib/campagne-creation.test.ts`

⚠️ **LA MOITIÉ WHATSAPP EXISTE DÉJÀ** depuis le 2026-09-13 (« ce scénario ne commence pas par un modèle
WhatsApp »). Cette tâche ajoute le **miroir RCS** et fait reposer les deux sur `canalOuverture` plutôt
que sur la présence de `modeleDuScenario`.

- [x] **Étape 1 : les tests des deux sens, et du cas « on ne sait pas »**
- [x] **Étape 2 : implémenter, relancer, MUTER**
- [x] **Étape 3 : commit**

---

### Tâche 4 : « Créer un scénario », le nom, la création

**Fichiers**
- Modifier : `web/components/campagne/EtapeContenu.tsx`
- Créer : `web/components/campagne/CreationScenarioEnLigne.tsx`

⚠️ **LE MODÈLE À SUIVRE EXISTE** : `CreationModeleEnLigne` fait exactement cela pour un modèle WhatsApp
(demander, créer, suivre, choisir dès que c'est prêt). **Le lire avant d'écrire**, et reprendre sa forme.

- [x] **Étape 1 : l'entrée « Créer un scénario » en TÊTE du sélecteur**, avant les existants
- [x] **Étape 2 : la demande du NOM** (le parcours normal le demande avant l'éditeur, celui-ci n'a pas
      d'endroit où le poser)
- [x] **Étape 3 : la création, qui rend un `workflowId`**
- [x] **Étape 4 : les tests e2e** (l'entrée est en tête ; sans nom on ne crée rien)
- [x] **Étape 5 : commit**

---

### Tâche 5 : la fenêtre, et l'éditeur dedans

**Fichiers**
- Modifier : `web/components/campagne/CreationScenarioEnLigne.tsx`
- Test : `web/e2e/campagne-scenario-a-la-volee.spec.ts`

🔴 **L'ÉDITEUR EST CELUI DE L'ONGLET SCÉNARIO, MONTÉ AILLEURS.** `WorkflowBuilder` prend `tenantId`,
`workflowId`, `initialGraph` et ses données de contexte : il n'a pas besoin de la page `/workflows`.
**Aucune version allégée, aucun second éditeur.**

- [x] **Étape 1 : la fenêtre, ~75 % de l'écran, et la garde de largeur en 1280 x 800**

```ts
test('l editeur respire en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await ouvrirLaFenetre(page);
  await pasDeDebordement(page);
  await pasDeChevauchement(page, ['fenetre-scenario', 'canevas-blocs', 'panneau-config']);
});
```

- [x] **Étape 2 : vérifier que le brouillon de la CAMPAGNE survit à l'ouverture** (on ne quitte pas la
      page, donc en principe oui : le vérifier plutôt que le supposer)
- [x] **Étape 3 : commit**

---

### Tâche 6 : publier, et ce que la publication refuse

**Fichiers**
- Modifier : `web/components/campagne/CreationScenarioEnLigne.tsx`, la route de publication
- Test : `web/e2e/campagne-scenario-a-la-volee.spec.ts`

- [x] **Étape 1 : les tests, et le premier est celui qui protège**

```ts
// 🔴 LA GARDE DEMANDEE PAR JULIEN. Sur un etage WhatsApp, un scenario qui n ouvre pas par un modele
// ne doit pas pouvoir etre publie DEPUIS LA CAMPAGNE.
test('publier refuse un scenario qui n ouvre pas par un modele, sur un etage WhatsApp', async ({ page }) => {
  await expect(page.getByTestId('refus-ouverture')).toContainText(/commence pas par un modèle/i);
});

test('et sur un etage RCS, c est l inverse qui est exige', async ({ page }) => { /* ... */ });

test('publier un scenario valide ferme la fenetre ET le selectionne dans la campagne', async ({ page }) => {
  await expect(page.getByTestId('fenetre-scenario')).toHaveCount(0);
  await expect(page.getByTestId('scenario-1')).toHaveValue(/.+/);
});

// 🔴 IL DOIT SE RETROUVER DANS L ONGLET SCENARIO : Julien l a demande explicitement.
test('le scenario cree apparait dans la liste de l onglet Scenario', async ({ page }) => { /* ... */ });
```

- [x] **Étape 2 : implémenter, relancer, MUTER** (retirer la garde, constater qu'un scénario invalide
      se publie et que le refus n'arrive qu'au récapitulatif)
- [x] **Étape 3 : commit**

## Revue

Revue `/revue` systématique, plus le rayon de souffle :

- **`campaignEligible` est lu par TROIS écrans** (l'assistant, la page `/workflows`, l'ancien chemin).
  Ajouter un champ à côté ne doit rien changer pour eux ; le vérifier plutôt que l'espérer.
- **La liste des scénarios a DÉJÀ été allégée de ses graphes** pour une raison de charge : ne pas les y
  remettre pour calculer le canal côté navigateur. C'est exactement le piège que la tâche 1 ferme.
- **Un scénario créé puis abandonné** reste en brouillon. Vérifier qu'il n'apparaît pas dans les listes
  qui ne montrent que les scénarios publiés, et qu'il n'est pas proposé en campagne.
- **Les textes** : la page `/workflows` dit peut-être « créez un scénario ici » ; il y a maintenant un
  second chemin.

---

## Ce qui a ete livre, et les DEUX ecarts avec ce plan (2026-09-13)

Les six taches sont faites, sans migration, en deux lots (`90f7aa9` puis `d1bb1a2`). Deux ecarts, dont un
qui a ouvert un chantier que ce plan n'avait pas vu.

1. 🔴 **LA TACHE 3 N'A PAS EU SON MIROIR RCS, ELLE A EU UNE CORRECTION DE MOTEUR.** Le plan demandait
   « et sur un etage RCS, c'est l'inverse qui est exige ». En l'ecrivant, la mesure a montre que sur un
   etage RCS **le scenario choisi n'etait JAMAIS demarre** : `engine.ts` teste `servi.sender` avant
   `contenu.workflowId`, et un etage RCS a toujours un sender. Mesure avec le vrai moteur : message parti,
   `sent: 1`, zero demarrage. Ajouter une garde aurait renforce l'illusion que la formule fait quelque
   chose. Julien a tranche (« bah pourquoi je retirerais le message / scenario pour un RCS ??? ») : le
   moteur demarre desormais le scenario APRES l'envoi. Corrige dans `b555012`, avec son test.
   ⚠️ Le meme `!contenu.workflowId` privait le fil de sa trace : le message RCS n'etait pas journalise
   dans la conversation des qu'un scenario etait attache. Meme cause, meme correctif.
2. **Le canal d'ouverture est aussi cote NAVIGATEUR** (`canalDOuvertureDuGraphe`), parce que la garde de
   publication s'execute dans l'editeur. `isCampaignEligible` en est derive des deux cotes, et un test
   compare les deux implementations cas par cas.

⚠️ **ET L'ENTREE N'EST PAS DANS LE SELECTEUR, elle est dessous.** Le plan disait « en TETE du selecteur ».
Une option « Creer un scenario » dans une liste deroulante est un choix qui n'en est pas un : elle se
selectionne comme une valeur, et un brouillon recharge porterait un identifiant qui ne designe aucun
scenario.

🔴 **CE QUI RESTE DU : l'essai reel.** Creer un scenario depuis une campagne WhatsApp, le publier, verifier
qu'il apparait dans l'onglet Scenario, lancer la campagne sur un vrai numero et constater la reception du
modele d'ouverture. Puis l'essai qui protege : tenter de publier, depuis la fenetre, un scenario qui ne
commence pas par un modele, et constater le refus AVEC sa raison.
