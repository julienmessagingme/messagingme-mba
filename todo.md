# todo.md : backlog

## 🟠 Le bouton « Rendre la main » de l'Inbox garde la course que la fin de parcours vient de perdre (2026-09-15)

Le correctif du 2026-09-15 (migration 0149) fait attendre à la fin d'un parcours l'accusé de son dernier
envoi avant de rendre le fil à l'agent de Meta, parce qu'envoyer un message PREND le fil chez Meta et que
l'accusé arrive DEUX MINUTES plus tard. **Le bouton « Rendre la main » de l'Inbox, lui, appelle toujours Meta
tout de suite** (`src/index.ts`, `rendreLeFilAuMba`). Un opérateur qui répond au client puis rend la main dans
la foulée relâche donc un fil que son propre message vient de reprendre : l'agent de Meta restera muet, comme
il l'était en fin de scénario.

🔴 **Ce n'est pas le même geste, et c'est pour ça que ça n'a pas été corrigé dans la foulée.** La route est
SYNCHRONE et rend un verdict à l'écran (« le fil est rendu, à qui »). Le différer jusqu'à l'accusé ferait
mentir le bouton, ou obligerait à afficher un état « remise en cours » qui n'existe nulle part aujourd'hui.

Deux pistes, à arbitrer : afficher l'attente (le bouton répond « rendu d'ici deux minutes ») et passer par le
même marqueur ; ou ne différer QUE quand notre dernier envoi date de moins de deux minutes et n'a pas encore
son accusé, et relâcher tout de suite sinon. La seconde ne change rien au cas courant, où l'opérateur rend la
main sans avoir écrit.

⚠️ Le filet existe déjà dans les deux cas : le balayage de contrôle reprend les fils immobiles et les rend
pour de vrai. Le coût d'aujourd'hui est un retard, pas une perte.

## 🔴 « L'agent de Meta prend la main » et « Un agent IA prend la main » NE PARTENT NULLE PART (2026-09-14)

Relevé en revue du lot « une question à la fois », en suivant ce que `devenir` devient. La question
« Que se passe-t-il quand le contact répond ? » de l'assistant de campagne propose trois réponses, et
**une seule voyage jusqu'au serveur** : « La conversation arrive dans l'Inbox », par `assignation` et
`assignationUserId`.

Mesuré, pas supposé : `devenir` et `agentId` n'apparaissent que dans l'écran et dans le brouillon
(`web/lib/campagne-brouillon.ts`) ; `CreateCampaignInput` (`web/lib/api/campagnes.ts`) ne porte aucun
champ pour eux ; `campaigns` n'a aucune colonne qui dise quel agent reprend la conversation.

**Choisir « Un agent IA prend la main » ne change donc rien à ce qui se passera**, et l'écran fait
pourtant désigner un agent précis dans une liste. C'est le motif « offert-et-inerte », que le produit
s'interdit ailleurs (un canal sans agent RCS est grisé AVEC sa raison plutôt que d'accepter un choix
sans effet).

Deux sorties possibles, et c'est un arbitrage de Julien :

- **le câbler** : une colonne sur `campaigns`, lue à l'arrivée d'une réponse, au même endroit que
  `assignationDeLaCampagne` (`src/campaign/store.pg.ts`) ;
- **ou retirer les deux options** et dire ce qui se passe réellement aujourd'hui (l'agent de l'espace
  répond s'il est actif, sinon la conversation tombe dans l'Inbox).

⚠️ Ne pas trancher à notre main : la première option est un vrai chantier, la seconde retire une
promesse qui a peut-être été faite à un client.

## ✅ LIVRÉ : traduction des conversations (tranché le 2026-09-12, livré et déployé le 2026-09-13)

> ⚠️ **CE TITRE A DIT « RIEN DE COMMENCÉ » PENDANT QUE C'ÉTAIT EN PRODUCTION** (migration 0137,
> `TRADUCTION_MODELE` posée, six tâches livrées). Relevé le 2026-09-14 en répondant à « il reste quoi à
> faire ? », c'est-à-dire par quelqu'un qui allait s'en servir. **Un backlog qui garde une entrée livrée ne
> vieillit pas, il MENT** : il fait rouvrir un chantier fini. Ce qui suit est le CADRAGE d'origine, gardé
> parce qu'il porte les décisions ; le fonctionnel vit dans `features.md`.

**Deux langues, FR et EN, et c'est ce qui rend le dessin simple.** « Traduire » veut dire « dans
l'autre », donc **aucun sélecteur de langue nulle part** : ni sur le contact, ni sur la conversation.

Décisions de Julien :

- **La langue de lecture vient de la console.** Elle vit dans le `localStorage`
  ([web/lib/i18n.tsx](web/lib/i18n.tsx)), **pas sur le compte**, donc le serveur ne la connaît pas.
  C'est le navigateur qui la passe à chaque appel. ⚠️ Le motif existe déjà et se décalque : le bot
  d'aide envoie `QuestionAide.langue: 'fr' | 'en'` à chaque question.
- **Les entrants se traduisent TOUS à l'ouverture d'une conversation**, jamais à l'arrivée. Traduire
  à l'arrivée fait payer les « ok », les emojis et toutes les conversations que personne n'ouvrira.
  Le premier lecteur paie, les suivants réutilisent le résultat rangé.
- **Les sortants ne se traduisent JAMAIS automatiquement.** Un bouton « Traduire » avant l'envoi.
  🔴 C'est une garde, pas une commodité : une traduction ratée en entrée se rattrape sur l'original
  affiché à côté, une traduction ratée en sortie est partie chez un client et **aucun message
  WhatsApp livré ne se rappelle**.
- **Le toggle « traduire les entrants » vit dans le `localStorage`**, comme la langue elle-même.
- **Stockage** : une colonne de traduction plus la langue dans laquelle elle est. Un message français
  n'a jamais besoin que d'une traduction anglaise, et réciproquement.
- 🔴 **À l'envoi, `body` porte ce qui est PARTI (le texte traduit), et une colonne à part porte ce
  que l'opérateur a ÉCRIT.** Miroir exact de la migration 0125 : ne garder que le traduit rend
  l'opérateur incapable de se relire, ne garder que l'original rend notre trace fausse le jour d'un
  litige.

Trois pièges à ne pas découvrir en route :

- 🔴 **Un template ne se traduit pas.** Il est approuvé par Meta dans une langue, et le texte
  approuvé EST le texte. La traduction ne concerne que les messages libres, dans la fenêtre de 24 h.
  Un bouton « Traduire » affiché sur un template ment.
- ⚠️ **Traduire coûte des jetons** sur la clé Gateway de l'espace (migration 0124), donc sur le
  crédit prépayé. Un espace à zéro ne peut pas traduire, et ça se dit à l'activation, pas au premier
  message muet.
- 🔴 **« L'autre langue » NE SUFFIT PAS, et c'est la précision de Julien du 2026-09-12.** Nos deux
  langues sont celles de la CONSOLE, pas celles des contacts : un client peut très bien écrire en
  espagnol. La règle juste est donc dissymétrique.
  - **En entrée** : traduire vers la langue du LECTEUR, quelle que soit la source. Aucun problème,
    la cible est toujours connue.
  - **En sortie** : la cible est la langue du CONTACT, qui n'est ni le français ni l'anglais dans ce
    cas. « L'autre des deux » ne veut plus rien dire.

### La langue du contact s'APPREND, elle ne se demande pas

🔴 **On la détecte déjà, et on la jette.** `src/agent/llm/transcription.ts` rend `langue: string |
null` (ligne 94) et la migration 0125 n'a créé aucune colonne pour la garder. Troisième fois dans la
même journée qu'on trouve une donnée calculée puis perdue, après la joignabilité WhatsApp.

Elle se retient donc sur la fiche du contact, alimentée par la transcription de ses vocaux et par la
traduction de ses textes. Ni question posée au contact, ni choix imposé à l'opérateur.

⚠️ **Le bouton NOMME sa cible** : « Traduire en espagnol », jamais « Traduire » tout court. Meilleur
même quand la cible est évidente, parce que l'opérateur voit où part sa phrase avant de valider.
Tant qu'on n'a rien appris du contact, il nomme la langue par défaut : il ne ment donc jamais.

### Les vocaux (précision de Julien, 2026-09-12)

Quand le client appuie sur **Transcrire** et que la traduction est active, la transcription doit
arriver dans SA langue de console, **même si le vocal était en espagnol**.

- 🔴 **On traduit la TRANSCRIPTION, pas le corps.** Le `body` d'un audio vaut `[audio]` ou la
  légende : le traduire ne produirait rien. L'ordre est imposé, transcrire puis traduire, et ça
  reste **un seul geste** pour l'opérateur.
- 🔴 **NE PAS utiliser le mode « traduire » intégré des API de transcription.** Il ne cible que
  l'anglais : s'en servir donnerait un comportement différent selon que l'opérateur est en FR ou en
  EN, et **détruirait l'original**. On transcrit fidèlement, puis on traduit.
- ⚠️ **Deux appels, donc deux fois le coût** sur le crédit prépayé pour un vocal traduit.
- La transcription garde ce qui a été **dit** (en espagnol), la traduction vit dans sa colonne avec
  sa langue. Même principe qu'en 0125 : la lecture d'un modèle n'est pas ce que le client a dit.

## 🔴 Ce qu'on exécute est le POINT 2 de l'audit externe du 2026-09-02

> **Au 2026-09-03 au soir : A1 à A4, B et C sont livrés et déployés.** Ne restent de ce point que le profil
> `equite` du banc de charge (plus bas) et, facultatif, éteindre `mba-web`.

### Contre-rapport de ChatGPT sur ces livraisons (2026-09-03) : les huit constats, vérifiés un par un

Vérifiés DANS LE CODE avant d'être acceptés, jamais sur leur formulation. **Cinq confirmés, trois à moitié**,
et les trois moitiés fausses valaient d'être établies, parce qu'elles auraient fait travailler pour rien.
**Tous les points confirmés sont corrigés**, sauf ceux listés comme ouverts en fin de section.

- ~~**A3-ipv6** : la classification IPv6 laissait passer cinq cas sur huit.~~ **CORRIGÉ.** C'était le plus
  grave, et il était à moi. La garde testait des PRÉFIXES DE TEXTE : `fe80::/10` fait dix bits et va jusqu'à
  `febf`, donc trois adresses lien-local sur quatre passaient ; et une IPv4 mappée s'écrit aussi en
  hexadécimal, donc `::ffff:ac12:1`, qui EST `172.18.0.1`, la passerelle du réseau Docker du VPS, passait.
  C'est l'adresse même que cette garde existe pour bloquer, et l'en-tête du module affirmait qu'elle était
  rejetée, « vérifié ». L'adresse est désormais DÉVELOPPÉE en huit groupes de seize bits et comparée en
  nombres. ⚠️ La vérification a aussi trouvé quatre cas que le contre-rapport ne voyait pas : forme non
  compressée, `::/96` déprécié, et `0:0:0:0:0:0:0:1` classé public. Non retenus en revanche : `fec0::/10`,
  `2002::/16` et `::ffff:0:0:0/96`, aucun n'étant joignable depuis ce VPS.
- ~~**A1-transition** : la sortie terminale d'un tour était une double écriture non atomique.~~ **CORRIGÉ.**
  Clore la session puis faire sortir le parcours : une panne entre les deux laissait un parcours mort POUR
  TOUJOURS, la clôture ayant effacé le marqueur qui l'aurait désigné au balayage. ⚠️ **Et le correctif évident
  était faux** : inverser l'ordre paraît plus sûr, mais `sortirDuBlocAgent` fait AVANCER le parcours, qui peut
  retomber sur un autre bloc agent dans le même appel et réutiliser la session encore vivante avec ses tours
  consommés. La réparation passe donc par la MARQUE, pas par l'ordre.
- ~~**B4-exclusions** : les exclusions de cible étaient appliquées APRÈS le `LIMIT` SQL.~~ **CORRIGÉ.** Sur
  30 000 contacts, un plafond de 20 000 et 5 000 exclus dans la fenêtre, la campagne partait vers 15 000
  destinataires. **Elle sous-envoyait en silence** : le nombre affiché est celui qu'on vient de calculer.
- ~~**A2-garde-rcs** : une fenêtre subsistait entre la garde et l'envoi RCS.~~ **CORRIGÉ.** Exactement deux
  attentes séparaient le contrôle du `sendTo`. La règle du lot A2 se précise : « entre les effets » veut dire
  immédiatement avant l'effet, pas avant le travail qui le précède.
- ~~**A3-timeout** : le bouton « Test » n'avait aucun plafond de temps.~~ **CORRIGÉ.** Seul des trois boutons
  de la même famille à ne pas en avoir. ⚠️ Deux moitiés du constat étaient fausses : ce n'était pas illimité
  mais borné au défaut d'undici, **mesuré à 309 s** ; et ça n'immobilisait PAS une place du pool, les lectures
  en base étant terminées avant l'appel. Rien à faire non plus sur `page-distante.ts`, dont le plafond par
  saut est explicite et borne le pire cas.
- ~~**A4-sli** : le SLO d'entrée alarmait sur la mauvaise mesure.~~ **CORRIGÉ.** Le rouge ne se posait que sur
  l'ATTENTE quand le SLO promet un message TRAITÉ en 30 s. `agent-turn` étant un appel modèle, cette file
  serait restée verte quelle que soit la lenteur du modèle. Le p99 promis se lit maintenant sur le pire cas
  bout en bout, qui était calculé et transporté depuis toujours et affiché nulle part.
- ~~**C1-spread** : un commentaire affirmait une garantie du compilateur qui est fausse.~~ **CORRIGÉ.**
  Mesuré, pas raisonné : une propriété en trop dans un littéral DIRECT est refusée (TS2353), la même
  introduite par un SPREAD passe en silence, et un `satisfies` sur le littéral EXTÉRIEUR n'y change rien.
  Seul un `satisfies` sur l'objet INTÉRIEUR du spread la voit. C'est précisément là que vivaient les deux
  capacités de la panne du 2026-09-02.
- **A4-equite** : le réglage rend le SLO 3 arithmétiquement intenable à la cible annoncée. **DOCUMENTÉ, pas
  corrigé, et c'est délibéré.** L'enveloppe manquait à tout le monde : `attente = N × T / C − T`, donc avec les
  valeurs par défaut (tranche de 2 min, 4 runs) le seuil de 5 min tient jusqu'à **environ 13 campagnes longues
  simultanées**, et vaut 10,5 min à 25. ⚠️ **Ne PAS retoucher les deux réglages avant de mesurer** : baisser la
  tranche multiplie un `listPending` non borné (jusqu'à 20 000 lignes), monter la concurrence mange un pool de
  8 connexions déjà partagé. L'ordre des mesures est écrit dans `docs/SLO-2026-09-01.md`. Ce n'est pas une
  panne d'aujourd'hui : 6 jobs `campaign-run` sur sept jours, attente p95 de 0,11 s.

**Ce qui reste ouvert de ce contre-rapport**, et pourquoi : le « DNS rebinding » (déjà listé sous A3), et le
retriage des deux réglages de campagne, qui attend le profil de banc `equite` du lot 6, plus bas.

### Contre-CONTRE-rapport, sur les correctifs ci-dessus (2026-09-03 au soir)

Quatre nouveaux constats, vérifiés dans le code avec passe adverse : **trois confirmés, un réfuté**. Plus un
cinquième point hors tableau, sur mes propres tests, et **deux angles morts trouvés en propre**. Les deux
angles morts et deux des trois confirmés sont des **régressions que j'avais introduites la veille**.

- ~~**P1c, l'épreuve d'une SOURCE sans résolution DNS.**~~ **CORRIGÉ**, et c'était le plus grave. Elle
  appelait `construireCible` puis `fetch` : elle ne voyait donc pas qu'un nom public pointe vers le réseau
  Docker du VPS. C'était le **quatrième** chemin de ce genre, alors que le `CLAUDE.md` affirmait qu'il y en
  avait trois et qu'ils étaient tous gardés. Ce qui l'a fait rater : les deux boutons « Test » se ressemblent
  beaucoup, et l'autre appelait bien la garde. L'inventaire est désormais tenu par un test.
- ~~**P1a, le balayage sortait par « échec » en dur.**~~ **CORRIGÉ.** Juste tant qu'il ne réclamait que des
  sessions `en_cours` ; faux depuis qu'il ramasse aussi les closes dont la sortie est due. Le contact
  repartait par le repli technique au lieu de la branche prévue, et c'est le cas le plus fréquent. ⚠️ Le test
  unitaire du balayage ne voyait PAS le câblage du worker : une garde qui lit la source a été ajoutée, comme
  pour le plafond de campagne. Troisième fois que ce piège se présente.
- ~~**P2, l'index partiel de la 0112.**~~ **CORRIGÉ** (migration 0113, appliquée ; la base est à 0116, cf. le compteur de CLAUDE.md, seule source).
- **P1b, l'escalade humaine : RÉFUSÉ, et c'est un arbitrage.** Les faits sont vrais, c'est le seul couple
  « clore puis sortir » qui ne préserve pas la marque. Mais poser la marque **dégrade le cas le plus
  probable** : le rattrapage existant (le message suivant du contact remonte le fil en inbox ET escalade) est
  meilleur que le balayage, et un contact qui vient de réclamer un humain face à un silence total réécrit
  presque toujours. Le refus est écrit dans `src/agent/escalade.ts` avec sa raison.
- ~~**Point 5, mes deux tests du plafond de temps ne prouvaient rien.**~~ **CORRIGÉ.** Le premier n'assertait
  qu'un signal, le second passait AUSSI sans la garde qu'il tenait. Les faux minuteurs de vitest ne pilotent
  pas `AbortSignal.timeout`, d'où une couture `delaiTestMs`. Même lot : la résolution DNS n'était dans aucun
  budget, les deux s'additionnaient au lieu de se recouvrir.
- ~~**Angle mort 1 : un `Math.min(100_000)` écrasait en silence une limite de cible plus grande.**~~
  **CORRIGÉ.** Le plafond de campagne vit en configuration pour se relever le jour d'un gros client : le geste
  que le produit a prévu était exactement celui qui armait le défaut. C'est le sous-envoi silencieux de la
  veille, transposé du filtre d'exclusion au filtre de taille, trois lignes plus bas.
- ~~**Angle mort 2 : `AGE_TOUR_MORT_S` valait exactement `DUREE_MAX_AVANCE_MS`.**~~ **CORRIGÉ** (15 min).
  Marge nulle : une avance qui va au bout de son temps rend sa ligne réclamable à l'instant où elle abandonne.
  Ferme au passage la course sur `sortieAppliquee`, qui n'a pas de jeton de garde. Deux constantes qui doivent
  être ordonnées se règlent par une valeur, pas par une architecture ; le lien est tenu par un test, parce
  qu'il ne se voit dans aucun des deux fichiers pris séparément.

### Audit de RAYON DE SOUFFLE du lot précédent (2026-09-04) : ce que mes propres correctifs avaient cassé

Nouvelle discipline, née de la question de Julien (« qu'est-ce qui me fait croire que ce que tu as fait n'a
pas détruit autre chose ? »). Pour chacun des six changements du lot, **tous les dépendants ont été énumérés
et vérifiés un par un** : 102 au total, puis un réfuteur par changement chargé de trouver celui qui manquait.
**Aucun comportement cassé, trois risques réels, tous corrigés.**

- ~~**Des tests faisaient un VRAI appel DNS.**~~ **CORRIGÉ.** `tests/page-distante.test.ts` appelait
  `fetchUrlBorne(1000, impl)` à deux arguments, donc la vraie résolution, sur `www.exemple.fr`, un domaine que
  personne ici ne contrôle. Un des tests **passait aussi quand le nom ne résolvait pas** (« hôte non autorisé
  (nom introuvable) » contient bien « hôte non autorisé ») : vert par le chemin du refus, sans jamais
  atteindre la redirection qu'il prétend refuser. Le plafond DNS ajouté la veille avait en plus resserré leur
  marge en CI. **Un test unitaire qui touche le réseau n'est pas un test unitaire**, c'est un test dont le
  verdict appartient à quelqu'un d'autre. Prouvé corrigé en coupant le résolveur par défaut : 7 tests verts.
- ~~**Ma réécriture avait supprimé un cas de test sans le remplacer.**~~ **CORRIGÉ.** L'ancien test exerçait
  « le système coupe la connexion en plein corps », mal asserté mais exercé ; sa réécriture l'a remplacé par
  un cas piloté par l'échéance. Le chemin vivait toujours dans le code et produisait le même faux succès.
  `lireCorpsBorne` distingue désormais un flux CASSÉ d'un corps vide (les deux rendaient `{texte:''}`), et la
  route refuse aussi le corps **trop gros**, qu'elle ignorait alors que ses deux routes sœurs le refusent.
- ~~**Six endroits disaient encore « dix minutes ».**~~ **CORRIGÉ.** Dont le docbloc juste au-dessus de la
  constante à quinze, qui affirmait « même ordre de grandeur que la durée maximale d'une avance » alors que
  tout l'intérêt du changement est de NE PAS l'être ; et `CLAUDE.md`, avec deux affirmations fausses dans une
  seule phrase. Ma justification était en plus **orpheline**, placée après la constante, donc invisible au
  survol.
- ~~**Le `CLAUDE.md` se contredisait sur le compte des chemins sortants.**~~ **CORRIGÉ.** J'avais écrit qu'il
  y en avait quatre à la ligne 392 et laissé « les TROIS chemins concernés » à la ligne 407, plus les copies
  dans `todo.md` et `wip.md`. **Corriger un compte à un endroit et le laisser à trois autres, c'est le
  laisser faux.**

### Contradiction de mon PROPRE lot de correction (2026-09-04) : ce qui reste ouvert

Trois lecteurs indépendants, 71 fichiers ouverts, des scripts exécutés contre un vrai serveur local. **Rien de
cassé.** Quatre défauts trouvés et corrigés (le drapeau câblé sur un consommateur sur trois, une justification
FAUSSE dans mon propre commentaire, un témoin de test qui n'exerçait pas le cas qu'il nommait, un débris de
copier-coller). Ce qui reste ouvert, avec sa raison :

- **Le plafond du bouton « Test » n'est pas aligné sur celui de l'appel RÉEL.** Le test coupe à 40 000 octets
  (`MAX_APERCU * 2`), l'appel réel à `agent_tools.max_bytes` (défaut 16 384, réglable jusqu'à 262 144). Il
  existe donc des réglages valides où le bouton refuse une réponse que la production accepterait, et
  l'inverse. **Ce n'est pas une régression** : avant, une réponse de plus de 40 Ko donnait déjà un aperçu vide
  et zéro chemin, le bouton était donc déjà inutilisable au-delà. L'alignement exact est impossible (le test
  ne connaît pas l'outil qui utilisera la requête), donc à trancher : soit on affiche la borne à l'écran,
  soit on la fait remonter du plus permissif des outils qui désignent cette requête.
- **`sortieAppliquee` n'a toujours pas de jeton de garde.** La course est devenue INATTEIGNABLE en écartant
  `AGE_TOUR_MORT_S` de `DUREE_MAX_AVANCE_MS`, mais la pièce manque : il faudrait faire remonter l'instant de
  marque à travers `clore` puis `cloreEtSortir`, donc deux signatures.

**Vérifié et écarté** : `asIdArray` (`src/http/contacts.ts:91`) tronque les identifiants d'une action en
masse à 100 000, mais c'est **documenté dans son propre commentaire** et préexistant. Et le plafond DNS de 3 s
tombe DANS le budget d'outil de 8 s d'un tour d'agent, qu'il RÉDUIT au lieu de l'augmenter.

**Ce qui reste ouvert :** un jeton de garde sur `sortieAppliquee` (la course est devenue inatteignable par
la constante, mais la pièce manque toujours ; elle coûterait de faire remonter l'instant de marque à travers
deux signatures) ; et le compte jugé par le plafond de campagne inclut les contacts **bloqués**, alors que le
chargement des destinataires les filtre. Ce dernier **sur-compte** au lieu de sous-envoyer, donc le sens est
le bon, et il est préexistant.


Les sept lots de [docs/PLAN-POST-AUDIT-2026-09-02.md](docs/PLAN-POST-AUDIT-2026-09-02.md) sont **livrés et
déployés** (2026-09-02 au soir), ainsi que le point 1 de l'audit qui a suivi. Ce qui reste, dans cet ordre :

~~**A2 — arrêter les EFFETS à la perte du bail d'avance.**~~ **LIVRÉ le 2026-09-03.** Le battement expose
désormais `perduPourquoi()`, consulté avant CHAQUE effet dans `apply`, avant l'envoi RCS de `walkResolved` et
avant l'enfilement d'un tour d'agent ; une durée totale maximale de dix minutes abandonne une avance PENDUE
(le seul mode de panne que battre ne distinguait pas). ⚠️ **Un point de la demande a été volontairement NON
fait** : l'`AbortSignal` est exposé mais AUCUN transport ne l'écoute. Couper un envoi Meta en plein vol
échangerait « un message de trop » contre « un message parti que nous n'avons pas enregistré », qui est pire.
La garde se pose donc ENTRE deux effets. Le signal servira aux travaux réellement annulables (recherche de
connaissance, reranker, lecture de connecteur).

~~**A1 — rattraper un tour d'agent tué par un crash.**~~ **LIVRÉ le 2026-09-03** (migration 0112). Le
watchdog prévu : `src/agent/tour-bloque-sweep.ts`, passage à la minute, réclame et clôt en UNE requête les
tours en vol depuis plus de QUINZE minutes, puis fait sortir le parcours par la sortie RÉELLEMENT DUE (le
seuil était de dix, corrigé le 2026-09-03, et la sortie était en dur). On ne rejoue
pas, comme arbitré : le worker a pu mourir APRÈS l'envoi au contact. ⚠️ Il a fallu une COLONNE
(`tour_commence_le`) : « session en cours + run en attente + aucune échéance » décrit aussi un tour qui vient
d'être enfilé, et un balayage bâti là-dessus aurait tué des conversations vivantes.

~~**A3 — les deux bornes de sécurité des connecteurs HTTP.**~~ **LIVRÉ le 2026-09-03.** Résolution DNS
contrôlée (`src/lib/adresse-privee.ts`) sur les QUATRE chemins qui appellent une URL saisie par un client (le
compte a dit trois pendant un jour, l'épreuve d'une SOURCE manquait) : le
connecteur en conversation, le bouton « Test » d'une REQUÊTE, le bouton « éprouver » une SOURCE, et la lecture
de page distante (à chaque saut de redirection). Lecture bornée EN FLUX (`src/lib/corps-borne.ts`) sur les
TROIS qui lisent un corps, en OCTETS et non en unités UTF-16 (l'épreuve d'une source ne regarde que le
statut : dire « sur les mêmes » après avoir monté le compte à quatre serait faux). ⚠️ **Ce qui reste ouvert, et il faut le dire** : la vérification a lieu AVANT l'appel et `fetch` refait
sa propre résolution, donc le « DNS rebinding » (répondre public puis privé) n'est pas fermé. Le fermer exige
de fournir son PROPRE résolveur à la couche HTTP (`undici`, `connect.lookup`), donc une dépendance directe de
plus. Le scénario suppose un administrateur client hostile, qui a déjà son compte : le rapport ne le justifie
pas aujourd'hui. Le cas réaliste, un nom public qui pointe vers l'intérieur, est fermé.

~~**A4 — la preuve de capacité.**~~ **LIVRÉ le 2026-09-03.** La photo compte désormais
les jobs `active` (elle retombait à zéro sur un job coincé), un VRAI p95 par file est calculé sur 24 h depuis
les horodatages que pg-boss écrit déjà (aucune instrumentation ajoutée, elle existait et personne ne la
lisait) et affiché dans `/ops`, l'affirmation fausse du document de SLO est retirée, et le banc agent a
désormais un mode DURÉE avec découpe par minute, et **il a tourné six minutes sur le VPS** : 1 406 tours,
738 000 tokens/minute, **zéro refus**, et aucune dérive (la durée moyenne DESCEND de 1 445 à 1 217 ms d'une
minute à l'autre). Le Gateway n'est pas le prochain plafond, et ce n'est plus une extrapolation. La mesure
longue a aussi montré une QUEUE que les rafales cachaient : 113 s pour le tour le plus lent contre 2,4 s de
médiane, soit 0,14 % des tours au-dessus de 30 s, c'est-à-dire exactement ce que `DEADLINE_MS` protège.
**Reste seulement** le profil `equite` du banc de charge, déjà listé plus bas.

🔴 **Ce que la mesure a trouvé au passage, et qui n'était dans aucun audit** : `webhook-status` se vidait à
DEUX jobs par minute (sondage 30 s, un job par sondage, travail de 0,05 s), soit 125 heures pour absorber les
15 000 accusés d'une campagne de 5 000 destinataires. Corrigé par `burstWhenReadyExceeds`. Chiffres et leçon
dans `docs/SLO-2026-09-01.md`.

**B et C de l'audit, état au 2026-09-03** (vérifiés un par un DANS LE CODE, avec contre-vérification adverse,
parce que le « lot immédiat » du 2026-09-02 en avait déjà fermé une partie et que l'audit est donc périmé par
endroits) :

- ~~**B2** sémantique de la télémétrie du pool~~, ~~**B3** validation stricte des concurrences et plafonds~~,
  ~~**B5** faux 500 sur une source absente~~ : **livrés le 2026-09-02** (lot immédiat, `f711743`).
- ~~**B4** course du plafond « tous les contacts »~~ : **livré le 2026-09-03**. Le chemin résout et FIGE son
  jeu d'identifiants, borné à `plafond + 1`, au lieu de compter puis recharger. ⚠️ La contre-vérification a
  trouvé le trou que mon propre correctif avait laissé : le câblage relayait `(tenant, target)` vers un
  contrat à trois paramètres, donc la borne était avalée EN SILENCE et le compilateur ne pouvait pas le voir
  (une flèche plus courte est assignable). Gardé par `tests/campagne-cablage.test.ts`.
- ~~**C2** contradictions documentaires~~ : **livré le 2026-09-03**, et le pire des trois n'était pas un
  document : l'infobulle « vous avez la main » promettait à l'opérateur, dans le produit, que les campagnes
  n'enverraient pas. C'est l'inverse du code, qui passe `ignoreHumanControl` et REPREND la main, délibérément.
- ~~**C3** attribution RCS~~ : **livré le 2026-09-03** (textuel). La phrase « le détail par campagne reste
  reconstructible » de la 0107 était fausse, et l'entrée de backlog décrivait un manque déjà comblé.
- **B1** échecs d'avance : **partiellement livré le 2026-09-03**. Le contexte (parcours, run, canal) traverse
  désormais, donc la jointure sur le nom du scénario sert enfin à quelque chose. ⚠️ **Trois points restent
  OUVERTS, et c'est un choix**, pas un oubli :
  (b) aucune déduplication (un rejeu Meta peut écrire deux lignes pour le même message) : demanderait une
  migration avec index unique `concurrently`, pour un journal d'exploitation dont les doublons se lisent ;
  (c) aucun état acquitté/résolu : demanderait une migration, une route d'écriture et un bouton, alors que
  personne n'a encore eu à exploiter cette table ;
  (d) purge globale sans index sur `at` : la table est petite par construction (une ligne par ÉCHEC, 90 jours
  de rétention), un balayage séquentiel quotidien n'y coûte rien.
  ⚠️ Et une fausse piste à ne pas suivre : passer `alreadySeen` à l'avance pour dédupliquer CASSERAIT la
  reprise, `insertEvent` marquant l'événement dès la première tentative, donc un rejeu pg-boss trouverait tous
  ses messages « déjà vus » et n'avancerait plus rien.
- ~~**C1** capacités imbriquées~~ : **livré le 2026-09-03**, et l'audit généralisait à tort (« recopiés de
  fichier en fichier »). Inventaire fait : **14 `Pick<` dans `src/`, 13 sont des contrats étroits légitimes,
  UN SEUL était un passe-plat**, `src/campaign/run-job.ts`, et c'est celui qui avait déjà cassé la production.
  Ses onze capacités voyagent maintenant dans un objet `moteur` transmis d'un seul spread : il n'y a plus de
  liste à tenir alignée. Gardé par trois tests de forme (`tests/clics-cablage.test.ts`), vérifiés dans les deux
  sens. Les 13 autres `Pick` n'ont pas été touchés : leurs membres sont consommés sur place, donc un oubli y
  est déjà une erreur de compilation.
- ~~**C4** découpage des gros fichiers~~ : **refusé, et la contre-vérification a tranché**. Les mesures
  (`worker.ts` 877 lignes de code, `executor.ts` 680, `CampaignCreateForm` 1 319) ne justifient pas un
  découpage, et le dépôt l'avait déjà refusé nommément le 2026-08-31 avec un meilleur argument. Le seul défaut
  VIVANT que cet item recouvrait a été corrigé au passage : deux balayages sur vingt-deux journalisaient leur
  échec sans ALERTER (`vectorisation` et `analyse-conversations`), donc une panne y restait invisible.

**Ajouté le 2026-09-02 (lot 5) : écrire le profil `equite` du banc de charge**, après le lot 6.
`docs/SLO-2026-09-01.md` l'annonçait comme une commande existante alors que `scripts/banc-charge.mts` ne la
contient pas ; la promesse est retirée du document. Il faut : deux espaces sur la même file à groupe, l'un
bavard et l'autre discret, et la mesure de l'attente du DISCRET, seuil 5 minutes. ⚠️ Il exige un Postgres
jetable ET un worker en face, sinon il mesure une file morte.

**Ajouté le 2026-09-15 (revue finale des assistants) : journaliser les CRÉATIONS et les MODIFICATIONS faites
depuis les onglets**, sur les deux surfaces. Aujourd'hui l'historique porte tout ce que les assistants
appliquent, plus les SUPPRESSIONS des formulaires (les quatre du MBA, les fiches de connaissance d'un agent).
C'est un ordre de priorité assumé : chez Meta une suppression est définitive et la ligne d'historique en est le
seul exemplaire, quand une création ratée se refait. ⚠️ En attendant, **l'écran le DIT** (`HistoriquePanel`),
parce qu'un journal qui promet plus qu'il ne montre fait conclure « ça n'a pas eu lieu » là où il faudrait lire
« ce n'est pas encore journalisé ». Les routes à couvrir : `PATCH /tenants/:t/agents/:id` (la fiche), les
écritures d'outils (`agent-tools.ts`), et les créations de FAQ, compétences, sites et documents du MBA.

**Ajouté le 2026-09-15 : la garde `field !== 'messages'` est INERTE, lui donner un signal vrai.** Mesuré sur
30 jours de webhooks : un message entrant arrive TOUJOURS sur `messages`, même quand l'agent de Meta tient le
fil (cas daté : 2026-09-15 07:58:39). Tout ce qui devait se taire quand l'agent tient le fil (déclencheurs
d'automation, avance de scénario, jeton de test) teste ce champ, et ne se tait donc jamais. ⚠️ Ce n'est pas un
trou vivant : un scénario qui démarre PREND le fil explicitement, donc il ne parle plus par-dessus l'agent. Le
signal vrai est notre colonne `control_owner` (alimentée par `standby` et `messaging_handovers`), pas le
`field` de l'entrant. À retrancher là-dessus.

Ce `todo.md` reste le **backlog de fond et l'historique des lots livrés**. Il ne porte PAS le séquencement : un
ordre écrit à deux endroits diverge, c'est déjà arrivé entre `PLAN.md` et ce fichier.

**Deux décisions produit tranchées le 2026-08-31** : **un seul numéro WhatsApp par client** (le chantier
multi-numéro sort du plan, remplacé par un refus explicite du second) et **conversations gardées 12 mois**
(plancher de 3 mois donné par Julien, quadruplé parce que l'effacement est irréversible).

## Ce que l'audit documentaire du 2026-09-08 laisse ouvert (trié le 2026-09-09)

L'essentiel est fait : le manuel est séparé de son journal, le README est redevenu un portail, et trois
contrôles automatiques empêchent le retour des dérives (compteur recopié, titre daté, lien mort). Restent
deux items, tous deux P2 ou P3 dans l'audit, aucun urgent.

🟠 **Classer les variables d'environnement, et faire de `src/config.ts` la source GÉNÉRATRICE.** Le schéma zod
porte une centaine de clés, `.env.example` en montre dix-neuf. Le manuel les range désormais en cinq familles
(secrets obligatoires, interrupteurs, capacité, rétention, paramètres commerciaux), mais cette table est
écrite à la main : c'est exactement ce qu'on vient d'interdire ailleurs. La vraie fermeture est un générateur
qui produit `.env.example` depuis le schéma. ⚠️ Ne PAS toucher au chargement des variables au passage :
documenter d'abord, générer ensuite.

🔵 **Un contrat OpenAPI pour l'API publique v1.** Utile le jour où on ouvre l'API à des intégrateurs, inutile
avant. ⚠️ À GÉNÉRER depuis le code, jamais à écrire à la main : un contrat écrit à part est un second
inventaire, donc une divergence programmée. Aucun besoin aujourd'hui, personne ne l'a demandé.

⛔ **Écarté : formaliser des ADR.** L'audit le classe P3 en notant lui-même le risque de double documentation.
Le « pourquoi » d'une décision vit déjà dans le journal technique et dans les invariants du manuel ; en faire
un troisième endroit garantirait qu'un des trois soit faux.

## Un refus d'automation n'a AUCUN écran (relevé au lot « la chaîne reprend la main », 2026-09-08)

🟠 **Le symptôme, vécu.** Un bouton de chaîne cliqué ne lançait pas son scénario. Le refus était légitime (le
fil appartenait à l'agent de Meta) et il était écrit, mot pour mot, dans le journal du worker. Nulle part
ailleurs : ni pour l'abonné, ni dans la console, ni sur l'écran des chaînes, qui affichait au même moment
« N personnes ont envoyé ce message » juste à côté. Trois heures de recherche du côté du bouton, de l'URL et
du mot-clé, pour des composants qui n'avaient rien.

**Ce lot a fermé LA cause dominante** (un clic de chaîne reprend désormais la main), mais pas la classe : les
trois autres refus de `runAutomations` restent aussi muets (anti-rebond, condition non satisfaite, plafond
horaire), et le prochain refus se diagnostiquera de la même façon, c'est-à-dire mal.

**La piste, sans alourdir.** Il existe déjà une table de journal d'exploitation purgée à intervalle
(`erreursLivraison`, les échecs d'avance, avec sa rétention et son écran). Y écrire les refus d'automation
avec leur raison, leur automation et leur contact donnerait l'endroit qui manque, sans nouvelle mécanique ni
nouvelle migration de structure. ⚠️ **À borner d'abord** : un refus par anti-rebond peut se produire des
milliers de fois par heure sur une chaîne qui marche, donc soit on n'écrit que les refus RARES (fil tenu,
condition, plafond), soit on agrège. Écrire tous les refus tels quels remplirait la table plus vite que les
envois eux-mêmes.

## Reste de l'audit sécurité du 2026-09-07

L'audit a trouvé le parc en bon état (secrets, RLS, isolation tenant, injection SQL, journalisation,
sessions : tous propres, détail dans `documentation.md`). Le seul trou de code, le plafond de débit des
routes authentifiées, est FERMÉ le jour même. Restent trois choses, par ordre de valeur.

### ✅ S'attaquer soi-même : FAIT (2026-09-07)

`scripts/auto-attaque.mts`, dans la CI. 540 sondes, inventaire pris sur le serveur construit, vérifiée dans
les deux sens (4 failles plantées, 4 détections). Détail dans `documentation.md`.

**⚠️ Question ouverte, petite mais réelle : la CI inventorie UNE route gardée de moins que ce poste** (168
contre 169, donc 148 gardées contre 149). Les deux runs sont verts et le run local couvre le sur-ensemble,
mais un écart d'inventaire est un écart de COUVERTURE : une route qui ne se monte pas en CI est une route que
la CI n'attaque jamais. Ce n'est PAS le `.env` (vérifié : même table de routes avec et sans), ni les routes
`/auth` (les 9 sont là), ni la version de Fastify (5.12.1 des deux côtés). Reste la version de Node (24 ici,
22 en CI). `npx tsx scripts/auto-attaque.mts --inventaire` imprime la liste complète : la comparer avec celle
d'un run de CI tranche en dix secondes.

**Ce qu'elle ne couvre PAS, et qui reste à faire un jour** : elle n'a jamais tourné contre la PRODUCTION.
Le mode distant est écrit et gardé, mais la couche NPM / Cloudflare / CORS réel n'a donc pas encore été
attaquée. Il faut pour ça un compte de test dédié dans un espace jetable. C'est une demi-heure, et c'est le
seul endroit où peuvent vivre des failles que le mode local ne verra jamais.

### ✅ Dépendances de `web/` remontées (2026-09-07)

`npm update` (plages semver respectées, `package.json` inchangé, seul le lock bouge) : **de 12
vulnérabilités à 7**. Fermées : `sharp`, `nanoid`, `js-yaml`, `browserslist`, `brace-expansion`, et `next`
15.5.20 -> 15.5.25 qui retombe de « high » à « moderate ». Build compilé, 213 tests web verts.

🔴 **Les 7 restantes ne sont pas ATTEIGNABLES ici, et c'est la seule raison de les laisser.** Ne pas les
rouvrir sans relire ceci :

- **`postcss`** : le nôtre est en 8.5.28, corrigé. Ce qui reste est le `postcss@8.4.31` que **Next embarque
  en interne**. Les trois avis portent sur un `sourceMappingURL` attaquant dans un commentaire CSS : notre
  CSS est le nôtre, compilé sur Vercel, personne d'extérieur n'en fournit à notre build.
- **`vitest` / `vite` / `esbuild` / `vite-node`** : l'avis critique vise l'**UI de Vitest**
  (`vitest --ui`), qu'on ne lance jamais, dans une dépendance de DEV qui n'est pas déployée.

Le seul correctif que npm propose pour les deux premiers est **next 16**, une majeure. À traiter comme un
chantier à part, avec `tailwindcss` 4, `typescript` 7, `eslint` 10 et `vitest` 5, jamais au passage d'un
`npm update`.

### 🟡 Trois broutilles relevées au passage

- **Trois faux positifs gitleaks** (`docs/MBA-API-REFERENCE.md`, `mba documentation/*`) : ce sont des
  exemples de format PEM recopiés de la doc Meta. Le hook `pre-commit` ne scanne que l'index, donc il ne
  bloque rien aujourd'hui, mais il bloquera le jour où on retouche un de ces trois fichiers. Un
  `.gitleaksignore` règle ça.
- **Un webhook entrant SANS secret** est un chemin d'écriture non authentifié (il crée des contacts et
  déclenche des automations, donc des envois facturés). Choix documenté et borné (code non devinable,
  limiteur avant la base), mais l'UI devrait AVERTIR à la création d'un webhook sans secret.
- **Deux chemins d'upload qui ne se protègent pas pareil** : `src/http/media.ts` fait confiance au type MIME
  déclaré dans la data URL (allowlist par regex), là où `src/rcs/image.ts` lit les octets magiques. Risque
  faible aujourd'hui (Meta valide derrière), mais c'est l'écart qui devient une faille quand quelqu'un
  branche un troisième consommateur sur le premier.

## Contre-audit du 2026-09-01 : ce qui est retenu, verifie dans le code

L'audit complet est `AUDIT-COMPARATIF-STRUCTURE-SCALABILITE-2026-09-01.md`. Six de ses constats ont ete
REVERIFIES dans le code avant d'etre inscrits ici ; les six etaient vrais. Ce qui suit est le reste
actionnable, trie. Deux items sont deja faits (le typecheck du WIP, ferme par la brique C ; le texte du
palier et le commentaire du banc, fermes le jour meme).

**1. ✅ FAIT le 2026-09-01 (migration 0102).** Le debit par numero est desormais partage entre l'API et le
worker : le compteur en memoire devient une ligne, la reservation une instruction SQL atomique, et l'attente
se fait HORS de la base. Panne de la base = repli sur le frein local, donc le pire cas est le comportement
d'avant. La PRIORITE (faire passer l'inbox devant une campagne) n'est PAS faite et n'etait pas le sujet :
elle demanderait une file d'envoi ordonnee, donc de la latence sur le chemin interactif. Detail dans
`documentation.md`. Le constat d'origine, garde pour memoire :

~~**Le debit par numero n'est PAS partage entre l'API et le worker.**~~ `src/index.ts:192` et
`src/worker.ts:193` construisent chacun leur arbitre en memoire. Les deux conteneurs tournent DEJA en
production : pendant qu'une campagne part du worker, un operateur qui repond depuis l'inbox consomme un
SECOND budget sur le meme numero. Le debit affiche n'est donc pas une propriete du numero.
⚠️ Ce n'est pas un sujet de gros volume : ca se produit avec un client et deux messages.
**Decision a prendre avant de coder** : soit une file d'envoi durable partitionnee par numero (l'ordre et
les priorites deviennent simples, la latence interactive augmente), soit un compteur partage en base avec
bail (les chemins directs restent directs, une brique de coordination apparait). Test d'acceptation dans les
deux cas : une campagne, un scenario et un envoi inbox lances ensemble depuis DEUX process.

**2. ✅ FAIT le 2026-09-01.** La cible part en INTENTION (`contactTarget`), resolue en base, avec le MEME
analyseur que les actions en masse du mini-CRM. Quatre refus ferment le pire accident (une campagne a tout
l'espace), dont un trou PRE-EXISTANT : `contactIds: []` etait truthy et retombait sur « tous les contacts ».
Le decoupage SQL du moteur (`listPending` sans limite) reste NON FAIT, hors sujet decide par Julien.
Le constat d'origine, garde pour memoire :

~~**Le piege des 25 000 destinataires.**~~ Le front propose jusqu'a 100 000 contacts
(`idsForFilters`, cap 100 000), met tous leurs identifiants dans le POST, et la route plafonne a 1 Mo
(`src/server.ts:209`). Le JSON des seuls identifiants pese environ 975 Ko a 25 000 contacts : la casse
arrive donc bien AVANT la limite que l'ecran annonce. L'interface promet quelque chose qui echoue.
⚠️ Julien a mis les campagnes de 100k hors sujet pour l'instant, mais le piege, lui, reste pose.
La moitie du correctif ne coute presque rien : `BulkTarget` EXISTE deja dans le mini-CRM
(`{ filters, excludeIds } | { ids }`), il suffit d'envoyer l'INTENTION de selection et de la resoudre dans
la transaction. Le decoupage SQL du moteur (`listPending` sans limite) est un chantier separe, non retenu.

**3. ✅ FAIT le 2026-09-01.** La route sert un RESUME (`listResume`) : plus aucun graphe ne traverse le
reseau pour afficher des noms. `nodeCount` et `hasDraft` sont calcules en SQL, `campaignEligible` cote serveur
avec la MEME fonction que la garde de creation. `list()` reste inchangee (la resolution par code en a besoin).
⚠️ La base envoie toujours le graphe a l'application : seul le trajet vers le navigateur disparait. Aller plus
loin demanderait de denormaliser en colonnes tenues a l'ecriture, avec le risque de peremption. Le constat :

~~**La liste des scenarios renvoie DEUX graphes complets par ligne**~~ (`graph` et `draft_graph` sont
tous les deux dans `COLS`, `src/workflow/store.pg.ts:29`), pour des ecrans qui n'affichent qu'un nom.
Correctif : une projection resumee et paginee (id, code, nom, dates, brouillon en attente, nombre de blocs,
eligibilite campagne), le graphe complet restant sur `GET /workflows/:id`.
⚠️ Deux consommateurs empechent un simple retrait : `estEnLigne` a besoin du nombre de blocs, et le
selecteur de scenario de l'inbox appelle `isCampaignEligible(w.graph)`. Les deux doivent devenir des
champs calcules cote serveur, avec un test de parite, sinon la regle existe a deux endroits.
**Declencheur** : avant environ 100 scenarios par espace.

**4. ✅ FAIT le 2026-09-01 (migration 0103).** `pause_reason` + `paused_until`, un balayage qui reprend les
pauses de DEBIT echues (reclamation atomique), et une pause de QUALITE qui n'est JAMAIS reprise par une
machine. L'angle mort du 429 sans code connu est ferme aussi : il entre desormais dans `estPlafondNumero`.
Le constat d'origine, garde pour memoire :

~~**La pause Meta ne reprend jamais toute seule.**~~ Le texte est corrige (il dit desormais que la reprise
est manuelle), mais la reprise elle-meme reste a faire : `pause_reason` + `paused_until`, un debit temporaire
reessaye apres un `Retry-After` borne, une qualite degradee JAMAIS reactivee aveuglement.
⚠️ Angle mort a traiter en meme temps : un HTTP 429 sans code Meta connu n'entre pas dans `estPlafondNumero`
et finit en echec destinataire au lieu d'une pause globale.

**5. 🟠 PARTIELLEMENT FAIT le 2026-09-01.** Les SLO sont ECRITS AVANT toute mesure
(`docs/SLO-2026-09-01.md`, trois objectifs avec leurs seuils), l'age du plus vieux job PRET est instrumente
dans `/ops` (c'est la mesure qui les rend observables, la profondeur seule ne dit rien), et le profil
« entrants » du banc existe enfin (`webhooks <n>`).
⚠️ RESTE OUVERT, et c'est ecrit dans le document lui-meme : le SLO 3 (equite entre espaces) n'est
qu'A MOITIE instrumente. `/ops` donne l'age par FILE, pas par espace : un espace affame derriere un espace
bavard reste invisible. Le geste suivant est d'ajouter `group_id` au regroupement de `getQueueLoad`. Et le
profil `equite` du banc n'est pas ecrit. Le constat d'origine :

~~**Le banc de charge ne mesure pas ce qu'on lui prete.**~~ Il prouve la reprise apres kill d'une campagne
de 400 destinataires sur un worker, et rien d'autre. Manquent : le debit des entrants et son p95, l'equite
entre espaces, la rafale d'accuses, la concurrence API + worker sur un meme numero, deux workers.
🔴 **Ecrire les SLO AVANT les profils** : un resultat sans seuil d'acceptation est une observation, pas une
preuve de capacite. Trois suffisent pour commencer : delai d'un entrant, delai avant premier envoi de
campagne, age du plus vieux job par espace.

**5bis. ✅ FAIT le 2026-09-02 : le plafond de debit des entrants est leve.** La premiere mesure contre les
seuils avait donne 120 s sur une rafale de 400, soit 1,5 message/s, et j'avais conclu a un arbitrage cout
contre latence a soumettre a Julien (relever la concurrence, ou baisser la cadence de sondage). C'etait une
fausse alternative : pg-boss 12.25, DEJA installe, sait reveiller ses workers par `LISTEN/NOTIFY`. Mesure sur
le meme banc, meme rafale : 22 ms d'age maximum, 400 jobs sur 400 traites, latence moyenne 7 ms. Le levier que
Julien demandait (sondage a 0,5 s) a ete mesure aussi, honnetement : 6,06 msg/s, exactement la prediction de la
formule, et le seuil de 30 s reste DEPASSE (65 s). Detail et preuves : `docs/SLO-2026-09-01.md`.

⚠️ **Ce qui reste ouvert la-dessus, et qui est petit.** Le filet de sondage a ete pose EGAL a la cadence
d'avant, pour que le pire cas du changement soit exactement le comportement d'hier. Le defaut pg-boss serait de
30 s. Le relacher vaudrait quinze fois moins de sondage a vide sur les entrants, donc autant d'egress : c'est
une SECONDE decision, a prendre sur des mesures de production une fois l'ecouteur eprouve, jamais le jour de sa
mise en service.

**6. Non retenu, et pourquoi.** Le VERSIONNAGE IMMUABLE des scenarios (`workflow_versions`) : Julien a
tranche le 2026-09-01, « on s'encombre pas de l'ancienne version » et « tant pis on assume que le user tombe
dans le vide ». Ce n'est donc pas une dette, c'est un arbitrage. Ce qui reste utile et pas cher : **dire au
moment de publier combien de parcours vivants vont etre affectes**. Ne plus le faire les yeux fermes.

## L'attribution des clics par campagne est APPROCHÉE, pas exacte (relevé au lot RCS, 2026-09-02)

⚠️ **Le titre de cette entrée était faux et il est corrigé le 2026-09-03** : il disait « les clics ne se
voient PAS sur le rapport d'une campagne », ce qui n'est plus vrai depuis `e77434d` (2026-08-22). Le rapport
de campagne PORTE un compteur de clics (`urlClicks`, `src/stats/store.pg.ts`). Une entrée de backlog qui
décrit un manque déjà comblé fait chercher un travail qui n'existe plus.

Les clics s'affichent donc à **trois** endroits :
- le rapport de campagne (funnel), depuis le 2026-08-22 ;
- Analytics > Mes tableaux, par BLOC DE SCÉNARIO (templates depuis le 2026-08-20, blocs RCS depuis le 2026-09-02) ;
- la fiche du mini-CRM, indirectement, via l'indicateur « Engagé » qui compte désormais un clic.

**Ce qui reste vraiment ouvert est l'EXACTITUDE, pas l'affichage.** Un lien tracé n'existe qu'une fois par
(tenant, destination) : deux campagnes qui envoient la même adresse au même contact dans une fenêtre
rapprochée partagent le compteur, et rien en base ne dit laquelle a produit le clic. Le rapprochement par
proximité de temps tranche par convention. C'est acceptable tant qu'on ne VEND pas d'analytique détaillée ;
le jour où on la vend, il faudra une dimension de plus sur le lien, donc une porte à sens unique (les liens
déjà envoyés continuent de circuler).

🔴 **CETTE ENTRÉE S'EST TROMPÉE UNE SECONDE FOIS, ET DANS L'AUTRE SENS. Corrigé le 2026-09-08.** Elle
affirmait : « une campagne DIRECTE (sans scénario) n'a donc aucun compteur de clics, sur aucun des deux
canaux ». C'est l'INVERSE. Le comptage filtre sur `template_name is not null` : il sert donc les campagnes
à TEMPLATE, c'est-à-dire précisément les campagnes directes, et rend `null` pour les campagnes à SCÉNARIO,
dont `template_name` est nul. Vérifié dans `src/stats/store.pg.ts` en écrivant le lot E, et gardé par un
test d'intégration qui exerce les deux cas.

✅ FAIT le 2026-09-09 : les clics d'une campagne à SCÉNARIO sont rattachés, bloc par bloc, dans la fiche
qui s'ouvre en cliquant une ligne du tableau du coût. L'attribution est celle des envois (la dernière
campagne scénario réclamée pour ce numéro avant le clic), et elle s'appuie sur
`tracked_link_clicks.contact_id` (migration 0106). La case du TABLEAU, elle, dit désormais « sans lien
tracé » et non « non attribuable », qui se lisait comme une panne d'attribution alors qu'il n'y a
simplement rien à mesurer.

⚠️ CE QUI RESTE, ET C'EST DÉFINITIF : les clics venus d'un template approuvé AVANT le 2026-09-02 portent
une URL figée chez Meta, sans jeton, et n'auront jamais d'identifiant. La fiche les compte à part et dit
pourquoi. Aucun code ne changera ça.

⚠️ Deux entrées de backlog fausses sur le même sujet, à un jour d'intervalle, dans les deux sens : ce qui
les a produites n'est pas l'inattention, c'est d'avoir décrit le code de mémoire. Une affirmation sur ce que
le code fait se relit DANS le code avant d'être écrite ici, ou ne s'écrit pas.

⚠️ À dire honnêtement le jour où on le fera : le compteur sera juste pour les envois ATTRIBUÉS, et muet pour
les templates approuvés avant le 2026-09-02, dont l'adresse figée chez Meta ne porte pas de jeton.

## Des faux de test mentent encore au compilateur (relevé au lot « le déclencheur gagne », 2026-09-07)

Le lot en a corrigé quatre, qui portaient un `as unknown as WorkflowExecutorDeps['runs']` ou un
`deps as never`. Ils avaient fait exactement ce qu'un transtypage fait : quand `closeActiveByWaId` est
devenue requise, le compilateur a nommé les fabriques honnêtes et **a laissé passer les menteuses**, qui ont
planté à l'exécution.

Il en reste, sur d'AUTRES dépendances : une dizaine de `as unknown as WorkflowExecutorDeps['agentSessions']`
et `['rcs']` (`tests/workflow-executor.test.ts`, `tests/workflow-avance-concurrente.test.ts`), et deux
`new WorkflowExecutor(deps as never)` (`tests/workflow-action-optin.test.ts`,
`tests/workflow-mesure-blocs.test.ts`, dont le `runs` est désormais honnête mais pas l'objet entier).

Le même incident les attend au prochain changement de ces contrats-là. À typer, fichier par fichier, quand
on touche l'un d'eux : ce n'est pas un chantier à mener d'un bloc.

## `workflow_runs_waiting_idx` est-il devenu redondant ? (relevé au lot « le déclencheur gagne », 2026-09-07)

La migration 0115 ajoute `workflow_runs_actif_idx (tenant_id, wa_id) where status in ('waiting','sleeping')`,
parce qu'aucun index ne servait la clause de `closeActiveByWaId`, désormais appelée par destinataire de
campagne.

Il rend PROBABLEMENT `workflow_runs_waiting_idx (tenant_id, wa_id) where status = 'waiting'` redondant :
une requête `status = 'waiting'` implique `status in ('waiting','sleeping')`, donc Postgres devrait pouvoir
se servir du nouveau. « Devrait » n'est pas une mesure, et cet index-là sert `findWaitingByWaId`, lu sur le
chemin chaud de CHAQUE message entrant : on ne le retire pas sur un raisonnement.

**0115 est appliquée depuis le 2026-09-07 au soir**, `indisvalid = true`, et le planificateur prend bien le
nouvel index sur la requête de `closeActiveByWaId` (`Index Scan`, là où c'était un `Seq Scan`). **Ce qu'il
reste à faire** : `explain` la requête de `findWaitingByWaId` en production et regarder QUEL index elle prend. Si elle prend le nouveau, le retrait de
l'ancien devient une migration additive de plus (un index en moins, c'est de l'écriture en moins sur une
table du chemin chaud). Si elle prend l'ancien, on garde les deux et on écrit pourquoi.

## L'état de Meta se lit connecteur par connecteur, en séquence (relevé à la revue du 2026-09-10)

🟡 `etatMeta` (câblage de `mbaPublication`, `src/index.ts`) demande la liste des connecteurs, puis les outils
de CHAQUE connecteur, l'un après l'autre. Un espace à dix connecteurs fait onze allers-retours chez Meta
avant d'afficher le moindre aperçu, et l'aperçu est appelé deux fois par publication (une fois pour montrer,
une fois pour recalculer au moment d'appliquer).

**Pas corrigé, et c'est délibéré** : sur le parc réel (une source déclarée, zéro connecteur chez Meta au
2026-09-10), la question ne se pose pas encore, et paralléliser sans mesure serait de l'optimisation à
l'aveugle. ⚠️ Ce qui le rendrait urgent : un premier client avec plusieurs systèmes branchés. Le jour venu,
`Promise.all` sur la boucle des connecteurs suffit (ce sont des LECTURES, aucune ne dépend de la précédente),
mais il faudra regarder ce que Meta plafonne en débit avant d'en lancer dix d'un coup.

⚠️ Ne pas confondre avec le contexte de publication (`ctx`), déjà posé : lui mémorise les lectures pendant
l'APPLICATION du plan, il ne touche pas au calcul de l'état initial.

## Le rangement en lot fait UN appel par conversation (relevé à la revue du 2026-09-08)

🟡 Cocher vingt conversations et choisir une destination produit vingt requêtes, envoyées à la suite. C'est
tenable : on ne coche que ce que l'écran affiche (cinquante lignes au maximum), et le geste est rare.

⚠️ Le constat portait sur le seul archivage ; depuis le 2026-09-09 la sélection va dans QUATRE destinations
(« à traiter », « signalé », « archivé », « désarchiver »), donc le même N+1 vaut pour chacune. Il n'a pas
empiré pour autant : c'est toujours un appel par ligne cochée, quelle que soit la destination.

Ce qui le rendrait faux : une case « tout sélectionner » sur le dossier entier. Le jour où elle apparaît, il
faut une route de rangement EN MASSE, sur le modèle de l'action en masse du mini-CRM (une cible par
INTENTION, filtres plus exclusions, et non une liste d'identifiants, qui plafonne la requête vers
25 000 contacts).
⚠️ Ne pas se contenter de paralléliser les vingt appels : chacun invalide les compteurs, donc vingt appels
simultanés feraient vingt recalculs pour un seul résultat.

## Une SECONDE route sans appelant : `GET /tenants/:id/conversations/todo-count` (2026-09-08)

Le menu de dossiers de l'Inbox rend les cinq compteurs en une lecture (`/conversations/counts`), et il a
remplacé le seul appelant de `todo-count`. La route existe toujours, elle marche, et plus personne ne la
demande. Sa fonction côté front a été retirée (du code mort avéré) ; la ROUTE est laissée en place et notée
ici, exactement comme sa sœur ci-dessous : retirer une adresse est une porte à sens unique, et rien ne presse.

⚠️ Si on la retire un jour, retirer AUSSI la dépendance `countATraiter` et son câblage, sinon il restera une
requête que rien n'appelle. Et vérifier d'abord qu'aucun client n'a bricolé dessus : elle n'est pas dans la
documentation d'API publique (`/v1/*`), mais elle est joignable.

## Une route sans appelant : `GET /tenants/:id/contacts/ids`

Depuis le 2026-09-01, la création de campagne envoie l'INTENTION de sélection (`contactTarget`) et non plus
une liste d'identifiants. Cette route, qui rendait jusqu'à 100 000 identifiants au navigateur, était le seul
chemin par lequel ils y arrivaient, et donc le mécanisme même du piège des 25 000. Elle **n'a plus aucun
appelant** (la fonction cliente a été retirée).

Elle reste montée parce qu'elle est une primitive de lecture légitime, bornée et testée, et que retirer une
route est une décision à prendre à part plutôt qu'un effet de bord d'un lot de correction. À trancher : la
supprimer (avec son test) ferme définitivement la possibilité de reconstruire le piège, la garder laisse une
brique réutilisable. Rien ne presse : sans appelant, elle ne coûte rien.

## Ce que le lot MCP du 2026-09-01 laisse ouvert

**1. Le grant OAuth 2.1 délégué (le gros morceau).** Aujourd'hui l'accès MCP passe par une **clé d'API** à
scopes : révocable par clé, limitée en débit, déjà en place. Ce que ça ne donne PAS, et que le scénario de
Julien décrivait (`claude mcp add`, une fenêtre de login, choisir son organisation, approuver l'accès), c'est
une **délégation par (utilisateur, client tiers, espace, scopes)**, révocable par utilisateur et traçable.
C'est une TROISIÈME autorité en plus du JWT de session et des clés d'API, avec enregistrement dynamique de
client (RFC 7591), écran de consentement, et métadonnées de ressource protégée (RFC 9728). C'est ce morceau
qui décide si une DSI signe, et c'est pour ça qu'il ne devait pas être bâclé en réutilisant une clé.
⚠️ Ne pas le faire à moitié : un demi-OAuth donnerait l'ILLUSION d'un contrôle d'accès par personne.

**2. `send_template` en MCP : une décision à prendre, pas un oubli.** Julien l'avait cité dans sa liste ; il
n'est volontairement pas exposé. Ouvrir l'envoi de template à un modèle, c'est un mégaphone facturé sur un
numéro dont Meta note la qualité. Le jour où on le veut, il faut décider AVANT : un scope à part
(`mcp:send_template`, non coché par défaut), et un plafond par clé et par jour. Un test
(`tests/mcp-serveur.test.ts`) garde aujourd'hui l'absence de tout outil de template : l'ajouter obligera à le
modifier, donc à en décider.

**3. Les six copies de la modale.** `web/components/Modale.tsx` existe et sert les deux fenêtres du
qualitatif, mais `app/tags`, `app/flows`, `app/inbox`, `ContactDetail`, `MbaFaqPanel` et `MbaSkillsPanel`
portent chacun leur propre copie de la même structure, sans touche Échap ni rôle de dialogue. À faire quand
on touchera ces écrans, pas comme un chantier à part.

**4. Un résumé pour les analyses d'avant.** Les conversations analysées avant le 2026-09-01 n'ont pas de
résumé (migration 0100) et la fiche le dit. Le rattraper voudrait dire rappeler le LLM sur tout l'historique,
donc payer une seconde fois pour du confort. À ne faire que si un client le demande, et alors par lots.

## Audit de scalabilité du 2026-08-25 : les constats retenus (triés le 2026-08-29)

L'audit complet reste `AUDIT-SCALE-2026-08-25.md`. Ce qui suit est le seul reste ACTIONNABLE après
vérification dans le code : la journée 1 est faite (R2 expiration de job, R6 plafond du Retry-After,
R3 alerte de file d'échec, J0 pool à 8), et R5, R6-découpage, J1, R12 et B3 vivent dans `PLAN.md`
(5.3, 5.4, 5.5), pas ici. Les 23 jaunes de la §7 de l'audit ne sont volontairement PAS recopiés :
aucun ne casse, ils se relisent à la source le jour où on ouvre le fichier concerné.

**Faits le 2026-08-31 :** **R1** (la vérité sur `singletonKey`, qui n'a jamais dédupliqué), **R1-bis** (le
verrou d'exécution par campagne, migration 0089), **R13** (arrêter une campagne lancée), **R4** (un
déploiement ne gèle plus une campagne : balayage de reprise, bail court renouvelé, drapeau d'arrêt,
`stop_grace_period`), **R10 + J2** (le rappel « avant date » ne part plus deux fois : claim conditionnel sur
le marqueur d'occurrence, dans le runner), puis **R9** (import CSV) et **R7** (compteurs de l'inbox). Détail
dans `docs/JOURNAL-TECHNIQUE.md`, l archive.

**Il ne reste donc AUCUN constat rouge ni orange de cet audit.** R11+J3 reste ouvert, sans objet tant qu'un
seul worker tourne, et deux leviers ont été laissés SCIEMMENT, avec leur condition de déclenchement :

- **La file pg-boss d'import** (R9, point 4). Une fois l'écriture groupée par lots de 500, un fichier de
  150 000 lignes, soit le plafond de corps de la route, tient en quelques centaines d'allers-retours : le
  timeout de 100 s de Cloudflare n'est plus approché, et c'était toute la raison d'être de la file. La poser
  coûterait une table de suivi, une file de plus, un écran qui interroge l'avancement, et un endroit où
  garer 8 Mo de CSV (une charge de job pg-boss est une ligne jsonb, ce n'est pas cet endroit-là). **À
  rouvrir si** un client importe régulièrement au-delà de la centaine de milliers de lignes.
- **La colonne `unread` dénormalisée** (R7, point 3). Le comptage reste en O(conversations de l'espace),
  mais l'index partiel (0092) le ramène à une sonde d'index par conversation, et le micro-cache le fait
  payer une fois pour tous les utilisateurs d'un même client. La colonne serait le vrai O(1), au prix d'une
  valeur maintenue à chaque écriture, donc capable de mentir. **À rouvrir si** un espace dépasse la dizaine
  de milliers de conversations, ou si le comptage se voit dans les temps de réponse.
- **Le polling du fil ouvert, toutes les 4 secondes**, reste la charge de lecture dominante de l'inbox, et
  aucun des quatre correctifs de R7 ne la touche (l'audit ne le demandait pas non plus). Le vrai remède est
  un delta `?after=` ou du SSE. **À rouvrir avant** de dépasser la dizaine de clients simultanément actifs.

- 🔲 **R11 + J3. Les deux prérequis à lever AVANT tout second worker** (sans objet aujourd'hui, le compose
  fige une instance). `advance` (`src/workflow/executor.ts:1135`) lit le run puis écrit par un `setState`
  inconditionnel : deux messages du même contact avancent le run deux fois. Le bon patron existe à côté
  (`setStateSiEncoreSur`, `run-store.pg.ts:158`), il ne sert qu'au tour d'agent. ⚠️ Une course est
  atteignable DÈS AUJOURD'HUI : le process API sur les rappels RCS (`src/index.ts:801`) pendant qu'un
  webhook du même contact est traité par le worker. Et `PgWorkerHeartbeatStore.beat` écrit une ligne
  unique `id = 'worker'` : à deux workers, un mort est masqué par le vivant.


## Sorti de `wip.md` à sa vidange (2026-08-29)

Ces points vivaient dans des sections de lots déployés. Ils n’ont rien à y faire : ce sont des choses à faire.

- 🔴 **Faire tourner les deux clés d’API smsmode** qui ont circulé en clair pendant le chantier RCS. Aucune
  autre trace de cette dette nulle part dans le dépôt.
- 🔴 **Aucun workspace n’a de solde prépayé.** Conséquence directe et non évidente : les agents IA ne
  démarrent pas et le bac à sable rend 409. Tant que personne n’a rechargé, tout le lot agent est inerte,
  et l’écran ne dit pas « il faut créditer », il dit « solde épuisé ».
- **`EUR_PER_USD` n’est pas posée dans `.env.prod`** : le défaut 0,92 de `src/config.ts` s’applique. C’est
  un arbitrage commercial (marge sur la conversion), il attend Julien.
- **Un message reste dans `webhook-dlq`** depuis l’incident du 2026-08-17, et **rien ne consomme cette file**.
  Sans outil de rejeu, la seule reprise est de renvoyer le message. Un consommateur de rejeu manque.
- **L’agent RCS est peut-être déposé en mode NON conversationnel** : le choix n’est pas modifiable après coup
  et imposerait un redépôt. À vérifier avant de vendre du RCS conversationnel.
- **Le cas GTFS / Auxerre** : ne jamais confier le paramètre `grille` au modèle. Prévoir un endpoint qui le
  déduit côté serveur, avec un jeton dédié révocable.
- **Excel (`.xlsx`) en pièce jointe** : toujours ÉCARTÉ, et c'est une décision reconduite le 2026-08-31. Les
  deux bibliothèques npm restent mauvaises (`xlsx` figé en 0.18.5 avec une CVE de pollution de prototype,
  `exceljs` énorme). Le PDF et le Word, eux, sont faits (`unpdf` et `fflate`, zéro dépendance transitive).
  Un client avec un tableur exporte en CSV, qui passe.
- **L’écriture en observation depuis `/ops`** : volontairement hors lot, à trancher si le besoin revient.
- **Astérisques sur les onze champs de l’éditeur de formulaire**, et la liste des vérifications visuelles.

### À voir sur du VRAI trafic (rien de tout ça n’a encore tourné en vol)

- le **bloc Question** : aucun contact n’a jamais reçu le menu WhatsApp qu’il produit ;
- la **campagne au fil de l’eau** : aucun lead n’est passé par le webhook ;
- la **chaîne RCS complète**, depuis le dernier déploiement ;
- l’**agent IA** sur du trafic réel : une conversation tenue, un outil appelé, une sortie qui reprend le
  scénario. Tout est testé contre des mocks, rien n’a parlé à un vrai contact.

## Relevé au lot « entretien de construction » (2026-08-31)

- ✅ **Les deux failles HAUTES des briques de Fastify sont FERMÉES** (2026-08-31) : `fast-uri` 3.1.3 -> 3.1.6
  et `find-my-way` 9.6.0 -> 9.9.0, dans les intervalles que Fastify autorisait déjà, donc `package.json`
  inchangé. Et **l'image de production n'embarque plus les outils de test** : le `Dockerfile` fait désormais
  `npm ci --omit=dev`, ce qui emporte `vitest` et toute sa chaîne (109 -> 76 paquets). `npm audit --omit=dev`
  rend 0 vulnérabilité. Prouvé AVANT bascule sur l'image allégée : `migrate`, l'API qui répond sur `/live` et
  `/health`, et le worker qui démarre avec ses sept files.
- ⚠️ **L'entretien à neuf points n'a jamais été mené en vrai.** Toute la mécanique est testée contre des
  doubles ; personne n'a encore vu le modèle formuler les neuf questions à la suite, ni le creusement
  `quel_outil` se déclencher sur une vraie conversation. C'est le premier essai à faire, et il demande un
  workspace crédité (voir plus haut : aucun ne l'est).
- ⚠️ **La lecture d'image n'a été prouvée que par une sonde**, avec un pixel de test. Aucune vraie grille de
  tarifs photographiée n'est encore passée par la chaîne complète.
- **Vérification visuelle du tchat** (fil, bulles, indicateur de frappe, trombone) : à faire à l'œil, aucun
  test ne la remplace.
- **La liste déroulante d'actions SUR une règle affichée** (scénario / API / MCP), demandée le 2026-08-28,
  reste non faite SOUS CETTE FORME. Le besoin est en grande partie couvert autrement depuis le 2026-08-31 :
  le point `quel_outil` de l'entretien pose la question au bon endroit, c'est-à-dire dans la QUESTION et non
  sur une ligne de diff dont ça changerait la clé. À rouvrir seulement si l'usage montre que ça manque encore.

## 🟠 SSRF par DNS rebinding : revalider l'IP RÉSOLUE avant l'appel (relevé à la revue du lot L2)

`urlRecuperable` (`src/lib/page-distante.ts`) contrôle le NOM D'HÔTE, jamais l'adresse IP finalement résolue.
Un administrateur de tenant peut donc déclarer un domaine à lui, passer la validation à l'écriture d'une source
de connecteur, puis repointer son DNS vers `172.18.0.1` (les autres conteneurs) ou `169.254.169.254` (les
métadonnées) : l'appel suivant résoudra la nouvelle adresse. Le pare-feu de l'hôte ne couvre pas ce chemin,
puisque le trafic reste dans le réseau Docker et ne traverse jamais `ens3`.

Le trou est ANCIEN (le scraper de connaissance le porte depuis toujours, et il est documenté dans le module),
mais le lot L2 en change la conséquence : la réponse peut désormais repartir vers un contact WhatsApp par le
filtre `outputPaths`. C'est un risque d'ADMINISTRATEUR (celui qui déclare la source), pas de contact ni de
modèle.

Fermeture : un dispatcher undici avec un `lookup` qui refuse les plages privées, posé sur les DEUX appelants
(le résolveur de connecteur et `fetchUrlBorne`). À faire d'un bloc, avec un test qui pointe un domaine public
vers `127.0.0.1` et vérifie le refus.

## 🟠 Joindre un FICHIER à un message rapide (demandé par Julien le 2026-08-28)

Aujourd'hui un bloc « message rapide » ne porte qu'une IMAGE (`data.imageUrl`, champ partagé avec le bloc RCS).
Julien veut pouvoir y joindre un document (PDF, devis, plaquette). Ce n'est pas un champ de plus : la chaîne
entière est aujourd'hui image-seulement, par construction et volontairement.

Ce qu'il faut, dans l'ordre :

1. **Migration** (la médiathèque refuse tout le reste en base) : `rcs_media.mime` porte
   `check (mime in ('image/jpeg','image/png','image/gif'))`. À élargir, avec un plafond de poids propre au
   document (les octets vivent dans Postgres : 5 Mo maximum, pas les 100 Mo que Meta accepterait).
2. **Signature du fichier** : `src/rcs/image.ts` lit la signature réelle des octets et c'est ELLE qui décide du
   type servi (un PDF renommé en `.png` est refusé). Il faut la même chose pour `%PDF-`, jamais faire confiance
   au type annoncé par le navigateur : ces fichiers sont servis sur une URL PUBLIQUE.
3. **Route publique de service** : elle sert aujourd'hui `inline` avec un nom neutre (le nom d'origine en dirait
   trop sur le client). Pour un document, décider `attachment` + nom, sachant que WhatsApp affiche le nom qu'on
   passe à l'ENVOI, pas celui de l'URL : le nom neutre peut donc rester.
4. **Envoi WhatsApp** : téléverser chez Meta (`uploadForSend` est déjà générique sur le mime) puis, selon que le
   bloc porte des boutons ou non, un en-tête `document` sur le message interactif, ou un message `document`
   avec `filename` et légende. `sendInteractive` n'expose aujourd'hui qu'un en-tête image.
5. **Canal RCS** : un document n'a pas d'équivalent dans une carte RCS. Décider la dégradation (envoyer le
   texte seul ? un lien ?) et la DIRE dans l'écran, sinon le client croira que la pièce jointe part sur les
   deux canaux.
6. **Écran** : champ de téléversement à côté de l'image, aperçu WhatsApp, et la pièce jointe visible dans la
   miniature du bloc (comme le visuel depuis le 2026-08-28).

Deux à trois heures, sur le chemin d'ENVOI en production : à faire d'un bloc, pas en passant.

## 🔴 Agent IA : les lots NON développés (L3, L4, L6, L7), du cadrage du 2026-08-23

⚠️ **CE TITRE A DIT « L2 à L7 » JUSQU'AU 2026-09-11**, alors que L2 est livré et déployé depuis le
2026-08-28, deux lignes plus bas et marqué ✅. Un titre qui contredit sa propre liste est plus lu que la
liste : il a fait annoncer à Julien un chantier en pause plus gros qu'il n'est. Il n'y a PAS de L5, la
numérotation du cadrage saute de L4 à L6.

Ce qui est livré, c'est **L0, L1 et L2** : l'agent, ses outils MAISON, sa base de connaissance, la
construction en parlant, le bac à sable, le tour de production, le solde prépayé, et les connecteurs API du
client. Tout le reste ci-dessous n'existe pas. Le
séquencement et le pourquoi de l'ordre sont en §7 de
[AGENT-IA-CADRAGE-2026-08-23.md](AGENT-IA-CADRAGE-2026-08-23.md) ; le tableau côté client est dans
[AGENT-IA-PRODUIT-2026-08-27.md](AGENT-IA-PRODUIT-2026-08-27.md).

- ✅ **L2 : le connecteur API (HTTP) du client. LIVRÉ ET DÉPLOYÉ le 2026-08-28** (migration 0088 appliquée).
  Plan exécuté : [AGENT-IA-PLAN-L2.md](AGENT-IA-PLAN-L2.md), neuf tâches. Le système se déclare dans
  **Tools > Connecteurs API**, l'agent n'y déclare que ses appels. Détail dans [documentation.md](documentation.md) §Le connecteur API d’un client.
- 🟠 **L3 : le « temps 2 ».** L'IA de construction relit les VRAIES conversations, le journal d'outils et le
  signal de mécontentement, propose des corrections et **rejoue des cas de test avant d'appliquer**. N'a de
  valeur qu'une fois qu'il existe des conversations, donc après une mise en service réelle.
- 🟠 **L4 : MCP en jeton statique, sur allowlist.** Couvre 70 % du parc mesuré pour un quart du prix de
  l'OAuth. **Le plan d'exécution est écrit : [AGENT-IA-PLAN-L4.md](AGENT-IA-PLAN-L4.md)** (5 tâches, une
  colonne de migration au plus, zéro dépendance nouvelle). Il tranche la question qui commandait tout le
  reste : le schéma d'un outil MCP est TRADUIT dans notre modèle à la déclaration, jamais transmis tel quel,
  ce qui fait tomber la moitié du lot et récupère au passage la garde anti-IDOR que MCP ne fournit pas.
  **Deux décisions attendent Julien** : D3 (allowlist seule, l'URL libre restant à L7), et d'où vient le
  `risk` d'un outil MCP, puisque le plancher dérivé de la méthode HTTP n'existe pas ici.
  🔴 **ET L4 NE SERVIRA JAMAIS LE MBA, vérifié le 2026-09-10 sur le corpus OpenAPI officiel de Meta**
  (`mba documentation/`, version 2.0.0) : zéro occurrence de « MCP » dans les 16 specs et 12 pages, et
  surtout **aucun champ où le déclarer**. Un `agent_connector` exige `base_url` + `auth_type`
  (`OAUTH2 | OAUTH2_CLIENT_CREDENTIALS | API_KEY | BASIC | CUSTOM | NONE`) et rien d'autre ; un tool est
  un `request_definition` HTTP. **Un outil MCP n'est donc pas publiable au MBA**, et L4 ne vaut que pour
  NOS agents. Ce constat a sorti le client MCP du programme « catalogue centralisé » du 2026-09-10
  (décision de Julien), il ne l'a pas annulé ici. ⚠️ Corollaire à ne pas perdre : le jour où L4 se fait,
  la case « exposé au MBA » d'un outil MCP doit être **grisée avec la raison**, pas cochable en vain.
- 🔵 **L6 : MCP OAuth.** Quatre à huit fois le coût de L4, et le coût n'est pas dans le développement mais
  dans la SUPERVISION : un jeton mort ne produit aucune erreur applicative, l'agent dégrade en silence au
  milieu d'une conversation. Premier serveur à brancher : Linear. Le pire premier candidat : HubSpot (la
  console a déjà son connecteur `mm-hubspot` en production, ce serait une deuxième façon de faire la même
  chose).
- 🔵 **L7 : URL MCP arbitraire par tenant.** Décision commerciale, pas technique.

⚠️ **PIÈGE DE VOCABULAIRE, vécu le 2026-08-28, et tranché depuis.** La console a un menu **Tools** dans la
barre de gauche ET un onglet **Outils** DANS un agent. Julien a cherché le connecteur dans le menu et n'a rien
vu, parce qu'il vivait alors dans l'agent. Le partage est désormais explicite, et c'est lui qui l'a tranché :
le **système** (adresse, authentification, secret) se déclare dans **Tools > Connecteurs API**, une
bibliothèque du workspace où plusieurs agents puisent ; l'**appel** que tel agent a le droit de faire se
déclare dans son onglet Outils. Si la confusion revient malgré ça, la correction est de RENOMMER l'un des
deux, pas de réexpliquer.

## L'API publique v1 ne sait pas dire « désabonné » (reste du 5.1, 2026-08-29)

La moitié conformité du 5.1 est faite : un STOP en WhatsApp désabonne désormais, comme en RCS. Reste la
moitié API : un client dont le CRM sait que quelqu'un s'est désinscrit ne peut pas nous le dire par
`/v1/contacts`, qui ne produit que `opted_in` ou `unknown`.

🔴 **Et ça ne se règle PAS en réinterprétant `optIn: false`.** Deux raisons trouvées en regardant le code :

1. `optIn: false` veut dire aujourd'hui « non renseigné ». Lui donner le sens « désabonné » réécrirait le sens
   des payloads que les intégrations envoient déjà, et pourrait désabonner en masse sur un sync ordinaire.
   Il faut un champ EXPLICITE (`optOut: true`), additif.
2. Le champ ne peut pas passer par l'upsert. `upsertByPhoneReturningId` porte
   `opt_in_status = case when excluded.opt_in_status = 'opted_in' then 'opted_in' else contacts.opt_in_status end`,
   c'est-à-dire qu'il ne sait que **promouvoir**. C'est une bonne garde (un sync n'écrase jamais un
   consentement), et elle rend l'opt-out impossible par ce chemin **par construction**. Il faut donc une
   seconde écriture après l'upsert, sur l'identifiant rendu, comme le fait la route `PATCH` de la fiche.

À faire avec son entrée de journal d'audit (`contact.optout`, source `api`), comme les trois autres chemins.

**Ce n'est pas une brèche de conformité** : le refus exprimé À NOUS est désormais honoré, et l'opérateur a
déjà trois chemins pour désabonner (fiche, action en masse, bloc « Action »). C'est un trou d'intégration.

## 🔴 À TRANCHER : une règle d'arrêt nommée `humain` fabrique deux poignées identiques (2026-08-29)

Trouvé en instruisant le correctif du bloc Question, **pas encore déclenché**, mais atteignable dès qu'un
client nomme une règle d'arrêt d'une certaine façon.

Le bloc agent dessine ses sorties en deux séries : celles que le client déclare, en `sortie:<code>`
([WorkflowBuilder.tsx](web/components/WorkflowBuilder.tsx), `sortiesDuBloc`), puis celles que la plateforme
pose toujours (`AGENT_SORTIES_RESERVEES` dans [nodeMeta.ts](web/lib/nodeMeta.ts)), dont les poignées sont
`sortie:humain`, `sortie:sans_source`, `sortie:plafond` et `sortie:echec`. Un code client valant `humain`,
`sans_source`, `plafond` ou `echec` produit donc **deux `Handle` de même identifiant**. React Flow retient le
premier (`getHandle`), donc la seconde ligne tire sa flèche depuis celle du haut, et les deux s'affichent
reliées. C'est exactement la famille du défaut corrigé le 2026-08-29, et `humain` est un nom parfaitement
naturel pour une règle d'arrêt.

`sortiesDuBloc` ne filtre que les codes vides. La liste réservée existe côté serveur
([src/agent/sorties.ts](src/agent/sorties.ts)), et la parité code front / serveur a déjà ses tests
(`tests/web-agent-code-sortie-parity.test.ts`).

**Le choix est produit, pas technique**, d'où le report :
- soit **refuser le code à l'enregistrement** (`ficheAgentSchema` réserve les quatre noms). Propre, mais une
  fiche existante qui porte déjà `humain` ne s'enregistrerait plus, et il faudrait le dire au client ;
- soit **fusionner à l'affichage** : une règle client `humain` et la sortie réservée « Transfert à un humain »
  veulent dire la même chose, donc une seule ligne. Rien ne casse, mais la ligne du client disparaît du
  canevas sans explication ;
- soit **refuser à l'enregistrement ET absorber l'existant** à l'affichage. Le plus complet, le plus cher.

## Ouvert par la tranche 19c du bloc agent IA (2026-08-28)

**Dire à l'admin qu'une suppression de compte a éteint des outils d'agent.** Supprimer un utilisateur éteint
maintenant les outils d'agent qu'il avait mis en service (sans quoi le `delete` échouait en `23514`, cf. le
plan agent IA, tranche 19c). La réponse HTTP rend toujours `{id, deleted: true}` : seul un `console.warn`
côté serveur dit combien de réglages sont tombés. Conséquence : si un agent cesse d'envoyer un bloc après un
départ, il faut penser à chercher ce log. Renvoyer le compte dans la réponse du `DELETE` et l'afficher sur
l'écran Admin fermerait le trou. Non fait tout de suite parce que `UserMutation` est partagé avec
`setRole`/`setDisabled` et qu'aucune route de `users.ts` ne trace d'audit aujourd'hui : le faire ici seulement
serait incohérent.

**Confirmer avec Julien que `mba_envoyer_bloc` doit rester IRRÉVERSIBLE.** Déclaré tel quel en 19c (un message
parti chez un contact ne se rappelle pas, et il est facturé), donc l'agent ne peut pas envoyer un bloc tant
que l'autonomie n'est pas cochée sur cet outil. Si l'envoi de bloc doit être libre par défaut, c'est une ligne
dans `src/agent/outils-maison.ts`.

## 🆕 Ouvert par le second relevé de doc Meta du 2026-08-26 (soir)

Détail complet et citations : `docs/MBA-API-REFERENCE.md`, section « Second relevé du 2026-08-26 ».

- 🔴 **Agent Budget (`{business_manager_id}/agent_budget`), à mesurer puis à arbitrer.** Un plafond
  d'usage (jetons sur le Business Manager, ou tours d'IA **par conversation**, sur fenêtre glissante de
  1 à 30 jours) qui, une fois atteint, **arrête l'agent et bascule la conversation vers un humain** par la
  route de passation déjà configurée. C'est notre thèse produit, offerte en natif. Deux inconnues avant
  d'en faire quoi que ce soit : le 403 « not enabled for this business integration » (porte ouverte ou
  fermée pour nous ?), et le fait que cet endpoint attend le **Business Manager ID**, pas le
  `phone_number_id` de tous nos autres appels.
- 🟠 **Conversation Turns (`{entity_id}/insights/conversations/turns`).** Par tour : latence bout en bout,
  étapes `LLM_CALL` / `TOOL_CALL` avec leur statut, aperçu de la sortie du modèle, entrées et sorties des
  outils. C'est le « pourquoi l'agent a répondu ça » que notre référence listait comme définitivement
  absent. À brancher quand un agent tournera pour de vrai.
- 🟠 **`crawl_error` et `completed_no_data` : MESURER avant de coder.** Annoncés par le changelog du
  2026-08-24, absents de la page de référence ET de son export OpenAPI. Quand ils seront vus sur un appel
  réel : libeller `COMPLETED_NO_DATA` (« Exploré, rien d'exploitable », surtout pas en rouge) et afficher
  `crawl_error` **uniquement** si `crawl_status` vaut `FAILED` et que la valeur n'est pas vide (Meta le
  laisse vide pendant le crawl et sur tout crawl ayant ramené des pages).
- 🔴 **Scinder le PUT d'activation en deux appels.** `scripts/mba-activer-restreint.mts` envoie
  `ai_audience` et `rollout.enabled` dans le MÊME PUT. Meta prescrit maintenant : régler `ai_audience`,
  **relire en GET**, puis allumer. Si Meta évalue l'audience stockée au moment d'allumer, le PUT combiné
  se heurterait au 400 de facturation et on croirait à tort que la barrière n'a pas bougé.
- 🟠 **L'avertissement qui manque dans la console.** Allumer un agent avec `ai_audience = EVERYONE` sur un
  numéro vivant l'expose immédiatement à tout le monde. Le panneau allowlist dit que la liste est sans
  effet en `EVERYONE` ; rien ne dit ce que coûte le clic d'allumage. À écrire au moment du clic.

## ⚠️ Revue du bloc Question : ce qui n'a PAS été instruit (2026-08-26)

La revue adversariale du bloc Question a rapporté **39 défauts**, chacun devant être soumis à deux sceptiques
chargés de le réfuter. **La moitié des réfutations n'a jamais tourné** (limite d'usage atteinte en cours de
route), et le décompte a écarté ces défauts-là par construction : un défaut dont AUCUN juge n'a pu se
prononcer compte comme non confirmé.

**Les 10 confirmés ont été vérifiés dans le code et corrigés** (commit `52a33b6`). Ce qui suit est la liste
de ce qui n'a été NI réfuté NI instruit, à reprendre à tête reposée. Aucun n'est bloquant à vue d'œil,
mais aucun n'a été vérifié non plus.

- **Le plafond du corps d'une liste.** J'ai retenu 4096 caractères, relevé sur la référence Cloud API que j'ai
  lue moi-même. Un relecteur affirme 1024. Non tranché : à vérifier à la source avant qu'un client écrive une
  question longue.
- **Échéance de plus de 7 jours.** Un relecteur soutient qu'elle sort du garde-fou d'unicité de parcours, donc
  que deux scénarios pourraient écrire au même contact. Plausible, jamais vérifié.
- **Reprise pendant un fil GELÉ** (repris par un humain ou par l'agent) : `resume` clot le run, là où
  `advance` refuse explicitement de le faire. Comportement hérité du bloc Attente, pas introduit ici, mais il
  prend un sens nouveau sur une question.
- **Délai remis à zéro après avoir relié « Pas de réponse »** : la sortie disparaît de l'éditeur, l'arête reste
  dans le graphe. Branche morte, invisible.
- **Le journal de conversation garde la question, pas le menu** : un opérateur qui relit un fil ne voit pas
  les choix qui ont été proposés.
- **Trous de couverture nommés** : `wiring.sendQuestion` (le seul code qui décide « liste ou texte ») n'a aucun
  test ; la branche `question` de `waitBeforeSessionMessage` côté front n'est exercée par aucun cas ; rien ne
  prouve de bout en bout qu'un `row:<i>` reçu du webhook redescend jusqu'au routage.

### 🔴 Un point qui touche la base de PRODUCTION

`tests/integration/question-timeout.integration.test.ts` appelle `claimDueQuestions(50)` **sans filtre de
tenant** : il réclame donc aussi les échéances réelles d'autres espaces qui seraient dues au même instant.
Depuis le passage au BAIL, le dégât se limite à repousser leur réveil de 15 minutes (avant, la version qui
consommait l'échéance l'aurait détruite). À borner au tenant du test avant que des clients aient des
questions en vol.


## ⚠️ En attente d'une VÉRIFICATION EN VOL (2026-08-26)

Deux fonctionnalités sont livrées et déployées, mais AUCUNE n'a encore été vue fonctionner sur du vrai
trafic. Les tests prouvent que notre code émet la bonne forme, pas que Meta réagit comme attendu. Tant que
ce n'est pas fait, ne pas les compter comme acquises.

**1. L'image sur un bloc « message rapide »** (commit `f6f7be5`). La référence Meta documente les types
d'en-tête (text/video/image/document) et le fait qu'un média se donne par `id` ou par `link`, mais elle ne dit
PAS explicitement que l'en-tête est accepté sur le sous-type « boutons de réponse ». Un seul envoi réel
tranche. Trois issues possibles : le message arrive avec l'image (c'est réglé) ; Meta refuse l'envoi (le bloc
remonte son refus, et on bascule sur le lien plutôt que l'identifiant, ou sur deux messages) ; le message
arrive SANS l'image, et c'est le cas embarrassant car rien ne le signalerait.

**2. Le déclencheur « publicité » (CTWA)** (commit `bee7137`). Sur 275 corps de webhook conservés depuis
juillet, aucun ne contient `referral` ni `ctwa_clid` : personne n'a encore pointé de pub sur ce numéro.
⚠️ AVANT la première campagne publicitaire, vérifier la bascule d'attribution dans les réglages WhatsApp
Business : sans elle, Meta n'envoie pas l'objet `referral` du tout, et le déclencheur restera muet sans
qu'aucune erreur n'apparaisse nulle part. Quand une pub tournera, deux signaux disent que la chaîne est bonne :
la fiche du contact porte « Pub (identifiant) » et « Pub (titre) », et le scénario part.

## À faire : renvoyer les conversions publicitaires à Meta (`ctwa_clid`)

Le déclencheur « publicité » est livré (2026-08-26) : on sait de quelle pub vient un lead et on le route vers
un scénario. Ce qui reste, et qui a une vraie valeur commerciale : **refermer la boucle d'attribution**.
`ctwa_clid` sert à renvoyer à Meta les conversions (un lead qualifié, un achat) via l'Automatic Events /
Conversions API, ce qui laisse l'algorithme optimiser la diffusion de la pub. C'est un argument de vente
concret pour un client qui fait de l'acquisition.

Deux précautions connues : `ctwa_clid` arrive parfois VIDE, et il n'est transmis que sur le premier message.
Il n'est pas recopié sur la fiche contact aujourd'hui. ⚠️ **Le repli « on le retrouvera dans le payload brut »
a une DATE DE PÉREMPTION depuis le 2026-08-31** : `webhook_events` est purgée à 30 jours (rétention RGPD,
migration 0093). Au-delà, le `ctwa_clid` d'un lead est définitivement perdu. Le jour où on referme la boucle
d'attribution, il faut donc le recopier sur la fiche contact À LA RÉCEPTION.

## Étanchéité des canaux : ce que le lot du 2026-08-25 a volontairement laissé

Le lot est livré (voir `AUDIT-ETANCHEITE-CANAUX-2026-08-25.md` et `.loop/etancheite-canaux.md`). Trois points
ont été écartés sciemment, pas oubliés :

- **Exiger le `channelId` sur le rappel smsmode.** La garde d'isolation n'arrête pas un corps FORGÉ qui omet
  l'objet `channel` ; le code de l'URL reste la seule authentification réelle. Les corps sans `channelId`
  sont désormais JOURNALISÉS. Quand les journaux montreront que ça n'arrive jamais, exiger le champ (403 sinon).
  Un seul corps réel est capturé à ce jour : trop peu pour trancher aujourd'hui sur un canal LIVE.
- **Plafond de requêtes sur `/rcs/callback/:code`**, seule écriture non signée du produit. Le `RateLimiter`
  maison (`src/auth/rate-limit.ts`) suffit, aucune dépendance nouvelle.
- **Une série RCS au tableau de bord.** Les envois RCS sont sortis de la série « Service » (qui les annonçait
  comme non facturés) mais ne sont affichés nulle part ailleurs. Leur donner leur propre série, avec le coût
  smsmode en face, est le vrai correctif.

> **Le plan global vit dans `PLAN.md`.** Audit de scalabilité et lot de features séquencés ensemble,
> en 6 blocs. Ce `todo.md` reste l'historique détaillé des lots livrés et le backlog de fond.

## ✅ LOT LIVRÉ : étanchéité des canaux RCS / WhatsApp (2026-08-25)

**L'audit reste la référence** : `AUDIT-ETANCHEITE-CANAUX-2026-08-25.md`, 6 rouges, 9 jaunes, et surtout
**41 partages de canal qui sont VOULUS et qu'il ne faut pas « corriger »**. Cette dernière liste se relit
avant toute intervention dans cette zone. Le plan exécuté est dans `.loop/etancheite-canaux.md`.

Le fond du sujet, en une phrase : `workflow_runs.channel` existait, il était correctement ÉCRIT à l'envoi,
mais **jamais relu** au moment de décider si un message entrant concernait ce parcours. Un tap RCS faisait
donc avancer une branche d'une question posée en WhatsApp, et l'inverse. `advance` reçoit désormais le canal
du retour et refuse ce qui ne vient pas du bon tuyau.

Les deux décisions produit ont été tranchées par Julien le 2026-08-25 : réponse RCS libre depuis l'inbox
→ **oui, livrée** ; automations sur un message RCS → **câblées**. Le troisième point (`lastInboundAt` poussé à
HubSpot) est résolu sans arbitrage : le champ est restreint à WhatsApp, puisque sa raison d'être écrite est
de piloter la fenêtre 24 h de Meta ; un besoin « dernier contact tous canaux » prendra un champ DISTINCT.

Ce qui reste ouvert est plus bas, section « Étanchéité des canaux : ce que le lot a volontairement laissé ».

## ✅ Laissé ouvert par le lot « Journée 1 », puis FAIT le 2026-08-31

Les deux chemins que le correctif voisin ne couvrait pas sont fermés : le **plafond de temps d'un appel
sortant** (30 s pour une API ordinaire, 120 s pour un modèle, l'échéance de l'appelant restant prioritaire) et
le **dimensionnement de l'enfilement du retry-sweep**. Détail et pièges dans `documentation.md` §Journal des
lots livrés.

⚠️ **Le même trou de plafond existe dans le connecteur** (`mm-hubspot/src/http/transport.ts`), consigné dans
le `todo.md` de CE dépôt-là.

## Ouvert par le lot « webhooks entrants » (2026-08-23)

- **Aucun appel d'un VRAI outil du marché.** L'arbre de mapping est éprouvé sur des payloads fabriqués. Ce
  que Zapier, Make ou HubSpot envoient réellement (enveloppes, tableaux imbriqués, clés à points) n'a pas été
  regardé. À faire au premier branchement client, en gardant le payload sous les yeux.
- **Un type de valeur invalide fait échouer l'appel ENTIER.** `upsertContactsFromApi` refuse l'enregistrement
  dès qu'une valeur ne passe pas la validation de son champ (du texte dans un champ nombre) : le téléphone est
  perdu avec. Seule la LONGUEUR est filtrée en amont. Le corriger demanderait soit une écriture partielle dans
  le chemin partagé (qui servirait aussi l'API publique et l'import), soit une validation par type dans la
  route, donc une seconde copie des règles. À trancher si le cas se présente vraiment.
- **Pas de journal des appels.** On garde le DERNIER payload, jamais un historique (choix RGPD). Un
  intégrateur qui débogue « mon 3e appel n'a rien fait » n'a donc rien à regarder. Un journal des RÉSULTATS
  sans les corps (horodatage, contact, champs, scénario) serait le bon compromis, il n'est pas fait.
- **Le plafond de débit est en mémoire du process.** Comme celui de `/v1`. À plusieurs instances d'API, le
  plafond réel est multiplié par leur nombre. Sans objet aujourd'hui (une seule instance).
- **Un webhook désactivé rend 404, pas 410.** Un outil tiers ne peut donc pas distinguer « supprimé » de
  « éteint ». C'est délibéré (ne rien révéler), mais ça complique le diagnostic côté client.

## Ouvert par le lot « 5 corrections » (2026-08-21)

- **Le compteur de clics reste un compteur de TEMPLATE, pas de campagne.** Un lien ne sait pas quel envoi l'a
  porté : deux campagnes sur le même template lisent le même chiffre. Le funnel le dit sous le graphe. Le
  rendre exact demanderait un lien par destinataire (donc un template par campagne, ce que Meta ne permet
  pas) ou un paramètre dynamique dans l'URL du bouton, à évaluer.
- **Les compteurs déjà pollués ne sont pas purgés.** Les 70 clics de Meta sur `testurl` restent en base ; le
  seuil « depuis le premier envoi » les écarte à la lecture. Rien à supprimer, donc rien d'irréversible, mais
  une lecture brute de `tracked_link_clicks` reste trompeuse.
- **Aucun envoi réel n'a encore exercé la chaîne de bout en bout** : le tap de bouton (`type = 'button'`) est
  déduit du code du webhook, pas mesuré sur un vrai destinataire. À vérifier au premier envoi réel d'un
  template à boutons.
- **`buttonReplies` ne distingue pas « aucun bouton » de « zéro tap ».** `urlClicks` le fait (`null` vs `0`),
  parce que la table des liens tracés dit si le template porte un bouton URL. Rien ne dit l'équivalent pour
  les boutons de réponse rapide sans interroger Meta. L'étape n'apparaît donc qu'à partir d'un tap. Choix
  assumé : mieux vaut une étape absente qu'une étape à zéro qui accuse les destinataires.
- **Les messages d'erreur venus du SERVEUR restent en français**, dans les deux langues. `http.ts` ne traduit
  que ses deux replis ; `body.error` est rédigé côté API et passe tel quel. Le vrai correctif serait un code
  d'erreur stable traduit côté front, à faire si un client anglophone arrive.
- **Le motif d'un refus Meta n'est pas récupéré** : `list()` ne demande pas le champ. L'écran renvoie donc à
  la liste des templates au lieu de l'expliquer. À faire si le cas devient fréquent.
- **`ENCRYPTION_KEY` manque au `.env` local** : 6 tests d'intégration de `email-account-store` échouent chez
  moi pour cette seule raison. Sans effet sur la production, mais la suite d'intégration n'est pas verte à
  100 % en local tant que la clé n'y est pas.

## 🔴 MBA : ce qui reste après le chantier « paramètres d'activation » (livré le 2026-08-21)

**Le chantier est DÉPLOYÉ** (écran Activation, migration 0067, règle du texte libre, abonnement webhook).
Dossier complet dans `.loop/mba-parametres-activation.md`. Ne restent que les deux points ci-dessous, dont
le premier ne dépend pas de nous.

### Ce qui reste à faire, dans l'ordre
1. 🔴 **BLOQUÉ PAR LE MOYEN DE PAIEMENT** : provoquer un VRAI transfert en conversation WhatsApp réelle.
   Sans moyen de paiement rattaché au compte, aucun message WhatsApp n'atteint l'agent : le bac à sable
   (`agent_test`, onglet « Tester ») est le SEUL canal. Rien à tenter d'ici là, ce n'est pas un manque de
   notre côté. Le jour où c'est rattaché : envoyer « je veux parler à un conseiller » au
   `+33 5 25 68 03 01` (`phone_number_id=1305301719324792`, WABA `1067000669256166`) et regarder si l'on
   reçoit `messaging_handovers`, sous quelle forme, si la suite bascule de `standby` vers `messages`, et si
   l'écho du message de transfert arrive. Puis corriger `ownerFromHandover` (`src/webhooks/handover.ts`),
   dont la lecture est DEVINÉE et probablement INVERSÉE. Le module journalise déjà tout payload reçu
   (`handover_recu`, `standby_echo`) : la trace sera là.
   ✅ **FAIT le 2026-09-10 au soir, sur le `+33 5 25 68 02 50` et non sur l'autre numéro.** Réponses aux
   quatre questions, toutes mesurées : on reçoit bien `messaging_handovers` ; la suite bascule bien de
   `standby` vers `messages` ; l'écho du message de transfert arrive. **Et « probablement INVERSÉE » était
   juste** : le repli « le texte contient `business_agent` » lisait `previous_owner_app_role`, donc le
   détenteur PRÉCÉDENT, et concluait l'inverse. Deux autres défauts sont tombés avec :
   `recipient` est un OBJET (le client vit dans `sender.phone_number`), et un `messaging_handovers` n'a
   AUCUN `metadata` (le numéro business vit dans `recipient.phone_number_id`).
   🔴 **CE QUI A DÉBLOQUÉ L'ATTENTE N'ÉTAIT PAS LE NUMÉRO, C'ÉTAIT UN RÉGLAGE** : `messaging_handovers` ne
   se déclenche QUE si le bloc `handoff` est configuré chez Meta, et il valait `null`. On a attendu des
   semaines un événement qu'aucun numéro n'aurait envoyé. Forme réelle et tests : `tests/handover-reel.test.ts`.
   ✅ L'abonnement webhook, lui, est FAIT (2026-08-21) : `messages`, `standby` et `messaging_handovers` sont
   souscrits sur l'app. Ce n'est donc plus un prérequis manquant.
2. 🔲 **La pastille « quelqu'un a besoin d'aide »** dans l'inbox. Demande une donnée NOUVELLE : `app_human` ne
   distingue pas « escaladé, personne ne s'en occupe » de « un opérateur a répondu », donc la pastille ne
   pourrait jamais s'éteindre. Et le balayage de reprise rebascule après le délai même si personne n'a rien
   fait : une demande d'aide peut donc s'éteindre toute seule. À ne faire qu'APRÈS le point 1.
3. 🔲 **Le texte lu par le client hors horaires** reste celui de Meta. Nous ne l'écrivons pas encore
   (`message` + `message_selection: CUSTOM`), parce que le comportement réel de ces deux champs n'a pas été
   mesuré. À traiter avec le point 1, sur le même test réel.

### Faits à ne pas re-chercher
- `handoff` a **trois** champs : `enabled`, `message`, `message_selection` (DEFAULT/AGENT/CUSTOM).
  🔴 `enabled` **n'active pas** le passage de main, il décide si l'agent LÂCHE le fil après l'avoir annoncé.
- « Je veux parler à un conseiller » -> `handoff_reason: customer_request`, **déjà mesuré** sur notre numéro
  de test. Le déclencheur est natif, rien à câbler.
- **Deux interrupteurs MBA** : `mba_enabled` (Accueil) ne fait PAS répondre l'agent, c'est le **rollout**
  (MBA > Vue d'ensemble) qui le fait. Asymétrique : `false` coupe TOUTES les conversations, `true` ne reprend
  que les nouvelles.
- Sur le WABA de test, **deux** apps sont abonnées : la nôtre et « Business Agent » de Meta. `subscribed_apps`
  liste les APPS, pas les CHAMPS ; les champs se lisent sur `{app_id}/subscriptions` (jeton d'application).
- ❌ Une skill = trois champs de TEXTE chez Meta. Elle ne produit aucun effet chez nous, elle ne fait
  qu'influencer le modèle. Ne jamais la vendre comme un transfert garanti.

## 🔲 CI rouge par intermittence : `inbox-envoi-scenario` et `campaign-carousel-preview` (mesuré 2026-08-21)

**Ce n'est pas une régression** : mesuré sur 5 exécutions, les échecs CHANGENT de test d'une fois sur l'autre,
et les deux fichiers passent **25/25** et **6/6** en isolation, y compris avec 4 workers.

| Exécution | Échecs |
|---|---|
| local (20/08 au soir) | aucun, 192/192 |
| CI | campaign-carousel |
| CI (rerun, même commit) | campaign-carousel + inbox-envoi-scenario |
| local | campaign-carousel + inbox-envoi-scenario |
| local | inbox-envoi-scenario seul, sur un AUTRE test du fichier |
| local (23/08, suite complète) | inbox-envoi-scenario seul, « fenêtre FERMÉE » |
| local (23/08, suite complète, rerun) | aucun, 246/246 |
| local (23/08, fichier seul, 3 fois) | aucun, 5/5 à chaque fois |

**Point commun constant** : le chargement de la liste des SCÉNARIOS (`wfSelect`, `scenario-select`), qui
attend workflows ET templates puis filtre par éligibilité. Ce sont les deux écrans les plus lourds de la suite.

**Cause** : contention. 4 workers partagent UN serveur Next (`playwright.config.ts`), et le budget du TEST
(30 s par défaut) est mangé par le chargement de l'écran avant que l'assertion commence.
`campaign-carousel-preview` a déjà reçu 90 s pour cette raison exacte ; `inbox-envoi-scenario` est resté à 30 s
alors que son `ouvrirPanneau` réessaie déjà pendant 20 s.

**Deux pistes, dans cet ordre :**
1. Aligner le budget de `inbox-envoi-scenario` sur les 90 s de son jumeau. Ce n'est PAS affaiblir un test :
   les assertions ne bougent pas, on rend seulement au test le temps que la contention lui prend.
2. 🔴 Un échec reste INEXPLIQUÉ par la contention : en CI, `carousel-cards` et « Séjour à Nice » étaient
   visibles mais « Séjour à Lyon » **absent du DOM** (`element(s) not found`, pas un timeout). Les deux cartes
   viennent pourtant du même `.map()`. À creuser avec un trace Playwright : la CI n'uploade aucun artefact
   aujourd'hui, l'ajouter est le prérequis pour diagnostiquer au lieu de deviner.

⚠️ Ne PAS « corriger » en rallongeant encore les attentes internes : ça a déjà été fait deux fois et n'a pas tenu.

## 🔲 Bornes de journée : les mesures filtrent en UTC, l'écran raisonne en heure locale (2026-08-21)

`countByNode` (`src/workflow/node-events.pg.ts`) compare `at >= $3::date and at < ($4::date + interval '1 day')`.
Les bornes sont donc interprétées en UTC, alors que l'utilisateur choisit « aujourd'hui » dans SON fuseau.
L'été, deux heures d'événements changent de journée : un clic de 23 h 30 à Paris est compté le lendemain.

**Comment c'est apparu** : un test d'intégration a échoué en CI à 00 h 05 heure de Paris, sur un commit qui
n'y touchait pas (vérifié en relançant la CI du commit précédent, qui a échoué au même endroit). Le test a été
rendu insensible au fuseau ; le décalage de fond, lui, est toujours là.

**À décider** : soit les bornes sont converties dans le fuseau du tenant (`tenant_settings.timezone`, déjà
lu ailleurs), soit on assume l'UTC et on le dit à l'écran. Aujourd'hui ce n'est ni l'un ni l'autre.
Concerne les mesures par bloc, et probablement les autres agrégats datés d'Analytics : à vérifier ensemble.

## Ouvert au 2026-08-20 (traçage des liens + statut manager)

- ✅ **TRANCHÉ le 2026-09-14 : un MANAGER consulte les écrans de conformité.** Julien : « ouvre la console aux
  managers sur les écrans de conformité ». Il atteint désormais Sécurité (accueil, Consentement, IA, Audit
  trails, Journal des erreurs) en plus de l'Inbox, et **il ne règle rien** : brancher un connecteur sur le
  consentement ou changer la politique d'annonce d'IA restent des décisions de la marque, refusées côté
  serveur ET masquées côté écran. Consulter et décider ne sont pas le même geste.
  ⚠️ **La liste vit dans `web/lib/nav.ts` (`ECRANS_ENCADREMENT`), et deux choses en dérivent** : la garde
  d'accès de la console et le FILTRAGE du menu. Les écrire séparément reproduirait le défaut que la revue du
  chantier 6 a trouvé dans l'autre sens : une garde serveur qui nomme `manager` pendant que la console ne
  l'y mène jamais.
  ⚠️ **Le reste des prérogatives d'un manager n'est toujours pas décidé** : campagnes, contacts, scénarios,
  réglages. Ça se décide écriture par écriture, comme avant.
- 🔲 **Premier test RÉEL du traçage des liens, de bout en bout.** La redirection est vérifiée en prod (302 +
  clic compté) et la substitution est vérifiée en test contre un faux Meta, mais **personne n'a encore créé un
  template avec un lien depuis la console**. Le maillon création -> approbation Meta -> envoi -> clic ->
  compteur n'a jamais été exercé en vrai.
- 🔲 **Nettoyer `test_lien_redir_a` et `test_lien_redir_b`** sur le WABA de test (« AuxR M le Bus MBA test »).
  Le token sait créer un template mais **pas le supprimer** sur ce compte (« Need permission on either
  WhatsApp Business Account or owner/shared business », par l'arête WABA comme par l'id). À retirer depuis
  Business Manager.
- 🔲 **Attribution par personne des clics** (reportée, pas abandonnée) : demanderait un suffixe fourni à
  l'envoi, donc un composant de bouton sur les quatre chemins d'envoi. Le lien de base ne changerait pas, les
  templates déjà approuvés n'auraient pas à être resoumis. **Julien n'en veut pas pour l'instant** : il veut
  un comptage global.
- ❌ **HORS PÉRIMÈTRE, tranché le 2026-08-20** : les liens écrits dans le **CORPS** d'un message ne sont pas
  traçables. Seuls les **boutons** le sont. WhatsApp va chercher lui-même les liens du corps pour en afficher
  l'aperçu, un compteur y compterait des robots plutôt que des humains. Décision de Julien, ne pas rouvrir
  sans qu'il le demande.

## Les deux audits de scalabilité : lequel fait foi

⚠️ **`AUDIT-SCALE-2026-08-25.md` succède à celui de juillet et le supplante.** Quand les deux se recouvrent,
celui d’août tranche : il re-statue les bloquants de juillet avec des mesures fraîches. Ce qui reste
ACTIONNABLE des deux est en tête de ce fichier (section « Audit de scalabilité du 2026-08-25 ») et dans
`PLAN.md`, dont les états ont été vérifiés item par item le 2026-08-29.

Des trois « bloquants mécaniques » de juillet, deux sont corrigés (le token Meta par tenant, le budget de
connexions Postgres) ; le troisième, un seul numéro par tenant, est `PLAN.md 5.4`.

## Plan des boucles feature-loop (ordre)

1. ✅ **Loop 1 : Webhook receiver + file + idempotence** (le socle que tout consomme).
2. ✅ **Loop 2 : Wrapper Cloud API + MM Lite** (send text/template, statuts, marketing_messages,
   erreurs + retries + throttling).
3. ✅ **Loop 3 : Contacts BSUID-native + import CSV + user fields** (parsing, dédup, merge CTA).
4. ✅ **Loop 4 : Moteur de campagne + garde-fous** (pacing, fréquence max, coupure quality rating).
5. ✅ **Loop 5 : Adaptateurs Postgres + run E2E** (stores PG, services create/run, routes HTTP
   import/campagne/run, worker campaign-run ; E2E CSV->campagne->envoi prouvé contre Supabase).

Fait ✅ : UI (login, contacts/import, campagnes) + auth JWT/RBAC + déployé **LIVE** sur
`mba.messagingme.app` (1er envoi WhatsApp réel le 2026-07-06, numéro Zadarma).

## Programme 16 features (2026-07-16) : lots restants

Lots A-E LIVE (cf `docs/JOURNAL-TECHNIQUE.md` (l archive)). Restent, dans l'ordre recommandé :
- ✅ **Lot 4b : fin du socle identifiants : FAIT (2026-07-16)** (codes des NODES mintés serveur + champs système
  déterministes + backfill, cf `.loop/lotF-identifiants-4b.md`). Reste le chantier DÉDIÉ **endpoints API publics**
  adressés par code (API keys, auth consommateur externe, scopes, rate limiting -> cadrage produit).
- ✅ **Lot 6 : i18n anglais COMPLET : FAIT (2026-07-16)** (bug lang resync fermé, day/format locale-requis,
  toggle pré-login sur les 5 pages auth, cf `.loop/lotG-i18n-anglais.md`).
- ✅ **Lot 7 : Flow avancé (#6b/#6c) : FAIT (2026-07-17)** : formulaires MULTI-ÉCRANS (onglets builder, ids
  `FORM`/`FORM_B`…, complete agrégé par refs globales, webhook INCHANGÉ), champs CONDITIONNELS (`visibleIf` ->
  propriété `visible`, sondé : champ masqué OMIS du payload, requis caché ne bloque pas), **fix node `flow`**
  (envoi interactif réel + garde fenêtre 24 h à 3 étages). Sondes LIVE avant plan + sonde committée
  `scripts/sonde-flow-live.mts` (générateur produit vs WABA réel). Cf `.loop/lot7-flow-avance.md`.
  ⚠️ Vérif Julien restante (V2) : scénario avec node Formulaire -> envoi réel reçu sur son WhatsApp,
  formulaire multi-écrans rempli -> champs contact + run avancé + carte inbox.
- ✅ **Lot 8 : Campagne « une-page » : FAIT (2026-07-17, 5 phases LIVE)** : écran pleine largeur 2 étapes
  (Préparation / Lancement), sources de destinataires (Liste de contacts requêtable par filtres / Import fichier
  + tag / HubSpot grisé), débit ajustable (mig 0033, timeout de job dimensionné), planification maintenant/plus
  tard (mig 0034, sweeper, annulable). Cf `.loop/lot8-campagne-une-page.md`. ⚠️ Vérif Julien restante (E1/V1) :
  drive navigateur du parcours complet + coup d'œil visuel (pleine largeur, filtres, slider, calendrier).
- **HubSpot import (#14, parké)** = **3e bouton de source** de campagne (le socle source-picker est prêt, il ne
  reste que la source HubSpot) : importer une liste HubSpot comme destinataires. Multi-repo : scope
  `crm.lists.read` sur l'app mm-hubspot + RE-CONSENTEMENT du portail cobaye (action Julien), client lists + route
  service-à-service côté mm-hubspot, proxy + réutilisation `importContacts()` côté mba, opt-in JAMAIS posé à
  'opted_in' par défaut (conformité). + (todo #5-tail) proposer les internal names HubSpot dans les sélecteurs.
- **Analytics palier L (suite #8)** : tracker les erreurs des envois Inbox/Workflow (colonnes d'erreur sur
  `conversation_messages` + toucher le handler de statuts webhook EN PROD, risqué → à froid).
- ✅ **ConvAnalyzer light (Lot 9) : FAIT (2026-07-17)** : bloc « Conversations (analyse) » dans Analytics
  (quanti donut/barres + table quali filtrable -> inbox), sur le moteur Pièce 1 déjà actif. Cf
  `.loop/lot9-convanalyzer.md`. **V2 (backlog)** : ~~(a) agent IA décisionnel branché sur l’analyse~~ **FAIT AUTREMENT, et mieux**
  (2026-08-03) : le déclencheur d’automation `conversation_analyzed` existe, donc une analyse démarre un scénario,
  qui sait poser un tag, écrire dans HubSpot et envoyer. Restent ouverts :
  (b) enrichir le schéma d'analyse pour reprendre ce que le vrai convanalyzer a en plus (urgence graduée 0-5,
  score d'échec du bot, churn, clustering de sujets) ; (c) tendance temporelle stable (joindre
  `conversations.created_at`, pas `conversation_analysis.created_at` qui bouge à la ré-analyse).
- ✅ **Palier 2 : champ booléen + consentement de flow : FAIT (2026-07-17)** : canonicalisation booléenne
  (`crm/fields.ts`, partagée fiche/import/webhook), OptIn de flow -> champ booléen choisi (défaut `whatsapp_optin`
  créé à la volée) ET flip `opt_in_status='opted_in'` (opt-out écrasé, décision Julien), garde double-consentement.
  Cf `.loop/palier2-consentement.md` + cadrage `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md`.
  ⚠️ Dette test : `toBElems` (FlowBuilder) non testé unitairement (fonction non exportée) -> exporter + test
  (optin défaut -> saveTo vide ; optin cible explicite -> saveTo non vide). ⚠️ Vérif Julien : flow avec écran
  de consentement -> coché -> champ « Oui » + statut opt-in + éligibilité campagne marketing.

## Décisions API/HubSpot tranchées (2026-07-17) -> paliers restants

Cf `~/messagingme-pilot/docs/CADRAGE-MBA-API-CONTENU-HUBSPOT.md` (D-1..D-10 validées par Julien). Paliers :
- ✅ **Palier 3 (Phase A+B) : API publique v1 : FAIT (2026-07-17)** : clés d'API (`api_keys`, scopes
  contacts:write/sends:create, rôle synthétique 'api'), résolveur code+nom (409 ambigu), `POST /v1/contacts`
  (+ batch), `POST /v1/sends` (scénario + template, `Idempotency-Key` obligatoire + claim atomique, rapport
  skipped détaillé, upsert-then-send), `GET /v1/sends/:id`, CRUD clés admin. Migration 0035. Cf
  `.loop/palier3-api.md`. Reviewer sécurité : 🔴 double-envoi (idempotence libérée post-enqueue) trouvé + corrigé.
  - ✅ **Phase B2 : cible node : FAITE (2026-07-18)** : `WorkflowExecutor.startFromNode` (garde 24 h de `start`
    conservée intacte), `PgInboxStore.getWindowOpenByWaIds` (fenêtre en lot, 1 requête), `Campaign.startNodeId`
    de bout en bout, branche `startWorkflowFromNode` du moteur, `POST /v1/sends` accepte `{node:'nod_...'}`.
    Hors fenêtre -> `skipped:{reason:'out_of_window'}`, jamais d'envoi. `createMissing` forcé à false et `params`
    refusé (400) sur cette cible. Aucune migration (0035 portait déjà la colonne). Reviewer PASS.
    Cf `.loop/palier3-b2-et-robustesse.md`.
  - ✅ 🟡 **follow-up enqueue : FAIT (2026-07-18)** : retry borné (3 tentatives, backoff 100/300 ms) au lieu d'un
    sweeper. Motif : un sweeper qui ré-enfilerait les campagnes `draft` relancerait aussi les brouillons créés à
    la main dans l'UI et jamais lancés volontairement (= envois non désirés). L'idempotence reste scellée
    inconditionnellement sur tous les chemins.
  - 🟡 **runs de workflow orphelins** (reviewer 2026-07-18, pré-existant, rendu probable par la cible node) :
    `PgWorkflowRunStore.findWaitingByWaId` prend le run `waiting` le plus RÉCENT. Un contact qui avait déjà un run
    en attente (campagne scénario) et à qui on envoie un bloc se retrouve avec 2 runs : le 2e avance et se
    termine, puis une réponse ultérieure réveille le PREMIER et envoie un message que personne n'a demandé.
    Correctif proposé : dans `PgWorkflowRunStore.start`, clore les runs `waiting` du même (tenant, wa_id) avant
    l'insert (l'index partiel `workflow_runs_waiting_idx` couvre déjà l'écriture). Change la sémantique de cycle
    de vie des runs pour TOUTES les campagnes -> décision Julien avant de le faire.
  - 🟡 **`phoneNumberId` ignoré à l'envoi workflow** (reviewer 2026-07-18) : `/v1/sends` valide le numéro et le
    persiste sur la campagne, mais `worker.ts` (sendTemplate/sendQuickMessage/sendFlow du workflow) résout le
    numéro via `getTenantPhoneNumberId` = le PREMIER numéro du tenant. Zéro impact avec un seul numéro ; au 2e,
    un appel API explicite partirait du mauvais expéditeur en silence. Correctif : passer `campaign.phoneNumberId`
    jusqu'aux callbacks de l'executor.
  - 🟡 **intégration `queue.integration.test.ts`** : échoue en EMAXCONNSESSION (pooler Supabase plafonné à 15
    sessions, partagées avec la prod mba-api/mba-worker). `fileParallelism: false` a réglé les 5 autres fichiers
    (17 -> 60 tests verts). Reste à borner les pools de ce test précis, ou à le pointer sur une autre base.
- ~~Palier 3 (ancien cadrage)~~ remplacé par l'entrée ci-dessus.
  Rappel de portée (fait) : `POST /v1/sends` scénario + template, node = fenêtre 24h uniquement (D-1, Phase B2).
- 🔶 **Palier 4 : import listes HubSpot (Phase 0+1 FAITES 2026-07-18)** : toggle self-serve + re-consentement
  ciblé (`optional_scope=crm.lists.read`, mécanisme natif HubSpot, ne touche pas les autres portails). Phase 0
  (connecteur mm-hubspot) : client Lists (search/memberships/batch-read borné 5000), OAuth optional_scope +
  granted_scopes + garde anti-hijack, route service signée `/service/lists[/contacts]`. Phase 1 (mba) : toggle
  `hubspot_lists_enabled`, proxy signé, `importHubspotList` (opt-in JAMAIS opted_in, garanti au niveau du type,
  tag `HubSpot: <nom>`). Migrations 0007 (mmhs) + 0036 (mba). Reviewer cross-repo PASS. Cf
  `~/mm-hubspot/.loop/palier4-lists-connecteur.md`.
  - ✅ **Phase 2 (UI mba) FAITE (2026-07-18)** : toggle « Campagnes via données HubSpot » + CTA re-consentement
    sur /accueil (dans le bloc portail connecté), 3e bouton de source de campagne activé + composant
    HubspotListImport (liste -> sélection -> import, tag serveur source de vérité). Reviewer logique PASS (2 🔴
    corrigés : mismatch de tag, getSettings dans Promise.all). **RESTE Phase 3 (Julien)** : re-consentement réel du
    portail cobaye 139615673 + import de test.
  - ✅ 🟡 (a) **`searchLists` paginé : FAIT (2026-07-18)** : boucle par `offset`, arrêt sur `hasMore=false`,
    `total` atteint, page vide, borne 500 listes ET borne dure d'itérations, chaque troncature loguée.
  - ✅ 🟡 (b) **`/service/*` fermé au public : FAIT (2026-07-18)** : `advanced_config` sur le proxy host NPM 22
    (`mm-hubspot.messagingme.app`), `location ^~ /service/ { return 404; }`. mba appelle le connecteur en INTERNE
    (`HUBSPOT_SERVICE_URL=http://mm-hubspot-api:8096`), donc sans passer par NPM. Vérifié après bascule : public
    `/service/lists` -> 404, `/health` -> 200, `/ingest` -> 401 (inchangé), interne `/service/lists` -> 401
    (vivant, signature exigée).
- **Palier 5 : échelle d'autonomie HubSpot (4 niveaux)** : curseur sur le dashboard (N1 suggère, N2 actions
  sûres, N3 Deal auto, N4 autonome), seuil de confiance interne calibré par niveau (D-8/D-9/D-10). 5a = N1-2 +
  curseur + setter `autonomy_level` ; 5b = N3 (Deal auto) après mesure.
- **Drop différés** : rien (0030 a droppé `workflows.status` ; codes = additifs).

## Suites des revues Automation (2026-08-03) : identifiées, NON traitées

Trois points relevés par les revues adversariales des lots E/E.2/F, jugés non bloquants et laissés de côté.
Chacun est un compromis assumé, pas un oubli.

- **Pas de sweeper des parcours en attente.** Un parcours qu'un contact ne fait jamais avancer reste « en
  attente » indéfiniment. Aujourd'hui une automation l'ignore au bout de 7 jours (fenêtre d'âge), ce qui
  débloque le contact, mais la ligne reste en base. Un balayage qui les clôt proprement serait plus sain.
- **Le numéro qui teste un scénario compte dans la statistique Contacts.** Les messages du test sont bien
  exclus des chiffres et de l'analyse, mais la fiche contact créée par le test, elle, est comptée comme
  n'importe quel contact. L'écran de test le dit, ce n'est donc pas un mensonge, juste une imprécision.
- **Le signal « nouveau contact » ne survit pas à un rejeu du webhook.** Si le traitement d'un message échoue
  après la création de la fiche et qu'il est rejoué, le contact n'est plus « nouveau » : un déclencheur
  « nouveau contact » ne partira pas pour lui. Le rendre infaillible imposerait une requête de comptage sur
  chaque message entrant, prix jugé trop élevé pour un cas qui suppose déjà un incident.

## Chantier OTP + étapes de deal HubSpot (ouvert le 2026-08-16)

Contexte et gotchas : `docs/JOURNAL-TECHNIQUE.md` (l archive). ⚠️ Le compteur de migrations vit dans `CLAUDE.md`, pas ici : cette ligne a annoncé « 0059 » pendant trente migrations.

- 🔴 **Le pilote OTP, avant toute construction.** Répondeur Zadarma sur un numéro DÉDIÉ, un OTP déclenché, et
  on regarde si Meta dicte son code à une machine ou raccroche. Aucun retour d'expérience publié : c'est la
  seule question qui décide si le full-auto vit. Ne jamais utiliser un numéro qui sert Odalys, EDHEC ou Gan
  Prévoyance : une écriture de routage les couperait.
- **Le dossier d'identité (KYC) par numéro français** : un seul dossier au nom de la société, réutilisable, ou
  un par client final ? La deuxième réponse ramène le geste manuel par la porte juridique et touche le modèle,
  pas le code. À trancher AVANT d'industrialiser.
- **Réserve de numéros en base** (migration 0056) : quel numéro est alloué à quel embarquement, et son état.
- **Route + écran qui affiche le code en direct.** Sert dans les DEUX scénarios : c'est l'affichage du repli
  assisté si le full-auto meurt, et le suivi de la capture s'il vit. Avec un bouton « renvoyer le code ».
- **Instancier `ZadarmaClient` dans `index.ts`** à partir de la config (rien ne le fait aujourd'hui).
- 🟡 **L'aperçu de template n'affiche pas le visuel d'en-tête.** `web/components/TemplatePreview.tsx` ne
  transmet pas la prop `header` que `WhatsAppPreview` accepte pourtant déjà. Purement cosmétique (l'envoi, lui,
  joint bien le visuel depuis le 2026-08-17), mais ça donne un aperçu qui ne ressemble pas au message reçu.
- ✅ **Menu des étapes de deal dans l'écran Automation** (fait et déployé le 2026-08-16).
- ✅ **Souscription webhook HubSpot envoyée** (2026-08-16, build #8 sur le compte dev 148896252). La chaîne
  est donc vivante de bout en bout ; reste à l'éprouver sur le portail cobaye avec un deal dont le contact
  porte un numéro, et un scénario qui ouvre par un template.

## Suite de l'audit anti-slop (2026-08-18) : 1 item sur 57

Les 6 rouges et 50 des 51 jaunes sont corrigés et déployés (cf. `AUDIT-ANTI-SLOP-2026-08-18.md`). Ne reste que celui-ci, laissé
volontairement à l'arbitrage de Julien.

- 🟡 **Découper `web/lib/api.ts`** (1325 lignes, 203 exports, une quinzaine de domaines) par domaine dans
  `web/lib/api/`, derrière un barrel qui re-exporte tout (aucun import appelant ne change). Le repo pratique
  déjà l'extraction avec shim de re-export (`contact-filters`, `field-kinds`). Mécanique, mais ça brasse tous
  les imports du front, d'où l'arrêt : à faire dans un lot dédié, pas en fin de session. ⚠️ Reporter le
  `'use client'` de tête dans les modules qui touchent `session`/`window`.

## MBA ouvert sur la France (2026-08-18) : ce que la doc fraîche impose d'instruire

Contexte : `agent_eligibility` renvoie `is_eligible:true` sur `+33 5 25 68 03 01` (ToS acceptées par Julien),
et Meta a modifié 6 pages entre le 11 et le 15 août dont une page `changelog` neuve. Relevé complet :
`docs/MBA-API-REFERENCE.md` § « Ce qui a changé chez Meta ». Rien n'est cassé, rien n'est branché.

- 🔴 **Instruire « configured escalation partner ».** C'est la condition d'accès à l'action `take` de
  `thread_control`, donc au handoff propre vers un humain, donc à la plus-value centrale du produit. Meta
  écrit la restriction et ne définit NI qui désigne ce partenaire, NI comment. Sans réponse, on reste sur la
  prise de contrôle par envoi de message. À poser à Meta, ou à mesurer sur le numéro de test.
- 🔴 **Relever le nom exact des deux nouveaux champs de `handoff`** (« release thread control after sending a
  handoff message » et « source du message : CUSTOM / AGENT / DEFAULT »). Leur description est documentée,
  pas leur nom : il faut le lire dans le rendu de la page ou le déduire d'un GET une fois un handoff
  configuré. Ne pas coder dessus avant.
- 🔴 **Le read-modify-write de `settings` doit repasser les clés inconnues telles quelles.** La ressource est
  en remplacement complet ; un modèle typé fermé (Zod ou interface qui ne connaît que `enabled`/`message`)
  effacerait `never_say_phrases` et les champs de handoff au premier PUT, sans que personne l'ait demandé.
- 🟠 **Dire au client qu'un moyen de paiement conditionne la LIVRAISON**, pas seulement l'activation :
  « messages are not delivered unless your Business Agent account has a payment method attached ». Rien ne le
  signale côté console aujourd'hui.
- 🟠 **Lire les deux pages Meta jamais transcrites** : `agent-insights` (quelles sources de connaissance et
  quelles skills ont servi à répondre, utile pour expliquer une réponse à un client) et `capabilities`. Elles
  sont désormais dans la veille.
- 🟡 **Modèle de coût** : les messages MBA ont un régime tarifaire propre (grille « non-template messages »),
  que notre estimation par catégorie de template ne couvre pas.
- 🟢 **`agent_test` ne facture pas les jetons** (« Tokens consumed while testing through this endpoint are not
  billed »), écrit deux fois dans la page : la QA peut s'appuyer dessus sans compter.

## Post-live : prochaines actions

- 🟡 **Aucun outil de rejeu de la file d échecs (DLQ).** Un job en échec part dans `<file>-dlq`, que RIEN ne
  consomme : il y reste indéfiniment. Un message entrant y dort depuis le 2026-08-17. Une commande `/ops` qui
  liste et rejoue une entrée éviterait de perdre de la donnée à chaque incident de schéma.
- 🟡 **Une file sans consommateur devrait CRIER.** Le worker annonce `[inerte]` au démarrage quand une
  fonctionnalité n est pas configurée, mais personne ne lit cette ligne. Une alerte (Telegram, comme
  l error-tracking) au démarrage d une file inerte aurait économisé une journée sur le déclencheur HubSpot.


- ✅ **Token permanent POSÉ (2026-07-08).** `META_ACCESS_TOKEN` = token System User permanent
  (`expires_at:0`, scopes messaging+management), dans `.env.prod` du VPS. Templates create+list
  validés en live via l'app. Détails : `brain/PROJECTS.md` §Meta/WhatsApp.
- ✅ **Placeholders demo supprimés (2026-07-08).** `demo-pn`/`demo-waba` (seed) traînaient sous le
  tenant réel et gagnaient le `order by created_at limit 1` -> 502 templates. DELETE des 2 lignes.
- **Template `mba_console_test`** (id `1507311428074574`, PENDING) : template de test créé pour prouver
  la feature. Supprimable depuis l'onglet Templates quand tu veux.
- **Onboarding client (Embedded Signup)** : Facebook Login for Business (config_id) → bouton ES +
  échange de token BISU côté backend → **Access Verification (Tech Provider)** + **App Review**
  (Advanced Access sur les perms WhatsApp, screencast par permission). Ni l'un ni l'autre requis
  pour NOTRE propre numéro (rôle sur l'app), mais requis pour brancher les WABA de clients.
- ✅ **Veille MBA POSÉE (2026-07-09)** : cron VPS `ops/mba-eligibility-watch.mjs` (crontab ubuntu,
  toutes les 6h) qui poll `GET api.facebook.com/{pnid}/agent_eligibility` (X-API-Version 2.0.0).
  Baseline = 403 « Meta Business AI Terms » (`BLOCKED_TOS`, état dans `.mba-eligibility-state.json`).
  Alerte Telegram (`@Messagingmeapp_bot`, creds lus au runtime depuis `messagingme-pilot/config.json`)
  au moindre changement d'état (mur ToS levé → MBA ouvre FR). Log `.mba-eligibility.log`.

## ✅ Suites revue templates + inbox : TOUT RÉSOLU (2026-07-08)

- ✅ **Bouton URL dynamique** : `buildComponents` émet l'`example` bouton quand l'URL contient `{{n}}`.
- ✅ **Types interactifs Flows** : `nfm_reply` capturé (corps + `response_json` en payload), réaction
  (emoji), médias (légende ou `[type]`), localisation, sous-type inconnu -> `[interactif]`. Plus de
  perte silencieuse.
- ✅ **Liaison contact** : match `'+'||wa_id` PUIS chiffres normalisés (`regexp_replace`) -> tolère un
  formatage différent.
- ✅ **Message Meta** : 502 tronqué à 200 car., espaces compactés.
- ✅ **Templates list** : pagination complète (suit `paging.next`, cap 20 pages).

## ✅ Sécurité / auth : RÉSOLU (était BLOQUANT à la revue Loops 3-5)

Auth construite et déployée : login JWT (scrypt async, rate-limit, hash leurre anti-énumération),
isolation tenant sur toutes les routes (tenant DÉRIVÉ du JWT, 403 si mismatch), RBAC (écritures
admin-only via `forbidNonAdmin`), ownership `phoneNumberId` validée, `AUTH_SECRET` fail-fast en
prod. Résidus non bloquants ci-dessous.

## Suites de la revue sécurité auth

- ✅ **RBAC** : `forbidNonAdmin` applique le rôle admin sur les écritures (import, création + run
  de campagne). Reads ouverts aux comptes authentifiés. Matrice à affiner si un rôle `agent` est
  réellement provisionné.
- ✅ **Compte démo** `admin@demo.test` désactivé en prod (password_hash null, réversible).
- ✅ **AUTH_SECRET** : boot prod échoue si absent/faible ; posé sur le VPS.
- ✅ **Unicité email** : tranché -> email GLOBAL insensible à la casse. Migration 0010 (index
  `users_email_lower_unique` sur `lower(email)`), `findByEmail` matche `lower(email)`. Fin du
  non-déterminisme multi-tenant.

## ✅ Dashboard v2 : prix templates MARCHE EN PROD (corrigé 2026-07-10)

⚠️ CORRECTION d'une conclusion erronée. J'avais écrit que `pricing_analytics` était bloqué par
l'Advanced Access (403 #200). **C'était FAUX** : la sonde avait tourné avec le token du `.env` LOCAL,
qui est limité/périmé, PAS le token permanent de prod. Re-testé DANS le conteneur `mba-api` (vrai token
`.env.prod`) : `pricing_analytics` renvoie **200 + vraies données** (marketing 0,0712 / utility 0,0248…).
Donc **le prix par template s'affiche déjà en prod** (le getPricing déployé utilise le bon token). Aucun
App Review requis pour l'analytics de NOTRE WABA. Pas de dégradation « indisponible » en réalité.

- **Leçon (cf. LEARNINGS)** : le `META_ACCESS_TOKEN` du `.env` LOCAL n'est PAS le token de prod. Toute
  sonde Meta doit tourner **dans le conteneur / avec le token de prod** (`docker cp` + `docker exec mba-api
  node ...`), jamais avec un scratch local, sinon faux négatifs (#200 « Provide valid app ID »).

## Dette Feature 2 : Admin + RBAC (revue adversariale 2026-07-10)

RBAC posé : rôles `admin`/`agent`, agent = inbox uniquement (garde serveur `makeRequireRole`
sur tous les groupes sauf inbox + templates GET, source de vérité), onglet Admin (liste users,
créer un agent, changer un rôle). Corrigé à la revue : 🔴 templates GET remis en `requireAuth`
(l'inbox agent en dépend) ; invariant « ≥1 admin/tenant » forcé EN BASE dans `setRole` (refus
`last_admin` -> 409) ; tests agent->403 ajoutés sur contacts/import. Résidus non bloquants :

- ✅ **JWT figé sur changement de rôle / révocation : RÉSOLU (2026-07-10)** : `requireAuth` relit
  l'état du compte EN BASE à chaque requête authentifiée (`getUserState` -> `PgUserStore.getAuthState`) :
  compte supprimé/révoqué -> 401 immédiat, rôle rafraîchi depuis la base. Un changement de rôle, une
  révocation ou une suppression prennent effet TOUT DE SUITE, plus de fenêtre de 12h. Coût : un lookup
  PK par requête (négligeable à ce volume). Optionnel (absent en test -> JWT seul).
- 🟡 **Oracle d'existence d'email cross-tenant** : POST /users renvoie 409 si l'email existe DÉJÀ
  ailleurs (index unique GLOBAL `lower(email)`, migration 0010). Un admin peut ainsi sonder si un
  email est déjà un compte console d'un autre tenant (fuite limitée à l'existence, message générique,
  pas de PII ni de tenant révélé). Conséquence assumée du design « un email = un compte global ».
  Fermer l'oracle imposerait de repasser à l'unicité par tenant + login scopé au tenant (changement
  de schéma qui touche le login) -> à trancher côté produit, pas en aveugle.
- 🟡 **Course théorique zéro-admin** : deux rétrogradations croisées simultanées (READ COMMITTED)
  pourraient toutes deux voir count>1. Négligeable (2 admins à la milliseconde). Fermer via
  transaction + `SELECT ... FOR UPDATE` si on ajoute un jour token_version.

## Suites de la revue Loops 3-5

- ✅ **Réconciliation `sending`** : sweeper `reclaimStale` en place (worker.ts, `STALE_SENDING_MS`),
  reset `sending` -> `pending` au-delà du timeout.
- ✅ **createCampaign transactionnel + bulk** : `createWithRecipients` est dans un BEGIN/COMMIT et
  insère les destinataires en UNE requête (`unnest`, helper `bulkInsertRecipients`, idempotent
  `on conflict do nothing`). `insertRecipients` idem.
- 🟡 **quality getRating** : lu à chaque destinataire (point-query PK). Mémoïser (TTL court) si la
  volumétrie l'exige. Dominé par l'appel Meta aujourd'hui -> laissé tel quel.

## Raffinement invariant admin (lot 6 P3, non bloquant)

Les sous-requêtes « ≥1 admin actif » de `PgUserStore.setRole/setDisabled/deleteUser` comptent
`role='admin' and disabled_at is null` SANS exclure les comptes **pending** (password_hash null, invitation non
acceptée). Non exploitable (self-block + un pending ne peut pas s'authentifier), mais correctness-of-intent :
ajouter `and password_hash is not null` aux 3 sous-requêtes pour qu'un admin invité jamais activé ne compte pas
comme « admin actif ». Défense en profondeur, à faire à froid (touche du SQL d'invariant sécurité).

## Refonte auth : ✅ FAITE (Lot 6, 2026-07-13)

Inscription libre + Google + invitations Resend + mot de passe perdu/reset/changement, tous LIVE. Détail :
`docs/JOURNAL-TECHNIQUE.md` (l archive) §Lot 6. Domaine Resend vérifié + client OAuth Google configuré (origine JS + app publiée par Julien).

## Vérifier l'identité BSUID au 1er trafic réel (lot 4)

L'envoi route déjà un BSUID en `recipient` (vs `to` pour un numéro) via `messagingTarget`, et l'inbound
auto-crée les fiches (numéro OU BSUID). Mais **aucun contact BSUID n'existe encore** (le BSUID post-octobre
n'a pas commencé à remonter). Au 1er BSUID réel : (1) confirmer le format Meta et l'heuristique
`classifyWaId` (7-15 chiffres = numéro, sinon BSUID) ; (2) vérifier qu'un template part bien via `recipient`
et est délivré ; (3) vérifier que la fiche auto-créée + le matching merge/tag/conversation collent au format
réel. Cf `documentation.md §Identité`.

## Suites builder Lot 5 : node à sorties par bouton (V2, non bloquant)

Signalés à la revue Phase 3 (sous le seuil de confiance, défense en profondeur) :
- **Snapshot des boutons figé** : le node template mémorise `templateButtons` à la sélection. Si on ÉDITE
  ensuite le template (réordonner/renommer les boutons) sans ré-ouvrir le node, le workflow garde l'ancien
  ordre -> un bouton pourrait brancher vers la mauvaise cible (le payload `btn:<i>` reste posé sur l'index i).
  Fix possible : re-fetch les boutons courants du template à l'exécution, ou invalider/re-valider le node quand
  le template change. Conditionnel (édition après câblage), pas bloquant.
- **Arêtes orphelines à la re-sélection** : changer le template d'un node déjà câblé ne purge pas les arêtes des
  anciens `sourceHandle` disparus ; combiné au repli `nextNode` (1re arête), une arête morte pourrait être
  choisie. Fix : purger les arêtes du node dont le `sourceHandle` n'existe plus au changement de template.

## Suites builder Lot 3 (V2, non bloquant)

- **Branche par bouton quick-reply** : PB2 avance aujourd'hui sur N'IMPORTE QUELLE réponse inbound. Pour un
  vrai arbre (bouton A -> bloc X, bouton B -> bloc Y), mapper les arêtes sortantes d'un bloc template sur ses
  boutons (`sourceHandle` déjà prévu dans le modèle de graphe). À faire quand un scénario réel le réclame.
- **Livraison/lecture des campagnes workflow** : message_id synthétique `wf-<id>` -> le funnel affiche
  delivered/read/replied = 0 pour ces campagnes. Câbler un vrai suivi imposerait de relier le wamid du 1er
  template envoyé par le workflow au destinataire de campagne. Limitation V1 assumée.

## Décisions ouvertes

- **OTP post-octobre** : espérer un équivalent WABA-only en ES v4 ; sinon construire le
  fallback « copy-paste assisté ». Solution Partner écarté (hors de portée court terme).
- **Vertical de notre WABA** vs les 5 verticaux MBA : trancher via `agent_eligibility`
  post-ToS.
- **PaaS** : point de décision à l'entrée Phase 3 (Fly.io Paris / Railway EU, critère RGPD).

## Dette de la revue Loops 1-2

- ✅ **Test DLQ** : test d'intégration qui prouve job qui throw -> `<name>-dlq` (retryLimit
  configurable + `pullPending`, 1 seule tentative avec retryLimit:0).
- ✅ **CI intégration** : job `integration` (service Postgres 16, `DB_SSL=off`, migrate +
  `test:integration`) ajouté à `.github/workflows/ci.yml`.
- 🟢 **parse.ts** : VÉRIFIÉ, pas de double-comptage. Chaque sous-événement a une `dedupKey`
  distincte par source (rien ne collapse) ; messages+statuses arrivent sous le même `field:messages`
  donc le routage par tableau est le bon choix (gater par `field` serait fragile aux versions Meta).
- ⏸️ **`webhook_events` renommage `meta_message_id` -> `dedup_key`** : décision de NE PAS le faire.
  Renommer une colonne sur le chemin chaud du webhook (coordination migration+déploiement, fenêtre
  d'échec d'insert) pour un gain purement cosmétique n'en vaut pas le risque ; la couche appli
  utilise déjà `dedupKey` et la colonne est documentée. `tenant_id`/`waba_id` : prématuré tant
  qu'aucun consommateur analytique n'existe (colonnes vides = spéculatif).
- ⏸️ **`processed_at`/`error`** : sémantique à trancher (log brut d'ingestion vs statut de
  traitement réel). Décision produit, pas un bug.

## Raffinements notés

- ✅ **Loop 3 / import collision** : deux colonnes -> même custom key est signalé (`report.errors`
  « colonnes fusionnées »), 1re valeur non vide gagne.
- ⏸️ **Loop 3 / slugify** : deux labels distincts -> même key = fusion (1er gagne) + warning.
  Décision : on GARDE ce comportement. Disambiguer en `ville_2` casserait silencieusement le mapping
  des variables de template (l'utilisateur mappe sur `ville`). Le warning est le bon compromis.
- ✅ **Loop 2 / `withRetry`** : ne rejoue QUE `MetaApiError.retryable` + codes réseau connus
  (`NETWORK_CODES`), pas un throw arbitraire.
- ✅ **Loop 2 / `MetaClient`** : test « `rateLimiter.acquire()` appelé à chaque tentative » ajouté.
- ✅ **Loop 5 / existence campagne** : `campaignBelongsTo` = `select 1 ... where id and tenant_id`.
- ✅ **Loop 5 / `insertRecipients`** : bulk insert (`unnest`).
- 🟡 **Loop 5 / état `queued`** : la route `run` enqueue sans état intermédiaire visible (reste
  `draft` jusqu'à `running`). Une future UI voudra peut-être un `queued`. Décision produit.
- 🟡 **Loop 5 / quality rating** : `PgQualityProvider` lit `phone_numbers.quality_rating` (défaut
  UNKNOWN). Câbler l'alimentation par webhook `phone_number_quality_update` (feature, pas un bug).

## À durcir / suites (2026-07-15)

- ✅ **Bouton FLOW dans l'envoi workflow : FAIT (2026-07-16)** : `buildWorkflowTemplateComponents` génère désormais
  le composant `{sub_type:'flow', parameters:[{type:'action', action:{flow_token}}]}` par bouton FLOW (corrige #131009).
  Vérifié empiriquement contre la Cloud API. Détail : `CLAUDE.md` §Gotchas 2026-07-16.
- ⚠️ **Variables de template non contiguës** (`{{1}}` + `{{3}}` sans `{{2}}`) : le front compte les positions distinctes
  (Set) alors que le backend attend 1..N contigu -> désalignement possible. Pré-existant (mode direct), pas introduit
  ce lot ; à corriger si un template non contigu apparaît.

## Suites Embedded Signup / i18n (2026-07-16)

- 🔄 **Refresh du business token ES (60 j)** : le token BISU par-client expire à 60 j. Aujourd'hui il ne sert qu'à
  l'onboarding (subscribe webhooks), donc son expiration est sans impact. **Quand on enverra les campagnes avec le
  token PAR-CLIENT** (au lieu du `META_ACCESS_TOKEN` global), câbler le refresh + l'alerting d'expiration.
- 📤 **Envoi via le token par-client** : le worker envoie aujourd'hui avec le token global (marche pour NOTRE numéro).
  Pour de vrais clients onboardés, router l'envoi/les lectures sur le business token du WABA du client.
- 🗑️ **Supprimer le compte de test reviewer** `meta-review@messagingme.app` (admin Demo) **après approbation** de
  l'App Review Meta. Le garder tant que la review n'est pas passée (Meta peut re-tester).
- 🌐 **i18n** : spot-check des chaînes visibles restées en français en mode EN (build vert + grep « aucune valeur
  backend traduite » OK, mais quelques chaînes rares ont pu être oubliées). Corriger au fil des retours de Julien.

## Bugs connus

- 🟡 **`web/e2e/inbox-envoi-scenario.spec.ts` est INSTABLE sous charge parallèle** (constaté deux fois le
  2026-09-02, sur deux tests DIFFÉRENTS du même fichier). Il passe 10 sur 10 en isolation et 5 sur 5 en
  répétition ciblée ; il tombe environ une fois sur trois quand les 417 e2e tournent à quatre workers.
  Son helper `ouvrirPanneau` porte déjà un `toPass({ timeout: 20_000 })`, donc son auteur le savait fragile :
  le panneau met parfois plus de 20 s à s'ouvrir quand la machine est chargée.
  ⚠️ **Ne PAS le rendre plus tolérant pour le faire taire** : il finirait par ne plus rien prouver. La bonne
  piste est de comprendre CE QUI met 20 s (probablement une attente réseau simulée qui n'est pas encore
  installée quand le clic part), pas de relever le délai. En attendant, une CI rouge sur ce fichier seul se
  relance.

## Chaîne WhatsApp (Channels Me), avant la mise en service

⚠️ **Cette section a affirmé « le front n'est PAS fait » jusqu'au 2026-09-07 au soir**, alors que les écrans
Chaîne étaient livrés, testés de bout en bout et servis en production. Un paragraphe qui décrit un ÉTAT
vieillit sans prévenir : il est réécrit ici pour ne dire que ce qui RESTE à faire.

**Livré et en service** (migrations 0114 et 0116, signeur, client, trois stores, moteur, routes, écran Chaîne
complet : composeur avec mise en forme et smileys, téléversement de photo, liens, publications avec leur
scénario et leur mesure). Ce qui suit reste ouvert.

- 🔴 **Un échec d'allumage après publication ne réveille personne.** `POST /posts` répond désormais 201 dès
  que le post est parti, et c'est voulu : un 500 aurait poussé à republier vers toute l'audience, alors que
  `createMessage` n'a aucune clé d'idempotence. L'échec part dans un champ `avertissements` et dans le journal
  (`channelsme_distant_ko`), mais **aucune alerte n'y est branchée** et aucun écran ne lit ce champ. Une panne
  SYSTÉMATIQUE de l'allumage laisserait donc des posts au bouton mort, visibles seulement dans les journaux
  bruts. Deux pistes : afficher `avertissements` dans l'écran Chaîne, et alerter sur la répétition de
  `channelsme_distant_ko` comme on le fait déjà pour les refus `/ops`.
- **Régler le plafond horaire propre au lien.** Le mécanisme existe (colonne `max_par_heure` sur le lien, et
  le runner lit le plafond de l'automation avant celui de l'instance), mais personne ne sait combien
  d'abonnés appuient sur le bouton dans l'heure qui suit une publication. Poser une valeur généreuse pour le
  pilote, puis la régler sur la mesure du PREMIER vrai post. Sans ça, le plafond global de 200 ignore les
  suivants en silence.
- **Mesurer la longueur maximale d'un texte de post** chez le fournisseur. Aujourd'hui la console comptera
  sans refuser et relaiera le 422 distant, faute de valeur connue.
- **Provisionner la connexion du tenant pilote** (org, chaîne, clé, secret) via `PUT /connection`, puis
  vérifier avec `POST /connection/test`.

## Plus tard (V2+)

- Sync CRM (audiences entrantes + « zéro saisie » sortant : extraction post-conversation).
- Recettes événementielles (agent_event vs template selon fenêtre ouverte).
- Couche pub : wedge CTWA + attribution (referral/ctwa_clid + Conversions API).
- Coexistence (option d'onboarding app → API).

## Chaîne : le comptage des conversations quand la table des messages aura grossi

`PgChannelsMeLinkStore.conversationsParLien` relit les messages entrants et compte en JS, avec
`normalizeText`, parce que c'est la SEULE définition de « ce message correspond à cette phrase » et que la
réécrire en SQL en créerait une seconde (`lower()` ne retire pas les accents, `unaccent` n'est ni installé ni
immuable sur cette base). La lecture est bornée deux fois : par la date du plus ancien lien, et par
`MESSAGES_CONVERSIONS = 20 000`, au-delà duquel l'écran dit « au moins N » au lieu d'un total.

**Mesure du 2026-09-07 : 89 messages entrants WhatsApp sur toute la base de production.** Le plafond est donc
à trois ordres de grandeur du besoin, et cette entrée n'est pas urgente.

⚠️ **Cette route ne porte PAS `limiteCouteuse`, et c'est un choix aligné sur le dépôt, pas un oubli** : aucune
route de `/stats` n'en porte non plus, alors qu'elles agrègent davantage. Le plafond général (300/minute par
utilisateur) s'applique. Si le profil de charge change, c'est la première chose à revoir.

**La bonne réparation, le jour venu, et elle préserve la justesse** : préfiltrer en SQL sur le plus long
segment de la phrase qui ne porte NI accent NI espace (« Réserver ma place » -> `place`). Tout corps qui
contient la phrase entière contient forcément ce segment, donc le préfiltre ne peut RIEN perdre, et le
comptage exact reste en JS sur les survivants. Repli quand aucun segment ne qualifie (phrase entièrement
accentuée) : pas de préfiltre, comportement actuel.

## 🟡 `campagne-assistant-recap` : la garde d'empilement est instable EN LOT (mesuré le 2026-09-12)

Le cas « le tableau, le bloc de coût et le bouton sont EMPILÉS » échoue par intermittence, mais
**seulement quand le fichier est lancé avec d'autres specs**, jamais seul.

**Quantifié dans les deux sens avant de conclure**, comme la règle du dépôt l'exige : **4 exécutions
vertes sur la référence** et **4 exécutions vertes avec le changement soupçonné**, en isolé. En lot,
il tombe environ une fois sur deux, sur la référence comme sur le code modifié. Ce n'est donc pas une
régression, et surtout ce n'est pas la faute du dernier qui l'a vu rougir.

⚠️ **Ne PAS l'affaiblir pour le faire taire.** L'assertion qu'il porte est celle qui attrape trois
blocs côte à côte, que ni `pasDeDebordement` ni `pasDeChevauchement` ne voient. C'est la garde la
plus utile de l'écran.

**La piste** : `boundingBox()` est lu sans attendre que la mise en page soit stabilisée. En lot, le
serveur de dev sert plus lentement et la mesure part avant la fin du rendu. La réparation est une
attente sur un état RENDU (les trois blocs visibles ET leur hauteur non nulle) avant de mesurer, pas
un `waitForTimeout`.

## 🟡 Cocher « heures ouvrées » sur un espace SANS jour ouvert condamne la campagne (relevé au lot 7, 2026-09-12)

**Le comportement est documenté et voulu**, pas accidentel : sans aucun jour ouvert,
`prochaineOuverture` rend `null`, la campagne se met en pause `hors_horaires` **sans échéance**, et
`reprendreCampagnesDues` exige `paused_until is not null`. Elle ne repart donc jamais toute seule.
⚠️ Ce n'est PAS silencieux : `messageDePause` l'explique à l'opérateur, avec la même sémantique
qu'une pause de qualité.

⚠️ **LA MOITIÉ « ÉCRAN » DE CE POINT EST CLOSE DEPUIS LE 2026-09-13.** Elle disait que le manque
était dans l'ancien formulaire, qui laissait cocher la case sans prévenir : cet écran a été RETIRÉ, et
l'assistant, seul chemin de création désormais, avertit au moment du clic (« aucune heure d'ouverture
n'est réglée »). C'est la bonne place : au moment de la décision, pas au moment de la panne.

⚠️ **MESURÉ LE 2026-09-12 : l'espace « Demo » a ZÉRO jour ouvert.** C'est celui sur lequel les essais
se font. Le piège est donc armé là où on teste, et zéro campagne y est bloquée aujourd'hui.

**Il ne reste donc qu'UNE question, et elle demande une décision** : un espace sans aucun jour ouvert
doit-il être traité comme « toujours ouvert » pour l'envoi initial ? Cela alignerait le comportement
sur celui du rattrapage (`fenetreDeRattrapageOuverte` rend déjà `true` dans ce cas). C'est plus
cohérent, mais cela change un comportement d'ENVOI : ça ne se fait pas sans décision explicite.

## 🟡 Le choix de l'EXPÉDITEUR a disparu avec l'ancien formulaire (relevé au lot 8, 2026-09-13)

L'assistant pose `phoneNumberId` sans le faire choisir. `CampaignCreateForm`, lui, le proposait quand
l'espace en avait plusieurs.

⚠️ **MESURÉ : régression LATENTE, pas vivante.** Les deux espaces de production ont **un seul numéro
chacun** au 2026-09-13, donc personne ne peut constater la perte aujourd'hui. Elle mordra au premier
client à deux numéros, et ce jour-là elle se manifestera par « mes campagnes partent du mauvais
numéro », pas par une erreur.

**À reposer dans l'assistant** : un sélecteur à l'étape Canal, visible seulement quand l'espace a plus
d'un numéro. Le montrer à un espace mono-numéro serait une question dont la réponse est déjà connue.

## 🔴 DEUX FOIS LE MÊME MOTIF : l'écran affiche ce que la requête n'envoie pas (2026-09-13)

Deux défauts trouvés à deux lots d'intervalle, de la même famille, dans le même assistant :

- **lot 7** : `entreeDeCreation` posait `contactTarget: { filters }` **quoi qu'on ait coché**. Une
  sélection ligne à ligne était affichée, comptée, et la campagne partait à tout ce que les filtres
  décrivaient, donc à plus de monde que ce que l'opérateur avait validé ;
- **lot 8** : le constructeur de message RCS était un littéral `kind: 'text'`. L'écran affichait le
  visuel, le téléversait, le montrait en aperçu, et n'en envoyait rien.

🔴 **LA CAUSE COMMUNE EST LA MÉTHODE DE CONSTRUCTION, PAS L'INATTENTION.** Un écran bâti écran d'abord
a deux moitiés qui avancent à des vitesses différentes : ce qu'il MONTRE et ce qu'il ENVOIE. Les tests
d'interface ne voient que la première, et ils sont verts pendant que la seconde ment.

⚠️ **LA PARADE, ET ELLE EST BON MARCHÉ** : pour tout écran qui construit une requête, au moins un test
lit le **CORPS DE LA REQUÊTE**, pas le rendu. C'est le seul qui prouve quelque chose. À appliquer à
l'assistant de traduction et au récap avant qu'ils ne reproduisent le motif une troisième fois.

## Une campagne en pause ne dit NI pourquoi NI jusqu'à quand (2026-09-13)

Trouvé en diagnostiquant le « le truc reste en pause » de Julien, un dimanche. La campagne était
parfaitement saine : `business_hours_only` coché, l'espace fermé le dimanche, donc
`pause_reason = 'hors_horaires'` et `paused_until` au lundi 9 h. Le moteur avait raison de bout en
bout, et **l'écran n'en montrait rien** : la liste affiche « en pause », point.

🔴 **LES DEUX COLONNES EXISTENT DEPUIS 0103 ET 0122, ET L'API NE LES EXPOSE PAS** (`pause_reason`,
`paused_until` absentes de `CampaignSummary`). `messageDePause` sait déjà fabriquer la phrase
(`src/campaign/pause.ts`), personne ne l'affiche dans la liste. C'est encore le même motif que
celui du bloc au-dessus, dans l'autre sens : le serveur SAIT, l'écran ne le dit pas.

⚠️ **ET LE PIÈGE QUI SUIT** : changer ses heures d'ouverture ne réveille PAS une campagne déjà en
pause, `paused_until` ayant été calculé au moment de la pause. Le geste existe (le bouton
« Reprendre » de la liste, que Julien a trouvé seul), mais rien ne l'indique à qui vient de corriger
ses horaires en croyant avoir résolu le problème.

À faire : exposer les deux colonnes dans le résumé, afficher la phrase et l'échéance sous le badge
« en pause », et nommer le bouton « Reprendre » comme le geste qui rattrape un horaire corrigé.

## Un test qui désigne par le TEXTE ne nomme aucun symbole (2026-09-13)

Trouvé par la CI, pas par la revue, et c'est bien le problème. En retirant la question « Ne pas envoyer
le rattrapage en dehors des heures d'ouverture », la revue a cherché ses lecteurs par `grep` sur le
champ (`rattrapageHorsHoraires`), sur le `data-testid` (`bloc-rattrapage`) et sur la fonction
(`rattrapagePossible`). Zéro reste. **Deux e2e la gardaient pourtant**, en la désignant par son
libellé : `getByRole('checkbox', { name: /heures d.ouverture/i })`.

🔴 **ET LE PIÈGE EST PLUS FIN QUE « J'AI OUBLIÉ UN GREP »** : ce libellé ressemblait à celui de la case
qui RESTE (« Envoyer uniquement pendant les heures **ouvrées** »). En lisant le test, on croit qu'il
parle de la survivante. Il fallait comparer les deux libellés au caractère près pour voir que
`/heures d.ouverture/i` ne correspond qu'à la disparue.

⚠️ **LA PARADE** : quand on retire un élément d'interface, chercher aussi son **LIBELLÉ** dans les
tests, pas seulement son identifiant. Et si un cas réécrit se met à ressembler à un cas déjà présent,
c'est qu'il faut le SUPPRIMER en nommant son remplaçant, pas le réécrire : les deux exemplaires ont été
retirés une fois constatée cette duplication.

## L'espace ne sait pas distinguer « horaires réglés » de « jamais réglés » (2026-09-13)

`tenant_settings.business_hours` valait `null` pour l'espace Demo, et l'API rend
`DEFAULT_BUSINESS_HOURS` (lundi-vendredi 9 h-18 h) à la place. Conséquences mesurées :

- l'espace se voit appliquer des heures d'ouverture **qu'il n'a jamais choisies**, et une campagne
  « heures ouvrées » lancée un dimanche attend le lundi ;
- l'avertissement « aucune heure d'ouverture n'est réglée pour cet espace » de l'étape Canal ne peut
  donc **JAMAIS s'afficher** : `heuresDOuvertureReglees` reçoit le défaut et répond « oui ».

Le code de cet écran est juste, sa garde est inerte. Pour la rendre vivante il faut que l'API dise si
la colonne est nulle (un drapeau à côté des heures), sans quoi le front ne peut pas faire la différence.

## Une bulle SORTANTE change de contenu selon un réglage sur les messages REÇUS (2026-09-13)

Signalé par le lot de la tâche 6, confirmé en revue. L'interrupteur s'appelle « Traduire les messages
reçus », et pourtant il change aussi ce qu'affichent les bulles **envoyées** :

- **éteint** : la bulle montre `body`, c'est-à-dire **ce qui est PARTI** (donc le texte traduit, si
  l'opérateur avait utilisé le bouton de traduction sortante) ;
- **allumé** : elle montre `redaction_origine`, c'est-à-dire **ce que l'opérateur avait écrit**.

🔴 **LES DEUX SONT DÉFENDABLES, MAIS PAS SOUS LE MÊME INTERRUPTEUR, ET SURTOUT PAS EN SILENCE.** Rien
à l'écran ne dit laquelle des deux versions on regarde. Un opérateur qui cherche à savoir ce que son
client a réellement reçu peut lire l'autre texte sans s'en apercevoir, et c'est précisément la question
qui se pose le jour d'un litige.

✅ **TRANCHÉ PAR JULIEN LE 2026-09-13 : une bulle sortante montre TOUJOURS ce qui est PARTI**, quel que
soit le réglage de traduction, avec un moyen de déplier ce que l'opérateur avait écrit. C'est la vérité
de l'échange, celle qui compte le jour d'un litige, et elle cesse de dépendre d'un interrupteur qui ne
parle que des messages REÇUS.

⚠️ **CE N'EST PAS QU'UN CHANGEMENT D'AFFICHAGE** : `texteOriginal` (`src/traduction/fil.ts`) rend
aujourd'hui `redactionOrigine ?? body` pour un sortant. C'est CETTE ligne qui s'inverse, et le test qui
la garde doit exercer les deux sens, réglage allumé comme éteint.

## Le bouton « Envoyer » est recouvert par la bulle d'aide en 13 pouces (2026-09-13)

Mesuré pendant la tâche 6, et **ce n'est pas une régression de ce lot** : la bulle flottante du bot
d'aide se pose au-dessus du coin bas-droit, donc par-dessus la droite du bouton « Envoyer » de l'Inbox
à 1280 x 800.

⚠️ **AUCUNE DES DEUX GARDES DE LARGEUR NE PEUT LE VOIR** : `pasDeDebordement` regarde le débordement du
document, `pasDeChevauchement` compare des éléments qu'on lui NOMME, et personne n'a jamais pensé à
nommer la bulle d'aide en face du bouton d'envoi. C'est le trou de la méthode plus que celui de
l'écran : une garde qui exige qu'on nomme les paires ne trouve que ce à quoi on pensait déjà.

✅ **TRANCHÉ PAR JULIEN LE 2026-09-13 : LA BULLE SE DÉCALE SUR L'INBOX.** Le bot d'aide remonte ou se
décale quand une conversation est ouverte, là où il gêne ; les autres écrans ne bougent pas. On corrige
la cause sans toucher à la zone de saisie, qui est l'élément le plus utilisé du produit et dont la
largeur ne doit pas payer pour un problème qui n'existe que sur un écran.

⚠️ **ET ON AJOUTE LA PAIRE À LA GARDE**, sinon on corrige le symptôme sans empêcher son retour :
`pasDeChevauchement(page, ['bouton-envoyer', 'bulle-aide'])` en 1280 x 800.

---

# Demandes de Julien du 2026-09-13 (après l'essai réel de la traduction)

## 🔴 BUG — « Modèle et scénario » demande DEUX choix au lieu d'un

**Constaté par Julien, vérifié dans le code.** Dans l'étape Contenu d'une campagne, choisir la formule
« Modèle et scénario » laisse le sélecteur **Modèle** affiché (il est rendu inconditionnellement dans
`CadreWhatsApp`, `web/components/campagne/EtapeContenu.tsx`) EN PLUS du sélecteur de scénario.

Julien : « le user ne doit pas choisir un modèle puis un scénario, il doit choisir uniquement un
scénario, et un scénario qui commence par un Template. On avait déjà répondu à ce bug depuis
longtemps. » C'est donc une RÉGRESSION : l'assistant a réintroduit ce que l'ancien formulaire avait réglé.

🔴 **CE N'EST PAS QU'UNE QUESTION DE TROP, C'EST UNE SOURCE DE CONTRADICTION.** Le modèle qui part
réellement est celui du PREMIER BLOC du scénario ; celui que l'écran fait choisir à côté ne sert qu'à
compter des variables. Les deux peuvent différer, et alors l'association des variables est faite sur le
mauvais modèle, ce qui fait refuser la campagne entière par Meta (`resolveHintParams`).

⚠️ **LA BRIQUE POUR LE CORRIGER EXISTE DÉJÀ** : `scanOpening(graph)` (`web/lib/campaign-eligibility.ts`)
rend `firstTemplate` (avec son `templateName`) et `rcsOpen`. Le modèle d'ouverture se DÉDUIT donc du
scénario choisi, au lieu d'être demandé. Corollaire à ne pas oublier : c'est ce même scan qui doit
refuser un scénario dont le premier bloc ne convient pas au canal de l'étage.

## ÉVOL — « Créer un scénario » depuis la campagne, sans la quitter

Dans la liste des scénarios d'une campagne « Modèle et scénario », le **premier choix**, avant les
scénarios existants, doit être **« Créer un scénario »**. Il ouvre une fenêtre qui occupe environ les
trois quarts de l'écran et reprend l'écran de construction (les blocs qu'on relie).

- **Le nom se demande d'abord** : dans le parcours normal, c'est la première étape avant que l'écran de
  construction apparaisse. En arrivant directement sur le graphe, il faut donc le demander quelque part.
- **« Publier » ferme la fenêtre et revient à la campagne**, avec le scénario choisi.
- 🔴 **Le scénario doit se retrouver dans l'onglet Scénario** : ce n'est pas un objet jetable propre à
  la campagne, c'est un scénario de l'espace comme un autre.
- 🔴 **LA GARDE DU PREMIER BLOC, ET ELLE EST LE CŒUR DE LA DEMANDE.** Sur un étage **WhatsApp**, on ne
  doit pas pouvoir publier un scénario qui ne commence pas par un **Template** ; sur un étage **RCS**,
  il doit commencer par un bloc **RCS**. La même règle vaut pour **les étages de repli** d'une campagne
  à chaîne, qui utilisent eux aussi des scénarios.
- ⚠️ `isCampaignEligible` / `scanOpening` portent déjà la moitié de cette règle (ils savent dire si un
  graphe ouvre par un template nommé ou par un bloc RCS). Ce qui manque, c'est de l'appliquer AU MOMENT
  DE PUBLIER depuis la campagne, et par CANAL d'étage.

## ÉVOL — Un menu « Sécurité », à côté de Paramètres, Support et Developers

🔴 **LIVRÉ LE 2026-09-13, TÂCHES 1 À 6** (`623e6a5`). La page d'accueil, le menu et ses trois sous-menus
(Consentement, Audit trails, Journal des erreurs) existent. Un opt-out bloque désormais scénario, automation
et agent IA, l'envoi d'un modèle marketing depuis l'Inbox et la réponse d'un agent MCP. La liste des
désabonnés porte la date (migration 0138) et les « refus possibles à confirmer » remontent sans désabonner
personne. Le détail et les écarts : [plan](docs/superpowers/plans/2026-09-13-centre-securite.md).

**Ce qui RESTE de ce chantier**, et rien d'autre :

1. **L'opt-out déclenche un APPEL D'OUTIL** (tâche 7) : au moment où un refus est déclaré, l'espace peut
   pousser l'information vers son propre système via un connecteur déjà déclaré dans Tools. C'est ce qui rend
   le refus opposable ailleurs que chez nous. ⚠️ L'appel ne doit JAMAIS bloquer l'écriture de l'opt-out.
2. **Le sous-menu IA** (tâche 8) : remonter « l'IA se déclare comme telle » de la fiche d'agent au niveau de
   l'ESPACE, sans changer le comportement des agents existants. ⚠️ Le Meta Business Agent n'est pas concerné,
   Meta écrit déjà « IA » sous ses messages.
3. **Le journal des erreurs, la moitié SYSTÈME** (tâche 9) : les retours d'API qui n'ont pas fonctionné et les
   échecs d'avancement de parcours (`workflow_advance_failures`, migration 0108, déjà en base). La moitié
   client existe déjà et a déménagé.
4. 🔴 **L'ESSAI RÉEL, qui n'est pas une tâche mais la seule preuve** : écrire « stop » depuis un vrai
   téléphone, constater l'opt-out, PUIS tenter d'atteindre ce contact par un scénario ET par une automation.
   Puis l'essai inverse : un opérateur doit encore pouvoir lui répondre à la main.

🔴 **ET UN ARBITRAGE EN ATTENTE, découvert le 2026-09-13** : la règle STOP désabonne « arrêt maladie »,
« arrêt du traitement », « stop covid » et « stopper la commande », parce que l'ancrage en début de message
ne protège pas d'un message qui COMMENCE par le mot-clé. Sur un espace d'assureur, c'est un message ordinaire.
Resserrer l'ancrage ferait perdre « stop merci », qui est un vrai refus : c'est un choix produit, et le
comportement actuel est figé par `tests/consentement-observation.test.ts` en attendant.

## ÉVOL — Déplacer « Scénario » dans Contenu, juste après Email

Le menu Scénario quitte sa place actuelle pour le menu **Contenu**, immédiatement après Email.

## ÉVOL — Une RÉPONSE est un engagement, au même titre qu'un clic

Performance lab, page d'accueil, « ce que coûte l'engagement ». Constaté par Julien sur l'envoi
« Testjulien2 » : le destinataire d'un message marketing n'a **pas cliqué**, mais il a **répondu**.

🔴 **UNE RÉPONSE EST UN ENGAGEMENT DE PREMIER NIVEAU, et ne pas la compter sous-estime exactement ce que
la page prétend mesurer.** Quelqu'un qui prend la peine d'écrire s'est engagé plus fort que quelqu'un
qui clique. Le coût par engagement doit donc compter les réponses avec les clics.
