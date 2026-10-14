# La durée de validité des modèles (plan)

**Statut : validé par Julien le 2026-10-14** (trois choix, ci-dessous). Lot A de l'éditeur de modèles, après le lot
« envoi » de la Marketing Messages API (`2026-10-14-mm-api-envoi.md`). Le lot B, l'en-tête GIF, attend une mesure.

**But :** dans l'éditeur de modèles, choisir combien de temps WhatsApp tente de livrer un message avant de l'abandonner.
Une promo à durée limitée n'arrive plus trois jours après la fin de l'offre ; un rappel de rendez-vous n'arrive plus
après le rendez-vous.

## Ce que dit Meta (pages relues le 2026-10-14)

- Le champ s'appelle `message_send_ttl_seconds`. Il s'envoie à la création (`POST /{waba}/message_templates`) et à
  l'édition (`POST /{template_id}`), et se lit dans la liste (`fields`) : les trois sont dans la référence « Message
  Template API ».
- **Marketing** : de 12 h à 30 jours (défaut 30 jours), appliquée SEULEMENT aux envois par la Marketing Messages API,
  donc une fois `META_MM_LITE` allumé. **Utility** : de 30 secondes à 12 h, appliquée par la Cloud API dès aujourd'hui ;
  `-1` vaut 30 jours, le défaut.
- Un reclassement automatique par Meta efface la durée (elle redevient nulle).
- Passé le délai, le message est abandonné : aucun accusé de livraison n'arrive.

## Les trois choix de Julien

1. **La durée d'abord, le GIF ensuite** : le GIF attend une mesure de sa syntaxe d'envoi, que Meta ne documente pas.
2. **Marketing ET utility** : même champ, et l'utility marche dès aujourd'hui.
3. **Des durées proposées**, jamais une saisie libre. Marketing : 12 h, 24 h, 48 h, 7 jours, 30 jours (défaut). Utility :
   1 h, 6 h, 12 h, 30 jours (défaut).

## Tâches

1. **Le module partagé** (`web/lib/partage/duree-validite.ts`) : les durées proposées par catégorie, le défaut, les
   bornes de Meta (`dureeValide`). La console propose, le serveur refuse ce que Meta refuserait : une seule source.
2. **Le client Meta** (`src/meta/templates.ts`) : `ttlSecondes` à la création et à l'édition, envoyé en
   `message_send_ttl_seconds` seulement s'il est donné ; `list` lit le champ (`TemplateSummary.ttlSecondes`).
3. **La route** (`src/http/templates.ts`) : `parseTemplateFields` valide `ttlSecondes` (entier, dans les bornes de la
   catégorie, sinon 400 lisible) ; la création et l'édition le transmettent.
4. **L'éditeur** (`web/components/TemplateForm.tsx`, `web/lib/api/templates.ts`) : un choix « Durée de validité »
   sous la catégorie, remis au défaut quand la catégorie change. 🔴 **Le défaut n'envoie rien** : un modèle créé sans
   toucher à la durée part exactement comme aujourd'hui. À l'édition, revenir au défaut depuis une durée choisie envoie
   la valeur du défaut, pour l'effacer chez Meta.
5. **Documentation** : `features.md` (l'éditeur) avec sa fiche d'aide si elle cite la section, `documentation.md`.

**Hors lot :** le carrousel (`CarouselForm`), l'API publique (`/v1/templates`) et l'outil MCP de création. Ils gardent
le défaut de Meta.

## Trouvé par la relecture, corrigé dans le lot

1. 🔴 **« Modifier » ou « Dupliquer » sur un modèle d'AUTHENTIFICATION faisait planter la page Modèles.** La liste de
   Meta en contient, et l'éditeur lisait les durées proposées d'une catégorie qui n'en a pas (TypeError au rendu, et
   aucun `error.tsx` sous `web/app`). Le champ ne s'affiche et ne part désormais que pour marketing et utilitaire.
2. La liste des modèles est sur le chemin des envois (campagnes, scénarios) : si Meta refusait le nouveau champ
   (erreur 100), elle est relue sans lui. On perd l'affichage de la durée, jamais les envois.
3. Le vocabulaire suit l'écran (« Utilitaire », pas « Service »), et les textes disent qu'un message abandonné ne
   reçoit aucun accusé de livraison.

## Ordre de déploiement

Aucune migration. L'API d'abord (elle accepte le champ et le lit chez Meta), la console ensuite : une console déployée
seule enverrait un champ que l'ancienne API ignorerait en silence, et l'utilisateur croirait sa durée enregistrée.
Vercel publie la console au push : la fenêtre se dit au moment du push, et le déploiement de l'API suit aussitôt.

## Méthode de livraison

**Implémenteur par lot, avec relecture du diff**, parce que le lot touche la création de modèles, un chemin que la
production emprunte, et la LECTURE de la liste des modèles chez Meta : un champ que Meta refuserait ferait échouer
toute la liste (erreur 100), donc l'écran des modèles, les campagnes et les scénarios qui la lisent. La référence de Meta
nomme bien le champ, mais seul un essai réel le prouve. Une relecture indépendante en fin de lot.

**Essai réel qui clôt le lot**, après déploiement :
1. L'écran des modèles d'un espace de test s'affiche (la liste lue avec le nouveau champ).
2. Un modèle utility créé avec « 1 heure » : la liste le relit à 1 heure, et Meta l'accepte en revue.
3. Le même modèle repassé à « 30 jours (défaut) » à l'édition : la liste le relit au défaut.
4. Un modèle marketing créé avec « 7 jours » sur un espace NON inscrit à la Marketing Messages API (le cas de la
   plupart des clients) : Meta l'accepte, et la liste le relit à 7 jours. S'il le refusait, le refus est visible à la
   création, et il faudra le dire dans le texte du champ.
5. Un modèle créé sans toucher à la durée : son corps chez Meta ne porte aucune durée (comme avant le lot).
6. Sur un espace qui a un modèle d'authentification : « Modifier » et « Dupliquer » ouvrent le formulaire, sans champ
   de durée.
