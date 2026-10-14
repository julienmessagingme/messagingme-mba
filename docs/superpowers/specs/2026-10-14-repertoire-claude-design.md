# Messaging Me dans le répertoire de Claude (2026-10-14)

## Le besoin

Aujourd'hui, le plugin Claude Code s'installe depuis notre propre place de marché (`messagingme@messagingme`, dépôt
public `julienmessagingme/messagingme-plugin`, généré depuis `plugin/` par `npm run plugin:generer`). Julien veut qu'on
le trouve dans la bibliothèque de Claude.

## Ce qu'exige Anthropic (documentation officielle lue le 2026-10-14)

- **La bibliothèque officielle (`claude-plugins-official`, onglet Découvrir de `/plugin`) n'a pas de candidature
  publique** : « doesn't take submissions through the directory portal », seulement par un contact partenaire.
- **La voie publique est le répertoire** (claude.ai/directory), soumis depuis https://claude.ai/directory/manage par un
  compte claude.ai Pro, Max, Team ou Enterprise (Owner en Team). Anthropic demande DEUX fiches quand un plugin pointe
  vers un serveur MCP distant : le serveur comme **connecteur** (« submit the server anyway »), le plugin comme
  **plugin bundle**. Revue automatique puis humaine, délai non annoncé ; contacts directory@anthropic.com et
  mcp-review@anthropic.com.
- **Le connecteur** : chaque outil porte un `title` et `readOnlyHint: true` (lecture) ou `destructiveHint: true` (il
  modifie des données) ; descriptions exactes, qui disent ce que fait l'outil sans dire à Claude comment se comporter ;
  erreurs explicites ; aucune transaction financière exécutée ; OAuth conforme ; une **politique de confidentialité
  complète** (sinon refus immédiat) ; une doc publique ; des **identifiants de test d'un compte entièrement peuplé**,
  sur lequel les relecteurs exécutent les outils.
- **Le plugin** : `plugin.json` valide (`claude plugin validate --strict`), un README d'au moins 40 mots qui décrit ce
  que le plugin exécute, envoie ou récupère, une **licence** (bloquant), et les champs de fiche `icon`,
  `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`. Le nom est définitif.
- **Marques** : rien qui présente le plugin comme officiel ou partenaire d'Anthropic.

## Ce qui est déjà conforme (vérifié le 2026-10-14)

- L'OAuth : 401 avec `resource_metadata`, ressource exacte, PKCE S256, enregistrement dynamique, client public, et
  l'adresse de retour de claude.ai déjà épinglée (`src/oauth/clients.ts`).
- Chaque outil a un titre (fabriques `lecture` et `ecriture`).
- `buy_credit` et `manage_number_subscription` ouvrent une page Stripe et rendent son lien : le paiement reste un geste
  de la personne, aucune transaction n'est exécutée à sa place.
- La doc publique : la page développeurs de la vitrine et la doc MCP de la console.

## Décisions de Julien (grill du 2026-10-14)

- **Connecteur + plugin**, par le répertoire public ; pas de contact partenaire, notre place de marché reste en
  parallèle (une session sans compte claude.ai ne reçoit pas les plugins du répertoire).
- **Compte de test** : l'espace réel « Messaging Me Tech SANDBOX » et son numéro (WABA de notre portefeuille, sur le
  jeton global d'utilisateur système, qui n'expire jamais : rien à renouveler, mesuré le 2026-10-14), peuplé, et dont tous les contacts sont nos propres téléphones : un relecteur qui envoie n'écrit qu'à nous.
- **Pages légales** : Claude rédige une politique de confidentialité et des conditions d'utilisation propres au
  produit, en français et en anglais sur la vitrine ; Julien les valide AVANT leur mise en ligne. L'éditeur est
  **Messaging Me SAS** (RCS Paris 948 692 231), « SmartLink » restant le nom de marque sur les fiches ; le
  correspondant pour les données est Julien (julien@messagingme.fr) ; l'accord de traitement de l'article 28 du RGPD
  est une annexe des conditions, pas un document à part ; la responsabilité et la résiliation sont rédigées par
  Claude. **Elles décrivent l'hébergement d'après la bascule chez Scaleway et se mettent en ligne avec elle** (Julien :
  « le temps de tout envoyer, on sera sur Scaleway »).
- **Fiches en anglais.** **Titres et descriptions des 56 outils MCP en anglais.**

## Ce qui change

1. **Les outils MCP parlent anglais** : titre, description, descriptions des paramètres et instructions du serveur.
   Les messages de refus et les valeurs rendues restent en français (Claude les relaie dans la langue de la personne),
   tout comme les skills du plugin.
2. **Les annotations suivent la règle du répertoire** : `destructiveHint: true` sur TOUT outil qui écrit (dans
   claude.ai, chaque écriture demandera une confirmation, c'est l'effet voulu par Anthropic), et les descriptions qui
   donnent des consignes de comportement sont réécrites en constat.
3. **Le plugin 0.2.0** : licence MIT, icône, champs de fiche, README qui dit ce que le plugin envoie et récupère.
4. **Les pages légales** sur la vitrine, puis les liens de pied de page vers elles.
5. **L'espace de démo** peuplé, et un compte de relecteur créé par Julien.
6. **Le dossier de soumission** (textes des deux fiches, réponses « Data handling », liens) dans `docs/prive/`, que
   Julien recopie dans le portail.

## Hors périmètre

La bibliothèque officielle (`claude-plugins-official`), faute de voie publique ; une candidature au label « Verified »
(Anthropic l'attribue seul) ; le renommage du plugin (`messagingme` reste le nom).
