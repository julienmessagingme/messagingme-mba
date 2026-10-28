# Livre blanc « WhatsApp et recrutement étudiant » : page de téléchargement, HubSpot et SANDBOX

Cadrage du 2026-10-27 et du 2026-10-28 avec Julien. Ce document décrit quoi construire et pourquoi ; le plan
d'exécution viendra après son approbation.

## Intention

Julien veut un aimant à prospects pour les écoles : un livre blanc sur WhatsApp dans le recrutement étudiant, qu'on
télécharge sur la vitrine contre un formulaire. Chaque téléchargement doit tomber dans une liste du HubSpot de Messaging
Me, et ceux qui l'acceptent doivent pouvoir être relancés sur WhatsApp depuis l'espace SANDBOX, par les scénarios de
Julien. Le livre blanc lui-même est un objet de marque : il doit être « soigné et hyper peps », moderne, et donner
envie d'en parler à un directeur des admissions.

## Objectifs

1. Un livre blanc PDF de 10 à 14 pages, écrit et mis en page par Claude, sur WhatsApp dans le recrutement et les
   admissions de l'enseignement supérieur.
2. Une page dédiée de la vitrine qui le présente et porte le formulaire, et un bloc d'appel sur
   `site/solutions/enseignement-superieur/` qui y mène.
3. Après envoi du formulaire, une page « merci » qui donne le PDF tout de suite.
4. Chaque envoi crée ou met à jour le contact dans HubSpot, par une soumission de formulaire HubSpot.
5. Chaque envoi qui porte un mobile ET la case WhatsApp cochée dépose aussi le contact dans SANDBOX, avec le tag
   `livre-blanc-education` et son consentement.

## Hors périmètre

- La version anglaise du PDF : un second temps. Les pages anglaises, elles, sont dans le lot (voir Pièce 2).
- La relance elle-même : le modèle marketing approuvé sur le numéro de SANDBOX, les scénarios, la campagne. C'est le
  travail de Julien une fois les contacts arrivés.
- Le formulaire de contact existant (`/vitrine/contact`) : il continue d'envoyer un courriel, on ne le branche pas sur
  HubSpot ici.
- Un envoi WhatsApp immédiat du PDF : écarté par Julien, le PDF se télécharge sur la page « merci ».

## Anti-objectifs (ce qui serait un échec même si « ça marche »)

- Un message WhatsApp qui part tout seul au dépôt dans SANDBOX : aucune automation ne doit se déclencher.
- Un contact déposé dans SANDBOX sans consentement explicite, ou un téléchargement conditionné au consentement
  WhatsApp.
- Un prospect perdu en silence parce que HubSpot ne répondait pas.
- Un livre blanc qui fait du « marketing pur » : c'est précisément ce qu'il dénonce.
- Une promesse fausse sur le produit : un connecteur natif Dynamics ou Oscar qui n'existe pas, un tarif Meta inventé.

## Pièce 1 : le livre blanc

**Lecteur.** Les directions marketing, communication et admissions des écoles du supérieur (privées et publiques).

**Plan (de Julien, rangé par Claude).**

1. Couverture et édito : pourquoi WhatsApp pour recruter.
2. Comprendre WhatsApp : l'application personnelle, l'application WhatsApp Business, l'API WhatsApp Business. Un
   tableau des contraintes et des avantages de chacune.
3. Ce qu'il faut pour un compte API : portefeuille Meta Business vérifié, numéro dédié, nom d'affichage approuvé, la
   coche bleue (ce qu'elle est, comment on l'obtient). Encart « À retenir ».
4. Les chiffres : audience de WhatsApp en France, ouverture des Français aux messages des marques, présence dans
   toutes les tranches d'âge.
5. Ce qui marche dans l'éducation : être au plus près d'un événement du candidat (téléchargement de brochure,
   inscription à une JPO, admissibilité) ou lui apporter quelque chose qui a de la valeur (renvoi de brochure,
   invitation, livre blanc). Les cas NEOMA et Groupe EDH, avec exactement les chiffres et la source déjà publiés sur
   `site/solutions/enseignement-superieur/` (« cas clients présentés par Messaging Me, mai 2026 »).
   **L'acquisition par les publicités Click-to-WhatsApp** (ajout de Julien du 2026-10-28) : une publicité Facebook ou
   Instagram dont le bouton ouvre une conversation WhatsApp avec l'école, l'IA qui qualifie le projet du candidat,
   l'équipe admissions qui reprend. Illustrée par un **beau schéma pleine largeur** (la pub dans un fil Facebook, le
   bouton « Envoyer un message », la conversation qui s'ouvre, la fiche qui arrive au CRM). Cas Groupe EDH (campagnes
   Click-to-WhatsApp dans 11 pays). La gratuité des messages pendant 72 heures après le clic, déjà affirmée par
   `site/fonctionnalites/publicites-click-to-whatsapp/`, se revérifie chez Meta avant impression.
6. L'automatisation CRM : ce que c'est, et pourquoi c'est ce qui marche (on automatise sur des contacts qui remontent du
   CRM). HubSpot, Salesforce, Microsoft Dynamics, Oscar.
7. Démarrer sans CRM : le lien au CRM n'est pas obligatoire, des extraits s'importent ; des campagnes plus larges sans
   CRM (exemple : tous les candidats convoqués aux entretiens).
8. Organiser des relances intelligentes.
9. Faire parler vos équipes et vos ambassadeurs : le bot hybride (l'IA répond d'abord, un humain reprend), concept
   expliqué.
10. Ce qui ne marche pas : le marketing pur.
11. Check-list de démarrage, puis l'appel final.

**Règles d'écriture.** Vouvoiement. Aucun tiret cadratin ni demi-cadratin. La marque est Messaging Me ; « Meta
Business Agent » reste tel quel (c'est le produit de Meta) ; jamais « UChat ». Sur le produit, n'affirmer que ce qui
est vrai aujourd'hui : HubSpot et Salesforce exactement comme les décrit la page Intégrations de la vitrine (choix de
Claude : ni plus, ni moins, en distinguant le sens « la conversation qualifiée arrive au CRM » du sens « le CRM
déclenche le message ») ; Dynamics et Oscar « par import ou par API ». Les règles
WhatsApp (fenêtre de 24 h, modèles et catégories, consentement et STOP, tarifs de Meta) se rédigent depuis la skill
`messagingme:regles-whatsapp` et `~/.claude/brain/MESSAGINGME.md`, jamais de mémoire.

**Chiffres (décision de Julien du 2026-10-28).** Chaque chiffre porte sa source en note (éditeur, titre, date, lien),
relue mot pour mot sur la page d'origine avant impression. Une exception décidée par Julien : **« 96 % de lecture »
figure SANS source**, comme sur le film d'accueil. Le « 98 % d'ouverture » reste exclu. Points de départ sourcés :
étude BCG pour Meta (présentée le 9 avril 2026 ; 83 % des Français ouverts aux messages pertinents des marques, enquête
Kantar, contre 50 % des entreprises qui croient leurs clients favorables) à écrire comme une ouverture d'esprit, pas
un taux d'ouverture ; Médiamétrie (50,6 millions de visiteurs uniques mensuels en août 2026, 11 ans et plus). Les
« 30 ouvertures par jour » et la répartition par âge n'entrent qu'avec une source trouvée.

Pistes apportées par Julien le 2026-10-28 (une diapositive d'un document tiers : on reprend les FAITS à leur source
d'origine, jamais la diapositive), chacune à retrouver à la source primaire avant d'entrer :
- WhatsApp marque la plus puissante du monde, 41,7 % (YouGov BrandIndex, décembre 2025) ;
- 488 millions d'utilisateurs quotidiens en zone EMEA, près de 50 millions en France (GWI 2025, 32 pays) ;
- 30 ouvertures de l'application par jour, près de 900 par mois (Dentsu, « Human Truths ») ;
- 70 % des utilisateurs européens prêts à interagir avec des marques (BCG) ;
- plus de 80 % d'ouverture en cas d'interaction avec une marque, contre environ 15 % par e-mail (BCG).
Écartée : « 98 % d'ouverture et plus de 41,7 % de clics » (attribuée à YouGov, elle réemploie le 41,7 % de notoriété de
la première ligne, et le 98 % n'a aucune source d'origine connue). **La France à 56 millions** (Julien) : le chiffre
imprimé est celui dont on tient la source (Julien la fournit, ou Claude la trouve) ; à défaut, Médiamétrie.

**Captures des CRM (décision de Julien du 2026-10-28).** De vraies captures des quatre CRM, plutôt que des schémas.
Aucune donnée réelle visible : fiches de démonstration, ou floutage. **HubSpot** : prise par Claude sur le portail
Messaging Me, avec la carte Messaging Me sur une fiche de démonstration. **Salesforce, Dynamics et Oscar** : fournies
par Julien ; le produit exact derrière « Oscar » se confirme avec lui à la remise des captures. La section 6 se met en
page à leur arrivée ; le reste du livre blanc n'attend pas.

**Appel final.** Un QR code et un lien vers **le numéro de SANDBOX** (décision de Julien : le même numéro que les
relances, tout atterrit dans le même espace), plus la page contact de la vitrine. ⚠️ Avant l'ouverture de la page, ce
qui répond sur SANDBOX (agent de Meta, répondeur de test) se règle pour qu'un prospect qui écrit reçoive une vraie
réponse : c'est un prérequis de l'essai réel, à régler avec Julien.
Le lien imprimé est une adresse de la vitrine qui redirige vers `wa.me` (choix de Claude, par `site/vercel.json`) :
un PDF qui circule ne se rappelle pas, le numéro derrière doit pouvoir changer.

**Mise en page.** Moderne et « peps » : encarts, blocs « À retenir », gros chiffres, citations, contrastes de polices
(deux ou trois familles), palette de la marque (`site/site.css` : nuit `#010630`, action `#0080D6`) avec des accents
WhatsApp. Le livre blanc est écrit en HTML et CSS puis imprimé en PDF par Chromium (Playwright est déjà dans `web/`).
Les polices de la vitrine (`site/fonts/` : Plus Jakarta Sans, Inter, Google Sans) sont disponibles ; une police
d'accent supplémentaire est au choix du constructeur, si sa licence permet l'intégration dans un PDF.

**Séquence.** Trois pages d'essai d'abord (couverture, une page de contenu avec encart et « À retenir », la page des
chiffres), montrées à Julien. Le reste ne se met en page qu'après son accord sur le style.

## Pièce 2 : la vitrine

- **Page dédiée** `site/livre-blanc/whatsapp-education/` (adresse : choix de Claude) : promesse, sommaire visuel,
  aperçu de pages, formulaire. Indexable : elle entre dans `site/sitemap.xml`, `site/llms.txt`, avec son JSON-LD
  (fil d'Ariane).
- **Page « merci »** `site/livre-blanc/whatsapp-education/merci/` : `noindex`, hors du plan du site, avec le bouton de
  téléchargement du PDF et une invitation à écrire sur WhatsApp.
- **Bloc d'appel** sur `site/solutions/enseignement-superieur/` qui mène à la page dédiée. Cette page est générée
  (`scripts/vitrine/cas.ts` depuis `secteurs-textes.ts`, dans les deux langues) : le bloc s'écrit dans la source, et
  apparaît aussi sur `/en/solutions/higher-education/`, vers la page anglaise.
- **Pages anglaises (choix de Claude).** `tests/vitrine-langues.test.ts` exige une jumelle anglaise pour chaque page
  française : on ne l'affaiblit pas. La page dédiée et sa page « merci » ont leur jumelle, générée par les
  dictionnaires (`npm run vitrine:anglais`), qui propose le livre blanc en annonçant qu'il est en français. La route
  renvoie un formulaire anglais vers les pages anglaises, comme `/vitrine/contact`.
- **Formulaire.** Prénom, nom, e-mail professionnel, établissement, fonction (requis) ; mobile (facultatif) ; une case
  « J'accepte d'être recontacté par Messaging Me sur WhatsApp », **décochée** et facultative, avec un lien vers la
  politique de confidentialité. Le téléchargement ne dépend pas de la case. Un pot de miel comme sur le formulaire de
  contact.
- **Mécanique de la vitrine.** En-tête et pied de page par les gabarits (`npm run vitrine:entete`), jamais à la main.
- **Le PDF** est servi par la vitrine, à une adresse publique : le formulaire filtre l'accès, il ne le verrouille pas
  (usage normal d'un livre blanc). Un PDF remplacé sous le même nom prend un `?v=` incrémenté dans chaque page qui le
  cite (règle du cache de la vitrine).

## Pièce 3 : la route `POST /vitrine/livre-blanc`

Sœur de `POST /vitrine/contact` (`src/http/contact-vitrine.ts`), et elle en reprend tout : formulaire HTML natif en
`application/x-www-form-urlencoded`, réponse en redirection 303 vers des pages écrites dans le code (jamais lues dans
la requête), Zod en `safeParse`, pot de miel traité comme un succès, plafond de débit, classe d'accès `anonyme` dans le
registre `modulesDeRoutes`, fausse autorité déclarée dans `scripts/auto-attaque.mts`.

**Vers HubSpot (choix de Claude).** Une soumission à un formulaire HubSpot par l'API Forms (point d'envoi public, sans
jeton) plutôt qu'une création de contact par jeton : aucun secret à poser, HubSpot enregistre une vraie soumission, et
la liste de Julien se construit sur « a soumis le formulaire livre blanc », avec ou sans workflow. Appel borné dans le
temps. Deux points à **mesurer** sur le portail avant d'écrire le code : comment le point d'envoi traite un champ absent
de la définition du formulaire, et comment porter le consentement WhatsApp (propriété de contact dédiée, ou options de
consentement du formulaire selon les réglages RGPD du portail). Les mesures se font sur le VRAI formulaire (accord de
Julien), avec des adresses `julien+test…@messagingme.fr`, AVANT qu'il crée sa liste ou son workflow ; Julien supprime
ensuite ces contacts d'essai. Le formulaire HubSpot ne bloque pas les messageries gratuites : la page demande un
e-mail professionnel mais la route accepte toute adresse valide, et les deux règles doivent rester les mêmes.

**Vers SANDBOX.** Seulement si la case est cochée ET le mobile se normalise en E.164 (`e164DepuisSaisie`,
`src/crm/phone.ts`). Le contact est créé ou mis à jour par son numéro, reçoit son nom, le tag `livre-blanc-education`,
et son consentement avec une source qui dit d'où il vient (vitrine, livre blanc). Par les écritures existantes du store
de contacts (`src/crm/contact-store.pg.ts`) et la règle de transition du consentement du dépôt, jamais par du SQL à
côté. Trois règles :
- **aucune émission** d'événement d'automation (le défaut « n'émet pas » du dépôt) ;
- un contact qui avait dit STOP n'est **pas** réabonné par la case (choix de Claude : le plus prudent) ;
- la limite de contacts de l'offre s'applique par le chemin existant ; un dépôt refusé se journalise sans gêner le
  visiteur. SANDBOX est sans limite selon Julien : à vérifier en lecture seule au passage.

**Aucun prospect perdu (choix de Claude).** Si l'envoi à HubSpot échoue, la route envoie le prospect par courriel à
l'équipe, par le même chemin Resend que le formulaire de contact. Le visiteur reçoit le PDF dans tous les cas : ni une
panne de HubSpot, ni une panne de SANDBOX ne le privent du téléchargement.

**Configuration.** L'identifiant du portail, celui du formulaire HubSpot et l'espace où déposer (SANDBOX) arrivent par
la configuration ; aucun n'est un secret. Une valeur vide coupe la moitié correspondante, sans empêcher l'API de
démarrer.

## Gestes de Julien

- Créer le formulaire dans HubSpot avec les champs ci-dessus, et donner son identifiant (le connecteur HubSpot de
  Claude ne peut pas écrire de formulaire).
- Après les mesures de Claude : supprimer les contacts d'essai, puis créer sa liste (ou son workflow) sur ce
  formulaire.
- Fournir les captures de Salesforce, Dynamics et Oscar.
- Régler ce qui répond sur SANDBOX avant l'ouverture.
- Approuver le déploiement de l'API.

## Ordre de livraison

1. Trois pages d'essai du livre blanc, accord de Julien sur le style, puis le livre blanc entier, relu par Julien.
2. La route, ses tests, sa fausse autorité : poussée et **déployée avant** la page qui la poste (une page qui poste
   vers une route absente casse en silence).
3. La page dédiée, la page « merci », le bloc d'appel, le PDF : poussés après le déploiement de l'API.

`src/server.ts`, `src/index.ts` et `scripts/auto-attaque.mts` sont des fichiers de câblage partagés : annonce aux
sessions voisines avant de les éditer, commit en plomberie.

## Méthode de livraison

**En direct, sans agent**, avec une relecture indépendante en fin de lot. La route est un chemin que la production
emprunte, mais isolé, réversible, testable, et calqué sur une route existante ; le livre blanc et les pages sont
visuels, donc hors feature-loop.

## Essai réel

Julien envoie le formulaire depuis la vitrine en production, avec son mobile et la case cochée : le PDF se télécharge,
le contact est dans la liste HubSpot, et il est dans SANDBOX avec le tag et son consentement. Son mobile a déjà une
fiche dans SANDBOX : son état (tags, consentement, STOP éventuel) se relève AVANT l'essai, sinon un STOP laissé par
un essai ancien fait échouer l'écriture du consentement, à dessein. Un second envoi sans la case, adresse e-mail
différente : le contact est dans HubSpot, et la fiche SANDBOX est inchangée (aucun tag, aucun consentement ajouté).

## Laissé au constructeur

L'adresse exacte du PDF, la police d'accent, le texte des pages de la vitrine (dans la ligne de `memory`
« vitrine-positionnement » : on vend, sans réassurance technique), le libellé exact de la case, la forme de la
configuration (noms des variables), le plafond de débit de la route.
