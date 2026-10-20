# Campagnes depuis Claude (design)

Cadré avec Julien le 2026-10-20, en rondes de questions. Réponse à Kanal, dont le MCP « V2 » annonce : « Analyse mon
inbox de la semaine, crée un segment des paniers abandonnés et prépare la campagne », « rien ne part sans votre
confirmation ».

## Pourquoi

Un client écrit une phrase à son assistant (Claude, Claude Code, Codex, Lovable, tout client MCP) et obtient une
campagne WhatsApp prête à partir, ciblée sur ce que ses clients ont vraiment dit. Notre avantage sur Kanal, à garder
visible : l'analyse est DÉJÀ faite, conversation par conversation (intention, sentiment, satisfaction, urgence,
sujet), là où leur assistant relit l'inbox à chaque demande.

**Succès** : la phrase de l'exemple ci-dessous marche de bout en bout sur un espace Pro, et la page de cas et son film
peuvent la montrer telle quelle.

## Le parcours (l'exemple qui fait foi)

« Analyse mon inbox de la semaine et prépare une campagne pour les clients qui se sont plaints d'un retard de
livraison, envoi demain 10 h. »

1. **Le thème** : `get_conversation_insights` (Entreprise) donne « retard de livraison : 38 conversations » ; sans
   lui, l'assistant lit les conversations (`list_conversations`, `get_messages`).
2. **Le segment** : l'assistant pose l'étiquette `retard-livraison-oct` sur ces 38 contacts. Un segment EST une
   étiquette (décision de Julien) : aucun objet « segment » neuf, conforme à la règle du dépôt (pas de segments
   avancés).
3. **Le brouillon** : l'assistant prépare la campagne (cible : l'étiquette ; un modèle approuvé ; demain 10 h,
   heure de Paris) et répond par un récapitulatif : contacts ciblés, combien partiront, combien seront écartés et
   pourquoi (pas de consentement marketing, STOP, limite de l'offre), **cinq noms** pour vérifier (décision de
   Julien), le coût estimé, la date, et un code de confirmation.
4. **Le lancement**, aux deux endroits (décision de Julien) : dans l'assistant, après le « oui » de la personne, avec
   le code ; ou dans la console, sur le brouillon, bouton « Lancer » qui existe déjà.

Le thème qui n'est pas un champ filtrable (le sujet est un texte libre, non filtrable depuis la décision 12 du
chantier « Tout sur la fiche ») se fait par l'étape 2 : l'assistant lit et étiquette (décision de Julien). Rendre le
sujet filtrable est un autre chantier.

## Ce qui existe et que le lot réutilise, sans le dupliquer

- Lecture de l'inbox par le MCP (`list_conversations`, `get_conversation`, `get_messages`, sans fonction : Free).
- `get_conversation_insights` (fonction `analyse` : Entreprise) ; `search_contacts` et la dernière analyse de chaque
  fiche ; `tag_conversation` (fonction `inbox` : Pro) ; `list_templates`, `create_template`, `get_template_status`.
- Le ciblage de la console : `BulkTarget` (étiquettes, et les champs d'analyse par `fieldFilters`, une seule
  sémantique tenue par `src/crm/filtre-fiche.ts` et `tests/filtre-fiche.test.ts`).
- L'action en masse du mini-CRM (`POST /tenants/:tenantId/contacts/bulk`, plafond des opérations coûteuses), qui
  n'émet AUCUN événement d'automation (règle du dépôt : aucun chemin de masse n'émet).
- La campagne complète non lancée (`campaigns.status = 'draft'`, à ne pas confondre avec `campaign_drafts`, l'état
  d'un formulaire), sa programmation (`scheduled`), son lancement (`/campaigns/:id/run`), ses garde-fous
  (`src/campaign/guardrails.ts` : le marketing exige l'opt-in, STOP bloque tout), le plafond de destinataires, la
  préparation (`src/http/preparation-campagne.ts`) et le chiffrage (`src/stats/chiffrage.ts`).
- Les annotations MCP : une écriture porte `destructiveHint: true`, ce qui fait demander l'accord de la personne par
  le client avant l'appel.
- Le refus par offre : un outil hors offre reste listé et refuse avec le lien de l'offre.

## Les quatre outils neufs

1. **`find_contacts`** (lecture) : les contacts d'une cible, sous la même forme que le ciblage de la console :
   étiquettes (toutes ou l'une), période du dernier message reçu, consentement ; et, en Entreprise seulement, les
   champs d'analyse (intention, sentiment, satisfaction, urgence, résolue). Rend le nombre total et au plus 100
   contacts (identifiant, nom, numéro, étiquettes, dernière analyse si l'offre l'ouvre).
2. **`tag_contacts`** (écriture) : pose une ou plusieurs étiquettes sur tous les contacts d'une cible (mêmes
   filtres) ou sur une liste d'identifiants. Passe par l'action en masse existante : plafond des opérations coûteuses,
   aucune émission d'événement. Rend le nombre de contacts étiquetés.
3. **`prepare_campaign`** (écriture, n'envoie rien) : crée la campagne complète NON lancée, visible dans la console
   comme brouillon : cible (étiquettes ou filtres), modèle approuvé et ses variables, maintenant ou à une date
   (décision de Julien : la date est dans le premier lot), même validation que la console. Rend le récapitulatif de
   l'étape 3, avec un code de confirmation.
4. **`launch_campaign`** (écriture) : lance (ou programme) la campagne préparée, par le même chemin que le bouton de la
   console. Exige le code du récapitulatif.

**Le code de confirmation** : six caractères, à usage unique, valable 30 minutes, lié à la campagne ET à son état au
moment du récapitulatif. Toute modification du brouillon (cible, modèle, date) l'invalide : on ne lance jamais autre
chose que ce que la personne a vu. ⚠️ L'assistant lit ce code dans la réponse de l'outil : il n'empêche pas, à lui
seul, un assistant de lancer sans demander. Ce qui garantit le « oui » humain, c'est l'annotation `destructiveHint`
(le client demande l'accord avant l'appel), la consigne de l'outil (montrer le récapitulatif, attendre la réponse) et
le chemin de la console pour qui veut un clic. Le code garantit l'autre moitié : que le lancement porte sur
exactement ce qui a été montré.

## Les offres (décisions de Julien)

| | Free | Pro | Entreprise |
|---|---|---|---|
| Lire l'inbox, statistiques brutes, envoyer par l'API (1 000 messages par mois) | oui (inchangé) | oui | oui |
| `find_contacts` (étiquettes, période, consentement), `tag_contacts`, `prepare_campaign`, `launch_campaign` | listés, refusent avec le lien | oui | oui |
| Filtres d'analyse dans `find_contacts` et la cible, thèmes (`get_conversation_insights`) | refus | refus avec le lien | oui |

## Ce qui ne bouge pas

Le consentement (marketing : opt-in seulement ; STOP : rien), les limites de Meta, le plafond de destinataires, le
plafond des opérations coûteuses, l'isolation par espace (`tenant_id` sur chaque requête), le rôle (une écriture est
réservée à un admin, comme dans la console), le prix (une campagne depuis l'assistant coûte ce qu'elle coûte depuis
la console).

## Hors du lot

Le sujet filtrable ; un objet « segment » enregistré ; l'A/B testing ; une campagne RCS ou scénario depuis
l'assistant (le lot ne prépare que des campagnes WhatsApp de modèle) ; la page de cas et son film (après le lot, une
fois l'essai réel fait).

## Les choix de Claude après la relecture « constructeur » (2026-10-20, à valider par Julien en lisant)

La relecture a montré que l'existant ne fait pas tout ce que les sections ci-dessus supposaient. Ces choix le
corrigent ; ils priment sur le texte plus haut là où ils le contredisent.

1. **La date** : un brouillon n'a pas de date aujourd'hui, elle se pose au lancement. `prepare_campaign` la range sur
   le brouillon (une colonne neuve, nullable, migration AVANT le code) sans le programmer ; `launch_campaign` le
   programme à cette date. Dans la console, un brouillon daté montre sa date et son bouton devient « Programmer pour
   … » au lieu de « Lancer » : sinon, qui a vu « demain 10 h » dans l'assistant enverrait tout de suite depuis la
   console.
2. **Re-préparer** : un brouillon ne se modifie pas (destinataires figés à la création). Changer la cible, le modèle
   ou la date, c'est préparer à nouveau : `prepare_campaign` accepte l'identifiant du brouillon qu'il remplace et le
   supprime, s'il n'a jamais été lancé et vient de l'assistant. Un code expiré se renouvelle de la même façon.
3. **Le quota quotidien des modèles de l'API** (`modelesJour`) ne s'applique pas : une campagne lancée depuis
   l'assistant compte comme une campagne de la console (Pro : envois illimités). Ce qui borne l'envoi de masse :
   l'offre Pro, le rôle admin, l'accord demandé par le client (`destructiveHint`), le code, le plafond de
   destinataires et celui des opérations coûteuses.
4. **La catégorie** (marketing ou service) n'est PAS choisie par l'assistant : elle vient de la catégorie du modèle
   chez Meta, la plus stricte des deux si elles diffèrent, comme le fait déjà `POST /v1/sends`. Un modèle
   MARKETING ne part qu'aux contacts qui ont consenti.
5. **Le coût** : pas de montant en euros avant le lancement, comme la console l'a décidé (`EtapeRecap.tsx` : un
   montant affiché à côté du bouton qui envoie serait cru). Le récapitulatif dit le VOLUME : « jusqu'à N messages
   facturables par Meta ».
6. **La période du dernier message reçu** sort du premier lot : `find_contacts` et la cible n'ont que les critères
   du ciblage existant (étiquettes, consentement, et en Entreprise les champs d'analyse, dont la date de la dernière
   analyse). Pas de second analyseur de cible : le MCP passe par `parseBulkTarget`.
7. **Désigner les contacts d'un thème** : `get_conversation_insights` ne rend que des agrégats. Le lot étend
   `list_conversations` (l'identifiant du contact, une période, le curseur que le store a déjà) et `tag_contacts`
   accepte des identifiants de conversations ou de contacts. L'assistant lit les conversations de la période et
   étiquette celles qui parlent du thème ; le premier lot vise quelques centaines de conversations par passage.
8. **Le modèle approuvé** : `preparerCampagne` ne le vérifie pas aujourd'hui. `prepare_campaign` vérifie qu'il
   existe, qu'il est approuvé et lit sa catégorie (point 4) avant de créer le brouillon.
9. **La fonction d'offre** : les campagnes de la console ne sont gardées que par `console`. Les quatre outils sont
   gardés par une fonction du Pro (le constructeur choisit `scenarios` ou en ajoute une), les filtres d'analyse par
   `analyse`.

## Laissé au constructeur

Les noms exacts des paramètres, la forme du récapitulatif, le stockage du code de confirmation (une table, ou une
colonne de la campagne), le choix de la fonction d'offre qui ouvre les quatre outils en Pro (celle des campagnes
dans la console), le nombre maximal d'identifiants de `tag_contacts`.
