# Offre Entreprise depuis /ops, second facteur des admins au choix de l'espace, gras de l'Inbox

Demandes de Julien du 2026-10-13, design court validé le même jour (« ok go, enchaîne sur le code »). Ses trois
choix : le gras suit les conversations NON LUES ; le réglage est désactivé partout, espaces existants compris ; la
connexion Google n'est pas concernée par le réglage.

## Méthode de livraison

**Implémenteur par lot, puis UNE relecture indépendante du diff**, parce que le second facteur est un chemin que la
production emprunte à chaque connexion et qu'il porte un invariant invisible au compilateur (aucune session d'admin
sans facteur DANS UN ESPACE QUI L'EXIGE, et aucune session d'exploitation sans facteur, jamais). Le reste (fenêtre de
l'offre dans /ops, gras et titres de l'Inbox) se fait **en direct** dans le même lot : écrans isolés et réversibles.

**Essai réel qui clôt le lot** (`docs/prive/ESSAIS-REELS.md`) : sur un espace de test, cocher « Exiger la double
authentification », se connecter par mot de passe avec un admin sans facteur (l'enrôlement est demandé), décocher (plus
rien n'est demandé, et l'admin retire son facteur depuis Mon compte) ; se connecter à /ops (le code est toujours
demandé) ; envoyer un WhatsApp au numéro (« À traiter » passe en gras, puis redevient normal une fois le fil ouvert) ;
passer un espace de test en Entreprise depuis /ops, puis le ramener en Base.

## Tâches

1. **Migration 0230** : `tenants.second_facteur_admins boolean not null default false`. Passe AVANT le code, qui la
   lit (l'ancien code l'ignore et survit). Test de forme comme 0229.
2. **Le second facteur exigé, écrit une fois** (`src/auth/facteur-exige.ts`) : un compte admin actif dans un espace
   qui l'exige. Lu par `findIdentity` (nouveau champ requis `facteurExige`) et par l'état du facteur (`obligatoire`).
   La connexion, l'inscription et l'invitation acceptée lisent ce calcul, plus « admin quelque part ». /ops inchangé
   (`entreeOps` exige un code ou un enrôlement, la garde relit le facteur à chaque requête). Mon compte : une adresse
   d'exploitation ne retire pas son facteur (`opsEmails` passe dans `MfaRouteDeps`, même objet de dépendances).
3. **Le réglage** : `GET` et `PUT /tenants/:t/second-facteur` dans le module `admin` (garde admin au montage), tracés
   au journal (`espace.second_facteur_exige`, `espace.second_facteur_libre`). Carte « Sécurité de l'espace » sur
   Compte & équipe ; la route absente (API pas encore déployée) cache la carte.
4. **Console de l'inscription** : la réponse peut être une session directe (`signup` rend une étape OU la suite).
   🔴 Elle part sur Vercel au push, AVANT l'API : l'ancienne API ne rend que des étapes, la nouvelle console sait lire
   les deux. L'ordre inverse casserait l'inscription.
5. **Offre Entreprise dans /ops** : lien « offre » par espace, fenêtre qui lit `GET /ops/offre/:id` et écrit `PUT`
   (Entreprise, limite d'utilisateurs ou sans limite, conservation inchangée sauf case cochée, avertissement si elle
   baisse, note obligatoire). La route est déjà en production.
6. **Gras de l'Inbox** : les compteurs du menu rendent `aTraiterNonLues` et `nonLues` par membre (même `UNREAD_SQL`
   que la pastille) ; « À traiter » et un nom passent en gras quand il en reste. Titres « Conversations » et
   « Affectation » en corps normal, gras et foncés. Une API ancienne rend des zéros : rien en gras, aucune casse.

## Tests attendus

- Routes d'authentification : admin d'un espace qui n'exige pas = session directe (connexion, inscription,
  invitation) ; admin d'un espace qui exige = enrôlement ; facteur actif = code, quel que soit le réglage ; Mon compte
  refuse la désactivation dans un espace qui exige et pour une adresse d'exploitation, l'accepte sinon ; /ops exige
  toujours le code (inchangé, `ops-nominatif`). Mutations vérifiées dans les deux sens.
- Route du réglage : garde admin, Zod strict, journal, 404 d'un espace inconnu.
- Intégration (CI) : `obligatoire` et `facteurExige` suivent le réglage de l'espace ; les compteurs non lus.
- e2e : la carte du réglage, l'inscription sans enrôlement, la fenêtre de l'offre, le gras du menu.

## Ordre de déploiement

Migration 0230 (relue en base), push du lot (console publiée par Vercel, compatible avec l'ancienne API), CI lue job
par job, relecture indépendante, `up` de l'API et des workers, `aide:charger` (fiche des accès modifiée), fumée.
