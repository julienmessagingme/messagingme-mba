# Plan : Messaging Me dans le répertoire de Claude (2026-10-14)

Spec : [docs/superpowers/specs/2026-10-14-repertoire-claude-design.md](../specs/2026-10-14-repertoire-claude-design.md).

## Méthode de livraison

**Livraison A par un implémenteur, puis une relecture indépendante de son diff**, parce qu'elle change ce que lisent
les clients qui pilotent déjà leur espace depuis Claude Code (56 outils réécrits, dont des outils qui envoient des
messages et ouvrent des paiements) : une description fausse fait appeler le mauvais outil, en silence. Les livraisons
B, C et D se font **en direct** : des textes, des fichiers de plugin et un dossier, dont la vraie relecture est celle
de Julien (les pages légales ne partent qu'après sa validation). L'essai réel qui clôt le lot est en bas.

## Livraison A : les outils MCP en anglais, aux règles du répertoire

1. Titres, descriptions, descriptions des paramètres et instructions du serveur en anglais, dans `src/mcp/outils*.ts`
   et `src/mcp/serveur.ts`. Refus et valeurs rendues inchangés.
2. `destructiveHint: true` sur tout outil qui n'est pas en lecture ; les fabriques `lecture`/`ecriture` le portent.
3. Relecture anti-injection : une description dit ce que fait l'outil et quand l'appeler, jamais « dis à la
   personne », « commence par », ni une offre à promouvoir.
4. Tests attendus : un test DÉRIVÉ de la liste servie par `tools/list` exige pour chaque outil un `title`, et soit
   `readOnlyHint: true`, soit `destructiveHint: true` ; un test refuse le français dans les titres et descriptions
   (lettres accentuées et mots courants) ; les tests qui lisaient des phrases françaises (`tests/mcp-*.test.ts`) lisent
   les nouvelles, en gardant le cas qu'ils exerçaient. Auto-attaque lancée en local avant de pousser.
5. Rayon de souffle : les skills du plugin et la FAQ qui citent des outils (noms inchangés), la doc MCP de la console
   (`web/lib/mcp-outils.ts`, ses propres textes, inchangée), les espaces qui ont déjà le serveur (aucune
   réautorisation : seuls les textes changent).

## Livraison B : les pages légales (après validation de Julien)

1. Brouillons dans `docs/prive/` : politique de confidentialité et conditions d'utilisation de Messaging Me, éditeur
   SmartLink, FR et EN ; sources : `brain/MESSAGINGME.md` (conformité), les sous-traitants et durées réels lus dans le
   code et `documentation.md`. Julien les valide.
2. Puis les pages `site/confidentialite/`, `site/en/privacy/`, `site/conditions/`, `site/en/terms/`, avec `sitemap.xml`,
   JSON-LD et pied de page de toutes les pages pointant vers elles.

## Livraison C : le plugin 0.2.0

1. `plugin/LICENSE` (MIT), une icône PNG du logo, `plugin.json` : `displayName`, `license`, `icon`,
   `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`.
2. README : ce que le plugin envoie et récupère (le serveur `api.messagingme.app`, rien d'autre), les prérequis
   (compte Messaging Me, compte Meta), l'éditeur.
3. `npm run plugin:generer`, `claude plugin validate --strict plugin`, `tests/plugin.test.ts` étendu aux champs de
   fiche ; publication dans le dépôt public comme les versions précédentes.

## Livraison D : l'espace de démo et le dossier de soumission

1. Après le renouvellement Meta de « MessagingMeEmbdedded » : lecture seule de ses contacts (tous à nous), puis
   peuplement (agent IA avec connaissance, conversations, modèles approuvés, bulle, une adresse de webhook).
2. Julien crée le compte du relecteur (adresse et mot de passe à lui, jamais dans la conversation).
3. `docs/prive/` : les textes anglais des deux fiches (nom, accroche de 200 caractères, description de 2 000,
   catégories), les réponses « Data handling », les liens, les instructions pour les relecteurs.

## Ordre de déploiement

A (API, puis le plugin qui n'en dépend pas) ; B seulement après validation, la vitrine se publiant au push ; C après B
(ses liens doivent répondre) ; D ; puis Julien soumet le connecteur, ensuite le plugin.

## L'essai réel qui clôt

Julien soumet les deux fiches. Une fois publiées : depuis un compte claude.ai neuf, ajouter le connecteur, se
connecter, lire un espace et y envoyer un message (confirmation demandée) ; dans Claude Code, installer le plugin
depuis le répertoire et lancer la mise en service sur un espace de test.
