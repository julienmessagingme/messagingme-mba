# Vidéos et PDF dans le bloc « message rapide » (plan)

**Statut : validé par Julien le 2026-10-14, exécution native** (la session implémente chaque lot elle-même, un relecteur indépendant
relit le lot fini). **Révisé le 2026-10-15 : lots B puis C TOUT DE SUITE, fichiers en base ; lot A après la bascule**
(section suivante). Spec : [2026-10-14-medias-message-rapide-design.md](../specs/2026-10-14-medias-message-rapide-design.md),
validée le 2026-10-14. Le plan la suit, il ne la répète pas : le pourquoi de chaque choix est dans la spec.

**But :** le bloc « message rapide » porte une image, une vidéo MP4 ou un PDF, sous un quota par offre, stockés en
base jusqu'au lot A, puis dans un bucket privé.

Trois lots, chacun déployé seul. Au démarrage de chaque lot, relire ses fichiers sur origin (le code bouge vite) et
corriger le plan avant d'écrire une ligne.

## Révision du 2026-10-15 : l'ordre devient B, C, puis A après la bascule

Décision de Julien (spec, § « Révision du 2026-10-15 ») : on n'attend pas la bascule, les fichiers restent dans
`rcs_media.bytes` jusqu'au lot A. Ce qui change dans les tâches ci-dessous :
- **B2** : le dépôt est UNE transaction sous `pg_advisory_xact_lock` (empreinte connue -> fiche existante ; sinon
  contrôle du quota et insertion des octets). Ni objet à déposer, ni objet à effacer sur refus.
- **B4** : la purge efface les lignes supprimées depuis plus de 30 jours, rien d'autre.
- **C2** : la mesure du transport porte sur le chemin ACTUEL : une requête de 23 Mo vers la route de dépôt, à
  travers Cloudflare et le proxy du VPS, AVANT de livrer C. Un refus du proxy (413) fait passer C2 par un plafond
  plus bas ou par un réglage du proxy, à décider avec Julien sur la mesure.
- **C3** : `prepareFichier` lit les octets en base par (espace, code), sans magasin d'objets.
- **Lot A**, APRÈS la bascule : sa recopie (A3) déplace TOUT ce que la table porte, vidéos et PDF compris, et la
  tâche A2 bascule les écritures du dépôt (B2) vers le magasin.

Les points de revue 1 à 5 restent valables. Le déploiement de B et C sur le VPS s'annonce à la session de migration
avant chaque `up`.

## Contraintes communes

- Bucket Scaleway privé, région `nl-ams` (passer la région à chaque commande, la CLI garde `fr-par`). Créé par
  Julien, clé IAM bornée au bucket, variables posées par Julien. Clé d'objet `tenants/<tenant_id>/<code>.<ext>`.
- Plafonds : image 2 Mo (JPEG, PNG, GIF ; JPEG et PNG seulement pour le bloc), MP4 16 Mo (la constante de
  `src/http/media.ts`), PDF 16 Mo. Le type se tranche sur les octets, jamais sur ce qu'annonce le navigateur.
- Quota : Base 0, Pro 100 Mo, Entreprise 500 Mo, somme des `taille` des fichiers non supprimés.
- Vidéo et PDF jamais servis par `/m/`. Lecture interne par (espace, code), aperçu sous session.
- Tout numéro de migration se lit par `npm run migrations`, au moment d'écrire la migration.
- Textes de la console en `t('fr', 'en')`, sans tiret long.

## Points à surveiller en revue

Ce que la spec implique et qu'aucun test d'une tâche ne viserait sans qu'on le demande. Chaque ligne a son test dans
la tâche qui possède le code.

1. **Un MOV renommé en `.mp4`** (marque `ftyp` `qt  `) passe la signature `ftyp` et l'encodage H.264, puis Meta le
   refuse : refusé au dépôt (tâche C1).
2. **Un bloc DÉJÀ enregistré** avec un fichier et plus de 1 024 caractères : la borne de l'éditeur ne le touche pas.
   Le moteur refuse en nommant la limite, au lieu de laisser Meta rejeter le message (tâche C5).
3. **Une adresse `/m/` sur un ancien hôte** (`mba.messagingme.app`, `engageme.messagingme.app`) dans un graphe
   enregistré : reconnue comme nôtre par son chemin, lue directement (tâche C3).
4. **Le même fichier redéposé pendant sa suppression douce** : nouvelle fiche, quota consommé, et l'ancienne finit
   sa purge sans emporter la nouvelle. Les deux partagent l'empreinte, PAS la clé d'objet : le code est neuf (tâche B2).
5. **Un nom de PDF hostile** (chemin `../`, 300 caractères, sans extension, émoji) : `filename` nettoyé, borné, finit
   par `.pdf` (tâche C2).

## Lot A : les fichiers sortent de Postgres

Prérequis : la bascule faite, la mesure 1 de la spec (§ 6, taille maximale d'une requête vers le conteneur) connue.
Julien crée le bucket et la clé, pose les variables dans les secrets de la cible. Mesure 2 de la spec : borner la
clé au bucket par l'IAM, sinon par une politique de bucket, et le vérifier (la clé refuse un autre bucket du projet).

1. **Le magasin d'objets** (`src/lib/magasin-objets.ts`, `src/config.ts`, `package.json`).
   Interface `MagasinObjets` : `deposer(cle, octets, type)`, `lireFlux(cle) -> Readable`, `lireOctets(cle) -> Buffer`,
   `effacer(cle)` (réussit sur une clé absente), `effacerPrefixe(prefixe) -> nombre`. Implémentation par
   `@aws-sdk/client-s3` (`forcePathStyle`, point d'accès de la région). Le faux en mémoire vit dans
   `tests/magasin-objets-faux.ts`, jamais dans `src/`. Variables `OBJETS_*` (point d'accès, région, bucket, clé, secret) :
   toutes ou aucune, sur le motif du couple Stripe (`superRefine`).
   Tests : la règle « toutes ou aucune » ; `effacerPrefixe` sur plus de 1 000 clés (pagination) contre le faux.
2. **Migration A1 et lecture à deux emplacements** (`db/migrations/`, `src/rcs/media-store.pg.ts`,
   `src/http/rcs-media.ts`, `src/index.ts`). Migration AVANT le code : `bytes` nullable, `cle_objet text`, CHECK
   « exactement l'un des deux » nommé. Le store écrit au bucket quand le magasin est configuré (objet d'abord, fiche
   ensuite ; fiche refusée -> objet effacé), en base sinon. `getByCode` rend un flux ou des octets ; `/m/` envoie le
   flux, mêmes en-têtes.
   Tests : écriture au bucket vs en base selon la config ; `/m/` sert les deux ; CHECK refusant ni l'un ni l'autre
   (intégration).
3. **La recopie** (`scripts/medias-vers-objets.mts`). Ligne par ligne : dépose, pose `cle_objet`, vide `bytes`, dans
   cet ordre ; rejouable. Sortie : le nombre de lignes encore en base, qui doit être 0.
   Tests : rejoué deux fois, même état ; une erreur de dépôt laisse la ligne en base.
4. **La suppression d'un espace efface ses objets** (`src/ops/suppression-espace.ts`, `.pg.ts`, le câblage de
   `src/index.ts`). Étape `fichiers` dans `ETAPES`, avant `purge`, au mieux. `prevoirEtapes` la dit à l'avance.
   Tests : l'étape efface le préfixe de l'espace et pas celui d'un autre ; son échec est noté et la purge continue.
5. **La carte de `/ops`** (`src/ops/stockage.pg.ts` et son écran) : « Stockage des fichiers », somme des `taille`,
   seuil revu.
6. **Migration A2, plus tard** : après un déploiement où plus aucun code ne lit `bytes`, et la recopie à 0. Elle
   retire `bytes` et le CHECK A1 devient « `cle_objet` non nul » ; les variables `OBJETS_*` deviennent obligatoires.
   Tests : le démarrage refuse sans les variables ; `tests/integration` ne nomme plus `bytes`.

## Lot B : le stock

1. **La limite de l'offre** (`src/offres/offres.ts`, `src/offres/refus.ts`, `src/offres/vue.ts`, l'outil
   `get_plan` de `src/mcp/outils.ts`, la documentation de l'API qui décrit les limites, la page des offres de la
   vitrine `site/` si elle liste les limites). `Limites.stockageOctets`,
   `NomLimite` l'inclut, `phraseLimite` le dit en Mo.
   Tests : les trois offres ; la vue de l'offre et `get_plan` le montrent ; `corpsRefusLimite` sur cette limite.
2. **Migration B et store** (`db/migrations/`, `src/rcs/media-store.pg.ts`). Migration AVANT le code :
   `supprime_le timestamptz`, `empreinte text`, sans index unique (5 groupes de doublons en production, mesuré le
   2026-10-15 : le verrou d'espace tient l'unicité). Store :
   - `deposer(tenant, fichier)` : empreinte connue -> la fiche existante ; sinon contrôle rapide du quota, objet au
     bucket, puis transaction sous `pg_advisory_xact_lock` (contrôle exact, insertion), refus -> objet effacé et
     `LimiteOffreError('stockageOctets', max)` ;
   - `lister(tenant)` sans les supprimés, `occupation(tenant)` ;
   - `utilisations(tenant, code)` : les lieux de la spec § 2.4, chacun avec le nom de ce qui l'utilise ;
   - `supprimer(tenant, code)` : refus si `utilisations` n'est pas vide, sinon `supprime_le = now()` ;
   - `getByCode` sert encore un fichier supprimé depuis moins de 30 jours.
   Tests (intégration) : deux dépôts parallèles au bord du quota, un seul passe ; dédoublonnage, même au-dessus du
   quota ; point de revue 4 ; `utilisations` pour CHAQUE lieu (brouillon et publié d'un scénario, message RCS
   enregistré, campagne en cours, brouillon de campagne, étage de chaîne) et pour une campagne TERMINÉE (ne compte
   pas) ; un fichier d'un autre espace n'apparaît jamais.
3. **Les routes** (`src/http/rcs-media.ts`, `src/server.ts`). Module monté avec `toutes('scenarios')` au lieu de
   `toutes('rcs')`. Dépôt sous `limiteCouteuse`. Nouvelles routes d'espace : lister (avec l'occupation et le
   quota), supprimer (409 avec la liste des utilisations), ouvrir (octets, `nosniff`, `attachment` hors image).
   Tests : `tests/scope-tenant.test.ts` les couvre (lancer aussi `npx tsx scripts/auto-attaque.mts` en local) ; un
   espace Pro dépose une image ; Base refusé par l'offre.
4. **La purge des fichiers supprimés** (`src/worker.ts`, une tâche `taches.programmer`, une fois par jour, par
   `purgerJusquAEpuisement`). Objet effacé PUIS fiche.
   Tests : au-delà de 30 jours effacés, en deçà gardés ; objet introuvable -> la fiche part quand même au passage
   suivant ; le faux magasin garde la trace de l'effacement (pas un faux qui retire la ligne en silence).
5. **L'inventaire des lieux** (`tests/medias-lieux.test.ts`). Dérive de `web/` les composants qui importent
   `ChampImageHebergee` et exige que chacun soit rattaché à un lieu de `utilisations`.
   Test vérifié dans les deux sens : un composant fictif ajouté le fait échouer.
6. **L'écran de la médiathèque** (une page de Paramètres, `web/lib/api/`). Jauge, liste, Supprimer (le refus montre
   ce qui utilise le fichier). Si `web/lib/nav.ts` change : `npm run aide:carte`. Tout lot console = la suite serveur
   entière avant de pousser.
   E2E : liste, suppression refusée puis acceptée.

## Lot C : vidéo et PDF dans le bloc

Prérequis : la mesure 1 de la spec. Si le conteneur coupe sous 24 Mo, la tâche C2 passe par une URL signée vers le
bucket (spec § 3.7) : réécrire C2 avant de commencer.

1. **Reconnaître et vérifier** (`src/medias/fichier.ts`, migration C qui élargit le CHECK des types AVANT le code).
   `typeFichier(octets)` : les trois images, `video/mp4` (`ftyp` dont la marque majeure n'est pas `qt  `),
   `application/pdf`. `verifierVideo(octets) -> null | raison` : parcours des boîtes, règles de la spec § 3.1.
   Tests : boîtes construites dans le test (pas de fichier vidéo au dépôt) : `avc1` accepté, `hvc1` refusé, High +
   `ctts` refusé, Main + `ctts` accepté, deux pistes audio refusées, audio non AAC refusé, `moov` en fin lu, MOV
   refusé (point de revue 1), PDF renommé en `.mp4` refusé.
2. **Le dépôt** (`src/http/rcs-media.ts`). Accepte vidéo et PDF, plafonds de la spec, `bodyLimit` de 24 Mo ;
   `/m/` rend 404 hors image. Le nom gardé pour `filename` est nettoyé (point de revue 5).
   Tests : plafonds par type, 404 de `/m/` pour une vidéo et un PDF, nom hostile.
3. **La préparation directe** (`src/meta/template-media.ts`, `src/workflow/wiring.ts`, le câblage de l'API).
   Nouvelle méthode `prepareFichier(tenant, url) -> { mediaId, type: 'image' | 'video' | 'document', nom } | null`.
   Une adresse dont le CHEMIN est `/m/<code>.<ext>` se lit par (espace, code) dans le store puis le magasin ; pas de
   fiche pour cet espace -> chemin HTTP actuel. `prepareOne` (en-têtes de templates, `src/worker.ts`) ne change pas.
   Nouvelle dépendance de `creerEnvoisDeBloc` : `prepareFichierDuBloc`.
   Tests : lecture directe sans HTTP ; code d'un autre espace -> HTTP, et une vidéo y échoue ; point de revue 3 ;
   cache par numéro conservé.
4. **Le client Meta** (`src/meta/client.ts`). `EnTeteMedia = { type, id, filename? }` remplace le `mediaId` d'image
   de `sendInteractive` et `sendCtaUrl` ; `sendMedia(to, enTete, legende)` remplace `sendImage`. Seul
   `src/workflow/envois-bloc.ts` les appelle (relevé le 2026-10-14) : `ClientDesEnvois` suit.
   Tests : la forme exacte du corps envoyé pour image, vidéo, document (avec `filename`), dans les trois méthodes.
5. **Le bloc** (`src/workflow/envois-bloc.ts`, `src/workflow/executor.ts`). Les quatre formes de la spec § 3.4.
   Refus si un fichier est joint et que le texte dépasse 1 024 caractères (point de revue 2). Sur un parcours RCS,
   refus d'une vidéo ou d'un PDF AVANT la carte, avec la raison de la spec § 3.5. Le champ reste `imageUrl` ; un
   commentaire au point de lecture dit qu'il porte aussi une vidéo ou un PDF (spec § 3.3).
   Tests : les quatre formes ; préparation ratée -> refus nommé, rien n'est envoyé ; refus RCS ; garde de légende.
6. **L'écran** (`web/components/ChampImageHebergee.tsx`, `WorkflowConfigPanel.tsx`, `WorkflowNode.tsx`, l'aperçu
   du bloc). Option `accepte` (défaut `image` ; `image-video-pdf` pour le bloc, qui n'y prend en image que JPEG et
   PNG, spec § 11), aperçu par nom et poids avec « Ouvrir », borne de texte à 1 024 dès
   qu'un fichier ou un bouton est là, mention « WhatsApp seulement », type visible dans la miniature. `grep` de
   `web/e2e` avant de changer un rôle.
   E2E : `web/e2e/workflow-quick-media.spec.ts` étendu (dépôt d'un PDF, miniature, mention RCS, borne 1 024).
7. **La documentation**, dans le commit qui livre : `features.md` (section du bloc, AVEC sa fiche d'aide et son
   empreinte, `tests/aide-proposer.test.ts` vert avant le push), `documentation.md` (médiathèque, bucket, quota,
   suppression douce), `todo.md` (la fiche du 2026-08-28 pointe vers la spec), `docs/prive/ESSAIS-REELS.md`.

## Ordre de déploiement

Pour chaque lot : `gh run view <id> --json jobs` job par job avant le déploiement, la migration AVANT le code qui la
lit, puis relecture en base point par point (colonnes, CHECK sous leur nom, prédicat exact de l'index partiel).

- **A** : bucket, clé et variables (Julien) -> A1 -> API et worker -> recopie, sortie à 0 relue -> essai de l'étape
  `fichiers` sur un espace de test supprimé depuis `/ops` -> A2 et variables obligatoires, dans un déploiement à part.
- **B** : migration -> API et worker -> la console APRÈS (l'écran appelle des routes neuves).
- **C** : migration -> API et worker -> la console APRÈS.

## Méthode de livraison

**Implémenteur par lot + revue humaine du diff**, une relecture indépendante en fin de chaque lot, parce que les
trois lots passent par des chemins que la production emprunte : l'envoi d'un bloc, une colonne retirée sous une
adresse publique à sens unique, la purge, la suppression d'un espace. Ils portent aussi des invariants qu'aucun
compilateur ne voit : l'isolation par espace d'une lecture qui ne passe plus par HTTP, un index partiel lié à sa
requête, un verrou qui tient le quota. Pas de `feature-loop`, parce que la moitié des critères demande un œil
(l'écran, la vidéo sur un téléphone).

**Essai réel qui clôt la feature** (spec § 7), sur le téléphone de Julien depuis un espace Pro : un PDF en en-tête
de réponses rapides (nom affiché, bonne branche au tap), une vidéo sans bouton lue sur iPhone ET sur Android, le
refus d'une vidéo HEVC d'iPhone, la jauge qui bouge et la suppression refusée d'un fichier utilisé. Pour le lot A,
une adresse `/m/` envoyée avant la recopie s'affiche encore après A2.
