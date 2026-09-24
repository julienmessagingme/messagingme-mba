import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE `/v1/sends`, LU DANS `src/index.ts`.
 *
 * 🔴 POURQUOI UN TEST DE SOURCE. Une flèche à moins de paramètres est assignable à un contrat qui en déclare
 * plus : `(tenant, key) => store.claim(tenant, key, 'x')` ou `(t, id, consent) => appliquerConsentement(…,
 * 'api')` compileraient et avaleraient l'empreinte ou la source du consentement, en silence. Même famille que
 * `tests/workflow-cablage-categorie.test.ts` et `tests/campagne-cablage.test.ts`.
 */
const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const source = sansCommentaires('../src/index.ts');

describe('câblage de /v1/sends', () => {
  it('🔴 l’empreinte du corps atteint le magasin d’idempotence', () => {
    expect(source).toMatch(/idempotencyClaim: \(tenant, key, empreinte\) => idempotencyStore\.claim\(tenant, key, empreinte\)/);
  });

  it('🔴 la SOURCE du consentement atteint l’écriture', () => {
    expect(source).toMatch(/appliquerConsentement: \(tenant, contactId, consent, source\) => appliquerConsentement\(depsConsentement, tenant, contactId, consent, source\)/);
  });

  it('🔴 le consentement a UNE construction, partagée avec `/v1/contacts` : `depsConsentementDe`, des deux côtés', () => {
    expect(source).toMatch(/const depsConsentement = depsConsentementDe\(contactStore, auditSink\)/);
    expect(sansCommentaires('../src/api/contacts-v1.ts')).toMatch(/depsConsentementDe\(deps\.contacts, deps\.audit\)/);
  });

  it('🔴 la résolution de fiche lit le MÊME dépôt que `/v1/contacts`, et ses quatre paramètres passent', () => {
    expect(source).toMatch(/resoudreFiche: \(tenant, cles, o\) => resoudreFiche\(contactStore, tenant, cles, o\)/);
  });

  it('🔴 la catégorie d’un template est lue chez Meta, avec la langue DEMANDÉE', () => {
    expect(source).toMatch(/verdictModele\(await workflowRuntime\.templateVarInfo\(tenant, name, language\), language\)/);
  });

  it('les contacts de l’API sont lus par la lecture qui garde les bloqués', () => {
    expect(source).toMatch(/listContactsPourEnvoi: \(tenant, ids\) => repo\.listContactsPourEnvoiApi\(tenant, ids\)/);
  });
});

describe('câblage de /v1/templates', () => {
  it('🔴 la liste des templates chez Meta passe par un cache d’UNE minute, par espace et par WABA', () => {
    // Sans lui, un intégrateur qui boucle sur `GET /v1/templates` relit la liste COMPLÈTE chez Meta à chaque
    // appel, épuise le quota de l'API de gestion du WABA, et le refus pris pour une panne d'authentification
    // invaliderait le jeton du WABA, donc bloquerait les envois de l'espace. Un échec de Meta n'est jamais
    // gardé : c'est la promesse de `cacheCourt` (`tests/cache-court.test.ts`).
    expect(source).toMatch(/const catalogueTemplatesCache = cacheCourt<TemplateSummary\[\]>\(60_000\)/);
    expect(source).toMatch(/templates: async \(tenant\) => \{\s*const waba = await repo\.getTenantWabaId\(tenant\);\s*if \(!waba\) return \[\];\s*return catalogueTemplatesCache\.lire\(`\$\{tenant\}:\$\{waba\}`, async \(\) => \(await metaFactory\.templateClientForTenant\(tenant\)\)\.list\(waba\)\);/);
  });
});
