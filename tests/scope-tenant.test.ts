import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scopeTenant } from '../src/http/scope';

/**
 * LE CONTRÔLE D'ACCÈS TENANT, ET SON MODE DE PANNE (audit de surface publique du 2026-09-03).
 *
 * 🔴 `scopeTenant` est LE contrôle d'isolation entre clients de ce produit. La connexion passe par le pooler
 * en rôle superuser, donc la RLS de Postgres est contournée : le filtrage en code est le SEUL contrôle, et
 * cette fonction est l'endroit où il se décide, pour 235 routes.
 *
 * Elle échouait OUVERT : sans `req.auth`, elle rendait le tenant pris dans l'URL. Elle n'était donc un
 * contrôle que tant que la garde d'authentification avait bien été posée au montage, dans un AUTRE fichier.
 * Ce test fige le sens inverse.
 */
describe('scopeTenant : le contrôle d’isolation entre clients', () => {
  const req = (tenantUrl: string, tenantJwt?: string) => ({
    params: { tenantId: tenantUrl },
    ...(tenantJwt === undefined ? {} : { auth: { tenantId: tenantJwt } }),
  });

  it('cas nominal : le JWT et l’URL désignent le même espace', () => {
    expect(scopeTenant(req('t1', 't1'))).toBe('t1');
  });

  it('🔴 l’URL désigne un AUTRE espace que le jeton : refusé', () => {
    // Le cas d'école de l'IDOR : changer l'identifiant dans la barre d'adresse.
    expect(scopeTenant(req('t2', 't1'))).toBeNull();
  });

  it('🔴 AUCUNE authentification : refusé, et c’est le correctif', () => {
    // Avant, ceci rendait 't2' : la fonction distribuait l'espace demandé à qui le demandait. Ce n'était pas
    // exploitable en production (le câblage fournit toujours `auth`), mais la sûreté de 235 routes reposait
    // sur un appelant lointain, et la panne aurait été MUETTE. Un contrôle d'accès qui dépend d'une
    // convention n'est pas un contrôle d'accès.
    expect(scopeTenant(req('t2'))).toBeNull();
  });

  it('🔴 et le garde-fou du démarrage couvre TOUS les modules qui en dépendent', () => {
    // La seconde moitié du correctif. Le `throw` de `buildServer` n'énumérait que 18 modules sur 36 : les
    // autres se seraient montés sans garde, en silence. Ce test lit la source parce qu'aucun type ne peut
    // exprimer « cette liste doit rester complète ».
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const bloc = server.slice(server.indexOf('export function buildServer'), server.indexOf('const app = Fastify'));
    // Les modules dont les routes portent `:tenantId` et appellent donc `scopeTenant`. En ajouter un au
    // serveur sans l'ajouter ici, c'est rouvrir la porte pour lui seul.
    const dependants = [
      'import', 'campaigns', 'admin', 'flows', 'templates', 'support', 'contacts', 'account', 'me',
      'workflows', 'embeddedSignup', 'apiKeys', 'hubspotImport', 'hubspotInstall', 'hubspotPipelines',
      'mba', 'email', 'webhooksAdmin',
      'inbox', 'stats', 'settings', 'rcsMessages', 'rcsChannel', 'rcsMedia', 'media', 'tags', 'fields',
      'workflowReports', 'automations', 'agents', 'agentKnowledge', 'agentTools', 'agentSources',
      'agentRequetes', 'agentSetup', 'agentTest', 'channelsMe', 'aide',
    ];
    const manquants = dependants.filter((m) => !bloc.includes(`deps.${m}`));
    expect(manquants, `ces modules exposent des routes tenant sans être couverts par le garde-fou : ${manquants.join(', ')}`).toEqual([]);
  });
});
