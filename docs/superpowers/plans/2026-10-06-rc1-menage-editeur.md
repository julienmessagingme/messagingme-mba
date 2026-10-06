# RC1 : le ménage de l'éditeur de scénarios, et le widget sous Tools

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06 par une série de questions.
> Plan COURT : tâches, interfaces, tests attendus, ordre de déploiement, sans code.

**But :** retirer des panneaux de blocs les textes d'aide que Julien a listés, ajouter un compteur de caractères aux
réponses, et ranger « Widget WhatsApp » sous Tools.

**Décisions de Julien :** seulement les textes listés (pas de ménage étendu aux autres blocs ni aux autres modes de
l'Attente) ; « 2 Mo maximum » reste ; les compteurs commencent à `0/20` et se remplissent à la frappe.

## Contraintes globales

- Console seule (`web/`) : aucune route, aucune migration. Aucun tiret cadratin ni demi-cadratin.
- Les deux langues de chaque `t(...)` partent ensemble.
- ⚠️ Les e2e trouvent les éléments par texte et par rôle : `grep` de chaque texte retiré dans `web/e2e` avant.

## T1. Les textes retirés (`web/components/WorkflowConfigPanel.tsx`)

Numéros de ligne relevés sur `e5c338d7`, à relire au moment d'éditer.

| Bloc | Ce qui part | Ligne |
|---|---|---|
| Message rapide | « « Variable » insère un champ du contact… » (celui du bloc, pas celui du RCS l. 373) | 552 |
| Message rapide | « JPEG, PNG ou GIF, 2 Mo maximum. Le message part alors… image légendée. » devient « 2 Mo maximum. » | 568 |
| Message rapide | « Max 3, 20 caractères. Chaque réponse devient une sortie… » (remplacé par les compteurs, T2) | 637 |
| Question | « Ce bouton n'apparaît que si vous proposez des réponses ci-dessous. » | 450 |
| Question | « Maximum 10 réponses, 24 caractères chacune… réponse écrite. » (remplacé par les compteurs, T2) | 490 |
| Question | La fin seulement : « : reliez-la pour prévoir ce cas. Maximum 30 jours. » ; il reste « 0 = on attend sans limite. Au-delà de 0, une sortie « Pas de réponse » apparaît sur le bloc. » | 512 |
| Question | « Ce bloc part sur WhatsApp uniquement, et exige… ouvrir une campagne. » | 517 |
| Condition | « Le contact tire le fil « Si réunie »… Reliez chaque sortie à un bloc. » | 724 |
| Attente | « Le délai est tenu à la minute près environ… Maximum 30 jours. » | 246 |
| Attente | La variante `delai` du paragraphe d'alerte : « Après une attente, seul un envoi de template… ne partira pas. » ; la variante des modes date et heures ouvrées (« …refusé à la publication ») RESTE, hors liste | 274 |
| Assigner à un agent | « Le fil passe à un humain : le scénario s'arrête ici… l'agent automatique. » | 738 |
| Assigner à un agent | « Au pot commun, tout le monde la voit… administrateur. » | 773 |

- Un paragraphe vidé disparaît avec son `<p>` (pas de marge orpheline). Pour l'alerte de l'Attente, le `<p>` ne
  s'affiche plus en mode `delai`.
- **Tests attendus :** `web/e2e/workflow-type-chooser-wait.spec.ts:63` attend le texte retiré : il devient l'assertion
  inverse (le texte n'est PAS affiché en mode délai), et `:120` (variante longue) reste tel quel. Les deux e2e de la
  Condition (`workflow-condition.spec.ts:49,83`) trouvent « Si réunie » sur la carte du bloc, pas dans l'aide : rien à
  changer, à confirmer en les lançant.

## T2. Les compteurs de caractères

- Un petit composant `CompteurCaracteres` (`web/components/`), `{ valeur: string; max: number }`, qui affiche
  `n/max` dans le champ, à droite, en gris, et en couleur d'alerte à `max`. ⚠️ Il n'existe aucun composant réutilisable
  (cinq compteurs écrits à la main ailleurs) : on n'y touche pas, ce lot ne les fusionne pas.
- Posé sur : chaque réponse rapide du Message rapide (`maxLength={20}`, l. 629) et chaque réponse de la Question
  (`maxLength={24}`, l. 463). Le `maxLength` reste : le compteur montre la limite, il ne la remplace pas.
- **Tests attendus :** un test de composant (`web/lib` ou e2e court) : vide `0/20`, après trois lettres `3/20`, au
  plafond la classe d'alerte ; un e2e existant du Message rapide et de la Question reste vert.

## T3. Widget WhatsApp sous Tools (`web/lib/nav.ts`)

- L'entrée `widgets` (l. 272, premier niveau) passe dans les `children` du groupe `tools` (l. 336-350), après
  « Connecteurs MCP ». La route `/widgets` ne bouge pas, ni son icône dans la page.
- **Tests attendus :** `web/lib/nav.test.ts` et les deux e2e de navigation (`nav-rangement.spec.ts`,
  `navigation-onglets.spec.ts`) lancés : aucun ne cite l'entrée (relevé de l'exploration), un test qui compte les
  entrées de premier niveau se met à jour s'il existe. Le groupe Tools s'ouvre quand on est sur `/widgets`.

## T4. Documentation

- `features.md` : la section du constructeur de scénarios et celle du widget (où il se trouve). ⚠️ Toute section citée
  par une fiche d'aide se modifie avec sa fiche et son empreinte, `tests/aide-proposer.test.ts` vert AVANT le push.

---

## Méthode de livraison

**En direct**, sans agent ni boucle, parce que le lot ne touche que des textes, deux compteurs et une entrée de menu
d'une console publiée par Vercel : réversible par un simple revert, aucun chemin que la production emprunte pour
envoyer ou recevoir un message. Une relecture du diff en fin de lot quand même (règle du dépôt), courte.

**Ordre de déploiement :** `npm run typecheck` et `npm test` à la racine, `npm run build` dans `web/`, les e2e touchés
(T1, T2, T3) lancés en démarrant le serveur soi-même (CLAUDE.md, § e2e), push sur `main`, Vercel publie.

**L'essai réel qui clôt :** sur la console publiée, ouvrir un scénario de l'espace de Julien, cliquer chacun des cinq
blocs (Message rapide, Question, Condition, Attente en mode délai, Assigner) et vérifier que les textes listés ont
disparu ; taper une réponse rapide et voir le compteur passer de `0/20` à `5/20` ; ouvrir Tools et y trouver
« Widget WhatsApp », qui ouvre la page des widgets.
