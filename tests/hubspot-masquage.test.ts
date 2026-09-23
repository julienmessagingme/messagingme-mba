import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import { sansPortailHubspot, avecPortailHubspot } from './hubspot';
import type { SettingsRouteDeps } from '../src/http/settings';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';

// Aucun compte : ces cas ne testent pas la connexion, ils lisent une route avec un jeton deja signe.
const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

/**
 * SANS PORTAIL HUBSPOT LIE, LES FONCTIONS HUBSPOT SONT MASQUEES (lot 9, arbitrage de Julien du 2026-09-23).
 *
 * 🔴 CE QUE CE FICHIER FERME, ET CE N'ETAIT PAS CE QUE LE PLAN ANNONCAIT. La source HubSpot d'une campagne
 * etait deja masquee, mais sur `hubspotListsEnabled`, qui est un INTERRUPTEUR d'espace : un client qui DELIE
 * son portail garde l'interrupteur allume, donc la source restait offerte et ne menait nulle part. Les deux
 * drapeaux repondent a deux questions differentes, « ce client VEUT-il cette source ? » et « est-elle
 * seulement POSSIBLE ? », et il faut les DEUX.
 *
 * ⚠️ CE QUI N'EST PAS ICI, ET POURQUOI : `flagUnreachable` (le balayage de relance ecrit « injoignable »
 * dans HubSpot) reste hors de ce lot, par decision de Julien. Il est deja neutralise quand l'INSTANCE n'a
 * pas de connecteur, pas quand un ESPACE n'a pas de portail, et le neutraliser par espace toucherait un
 * chemin que la production emprunte. C'est consigne, pas oublie.
 */
const SECRET = 'secret-de-test-de-32-octets-minimum!!';
// ⚠️ `signSession` est ASYNCHRONE : un jeton construit en synchrone rendrait une promesse, donc un en-tete
// `Bearer [object Promise]` et un 401 qui ferait chercher le defaut du cote de la garde.
const jeton = (role: 'admin' | 'manager' = 'admin') =>
  signSession({ userId: 'u1', tenantId: 't1', role }, SECRET);

const REGLAGES = {
  mbaEnabled: false, hubspotListsEnabled: true, campaignsPaused: false, autoRetryEnabled: false,
  controlHandbackSeconds: null, mbaHandoffMode: null, agentTransfertMode: null, agentsPeuventPrendre: false,
  optoutRequestId: null, mentionIaFrequence: null, timezone: 'Europe/Paris', businessHours: {},
};

function app(portail: SettingsRouteDeps['hubspotPortalConnecte']) {
  return buildServer({
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    settings: {
      getSettings: async () => REGLAGES,
      hubspotPortalConnecte: portail,
      setMbaEnabled: async () => {},
      setHubspotListsEnabled: async () => {},
      setCampaignsPaused: async () => {},
      setAutoRetryEnabled: async () => {},
      setControlHandbackSeconds: async () => {},
      setMbaHandoffMode: async () => {},
      setTimezone: async () => {},
      setBusinessHours: async () => {},
    } as unknown as SettingsRouteDeps,
  });
}

const lire = async (a: ReturnType<typeof app>, role: 'admin' | 'manager' = 'admin') =>
  a.inject({ method: 'GET', url: '/tenants/t1/settings', headers: { authorization: `Bearer ${await jeton(role)}` } });

describe('le lien du portail HubSpot voyage avec les reglages', () => {
  it('🔴 aucun portail -> `hubspotPortalConnecte: false`, meme quand l interrupteur est ALLUME', async () => {
    // Le cas exact du defaut : l'interrupteur dit oui, le portail dit non, et c'est le portail qui tranche.
    const a = app(sansPortailHubspot);
    const body = (await lire(a)).json<{ hubspotListsEnabled: boolean; hubspotPortalConnecte: boolean }>();
    expect(body.hubspotListsEnabled, 'l interrupteur reste ce qu il est').toBe(true);
    expect(body.hubspotPortalConnecte).toBe(false);
    await a.close();
  });

  it('un portail lie -> `hubspotPortalConnecte: true`', async () => {
    const a = app(avecPortailHubspot);
    expect((await lire(a)).json<{ hubspotPortalConnecte: boolean }>().hubspotPortalConnecte).toBe(true);
    await a.close();
  });

  it('🔴 il voyage sur la route des REGLAGES, pas sur celle du statut de compte', async () => {
    /**
     * LE CHOIX DE LA ROUTE EST LE VRAI SUJET, et il a failli etre le mauvais. Le lien du portail est deja
     * rendu par `GET /tenants/:t/account`... qui n'est pas la route que les deux ecrans a masquer
     * appellent. Les y faire appeler une SECONDE route pour un drapeau d'affichage aurait ajoute un
     * aller-retour a l'ouverture de chaque ecran, et une seconde source de verite pour la meme question.
     *
     * ⚠️ CETTE ROUTE EST ADMIN-ONLY, et ce n'est pas un probleme ici : les deux ecrans gardes (Campagnes,
     * Automations) le sont AUSSI (`ECRANS_ENCADREMENT` ne les contient pas), et ils appellent deja
     * `getSettings` pour `rcsEnabled` et `mbaEnabled`. Le drapeau voyage exactement ou les autres vont.
     */
    const a = app(avecPortailHubspot);
    const res = await lire(a, 'manager');
    expect(res.statusCode, 'un manager n a pas acces aux reglages, et n a pas non plus ces deux ecrans').toBe(403);
    await a.close();
  });

  it('🔴 la dependance est REQUISE par le type, pas optionnelle', () => {
    // Optionnelle, elle vaudrait `undefined` sur un cablage qui l'oublie, donc « pas connecte », donc la
    // source disparaitrait pour un client qui l'a. C'est la regle du lot 2 du plan du 2026-09-14.
    const src = readFileSync(new URL('../src/http/settings.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/hubspotPortalConnecte\(tenantId: string\): Promise<boolean>;/);
    expect(src, 'un `?` la rendrait oubliable').not.toMatch(/hubspotPortalConnecte\?/);
  });

  it('🔴 le cablage retombe sur `false` quand le schema du connecteur n existe pas', () => {
    // Le cas d'erreur REEL n'est pas un hoquet reseau : c'est une base sans le schema `mmhs` (instance sans
    // connecteur, base de CI), donc `42P01`. Repondre « connecte » y offrirait une source impossible.
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/hubspotPortalConnecte:[^\n]*getHubspotPortal\(tenant\)[^\n]*catch\(\(\) => false\)/);
  });
});
