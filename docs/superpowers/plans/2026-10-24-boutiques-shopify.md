# La page « Boutiques Shopify », avant le numéro par QR code : le chemin gratuit par Claude Code, et un guide du numéro

**Plan du 2026-10-24.** Lot 1 de la conception `docs/superpowers/specs/2026-10-23-vitrine-shopify-design.md`, que Julien
a décidé le 2026-10-24 de construire sans attendre le produit QR code, avec un questionnaire qui guide le marchand vers
son numéro. Le film (lot 3) reste à faire.

## Décisions de Julien (2026-10-24)

- **La page sort maintenant**, au menu Solutions, et vend d'abord le chemin gratuit : l'offre Free, tout se branche en
  le demandant à Claude Code.
- **Un numéro relié par QR code ne fait que RÉPONDRE** : l'agent IA répond aux clients qui écrivent ; les messages
  Shopify (confirmation, expédition, relance) demandent un numéro relié par Meta. Mesuré le 2026-10-24 par la session
  du connecteur : écrire en premier à un inconnu depuis un numéro QR code fait couper le numéro ou refuser le message.
- **La coexistence s'annonce déjà** (« on est en train de bosser dessus ») : le marchand qui a un numéro WhatsApp
  Business depuis plus d'un mois le gardera, et le reliera aussi à l'API. Pas de date ; « un mois » est la règle de
  Julien (Meta n'en publie pas, les revendeurs conseillent sept jours).
- **Le questionnaire est l'arbre de Julien** (une feuille dessinée à la main, après le premier rendu en deux questions),
  qui part de ce que le marchand a déjà : jusqu'à quatre questions, et à chaque « ou » la différence expliquée. Et
  « personne ne comprend jamais rien à ça » : les mots se disent avant les questions.
- **Le même parcours dans le plugin** : la skill de mise en service le suit pour que Claude Code réponde « le pourquoi du
  comment » entre un numéro de l'API et l'application WhatsApp Business (avec la coexistence plus tard, si le client le
  veut), et le README GitHub l'explique.

## Ce que la page affirme, et d'où

- Free à 0 € d'abonnement, Shopify ouvert par Claude Code (`src/mcp/outils-shopify.ts`, `fonction: null`), 100 contacts
  créés (`DROITS.base`) ; console en Pro, 49 € HT par mois, 14 jours d'essai ; numéro fourni à 3,50 € HT par mois en
  Free, inclus dans le Pro (`site/tarifs/`) ; Meta facture les messages au marchand ; l'agent IA sur un crédit prépayé.
- Le scénario, la relance et ses règles (§ 1 et § 4 de la conception, `features.md` § Boutique Shopify).
- Le numéro (session du connecteur, 2026-10-24) : l'API officielle demande un portefeuille Meta Business, que la fenêtre
  de Meta crée sur place, et un numéro hors de l'application WhatsApp (le sien, ou un numéro fourni) ; la coexistence
  garde l'application et son numéro, avec ses contreparties (messages de l'API facturés par Meta, fonctions de
  l'application retirées, l'ouvrir au moins toutes les deux semaines).

## Le questionnaire : l'arbre de Julien

D'abord cinq mots : compte Meta Business, application WhatsApp Business, API officielle, QR code, coexistence. Puis :

1. « Avez-vous un compte Meta Business ? » Je ne sais pas → où vérifier (business.facebook.com).
2. Dans les deux cas (avec un compte depuis la relecture du rendu par Julien) : « Utilisez-vous l'application WhatsApp
   Business ? » Oui → 3 ; Non → 5.
3. « Voulez-vous automatiser ce numéro ? » Oui → 4 ; Non → 5 (un autre numéro).
4. « Depuis quand ? » Plus d'un mois → **la coexistence** (bientôt ; le QR code en attendant) ; moins d'un mois → **le
   QR code, puis la coexistence**.
5. Avec un compte : « Avez-vous un numéro disponible ? » Oui → **l'API, votre numéro** ; Non → **l'API, un numéro
   fourni**. Sans compte : « Avez-vous un numéro pour automatiser ? » Oui → **votre numéro, deux voies** ; Non → **un
   numéro fourni, deux voies**.

Les deux voies, la légende de Julien : l'API (un compte Meta Business à créer, les messages partent) ou le QR code (sans
compte, ne fait que répondre, la coexistence plus tard). Sans script, les six issues se lisent en liste, chacune avec sa
situation.

## Tâches

1. Le registre : une nature `boutique` pour l'entrée `shopify` (`/solutions/shopify/`, `/en/solutions/shopify-stores/`),
   au menu Solutions après les secteurs ; les tests du registre et du menu suivent.
2. Les textes FR et EN (`scripts/vitrine/boutique-textes.ts`) et leur assemblage par `npm run vitrine:cas` : la une
   (logo Shopify noir, deux portes), le problème (Baymard), le scénario en cinq temps, ce que vous branchez, et ensuite
   (les combinaisons étiquetées de leur offre ; pas de bulle avant son essai), le guide du numéro, commencer en quatre
   étapes, le prix, une FAQ en `FAQPage`, l'appel final. Visuel de la une : un téléphone en HTML (la relance, la
   question, la réponse de l'agent), sur le modèle de l'accueil.
3. Le questionnaire dans `site.js`, lisible sans script.
4. Les liens : la carte Shopify de `/integrations/` mène à la page ; le bandeau de l'accueil garde son chemin vers
   `/integrations/#shopify`, et la page d'aide le sien vers le plugin (son corps ne porte pas de lien, la fiche n'en a pas).
5. Plan du site, `llms.txt`, `features.md`, `documentation.md`, journal.
6. Le plugin : le choix de la filière de la skill `mise-en-service` suit l'arbre (mots d'abord, questions une à une), la
   skill `shopify` y renvoie, le README GitHub gagne « Which WhatsApp number? », la FAQ (`scripts/plugin/faq.ts`, publiée
   aussi sur les pages développeurs) corrige ses réponses sans compte Meta Business et ajoute « API ou application » ;
   version 0.3.9, publiée par `plugin.yml` après le push (aucun outil nouveau, donc rien à déployer avant).

## Tests attendus

La suite racine entière (registre, menu, `vitrine-cas`, `vitrine-anglais`, `vitrine-entete`, `vitrine-marque-shopify`,
`vitrine-langues`, `plugin`, `plugin-faq`, `plugin-readme`), plus un test de l'arbre (chaque réponse mène à une question
ou à une issue, tout est atteint, rien ne boucle, les deux langues ont le même arbre, la page sans script montre les six
issues) et des promesses : aucune phrase de la page ne promet un message Shopify sur un numéro QR code.

## Méthode de livraison

**En direct, sans agent**, parce que c'est une page statique réversible (un `git revert`), sans chemin de production :
aucun envoi, aucune migration. Ce qui compte est la promesse juste, que Julien juge sur le rendu : le rendu bureau et
téléphone, en deux langues, lui est montré, et rien ne part sans son oui. Une relecture indépendante en fin de lot,
tournée vers la promesse (numéro, prix, QR code), la marque Shopify et le rayon de souffle sur le menu.

**L'essai réel qui clôt** : Julien parcourt la page en ligne, sur ordinateur et sur téléphone, en français et en anglais,
répond au questionnaire jusqu'à chacune des six issues, et retrouve la page depuis le menu Solutions, la page
Intégrations, le bandeau de l'accueil et la page d'aide. Puis, le plugin 0.3.9 installé, il tape `/messagingme:demarrer`
sur un espace sans numéro et vérifie que Claude explique les mots et pose les questions une à une, dans l'ordre de
l'arbre.
