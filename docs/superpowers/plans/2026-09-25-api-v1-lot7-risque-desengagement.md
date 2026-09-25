# API publique v1, lot 7 : le risque de désengagement

**Spec** : `docs/superpowers/specs/2026-09-24-api-publique-coherente-design.md` § 19 (cadré le 2026-09-25).
Plan COURT (règle du 2026-09-24) : tâches, interfaces, tests attendus, ordre de déploiement ; le code se lit dans
le dépôt.

## Méthode de livraison

**Implémenteur par lot, avec une relecture indépendante en fin de lot**, parce que la production emprunte ces
chemins (un balayage de nuit écrit sur CHAQUE fiche active, et un déclencheur d'automation de MASSE qui peut
lancer des scénarios facturés) et que la grille porte des invariants qu'un test seul ne voit pas (lecture ignorée
pour un contact aux accusés coupés, `inconnu` sans score, STOP à 100). Deux agents à la suite : le serveur, puis la
console. L'essai réel qui clôt le lot est décrit plus bas.

## Tâches

1. **Migration 0178** (`risque_desengagement`) : sur `contacts`, `risque_niveau text` nullable (CHECK
   `inconnu | faible | moyen | eleve`), `risque_score smallint` nullable (CHECK 0 à 100), `risque_raisons text[]
   NOT NULL DEFAULT '{}'`, `risque_calcule_le timestamptz` ; index `(tenant_id, risque_niveau) where deleted_at is
   null`, celui du filtre. Additive : AVANT le `up`. Compteur de `CLAUDE.md` dans le commit qui la prend.
2. **Les règles, PURES** (`src/engagement/risque.ts`) : `calculerRisque(faits, maintenant, seuils?) ->
   { niveau, score, raisons }` à partir des faits d'un contact (délivrés et lus sur la fenêtre, dernier signe de
   vie, trois derniers délivrés, dernière analyse, joignabilité, STOP, blocage). La grille, les niveaux, les codes
   et `SEUILS_PAR_DEFAUT` (30 et 60 jours de silence, fenêtre de 90, allègement de 14) sont des constantes
   exportées ; les seuils se passent en paramètre POUR LES TESTS.
3. **Lecture et écriture en base** (`src/engagement/risque.pg.ts`) : les faits de tous les contacts à évaluer
   d'un espace en requêtes groupées (jamais une requête par contact), puis l'écriture du résultat ; rend les
   TRANSITIONS de niveau (ancien, nouveau). `tenant_id = $1` sur chaque requête. Sont évalués : les contacts
   actifs qui ont reçu un envoi sur la fenêtre, ceux dont le niveau stocké n'est pas null, les désabonnés et les
   bloqués.
4. **Le balayage de nuit** (worker) : une fois par nuit et par espace, best-effort (une panne d'un espace
   n'arrête pas les autres), journalisé. Pour chaque transition : les signaux (attributs `em_risk_level`,
   `em_risk_score`, `em_risk_reasons`, et l'événement `em_risk_changed`) par l'émetteur existant, qui ne coûte rien
   sans outil branché ; et, pour un passage EN `eleve`, l'événement d'automation `risque_eleve`, plafonné à 200 par
   nuit et par espace (au-delà : écrit, pas déclenché, journalisé), en plus du plafond horaire de chaque
   automation. Le même balayage se lance À LA DEMANDE pour un espace par `/ops` (jeton ops), pour l'essai réel et
   le dépannage.
5. **Dictionnaire des signaux** : l'événement et les trois attributs dans `src/signaux/types.ts`, leur
   traduction dans l'adaptateur, sans nommer d'outil hors de ses fichiers réservés.
6. **Déclencheur d'automation** `risque_eleve` : `AUTOMATION_TRIGGER_KINDS`, la correspondance, le travail de la
   file `automation-event` ; aucune migration (le type n'a pas de CHECK en base).
7. **API** : `engagementRisk: { level, score, reasons, computedAt } | null` dans `FicheApi` (lecture et
   recherche) ; exemples de `web/lib/api-exemples.ts` et page de doc.
8. **Console** (second agent) : sur la fiche du mini-CRM, le niveau et ses raisons en français ; un filtre par
   niveau dans la liste des contacts, par les règles partagées de `src/crm/contact-filters.ts`, donc aussi dans
   la construction d'une campagne ; le déclencheur « risque élevé » dans l'écran Automation ; les signaux neufs
   dans « Ce que nous remontons ». Chaque écran tolère une API qui ne renvoie pas encore le champ.
9. **Doc** : `features.md`, `documentation.md` (le balayage, la grille par pointeur vers la spec, le chemin de
   masse et son plafond).

## Tests attendus

- Chaque règle de la grille, isolée ; l'exclusivité des deux silences ; le plafond à 100 ; l'allègement et son
  plancher ; `inconnu` sans score ; STOP et blocage à 100 même sans historique ; un contact qui répond sans jamais
  lire n'est PAS pénalisé par `non_lu` ; les trois raisons les plus lourdes, dans l'ordre.
- Isolation : un espace n'évalue ni n'écrit la fiche d'un autre (intégration, CI).
- Le balayage : transitions justes, signal émis seulement sur un changement, plafond de 200 déclenchements tenu,
  une panne d'un espace n'arrête pas le suivant.
- Parités : le dictionnaire du serveur et la page, les codes de raisons et leurs libellés de la console.
- Chaque test de non-régression vérifié dans les deux sens.

## Déploiement

1. Push du serveur, CI lue job par job.
2. Relecture unique du lot.
3. Sur le VPS : `git pull`, `compose build`, `migrate` (0178), relecture en base, puis `up -d --build mba-api
   mba-worker`, rechargement du proxy, contrôle des portes.
4. Push de la console APRÈS le déploiement de l'API.

## Essai réel qui clôt le lot

Sur l'espace d'essai, avec ses VRAIES données (des contacts qui ont reçu des campagnes il y a plus de 30 jours
sans y répondre existent déjà) : le balayage lancé par `/ops` classe chaque contact ; on vérifie à la main, pour
deux ou trois contacts, que le niveau et les raisons correspondent à leur historique réel ; on le voit sur la
fiche, dans le filtre, dans `GET /v1/contacts/{id}`, dans l'outil branché (attributs et événement) ; une
automation « risque élevé » posée sur un scénario d'essai part UNE fois pour un contact qui passe en élevé, et
pas une seconde fois au balayage suivant.
