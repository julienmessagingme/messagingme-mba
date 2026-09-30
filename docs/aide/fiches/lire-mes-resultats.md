---
ecran: perf-synthese
source_section: Analytics (menu Analytics)
source_empreinte: 9d7559
---
# Lire mes résultats dans le Performance Lab

L'onglet Performance Lab rassemble quatre pages : **Synthèse**, **Quantitatif**, **Analyse des
conversations** et **Mes tableaux**.

**La Synthèse** répond à la question qu'on se pose en arrivant : ce que coûte un engagement. Une ligne par
campagne ayant envoyé sur la période, avec ses envoyés, ses engagés et son coût par engagé. Est compté comme
engagement toute réaction du contact, un clic mais aussi une réponse : une campagne qui démarre un scénario
n'a pas de lien tracé et fait pourtant réagir des gens.

Le coût affiché est une **estimation, pas une facture**, et l'écran le dit : il se recalcule à partir des
envois et des tarifs que Meta donne pour la période. Trois cases restent volontairement **vides** plutôt
que d'afficher un zéro, avec leur raison au survol : le coût quand Meta ne donne aucun tarif, le nombre
d'engagés quand rien ne permet de le rattacher à la campagne, et le rapport dès qu'un des deux manque. Un
zéro affirmerait « ça n'a rien coûté » ou « personne n'a réagi ». Le tableau montre au plus cinquante
campagnes, les plus grosses, et vous dit quand la période en compte davantage.

**Cliquez une ligne** pour ouvrir la fiche de la campagne : ce qu'elle a coûté et ce que les gens en ont
fait, étape par étape pour une campagne à scénario (les clics, les boutons tapés et les réponses écrites,
en gestes et en personnes). Deux choses à savoir : le coût de référence est le **lancement**, c'est-à-dire
le premier message envoyé à chaque destinataire, les modèles qu'un scénario renvoie ensuite étant comptés à
part ; et cette fiche couvre **toute la vie de la campagne**, pas la période choisie en haut, ce qui explique
qu'elle puisse différer de la ligne du tableau. Les échecs sont montrés séparément.

À droite, le **nuage « urgence et satisfaction »** place une conversation par point, la satisfaction en
abscisse et l'urgence en ordonnée : le coin qui alarme tombe en haut à gauche. Il se remplit au fil des
jours, puisque seules les conversations analysées depuis la mise en service de ces deux notes en portent.
Les analyses qui n'en ont pas sont comptées à part sous le graphe, elles ne valent pas zéro.

**Le Quantitatif** porte les volumes, les coûts et les funnels, sur une plage libre (7, 30 ou 90 jours, ou
des dates que vous choisissez). Vous y trouvez vos contacts (au choix **cumulés**, la courbe historique qui
ne baisse jamais, ou **actifs**, ce qu'il vous reste après vos suppressions), les messages envoyés et
échangés, le coût estimé par jour, filtrable par campagne ou par modèle, et les erreurs de Meta par code et
par modèle. Un tableau dit aussi **qui a écrit les messages de service** : l'IA, un scénario, ou une
personne de votre équipe, avec le détail de l'IA (votre agent, celui de Meta, un agent tiers).

La page **Quantitatif > Performance** mesure votre équipe sur les conversations qu'un robot lui a passées (un
scénario, un agent IA, l'agent de Meta, ou la réponse à une campagne qui arrive dans l'Inbox), et sur celles qu'un
client rouvre en réécrivant après « Traité » ou un archivage, tant que votre équipe les tient. Le chrono part quand
le client a écrit : un destinataire de campagne qui ne répond jamais ne compte pas, et celui qui répond deux jours
plus tard compte à partir de sa réponse. Le **temps de réponse** va jusqu'au premier message écrit dans l'Inbox par
un collaborateur, et le **temps de résolution** jusqu'au premier « Traité », archivage ou retour à un robot ; si
personne ne clique « Traité » et que la console rend la conversation au robot après le délai de reprise, la
résolution s'arrête à la dernière réponse de l'équipe. Vous y lisez la médiane et le 90e centile de chacun, la
courbe par jour et un tableau par collaborateur (la réponse à celui qui a répondu le premier, la résolution à celui
qui a clos, et toutes les demandes qu'il a closes, avec ou sans réponse). Les durées se comptent **en heures
d'ouverture** de votre espace, réglées dans Paramètres, et s'écrivent alors en heures, jamais en jours : une
demande arrivée vendredi soir et répondue lundi matin n'a pas attendu tout le week-end. Un chiffre qu'on ne connaît
pas encore s'écrit « non disponible », jamais zéro ; les demandes closes sans aucune réponse sont comptées à part ;
« encore ouvertes » compte toutes les demandes ouvertes en ce moment, quelle que soit la période choisie ; et la
mesure démarre à sa mise en service, que la page date.

Le **funnel par campagne** va de l'envoi à la réponse. Il ne suit pas le sélecteur de période, il porte
toujours sur la totalité de la campagne choisie. « Délivrés » et « lus » affichent un tiret quand Meta n'a
rendu aucun accusé, ce qui est le cas par construction d'une campagne qui envoie un scénario.

**L'Analyse des conversations** montre ce que vos conversations disent, classées par une IA : sentiment,
intention, action suggérée, taux de résolution, sujets fréquents. Tout y est cliquable : un chiffre ouvre la
liste des conversations concernées, une ligne ouvre une fiche avec le résumé et un bouton vers l'Inbox, et
la liste s'exporte en CSV comme en PDF. L'écran annonce la durée pendant laquelle votre espace conserve ses
conversations : au-delà, une conversation n'est plus consultable, donc une liste plus courte que la période
demandée n'est pas une anomalie.

**Mes tableaux** sert à construire vos propres mesures sur un scénario : il s'affiche tel que vous l'avez
dessiné, et un clic sur un bloc de message choisit ce que vous voulez compter (envoyés, lus, chaque choix
cliqué, le clic sur un lien, « a répondu sans cliquer »). Le tableau se nomme, s'enregistre et se rouvre,
rendu en histogramme.

Deux derniers points qui évitent des surprises : la **période ne suit pas d'une page à l'autre**, chacune
repart de son défaut de trente jours ; et **une conversation ouverte depuis « Tester le scénario » n'entre
dans aucun chiffre**, ni dans l'analyse. Tester depuis votre propre téléphone ne déforme rien.
