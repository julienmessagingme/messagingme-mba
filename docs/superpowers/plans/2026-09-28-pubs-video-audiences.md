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

## Retouches du 2026-09-28

Demandées par Julien après son premier essai, plus les jaunes de la relecture du lot.

1. **Retirer ou changer le visuel.** Une vidéo déposée ne se retirait plus. Image et vidéo portent désormais le même
   geste : « Changer » (rouvre le choix de fichier) et « Retirer » (retour à « aucun visuel », et le brouillon
   enregistre `video: null` ou `image: null`). Un dépôt en cours s'annule (le morceau en vol est coupé). La vidéo déjà
   déposée reste dans la bibliothèque du compte chez Meta, où elle ne coûte rien. Un fichier refusé au « Changer » ne
   défait plus la vidéo en place.
2. **Choisir le bouton.** Une liste FERMÉE de dix types (`BOUTONS_PUB`, `src/meta/pubs-payloads.ts`), défaut
   `WHATSAPP_MESSAGE`. Seul `call_to_action.type` change. ⚠️ Seul le bouton WhatsApp est documenté côté API pour
   Click-to-WhatsApp : les neuf autres viennent du Gestionnaire, c'est une hypothèse écrite à cet endroit, que l'essai
   réel tranche. Le brouillon garde le choix : **migration 0188** (`pubs_brouillons.bouton`, défaut
   `WHATSAPP_MESSAGE`, sans CHECK). La console n'envoie la clé que si elle diffère du défaut (création) ou de ce que le
   serveur détient (brouillon), pour qu'une API d'avant ce lot reste utilisable au bouton par défaut.
3. **Les jaunes.** L'hôte du dépôt vidéo isolé dans `HOTE_DEPOT_VIDEO` : la documentation de la Video API dit
   `graph-video.facebook.com` DÉPRÉCIÉ, le SDK officiel l'emploie encore ; on suit la documentation
   (`graph.facebook.com`), l'essai réel tranche. Les audiences se vérifient à la création sur l'arête du compte
   (`/act_{id}/customaudiences`, possédées ET partagées, page par page jusqu'à 500) : ce qui n'y figure pas est
   refusé. ⚠️ Pas sur `account_id`, qui désigne le PROPRIÉTAIRE et refusait donc les audiences partagées (rouge de la
   relecture, corrigé). Le compte d'une vidéo n'est pas vérifié (le nœud `Video` n'expose aucun compte publicitaire).
   Un refus de Meta porte `error_user_title` et `error_user_msg` dans son message, et son sous-code au journal. La CSP gagne
   `media-src 'self' blob:`. La durée se lit dans `mvhd`, au début OU à la fin du fichier, le décodeur n'étant plus
   qu'un repli (un MOV HEVC d'iPhone était refusé sous Chrome Windows). La vignette se rapatrie sous 30 s, et l'erreur
   d'abandon d'un appel Graph dit le vrai délai. Les routes journalisent par `journaliser`, et un 502 ne porte plus de
   message interne. **Un refus de Meta à la création sort en 422 avec son message** (Cloudflare remplace le corps d'un
   5xx) : c'est ce qui rend l'essai réel lisible. Une panne reste en 502, opaque, cause au journal.

**Méthode** : implémenteur puis une relecture, comme le lot. **Essai réel qui clôt ces retouches** : le même que le
lot, avec un bouton autre que WhatsApp (par exemple « Obtenir un devis ») sur une créa vidéo ; et, depuis l'écran,
retirer puis changer une vidéo déposée. **Ordre de déploiement** : 0188 AVANT le `up` de l'API ; la console après
l'API (sinon, pendant la fenêtre, un bouton autre que WhatsApp rend 400 ; le défaut passe).
