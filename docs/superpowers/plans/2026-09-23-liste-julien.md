# Liste de Julien du 2026-09-23 : plan de livraison

Demandes de Julien après l'essai réel des outils maison de l'agent de Meta, triées et arbitrées le même jour
(AskUserQuestion). Chaque lot est indépendant et se livre, se relit et se déploie seul, dans l'ordre ci-dessous.

## Méthode de livraison

**En direct, lot par lot, avec une relecture à froid d'un seul agent avant chaque déploiement de l'API.** Les lots
sont petits et indépendants ; plusieurs touchent des chemins que la production emprunte (appel de connecteur,
relances de campagne, passage de main de l'agent de Meta, envoi par l'API publique, grille de prix) : ceux-là
reçoivent une relecture du diff et des tests vérifiés par mutation. Aucun workflow multi-agents : la taille ne le
justifie pas. Les lots purement console (0, 1, 5 et 9) partent chez Vercel au `git push` ; aucun n'appelle de route
neuve avant que l'API qui la porte soit déployée (CLAUDE.md, § Déploiement).

Chaque lot se clôt par l'essai réel écrit dans sa section, fait par Julien sur l'espace d'essai : un test vert
ne suffit pas, parce que les tests d'écran sont écrits par celui qui a écrit l'écran.

## Lot 0, livré (bbfc60cf) : Inbox

- Pastille « fenêtre 24 h ouverte / fermée » retirée de l'en-tête ; le bandeau de la zone de saisie reste.
- Liste des conversations : jour et heure (`jourHeure`).
- Essai réel : ouvrir l'Inbox, voir « 22/09 17:42 » dans la liste et plus de pastille.

## Lot 1 : Connecteurs API, l'édition lisible et deux substitutions manquantes

- Constat (rapport d'enquête) : les libellés des lignes ne sont que des `placeholder` HTML (`Paires`,
  `OngletVariables` de `web/components/RequetesConnecteur.tsx`), donc invisibles dès qu'une valeur est chargée.
  → De vrais en-têtes de colonnes (Nom / Valeur ; Variable / Origine / Type / Valeur d'essai), toujours visibles.
- 🔴 La pastille de variable insère `{{nom}}` dans le CHEMIN, le serveur ne remplace que `{nom}`
  (`src/agent/http-cible.ts`) : les deux formes doivent être substituées.
- 🔴 Une variable dans un EN-TÊTE n'est jamais substituée (`src/agent/requete-http.ts`), et `variablesUtilisees`
  ignore les en-têtes : substitution et inventaire des variables étendus aux en-têtes.
- Essai réel : modifier une requête existante et reconnaître chaque champ ; un appel avec `{{x}}` dans le chemin et
  dans un en-tête, relu dans l'onglet Réponse de « Essayer ».

## Lot 2 : Escalade de l'agent de Meta

- Arbitrage de Julien : une conversation que l'agent de Meta passe à l'équipe arrive TOUT DE SUITE dans « À
  traiter », nous revient officiellement (plus de pastille « agent Meta »), et ne lui est rendue qu'après une
  réponse d'un opérateur suivie de 2 h de silence.
- Migration : `conversations.escaladee_le` (timestamptz nullable, sans défaut), posée au `control_passed` venant de
  l'agent de Meta, effacée à la première réponse humaine. Numéro : le premier libre APRÈS celui de la session
  publicités (0163 est pris par elle, non poussé) : lire `schema_migrations` et `db/migrations/` au moment d'écrire.
- « À traiter » : `last_direction is distinct from 'out' OR escaladee_le is not null`.
- Balayage de reprise (`src/inbox/control-sweep.ts`) : ne rend jamais une conversation dont `escaladee_le` est posé.
- Course relevée : un entrant `standby` traité APRÈS la passation réécrit `mba` sans condition
  (`accorderLeDetenteur`, `src/webhooks/inbound.ts`) : il ne doit pas écraser une escalade.
- Essai réel : faire escalader l'agent (« je veux parler à quelqu'un »), voir la conversation dans « À traiter »
  sans pastille, attendre, répondre en opérateur, puis vérifier la reprise après 2 h (réglage d'espace raccourci).

## Lot 3 : « Relancer automatiquement les échecs » quitte les Paramètres

- Constat : cette case (`tenant_settings.auto_retry_enabled`) est ce qui AUTORISE le balayage de relance des
  campagnes (`retry-sweep`, listes de `src/campaign/store.pg.ts`). La retirer seule couperait toute relance.
- Les campagnes ont déjà « Réessayer les envois qui échouent » (`campaigns.reessayer`, défaut vrai). Le balayage
  obéira à la case de la CAMPAGNE, puis la case d'espace disparaîtra de l'écran.
- Tranché par Julien : NOUVELLES CAMPAGNES SEULEMENT. Les campagnes existantes ont `reessayer = true` par défaut ;
  basculer la garde les ferait relancer alors que l'espace ne relançait pas.
- Mesuré en lecture seule avant d'écrire : un seul espace a une ligne de réglages, sans relance ; 5 campagnes sans
  repli ont `reessayer = true`, jamais relancées ; zéro échec 131049/131026 en attente. La case de la campagne
  était donc offerte et inerte.
- Migration 0165 : `campaigns.reessai_par_campagne` (`false` pour l'existant, `true` écrit par
  `insertCampaignRow`). Le balayage (`listAutoRetry`) lit la case de la campagne si le drapeau est posé, celle de
  l'espace sinon, en `left join` (une campagne neuve d'un espace sans réglages est listée). Avant le déploiement.
- La section des Paramètres, la route `PATCH settings/auto-retry` et son écriture en magasin disparaissent : un
  réglage sans écran ne doit plus pouvoir changer le sort des campagnes d'avant. La case de la campagne dit
  désormais ce qu'elle fait.
- Essai réel : une campagne avec la case cochée, un destinataire en échec 131049, relancé le lendemain matin.

## Lot 4 : Performance lab, coût par engagement

- Constat : n'apparaissent que les campagnes ayant un envoi de MODÈLE facturable dans la période ; une campagne à
  scénario envoyée à un numéro de test (`is_test`) en sort ; les archivées sont incluses sans le dire.
- Mesuré en lecture seule avant d'écrire : 7 campagnes, 2 visibles. Les 4 campagnes à scénario n'ont aucun envoi
  de modèle facturable, la campagne RCS non plus, et « nouveau test », archivée, était comptée sans le dire.
- Toutes les campagnes ayant envoyé dans la période apparaissent, à coût nul si rien de facturable, et une bascule
  « inclure les archivées » (défaut : exclues), appliquée AVANT le plafond de 50 (`getVolumeParCampagne`).
- La colonne « Envoyés » montre les personnes TOUCHÉES (`envois`), pas les seuls envois facturables : « 0 » se
  lirait « rien n'est parti » sur une campagne à scénario.
- 🔴 Une campagne RCS garde sa case COÛT VIDE : ce tableau ne connaît que les tarifs Meta, et « 0 » y serait faux.
  Une campagne WhatsApp sans rien de facturable, elle, a un coût CONNU (ses messages de service, souvent nul).
- L'accordéon s'ouvre désormais même sans ligne, sur une phrase et la bascule : fermé, la bascule serait
  inatteignable sur une période dont toutes les campagnes sont archivées.
- Essai réel : les six campagnes terminées de l'espace d'essai visibles, « nouveau test » seulement avec la bascule.

## Lot 5 : Performance lab, contacts cumulés ou actifs

- Arbitrage de Julien : actifs = contacts encore dans le mini-CRM (`deleted_at is null`).
- Historique reconstructible (la purge date la suppression, elle ne détruit pas la ligne) : actif le jour J = créé
  avant la fin de J et non supprimé à J. Bascule sur la carte « Contacts ».
- Essai réel : supprimer un contact d'essai, voir la courbe « actifs » baisser d'un et « cumulés » inchangée.

## Lot 6 : Mini-CRM, « Ouvrir la conversation »

- Route qui trouve OU CRÉE la conversation du contact (unique par espace et numéro, migration 0058), et l'Inbox
  qui sait afficher une conversation absente de la page chargée (lien `?c=`).
- Essai réel : depuis la fiche d'un contact sans conversation, ouvrir l'Inbox sur son fil vide.

## Lot 7 : API développeurs, envoyer un simple message

- Texte seul, dans la fenêtre de 24 h ; hors fenêtre, un refus explicite. Garde de désabonnement et de blocage,
  message enregistré dans l'Inbox, même clé d'API et même plafond que les autres routes `/v1`.
- Essai réel : un `curl` avec une clé d'API vers le numéro d'essai, fenêtre ouverte puis fermée.

## Lot 8 : « Vos prix » dans /ops, une grille pour tous

- Arbitrage de Julien : une seule grille, dans /ops, pour tous les espaces ; l'écran des Paramètres disparaît.
- Migration de la grille globale ; lecture des coûts depuis elle ; reprise de la valeur actuelle.
- Essai réel : changer un prix dans /ops, le voir dans le coût par engagement de deux espaces.

## Lot 9 : HubSpot

- Arbitrage de Julien : sans HubSpot connecté (portail lié), les fonctions HubSpot sont MASQUÉES : import de listes en
  campagne, déclencheur « étape de deal », mention « injoignable dans HubSpot », et la future action du bloc. La
  carte de connexion de l'Accueil reste, sinon plus personne ne pourrait connecter HubSpot.
- Action « mettre à jour un champ HubSpot » (valeur + nom interne de la propriété) dans le bloc action : demande une
  route générique d'écriture de propriété dans `mm-hubspot` (dépôt voisin, seul détenteur du jeton HubSpot).
- Essai réel : un espace sans HubSpot ne voit aucune de ces fonctions ; un espace connecté pose une propriété.
