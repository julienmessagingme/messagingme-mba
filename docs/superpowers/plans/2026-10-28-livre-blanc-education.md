# Livre blanc « WhatsApp et recrutement étudiant » : plan d'exécution

> **Pour l'exécutant :** plan court (tâches, interfaces, tests attendus, ordre), sans code : le design fait foi.

**But :** un livre blanc PDF téléchargeable sur la vitrine contre un formulaire, chaque envoi versé dans HubSpot, et
dans SANDBOX (tag `livre-blanc-education`) pour qui accepte WhatsApp.

**Architecture :** le livre blanc est du HTML et du CSS imprimé en PDF par Chromium. Le formulaire de la vitrine poste
en HTML natif vers une route anonyme `POST /vitrine/livre-blanc`, sœur de `/vitrine/contact`, qui soumet à un
formulaire HubSpot, dépose dans SANDBOX si consentement, et redirige en 303 vers la page « merci ».

**Spec :** [docs/superpowers/specs/2026-10-28-livre-blanc-education-design.md](../specs/2026-10-28-livre-blanc-education-design.md)

## Contraintes globales

- Aucun tiret cadratin ni demi-cadratin (compté par script, pas par grep). Vouvoiement. Marque Messaging Me, jamais
  « UChat » ; « Meta Business Agent » tel quel.
- Aucun secret : portail, formulaire HubSpot et espace de dépôt arrivent par la configuration ; vide = moitié coupée.
- Zod `safeParse` ; destinations des redirections écrites dans le code, jamais lues dans la requête.
- L'API est déployée AVANT la page qui la poste.
- `src/index.ts`, `src/server.ts`, `scripts/auto-attaque.mts` : annonce aux sessions voisines avant d'éditer, commit
  en plomberie (`CLAUDE.md` du dépôt).
- Tout test de non-régression se vérifie dans les deux sens.

## Points de relecture

1. Mobile saisi sous toutes ses formes (`06 12…`, `+33 6…`, `0033…`, étranger, avec espaces ou points) : normalisé
   en E.164 ; illisible, il n'empêche ni HubSpot ni le PDF, et rien n'entre dans SANDBOX. Test : Tâche 4.
2. Case cochée sans mobile, ou mobile sans case : HubSpot seulement, aucune erreur pour le visiteur. Test : Tâche 4.
3. Même personne deux fois : une seule fiche SANDBOX, le tag une seule fois, HubSpot met à jour. Test : Tâche 5.
4. HubSpot lent ou en panne : courriel de secours, le visiteur arrive sur « merci » sans attendre au-delà du plafond
   de temps. Test : Tâche 4 (faux qui ne répond pas) et Tâche 5 (plafond posé sur l'appel).
5. Fiche SANDBOX qui a dit STOP et coche la case : reste désabonnée, aucun consentement écrit ; le tag est posé (il
   trace le téléchargement, et la garde d'envoi `estDesabonne` bloque toute relance). Test : Tâche 5.

---

## Phase A : le livre blanc

### Tâche 1 : gabarit et trois pages d'essai

**Fichiers :** `docs/livre-blanc/whatsapp-education/` (source HTML, CSS, images) ; `scripts/livre-blanc/imprimer.mts`
(Chromium de `web/node_modules/playwright`, script racine `npm run livre-blanc:imprimer`) ; PDF d'essai dans le
scratchpad, jamais dans `site/`.

- [ ] Sourcer les chiffres de la page des chiffres à leur source primaire (lien, date, citation exacte) dans
  `docs/livre-blanc/whatsapp-education/sources.md` ; le 96 % sans source (décision de Julien).
- [ ] Couverture, une page de contenu (encart, « À retenir »), la page des chiffres. Format A4, polices embarquées.
- [ ] Vérifier : PDF ouvert, polices embarquées, zéro tiret long, chaque chiffre a sa note sauf le 96 %.
- [ ] Montrer à Julien. **Rien ne continue sans son accord sur le style.**

### Tâche 2 : le livre blanc entier

- [ ] Rédiger les onze parties du spec, schéma Click-to-WhatsApp compris ; règles WhatsApp depuis la skill
  `messagingme:regles-whatsapp` et `brain/MESSAGINGME.md` ; produit décrit comme la page Intégrations.
- [ ] Capture HubSpot sur une fiche de démonstration du portail Messaging Me (aucune vraie donnée).
- [ ] Emplacements réservés pour Salesforce, Dynamics et Oscar, en attente des captures de Julien.
- [ ] QR et lien vers `https://app.messagingme.fr/whatsapp/` (redirection posée en Tâche 7).
- [ ] Mêmes vérifications que la Tâche 1, plus 10 à 14 pages et un poids raisonnable pour un téléchargement.
- [ ] Relecture de Julien ; commit de la source.

### Tâche 3 : captures tierces (bloquée par Julien)

- [ ] À réception : intégrer, flouter toute donnée réelle, confirmer avec Julien le produit « Oscar », réimprimer.

## Phase B : la route

### Tâche 4 : mesures HubSpot, puis route `POST /vitrine/livre-blanc`

**Prérequis :** Julien a créé le formulaire et donné son identifiant. Mesures sur le vrai formulaire avec
`julien+test…@messagingme.fr`, avant sa liste : champ absent de la définition, forme du consentement WhatsApp. Le
résultat s'écrit dans le commentaire de tête de la route.

**Fichiers :** créer `src/http/livre-blanc-vitrine.ts`, `tests/livre-blanc-vitrine.test.ts`.

**Interfaces (produit) :**
- `registerLivreBlancVitrine(app, deps: LivreBlancVitrineDeps, vitrine = VITRINE): void`
- `LivreBlancVitrineDeps = { hubspot: SoumissionHubspot | null; sandbox: DepotSandbox | null; secours: { enabled: boolean; envoyer(c: { sujet: string; texte: string; repondreA: string }): Promise<void> } }`
- `SoumissionHubspot = { soumettre(d: DemandeLivreBlanc, langue: 'fr' | 'en'): Promise<void> }` (lève sur échec)
- `DepotSandbox = { deposer(d: { nom: string; telephoneE164: string }): Promise<'depose' | 'desabonne' | 'refuse'> }`
- `PAGES_LIVRE_BLANC` par langue (formulaire, merci), comme `PAGES` de `contact-vitrine.ts`.

**Tests attendus :** champs requis manquants → retour au formulaire `?erreur=champs` ; pot de miel → « merci » sans
aucun appel ; succès → « merci », `soumettre` appelé une fois, `deposer` seulement si case ET E.164 valide ;
`soumettre` qui lève → `secours.envoyer` appelé avec les champs du prospect, visiteur sur « merci » ; `deposer` qui
lève ou rend `refuse` → visiteur sur « merci », journalisé ; formulaire anglais → pages anglaises ; plafond de débit
→ `?erreur=trop` ; les cinq points de relecture 1, 2 et 4.

### Tâche 5 : les deux adaptateurs

**Fichiers :** `src/http/livre-blanc-hubspot.ts` (point d'envoi public de l'API Forms, plafond de temps, contexte de
page) ; `src/crm/depot-livre-blanc.ts` (écritures existantes de `contact-store.pg.ts` : fiche par numéro, nom, tag
`livre-blanc-education`, consentement source `vitrine-livre-blanc` par la règle de transition existante, aucune
émission d'automation, limite de l'offre respectée) ; leurs tests, dont l'intégration (Postgres de la CI) pour le dépôt.

**Tests attendus :** corps envoyé à HubSpot conforme aux mesures de la Tâche 4 ; délai dépassé → rejet ; dépôt
idempotent (points de relecture 3 et 5) ; aucun événement d'automation publié.

### Tâche 6 : câblage, configuration, auto-attaque, déploiement

- [ ] Annonce aux sessions voisines. `src/config.ts` et `.env.example` : trois variables, vides par défaut.
- [ ] `src/index.ts` : construire les deps (secours = même chemin Resend que `contactVitrine`). `src/server.ts` :
  entrée `anonyme` du registre. `scripts/auto-attaque.mts` : fausse autorité coupée et motif `^/vitrine/livre-blanc$`.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npx tsx scripts/auto-attaque.mts` ; commit en plomberie.
- [ ] CI lue job par job (`gh run view <id> --json jobs`), puis `deploy-scaleway.yml` avec `migration=aucune`,
  approuvé par Julien ; poser les trois valeurs dans la configuration du conteneur (`DEPLOY.md`).
- [ ] Vérifier en production : un POST sans champs rend 303 vers `?erreur=champs`.

## Phase C : la vitrine

### Tâche 7 : pages, bloc d'appel, PDF, redirection WhatsApp

**Fichiers :** `site/livre-blanc/whatsapp-education/` (page, `merci/`, PDF) et leurs jumelles `site/en/…` générées ;
bloc d'appel dans `scripts/vitrine/secteurs-textes.ts` ; `site/sitemap.xml` (page seule), `site/llms.txt`, JSON-LD ;
`site/vercel.json` (redirection `/whatsapp/` vers le `wa.me` de SANDBOX) ; dictionnaires `scripts/vitrine/anglais/`.

- [ ] `npm run vitrine:entete`, `npm run vitrine:anglais`, génération des pages de secteur.
- [ ] Suite racine ENTIÈRE (des tests lisent `site/`), dont `vitrine-langues`, `vitrine-anglais`, `vitrine-entete`.
- [ ] Rendu vérifié dans l'aperçu, mobile compris ; push APRÈS le déploiement de la Tâche 6.
- [ ] Tout PDF remplacé plus tard sous le même nom prend un `?v=` incrémenté dans chaque page qui le cite.

### Tâche 8 : documentation

- [ ] `documentation.md` (la route, ses trois variables), `features.md` (avec `aide-proposer` avant de pousser),
  `docs/prive/ESSAIS-REELS.md`, journal technique ; puis `/sync`.

## Méthode de livraison

**En direct, sans agent**, avec une relecture indépendante en fin de lot, parce que la route est un chemin que la
production emprunte mais isolé, réversible, testable et calqué sur `/vitrine/contact`, et que le livre blanc et les
pages sont visuels, donc hors feature-loop.

**Essai réel qui clôt la feature :** état de la fiche SANDBOX de Julien relevé avant ; Julien envoie le formulaire en
production avec son mobile et la case cochée (PDF téléchargé, contact dans la liste HubSpot, fiche SANDBOX taguée et
consentie), puis un second envoi sans la case (contact dans HubSpot, fiche SANDBOX inchangée). Prérequis : ce qui
répond sur SANDBOX est réglé.

## Ordre

Tâche 1 → accord de Julien → Tâche 2 (la Tâche 3 quand les captures arrivent) ; en parallèle, dès le formulaire
HubSpot créé : Tâches 4, 5, 6 ; puis Tâche 7 (avec le PDF final), Tâche 8, l'essai réel.
