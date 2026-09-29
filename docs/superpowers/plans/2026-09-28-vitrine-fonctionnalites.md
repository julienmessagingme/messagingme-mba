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

## Essai réel qui clôt

Julien parcourt les deux pages en production, sur ordinateur et sur son téléphone : il ouvre le menu, lance les
deux films, et clique « Demander une démo ».
