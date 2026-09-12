# Le récap du bot d'aide : plan d'exécution

> **Pour un exécutant agentique :** SOUS-SKILL REQUISE : `superpowers:subagent-driven-development`
> ou `superpowers:executing-plans`, tâche par tâche.

**But :** un bouton à l'ouverture du bot d'aide qui rend le récap de la VEILLE : conversations,
messages, thèmes dominants. Réservé aux rôles `admin` et `manager`.

**Architecture :** le SQL calcule tout ce qui est chiffré, y compris les écarts avec la semaine
précédente. Le modèle n'est appelé que les jours où il y a quelque chose à signaler, et il ne peut
citer aucun nombre qui ne soit dans son entrée. Le résultat est mis en cache par espace et par jour.

**Spec :** [../specs/2026-09-12-recap-bot-aide-cadrage.md](../specs/2026-09-12-recap-bot-aide-cadrage.md)

## Méthode de livraison

**Retenue : mixte, et c'est le premier plan où les deux se justifient sur le même lot.** Les tâches 1
et 2 (le SQL du récap, la garde de rôle et le cache) en implémenteur + revue ; les tâches 3 et 4 (le
rendu et le bouton) en **feature-loop**.

**Pourquoi cette coupure** : la tâche 1 porte un piège que seule la connaissance du dépôt voit,
`conversation_analysis.created_at` étant réécrit à chaque ré-analyse, et la tâche 2 ouvre la
**première lecture des données d'un client par le bot d'aide**, donc l'isolation `tenant_id = $1` et
la garde de rôle y sont le sujet, pas un détail. Les tâches 3 et 4, à l'inverse, ont des critères
mécaniquement testables et un rayon de souffle nul : un gabarit, un seuil, un bouton.

⚠️ **Ce plan est donc le cas d'école du fait que la méthode se choisit par LOT et pas par chantier.**
Appliquer la méthode lourde aux quatre tâches aurait taxé deux tâches qui ne le méritent pas, et
c'est comme ça qu'une règle finit contournée.

🔴 **L'essai RÉEL qui clôt la feature** : ouvrir le bot sur l'espace de production avec un compte
`admin`, cliquer le bouton, et **recompter à la main** les conversations de la veille contre ce qu'il
annonce. Puis rouvrir avec un compte `agent` et vérifier que le bouton n'est pas là. Un récap qui
affiche un chiffre plausible et faux est pire que pas de récap, parce que les gens agissent dessus.

## Contraintes globales

Celles du plan des campagnes s'appliquent à l'identique. Trois ajouts propres à ce lot :

- 🔴 **LE MODÈLE NE COMPTE JAMAIS.** Il formule des nombres que le SQL lui a donnés. Un chiffre faux
  dans un récap est pire que pas de récap, parce que les gens agissent dessus.
- 🔴 **Les jetons du bot d'aide sont sur NOTRE clé**, pas sur le crédit du client (décision du
  2026-09-11, écrite dans `src/http/aide.ts`). Toute dépense évitable l'est.
- 🔴 **`admin` et `manager` seulement.** La garde est côté SERVEUR (403), et le bouton est MASQUÉ
  côté client pour les autres, pas grisé.

---

### Tâche 1 : le SQL du récap

**Fichiers**
- Créer : `src/aide/recap.pg.ts`
- Test : `tests/integration/aide-recap.integration.test.ts`

**Produit**
```ts
export interface Recap {
  jour: string;                 // 'YYYY-MM-DD' dans le fuseau de l'espace
  conversations: number;
  conversationsAnalysees: number;   // le reste n'a pas encore de thème
  messagesEntrants: number;
  messagesSortants: number;
  themes: Array<{ topic: string; n: number }>;   // les 5 premiers
  semainePrecedente: { conversations: number; messagesEntrants: number };
}
export function creerRecap(pool: Pool): (tenantId: string, jour: string) => Promise<Recap>;
```

🔴 **DEUX SOURCES, ET C'EST LE PIÈGE DU LOT.** `conversation_analysis.created_at` est réécrit en
`now()` à chaque ré-analyse (documenté dans `src/stats/conversation-stats.pg.ts`) : c'est la date de
DERNIÈRE ANALYSE, pas celle de la conversation. Le volume se lit donc sur `conversations` et
`conversation_messages` à leurs vraies dates, et les thèmes se lisent sur `conversation_analysis`
**rattachés aux conversations d'hier**, quelle que soit la date de leur analyse.

⚠️ Réutiliser `STATS_TZ` et `BOUNDS_CTE` de `src/stats/range.ts` pour les bornes de journée. Les
réécrire rouvrirait le piège déjà relevé dans `todo.md` : les mesures filtrent en UTC et l'écran
raisonne en heure locale.

- [ ] **Étape 1 : le test d'intégration, sur le piège en premier**

```ts
// 🔴 LE TEST QUI COMPTE. Sans lui, le recap est plausible et faux.
it('une conversation d AVANT-HIER re-analysee HIER n est PAS dans le recap d hier', async () => {
  await insererConversation({ creeeLe: ilYA(2), analyseeLe: ilYA(1), topic: 'remboursement' });
  const r = await recap(tenantId, hier);
  expect(r.conversations).toBe(0);
  expect(r.themes).toEqual([]);
});

// 🔴 ET SON MIROIR : une conversation d hier analysee CE MATIN doit y etre, avec son theme.
it('une conversation d HIER analysee ce matin est dans le recap d hier, avec son theme', async () => {
  await insererConversation({ creeeLe: ilYA(1), analyseeLe: maintenant, topic: 'retard de livraison' });
  const r = await recap(tenantId, hier);
  expect(r.conversations).toBe(1);
  expect(r.themes).toEqual([{ topic: 'retard de livraison', n: 1 }]);
});

it('une conversation d hier SANS analyse est comptee mais pas thematisee', async () => {
  await insererConversation({ creeeLe: ilYA(1), analyseeLe: null });
  const r = await recap(tenantId, hier);
  expect(r.conversations).toBe(1);
  expect(r.conversationsAnalysees).toBe(0);
});

// ⚠️ Isolation : un autre espace n existe pas.
it('ne voit rien d un autre espace', async () => {
  await insererConversation({ tenantId: autreTenant, creeeLe: ilYA(1) });
  expect((await recap(tenantId, hier)).conversations).toBe(0);
});
```

- [ ] **Étape 2 : implémenter**
- [ ] **Étape 3 : MUTER** : indexer les thèmes sur `conversation_analysis.created_at` au lieu de la
      date de la conversation, constater que les deux premiers tests échouent en sens inverse l'un
      de l'autre. C'est cette paire qui tient le piège.
- [ ] **Étape 4 : commit**

---

### Tâche 2 : la garde de rôle et le cache

**Fichiers**
- Créer : `src/aide/recap-cache.ts`
- Modifier : `src/http/aide.ts`
- Test : `tests/aide-recap-route.test.ts`

**Produit** : `POST /tenants/:tenantId/aide/recap`, 403 pour un rôle non autorisé.

- [ ] **Étape 1 : les tests**

```ts
// 🔴 LA GARDE EST COTE SERVEUR. Masquer le bouton n est pas un controle d acces.
it('un role agent recoit 403, meme en appelant la route directement', async () => {
  const res = await app.inject({ method: 'POST', url: `/tenants/${t}/aide/recap`, headers: jeton('agent') });
  expect(res.statusCode).toBe(403);
});

it('admin et manager passent', async () => {
  for (const role of ['admin', 'manager']) {
    expect((await appeler(role)).statusCode).toBe(200);
  }
});

// 🔴 LE CACHE DIVISE NOTRE FACTURE PAR LE NOMBRE D UTILISATEURS DE L ESPACE.
it('le deuxieme appel du meme jour ne recalcule rien', async () => {
  await appeler('admin');
  const avant = appelsSql;
  await appeler('manager');
  expect(appelsSql).toBe(avant);
});

// ⚠️ Et il expire quand le jour tourne, sinon on sert le recap d avant-hier indefiniment.
it('le cache expire au changement de jour', async () => {
  await appeler('admin');
  avancerAuLendemain();
  const avant = appelsSql;
  await appeler('admin');
  expect(appelsSql).toBeGreaterThan(avant);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (retirer la garde de rôle, constater le 200 pour
      `agent` ; retirer l'expiration, constater que le dernier test échoue)
- [ ] **Étape 3 : commit**

---

### Tâche 3 : le rendu, gabarit puis modèle

**Fichiers**
- Créer : `src/aide/recap-rendu.ts`
- Test : `tests/aide-recap-rendu.test.ts`

**Produit**
```ts
export function meriteUnModele(r: Recap): boolean;
export function gabarit(r: Recap, langue: 'fr' | 'en'): string;
```

🔴 **Le modèle n'est appelé QUE quand le SQL a trouvé un écart à signaler** (un volume qui s'écarte
nettement de la semaine précédente, ou un thème absent la semaine d'avant). Sinon, gabarit. On ne
paie que les jours où ça achète quelque chose, et cette dépense est la nôtre.

- [ ] **Étape 1 : les tests**

```ts
it('sans ecart notable, aucun appel de modele', () => {
  expect(meriteUnModele({ conversations: 42, semainePrecedente: { conversations: 40 }, ... })).toBe(false);
});

it('un volume qui double merite une phrase', () => {
  expect(meriteUnModele({ conversations: 84, semainePrecedente: { conversations: 40 }, ... })).toBe(true);
});

// 🔴 LE GABARIT DIT CE QU IL NE SAIT PAS. Sans cette phrase, il sous-declare en silence.
it('le gabarit ecrit combien de conversations n ont pas encore de theme', () => {
  const t = gabarit({ conversations: 42, conversationsAnalysees: 25, ... }, 'fr');
  expect(t).toMatch(/17 .* pas encore analysée/);
});

// ⚠️ Un espace sans activite hier ne doit pas rendre une page vide ni des zeros muets.
it('un jour sans activite le dit en une phrase', () => {
  expect(gabarit({ conversations: 0, ... }, 'fr')).toMatch(/aucune conversation/i);
});
```

- [ ] **Étape 2 : implémenter, relancer, MUTER** (retirer la phrase des non analysées, constater
      l'échec du troisième test)
- [ ] **Étape 3 : brancher l'appel de modèle**

🔴 **Le modèle reçoit l'objet `Recap` et rien d'autre.** Tout nombre qu'il a le droit de citer est
dans son entrée, donc il ne peut pas en inventer. Sa consigne lui interdit explicitement d'en
calculer un nouveau.

⚠️ **Ce chemin n'emprunte PAS le rappel de connaissance.** Le moteur actuel répond « je ne sais pas »
sans appeler le modèle quand aucune fiche n'est pertinente, et un récap ne vient d'aucune fiche :
branché comme une question ordinaire, il tomberait droit dedans.

- [ ] **Étape 4 : commit**

---

### Tâche 4 : le bouton

**Fichiers**
- Modifier : `web/components/BoutonAide.tsx`, `web/lib/api-aide.ts`
- Test : `web/e2e/aide-recap.spec.ts`

L'accueil du bot porte déjà trois suggestions cliquables. Le récap devient la première, en tête.

- [ ] **Étape 1 : les tests**

```ts
// ⚠️ LE LIBELLE DIT CE QU IL FAIT : « du jour » pour la veille laisserait quelqu un se demander
// a 16 h pourquoi ses conversations du matin n y sont pas.
test('le bouton parle d hier', async ({ page }) => {
  await expect(page.getByRole('button', { name: "Le récap d'hier" })).toBeVisible();
});

// 🔴 MASQUE pour un operateur, pas grise : un bouton grise lui dirait que ses collegues ont une
// fonctionnalite qu il n aura jamais, ce qui n est que du bruit.
test('un operateur ne voit pas le bouton du tout', async ({ page }) => {
  await connecterEnTantQue(page, 'agent');
  await expect(page.getByRole('button', { name: /récap/i })).toHaveCount(0);
});

test('rien ne deborde en 13 pouces', async ({ page }) => {
  await page.setViewportSize(TREIZE_POUCES);
  await page.getByRole('button', { name: "Le récap d'hier" }).click();
  await pasDeDebordement(page);
});
```

- [ ] **Étape 2 : implémenter, relancer, commit**

---

## Revue

Revue `/revue` systématique. Rayon de souffle :

- 🔴 **C'est la PREMIÈRE capacité de lecture de données du bot d'aide.** Jusqu'ici il lisait
  `aide_fiches`, qui n'a pas de `tenant_id` (même corpus pour tout le monde). Vérifier que le
  nouveau chemin porte bien `tenant_id = $1` sur CHAQUE requête, et que `scopeTenant` le garde.
- Le moteur `src/aide/repondre.ts` garde sa garde « aucune fiche pertinente = je ne sais pas sans
  appeler le modèle ». Vérifier qu'elle est toujours vraie pour les questions ordinaires, et que le
  récap ne passe pas par là.
- Le plafond de débit de la route d'aide (20 par minute et par ESPACE) couvre-t-il le récap, ou
  faut-il un plafond à part ? Un récap coûte plus qu'une question.
