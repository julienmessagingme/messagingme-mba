# Refonte de la documentation de l'API publique (forme, pas fond)

Demande de Julien du 2026-09-25 : la page `/developers/api` contient les bonnes informations mais se lit comme
un texte d'IA (une page de 5 000 mots, contrats en prose, majuscules d'emphase, règles répétées, détails
internes). Arbitré le même jour : **sept pages** plus un guide, et la refonte démarre tout de suite, avant l'essai
réel de l'API (`docs/PLAN-ESSAI-API-2026-09-25.md`), dont les écarts se corrigeront ensuite dans la nouvelle doc.

## Méthode de livraison

**Implémenteur par lot, puis relecture du lot**, en deux lots. C'est de la documentation publique sans aucun
changement de contrat, mais elle est gardée par des tests de parité (exemples validés par les vrais schémas,
codes, signaux, risque, adresse de l'API) qu'un découpage casse facilement : on lit le diff, on ne fait pas
confiance au vert seul. L'essai réel qui clôt chaque lot : Julien parcourt la doc publique et refait le premier
appel (détail en fin de plan).

## Pages (URL en anglais, libellés traduits)

| URL | Contenu |
|---|---|
| `/developers/api` | Accueil : une phrase, adresse de base, authentification en une phrase, un `curl` complet et sa réponse, liens vers les pages |
| `/developers/api/contacts` | Les cinq routes de contacts |
| `/developers/api/messages` | Messages simples (WhatsApp, RCS) et envois (`/v1/sends`, suivi), avec le tableau qui les distingue |
| `/developers/api/catalogs` | Templates, scénarios, messages RCS |
| `/developers/api/events` | Événements envoyés aux intégrations (`DocSignaux`) |
| `/developers/api/concepts` | Identification d'une fiche, consentement et STOP, fenêtre de 24 h, idempotence : chaque règle à UN endroit |
| `/developers/api/reference` | Authentification et droits, débit, erreurs (catalogue des codes) |
| `/developers/api/guides/per-contact` | Un outil qui appelle une fois par contact, en recette numérotée |

## Lot 1 : la structure

- Une mise en page commune aux pages : navigation latérale collante sur ordinateur, sélecteur sur mobile ; un seul
  `h1` par page ; `h2` par route ou concept ; méthode et chemin repérables d'un coup d'œil ; bouton Copier sur
  l'adresse, l'en-tête et chaque commande. Même cadre en public (`CadrePublic`) et dans la console.
- Le texte actuel est DÉPLACÉ dans sa page, pas réécrit ; seules les majuscules d'emphase deviennent des encadrés
  (Note, Attention, Obligatoire). La page MCP prend la même mise en page.
- Tests adaptés, jamais supprimés ni affaiblis : `tests/api-exemples.test.ts`, `tests/web-signaux-parite.test.ts`,
  `tests/web-risque-parite.test.ts`, `web/lib/api-base.test.ts` portent sur une LISTE FERMÉE des fichiers de la doc ;
  `web/e2e/developers-api.spec.ts` navigue entre les pages, en français et en anglais, en public, dans la console et
  sur mobile.

## Lot 2 : la réécriture

- Chaque route suit le même patron : droit, tableau des champs (type, obligatoire, contrainte), exemple, réponse,
  erreurs propres à la route, deux ou trois notes au plus.
- Les tableaux de champs sont décrits dans `web/lib/api-exemples.ts`, à côté des exemples, et un test de parité
  les compare aux schémas Zod du serveur (un champ ajouté au serveur sans la doc, ou l'inverse, casse le test).
- Allègement : une règle, un seul endroit ; les détails d'implémentation sans effet sur l'intégrateur sortent.

## Déploiement

Console seule (Vercel, au `git push`), aucune migration, aucune route neuve.

## L'essai réel qui clôt la refonte

Un œil humain : Julien parcourt la doc publique, en français et en anglais, sur ordinateur et sur mobile, et
refait le premier appel depuis la page d'accueil. Puis l'essai réel de l'API, qui la lit comme un intégrateur.
