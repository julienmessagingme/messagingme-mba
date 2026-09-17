# Performance Lab : les coûts et l'analyse des conversations

> Décidé avec Julien le 2026-09-17 par `grilling`, huit rounds, trente-deux décisions.
> Les plans d'exécution qui en découlent : `docs/superpowers/plans/2026-09-17-performance-lab-ux.md`
> (lot 1) et `docs/superpowers/plans/2026-09-17-performance-lab-couts.md` (lot 2). Le lot 3 est cadré
> ici et n'a pas encore de plan, délibérément.

## Objectif

La page de synthèse du Performance Lab répond aujourd'hui à deux questions (ce que coûte un engagement,
où en sont les conversations) avec deux cartes bavardes. Elle doit répondre à **trois questions de coût
en trois chiffres**, et rendre l'analyse des conversations lisible quand il y en aura mille plutôt que
quatorze.

## Ce qui a été MESURÉ avant de décider, et qui a changé trois décisions

🔴 **TOUTES CES MESURES VIENNENT DE LA BASE DE PRODUCTION, EN LECTURE SEULE, LE 2026-09-17.** Elles sont
datées parce qu'elles vieilliront : ce qui compte n'est pas le chiffre, c'est ce qu'il a tranché.

| Mesure | Valeur | Ce qu'elle a décidé |
|---|---|---|
| Poids de toute la base | **31 Mo** | Le stockage ne pèse RIEN dans la décision de rétention. Elle se prend sur le RGPD, point. |
| Conversations / messages / analyses | 14 / 373 / 14 | L'écran quali n'est pas près de faire tomber quoi que ce soit. La ligne-par-jour est un meilleur écran, pas un correctif de panne. |
| Analyses portant les DEUX notes | **2 sur 14** | La matrice urgence/satisfaction repose sur deux points. Cf. « arbitrages contre recommandation ». |
| Topics libres distincts | **13 pour 14 analyses** | L'inflation redoutée est déjà là, et pas où Julien la cherchait. |
| dont variantes de « consultation tarifs » | **4** | « consultation des tarifs », « consultation tarifs », « consultation tarifs et offres », « consultation tarifs cinéma ». Plus « Prise de rendez-vous agence Bordeaux » en double, à une majuscule près. |
| `agent_sessions` | **0** | Aucun tour d'agent IA n'a jamais tourné. La carte « coût IA » affichera 0 € au départ, et c'est normal. |
| Numéros WhatsApp par espace | **1 partout** | La franchise se compte par espace. Voir le piège n°2. |
| Messages de service (sortants WhatsApp hors template) | 140 | Le compte existe déjà et il est juste. Seul le PRIX manque. |

## Ce qui existe déjà, et qu'on n'invente pas

Quatre briques portent l'essentiel du lot 2. Les ignorer serait réécrire ce qui marche.

- 🔴 **Les engagements sont DÉJÀ ce que Julien décrit.** `PgStatsStore.engagementsParCampagne`
  ([src/stats/store.pg.ts:989](../../../src/stats/store.pg.ts)) compte des **personnes distinctes**, union
  des cliqueurs identifiés et des répondeurs, sur une fenêtre de **7 jours après l'envoi de chacun**.
  Quelqu'un qui clique, reclique sur un autre node, puis répond, compte **1**. Un appui sur un bouton de
  scénario produit un message entrant, donc il est compté. Rien à recalculer, tout à réafficher.
- 🔴 **Les mesures par node existent, avec les DEUX unités.** `EtapeCoutCampagne`
  ([src/stats/cout-campagne.ts:245](../../../src/stats/cout-campagne.ts)) porte `envoyes`, `boutons` et
  `reponses` en gestes ET en personnes. Seul `liens` n'a que des gestes, parce que les clics s'agrègent par
  code de lien : cette case-là ne pourra jamais compter des personnes, et l'écran doit le dire.
- 🔴 **L'origine d'un message sortant est enregistrée depuis la migration 0099**, avec exactement les
  valeurs dont on a besoin : `humain`, `scenario`, `ia`, `mba`, `campagne`, `mcp`
  ([src/inbox/origine.ts:11](../../../src/inbox/origine.ts)). Les quatre badges « qui a répondu » se
  dérivent de là, sans une seule colonne de plus.
- 🔴 **Les messages de service sont déjà comptés selon la définition de Meta** : sortants, WhatsApp, hors
  template, hors fil de test ([src/stats/store.pg.ts:578](../../../src/stats/store.pg.ts)). Ce filtre est
  partagé avec la ventilation par origine, et il doit le rester : un filtre qui diverge d'un mot ferait
  mentir le total et sa ventilation en même temps.

⚠️ **Et une brique NE FAIT PAS ce que son nom laisse croire.** `deduceHandledBy`
([src/analysis/engine.ts:22](../../../src/analysis/engine.ts)) ne rend que `humain` ou `automatise` :
la valeur `mba` est déclarée dans l'énumération et n'est **jamais produite**. Mesuré en base, les 14
analyses se répartissent en 8 `automatise` et 6 `humain`, zéro `mba`. Les badges ne doivent donc PAS se
poser sur `handled_by`, mais sur `conversation_messages.origin`, qui lui dit la vérité.

---

# Lot 1 : UX et menus

**Isolé, réversible, quelques fichiers.** Aucun chemin de production n'est touché.

## 1.1 La barre d'onglets s'aligne sur la colonne latérale

`CONSOLE / INBOX / PERFORMANCE LAB` démarre à **240 px** du bord gauche, c'est-à-dire la largeur de
`w-60` de la colonne latérale ([web/components/AppShell.tsx:356](../../../web/components/AppShell.tsx)).

🔴 **L'ALIGNEMENT EST PERMANENT, Y COMPRIS SUR L'ONGLET INBOX, QUI N'A PAS DE COLONNE.** C'est la moitié
de l'intérêt d'un alignement : un repère qui saute quand on change d'onglet est pire qu'un repère décalé.
Le logo occupe la zone à gauche.

⚠️ En dessous de `lg` il n'y a pas de colonne latérale du tout (elle devient un tiroir) : l'alignement ne
s'applique qu'à partir de ce point de rupture, sinon les onglets seraient poussés hors de l'écran sur un
téléphone.

## 1.2 Qualitatif devient « Analyse des conversations »

**Le libellé seulement.** L'adresse reste `/dashboard/quali` et la clé de nav reste `dashboard-quali`.

⚠️ **CHANGER L'ADRESSE AURAIT COÛTÉ TROIS SPECS PLAYWRIGHT ET UNE REDIRECTION ÉTERNELLE, pour un gain que
personne ne voit** : un utilisateur ne lit jamais cette adresse. Le dépôt vit déjà très bien avec un nom
technique qui ne colle plus au produit (il s'appelle `messagingme-mba` et le produit s'appelle Engage Me).

## 1.3 Erreurs quitte le Quantitatif

L'entrée `quanti-erreurs` disparaît du menu, et **la carte d'agrégat déménage** vers
`/securite/erreurs`, sous le journal existant. `/dashboard/erreurs` redirige vers elle.

🔴 **CE N'ÉTAIT PAS UN DOUBLON, ET C'EST POUR ÇA QUE LA CARTE DÉMÉNAGE AU LIEU DE DISPARAÎTRE.** Le centre
de Sécurité porte un **journal** (les 100 dernières lignes, cherchables par numéro, exportables) ; le
Quantitatif porte un **agrégat par code d'erreur Meta sur une période**. Ce sont deux questions
différentes : « qu'est-il arrivé à ce numéro » et « quel code revient le plus ce mois-ci ». Supprimer la
seconde aurait retiré la seule vue qui dit s'il faut agir.

## 1.4 Le bouton « Discuter » de la chaîne

Le menu déroulant ([web/components/ChaineComposeur.tsx:204](../../../web/components/ChaineComposeur.tsx))
ne propose plus que les **3 liens les plus récents**, chacun étiqueté `phrase → nom du scénario`. Un lien
« Voir tous les liens » déplie le reste.

🔴 **RIEN N'EST SUPPRIMÉ EN BASE, ET CE N'EST PAS NÉGOCIABLE.** Depuis la migration 0116, **la phrase d'un
lien EST sa clé de routage**, et les publications déjà parties sur la chaîne portent cette phrase dans
leur texte. Supprimer un ancien lien tuerait le bouton de toutes ces publications, définitivement et sans
recours : c'est la même porte à sens unique que les liens tracés `/r/<code>`. « Garder les 3 derniers » ne
peut donc signifier que « n'en montrer que 3 ».

⚠️ **LE VRAI DÉFAUT N'ÉTAIT PAS LA LONGUEUR DE LA LISTE, C'ÉTAIT SON LIBELLÉ.** Julien : « on ne sait plus
à quel scénario chaque bouton a été associé ». Le `<option>` n'affichait que `l.phrase`. Limiter à 3 sans
ajouter le nom du scénario aurait laissé le problème entier sur une liste plus courte.

---

# Lot 2 : la Synthèse, les coûts, et l'analyse des conversations

## 2.1 Colonne de gauche : une carte « Coûts » à trois lignes dépliables

Elle remplace `CoutParCampagneCard`. Les trois lignes se filtrent par la barre de période existante,
sauf mention contraire.

### Ligne 1 : coût moyen par engagement

**Un seul chiffre. Aucune phrase.** Tout le texte d'explication de la carte actuelle disparaît.

🔴 **LE CALCUL EST « COÛT TOTAL DIVISÉ PAR ENGAGÉS TOTAUX », ET L'AUTRE MOYENNE AURAIT MENTI.** Sur une
campagne A de 5 000 envois à 2 € par engagé et une campagne B de 10 envois à 40 €, ce calcul rend 2,07 €
quand la moyenne des ratios rendrait 21 €. Le chiffre répond à « ce que m'a coûté en moyenne une personne
engagée sur la période », qui est une question de budget ; la moyenne des ratios répond à « mes campagnes
sont-elles bien calibrées », qui est une question de qualité, et un essai à 10 envois y pèserait autant
qu'une campagne à 5 000.

🔴 **LE NUMÉRATEUR INCLUT LES MESSAGES DE SERVICE, PAS SEULEMENT LES TEMPLATES**, et c'est un changement de
fond par rapport à la carte actuelle. Un message de service est imputé à une campagne s'il part vers un
contact **dans les 7 jours suivant l'envoi de campagne qu'il a reçu**.

⚠️ **LA FENÊTRE DE 7 JOURS N'EST PAS UN NOMBRE CHOISI ICI : c'est celle d'`engagementsParCampagne`,
reprise telle quelle.** Numérateur et dénominateur parlent alors de la même population, sur la même
fenêtre. Deux fenêtres différentes auraient produit un ratio dont aucune des deux moitiés ne décrit le
même ensemble de gens, ce qui est indétectable à l'écran.

**L'accordéon** liste les campagnes mesurées, quatre colonnes : nom, envoyés, engagés, coût par engagé.
Les trois colonnes de réserves de la carte actuelle (`sans lien tracé`, causes de non-chiffrabilité) n'y
sont plus.

⚠️ **LES RÉSERVES NE SONT PAS PERDUES, ELLES DESCENDENT DANS LA FICHE DE CAMPAGNE.** Elles disent des
choses vraies et utiles (un template approuvé avant le 2026-09-02 ne remonte aucun clic), mais elles
n'ont pas leur place sur un écran de synthèse, où elles occupaient plus de place que les chiffres.

### Ligne 2 : coût total des messages envoyés

Le total de la période, déplié en quatre postes.

| Poste | Prix | Source du compte |
|---|---|---|
| Templates marketing | tarif Meta × marge de l'espace | `envoisTemplateFacturables`, déjà en place |
| Templates utility | tarif Meta × marge de l'espace | idem |
| Messages de service | tarif de l'espace, franchise déduite | sortants WhatsApp hors template, déjà en place |
| RCS | tarif de l'espace, conversationnel ou non | `conversation_messages` en `channel = 'rcs'` |

🔴 **UNE MARGE SUR LE TARIF META, ET PAS UNE GRILLE DE PRIX SAISIE.** Le tarif Meta reste la source, un
coefficient par espace (100 % par défaut, donc rien ne bouge aujourd'hui) donne le prix facturé. Une
grille saisie à la main aurait dérivé en silence le jour où Meta change ses tarifs par pays ou par
période, et personne ne l'aurait vu : le chiffre serait resté plausible.

🔴 **LA FRANCHISE EST CELLE DU MOIS EN COURS, AFFICHÉE À PART DE LA PÉRIODE.** « Sur la période : 340
messages de service » et, sur une ligne distincte, « franchise du mois : 340 / 1 000 consommés ».
Proratiser 1 000 sur sept jours aurait produit un nombre inventé, et un client construit un budget dessus.

⚠️ **1 000 messages gratuits, puis 2,48 cts en France, à partir du 2026-10-01.** La date est une bascule :
avant elle, aucun message de service n'est facturé au message. Le calcul doit donc porter la date
d'effet, pas seulement le prix, sinon rejouer une période de septembre facturerait des messages qui
étaient gratuits.

**Le RCS** est non conversationnel (6 cts) par défaut. Il **bascule en conversationnel (8 cts)**, lui et
tous les RCS suivants du même échange, si le contact appuie sur un bouton ou répond **dans les 7 jours**.

🔴 **LE COÛT D'UN MESSAGE RCS CHANGE DONC APRÈS SON ENVOI, et la borne de 7 jours est ce qui le stabilise.**
Sans borne, le total de janvier pourrait encore bouger en juillet, sans que personne puisse dire pourquoi.
Julien, 2026-09-17 : « aucune personne ne réagira au bout d'une semaine ou d'un mois, tout se joue dans
les 24 h max ». Les 7 jours sont donc très au-dessus du comportement réel, et surtout ils réutilisent la
fenêtre déjà en place plutôt que d'en introduire une deuxième à tenir d'accord avec la première.

⚠️ **PAS DE MESSAGE DE SERVICE SUR RCS.** Contrairement à WhatsApp, un échange RCS ne produit aucune
facturation de service : tout est au tarif RCS. Ne pas recopier la mécanique WhatsApp ici.

### Ligne 3 : coût total IA

**Uniquement ce que le CLIENT paie**, c'est-à-dire son crédit prépayé : les tours d'agent IA et la
traduction. Déplier montre les tours avec leurs tokens entrée et sortie, comme l'écran d'essai du bac à
sable.

🔴 **CE QUE NOUS ABSORBONS N'A RIEN À FAIRE SUR SON ÉCRAN.** La transcription des vocaux, le bot d'aide de
la console et les deux assistants de configuration sont sur notre clé, par décisions déjà écrites au
`CLAUDE.md`. Les afficher ferait se demander à un client pourquoi on lui montre une dépense qu'on ne lui
facture pas, et ouvrirait une discussion sur un coût interne.

🔴 **LE COÛT IA DU MBA N'EXISTE PAS DE NOTRE CÔTÉ, ET CE N'EST PAS UN MANQUE.** Le Meta Business Agent
tourne chez Meta ([src/mba/client.ts:17](../../../src/mba/client.ts), `api.facebook.com`) : nous le
configurons, nous ne payons aucun token pour lui. Meta le facture au **message de service**, donc son coût
est déjà dans la ligne 2. L'écran doit le DIRE, sinon un lecteur conclura que la mesure manque.

⚠️ **LA CARTE AFFICHERA 0 € AU DÉPART, ET C'EST EXACT** : `agent_sessions` est vide en production. Elle
doit dire « aucune consommation sur la période » et non afficher un tiret, qui se lirait comme une panne.

### La grille de prix

Un réglage **par espace**, modifiable depuis la console : marge sur le tarif Meta, prix du message de
service, prix RCS non conversationnel, prix RCS conversationnel. Ce sont des **prix de vente**.

🔴 **PAR ESPACE ET PAS EN CONFIGURATION GLOBALE**, parce que ces prix ne sont pas des constantes
techniques : le tarif smsmode se négocie, et un grand compte ne se facture pas comme un petit. Une
constante d'environnement aurait demandé un déploiement pour changer un prix, et aurait imposé le même
tarif à tout le monde.

### Le sous-onglet Quantitatif > Coûts reste

🔴 **IL N'EST PAS EN DOUBLON, IL RÉPOND À L'AUTRE MOITIÉ DE LA QUESTION.** La Synthèse dit **combien**, en
trois chiffres ; le sous-onglet dit **pourquoi**, jour par jour et template par template. Surtout, il est
le seul à porter **ce que Meta a réellement facturé**, qui ne vient d'aucun calcul de notre côté. La carte
de la Synthèse pointe vers lui pour l'écart estimation / facture.

## 2.2 Colonne de droite : intentions et matrice

**Les intentions** en barres horizontales, reprises de `ConversationAnalysisCard`. Déplier une barre
montre les **topics libres** de cette intention, classés par fréquence.

🔴 **LES TOPICS SONT EMPILÉS SOUS LEUR INTENTION, ET C'EST CE QUI REND L'INFLATION VISIBLE.** Mesuré : 13
topics pour 14 analyses, dont quatre variantes de « consultation tarifs ». Rangés à plat dans une liste,
ces quatre-là seraient dispersés et personne ne verrait qu'ils sont parents. Sous « Information », ils se
retrouvent côte à côte, et le problème se voit tout seul. C'est l'argument du lot 3, rendu lisible.

⚠️ **CE RANGEMENT N'EST PAS UN REGROUPEMENT.** Aucune normalisation n'est appliquée : « Consultation
Tarifs » et « consultation tarifs » resteront deux lignes. Une normalisation basique (casse, accents)
aurait rattrapé les doublons de casse sans rien faire pour « tarifs et offres » contre « tarifs cinéma »,
donnant l'illusion d'un rangement sans en être un. Le vrai regroupement est le lot 3.

**Cliquer une intention** ouvre `/dashboard/quali` filtré sur **cette intention** et sur **la même
période**, par paramètres d'adresse.

⚠️ **PAR L'ADRESSE ET PAS PAR UN ÉTAT EN MÉMOIRE** : l'écran devient partageable par copier-coller, et le
retour arrière du navigateur ramène à la Synthèse dans son état. C'est le motif déjà en place sur
`/dashboard/funnel?campagne=<id>`.

**La matrice urgence/satisfaction** garde sa forme actuelle et **perd tout son texte**. Voir
« arbitrages contre recommandation ».

## 2.3 La fiche d'une campagne

`DetailCampagneModale` est **refondue**, pas remplacée : même modale, même ouverture, même fermeture qui
ramène l'accordéon dans son état.

Elle montre, dans cet ordre :

1. **Ce qui a été envoyé** : template seul, ou template plus scénario, avec le nom des deux.
2. **Le funnel de la campagne** : envoyés, délivrés, lus, répondus, échecs. Barres verticales, comme
   l'écran Funnel du Quantitatif.
3. **Les étapes node par node**, si c'est un scénario : une barre verticale par node et par nature
   (envoyés, réponses sans clic, clics sur bouton, réponses suivantes), dans l'ordre du graphe.

🔴 **ON COMPTE DES PERSONNES, LES GESTES SONT AU SURVOL.** Cohérent avec la règle de Julien (« un clic ou
un engagé = 1 ») et avec le coût par engagé juste au-dessus. Une personne qui clique trois fois ne doit
pas gonfler l'entonnoir.

⚠️ **SAUF LA BARRE DES CLICS SUR LIENS, QUI COMPTE DES GESTES ET LE DIT.** `EtapeCoutCampagne.liens` n'a
pas de compte de personnes, parce que les clics s'agrègent par code de lien. Afficher un nombre de
personnes y serait une invention. La barre porte donc sa mention, plutôt que d'aligner silencieusement
deux unités différentes dans le même graphe.

## 2.4 L'écran Analyse des conversations

**Une ligne par jour** : date, nombre de conversations, satisfaction moyenne sur 10, urgence moyenne
sur 10. Trié du plus récent au plus ancien.

- **Les jours sans conversation sont masqués.** Une ligne à zéro n'apprend rien et noie les autres.
- **Au-delà de 90 jours de période, regroupement par semaine**, avec un bascule jour/semaine manuel et
  la granularité courante **affichée**.

⚠️ **LA GRANULARITÉ AFFICHÉE EST LA PARADE À L'OBJECTION QUE CE CHOIX SOULÈVE.** Une granularité qui
change toute seule fait que deux captures de la même page ne se comparent plus. Le dire à l'écran, et
laisser la main, coûte une ligne et referme le défaut.

**Cliquer un jour** ouvre le détail actuel (la table des conversations analysées, plafonnée à 50 lignes
comme aujourd'hui), enrichi de **badges disant qui a répondu** : `Scripté`, `Humain`, `MBA`, `Agent IA`.
Une conversation hybride porte plusieurs badges. **Cliquer un badge** montre la partie de conversation
concernée.

🔴 **DES BADGES EN LECTURE SEULE, PAS DES CASES À COCHER.** Julien avait proposé des cases. Mais c'est un
FAIT dérivé de `conversation_messages.origin`, pas une opinion : une case à cocher promet qu'on peut la
changer, et un utilisateur qui décoche ferait mentir les comptes de la Synthèse sans qu'aucun écran ne
puisse le signaler. Le badge garde le geste voulu (cliquer pour voir la partie concernée) sans l'illusion
qu'on peut réécrire ce qui s'est passé.

🔴 **`Agent IA` N'EST PAS NOMMÉ, ET C'EST UN CHOIX MESURÉ.** Le nom de l'agent n'est pas sur le message :
il faudrait soit une colonne de plus (migration bloquante, et l'historique resterait sans nom), soit une
déduction par numéro et fenêtre de temps, qui mélangerait deux agents parlant au même numéro le même jour
sans rien signaler. Tant qu'un espace n'a qu'un agent, le nom n'apprend rien. Le jour où il en aura
plusieurs, c'est la colonne qu'on posera, comme la migration 0099 l'a fait pour l'origine.

⚠️ **LES BADGES NE SE POSENT PAS SUR `conversation_analysis.handled_by`**, qui ne rend que `humain` ou
`automatise` et ne distingue donc ni le scénario, ni le MBA, ni l'agent IA. Ils se dérivent des origines
des messages sortants du fil.

## 2.5 La rétention et les agrégats

**`CONVERSATION_RETENTION_DAYS` passe de 365 à 90**, et devient réglable par espace.

🔴 **CE N'EST PAS UNE RÈGLE RGPD, C'EST UNE DÉCISION, ET IL FAUT LE SAVOIR POUR LA DÉFENDRE.** Le RGPD ne
fixe aucune durée : l'article 5.1.e dit « pas plus longtemps que nécessaire », et la CNIL donne des
repères par finalité, aucun pour un historique de conversation. Le responsable de traitement est **le
client**, pas nous, d'où le réglage par espace. 90 jours est le plancher que Julien avait donné dès le
2026-08-31 et qu'on applique enfin.

🔴 **ET LE STOCKAGE N'ENTRE PAS DANS CETTE DÉCISION** : toute la base fait 31 Mo. Un million de messages
tiendrait dans quelques gigaoctets. Quiconque rouvrira ce choix doit le rouvrir sur le RGPD.

**Une table d'agrégats journaliers anonymes** garde la profondeur de la Synthèse : une ligne par jour et
par espace, portant le nombre de conversations, les moyennes de satisfaction et d'urgence, la répartition
des intentions et celle de qui a répondu. **Aucune donnée personnelle** : ni numéro, ni texte, ni résumé.

Elle est écrite par un **balayage nocturne** sur la veille. **Les vraies données font foi tant qu'elles
existent** (les 90 derniers jours), les agrégats au-delà.

🔴 **CE CHOIX IMPOSE UNE CONTRAINTE QU'IL FAUT TENIR, SOUS PEINE D'UNE MARCHE DANS LE GRAPHE.** Deux
sources répondent à la même question sur deux portions de l'axe du temps. Elles doivent passer par **la
même fonction de calcul**, et un test doit prouver qu'elles tombent d'accord sur un jour donné. Si elles
divergent d'une unité, la frontière des 90 jours produira une marche que rien ne signalera, et qu'on
prendra pour un vrai creux d'activité.

⚠️ **C'EST LA MÊME DOCTRINE QUE `workflow_node_events`** : on anonymise pour garder le quantitatif, au
lieu de supprimer et de perdre les compteurs.

## 2.6 Le résumé de conversation dans le mini CRM

Un **champ système en lecture seule** du contact, portant le résumé de la **dernière** conversation
analysée, avec sa date. Présent dès qu'un contact a eu une conversation. Visible dans la fiche et dans
les exports, comme les autres champs.

🔴 **SYSTÈME ET PAS UN `user_fields` ORDINAIRE.** Un client qui le renommerait ou le supprimerait
casserait l'écriture automatique, et rien ne le signalerait avant la prochaine analyse. Un résumé qu'on
peut réécrire à la main cesse d'être un résumé de ce qui s'est dit.

⚠️ **LE DERNIER RÉSUMÉ, PAS UN CUMUL.** Un cumul grossit sans fin, devient illisible dans une colonne de
tableau et part entier dans chaque export CSV. L'historique complet reste consultable dans la fiche
contact, qui affiche déjà les conversations passées.

## 2.7 Ce qui clôt le lot 2

🔴 **UNE CAMPAGNE RÉELLE, SUIVIE DE BOUT EN BOUT, ET AUCUN TEST NE LA REMPLACE.** Une campagne avec
scénario est lancée, quelqu'un clique et répond depuis un vrai téléphone, puis on vérifie sur l'écran
que **cette personne compte pour 1 engagement**, que **son coût inclut les messages de service** qui lui
ont été envoyés, et que **le funnel node par node montre son parcours**. C'est le seul essai qui prouve
que les trois calculs parlent de la même personne : chacun peut être juste isolément et désigner
quelqu'un d'autre.

---

# Lot 3 : les thèmes déclarés et la réanalyse

Cadré ici, **sans plan d'exécution**, pour que le lot 2 sache quelles portes lui laisser ouvertes.

## Ce que le lot 3 apporte

1. **Le client déclare ses propres thèmes**, précis et nommés par lui, à la façon de convanalyzer.
2. **Un bouton relance l'analyse sur toute la base** pour y appliquer ces thèmes.
3. **Satisfaction et urgence par segment** de conversation : la partie humaine notée à part de la partie
   MBA, de la partie agent IA.

## Ce qui est déjà tranché

🔴 **LA RÉANALYSE ÉCRIT UNE VERSION DATÉE À CÔTÉ DE L'ANCIENNE, JAMAIS PAR-DESSUS.** Elle inverse une
décision inscrite dans le dépôt (« on ne réanalyse pas », parce qu'un humain a peut-être déjà lu et agi
sur l'analyse). Garder les deux versions est ce qui rend l'inversion acceptable : le bouton devient
réversible, ce qui est indispensable quand on vient de facturer un client pour l'avoir pressé.

🔴 **SUR LE CRÉDIT DU CLIENT, ET IL EST PRÉVENU AVANT.** Rejouer toute une base est un coût réel. Le
bouton annonce ce qu'il va consommer ; sans crédit suffisant, il renvoie vers `/agents/credit`, où
l'achat Stripe arrivera.

## Le piège que le lot 3 devra désamorcer

🔴 **L'ÉNUMÉRATION DES INTENTIONS EST FERMÉE ET SANS REPLI : UNE VALEUR INCONNUE PERD L'ANALYSE ENTIÈRE.**
`llmOutputSchema.intent` est un `z.enum` ([src/analysis/schema.ts:48](../../../src/analysis/schema.ts)) :
un modèle qui rendrait un septième thème fait échouer la validation, l'analyseur réessaie une fois, puis
lève `InvalidLlmOutputError`, terminale. Le sentiment, le résumé, les deux notes et le reste partent avec.
Ouvrir les thèmes sans traiter ce point ferait perdre des analyses en masse, au moment précis où on en
relance des milliers.

⚠️ La parade existe déjà dans ce fichier pour d'autres champs (`.catch(undefined)` sur les notes,
`.default(false)` sur `abusive`) avec sa justification écrite : « une analyse perdue coûte plus cher
qu'une mesure manquée ». C'est la même règle qu'il faudra appliquer aux thèmes.

---

# Les pièges nommés

Trois choses casseront en silence si personne ne les tient. Elles sont écrites ici pour être relues, pas
pour être devinées.

1. 🔴 **Les deux sources de comptage doivent tomber d'accord.** Agrégat nocturne et lecture en direct,
   même fonction, test de concordance sur un jour donné. Sinon : une marche à la frontière des 90 jours,
   indiscernable d'un vrai creux.
2. 🔴 **La franchise deviendra fausse le jour d'un second numéro.** Mesuré : chaque espace a exactement
   un numéro aujourd'hui, mais **rien ne l'impose** (`phone_numbers` n'a aucune contrainte d'unicité sur
   `tenant_id`), et surtout **ni `conversations` ni `conversation_messages` ne porte de numéro
   d'émission**. La franchise par numéro n'est donc pas calculable aujourd'hui, à aucun prix. Le jour où
   un espace aura deux numéros, il faudra une colonne, et la franchise par espace surfacturera d'ici là.
3. 🔴 **Le filtre des messages de service est PARTAGÉ, il ne se recopie pas.** Le total et sa ventilation
   par origine doivent utiliser exactement le même. Le fichier le dit déjà : « un filtre qui diverge d'un
   mot ferait mentir les deux ». Le calcul de coût devient un troisième consommateur de ce filtre.

---

# Les arbitrages pris CONTRE ma recommandation

Écrits pour être assumés, et pour que personne ne les prenne plus tard pour un oubli.

## La matrice perd toute sa phrase

Julien, 2026-09-17 : « rien du tout, on enlève ».

⚠️ **CE QUE ÇA COÛTE, MESURÉ LE JOUR MÊME : la matrice repose sur 2 analyses sur 14.** Douze n'ont aucune
des deux notes, parce qu'elles sont antérieures à la migration 0121 et qu'on ne réanalyse pas
l'historique. Sans la phrase, un nuage de deux points se lit comme le portrait complet de l'activité, et
rien à l'écran ne permet de s'en douter.

⚠️ **LE RISQUE EST TEMPORAIRE** : chaque nouvelle analyse porte les deux notes. La proportion se
redressera d'elle-même, sans intervention. C'est ce qui rend l'arbitrage raisonnable.

## Les topics sont agrégés tout de suite

Julien, 2026-09-17 : « on l'agrège tout de suite dans la Synthèse ».

⚠️ **CE QUE ÇA COÛTE : la liste sera redondante jusqu'au lot 3.** Quatre lignes diront « consultation
tarifs » sous quatre libellés. Le rangement sous les intentions limite la casse en mettant les variantes
côte à côte plutôt que dispersées, et rend l'inflation visible, ce qui est un argument pour construire
le lot 3 plutôt qu'un défaut à cacher.

---

# Ce qui n'est PAS dans ce cadrage

- **Le nom de l'agent IA dans les badges.** Reporté jusqu'à ce qu'un espace ait plusieurs agents.
- **Une normalisation des topics.** Le lot 3 la remplace par des thèmes déclarés, ce qui est mieux qu'un
  rapprochement approximatif.
- **L'achat de crédit Stripe.** Attendu, nommé dans le lot 3, pas cadré ici.
- **Le multicanal ou les segments avancés** dans l'écran d'analyse : la discipline anti-tailor-made du
  `CLAUDE.md` s'applique.
