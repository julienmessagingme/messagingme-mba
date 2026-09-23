---
ecran: chaine
source_section: Chaîne WhatsApp (menu Chaîne) : publier, et démarrer des conversations
source_empreinte: 131d2a
---
# Publier sur ma chaîne WhatsApp

Une chaîne WhatsApp diffuse à des abonnés, en un seul sens : ils reçoivent, ils ne répondent pas. Son
intérêt dans la console est de **ramener l'abonné en conversation** : chaque publication peut porter un
bouton « Discuter » qui ouvre WhatsApp avec un message déjà écrit, et ce message déclenche un scénario.

**Écrire le message.** Une zone de texte, un aperçu qui montre le post tel que l'abonné le verra, et une
barre de mise en forme : gras, italique, barré, plus une palette de smileys. Le smiley s'insère au curseur,
et la mise en forme s'applique à la sélection, qui reste posée pour enchaîner deux styles. La mise en forme
utilise la syntaxe de WhatsApp et part telle quelle : c'est le téléphone de l'abonné qui la rend, et
l'aperçu vous montre le rendu attendu, jamais les étoiles.

**Mettre une photo.** Le bouton « Choisir une image » téléverse depuis votre poste, la console héberge le
fichier et remplit l'adresse toute seule. Le champ d'adresse reste disponible si vous hébergez déjà vos
visuels ailleurs. 2 Mo maximum, en JPEG, PNG ou GIF : le type réel du fichier est relu, un fichier renommé
est refusé.

**Le bouton « Discuter »** se rattache à un **lien**, qui associe une **phrase** à un **scénario**. La
phrase est ce que l'abonné enverra en appuyant. Deux règles la gouvernent, et elles se voient à la création :
une phrase ne peut ni contenir ni être contenue dans celle d'un autre lien, sinon un seul appui démarrerait
deux scénarios ; et la console compte combien de messages existants la contiennent déjà, pour vous éviter
une phrase trop banale (« Bonjour » déclencherait sur tout).

**Un appui reprend la conduite du fil.** Si la conversation était tenue par un opérateur ou par l'agent de
Meta, le scénario du bouton part quand même et la conduite revient à l'application. C'est le même principe
qu'une campagne : quelqu'un a fait un geste explicite, ici l'abonné lui-même. Un mot-clé ordinaire, lui, ne
reprend pas la main : une personne en train de répondre à un client ne doit pas se faire couper la parole
par un scénario sur un simple message.

**La liste des publications** montre, pour chaque post : son texte mis en forme, sa date, son statut lu en
direct chez le fournisseur, le scénario vers lequel son bouton renvoie, et combien de personnes ont envoyé
le message de son bouton. Un bouton mort est signalé, avec sa réparation à côté.

**« Combien de clics » n'existe pas, et ce n'est pas une lacune de la console.** Un appui sur le bouton ouvre
WhatsApp sur le téléphone de l'abonné : ce geste ne traverse aucun serveur, ni les nôtres ni ceux de la
chaîne. Ce qui est mesurable, c'est le message qui arrive ensuite. L'écran affiche donc exactement ce qu'il
observe, « N personnes ont envoyé ce message », comptées en personnes distinctes : un abonné qui appuie
trois fois compte pour une.

Trois limites sont écrites sous la liste, plutôt que rangées dans une infobulle :

- le chiffre vaut pour le **bouton**, toutes ses publications confondues. Deux posts sur le même bouton
  envoient le même message, rien ne dit lequel a été vu ;
- un message reçu alors que le bouton était éteint est compté, sans avoir rien démarré ;
- quand la mesure est indisponible, l'écran n'affiche **rien** plutôt qu'un zéro, qui se lirait « ce bouton
  n'a rien produit ».

Ce chiffre ne dit d'ailleurs pas « conversations démarrées », et c'est délibéré : nous ne reconnaissons que
la phrase du bouton, alors que trois conditions de plus décident ensuite si un scénario démarre vraiment.
