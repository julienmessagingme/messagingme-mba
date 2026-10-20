# Les champs depuis Claude : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** trois outils MCP, `list_fields`, `create_field` et `set_contact_field`, pour que l'assistant connaisse les
champs personnalisés d'un espace (les variables de `prepare_campaign` peuvent en venir), en crée, et en remplisse sur une
cible de contacts.

**Architecture :** aucune logique neuve. `list_fields` lit le référentiel comme `GET /v1/fields` ; `create_field` appelle
`creerChamp` (`src/http/fields.ts`), celle de l'écran Contenu et de `POST /v1/fields` ; `set_contact_field` reprend
l'action en masse « définir un champ » du mini-CRM (`defPourEcriture`, exportée de `src/http/contacts.ts`,
`validateFieldValue`, `canonicalizeFieldValue`, `applyEditsMany`) sur la cible de `src/mcp/cible.ts`.

**Spec :** demande de Julien du 2026-10-20 (« oui les trois, remplir un champ aussi »), à la suite du lot « Campagnes
depuis Claude » (`docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md`).

## Global Constraints

- `list_fields` : `mcp:read`, fonction `null` (comme l'API). `create_field` : `mcp:write`, `exigePersonne`, fonction
  `null` (l'API le permet dans toutes les offres). `set_contact_field` : `mcp:write`, `exigePersonne`, fonction `console`
  (une action en masse, comme `tag_contacts`), plafond des opérations coûteuses, aucune émission d'automation.
- Les types d'un champ sont ceux de `isUserFieldType` (text, number, date, datetime, boolean, url), annoncés dans le schéma.
- Une cible de `set_contact_field` n'est jamais vide (`lireCibleMcp`).

## Review Focus

1. Un champ inconnu de l'espace : refusé, rien n'est écrit (sauf un champ de base, créé comme dans la console).
2. Une valeur qui ne colle pas au type (« abc » dans un nombre) : refusée avant toute écriture.
3. Un libellé qui imite un champ de base (« Nom », « Téléphone ») : refusé comme dans la console.

## Méthode de livraison

**En direct, sans agent**, parce que le lot est petit, isolé et réversible : trois outils qui appellent des fonctions
déjà en production, sans migration ni route neuve ; une relecture indépendante en fin de lot, comme chaque lot, qui
relit aussi les jaunes du lot des campagnes corrigés ici.

**L'essai réel qui clôt** : depuis Claude Code sur un espace de test, « crée un champ Ville », « mets Lyon dans la ville
des contacts étiquetés test », puis « liste les champs » ; vérifier la fiche dans la console, puis préparer une campagne
dont une variable vient de ce champ.

### Tâche 1 : les trois outils

**Fichiers :** créer `src/mcp/outils-champs.ts` ; modifier `src/mcp/outils.ts` (spread, `DepsMcp`), `src/http/contacts.ts`
(exporter `defPourEcriture`), `web/lib/partage/catalogue-mcp.ts`, `web/lib/mcp-outils.ts`, `src/index.ts` (câblage, annoncé),
`tests/routes-inertes.ts` et les montages MCP ; tests `tests/mcp-champs.test.ts`.

- [ ] Tests : `list_fields` rend clé, libellé, type ; `create_field` refuse un type inconnu, un libellé de champ de base,
      une clé existante, et une clé d'API ; `set_contact_field` refuse un champ inconnu, une valeur hors type, une cible
      vide, compte le plafond AVANT l'écriture et appelle `applyEditsMany` avec la valeur canonique. Rouges, puis verts.
- [ ] Doc : `documentation.md` (l'item du MCP), `features.md`, doc Markdown régénérée (`npm run doc:md` dans `web/`).

### Tâche 2 : les jaunes de la relecture des campagnes (2026-10-20)

**Fichiers :** `src/mcp/cible.ts`, `src/mcp/outils-campagnes.ts`, `src/inbox/store.pg.ts` ; tests des outils voisins.

- [ ] `contact_ids` qui ne désignent aucun contact de l'espace : refusés par `lireCibleMcp` (résolus par
      `contactIdsForTarget`), au lieu d'un « 0 » silencieux (constat 2).
- [ ] `prepare_campaign` sans `phone_number_id` sur un espace à plusieurs numéros : refusé avec la liste ; le numéro
      choisi figure au récapitulatif (constat 3).
- [ ] Le récapitulatif boucle : un poste `other` (bloqués, supprimés, sans numéro, doublons) et, quand l'offre en a une,
      la marge des modèles du mois (constat 4).
- [ ] `replaced.deleted` faux : dit dans la réponse (constat 5) ; un brouillon sans aucun destinataire : supprimé et
      refusé avec ses motifs (constat 6).
- [ ] `contactIdsDesConversations` remonté au-dessus de la doc de `listConversations` (constat 7).
- [ ] Suite racine, suite console, typecheck, auto-attaque ; une relecture du lot ; push ; déploiement de l'API ; essai réel.
