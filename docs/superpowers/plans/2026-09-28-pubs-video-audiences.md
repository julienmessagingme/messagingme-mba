# Publicités Click-to-WhatsApp : vidéo et audiences (2026-09-28)

Demande de Julien du 2026-09-28 : pouvoir créer une publicité avec une VIDÉO (le formulaire n'accepte qu'une
image), et choisir QUI on vise avec les audiences préparées du compte publicitaire, au lieu de s'en remettre au seul
ciblage pays et âge.

Recherche faite le même jour sur la documentation de Meta (Graph v25, la version du dépôt) ; ce qui n'y est pas
documenté est dit comme tel ci-dessous et se vérifie à la première création réelle.

## Décisions de Julien (2026-09-28)

1. **Vidéo : 100 Mo et 60 secondes au plus**, MP4 ou MOV.
2. **Cadrage libre**, conseillé à l'écran : vertical 9:16 (stories, Reels, statut WhatsApp) ou 4:5 (fil). Meta place
   la publicité lui-même (aucun placement n'est posé aujourd'hui).
3. **Audiences : celles qui existent déjà dans le compte publicitaire, à inclure et à EXCLURE.** Créer une audience
   depuis les contacts Engage Me est un lot suivant (base légale RGPD à trancher, conditions de Meta à accepter à la
   main, jusqu'à 24 h de traitement).
4. **Advantage+ audience laissé à Meta.** Les audiences incluses deviennent des suggestions ; les EXCLUSIONS, le
   lieu et l'âge minimum restent des contrôles fermes. L'écran le dit en une phrase, et il dit aussi qu'avec
   Advantage+ Meta borne l'âge (minimum entre 18 et 25 ans, maximum fixé à 65).

## Ce qui en découle (sans nouvelle question)

- **La vignette est automatique** : une des vignettes que Meta extrait de la vidéo, redéposée comme image pour
  obtenir son empreinte (on ne cite jamais une adresse du CDN de Meta).
- **Le brouillon ne garde jamais les octets d'une vidéo** : elle est déposée chez Meta dès qu'elle est choisie
  (rien n'est facturable), et le brouillon garde son identifiant. Le visuel image garde son fonctionnement actuel.
- **Le dépôt passe par morceaux**, du navigateur à notre API puis à Meta (`/act_{id}/advideos`, `upload_phase`
  start, transfer, finish), jamais en base64 dans un corps JSON ni en entier en mémoire. Le traitement de Meta est
  asynchrone : la création attend l'état `ready`, bornée, et l'écran montre l'attente.
- **Défaut existant corrigé au passage** : le ciblage envoie l'âge sans préciser `targeting_automation`. Depuis v23,
  Meta active alors Advantage+ en silence, ou refuse la création si l'âge n'est pas au défaut. Le réglage devient
  toujours explicite. Aucune publicité ni aucun brouillon n'existe encore en production (mesuré le 2026-09-28).
- La créa vidéo passe par `video_data` au lieu de `link_data`. Le lien `wa.me` n'y a pas de champ `link` : il irait
  dans `call_to_action.value`, ce que Meta ne documente pas pour Click-to-WhatsApp. C'est le point que l'essai réel
  tranche.

## Méthode de livraison

**Implémenteur, puis UNE relecture**, parce que le chemin crée des objets chez Meta sur le compte publicitaire du
client (une erreur de ciblage ou de créa dépense son argent sur la mauvaise audience) et qu'une partie du contrat de
Meta n'est pas documentée : les tests unitaires ne peuvent vérifier que ce qu'on croit savoir. Tout reste créé EN
PAUSE, comme aujourd'hui.

**Essai réel qui clôt la feature** : sur le compte publicitaire de Julien, créer (en pause) une publicité VIDÉO avec
une audience incluse et une exclue, puis vérifier dans le Gestionnaire de Meta que la créa porte la vidéo et le
bouton WhatsApp, que l'ensemble porte l'inclusion, l'exclusion et Advantage+ ; supprimer ensuite la campagne d'essai.

**Ordre de déploiement** : la migration du brouillon (identifiant de vidéo, audiences) AVANT le `up` ; l'API avant
la console, qui appelle des routes neuves (dépôt de la vidéo, liste des audiences).
