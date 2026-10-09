import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * LE CÂBLAGE DE `/v1/sends`, LU DANS `src/index.ts`.
 *
 * 🔴 POURQUOI UN TEST DE SOURCE. Une flèche à moins de paramètres est assignable à un contrat qui en déclare
 * plus : `(tenant, key) => store.claim(tenant, key, 'x')` ou `(t, id, consent) => appliquerConsentement(…,
 * 'api')` compileraient et avaleraient l'empreinte ou la source du consentement, en silence. Même famille que
 * `tests/campagne-cablage.test.ts`.
 */
const sansCommentaires = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const source = sansCommentaires('../src/index.ts');
/** Le bloc des envois de `/v1/sends` (`depsEnvois`, partagé avec Claude), du template lu chez Meta jusqu'au serveur. */
const envois = source.slice(source.indexOf('lireModele: async (tenant, name, language)'), source.indexOf('  const app = buildServer({'));

describe('câblage de /v1/sends', () => {
  it('🔴 l’empreinte du corps atteint le magasin d’idempotence', () => {
    // Le magasin passe tel quel : aucune flèche intermédiaire ne peut avaler l'empreinte, et la route l'appelle
    // avec ses trois arguments.
    expect(envois).toMatch(/\bidempotence: idempotencyStore,/);
    // Le cœur (`lancerEnvoi`) prend l'empreinte du corps brut, et la route lui passe le corps de la requête.
    const sends = sansCommentaires('../src/http/v1-sends.ts');
    expect(sends).toMatch(/deps\.idempotence\.claim\(tenantId, idem\.cle, empreinteCorps\(brut\)\)/);
    expect(sends).toMatch(/lancerEnvoi\(\s*deps, req\.auth\.tenantId, req\.body, req\.headers\['idempotency-key'\],/);
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

  it('🔴 le numéro délié est lu par la garde de CE process, celle dont « Délier » et « Relier » vident le cache', () => {
    // Une autre instance (ou une lecture sans cache recopiée ici) ne serait pas vidée par le geste : l'API
    // refuserait encore quelques secondes après « Relier », ou accepterait après « Délier ».
    expect(envois).toMatch(/\bnumerosDelies: gardeNumeroDelie,/);
    // La garde est celle du socle de ce process : la même instance que la fabrique Meta, et que les routes
    // Délier et Relier vident. Aucune seconde construction dans l'API.
    expect(source).toMatch(/\bgardeNumeroDelie,[\s\S]*?\} = construireSocle\(\{ pool, queue, config \}\)/);
    expect(source).not.toMatch(/creerGardeNumeroDelie\(/);
    expect(sansCommentaires('../src/socle.ts')).toMatch(/const gardeNumeroDelie = creerGardeNumeroDelie\(/);
    expect(sansCommentaires('../src/socle.ts')).toMatch(/\bnumerosDelies: gardeNumeroDelie,/);
  });

  it('les contacts de l’API sont lus par la lecture qui garde les bloqués', () => {
    expect(envois).toMatch(/\brepo,/);
    expect(sansCommentaires('../src/http/v1-sends.ts')).toMatch(/deps\.repo\.listContactsPourEnvoiApi\(/);
  });
});

describe('câblage de /v1/templates', () => {
  it('🔴 la liste des templates chez Meta passe par un cache d’UNE minute, par espace et par WABA', () => {
    // Sans lui, un intégrateur qui boucle sur `GET /v1/templates` relit la liste COMPLÈTE chez Meta à chaque
    // appel, épuise le quota de l'API de gestion du WABA, et le refus pris pour une panne d'authentification
    // invaliderait le jeton du WABA, donc bloquerait les envois de l'espace. Un échec de Meta n'est jamais
    // gardé : c'est la promesse de `cacheCourt` (`tests/cache-court.test.ts`).
    expect(source).toMatch(/const catalogueTemplatesCache = cacheCourt<TemplateSummary\[\]>\(60_000\)/);
    // Une seule lecture, `listerModeles`, partagée par le catalogue et l'outil `list_templates` (lot 13, domaine 3).
    expect(source).toMatch(/const listerModeles = async \(tenant: string\): Promise<TemplateSummary\[\]> => \{\s*const waba = await repo\.getTenantWabaId\(tenant\);\s*if \(!waba\) return \[\];\s*return catalogueTemplatesCache\.lire\(`\$\{tenant\}:\$\{waba\}`, async \(\) => \(await metaFactory\.templateClientForTenant\(tenant\)\)\.list\(waba\)\);/);
    expect(source).toMatch(/catalogues: \{\s*templates: listerModeles,/);
    expect(source).toMatch(/modeles: \{ \.\.\.creationModeles, lister: listerModeles \}/);
    // 🔴 Le téléchargement de l'en-tête est la voie GARDÉE (inventoriée par `tests/lib-adresse-privee.test.ts`) : un
    // `fetch` nu injecté ici échapperait à l'inventaire, `DepsCreationModele` acceptant n'importe quel téléchargeur.
    // Livraison B : Claude envoie par le MÊME cœur que `POST /v1/sends`, sur les MÊMES dépendances.
    expect(source).toMatch(/sends: depsEnvois,/);
    expect(source).toMatch(/envoyerModele: \(tenant, corps, compter\) => lancerEnvoi\(depsEnvois, tenant, corps, undefined, compter\),/);
    expect(source).toMatch(/telechargerEntete: telechargerEnteteProduction,\s*deposerEntete: \(octets, mime\) => mediaClient\.uploadImage\(octets, mime\),\s*placesEntete: placesDeTelechargement,/);
  });
});

describe('câblage de l’envoi RCS libre (bouton de l’Inbox et /v1/messages/rcs)', () => {
  it('🔴 le bouton RCS de l’Inbox passe l’origine `humain`, jamais `api`', () => {
    // `envoyerRcsLibre` décide des gardes sur son dernier argument : `api` soumettrait l'OPÉRATEUR au
    // consentement, au STOP général et au cache de joignabilité, à rebours de la spec (§ 17, le bouton reste
    // identique). Les deux valeurs compilent, et aucun test de l'Inbox ne passe par ce câblage.
    expect(source).toMatch(/sendRcsFromInbox: async \(tenant, waId, contenu\) => \{\s*const issue = await envoyerRcsLibre\(depsRcsLibre, tenant, waId, contenu, 'humain'\);/);
  });
});

describe('câblage de /v1/webhooks (lot 13, domaine 4)', () => {
  it('🔴 les routes sont montées, sur la MÊME gestion que la console et les outils MCP', () => {
    // `v1.webhooks` est optionnel dans `buildServer` : sans ce câblage, les routes ne seraient pas montées, sans erreur.
    expect(source).toMatch(/webhooks: \{ gestion: gestionEvenements, audit: auditSink \},/);
  });
});
