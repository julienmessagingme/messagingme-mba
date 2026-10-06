# Le numéro fourni, côté client (lot 3b de « Engage Me pour Claude Code »)

Spec validée par Julien le 2026-10-05, **réécrite le 2026-10-06 pour le repli** qu'il a décidé après la mesure de
la fenêtre Meta (§ 2). Elle s'appuie sur le lot 3a, en production
(`docs/superpowers/specs/2026-10-05-pont-du-code-design.md`) : la réserve de numéros DIDWW (`numeros_fournis`), le pont
qui lit le code que Meta dicte (`codes_verification`), l'Asterisk et la carte /ops.

## 1. Ce que veut Julien

- **Numéro fourni** : la page attribue un numéro de notre réserve et l'affiche ; le client le tape dans la fenêtre Meta
  et choisit la vérification par appel ; notre Asterisk capte le code ; la page l'affiche ; le client le recopie.
- **Numéro apporté** : la séquence actuelle, inchangée. Le client tape son numéro dans la fenêtre et reçoit son code.
- **Libre-service dès le 3b**, gratuit jusqu'au paiement du 3c. La seule borne est la taille de la réserve.
- **Alerte** : Telegram dès qu'il reste moins de 3 numéros libres, au plus une fois par jour.
- **Crédit offert** : 1 € pour un espace créé depuis Claude Code, 5 € pour un espace créé dans la console.
  « Par Claude Code, si le mec fournit son numéro cela coûte zéro, donc on ne va pas lui filer 5 € à chaque fois. »

Supposés, validés avec le design : le 1 € vaut pour tout espace né depuis Claude Code, numéro fourni ou apporté ;
l'origine d'un espace est fixée à sa création ; un seul numéro fourni par espace.

Hors périmètre (3c) : l'abonnement Stripe, la résiliation chez DIDWW, l'outil d'attente de Claude Code.

## 2. Ce que Meta permet, mesuré le 2026-10-06

- **Rien ne fait sauter l'écran du numéro en Embedded Signup v4.** `only_waba_sharing` n'existe qu'en v2, que Meta
  coupe le 15 octobre 2026 (la v3 l'a retiré le 29 mai 2025) ; la seule option de `FB.login` documentée en v4 est
  `extras.setup`. Julien l'a vu sur la fenêtre de production : l'écran du numéro vient en premier, avec « Enter a new
  phone number », ses numéros existants, et « Use a display name with a virtual number instead ».
- **Le « sans numéro » de Meta est un numéro virtuel en +1 555**, avec une revue du nom de l'entreprise et du nom
  affiché qui peut durer 5 jours ouvrés : inutilisable pour une mise en route immédiate.
- **La pré-vérification** (proposer notre numéro déjà vérifié dans la fenêtre) est réservée par Meta aux Solution
  Partners agréés. Piste écartée par Julien le 2026-10-06.
- D'où le repli, la première conception de cette spec (le serveur ajoute le numéro au compte d'un client revenu sans
  numéro) étant impossible. La livraison A, déjà en production, reste : elle garde un compte revenu sans numéro au
  lieu de le refuser, sans effet sur le parcours avec numéro.
- **Limite de Meta** : un portefeuille non vérifié porte deux numéros au plus ; elle porte sur le portefeuille du
  CLIENT, et la fenêtre de Meta affiche alors son propre refus.

## 3. Le parcours

La page **« Connecter WhatsApp »** (`/connecter-whatsapp` dans la console, liée depuis l'Accueil d'un espace sans
numéro, et l'adresse que le 3c donnera à Claude Code) propose deux choix.

**« Fournissez-moi un numéro »**
1. « Obtenir mon numéro » : le serveur attribue un numéro libre de la réserve à l'espace (ou rend celui déjà attribué),
   et la page l'affiche en grand, avec un bouton « Copier ». Réserve vide : on le dit, et l'alerte part.
2. Trois consignes : ouvrir la fenêtre Meta ; à l'écran du numéro, « Enter a new phone number », taper le numéro, et
   choisir la vérification par appel ; recopier le code que la page affiche.
3. Pendant que la fenêtre est ouverte, la page interroge le serveur toutes les 3 secondes et affiche le code dès que
   l'Asterisk l'a capté.
4. La fenêtre se termine par la suite actuelle (`/embedded-signup/complete`, qui relie et active le numéro) ; le
   crédit offert part selon l'origine de l'espace ; la page affiche « numéro connecté ».
5. Si Meta refuse ce numéro (déjà actif ailleurs, cas d'un numéro DIDWW recyclé) : « En obtenir un autre » le sort de
   la réserve, en attribue un autre, et prévient Julien. « Abandonner » le rend à la réserve.

**« J'ai déjà un numéro »** : la fenêtre Meta actuelle et la suite actuelle. Seul le montant du crédit offert dépend
désormais de l'origine.

## 4. Le serveur

- **L'attribution** est atomique : une instruction prend une ligne `libre` (`for update skip locked`) et pose ensemble
  `attribue`, l'espace et l'heure, sans quoi `numeros_fournis_espace_chk` refuse. Rejouée, elle rend le numéro déjà
  attribué ; l'unicité « un numéro attribué par espace » (index unique partiel) tient deux demandes simultanées.
- **Le code d'un espace** : le dernier code certain capté sur SON numéro attribué, reçu après l'attribution et dans les
  15 dernières minutes. Jamais celui d'un autre espace ; jamais la transcription.
- **Les routes** (module de classe `tenant`, `espaceVerifie`, admin) : `POST /tenants/:tenantId/numero-fourni`
  (attribuer ; 409 si l'espace a déjà un numéro WhatsApp, ou si la réserve est vide), `GET` (le numéro et le code),
  `POST .../remplacer` (le numéro refusé passe en `bloque`, un autre est attribué, Julien est prévenu), `POST
  .../abandonner` (rendu à la réserve ; refusé une fois le numéro connecté). Le `GET` est interrogé en boucle : hors
  plafond coûteux.
- **L'alerte de réserve basse** : après chaque attribution et sur réserve vide, compter les numéros libres ; sous le
  seuil (`ALERTE_RESERVE_SEUIL`, 3 par défaut), un message Telegram sous un verrou court de 24 heures.
- **Le crédit offert par origine** : un marqueur d'origine posé à la création de l'espace (`claude_code` quand
  l'espace naît par la connexion OAuth de Claude Code, `console` sinon), et une seconde variable
  (`CREDIT_OFFERT_CLAUDE_CODE_MICRO_EUR`, 1 € par défaut) à côté de `CREDIT_OFFERT_MICRO_EUR`. Aucune reprise des
  espaces existants : ils restent `console`.
- **Migration 0211** (numéro relu dans le dossier d'origin au moment de l'écrire ; d'autres sessions écrivent aussi
  des migrations) : l'origine de l'espace, le statut `bloque`, l'unicité « un numéro attribué par espace ». Elle
  ajoute et relâche : elle passe AVANT le `up`.

## 5. La console

- La page « Connecter WhatsApp » et ses deux choix ; elle réutilise la connexion actuelle (`useConnexionNumero`).
- L'Accueil d'un espace sans numéro mène à la page.
- 🔴 Vercel publie la console au `git push` : la page n'est poussée qu'APRÈS le déploiement de l'API qui porte ses
  routes, ou elle tolère leur absence.

## 6. Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ces chemins (la connexion d'un client,
une migration, le montant d'un crédit offert), et le code porte des invariants invisibles (le CHECK à sens unique de
l'espace, l'unicité par espace, la borne « une offre par espace »). Une relecture indépendante en fin de lot.

## 7. Les tests attendus

- L'attribution concurrente : deux espaces, un numéro libre, un seul gagne ; rejouée, elle rend le même numéro
  (intégration).
- Le code d'un espace : jamais celui d'un autre espace, jamais avant l'attribution, jamais au-delà de 15 minutes.
- Remplacer et abandonner : le statut `bloque`, le retour à la réserve, le refus une fois le numéro connecté.
- Le crédit : 1 € pour un espace `claude_code`, 5 € pour `console`, toujours une seule offre par espace.
- L'isolation : les routes passent par `tests/scope-tenant.test.ts`.
- L'alerte : sous le seuil, une seule fois sur 24 heures.
- La page : le numéro affiché, le code qui apparaît, « En obtenir un autre » (e2e).

## 8. L'essai réel qui clôt

Sur un espace créé depuis Claude Code : « Fournissez-moi un numéro », le numéro affiché, tapé dans la fenêtre Meta
avec la vérification par appel ; le code apparaît sur la page en moins d'une minute, le client le recopie, et le
numéro est connecté. Le crédit offert affiche 1 €. La réserve passant sous 3 numéros libres, l'alerte Telegram arrive.
