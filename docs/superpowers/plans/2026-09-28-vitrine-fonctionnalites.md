# Vitrine : les pages Fonctionnalités (Publicités Click-to-WhatsApp, Chaînes WhatsApp)

Demande de Julien du 2026-09-28 : des pages de la vitrine (`site/`, engageme.messagingme.fr) sur les
fonctionnalités d'Engage Me, en commençant par les publicités Click-to-WhatsApp et les chaînes WhatsApp, et un
menu « Fonctionnalités » dans l'en-tête collant.

## Méthode de livraison

**En direct, sans agent.** Ce sont des pages statiques de la vitrine : isolées de la console et de l'API, sans
aucun chemin que la production emprunte (ni envoi, ni donnée), réversibles par un retour arrière du commit.
L’essai réel qui clôt la feature est celui de la section « Essai réel qui clôt », plus bas : Julien parcourt
les deux pages en production, sur ordinateur et sur téléphone.

## Décisions de Julien (cadrage du 2026-09-28)

- Menu **« Fonctionnalités »**, sous-menus « Publicités Click-to-WhatsApp » et « Chaînes WhatsApp ».
- Les films du reel : **un mélange** : le film intégré dans la page, et son récit repris en HTML.
- Le chiffre de la page Chaînes : **10 millions** d'utilisateurs quotidiens des chaînes WhatsApp en France,
  **Source : Meta, 2026** (le film v2 compte jusqu'à 10, vérifié image par image).
- L'appel de fin : **« Demander une démo »** (e-mail à contact@messagingme.fr), et « Se connecter ».

## Ce qui est livré

- `/site.css` : le style de l'accueil, sorti TEL QUEL de sa balise `<style>` (même ordre), plus le menu et les
  classes `f-` des pages. `/site.js` : l'en-tête collant, le menu, et le comportement des pages.
- `/fonctionnalites/publicites-click-to-whatsapp/` et `/fonctionnalites/chaines-whatsapp/`. L'en-tête, le pied et
  les icônes y sont RECOPIÉS de l'accueil : une modification se reporte dans les trois pages (dit en tête de
  chaque fichier).
- `site/img/` : les écrans, RENDUS depuis les sources HTML des films du reel (double densité, fond transparent),
  pas extraits de la vidéo. `site/films/` : les deux films en 720p (2,3 et 2,8 Mo) et leurs affiches.

## Vérifications faites

- Empreinte de rendu de l'accueil (style calculé et boîte de chaque élément, 1280 et 375 px) avant et après la
  sortie du CSS : identique jusqu'au pied de page, où seuls les deux liens ajoutés font bouger les hauteurs.
- Les deux pages à 1440 et 390 px : aucune erreur de chargement, aucun débordement horizontal.
- En défilement réel : l'écran collant suit l'étape lue (et revient à la première après un saut en haut), le
  film part muet à l'écran et s'arrête hors écran, l'entonnoir et le compteur s'animent une fois.
- Le menu : ouverture au clic, fermeture par Échap (focus rendu) et par un clic ailleurs, au bureau et sur mobile.

## Ajout du 2026-09-29 : deux pages de plus

Demande de Julien : deux fonctionnalités tirées des derniers films de l'atelier (`~/engageme-motion`), même méthode
(en direct), mêmes décisions (film intégré plus son récit en HTML, « Demander une démo »).

- `/fonctionnalites/conversations-en-actions/` (short 4, « la brique manquante ») : la conversation analysée, la
  tâche qui en découle, le CRM rempli tout seul, et les logos de l'accueil. ⚠️ Salesforce et Pipedrive y figurent,
  comme sur l'accueil et dans le film : ce sont des intégrations en feuille de route, montrées parce que Julien l'a
  choisi (règle de l'atelier : « ce qui s'affiche est vrai du produit »).
- `/fonctionnalites/whatsapp-et-rcs/` (short 5) : « fallback » est dit **repli**, le mot de la console, comme
  « Fonctionnalités » a été préféré à « Features ». Le hero porte les deux téléphones en grand, et une version
  resserrée (`<picture>`) sur mobile.
- Le menu passe à quatre entrées, le pied de page aussi. Les écrans sont rendus par
  `~/engageme-motion/rendre-images.cjs`, dont les trois pièges sont écrits dans le `CLAUDE.md` de l'atelier.

## Ajout du 2026-09-30 : le formulaire de contact, et deux noms

Demande de Julien : le lien « Contact » du pied menait à la page contact de messagingme.fr ; il veut un formulaire
de la vitrine qui arrive chez lui, par le même chemin que le formulaire de support de la console. Et deux noms.

**Méthode : en direct, plus UNE relecture indépendante de la route.** La route est publique et c'est la seule pièce
de ce plan que la production emprunte (un envoi d'e-mail) ; le reste est de la page statique.

- `POST /vitrine/contact` (`src/http/contact-vitrine.ts`) : formulaire HTML natif (pas de `fetch`, donc pas de
  CORS), validation Zod, e-mail Resend à `SUPPORT_TO` comme le support, redirection 303 vers une adresse FIXE de la
  vitrine. Pot de miel (champ `site`), plafond global de dix envois par dix minutes. Tests :
  `tests/contact-vitrine.test.ts`, chacun vu en échec sur son défaut remis (pot de miel, plafond, portée du lecteur).
- `/contact/` et `/contact/merci/` (hors index) ; le lien « Contact » du pied y mène. Le brouillon survit à un
  retour en erreur (stockage de l'onglet), le bouton se désactive pendant l'envoi.
- **Ordre de déploiement : l'API d'abord**, la vitrine ensuite. Pousser la page avant la route la ferait poster
  vers un 404.
- Noms : « Conversations en actions » devient **« Analyse de conversations »** (sous-titre « Définition d’action
  dans votre CRM ») ; **« fallback »** remplace « repli » dans le texte de la page WhatsApp et RCS. Le libellé de la
  console, « WhatsApp et RCS, avec repli », reste cité tel quel à côté de sa capture. L'adresse
  `/fonctionnalites/conversations-en-actions/` ne change pas : elle circule depuis la veille.
- Page Publicités Click-to-WhatsApp : **deux messages, tous deux voulus par Julien** : la pub ouvre une conversation
  (pas une landing page), ET tout se pilote au même endroit (plus d'allers-retours entre le Business Manager de
  Meta et une plateforme conversationnelle). Le second est porté par un avant/après en HTML, juste après la une.
  Les boutons « Demander une démo » mènent au formulaire, message pré-rempli avec la fonctionnalité.
- Accueil : un bandeau « Ils nous font confiance » entre la une et la section claire, dans l'ordre donné par
  Julien (Odalys, Groupama, Gan, Mieux Assuré, Groupe EDH, NEOMA, DPD, Picoty). Logos en couleurs d'origine sur
  des tuiles blanches (choix de Julien), repris des projets clients du poste ; celui de Picoty, seul absent,
  téléchargé sur picoty.fr avec son accord. Dans `site/img/clients/`.

## Essai réel qui clôt

Julien parcourt les deux pages en production, sur ordinateur et sur son téléphone : il ouvre le menu, lance les
deux films, et clique « Demander une démo ». Pour le formulaire : il envoie un message depuis `/contact/` sur son
téléphone, le reçoit dans sa boîte, et sa réponse part à l'adresse saisie.
