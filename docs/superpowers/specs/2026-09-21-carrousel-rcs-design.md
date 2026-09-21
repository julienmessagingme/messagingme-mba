# Carrousels RCS : les composer, et les envoyer en campagne

> Décidé avec Julien le 2026-09-21. Périmètre validé : lot 1 (composeur dans Contenu > Messages RCS) et
> lot 2 (un carrousel de la bibliothèque dans l'assistant de campagne). Le bloc de scénario est un lot 3,
> cadré ici et délibérément non planifié.

## Objectif

Un client doit pouvoir composer un carrousel RCS (plusieurs cartes qui défilent à l'horizontale, chacune
avec son visuel, son texte et ses boutons) et l'envoyer en campagne. Aujourd'hui, le serveur sait l'envoyer
mais aucun écran ne sait le produire : le format n'existe que pour qui appelle l'API à la main.

## Ce qui existe déjà, et qu'on ne touche pas

🔴 **LE SERVEUR EST PRÊT, ET CE CHANTIER N'Y AJOUTE AUCUNE LIGNE.** Vérifié le 2026-09-21 :

- Le modèle et sa validation portent le carrousel, de 2 à 10 cartes (`src/rcs/schema.ts`, `rcsOutboundSchema`).
  La route de la bibliothèque et la création de campagne (rang 1 comme étages de repli) valident avec lui.
- La traduction vers smsmode est conforme à leur spec, relue le 2026-09-21 dans
  `dev.smsmode.com/rcs/openapi/rest-rcs.yml` : `type: CAROUSEL`, `contents` de 2 à 11 cartes, chaque carte en
  `CardContentPost` (`title`, `description`, `media.fileUrl`, `media.height`, `suggestions` jusqu'à 4).
  `cardWidth` est facultatif et vaut `MEDIUM` par défaut ; on ne l'envoie pas.
- Les variables `{{champ}}` (titre, description, dates d'agenda), le suivi des liens et l'élagage des boutons
  Agenda invalides descendent déjà dans chaque carte, avec leurs tests.

⚠️ **AUCUN CARROUSEL N'EST JAMAIS PARTI POUR DE VRAI.** Le chemin est conforme à la spec et testé, pas
éprouvé. C'est l'essai réel de fin de chantier qui l'éprouvera (cf. plus bas).

Conséquence : **pas de migration, pas de déploiement VPS**. Tout part par Vercel, au push.

## Périmètre

**Dedans**

1. L'écran Contenu > Messages RCS refait sur le dessin de Contenu > Templates, avec le composeur de
   carrousel : créer, modifier, aperçu.
2. Le choix d'un carrousel enregistré dans l'assistant de campagne, sur n'importe quel étage RCS.
3. Deux retouches voisines, parce que la bibliothèque va maintenant CONTENIR des carrousels :
   - le panneau RCS de l'Inbox dessine l'aperçu d'un carrousel, au lieu d'annoncer qu'il ne sait pas ;
   - le bloc de scénario montre les carrousels GRISÉS avec leur raison, au lieu de les cacher en silence
     (le produit grise une option indisponible avec sa raison, il ne la fait pas disparaître).

**Dehors, et pourquoi**

- **Le bloc de scénario (lot 3).** Un carrousel dans un parcours pose la question des SORTIES (une par
  bouton Réponse de chaque carte), et elle mérite son propre lot.
- **La numérotation des boutons d'un carrousel pour les branches.** `normaliserPostbacks` laisse aujourd'hui
  les carrousels tels quels. Le carousel WhatsApp route déjà ses boutons par `card:<i>:btn:<j>` (l'exécuteur
  le connaît) : le lot 3 s'alignera sur cette forme. Figer une autre convention maintenant, sans son
  consommateur, obligerait à la défaire.
- **Les pastilles sous le carrousel.** smsmode en accepte 11, notre modèle n'en porte pas. Les ajouter
  toucherait six endroits du chemin d'envoi serveur (schéma, types, traduction smsmode, variables, élagage,
  suivi des liens) pour un besoin qui n'est pas exprimé.
- **La largeur des cartes.** On garde `MEDIUM`, le défaut de smsmode. C'est aussi la largeur qui autorise la
  hauteur `TALL` chez Google.
- **La carte à titre** (une carte simple avec titre, créable par l'API seulement) reste non éditable.

## Lot 1 : l'écran Contenu > Messages RCS, calqué sur Contenu > Templates

🔴 **DEMANDÉ PAR JULIEN LE 2026-09-21 : « il faut que ça ait vraiment la même gueule que les écrans WhatsApp
template ».** Les deux bibliothèques de contenu doivent se prendre en main de la même façon. Le relevé
ci-dessous a été fait sur les deux écrans RENDUS côte à côte le même jour, pas seulement dans le code.

### La liste

- Plus de titre de page ni de colonne centrée : un titre de section **« Messages RCS (N) »**, avec
  « Rafraîchir » et **« + Créer un message »** à droite, comme « Templates (N) ».
- Un **tableau** au même dessin (en-têtes en capitales grises) : **Nom** (cliquable, il ouvre l'aperçu dans
  une fenêtre, comme un template), **Format** (« message », « carte », « carrousel · 3 cartes »), **Texte**
  (le début du texte, ou celui de la première carte), **Actions** (« Éditer », « Supprimer »). « Éditer » est
  grisé AVEC SA RAISON sur une carte à titre, comme sur un carousel WhatsApp.
- Liste vide : le même encadré pointillé, avec sa phrase.

### Créer, modifier

- **Créer** ouvre au-dessus de la liste le même encadré bleu clair : « Nouveau message RCS » et « Fermer »,
  puis le sélecteur **« Message simple | Carrousel »** (sur « Message simple » par défaut), puis le
  formulaire dans une carte blanche. La phrase qui dit la différence avec WhatsApp prend la place de la
  mention Meta : « Aucune validation : un message RCS part tel qu'il est écrit, sous votre agent de marque ».
- Basculer de format ne perd rien : les deux formulaires restent montés, seul l'affiché compte. C'est une
  petite amélioration sur l'écran des templates, qui démonte le formulaire quitté.
- **Modifier** ouvre le même encadré, titré « Modifier « nom » », SANS sélecteur de format : un message
  s'ouvre dans le formulaire de son format, comme un template. Changer de format, c'est créer un autre
  message.
- ⚠️ Deux boutons distincts dans la liste (« + Message simple », « + Carrousel ») ont été écartés : le format
  y serait choisi avant d'avoir commencé et sans retour possible, et l'écran divergerait de celui des
  templates.

### Le formulaire « Message simple »

Le dessin de `TemplateForm` : le formulaire à gauche (Nom, Image d'en-tête, Message, Boutons), l'**« Aperçu
RCS »** dans un cadre de téléphone à droite (300 px, collant), la liste **« Il manque : … »** sous le
formulaire, et un bouton pleine largeur **« Créer le message »** (« Enregistrer les modifications » en
modification).

⚠️ **CE QU'IL PRODUIT NE CHANGE PAS D'UNE VIRGULE** (`versMessageRcs`), et ses `data-testid` restent ceux
d'aujourd'hui : les cas de `rcs-messages.spec.ts` doivent passer sans être réécrits. Un test qu'il faudrait
adapter au nouveau dessin dirait que le dessin a changé ce qui part, et c'est exactement ce qu'on ne veut pas.

🔴 **« Il manque » est NEUF sur ce formulaire**, dont le bouton se grisait jusqu'ici sans rien dire (le nom,
le texte, un texte trop long, un bouton incomplet). Le bouton est grisé si et seulement si la liste n'est pas
vide : la même liste décide des deux, sans quoi le bouton se grise pour une raison qu'elle ne nomme pas (le
défaut que garde `manques-cablage.test.ts` ailleurs).

### Le formulaire « Carrousel »

Le dessin de `CarouselForm` :

- le nom, puis **« Cartes (2/10, 2 minimum) »** en grille de deux colonnes, et la tuile pointillée
  **« + Ajouter une carte »** à droite (10 au plus) ;
- chaque carte : « Carte N » et « Retirer » (impossible sous 2 cartes), le visuel dans la zone pointillée
  « Choisir une image » (le téléversement hébergé du message simple, avec la saisie d'une adresse en
  dessous), un titre facultatif (200 caractères), le texte avec ses variables `{{champ}}` (2 000 caractères),
  et ses boutons (4 au plus, les six types, l'éditeur partagé `RcsButtonsEditor`) ;
- l'**« Aperçu RCS »** en dessous, pleine largeur, où les cartes défilent à l'horizontale ;
- **« Il manque : … »** (« le visuel ou le titre de la carte 2 », « un bouton incomplet sur la carte 3 »…),
  puis **« Créer le carrousel »**.

⚠️ **UNE DIFFÉRENCE AVEC WHATSAPP, ET ELLE EST VOULUE : les boutons se règlent CARTE PAR CARTE.** Meta exige
la même disposition de boutons sur toutes les cartes d'un carousel ; le RCS, non. Recopier la disposition
commune de `CarouselForm` serait inventer une contrainte que le canal n'a pas.

⚠️ Pas de déplacement de carte (gauche, droite) : `CarouselForm` n'en a pas, et le besoin n'est pas exprimé.

### Le cadre « Aperçu RCS »

Le pendant de `PhoneFrame` : le libellé « Aperçu RCS », un en-tête au NOM DE MARQUE de l'agent RCS
(`RcsAgent.brandName`, résolu comme `PhoneFrame` résout le nom vérifié WhatsApp : une requête par espace,
repli « Votre marque »), un fond de conversation clair. Les bulles restent celles de `RcsPreview` (menthe, la
couleur du RCS dans l'Inbox). Le cadre sert sur cet écran (formulaires et fenêtre d'aperçu) et à l'étage
carrousel de l'assistant. L'Inbox et le bloc de scénario gardent leur aperçu nu : leurs panneaux sont étroits,
et les changer n'est pas demandé.

### Les règles d'une carte

- **Un visuel OU un titre**, obligatoire : c'est la règle de smsmode (« must contain media or title »), déjà
  tenue par `rcsCardSchema` côté serveur. L'écran la tient à la saisie pour ne pas découvrir le refus à
  l'enregistrement.
- **Visuel en `TALL` (16:9)**, comme la carte simple, et pour la même raison : le défaut du fournisseur
  (`MEDIUM`, 2:1) rogne le visuel.
- **Texte plafonné à 2 000**, avec ou sans visuel : c'est la borne du champ `description` d'une carte.
- **Boutons sans libellé écartés**, `postbackData` gardé s'il existe, sinon dérivé (`carte<i>_btn<j>`), même
  règle que `versMessageRcs`. Il n'a aujourd'hui aucun rôle de routage (cf. « Dehors »).

### Où vit la logique

🔴 **UN MODULE PUR, `web/lib/rcs-carrousel.ts`**, sans React ni `window`, testé depuis la suite RACINE contre
le schéma SERVEUR, exactement comme `web/lib/rcs.ts` : ce que l'écran fabrique doit passer la validation de
la route, et seul un test peut tenir cet invariant entre deux tsconfig qui ne partagent aucun paquet.

- `BrouillonCarrouselRcs` : `{ cartes: CarteBrouillon[] }`, où `CarteBrouillon` vaut
  `{ title, text, imageUrl, suggestions }` (mêmes noms que `BrouillonRcs`).
- `carrouselVide()` : deux cartes vides.
- `versCarrouselRcs(brouillon)` : le message envoyable (`kind: 'carousel'`).
- `versBrouillonCarrousel(contenu)` : l'inverse, ou `null` si ce n'est pas un carrousel.
- `manquesCarrousel(brouillon)` : la liste des manques, en paires `[fr, en]` (module pur, `useT` y est
  inappelable ; même convention que `LIBELLE_KIND`). Le bouton « Créer le carrousel » est grisé si et
  seulement si elle n'est pas vide.
- `carrouselDepuis(valeur)` : la relecture STRICTE d'un carrousel venu d'un JSON non validé (cf. lot 2).

Les manques du message simple suivent la même règle, dans `web/lib/rcs.ts` (`manquesMessageRcs`).

Composants : `RcsMessageForm.tsx` (le formulaire simple, sorti de la page), `RcsCarouselForm.tsx`,
`RcsCarouselPreview.tsx` (l'aperçu de carrousel, partagé par la bibliothèque, l'assistant et l'Inbox) et
`RcsPhoneFrame.tsx` (le cadre). La page `web/app/rcs-messages/page.tsx` ne garde que la liste, l'encadré et
l'aiguillage entre les deux formulaires.

## Lot 2 : un carrousel dans l'assistant de campagne

### Ce que voit l'utilisateur

- « Partir d'un message enregistré » propose AUSSI les carrousels, marqués « (carrousel) ».
- En choisir un pose une **copie figée** du carrousel sur l'étage. Les champs Visuel, Message et Suggestions
  laissent la place à l'aperçu du carrousel (dans le cadre « Aperçu RCS »), avec une phrase (« Copié
  depuis la bibliothèque : pour le modifier, modifiez-le dans Contenu > Messages RCS puis choisissez-le à
  nouveau ») et un bouton **« Revenir à un message simple »**.
- Le texte, le visuel et les suggestions saisis AVANT restent en mémoire : retirer le carrousel les rend.
- Choisir ensuite un message simple dans la même liste retire le carrousel.
- Les deux formules marchent : « Message seul », et « Message et scénario » (le carrousel part, puis le
  scénario démarre, comme pour une carte).

### Les données

- `ContenuEtage.carrouselRcs?: CarrouselRcs` (`AssistantCampagne.tsx`), et son miroir structurel dans
  `EtatPourCreation.contenus` (`campagne-creation.ts`), `ContenuMinimal` (`campagne-chaine.ts`) et
  `ContenuBrouillon` (`campagne-brouillon.ts`).
- Pas de nom stocké : l'aperçu montre le contenu lui-même, qui est ce qui part.

### Les trois invariants, et où ils sont tenus

1. 🔴 **CE QU'ON CACHE EST EXACTEMENT CE QU'ON N'ENVOIE PAS.** Carrousel posé : `messageRcs` rend le
   carrousel, jamais le texte masqué. Carrousel retiré : il rend le texte. Même prédicat (la présence de
   `carrouselRcs`) pour l'écran, la création, la garde de lancement et `etageRenseigne`. C'est le motif qui
   s'est déjà posé trois fois dans ce fichier (`reessayer`, `assignation`, `devenir`), et il se tient de la
   même façon : un test sur le CORPS de création, dans les deux sens.
2. **UN ÉTAGE PORTEUR D'UN CARROUSEL EST RENSEIGNÉ**, même sans texte : `etageRenseigne` et
   `problemeAvantLancement` ne lui demandent pas de texte. Sans ça, l'assistant refuserait d'avancer sur un
   étage parfaitement rempli.
3. **LE BROUILLON RELIT LE CARROUSEL STRICTEMENT.** `campaign_drafts.state` est un `jsonb` libre que rien ne
   valide. `carrouselDepuis` vérifie la forme (2 à 10 cartes, champs connus et bien typés, un visuel ou un
   titre par carte, boutons des six types avec leurs champs obligatoires). 🔴 **Un carrousel mal formé est
   JETÉ, jamais réparé** : l'étage redevient vide, le récapitulatif dit qu'il n'a pas de message, et
   l'opérateur le choisit à nouveau. Réparer (comme `boutonsDepuisNode` transforme un bouton inconnu en
   bouton Réponse) serait acceptable sur un contenu qu'on édite sous ses yeux ; sur une copie figée qu'on
   ne peut pas éditer ici, ce serait envoyer un message que personne n'a relu.
   ⚠️ La relecture vérifie la FORME, pas tout le détail (une URL mal formée passe) : **le serveur reste
   l'autorité** et refuse en 400 à la création, comme pour tout ce que l'assistant envoie.

## Lot 3, cadré et non planifié : le bloc de scénario

Pour mémoire, ce qu'il faudra : stocker le message ENTIER dans le bloc (`rcsOutboundOf` reconstruit
aujourd'hui texte ou carte depuis trois champs), une sortie par bouton Réponse de chaque carte, et
`normaliserPostbacks` qui réécrit les boutons d'un carrousel en `card:<i>:btn:<j>`, la forme que l'exécuteur
route déjà pour le carousel WhatsApp.

## Tests

- **Suite racine** (`tests/web-rcs-carrousel.test.ts`) : `versCarrouselRcs` passe `rcsOutboundSchema` ;
  aller-retour `versBrouillonCarrousel` ; boutons sans libellé écartés ; `postbackData` dérivé ; une carte
  sans visuel ni titre est un manque ; `carrouselDepuis` accepte ce que le serveur accepte et rejette les
  formes cassées (1 carte, 11 cartes, bouton de type inconnu, lien sans adresse). Et `manquesMessageRcs`
  nomme chacune des conditions qui grisaient déjà le bouton du message simple.
- **Les cas de `rcs-messages.spec.ts` passent SANS être réécrits** : c'est la preuve que le nouveau dessin
  du message simple n'a rien changé à ce qu'il poste.
- **Suite du front** : `campagne-creation.test.ts` (le carrousel part au rang 1 comme en repli ; le texte
  masqué ne part pas ; retiré, le texte repart ; la garde ne demande pas de texte), `campagne-chaine.test.ts`
  (`etageRenseigne`), `campagne-brouillon.test.ts` (le carrousel survit à l'aller-retour ; mal formé, il est
  jeté).
- **E2E** : un nouveau `rcs-carrousel.spec.ts` (créer un carrousel et lire le corps POSTÉ ; les manques ;
  modifier un carrousel existant, qui s'ouvre sans sélecteur dans le formulaire carrousel ; basculer de
  format sans rien perdre ; le tableau dit le format ; le nom ouvre l'aperçu) ; `campagne-assistant-rcs.spec.ts`
  RETOURNÉ (le carrousel est désormais proposé, et le corps de création le porte ; « Revenir à un message
  simple » renvoie le texte) ; la garde de largeur à 1 280 px sur le composeur et sur l'étage portant un
  carrousel.

## Méthode de livraison

**En direct, par moi, en deux lots successifs**, parce que :

- rien ne change côté serveur ni en base : un redéploiement Vercel suffit à revenir en arrière ;
- les critères se testent mécaniquement : fonctions pures, et e2e qui lisent le corps RÉELLEMENT posté ;
- le seul chemin sensible est la création de campagne (ce que de vraies personnes reçoivent), et il est
  couvert par les tests du corps de création, le serveur revalidant tout à l'arrivée.

Chaque lot se ferme par : tests (racine, front, e2e) verts en local, `/revue` avec sa section « rayon de
souffle », puis la CI lue job par job après le push.

🔴 **« LA MÊME GUEULE » NE SE PROUVE PAS PAR UN TEST, ELLE SE REGARDE.** Le lot 1 se ferme aussi sur des
captures des deux écrans rendus côte à côte (Templates et Messages RCS, liste et formulaires), montrées à
Julien avant le push. Un e2e vérifie ce qui part, pas à quoi ressemble ce qu'on voit.

## L'essai réel qui clôt la feature

À faire par Julien, sur son téléphone :

1. composer un carrousel de 3 cartes (visuels, un bouton Réponse, un bouton Lien) dans Contenu > Messages RCS ;
2. l'envoyer depuis le panneau RCS de l'Inbox à son propre numéro ;
3. vérifier le rendu (les cartes défilent, les visuels s'affichent, les boutons sont dans les cartes), taper le
   lien (le clic doit être compté) et la réponse (elle doit arriver dans l'Inbox) ;
4. lancer une campagne RCS vers lui-même avec ce carrousel.

C'est aussi le premier carrousel réellement accepté (ou refusé) par smsmode : un refus à cette étape est
une information sur leur API, à consigner, pas un échec du chantier.
