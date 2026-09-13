# Deux petits changements demandés le 2026-09-13

> **Pour un exécutant agentique :** deux sujets sans rapport, réunis parce qu'ils sont petits et qu'ils
> se livrent ensemble. Ils n'ont aucun fichier en commun.

**But :** déplacer le menu « Scénario » dans Contenu, et compter une RÉPONSE comme un engagement.

**Spec :** aucune. Les deux tiennent dans la demande de Julien, citée verbatim dans chaque tâche.

## Méthode de livraison

**Retenue : en direct, sans agent, avec revue sur le diff et vérification par mutation.**

**Pourquoi** : les quatre questions donnent deux réponses opposées, et c'est la seconde qui décide.
La tâche 1 est un déplacement d'entrée de menu : la production l'emprunte (c'est la navigation), mais
c'est réversible en une ligne et entièrement testable. La tâche 2, elle, touche **un chiffre affiché**,
et un chiffre faux fait prendre une décision : elle mérite un œil, pas seulement un test. Aucune des
deux ne porte assez de matière pour justifier la mise en route d'un implémenteur ; les deux ensemble
font moins d'une heure. ⚠️ Ne pas taxer le travail trivial de cérémonie : c'est ce qui fait contourner
la règle.

🔴 **L'essai réel qui les clôt** : ouvrir la console et cliquer sur « Scénario » à sa nouvelle place
pour vérifier qu'on y arrive et que l'onglet actif se surligne ; puis ouvrir Performance lab sur la
campagne « Testjulien2 », celle-là même que Julien cite, et **vérifier que le destinataire qui a
répondu sans cliquer est désormais compté comme engagé**.

---

### Tâche 1 : « Scénario » passe dans Contenu, après Email

**Demande de Julien, verbatim** : « deplacer le menu scenario dans Contenu > juste apres Email ».

**Décision prise le 2026-09-13** : entrée **à plat** dans `Contenu`, entre le groupe `Email` et le
groupe `Bibliothèque`. Julien a été mis devant la tension (Contenu est rangé PAR CANAL, un scénario
n'est pas un canal, il les traverse) et a tranché pour ce que sa demande disait.

**Fichiers**
- Modifier : `web/lib/nav.ts` (l'entrée `workflows` sort de la liste haute, entre dans `contenu.children`)
- Test : `web/lib/nav.test.ts` s'il existe, sinon un e2e de navigation

- [ ] **Étape 1 : le test d'abord**

```ts
it('« Scénario » vit dans Contenu, après le groupe Email', () => {
  const contenu = navConsole(t).find((e) => e.key === 'contenu')!;
  const cles = contenu.children!.map((c) => c.key);
  expect(cles).toContain('workflows');
  // 🔴 LA POSITION EST LA DEMANDE, pas seulement la présence : « juste après Email ».
  expect(cles.indexOf('workflows')).toBe(cles.indexOf('contenu-email') + 1);
  // ⚠️ ET IL N'EST PLUS EN HAUT : sans ce cas, on aurait DEUX entrées « Scénario ».
  expect(navConsole(t).map((e) => e.key)).not.toContain('workflows');
});
```

- [ ] **Étape 2 : déplacer l'entrée, relancer**
- [ ] **Étape 3 : MUTER** : laisser AUSSI l'entrée en haut, constater que le troisième `expect` rougit.
      C'est le cas qui attrape la faute la plus probable, un copier sans couper.
- [ ] **Étape 4 : vérifier que `/workflows` reste joignable et que l'onglet actif se surligne.**
      ⚠️ La déduction d'onglet se fait sur la STRUCTURE de la nav (cf. `adminBas` dans `nav.ts`) :
      déplacer une entrée peut changer l'onglet déduit pour son adresse.
- [ ] **Étape 5 : commit** (`git commit --only web/lib/nav.ts ...`)

---

### Tâche 2 : une RÉPONSE est un engagement de premier niveau

**Demande de Julien, verbatim** : « dans performance lab > homepage > ce que coute l'engagement…
exemple : sur l'envoi de Testjulien2, on a shooté un message marketing et le destinataire n'a pas
cliqué mais en revanche il a répondu ! c'est comme un clic dans ce cas là… c'est comme un clic de
premier niveau. Il s'est engagé !! il faut donc le compter. »

**Fichiers**
- Modifier : le calcul de la ligne « ce que coûte un engagement » (`src/stats/`, le lecteur de
  `web/lib/api/stats.ts:320`)
- Test : le test unitaire du calcul, plus un test d'intégration si le compte vient d'une requête

🔴 **CE QU'IL FAUT ÉTABLIR AVANT D'ÉCRIRE UNE LIGNE** : d'où vient aujourd'hui le compte des
engagements. Trois possibilités, et elles n'appellent pas le même changement : un compteur de clics sur
liens tracés (`tracked_links`), une colonne agrégée, ou un calcul à la volée. **Le lire, ne pas le
deviner.**

- [ ] **Étape 1 : établir la source du compte, et l'écrire dans le plan avant de coder**
- [ ] **Étape 2 : le test, avec le cas de Julien**

```ts
it('🔴 un destinataire qui a REPONDU sans cliquer compte comme engage', () => {
  // Le cas exact de « Testjulien2 » : un envoi marketing, zero clic, une reponse.
  expect(engagements({ clics: 0, reponses: 1 })).toBe(1);
});

// 🔴 ET IL NE COMPTE QU UNE FOIS. Quelqu un qui clique PUIS repond s est engage une fois, pas deux :
// le cout par engagement serait divise par deux sur les contacts les plus actifs, ce qui flatte
// exactement les campagnes qui marchent le mieux.
it('cliquer ET repondre ne compte pas double', () => {
  expect(engagements({ clics: 1, reponses: 1, memeContact: true })).toBe(1);
});
```

- [ ] **Étape 3 : implémenter, relancer**
- [ ] **Étape 4 : MUTER** : compter les réponses en plus des clics SANS dédoublonner par contact, et
      constater que le second test rougit. C'est le piège de cette tâche.
- [ ] **Étape 5 : vérifier sur la VRAIE campagne** (`Testjulien2` si elle existe encore, sinon la
      campagne réelle la plus récente) que le chiffre bouge dans le bon sens
- [ ] **Étape 6 : commit**

## Revue

Rayon de souffle à regarder, en plus des six axes :

- **qui d'autre lit le compte d'engagements ?** Le tableau de la page d'accueil, mais peut-être aussi
  un export ou le bilan d'un contact (`web/lib/api/contacts.ts:130` parle d'un « entonnoir
  d'engagement »). Deux définitions différentes du même mot sur deux écrans seraient pires que l'ancienne.
- **le coût par engagement BAISSE mécaniquement** quand on compte plus d'engagements. Si un texte
  quelque part cite un ordre de grandeur, il devient faux.
