# Les messages interactifs de l'agent de Meta (UI Skills), et les Consignes

Spec écrite le 2026-10-07 après une ronde de questions et le design présenté en conversation, à relire par Julien
avant le plan. Source : la documentation de Meta relue à la source le même jour, en local (la session cloud ne peut
pas joindre `developers.facebook.com`) : la référence `reference/configure/ui-skills`, le guide
`usage-guides/writing-ui-skills`, le guide `usage-guides/booking-and-reservation-agent` et le changelog.

## 1. Ce que veut Julien

Que l'agent de Meta puisse envoyer, dans ses propres réponses, des composants WhatsApp : boutons de réponse, liste de
choix, bouton lien (paiement, lien profond), formulaire (check-in, prise de dates), carrousel, image, lieu, demande de
position. Le client du client clique, et l'agent poursuit la conversation en sachant ce qui a été choisi, sans jamais
passer la main à notre scénario.

Et que la console ne confonde plus deux objets de Meta qui se ressemblent : ce que l'écran appelle aujourd'hui
« Compétences » (les *agent instructions* de Meta) et ces nouveaux messages (les *interactive messages*).

Décisions de la ronde du 2026-10-07 :

| Question | Décision |
| --- | --- |
| Noms à l'écran | « Consignes » et « Messages interactifs » ; en anglais « Instructions » et « Interactive messages » |
| Types du premier lot | Les neuf |
| Rédaction | Texte libre guidé : un canevas par type, pré-rempli dans le champ |
| Assistant de configuration | Il sait les proposer dès ce lot |
| Formulaire supprimé alors qu'un message interactif l'utilise | Refusé, avec un message qui nomme ce message |

## 2. Ce que dit Meta (relu le 2026-10-07)

- **Deux objets distincts, aucun lien structuré entre eux.** Une consigne vit sur `agent_config/skills` (un titre en
  slug de 64 caractères au plus, un texte de 20 000 caractères au plus, un statut de revue). Un message interactif vit
  sur `/{entity_id}/agent-ui-skills`, en-tête `X-API-Version: 2.0.0`, permission `whatsapp_business_messaging`.
  Aucun champ ne relie l'un à l'autre : le lien passe par le langage naturel de la consigne du message interactif,
  qui dit elle-même quand il part.
- **Le renommage de Meta du 2026-09-10 ne touche que les noms**, pas l'API.
- **Le contrat** : `POST /` (201), `GET /` paginé par curseur (`before`, `after`, `limit`), `GET /{id}`,
  `PUT /{id}` (200), `DELETE /{id}` (204). À la création : `title`, `component_type`, `status` (`enabled` ou
  `disabled`) et `instruction`, tous requis, plus `flow_id` (entier) requis pour `flow` et refusé pour tout autre
  type. 🔴 **La modification ne porte que `title`, `status` et `instruction`** : le type et le formulaire sont fixés à
  la création, et en changer veut dire supprimer puis recréer.
- **Un message interactif de type formulaire ne s'active qu'une fois le formulaire publié.** En brouillon, on le crée
  désactivé.
- **Ce qui revient à l'agent quand le client agit** : le libellé du bouton (boutons de réponse, carrousel à
  réponses), l'identifiant de la ligne (liste), les données du formulaire, la position partagée.
- **Pas de paiement dans la conversation hors Brésil et Inde**, et Meta dit de ne pas le promettre. Le schéma
  recommandé : l'agent réserve, un bouton lien ouvre le paiement, et la conversation confirme par un outil de statut.
- **Non documenté** : les longueurs maximales de `title` et d'`instruction`, la forme de l'écho d'un message
  interactif envoyé par l'agent, et la façon dont `agent_test` rend un message interactif (sa réponse ne porte que du
  texte, `quick_replies` et `product_variant_ids`).

## 3. Les noms, et ce qui ne se renomme pas

| Objet de Meta | À l'écran (fr) | À l'écran (en) | Clés internes, inchangées |
| --- | --- | --- | --- |
| agent instructions | Consignes | Instructions | onglet `competences`, élément d'historique `competence`, opérations `competence.*`, `data-testid` `mba-skill-*`, routes `/skills` |
| interactive messages | Messages interactifs | Interactive messages | onglet `messages_interactifs`, élément `message_interactif`, opérations `message_interactif.*`, routes `/messages-interactifs` |

🔴 **On ne renomme que ce qui s'affiche.** L'assistant garde ses entretiens en base avec des opérations nommées
`competence.*` (`src/mba/assistant/entretien-store.ts`) : renommer la clé ferait relire de travers chaque entretien
existant. L'Historique garde ses lignes sous l'élément `competence`. Les `data-testid` restent, les e2e qui trouvent
par texte suivent le nouveau libellé.

Ce qui change de libellé, et seulement de libellé : l'onglet et le repli de `web/lib/libelles-mba.ts`
(`competences`), `web/app/mba/parametres/page.tsx`, `web/components/MbaSkillsPanel.tsx` (boutons, titres, état
vide, alertes), `web/components/MbaOverviewPanel.tsx` (« Only skills require it »), le libellé d'historique de
`src/http/mba.ts` (« Compétence »), le résumé de l'inventaire de l'assistant (`src/mba/assistant/conversation.ts`,
« Compétences (n) »), son libellé de diff (`src/mba/assistant/application.ts`), `features.md` (quatre occurrences) et
la fiche `docs/aide/fiches/le-repondeur-de-meta.md`, son empreinte refaite dans le MÊME commit (vérifié par
`tests/aide-proposer.test.ts` avant de pousser).

Les neuf types, nommés à l'écran :

| `component_type` | Nom à l'écran |
| --- | --- |
| `interactive_reply_buttons` | Boutons de réponse |
| `interactive_list` | Liste de choix |
| `cta_url` | Bouton lien |
| `flow` | Formulaire |
| `image` | Image |
| `location` | Lieu |
| `location_request` | Demande de position |
| `carousel_url` | Carrousel à liens |
| `carousel_quick_reply` | Carrousel à réponses |

## 4. Où vit la vérité

Chez Meta, comme pour les consignes et la FAQ. Aucune table chez nous : une copie synchronisée ferait deux vérités, et
rien ne la demande. La console lit et écrit chez Meta par nos routes ; chaque écriture laisse sa ligne dans
`reglages_historique` (élément `message_interactif`, colonne `text` libre, donc **aucune migration**), seul exemplaire
d'un contenu que Meta ne garde pas.

## 5. Serveur

**Le client Meta** (`src/mba/client.ts`) : `listMessagesInteractifs` (suit `paging.cursors.after` tant qu'il est
présent, plafonné à 10 pages : mesuré le 2026-10-07, Meta ne rend jamais `next`), `creerMessageInteractif`, `modifierMessageInteractif`, `supprimerMessageInteractif`.
La réponse est lue par `safeParse` (`id`, `title`, `component_type`, `status`, `instruction`, `flow_id` facultatif),
jamais par `as`. Le chemin ne porte pas d'`agent_id` : la référence n'en mentionne aucun, contrairement aux consignes.

**La validation avant l'appel**, dans un module pur partagé par la route et l'assistant
(`src/mba/messages-interactifs.ts`) : le type dans l'énumération fermée des neuf, `flow_id` présent si et seulement si
le type est `flow`, titre et consigne non vides et bornés : titre 64, consigne 20 000, **comptés en octets UTF-8** comme le fait Meta
(mesuré le 2026-10-07 : une consigne de 20 000 caractères dont 10 accentués est refusée comme « 20010 »).

**Les routes**, dans `registerMba` (`src/http/mba.ts`, module `mba` de classe `tenant`, donc la garde et l'étape
d'espace posées au montage, rien à déclarer dans `FAUSSES_AUTORITES`) :

| Route | Rôle | Écriture d'historique |
| --- | --- | --- |
| `GET {base}/messages-interactifs` | la liste | non |
| `POST {base}/messages-interactifs` | créer (administrateur) | ajout |
| `PUT {base}/messages-interactifs/:id` | titre, consigne, actif (administrateur) | modification |
| `DELETE {base}/messages-interactifs/:id` | supprimer (administrateur) | suppression, avec le contenu supprimé |

`{base}` vaut `/tenants/:tenantId/mba/:phoneNumberId`, comme les consignes. Les formulaires publiés se lisent par la
route existante `GET /tenants/:tenantId/flows`, filtrée sur `PUBLISHED` côté console : pas de route de plus.

🔴 **Un `flow_id` se vérifie contre les formulaires DE L'ESPACE** (`flows.tenant_id = $1 and status = 'PUBLISHED'`),
à la route comme à l'assistant. Sans ce filtre, un espace pourrait faire ouvrir par son agent le formulaire d'un autre.

**La suppression d'un formulaire** (`DELETE /tenants/:tenantId/flows/:flowId`, `src/http/flows.ts:349`) lit d'abord
les messages interactifs du numéro de l'espace quand l'agent de Meta y existe, et rend 409 en nommant chaque message
qui utilise ce formulaire. Une lecture chez Meta qui échoue rend 503 avec un message lisible (« impossible de
vérifier, réessayez ») : supprimer à l'aveugle pourrait casser un agent en service. Un espace sans agent de Meta ne
fait aucun appel. Un formulaire supprimé directement dans le WhatsApp Manager reste hors de notre portée.

## 6. L'Inbox : l'écho d'un message interactif de l'agent

Aujourd'hui, `processHandovers` (`src/webhooks/handover.ts`) n'enregistre un écho de l'agent que s'il porte
`text.body`. Un message interactif est donc invisible dans l'Inbox, et l'opérateur qui reprend la conversation ne
voit pas ce que l'agent a proposé. Le sens inverse fonctionne déjà : `contentOf` (`src/webhooks/inbound.ts`) lit
`button_reply`, `list_reply`, `nfm_reply` et `location`, et un message en `standby` ne fait avancer aucun scénario ni
aucune automation.

Une fonction pure, `texteDeLEcho(message)`, rend un texte lisible, sans nouvelle colonne, stocké comme le corps
actuel :

| Écho | Texte enregistré |
| --- | --- |
| boutons de réponse | le corps, puis `[Boutons : Oui · Non]` |
| liste | le corps, puis `[Liste « Voir les créneaux » : 9 h · 10 h · 11 h]` |
| bouton lien | le corps, puis `[Bouton lien « Payer » : https://…]` |
| formulaire | le corps, puis `[Formulaire « Réserver »]` |
| carrousel | le corps, puis `[Carrousel : Carte 1 · Carte 2 · …]` (le texte de chaque carte, tronqué) |
| image | la légende, sinon `[image]` |
| lieu | le nom, sinon l'adresse, sinon `[lieu]` |
| demande de position | le corps, puis `[Demande de position]` |
| type inconnu | `[message interactif]`, et le payload complet journalisé |

🔴 **La forme de ces échos n'est pas documentée, elle se MESURE avant d'écrire une ligne** (étape 0 du plan) : un
message interactif de chaque type créé sur le numéro de test, déclenché dans une vraie conversation, puis lu dans
`webhook_events` (rétention de 30 jours). Les payloads réels deviennent les fixtures de `texteDeLEcho`. On suppose
qu'un écho reprend la forme d'envoi de la Cloud API (`interactive.body.text`, `interactive.action.buttons`,
`.sections`, `.cards`) ; si la mesure dit autre chose, c'est elle qui fait foi.

## 7. L'assistant de configuration

Trois opérations neuves dans `src/mba/assistant/proposition.ts` :

- `message_interactif.ajouter` : `titre`, `type` (énumération fermée des neuf), `consigne`, `formulaire`
  (l'identifiant d'un formulaire, requis pour `flow` et refusé pour les autres, par un `refine`). Créé actif.
- `message_interactif.modifier` : `cible`, `titre`, `consigne`. Ni le type ni le formulaire, que Meta ne laisse pas
  modifier.
- `message_interactif.supprimer` : `cible`, `libelle`. La règle « une seule suppression par diff » s'applique déjà
  par le suffixe.

Il voit ce qui existe : l'inventaire (`src/mba/assistant/inventaire.ts`, `conversation.ts`) ajoute les messages
interactifs du numéro et les formulaires publiés de l'espace (identifiant et nom). L'application
(`application.ts`) refuse un `formulaire` absent des formulaires publiés de l'espace, avec le message de la route.

🔴 **Les bornes que Zod applique sont annoncées dans le schéma envoyé au modèle.** L'outil `proposer`
(`src/http/mba-assistant.ts`, `outilProposer`) annonce aujourd'hui `operations` comme des objets dont seul `type` est
décrit : aucune borne, aucune énumération, pour aucune des onze opérations existantes. Le schéma annoncé des
opérations est désormais DÉRIVÉ de `operationSchema` (`z.toJSONSchema`, Zod 4), ce qui ferme aussi l'écart existant ;
un test de parité, sur le modèle de `tests/agent-setup-bornes.test.ts`, extrait les bornes de Zod et exige que le
schéma annoncé les porte toutes. ⚠️ À vérifier au premier tour réel : le modèle de l'assistant accepte un schéma
d'union discriminée.

## 8. La console

**L'onglet « Consignes »** : l'actuel, renommé (§3).

**L'onglet neuf « Messages interactifs »**, juste après « Consignes » dans `web/app/mba/parametres/page.tsx` :

- Une ligne d'introduction : l'agent garde la conversation et compose lui-même le message ; « Envoyer un bloc » et
  « Lancer un scénario » (onglet Outils) font passer la main à un scénario. Ce n'est pas le même outil.
- La liste : l'icône et le nom du type, le titre, interrupteur actif ou inactif (un `PUT` du seul statut), modifier,
  supprimer.
- **L'ajout se fait comme l'ajout d'un outil** (demande de Julien du 2026-10-07) : un bouton « + Ajouter un message
  interactif » ouvre une grille de neuf cartes, sur le modèle exact de « Quel outil ajouter ? »
  (`web/components/mba-outils/ChoixTypeOutil.tsx`) : l'icône et le nom sur la même ligne, une phrase d'aide dessous,
  et la même paire icône et nom dans la liste des messages en place. La carte « Formulaire » est grisée, pas cachée,
  avec un lien vers `/flows`, quand l'espace n'a aucun formulaire publié ; une lecture ratée le dit et propose de
  relire, comme la grille d'outils.
- **La fiche** qui s'ouvre après le choix : « Quand l'envoyer » d'abord (la situation, en une phrase : « quand le
  client demande à réserver »), puis le contenu pré-rempli du canevas du type, le titre, et pour un formulaire le
  sélecteur des formulaires publiés de l'espace. Les deux champs forment la consigne envoyée à Meta,
  `Quand : <quand>` sur la première ligne puis le contenu ; à la relecture, une consigne qui commence par `Quand : `
  se sépare sur sa première ligne, une autre (écrite par l'assistant ou ailleurs) va entière dans le contenu, avec
  « Quand l'envoyer » vide et l'invite à le préciser. La fiche d'un message existant montre le type en lecture
  seule, avec la phrase « Pour changer de type ou de formulaire, supprimez ce message et recréez-le » (Meta ignore en
  silence un changement de type, mesuré le 2026-10-07).

Les icônes, toutes de la famille de la console (`web/components/Icone.tsx`, seul importeur de Phosphor) :

| Type | Icône |
| --- | --- |
| Boutons de réponse | `reponse` (existante) |
| Liste de choix | `liste`, neuve (`ListBulletsIcon`) |
| Bouton lien | `lien` (existante) |
| Formulaire | `formulaire` (existante) |
| Image | `image` (existante) |
| Lieu | `position` (existante) |
| Demande de position | `localiser`, neuve (`GpsFixIcon`) |
| Carrousel à liens, carrousel à réponses | `carrousel`, neuve (`CardsThreeIcon`) |
- Les écritures sont réservées aux administrateurs, comme sur les autres onglets.

**Les canevas**, un par type, dans `web/lib/messages-interactifs.ts` (pur, testé) :

```
Boutons de réponse
Quand : (la situation où l'agent envoie ce message)
Texte du message (1 à 1 024 caractères) :
Boutons (1 à 3, 20 caractères chacun, tous différents) :
```

```
Liste de choix
Quand :
Texte du message (1 à 4 096 caractères) :
Texte du bouton qui ouvre la liste (1 à 20 caractères) :
Lignes (1 à 10) : pour chacune, un identifiant stable (188 caractères au plus), un titre (24 au plus),
une description facultative (72 au plus)
```

```
Bouton lien
Quand :
Texte du message (1 à 1 024 caractères) :
Libellé du bouton (1 à 20 caractères) :
Adresse ouverte (https) :
Facultatif : image ou vidéo d'en-tête (adresse https), pied de message (1 à 60 caractères)
```

```
Formulaire
Quand :
Texte du message (ce que le client fera après avoir touché le bouton) :
Libellé du bouton (20 caractères au plus) :
Facultatif : les valeurs qui pré-remplissent le premier écran du formulaire
```

```
Image
Quand :
L'image : son adresse publique, ou l'identifiant d'une image déjà téléversée (l'un ou l'autre)
Facultatif : la légende
```

```
Lieu
Quand :
Latitude (-90 à 90) et longitude (-180 à 180), venues d'une source sûre comme la réponse d'un outil :
Facultatif : le nom du lieu, l'adresse
```

```
Demande de position
Quand :
Texte du message (1 à 1 024 caractères) :
```

```
Carrousel à liens
Quand :
Texte du message (1 à 1 024 caractères) :
Cartes (2 à 10) : pour chacune, une image (adresse), un texte (1 à 160 caractères), l'adresse du bouton,
le libellé du bouton (1 à 20 caractères)
```

```
Carrousel à réponses
Quand :
Texte du message (1 à 1 024 caractères) :
Cartes (2 à 10) : pour chacune, une image (adresse), un texte (1 à 160 caractères), le libellé du bouton
(1 à 20 caractères)
```

La ligne « Quand : » de chaque canevas est le champ « Quand l'envoyer » de la fiche ; le reste pré-remplit le
contenu. Les limites des canevas sont celles du guide de Meta ; elles ne sont pas contrôlées au caractère près (le contenu
peut venir d'un outil), elles guident la rédaction. Le contenu dynamique s'écrit en clair : « une ligne par créneau
rendu par l'outil `creneaux_libres` ».

**Le banc « Tester »** ne montre pas un message interactif : `agent_test` ne rend que du texte. L'onglet le dit
(« Les messages interactifs ne s'affichent pas ici : essayez-les sur WhatsApp avec un numéro de la liste »), sans
quoi un client conclurait qu'ils ne marchent pas.

**Le diff de l'assistant** sait afficher les trois opérations neuves : type et formulaire en clair, consigne en
entier.

L'accès suit l'offre : l'agent de Meta étant réservé au Pro et à l'Entreprise (lot 6), l'onglet l'est aussi, sans
règle de plus.

## 9. Ce qui ne change pas (rayon de souffle)

- **Qui tient la conversation** : rien ne touche `thread_control`, la liste de l'agent ni `control_owner`. Un clic
  du client arrive en `standby` et reste à l'agent.
- **Les automations et les scénarios** ignorent un `standby` (`src/webhooks/inbound.ts`) : un client qui touche
  « Réserver » sur un bouton de l'agent ne déclenche pas une automation dont le mot-clé serait « Réserver ». Un test
  le garde.
- **La réponse d'un formulaire** ouvert par l'agent arrive en `standby` avec `nfm_reply`, déjà lue par `contentOf`. Son
  écriture sur la fiche du contact se constate à l'essai réel (§13), elle n'est pas supposée.
- **Les outils maison** « Envoyer un bloc » et « Lancer un scénario » ne bougent pas.
- **Ce qui suppose l'ancien comportement des échos** : `recordAgentMessage` ne recevait que du texte ; il reçoit
  désormais aussi le texte rendu par `texteDeLEcho`. Ses lecteurs (aperçu de l'Inbox, historique de l'agent IA,
  analyse des conversations, traduction) lisent ce corps comme du texte : à relire un par un dans le plan.

## 10. Hors du lot

- Le correctif du modèle à bouton lien refusé par « Envoyer un bloc » (`src/workflow/engine.ts:281`), décision à part.
- Le plafond de 20 contacts sur la liste de l'agent (tâche séparée ouverte le 2026-10-07).
- Une action « Prévenir l'agent de Meta » par `agent_event` depuis un webhook entrant.
- Tout paiement dans la conversation.
- Une copie locale des messages interactifs, une recherche, un import en masse.

## 11. Ce qui se mesure avant d'écrire (étape 0 du plan)

Sur le numéro de test, avec un contact sur la liste, par appels directs :

1. Créer un message interactif de chaque type, déclencher chacun dans une vraie conversation, lire les échos dans
   `webhook_events` : leur forme réelle fait les fixtures du §6.
2. Les longueurs maximales réelles de `title` et d'`instruction` : un essai long, lire le refus. Les bornes de Zod
   (route et assistant) reprennent la mesure ; sans refus jusqu'à 4 000 caractères, la consigne est bornée à 4 000
   (`MAX_TEXTE` de l'assistant) et le titre à 200.
3. La forme d'erreur d'un `flow_id` en brouillon créé `enabled`, et d'un `flow_id` sur un autre type : le message lu
   à l'écran en dépend.
4. Ce que rend `agent_test` quand un message interactif devrait partir (texte vide, `quick_replies`, rien) : la phrase
   de l'onglet « Tester » en dépend.

## 12. Découpage, méthode de livraison et ordre de déploiement

**Méthode de livraison : implémenteur par lot et revue humaine du diff.** La lecture des échos se trouve sur le
webhook de chaque conversation de l'agent de Meta, donc sur un chemin que la production emprunte ; l'écran et
l'assistant écrivent la configuration d'un agent en service.

| Livraison | Contenu | Relecture |
| --- | --- | --- |
| 0 | Les mesures du §11, consignées dans `docs/MBA-API-REFERENCE.md` avec le relevé daté de la doc de Meta | aucune, c'est une mesure |
| A, serveur | client, validation, routes et historique, garde de suppression d'un formulaire, `texteDeLEcho`, assistant (opérations, inventaire, application, schéma dérivé) | une relecture en fin de lot |
| B, console | renommage en Consignes, onglet Messages interactifs, canevas, phrase du banc Tester, diff de l'assistant, `features.md` et fiche d'aide avec empreinte | une relecture en fin de lot |

**Ordre** : A déployée (API et les deux workers, aucune migration) AVANT de pousser B, puisque Vercel publie la console
au push et que l'écran appelle des routes neuves. Le renommage seul n'appelle rien de neuf, mais il part avec B.

## 13. Les tests attendus

- **Client** : chemins, en-tête de version, lecture `safeParse` d'une réponse, pagination jusqu'à l'absence de
  `next`.
- **Validation** : `flow_id` requis pour `flow`, refusé ailleurs ; type hors des neuf refusé.
- **Routes** : écriture refusée à un non-administrateur, ligne d'historique pour chaque écriture, `flow_id` d'un
  formulaire d'un autre espace refusé, `flow_id` en brouillon refusé ; `tests/scope-tenant.test.ts` couvre les routes
  neuves sans rien y ajouter (il les dérive).
- **Suppression d'un formulaire** : 409 qui nomme le message, 503 si Meta ne répond pas, aucun appel sans agent.
- **`texteDeLEcho`** : un cas par type sur les payloads mesurés, plus le type inconnu.
- **Standby** : un `button_reply` en `standby` ne déclenche aucune automation à mot-clé égal.
- **Assistant** : les trois opérations, le `refine` du formulaire, le refus d'un formulaire inconnu à l'application,
  la parité des bornes entre Zod et le schéma annoncé.
- **Console** : un canevas par type (pur), l'onglet en e2e (créer, basculer, supprimer), et les e2e existants qui
  cherchent « Compétences » ou « Skills » par texte mis à jour (`web/e2e/mba-skills.spec.ts`,
  `mba-parametres-overview.spec.ts`, `support/mba.ts`), lancés en local avant de pousser.
- **Auto-attaque** (`npm run auto-attaque`) lancée en local avant de pousser A.

Chaque test de non-régression se vérifie dans les deux sens.

## 14. L'essai réel qui clôt

Sur le numéro de test, contact sur la liste, depuis la console de production :

1. Créer quatre messages interactifs : boutons de réponse, liste, bouton lien, formulaire publié.
2. Mener une conversation sur le téléphone qui déclenche chacun : il arrive, il s'affiche dans l'Inbox avec ses
   boutons, ses lignes ou son lien.
3. Toucher un bouton, une ligne, remplir le formulaire : l'agent poursuit en tenant compte du choix, et la réponse du
   formulaire est sur la fiche du contact.
4. Demander à l'assistant d'ajouter un message interactif : le diff s'affiche, l'application passe, la ligne est dans
   l'Historique.
5. Tenter de supprimer le formulaire utilisé : refus qui nomme le message.

Tant que ces cinq points n'ont pas été vus sur l'écran et le téléphone, le lot n'est pas fini, quels que soient les
tests.
