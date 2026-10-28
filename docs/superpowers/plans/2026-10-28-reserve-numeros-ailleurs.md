# La réserve de numéros fournis : un numéro utilisé ailleurs ne part jamais

**Demande de Julien (2026-10-28)** : « dans OPS le numéro 441555479304 est pris !!! c mon numéro whatsapp app business ».
Relevé en production, en lecture seule : ce numéro DIDWW est `libre` dans la réserve, alors que son application WhatsApp
Business l'utilise (relié par QR code à l'espace de test « newCompany » le 22, sans passer par l'attribution, donc
`fourni_id` nul). La réserve donne le plus ancien numéro libre : le deuxième client Pro qui demande un numéro l'aurait
reçu, Meta l'aurait vérifié sur notre central, et l'application de Julien aurait perdu le numéro. Décision : « Oui, pose
la garde : un numéro de la réserve relié ailleurs ne doit jamais être attribué, et /ops doit pouvoir retirer un numéro
de la réserve. »

## Ce qui change

1. **Un prédicat unique, « utilisé ailleurs »** (`src/otp/store.pg.ts`) : un numéro de la réserve est utilisé ailleurs
   si une ligne de `comptes_application` porte ce numéro (QUEL QUE SOIT son statut : un compte retiré chez nous laisse
   l'application en service sur le téléphone), ou si un numéro de `phone_numbers` a les mêmes chiffres (un numéro API
   d'un espace). Prudence assumée : un numéro écarté à tort coûte un abonnement DIDWW, un numéro donné à tort coupe
   l'application de quelqu'un.
2. **L'attribution l'applique** (`attribuerAvec`, donc `attribuer` et l'abonnement payé), **le compte des libres aussi**
   (`compterLibres` : l'alerte de réserve basse et le parcours du Pro ne promettent pas un numéro que l'attribution
   refuserait). Rien n'est écrit : la garde se DÉDUIT à chaque lecture, sans second écrivain ni balayage.
3. **`lister` dit pourquoi** : `ailleurs` (`application`, `api` ou `null`) pour un numéro libre ; la carte de `/ops` le
   montre et ne le compte plus parmi les libres.
4. **Sortir un numéro de la réserve depuis `/ops`** : `POST /ops/numeros-fournis/:id/sortir` (note obligatoire, ligne de
   journal signée de son auteur) passe un numéro `libre` et sans espace en `bloque`, le statut qui existe déjà pour un
   numéro actif ailleurs (exclu de l'attribution, codes toujours captés et affichés). Tout autre état : 409, rien
   d'écrit. Le libellé de `bloque` devient « hors réserve (actif ailleurs) » : il servait aussi au refus de Meta.

**Mes choix, faute de spec** : pas de bouton « remettre dans la réserve » (un retrait par erreur se répare par une
commande, et remettre un numéro actif ailleurs est justement le geste à éviter) ; pas de nouveau statut (pas de
migration). La console tolère une API sans la route (404 dit « pas encore sur cette version de l'API ») et sans le
champ `ailleurs`.

## Tests attendus

- Intégration (`tests/integration/numeros-fournis.integration.test.ts`, en CI) : un numéro libre relié par un compte
  d'application retiré, puis un numéro libre qui est le numéro API d'un espace : jamais attribués, pas comptés, signalés
  par `lister` ; `sortirDeLaReserve` : libre vers `bloque`, attribué ou inconnu : rien.
- Unitaire (`tests/ops-numeros.test.ts`) : la route exige la session d'exploitation, une note, un identifiant valide ; 409
  sans ligne ; le journal porte l'auteur ; `libres` du GET n'inclut pas un numéro utilisé ailleurs.
- Preuve en lecture seule sur la vraie réserve, avant le déploiement : l'ancienne requête d'attribution et la nouvelle,
  le compte des libres (2 avant, 1 après).
- e2e `/ops` : la carte montre le numéro utilisé ailleurs, et « Sortir de la réserve » envoie la note.

## Ordre de déploiement

Aucune migration. L'API d'abord (`deploy-scaleway.yml`, `migration=aucune`, accord de Julien) ; la console, publiée au
push, tolère l'API d'avant.

## Méthode de livraison

**Implémenteur par lot + relecture du diff**, parce que l'attribution est un chemin que la production emprunte (le
paiement du Pro y attribue le numéro dans sa transaction) et que la requête porte des invariants invisibles (`for update
skip locked`, l'index partiel d'un numéro par espace). Une relecture indépendante en fin de lot. **Essai réel** qui clôt :
après le déploiement, Julien ouvre `/ops`, onglet Réglages : `+44 1555 479304` y est signalé « application WhatsApp
Business » et « Numéros libres » vaut 1 ; puis il le sort avec le bouton (ou la commande du 2026-10-28), DANS TOUS LES
CAS : la garde déduite tomberait avec sa preuve (l'espace « newCompany » supprimé, relevé par la relecture).
