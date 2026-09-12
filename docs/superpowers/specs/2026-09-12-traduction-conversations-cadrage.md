# La traduction des conversations : cadrage

> Cadrage. Date : 2026-09-12. Décisions de Julien prises en séance, reportées ici avec leurs raisons.
> Statut : **à relire par Julien** avant écriture d'un plan.

## Le but

Un opérateur lit les messages entrants dans SA langue, quelle que soit celle du client, et peut
faire traduire ce qu'il écrit avant de l'envoyer. Français et anglais côté console.

## La règle, et pourquoi elle est dissymétrique

🔴 **Nos deux langues sont celles de la CONSOLE, pas celles des clients.** Une première version de
ce cadrage disait « avec deux langues, traduire veut dire dans l'autre, donc aucune cible à
choisir ». C'est faux dès qu'un client écrit en espagnol, cas soulevé par Julien le 2026-09-12 à
propos des vocaux. La règle juste a deux moitiés qui ne se ressemblent pas.

| | Source | Cible | Connue ? |
|---|---|---|---|
| **Entrant** | n'importe quelle langue | la langue du LECTEUR | **oui**, c'est la langue de sa console |
| **Sortant** | la langue de l'opérateur | la langue du CONTACT | **seulement si on l'a apprise** |

## Les décisions

### La langue de lecture vient du navigateur, et le serveur ne la connaît pas

Elle vit dans le `localStorage` (`web/lib/i18n.tsx`), pas sur le compte. Le serveur l'ignore.

**Conséquence : on ne peut pas traduire un entrant à son arrivée**, puisqu'à cet instant personne ne
sait dans quelle langue le futur lecteur voudra le lire. C'est le navigateur qui demande, en
passant sa langue.

⚠️ **Le motif existe déjà et se décalque** : le bot d'aide envoie `QuestionAide.langue: 'fr' | 'en'`
à chaque question. On ne crée rien.

### Les entrants se traduisent tous à l'OUVERTURE d'une conversation

Pas à l'arrivée du message, pas message par message à la demande.

- **Pas à l'arrivée** : ce serait payer pour tous les « ok », tous les emojis et toutes les
  conversations que personne n'ouvrira jamais. Sur une campagne à 5 000 destinataires, l'écart n'est
  pas marginal.
- **Pas à la demande message par message** : un opérateur qui doit cliquer sur chaque bulle
  abandonnera au troisième.

Le résultat est rangé : le premier lecteur paie, les suivants réutilisent.

### Les sortants ne se traduisent JAMAIS automatiquement

Un bouton, avant l'envoi. 🔴 **C'est une garde, pas une commodité.** Une traduction ratée en entrée
se rattrape sur l'original affiché à côté ; une traduction ratée en sortie est partie chez un
client, et `features.md` le dit déjà : aucun message WhatsApp livré ne se rappelle.

⚠️ **Le bouton NOMME sa cible** : « Traduire en espagnol », jamais « Traduire » tout court.
L'opérateur voit où part sa phrase avant de valider. Tant qu'on n'a rien appris du contact, il nomme
la langue par défaut : il ne ment donc jamais.

### La langue du contact s'APPREND, elle ne se demande pas

🔴 **On la détecte déjà, et on la jette.** `src/agent/llm/transcription.ts` rend
`langue: string | null` (ligne 94) et la migration 0125 n'a créé aucune colonne pour la garder.
C'est la troisième donnée de ce genre trouvée le même jour, après le verdict de joignabilité
WhatsApp qui ne part que dans HubSpot.

Elle se retient donc sur la fiche du contact, alimentée par la transcription de ses vocaux et par la
traduction de ses textes. Ni question posée au contact, ni choix imposé à l'opérateur.

### Le toggle « traduire les entrants » vit dans le `localStorage`

Comme la langue elle-même. Un réglage d'affichage qui suit le navigateur plutôt que le compte n'a
jamais surpris personne, et ça évite une migration pour une préférence.

## Les vocaux

Quand l'opérateur appuie sur **Transcrire** et que la traduction est active, la transcription arrive
dans SA langue, **même si le vocal était en espagnol**.

- 🔴 **On traduit la TRANSCRIPTION, pas le corps.** Le `body` d'un audio vaut `[audio]` ou la
  légende : le traduire ne produirait rien. L'ordre est imposé, transcrire puis traduire, et ça
  reste **un seul geste** pour l'opérateur.
- 🔴 **NE PAS utiliser le mode « traduire » intégré des API de transcription.** Il ne cible que
  l'anglais. S'en servir donnerait un comportement différent selon que l'opérateur travaille en
  français ou en anglais, et **détruirait l'original**. On transcrit fidèlement, puis on traduit.
- ⚠️ **Deux appels, donc deux fois le coût** pour un vocal traduit.

## Ce qu'on enregistre

🔴 **La question à ne pas rater, et c'est le miroir exact de la migration 0125.**

**En entrée** : le message garde ce que le client a écrit. La traduction vit dans SA colonne, avec
la langue dans laquelle elle est. Pour un vocal, la transcription garde ce qui a été **dit** (en
espagnol) et la traduction est une lecture de cette transcription.

**En sortie, et c'est inversé** : `body` porte ce qui est **PARTI**, donc le texte traduit, parce que
c'est ce que le client a reçu et que notre trace doit y correspondre le jour d'un litige. Une
colonne à part porte ce que l'opérateur a **ÉCRIT**, sans quoi il ne peut plus se relire.

Ne garder qu'un des deux est faux dans les deux sens : le traduit seul rend l'opérateur aveugle à sa
propre conversation, l'original seul rend notre historique mensonger.

## Trois contraintes à montrer, pas à laisser découvrir

- 🔴 **Un template ne se traduit pas.** Il est approuvé par Meta dans une langue donnée, et le texte
  approuvé EST le texte. La traduction ne concerne que les messages libres, dans la fenêtre de 24 h.
  Un bouton « Traduire » affiché sur un template ment.
- ⚠️ **Traduire coûte des jetons** sur la clé Gateway de l'espace (migration 0124), donc sur le
  crédit prépayé du client. ⚠️ **Contrairement au bot d'aide, qui est sur NOTRE clé** : la traduction
  sert les conversations du client, pas son apprentissage du produit. Un espace à zéro ne peut pas
  traduire, et ça se dit à l'activation, pas au premier message muet.
- ⚠️ **La langue du contact peut être fausse une fois.** Un client francophone qui écrit « ok » ou un
  emoji peut être mal classé. Le bouton nommant sa cible, l'opérateur le voit avant d'envoyer, et
  corriger doit être possible d'un geste depuis la fiche.

## Ce qui reste à trancher

1. **Où vit le toggle à l'écran.** L'Inbox n'a **aucune barre de navigation**, c'est un choix assumé
   depuis la refonte du 2026-09-08. « Le menu en haut à gauche » (Julien) désigne donc probablement
   le sélecteur de langue existant de la console, à côté duquel le toggle se poserait naturellement.
   À confirmer sur l'écran plutôt que sur le papier.
2. **Le modèle de traduction.** Le catalogue AI Gateway est déjà branché pour les agents. Un modèle
   rapide et bon marché suffit largement, mais lequel se choisit en mesurant, pas en supposant.
3. **Que se passe-t-il quand la traduction échoue** (modèle indisponible, crédit épuisé) ? Position
   proposée : l'original s'affiche avec une mention discrète, jamais une bulle vide ni un message
   d'erreur bloquant. Un opérateur qui voit l'espagnol travaille moins bien mais travaille.