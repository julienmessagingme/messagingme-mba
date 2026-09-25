# Double authentification des administrateurs d'espace (lot 3 du bilan)

Décision de Julien du 2026-09-25 (`docs/prive/BILAN-AUDITS-2026-09-22.md`, lot 3) : second facteur **TOTP**,
**10 codes de secours** à usage unique, **obligatoire pour les administrateurs d'espace**, **facultatif pour
les agents et managers**, une connexion **Google suffit**. Le lot 4 (`/ops` nominatif avec TOTP) suit, dans son
propre plan : il remplace le jeton partagé d'exploitation, ce qui n'a rien à voir avec ce qui est ici.

## Méthode de livraison

**Implémenteur par lot, puis revue humaine du DIFF et une relecture indépendante.** La connexion est le chemin
que TOUTE la production emprunte, et le code touché porte des invariants invisibles (le hash-leurre contre la
fuite d'existence, le jeton de choix signé, `verifySession` qui rejette tout jeton sans `tenantId` ni `role`).
Deux « oui » en haut de la grille. L'essai réel qui clôt le lot est une connexion de Julien en production,
décrite en dernière section.

## Décisions techniques

- **Le facteur appartient à l'IDENTITÉ** (`identities`, une ligne par adresse, 0072), pas au compte : c'est
  déjà là que vit le mot de passe. Une personne admin dans deux espaces s'enrôle une fois.
- **Obligatoire si l'identité est `admin` dans au moins un espace.** Vérifié APRÈS le mot de passe et AVANT le
  jeton de choix : aucun espace n'est ouvert, aucune liste d'espaces n'est rendue, tant que le code n'est pas
  passé.
- **TOTP écrit sur `node:crypto`** (RFC 6238 : HMAC-SHA1, pas de 30 s, 6 chiffres, fenêtre de plus ou moins un
  pas), sans dépendance. Le QR code se dessine avec `qrcode`, déjà dans `web/package.json`.
- **Secret chiffré** par `encryptSecret` (`src/crypto/secretbox.ts`, `ENCRYPTION_KEY`). **Codes de secours
  hachés** (scrypt, comme le mot de passe), montrés UNE fois.
- **Anti-rejeu** : on retient le dernier pas accepté, un code du même pas ou d'un pas antérieur est refusé.
- **Aucune session d'admin sans second facteur**, sauf Google : connexion par mot de passe, inscription
  (elle crée un admin) et acceptation d'une invitation d'admin passent par l'enrôlement avant tout jeton de
  session. Les sessions déjà émises vivent jusqu'à leur expiration (12 h).

## Tâches

1. **Migration 0182 `mfa_identites`** : sur `identities`, `mfa_secret_enc text`, `mfa_active_le timestamptz`,
   `mfa_dernier_pas bigint`, `mfa_secret_attente_enc text` (le secret pendant l'enrôlement) ; table
   `mfa_codes_secours (identity_id, code_hash, utilise_le)`, cascade sur l'identité. Tout nullable, sans défaut.
2. **`src/auth/totp.ts`** : base32, `genererSecret`, `codeAuPas`, `verifierCode(secret, code, maintenant,
   dernierPas)` qui rend le pas accepté ou `null`, `uriOtpauth(emetteur, email, secret)`.
3. **`PgMfaStore`** : lire l'état d'une identité, poser le secret en attente, activer (premier code juste,
   remplace les codes), marquer le pas, consommer un code de secours (UN `update ... where utilise_le is null
   returning`, donc atomique), régénérer les codes, réinitialiser.
4. **Jetons** dans `src/auth/token.ts`, sur le modèle du jeton de choix : `mfa` (5 min, porte l'identité et la
   suite prévue) et `enrolement` (10 min). Aucun ne porte `tenantId` ni `role` à la racine, donc
   `verifySession` les refuse par construction.
5. **Routes** : `/auth/login` rend `{ mfaToken }` ou `{ enrolToken }` au lieu d'une session quand il le faut ;
   `POST /auth/mfa/verifier` (code TOTP OU code de secours) reprend exactement la suite d'avant (session si un
   espace, jeton de choix sinon) ; `POST /auth/mfa/enroler` (secret et URI) et `POST /auth/mfa/activer`
   (premier code, rend les 10 codes et la suite). Avec une session : enrôlement volontaire, régénération des
   codes, désactivation (refusée à un admin). Limiteur de 5 essais par minute et par identité.
6. **Réinitialisation par un autre admin** : `DELETE /tenants/:tenantId/users/:userId/mfa`, admin seulement,
   refusée si l'identité a un compte dans un AUTRE espace (un admin d'ici ne doit pas affaiblir un compte
   ailleurs) ; ce cas passe par `/ops`.
7. **Journal** : `mfa.active`, `mfa.code_secours_utilise`, `mfa.echec`, `mfa.reinitialise`, `mfa.codes_regeneres`,
   `mfa.desactive`, écrits dans chaque espace de l'identité. Aucun secret ni code dans le détail.
8. **Console** : étape « code » et étape « enrôlement » (QR, clé à saisir à la main, premier code, puis les 10
   codes avec Copier et Télécharger) dans `/login`, `/signup` et `/invite/[token]` ; sur `/compte`, l'état, la
   régénération et la désactivation ; sur l'équipe, le bouton de réinitialisation.

## Tests attendus

- `totp` : les vecteurs de l'annexe B de la RFC 6238 (ramenés à 6 chiffres), la fenêtre, le rejeu.
- Connexion : agent sans facteur, session inchangée ; admin sans facteur, `enrolToken` et AUCUNE session ;
  facteur actif, `mfaToken` puis session ; mauvais code, 401 ; même pas rejoué, 401 ; code de secours accepté
  une fois, refusé la seconde ; jeton expiré, 401 ; plusieurs espaces, jeton de choix rendu APRÈS le code
  seulement ; Google sans étape.
- `verifySession` refuse un jeton `mfa` et un jeton `enrolement` (vérifié dans les deux sens).
- Intégration : la consommation d'un code de secours est atomique (deux consommations simultanées, une seule
  gagne) ; la réinitialisation refuse l'identité multi-espace.
- e2e : les deux étapes de la connexion, et l'enrôlement jusqu'aux codes.

## Ordre de déploiement

Migration 0182 AVANT le `up` (la connexion lit les colonnes). L'API avant la console : la console ne connaît
pas encore `mfaToken` et `enrolToken`, et une API neuve devant l'ancienne console bloquerait la connexion des
admins, donc les deux partent dans la même fenêtre, l'API d'abord, la console poussée juste après.

## Essai réel qui clôt le lot

Julien se connecte en production avec son compte admin : enrôlement avec son application, les 10 codes, puis
déconnexion, connexion par code, connexion par un code de secours, et ce même code refusé à la connexion
suivante. Un compte agent se connecte sans étape de plus.
