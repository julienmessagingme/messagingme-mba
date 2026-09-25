# Console : retirer ce qui fait « interface générée par IA »

Demande de Julien du 2026-09-25, grille du « taste skill » (règles lues, rien d'installé). Audit du même jour :
185 fichiers mesurés, 40 captures (`scratchpad/audit-taste/`, non versionné).

Décisions : police **Geist** ; **« vous »** partout ; icônes **Phosphor** (plus d'emojis ni de SVG faits main) ;
libellés de navigation anglais **gardés** ; cadres détaillés de l'Accueil **gardés**.

## Méthode de livraison

**Implémenteur par passe, relecture par passe, puis captures relues par Julien**, parce que chaque passe touche
près d'une centaine de fichiers de console sans changer une route : les tests d'interface existants tiennent le
comportement, mais seul un œil juge le rendu. L'essai réel qui clôt chaque passe : Julien parcourt les écrans
principaux en production (Accueil, Inbox, Contacts, Campagnes, Scénarios, Paramètres), sur ordinateur et sur
mobile.

## Passes

1. **Fondations** : Geist et Geist Mono par `next/font` ; échelle de titres et de textes (un composant de titre de
   page, tailles du thème au lieu des tailles arbitraires, `tabular-nums` sur les chiffres) ; plus de majuscules
   espacées comme structure (barre du haut, en-têtes de tableau, sur-titres) ; une teinte par état (danger,
   alerte, succès) à la place des familles Tailwind par défaut, trois niveaux de gris pour le texte, un fond de
   page ; anneau `focus-visible` global, retour `active`, `transition-colors duration-150` ; un composant `Bouton`
   (3 variantes, 2 tailles) branché sur les boutons existants.
2. **Formes et composants** : trois rayons ; filets et espacements au lieu de cartes dans des cartes ; moins de
   pilules et de pastilles décoratives ; deux largeurs de contenu ; `/compte` dans la coquille ; Phosphor à la
   place des emojis et des SVG ; confirmations dans la ligne au lieu de `window.confirm` ; une seule modale ;
   squelettes de chargement ; écrans vides et erreurs courts ; débordements mobiles (Inbox, Consentement, bouton
   d'aide qui cache « Envoyer »).
3. **Texte à l'écran** : « vous » partout ; phrases d'explication sous les titres retirées ou réduites à une ligne
   utile ; plus de majuscules d'insistance ; statuts Meta traduits ; dates par `formatDate` ; typographie (’ et …).

## Déploiement

Console seule, au `git push` (Vercel), une passe après l'autre ; aucune migration, aucune route neuve.
