---
ecran: securite-audit
source_section: Journaux et traces (menu Sécurité)
source_empreinte: d301f5
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

**Le journal des erreurs de livraison**, juste en dessous, répond à l'autre question : ce que Meta a répondu
quand un message n'est pas parti, ou n'est pas arrivé. Le code, sa signification en français pour les plus
courants, la campagne, le numéro, et surtout **d'où vient l'échec** : « jamais parti », c'est-à-dire que
Meta a refusé notre appel, ou « parti, non délivré », c'est-à-dire le téléphone d'en face. Chercher au
mauvais endroit coûte cher, alors cette colonne est la première à regarder.

Celui-ci **porte les numéros**, contrairement au précédent : savoir quel message n'est pas arrivé sans
savoir à qui ne répond à rien. Il n'a rien d'immuable, et il disparaît avec le contact quand vous supprimez
celui-ci.

**On cherche dans les deux** par mot-clé, par utilisateur ou par numéro de client, et les deux s'exportent
en CSV. Une nuance dans le journal des actions : chercher par numéro passe par la fiche du contact, donc un
contact effacé ne s'y retrouve plus, même si ses actions y figurent toujours. L'écran le dit sous le
résultat vide, pour que vous ne concluiez pas qu'il ne s'est rien passé.
