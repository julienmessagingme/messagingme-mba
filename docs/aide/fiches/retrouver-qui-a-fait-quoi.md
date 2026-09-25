---
ecran: securite-audit
source_section: Journaux et traces (menu Sécurité)
source_empreinte: 07f303
---
# Retrouver qui a fait quoi, et pourquoi un message n'est pas parti

Le menu Sécurité porte deux journaux, qui ne répondent pas à la même question.

**Le journal des actions** dit qui a fait quoi, et quand. Les gestes sur vos contacts d'abord : qui a
ajouté, supprimé, effacé, ou basculé un consentement. Mais aussi les **accès et les portes** : qui a invité
un collaborateur, changé son rôle, révoqué ou supprimé son compte ; qui a créé ou révoqué une clé d'API ;
les échecs de connexion ; qui a créé, modifié ou supprimé un webhook entrant ou un connecteur, et qui a
touché à leur secret ; qui a rattaché un numéro WhatsApp ; et qui a exporté l'historique d'un contact.

Ce journal est fait pour ne jamais être modifié, et cela dicte ce qu'il contient :

- **Les contacts y figurent par identifiant interne, jamais par numéro.** Y écrire un numéro annulerait la
  suppression d'un contact, puisque la ligne, elle, ne s'efface pas.
- **Il ne porte aucune adresse e-mail** (sauf celle de l'auteur de l'action), **aucun numéro, aucun texte de
  message**, ni le code d'un webhook, ni le secret d'un connecteur, ni une clé d'API. Un champ interdit est
  retiré avant l'écriture, et la ligne dit qu'il a été retiré plutôt que de le taire.
- **Les échecs de connexion ne sont enregistrés que pour des comptes qui existent.** Une tentative sur une
  adresse inventée n'appartient à aucun espace, elle ne peut donc pas y figurer.

**Le journal des erreurs**, juste en dessous, répond à l'autre question, en deux parties.

**Les erreurs de livraison** disent ce que Meta, ou pour un RCS le fournisseur RCS, a répondu quand un
message n'est pas parti, ou n'est pas arrivé. Le code, sa signification en français pour les plus courants,
la campagne, le numéro, et surtout **d'où vient l'échec** :

- « jamais parti » : notre appel a été refusé ;
- « parti, non délivré » : le téléphone d'en face n'a pas reçu un message de campagne ;
- « scénario bloqué sur une réponse » : c'est le traitement du message REÇU qui n'a pas abouti ;
- « message non délivré » ou « RCS non délivré » : un message envoyé hors campagne n'est pas arrivé, et sa
  provenance est dite entre parenthèses (réponse d'un opérateur, envoi par l'API, bloc de scénario, agent
  IA, agent de Meta, agent branché par MCP).

Chercher au mauvais endroit coûte cher, alors cette colonne est la première à regarder. Cette partie **porte
les numéros**, contrairement au journal des actions : savoir quel message n'est pas arrivé sans savoir à qui
ne répond à rien. Elle n'a rien d'immuable, et elle disparaît avec le contact quand vous supprimez celui-ci.

**Les erreurs système** disent quels appels la console a passés vers VOS systèmes sans qu'ils aboutissent :
qui appelait (un agent IA, le bloc « Appel HTTP » d'un scénario, la poussée d'un désabonnement, l'agent de
Meta, ou la remontée des signaux vers l'outil branché dans Paramètres > Intégrations) et ce que votre système
a répondu.

**On cherche dans les deux** par mot-clé, par utilisateur ou par numéro de client, et les deux s'exportent
en CSV. Une nuance dans le journal des actions : chercher par numéro passe par la fiche du contact, donc un
contact effacé ne s'y retrouve plus, même si ses actions y figurent toujours. L'écran le dit sous le
résultat vide, pour que vous ne concluiez pas qu'il ne s'est rien passé.
