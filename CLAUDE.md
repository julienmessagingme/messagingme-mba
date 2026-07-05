# CLAUDE.md — messagingme-mba

**Produit :** console SaaS plug-and-play qui déploie et pilote la stack native Meta pour
WhatsApp (Cloud API + Marketing Messages API/MM Lite + Meta Business Agent) pour des clients.
Pitch : « Envoie des campagnes WhatsApp qui se répondent toutes seules. »

**Cadrage produit (source de vérité) :** `messagingme-pilot/docs/PROJET-MBA-CONSOLE.md`
(+ `META-BUSINESS-AGENT-API.md` pour la référence API). Ce repo = l'implémentation.

## Commandes

```bash
npm install          # deps
npm run dev          # API en watch (Fastify, receiver webhooks)
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/
```

## Docs du repo (séparation stricte)

- [documentation.md](documentation.md) — technique : archi, stack, schéma DB, env, patterns
- [features.md](features.md) — fonctionnel : les features vues utilisateur, statut
- [wip.md](wip.md) — ce sur quoi on bosse maintenant
- [todo.md](todo.md) — backlog (dont le plan des boucles feature-loop)

## Règles spécifiques au projet

- **Construction par briques via `feature-loop`** : une boucle par brique testable (voir
  `todo.md`). Le scaffold + le schéma DB sont posés en direct ; les briques déterministes
  (receiver, wrapper API, contacts, campagnes) passent par des boucles plan → exécute →
  vérifie → reviewer. L'UI (inbox/dashboard) n'est PAS pour feature-loop.
- **On vérifie contre des mocks des contrats Meta + des tests**, pas contre le Meta live tant
  qu'on n'a pas de numéro branché. La validation end-to-end se fait en live plus tard.
- **Pas de tirets longs** dans la doc (« — » / « – » interdits).
- Git : rester sur `main`, committer sur `main`, push `origin`.
- **Discipline anti-tailor-made** : pas de flow builder, pas de nodes, inbox minimal borné.
  Voir la liste « on ne construit PAS » du cadrage.
