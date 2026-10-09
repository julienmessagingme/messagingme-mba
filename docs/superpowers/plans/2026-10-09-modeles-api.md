# Lot 13, domaine 3 : les modèles par l'API et par Claude

Spec : `docs/superpowers/specs/2026-10-08-api-complete-design.md` § 5 (décisions de Julien du 2026-10-09).

## Méthode de livraison

Implémenteur par lot, puis UNE relecture par livraison : la création soumet des modèles chez Meta au nom du client, la
route de la console est réécrite pour partager son chemin, et le serveur télécharge une adresse saisie par un client
(SSRF). Aucune migration en A et en B.
L'essai réel qui clôt A : avec une clé `templates:write` de l'espace d'essai, créer par curl un modèle utility avec une
image d'en-tête donnée par URL, le suivre par `GET /v1/templates/{name}` jusqu'à APPROVED, le voir dans l'écran Modèles,
puis demander à Claude d'en créer un second. B se clôt en demandant à Claude d'envoyer ce modèle à un téléphone de test ;
C en recevant `template.status_changed` sur une adresse webhook de test.

## Livraison A : créer et suivre

1. **La validation** `src/api/modele-meta.ts` : un schéma Zod strict du corps de Meta (nom `^[a-z0-9_]{1,512}$`, langue
   de la liste WhatsApp, catégorie `UTILITY`/`MARKETING` en casse libre, `parameter_format` `POSITIONAL` toléré ;
   composants HEADER texte sans variable ou média avec `example.header_url`, BODY obligatoire avec
   `example.body_text`, FOOTER, BUTTONS réponse rapide ou lien), bornes de Meta, et la traduction vers
   `CreateTemplateInput`. Tests : chaque forme acceptée, chaque borne et chaque hors-lot refusé avec son champ.
2. **L'en-tête par URL** `src/api/entete-par-url.ts` : texte de l'hôte (`urlRecuperable`), résolution
   (`resolutionPublique`), `fetchPublic` sans suivre de redirection, délai borné, `lireOctetsBornes` (image 5 Mo, vidéo
   et document 16 Mo), type décidé par la signature des octets (JPEG ou PNG, MP4, PDF), puis le dépôt chez Meta (le
   `uploadImage` de la console). Tests : chaque refus nommé ; les deux inventaires de `tests/lib-adresse-privee.test.ts`
   le comptent.
3. **La création partagée** `creerUnModele` (`src/http/templates.ts`) : les gardes de la console (champs des liens,
   compte WhatsApp, flow publié, liens tracés) en une fonction, que la route de la console appelle sans changer de
   comportement. `MetaTemplateClient.create` rend aussi la catégorie (Meta peut reclasser) ;
   `MetaTemplateClient.statutsDuNom` lit les langues d'un nom avec le motif de refus. Tests : ceux de la console
   restent verts, le client lu sur un faux `fetch`.
4. **Les routes** `src/http/v1-templates.ts`, sous `templates:write` : `POST /v1/templates` (201, refus de Meta en 422
   `meta_rejected`) et `GET /v1/templates/{name}` (404 `template_not_found`). Usage `templates.create` (lourde) et
   `templates.read`, hors quota du jour. Le droit dans la console (clés, référence) avec la parité des droits.
5. **Claude** : `create_template` (`mcp:write`), `get_template_status` et `list_templates` (`mcp:read`), ouverts à toutes
   les offres.
6. **La doc** : une page Modèles dans la doc API, les points d'entrée, l'exemple validé par `tests/api-exemples.test.ts` ;
   `features.md`, `documentation.md`.

## Livraison B : Claude envoie un modèle

Le cœur de `POST /v1/sends` (idempotence comprise) extrait en une fonction (`lancerEnvoi`) que la route et l'outil
`send_template_to_contact` (`mcp:write`, réservé à une personne comme `create_template`, un destinataire) appellent ;
les mêmes refus (STOP, modèles du mois, numéro délié ou suspendu). Tests : ceux de `/v1/sends` restent verts sans être
touchés, le corps construit par l'outil passe les règles de la route, l'outil rend ses refus avec leur code.

## Livraison C : l'événement

Lu le 2026-10-09 (lecture seule, accord de Julien) : l'application n'est PAS abonnée au champ
`message_template_status_update` ; Julien l'abonnera depuis le tableau de bord, sans risque avant le code. Une source
`template_status` dans `src/webhooks/parse.ts` (clé `tpl:<modèle>:<statut>:<instant>`), l'étape `processStatutsModeles`
(`src/webhooks/statuts-modeles.ts`) qui retrouve l'espace par son compte (`waba.id`), et la distribution d'un événement
d'espace (`distribuerEvenementEspace`, les mêmes adresses et le même gel que les signaux). Le type
`template.status_changed` entre au catalogue du lot 12, coché par défaut sur une adresse neuve. Tests : le découpage,
l'étape (redélivrance au même identifiant, compte inconnu, statut illisible), la distribution (type coché, limite de
l'offre, espace verrouillé), la parité de la page, et la lecture du compte en intégration.

## Ordre de déploiement

Aucune migration. ⚠️ La page des clés propose `templates:write` dès le push (Vercel) : une clé créée avec ce droit avant
le `up` de l'API serait refusée en 400. Fenêtre réduite : CI lue puis `up` de l'API et des deux workers dans la foulée.
