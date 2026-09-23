---
ecran: securite-consentement
source_section: Sécurité & compliance (menu Sécurité)
source_empreinte: 74ff14
---
# Savoir qui s'est désabonné, et prévenir mes systèmes

Le menu **Sécurité**, en bas de la barre de gauche, rassemble tout ce qui sert à rendre des comptes : ce qui
a été fait, ce qui a échoué, et ce que les gens ont accepté. Sa page d'accueil porte une boîte par
sous-menu. Les administrateurs et les managers y ont accès.

**L'écran Consentement** liste les personnes qui ont demandé à ne plus être contactées, avec **depuis
quand** et **par quel chemin** le refus est arrivé : saisi par votre équipe, posé par un scénario, coché par
la personne dans un formulaire, ou reçu d'un système tiers. La date porte l'heure, parce que sur un écran de
conformité deux messages envoyés le même jour, l'un avant et l'autre après un refus, ne racontent pas la
même histoire. Pour les refus les plus anciens, l'écran affiche « date inconnue » au lieu d'inventer une
date qui n'aurait rien à voir.

**Les refus possibles à confirmer** sont des messages qui ressemblent à une demande d'arrêt sans en avoir la
forme reconnue (« arrêtez de me contacter », « retirez-moi de votre liste »). Personne n'est désabonné par
cette relecture : elle vous sert à juger, depuis la conversation, s'il faut élargir la règle. L'écran vous
dit aussi sur combien de messages il a regardé.

**On ne réabonne pas d'un clic depuis cette liste.** Cela se fait depuis la fiche du contact, là où vous
voyez à qui vous avez affaire : un bouton sur une liste rendrait trop facile d'annuler en série des refus
que des personnes ont exprimés.

**Ce qu'un désabonnement bloque vraiment.** Tous les envois automatiques : campagne, API, mais aussi
scénario, automation et agent IA. Depuis l'Inbox, un modèle de catégorie Marketing est refusé, un modèle de
catégorie Service (une livraison, un rendez-vous, un compte) reste autorisé. En revanche, **une personne de
votre équipe peut toujours répondre à la main** : sans cette exception, vous ne pourriez même pas accuser
réception du désabonnement. La machine se tait, la personne peut encore répondre à la personne.

**Prévenir votre propre système à chaque désabonnement.** Sur ce même écran, un administrateur choisit un
appel déjà déclaré dans Tools > Connecteurs API, et il est joué à chaque refus, quel qu'en soit le chemin.
Votre CRM ou votre back-office apprennent donc le refus, avec le numéro de la personne. C'est ce qui évite
qu'un refus enregistré ici vous laisse continuer à écrire à cette personne depuis vos autres outils.

Quatre points sur ce branchement :

- **Votre système en panne ne bloque jamais le désabonnement.** Le refus est enregistré d'abord, l'appel part
  ensuite, et un appel raté est réessayé cinq fois à intervalle croissant.
- **Rien ne sort tant que vous n'avez rien choisi.** Aucun espace n'est branché par défaut.
- **On ne décrit pas l'appel ici, on en désigne un.** Il se met au point une fois dans Tools, où un bouton
  « Essayer » permet de l'éprouver avant de le brancher. Et tant qu'il est branché ici, il refuse d'être
  supprimé.
- **Ce réglage est réservé à l'administrateur**, en lecture comme en écriture : brancher, c'est décider que
  des données de contact partent chez un tiers. Un manager voit la liste des désabonnés, pas ce réglage.
