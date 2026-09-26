# Audit ponytail, lot 3 : câblage et contrôles d'accès

Choisi par Julien le 2026-09-25 (les trois lots de l'audit), ordre confirmé le 2026-09-26 : ce lot, puis les
correctifs du MFA. Source : l'audit ponytail du 2026-09-25 (rapport hors dépôt), section « LOT 3 ».

## Méthode de livraison

**Workflow multi-agents (cartographie, implémentation, relecture par angles), puis revue humaine du DIFF par
Julien avant tout déploiement**, parce que le lot déplace LE contrôle d'isolation entre espaces et le contrôle
de rôle de dizaines de routes : la production emprunte chaque ligne touchée, et un oubli ne se voit ni au
compilateur ni aux tests unitaires existants. Julien a demandé à relire ce diff lui-même. L'essai réel qui clôt
le lot est décrit en dernière section.

## Tâches

1. **A. Le contrôle d'espace devient une étape de montage.** Les ~240 `const tenant = scopeTenant(req); if
   (tenant === null) return reply.code(403)...` des modules `acces: 'tenant'` sont remplacés par une étape posée
   APRÈS la garde d'authentification de chaque route qui porte `:tenantId`, dans les seuls modules `tenant`
   (jamais `jeton-ops`, qui porte aussi des `:tenantId` et n'a pas de session). Le handler lit l'espace vérifié
   par un accesseur qui ÉCHOUE FERMÉ s'il manque. `scopeTenant` reste la seule règle.
2. **B. 55 `forbidNonAdmin` retirés**, seulement dans les modules dont TOUTES les routes sont montées derrière
   `g.admin` (`requireAdmin`), vérifié route par route à l'exécution, pas à la lecture. Ceux des modules montés
   sur `g.auth` ou `g.encadrement` restent.
3. **C. Les dépendances toujours câblées deviennent requises** (environ 70 `if (!deps.X) return 503|200`) ; les
   dépendances réellement conditionnelles restent optionnelles (transcription, traduction, HubSpot, `completer`,
   `fetchUrl`, et toute autre que le câblage de production ne fournit pas toujours).
4. **D. Idem pour les ~22 membres optionnels de `WorkflowExecutorDeps`** fournis par le seul `new WorkflowExecutor`
   de production ; les tests passent par des valeurs INERTES nommées (comme `jamaisDesabonne`), jamais par un
   contournement dans `src/`.

## Invariants à tenir (et à prouver)

- Une route tenant appelée avec une session d'un AUTRE espace rend 403, avant et après, pour CHAQUE route :
  preuve dynamique qui monte tous les modules et appelle chaque route `:tenantId` avec une session étrangère.
- Une route admin appelée par un agent rend 403 avec le même corps qu'avant.
- La table de routes (méthode, chemin, ordre) est identique avant et après.
- Aucun code HTTP ni message d'erreur ne change pour un appelant légitime.
- `tests/scope-tenant.test.ts` reste la garde, renforcée, jamais affaiblie.

## Tests attendus

- La preuve dynamique d'isolation ci-dessus, vérifiée dans les deux sens (étape retirée : elle échoue).
- Une preuve dynamique de rôle sur les routes dont on retire `forbidNonAdmin` (session d'agent : 403).
- `npm run auto-attaque -- --cible=local` : aucune trouvaille.
- CI verte, job `integration` compris.

## Ordre de déploiement

Aucune migration, aucune route neuve : l'API seule, après la revue de Julien et la CI. La console ne bouge pas.

## Essai réel qui clôt le lot

Après le `up` : une sonde dans le conteneur signe une session d'un espace A et appelle en lecture une route
d'un espace B (403 attendu), puis la même route de A (200) ; Julien navigue dans la console en admin, et un
agent ouvre l'Inbox.
