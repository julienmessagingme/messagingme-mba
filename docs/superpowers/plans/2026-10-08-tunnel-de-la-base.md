# Lot 19 : le tunnel de la Base, plan

Cadrage : la ligne du lot 19 du plan privé (`docs/prive/2026-10-02-engageme-claude-code.md`) et trois décisions de Julien
du 2026-10-08 : le numéro se saute (« Plus tard »), Claude Code se branche par OAuth (une commande sans clé), et la clé
d'API de l'application se crée sur la page finale. Plan court : tâches, interfaces, tests attendus, ordre de déploiement.

**Objectif** : un espace qui vient de naître enchaîne, sans passer par l'accueil, l'inscription, son numéro WhatsApp (le
sien, ou un numéro fourni), puis une page finale qui donne tout pour vivre dans Claude Code : la commande qui branche le
serveur MCP, la clé d'API de son application, et un prompt à coller. Les briques existent ; il manque l'enchaînement.

## Méthode de livraison

**En direct**, puis une relecture du diff : la console seule (trois écrans, une page neuve), réversible, aucun chemin
que la production emprunte pour un envoi, un webhook ou un montant, et aucune route ni migration neuve. Les critères
se vérifient par des tests de la console et des e2e ; l'essai réel est une inscription de bout en bout.

## Tâches

1. **La page finale `/demarrer`** (`web/app/demarrer/page.tsx`, la logique pure dans `web/lib/demarrer.ts`) :
   - le numéro : connecté (le numéro affiché), ou « Connecter mon numéro » (vers `/connecter-whatsapp?suite=demarrer`) et
     « Plus tard » (Claude saura le brancher) ;
   - Claude Code : la commande `claude mcp add --transport http messagingme <API>/mcp`, SANS clé (la connexion OAuth
     s'ouvre au premier usage), l'adresse dérivée de l'API (`BASE`), jamais du domaine de la console ;
   - la clé de l'application : « Créer la clé de mon application » (`createApiKey`, droits par défaut
     `API_SCOPES_PAR_DEFAUT`), montrée une seule fois, à ranger dans `MESSAGINGME_API_KEY` ;
   - le prompt à coller : il nomme le serveur MCP, la variable de la clé (jamais dans le code), la documentation de
     l'API, et propose de brancher le numéro s'il ne l'est pas.
   - Tests : `web/lib/demarrer.test.ts` (la commande sans clé ni en-tête, l'adresse de l'API, le prompt selon le numéro).
2. **L'enchaînement** :
   - l'inscription (et celle par Google, `GoogleButton`) mène à `/connecter-whatsapp?suite=demarrer` au lieu de
     l'accueil : le numéro d'abord, comme le dit l'objectif (décidé à l'exécution : la première version de ce plan
     envoyait l'inscription droit sur `/demarrer`, ce qui sautait l'étape du numéro) ;
   - `/connecter-whatsapp?suite=demarrer` montre « Plus tard » et, une fois connecté, « Continuer » vers `/demarrer`.
     La suite se garde dans la mémoire de l'onglet (`sessionStorage`), parce que le retour de Stripe après le paiement
     d'un numéro fourni arrive sans elle ; la page finale l'efface.
   - Tests e2e : l'inscription arrive sur la page du numéro (`second-facteur.spec.ts`) ; la page finale (commande sans clé,
     clé créée et montrée une fois, « Plus tard » quand aucun numéro n'est connecté) ; la suite depuis la connexion du
     numéro.
3. **Docs** : `features.md` (l'arrivée d'un nouvel espace), le journal, `wip.md`.

## Hors de ce lot

La porte du site (le bouton de la vitrine vers l'inscription) ne s'ouvre qu'après le lot 14.

## Ordre de déploiement

La console seule : publiée par Vercel au push, aucune route neuve, donc aucune fenêtre avec l'API. L'ancienne console
(`mba-web`) suit au déploiement suivant.

## L'essai réel qui clôt

Une inscription de bout en bout sur la console : le second facteur, la page du numéro (« Plus tard »), la page finale ;
la commande collée dans Claude Code ouvre la connexion OAuth ; la clé créée ; le prompt collé.
