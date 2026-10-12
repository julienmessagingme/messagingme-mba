# Lot 18 : la section développeurs de la vitrine

Lot 18 de « Messaging Me pour Claude Code » (plan privé, section « Ce qu'il faut construire »). Décisions de Julien du
2026-10-12, en deux rondes de questions, puis le design accepté le même jour.

## Ce qu'on veut

Un « vibe coder » qui construit avec Claude Code, Cursor ou Lovable arrive sur la vitrine, comprend en une page qu'il
peut brancher WhatsApp à son app en une session, et crée son espace. Google et les modèles qui lisent le web trouvent
cette page : c'est la seule porte de la doc qu'un moteur sait lire (le HTML de la doc de la console est vide côté
serveur, lot 17).

## Les décisions

| Sujet | Décision |
| --- | --- |
| Public | Les vibe coders (Claude Code, Cursor, Lovable) ; les équipes techniques des clients restent sur « Demander une démo » |
| Bouton d'inscription | Tout de suite, sur la page et en haut de l'accueil, malgré l'ouverture du site prévue sur Scaleway : les inscriptions arrivent sur l'infrastructure actuelle, avec ses réglages de charge provisoires (`docs/ARCHITECTURE-CIBLE.md` § 7.8) |
| Forme | Une seule page, `/developpeurs/` ; la doc reste dans la console, rien n'y est recopié |
| Langue | Français et anglais : `/developpeurs/` et `/en/developers/`, première page anglaise de la vitrine |
| Prix | La Free en chiffres, le Pro en une ligne, tenus égaux au code par un test ; aucun chiffre de Meta |
| Parcours | Claude Code d'abord (trois étapes), puis « Ou par le code » ; Cursor, VS Code et Lovable en une ligne |
| Visuel | Un terminal Claude Code animé, en HTML et CSS |
| Accueil | « Créer mon espace » en haut, à côté de « Demander une démo » ; le menu « Développeurs » de toutes les pages mène à la nouvelle page |

## Ce qui existe déjà, mesuré le 2026-10-12

- La vitrine (`site/`) est du HTML statique publié par Vercel, sans build. Le menu est recopié dans chaque page ;
  « Développeurs » y mène à un bloc de l'accueil (`/#developpeurs`) : une phrase, un appel `curl` et une commande Claude
  Code, deux boutons vers la doc de la console.
- 🔴 **La commande Claude Code de l'accueil n'est pas celle du tunnel** : l'accueil publie l'ancienne (serveur `mba`,
  clé dans l'en-tête), le tunnel `/demarrer` (lot 19) donne celle sans clé, par OAuth (`commandeMcp`,
  `web/lib/demarrer.ts`). Deux commandes publiques pour la même chose.
- Le tunnel est en production : `/signup` (ou Google depuis `/login`) crée l'espace et mène à
  `/connecter-whatsapp?suite=demarrer`, puis `/demarrer`. Aucun lien de la vitrine n'y mène encore.
- La console s'ouvre toujours en français : la langue vient d'un choix mémorisé par navigateur (`web/lib/i18n.tsx`),
  jamais de l'adresse. Un visiteur venu de la page anglaise tomberait sur une inscription en français.
- La grille de la Free vit dans `DROITS.base` et le prix du Pro dans `PRIX_PRO_HT_CENTIMES` (`src/offres/offres.ts`).
  Le prix du numéro fourni (3,50 € HT par mois) est `PRIX_NUMERO_HT_CENTIMES` (`src/stripe/abonnement.ts`), que la
  route compare au prix posé chez Stripe. (Corrigé par la relecture : la première version de cette spec le disait sans
  source dans le code.)
- Les exemples de code de la doc sortent d'un module compilé contre le SDK (`web/lib/exemples-code.ts`, lot 17).
- La CI de la racine ignore `site/**`, et son commentaire dit de retirer la ligne le jour où un test lira `site/`.

## La page `/developpeurs/`

De haut en bas. Le texte ci-dessous est la proposition ; il se relit à l'écran avec Julien.

1. **En tête.** Sur-titre « Développeurs ». Titre : « WhatsApp dans votre app, en une session Claude Code. » Chapeau :
   « Un numéro WhatsApp officiel, un agent IA qui répond à vos clients et une bulle sur votre site : Claude Code branche
   tout depuis votre terminal. » Deux boutons : « Créer mon espace » (`console.messagingme.app/signup`) et « Lire la
   doc » (`/developers/api` de la console). À côté, le terminal animé.
2. **Trois étapes.**
   - « Créez votre espace » : avec Google, en une minute ; branchez votre numéro, ou prenez-en un chez nous.
   - « Branchez Claude Code » : la commande du tunnel, à copier, puis `/mcp` dans Claude Code pour autoriser l'accès à
     l'espace.
   - « Demandez » : « Ajoute une bulle WhatsApp à mon site, et un agent IA qui répond à mes clients à partir de mon
     site. »
   - Une ligne : Cursor, VS Code ou Lovable ajoutent le serveur MCP `https://api.messagingme.app/mcp`, et la même
     autorisation s'ouvre.
3. **Ou par le code.** Envoyer des modèles, lire les conversations, recevoir chaque message par un webhook signé, avec
   un SDK TypeScript typé. Un exemple d'envoi repris de `EXEMPLES_SDK`, et les liens : doc de l'API, serveur MCP,
   recette Next.js, SDK, contrat OpenAPI.
4. **Gratuit pour commencer.** 1 000 modèles envoyés par mois ; 100 contacts créés (ceux qui vous écrivent ne comptent
   jamais) ; 1 utilisateur ; votre numéro, ou un numéro fourni à 3,50 € HT par mois ; l'IA payée à l'usage sur un crédit
   prépayé. Le Pro en une ligne : 49 € HT par mois, sans plafond de notre part sur les envois ni les contacts, 3 utilisateurs, numéro fourni
   inclus. Une phrase : Meta facture certains messages directement à votre entreprise, avec un lien vers sa grille.
5. **Un dernier appel** : « Créer mon espace ».

Les chiffres de la grille portent un attribut (`data-offre="base.contacts"`, `data-offre="pro.prix-mois"`…) que le test
lit : il ne dépend pas de la phrase autour.

## Le terminal animé

Une séance Claude Code rejouée en boucle : la demande de l'étape 3, puis les appels d'outils du serveur
`messagingme` sous leurs vrais noms, dans l'ordre où un vrai Claude les fait (l'import du site demande l'agent) :
`create_agent`, `import_site`, `activate_agent`, `set_default_responder`, `create_widget`. Puis la réponse de Claude
avec la balise de la bulle, à la forme exacte que rend le produit (`baliseDuScript`, `src/widgets/adresses.ts`).

- HTML et CSS, les lignes apparaissent à tour de rôle (le principe des scènes de l'accueil) ; un peu de `site.js` pour
  la boucle.
- Un visiteur qui a coupé les animations (`prefers-reduced-motion`) voit la séance terminée, sans mouvement.
- Le cadre porte une description lisible (`aria-label`), les lignes décoratives sont cachées aux lecteurs d'écran.
- Sous 640 px, les lignes reviennent à la ligne dans le cadre : aucun défilement horizontal de la page.

## L'anglais

- `/en/developers/` porte le même contenu, traduit. Son en-tête est réduit (logo vers l'accueil, la langue, « Sign
  in »), parce que le reste de la vitrine n'existe qu'en français ; son pied de page aussi.
- Le sélecteur de langue : sur `/developpeurs/`, le drapeau anglais devient un lien vers la jumelle, et réciproquement.
  Sur les autres pages, il reste « English, coming soon ».
- Les deux pages se déclarent l'une l'autre (`hreflang` fr, en, et `x-default` vers le français).
- **La console lit la langue dans l'adresse** : `?lang=en` (ou `fr`) à l'arrivée pose la langue et la mémorise, comme
  le bouton FR/EN. Les liens de la page anglaise vers la console la portent (`/signup?lang=en`, la doc). Une valeur
  inconnue est ignorée. Petit ajout dans `LocaleProvider`, sans route ni changement de l'API.

## L'accueil et le menu

- En haut de l'accueil : « Créer mon espace » à côté de « Demander une démo ».
- « Développeurs », dans le menu (bureau et téléphone) de toutes les pages de la vitrine, mène à `/developpeurs/`.
- Le bloc développeurs de l'accueil garde son texte, gagne un lien vers la nouvelle page, et sa commande Claude Code
  devient celle du tunnel : une seule commande publiée.

## Pour les moteurs et les modèles

- `sitemap.xml` : les deux pages.
- `llms.txt` : les deux pages en tête de la section « Développeurs », avec leur phrase.
- Chaque page : titre, description, adresse canonique, balises de partage avec une image `img/partage/developpeurs.jpg`
  (1200 × 630, tirée d'une capture du terminal), fil d'Ariane en JSON-LD.

## Ce que la CI tient

Un test de la racine (`tests/vitrine-developpeurs.test.ts`) lit `site/` :

1. Chaque `data-offre` des deux pages vaut ce que dit le code (`DROITS.base`, `PRIX_PRO_HT_CENTIMES`), et les deux
   pages portent les mêmes.
2. Toute commande `claude mcp add` publiée dans `site/` est celle de `commandeMcp`, sur l'API publique.
3. Chaque outil du terminal existe au catalogue des outils MCP, et la balise montrée a la forme de `baliseDuScript`.
4. L'exemple de code de la page est celui de `EXEMPLES_SDK`, au caractère près une fois le HTML décodé.
5. Plus aucun lien vers `/#developpeurs` ; chaque page de `site/` qui a un menu mène à `/developpeurs/`.
6. Le sitemap et `llms.txt` citent les deux pages ; les deux pages se déclarent l'une l'autre.

🔴 **Conséquence assumée** : `site/**` sort des chemins ignorés de `ci.yml` (son propre commentaire le demande), donc
chaque push de la vitrine lance la CI de la racine. La règle « un push `site/` seul ne lance aucune CI », écrite dans
`CLAUDE.md` et dans la mémoire des sessions, est mise à jour dans le même commit.

Le prix du numéro (3,50 €) et les utilisateurs du Pro portent aussi leur `data-offre`, comparés à
`PRIX_NUMERO_HT_CENTIMES` et à `DROITS.pro`.

## Hors périmètre

- La FAQ du plugin, publiée aussi sur la vitrine (lot 10, une seule source).
- La page Pricing, toujours « en construction ».
- Le reste de la vitrine en anglais.
- Rendre le HTML de la doc de la console côté serveur (`todo.md`, lot 17).

## Méthode de livraison

En direct, une seule livraison, sans agent implémenteur : des pages statiques et un petit ajout de la console,
réversibles en un push, qu'aucun chemin de production (envoi, webhook, base) n'emprunte ; le jugement est visuel et
revient à Julien. Une relecture indépendante en fin de lot, puis l'essai réel.

## L'essai réel qui clôt le lot

Julien, sur téléphone et sur ordinateur : la page en français puis en anglais, le terminal, les liens. Depuis la page
anglaise, « Create my workspace » ouvre l'inscription en anglais. Puis une inscription neuve de bout en bout depuis
la vitrine, qui clôt aussi l'essai dû du tunnel (lot 19).
