# L'arbre du numéro sans QR code, et le numéro fourni relié en gardant l'application : plan

> **Pour un agent** : un implémenteur, puis UNE relecture indépendante du diff. Les étapes se cochent (`- [ ]`).

**Les décisions de Julien (2026-10-26)** : « on va pas laisser le choix de faire du numéro QR code... le choix s'il a pas
de BM et pas de numéro, c'est d'utiliser whatsapp business app et de passer en COEX pour en même temps embarquer la
création d'un business portfolio [...] et s'il a whatsapp business app et qu'il veut utiliser un autre numéro, on doit
l'onboarder sur un numéro API ». Puis, à ses questions : **plus de QR code nulle part** (la vitrine, la console, Claude) ;
sans compte Meta Business et sans numéro, l'application WhatsApp Business **sur sa propre carte SIM ou sur un numéro
fourni**, au choix, puis reliée à l'API en la gardant ; un autre numéro que celui de l'application = un numéro API, **la
fenêtre de Meta crée le compte Meta Business** en chemin.

**L'arbre qui en sort** :
1. Il a l'application WhatsApp Business et garde ce numéro : on le relie à l'API en gardant l'application (`coexistence`).
2. Il a l'application et veut un autre numéro, ou il a un compte Meta Business sans l'application : un numéro API, le
   sien s'il est libre (`apporte`) ou un numéro fourni (`fourni`).
3. Ni compte ni numéro : l'application WhatsApp Business sur sa carte SIM (puis le cas 1), ou sur un numéro fourni
   (NOUVEAU : `fourni_application`), puis reliée en la gardant.

**Aujourd'hui** (relevé dans le code le 2026-10-26) : aucun espace n'a de compte QR code vivant (le seul, newCompany, est
`retire` depuis l'essai 161). La console ne propose le QR code que par un lien dont le jeton porte `filiere:
application` (`web/lib/lien-numero.ts`, `/brancher`, `ParcoursNumero.tsx`, `QrApplication.tsx`) ; Claude l'ouvre par
`start_whatsapp_connection` avec `filiere: application` (`src/mcp/outils-numero.ts`) ; la route
`POST /tenants/:tenantId/application/relier` (`src/http/numero-fourni.ts`) crée un compte sans regarder la filière du
jeton ; les textes du plugin dictent le choix. Le chemin « application sur un numéro fourni » existe déjà en filière
application, mode `fourni` (le pont des codes donne le code de l'application, prouvé sur le +44 1555 479304), mais il
finit toujours par le QR code. La voie `coexistence` ne refuse pas un numéro fourni, mais la page n'y attribue ni ne
montre le numéro et son code.

## Méthode de livraison

**Implémenteur, une relecture indépendante du diff, puis déploiement**, parce que la connexion du numéro est la porte
d'entrée de tout client : une branche mal tenue laisserait un nouveau client sans aucun chemin, ou rendrait à la réserve
un numéro fourni qui porte déjà son compte WhatsApp Business. Les pages se vérifient à l'écran, pas seulement par des
tests. **Essais réels qui closent** : (a) un numéro fourni installé le jour même dans l'application WhatsApp Business,
son code lu chez nous, puis relié en gardant l'application (il répond aussi au doute de Julien sur le délai, essai 164) ;
(b) un numéro API dont la fenêtre de Meta crée le compte Meta Business en chemin.

## Ce qui change

1. **Plus de QR code pour un nouvel espace** : `start_whatsapp_connection` n'annonce plus `filiere` et refuse
   `application` à un espace sans compte d'application existant, avec la phrase qui mène au cas 3 ;
   `POST .../application/relier` refuse de CRÉER un compte (« aucun compte d'application existant » : un compte en
   `sommeil` se rouvre encore, `ROUVRABLES`) ; aucun lien `filiere: application` ne s'émet plus pour un nouvel espace.
   Le code de la filière reste en sommeil (retrait plus tard, à part).
2. **Le mode `fourni_application`** (jeton du lien, `lireLien`, `start_whatsapp_connection`) : obtenir ou payer le numéro
   fourni comme en `fourni` ; puis les étapes « installez l'application WhatsApp Business et créez le compte avec ce
   numéro » (`ETAPES_COMPTE_FOURNI`), le code de l'application lu par le pont des codes (sur la page, et dans `code` de
   `watch_whatsapp_connection`, AVEC sa consigne : aujourd'hui `suiteDe` rend `COEXISTENCE_EN_COURS` avant tout) ; puis la
   fenêtre de Meta en coexistence (`connexion.connect({ coexistence: true })`), sans QR code. La fin est celle de la
   coexistence (`coexistence: true`).
3. **« Abandonner » garde le numéro** sur ce chemin : `numeroFourniAGarder` (`src/application/connexion.ts`) ne le
   rend pas à la réserve tant que le mode est `fourni_application` ou qu'une coexistence est en cours.
4. **Les textes du produit** : les consignes de Claude (`outils-numero.ts`), les phrases de refus, `features.md`,
   `documentation.md`. Sans le mot « coexistence » face au client : « garder mon application WhatsApp Business ». Les
   pages de la vitrine, les skills et la FAQ du plugin, le README et les fiches d'aide sont à la session Vitrine, après le
   déploiement de ce lot (annoncé).

## Tests attendus

- Un espace neuf : `filiere: application` refusé par Claude et par la route ; un compte d'application en `sommeil` se
  rouvre encore.
- `fourni_application` : le numéro s'obtient (Pro) ou se paie (Free) ; le code arrive dans `watch_whatsapp_connection`
  avec sa consigne ; la fin attend `coexistence: true`.
- « Abandonner » pendant ce chemin ne rend pas le numéro à la réserve.
- La page du lien : la branche montre le numéro, puis le code, puis la fenêtre en coexistence, sans QR code (rendu
  serveur, comme `web/lib/fenetre-meta.test.ts`).
- Chaque garde vérifiée dans les deux sens.

## Déploiement

L'API puis la console (la page appelle des routes qui existent déjà ; si une route change, l'API part AVANT le push de
la console), garde de révision ; la session Vitrine ensuite. ⚠️ La bascule vers Scaleway est visée le mardi 2026-10-27
au soir : aucun déploiement pendant la coupure.
