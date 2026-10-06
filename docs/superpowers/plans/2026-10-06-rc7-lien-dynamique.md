# RC7 : un champ du contact dans l'URL d'un bouton de template

> Chantier « Retours console du 6 octobre » (RC1 à RC8), cadré avec Julien le 2026-10-06. Plan COURT : tâches,
> interfaces, tests attendus, ordre de déploiement, sans code.

**But :** dans un template, un bouton « Lien » peut pointer vers une adresse dont une partie est un champ du contact
(`https://site.fr/commande/{numero_commande}`), sans perdre la mesure des clics.

**Décisions de Julien :**

| Question | Décision |
|---|---|
| Comment le champ est rempli | AU CLIC : Meta reçoit toujours notre lien tracé ; notre redirection retrouve le contact par son jeton et remplace le champ par sa valeur. Clics mesurés, aucun chemin d'envoi à modifier, valeur lue au moment du clic |
| Champ vide, ou message parti sans contact connu | On retire `{champ}` et on redirige vers le reste de l'adresse |

## Faits qui cadrent le lot (lus sur `e5c338d7`)

- La seule variable que Meta admet dans l'URL d'un bouton est un `{{1}}` FINAL, et il est déjà pris par le jeton du
  contact : `preparerLiens` (`src/http/templates.ts:87-114`) soumet `https://<api>/r/<code>/{{1}}`
  (`lienTraceAvecJeton`, `src/links/rewrite.ts:31`), et l'envoi y met `contacts.jeton_public` ou `anon`.
- La redirection (`src/http/links.ts:70-128`) envoie un 302 vers une destination FIXE stockée par bouton dans
  `tracked_links` ; le jeton ne sert qu'à attribuer le clic.
- `boutonsTracables` (`src/links/rewrite.ts:57-71`) exclut une URL qui contient `{{`. Nos champs s'écrivent avec des
  accolades SIMPLES, ils n'entrent pas en conflit.
- 🔴 **Les liens tracés sont une porte à sens unique** (CLAUDE.md) : une adresse `/r/<code>` déjà envoyée doit résoudre
  pour toujours. Ce lot ajoute une forme de destination, il n'en retire aucune.
- **Deux constats de lecture, à vérifier en tête de lot :** (1) l'envoi manuel d'un template depuis l'Inbox
  (`sendTemplateMessage`, `src/index.ts:941-951`) ne passe pas `suffixesBoutons`, donc un template tracé partirait sans
  son jeton (131008 chez Meta) ; (2) le PATCH d'un template (`src/http/templates.ts:386-393`) ne repasse pas par
  `preparerLiens`. Le premier se corrige dans ce lot (il empêcherait tout lien, dynamique ou non, depuis l'Inbox) ; le
  second, s'il est confirmé par un test, aussi.

## T1. La destination à champs et la redirection

**Fichiers :** `src/links/rewrite.ts`, `src/links/tracked-links.pg.ts`, `src/http/links.ts`, `src/http/templates.ts`
(validation), `src/meta/button-url.ts`, tests.

- Une destination peut porter des champs `{cle}` (clé d'un champ déclaré, ou `prenom`, `nom`, `telephone`). Stockée
  telle quelle dans `tracked_links.destination` : aucune migration.
- 🔴 **Un champ ne peut se trouver qu'APRÈS l'hôte** (chemin, requête, fragment) : refusé à la création sinon. Une
  valeur de fiche peut être écrite par le contact lui-même (formulaire, réponse) : un champ dans l'hôte ferait de notre
  domaine un redirecteur ouvert vers n'importe où.
- À la redirection, si la destination porte des champs : lecture du contact par son jeton, DANS L'ESPACE du lien
  (`tenant_id` du `tracked_link`, jamais un contact d'un autre espace qui aurait le même jeton), remplacement par la
  valeur encodée (`encodeURIComponent`), valeur absente ou jeton `anon` ou inconnu : le champ est retiré. L'adresse
  obtenue est revalidée (même schéma, même hôte que la destination) avant le 302 ; sinon, 302 vers la destination
  sans les champs.
- Une destination sans champ suit EXACTEMENT le chemin d'aujourd'hui (aucune lecture de plus).

**Tests attendus :** remplacement d'un champ présent, d'un champ vide, avec `anon`, avec un jeton d'un autre espace (le
champ est retiré, la fiche de l'autre espace n'est jamais lue) ; une valeur contenant `/`, `?`, `#`, `@` reste dans le
chemin (encodage) et ne change jamais l'hôte ; un champ dans l'hôte refusé à la création ; une destination fixe
redirige comme avant ; un lien déjà envoyé (fixture d'aujourd'hui) résout à l'identique.

## T2. L'envoi depuis l'Inbox (et le PATCH s'il est confirmé)

- `sendTemplateMessage` reçoit les suffixes de boutons comme la campagne et le scénario
  (`src/workflow/envois-bloc.ts:125-139` pour la forme) ; test qui échoue sans le correctif (le composant `url` absent).
- PATCH : un test qui prouve d'abord le défaut (un template tracé édité, envoyé, et le composant `url` incohérent), puis
  le correctif qui repasse par `preparerLiens`.

## T3. La console

**Fichiers :** `web/components/TemplateForm.tsx` (champ URL, l. 418-427), `web/lib/api/templates.ts`, e2e.

- Le champ « URL » d'un bouton « Lien » gagne le bouton « Variable » (le même sélecteur de champ que le corps), qui
  insère `{cle}` à la position du curseur ; un aperçu dit « exemple : https://site.fr/commande/A1234 » avec une valeur
  d'exemple.
- Refus lisible d'un champ placé dans l'hôte.

**Tests attendus :** e2e : créer un template avec un bouton dont l'URL porte un champ, le soumettre (Meta simulée),
voir que l'URL soumise est bien notre lien tracé à jeton.

## T4. Documentation

`documentation.md` (les liens tracés : la destination à champs, la règle de l'hôte, la lecture au clic), `features.md`
(templates, fiche d'aide relue avec son empreinte, `tests/aide-proposer.test.ts` vert avant le push), journal.

---

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de lot, parce que la redirection
`/r/` est une porte à sens unique (chaque lien déjà livré doit continuer de résoudre), qu'elle devient un point où une
donnée écrite par le contact entre dans une redirection (le risque de redirecteur ouvert), et qu'elle lit une fiche à
partir d'un jeton venu d'Internet (le risque d'une lecture hors de l'espace).

**Ordre de déploiement :** CI verte job par job, `compose build`, `up` de l'API et des deux workers (aucune migration),
rechargement NPM et contrôle public, et un lien `/r/` déjà envoyé testé depuis l'extérieur juste après. La console part
APRÈS (elle ne peut créer de bouton à champ qu'une fois la redirection capable de le remplir).

**L'essai réel qui clôt :** créer un template à bouton « Suivre ma commande » vers `https://…/{numero_commande}`, le
faire approuver par Meta, l'envoyer depuis une campagne à deux vrais numéros dont les fiches portent deux numéros de
commande différents, et depuis l'Inbox à l'un d'eux ; cliquer sur les téléphones : chacun arrive sur SA page, et les
clics sont comptés dans les mesures de la campagne.
