import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ETAPES_NUMERO_FOURNI, SECONDES_SANS_CODE } from '../web/lib/partage/etapes-numero-fourni';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { signLienNumero } from '../src/auth/token';
import type { EtatConnexion } from '../src/otp/etat-connexion';

/**
 * LES ÉTAPES DU NUMÉRO FOURNI, UNE SEULE SOURCE POUR LA PAGE ET POUR CLAUDE (essai réel 99, 2026-10-13). Écrites deux
 * fois, elles disaient deux choses ; Julien a fixé l'ordre et le choix du SMS en faisant l'essai.
 */
const SECRET = randomBytes(32).toString('hex');
const VIDE: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false };
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;

function deps(etat: EtatConnexion): DepsMcp {
  return {
    numero: {
      signerLien: (l: Parameters<typeof signLienNumero>[0]) => signLienNumero(l, SECRET),
      etat: async () => etat,
      urlConsole: 'https://console.exemple.test',
      attendre: async () => {},
      maintenant: () => 1_000_000,
    },
  } as unknown as DepsMcp;
}

describe('les étapes du numéro fourni', () => {
  it('🔴 l’ordre de Julien : la fenêtre de Meta, GB +44, « Text message », le code, l’autre méthode, « Finish »', () => {
    const fr = ETAPES_NUMERO_FOURNI.map((e) => e.fr);
    const ou = (motif: RegExp) => fr.findIndex((t) => motif.test(t));
    const ordre = [/Ouvrir la fenêtre de Meta/, /GB \(\+44\)/, /Text message/, /saisissez-le/, /Phone call/, /Finish/].map(ou);
    expect(ordre.every((i) => i >= 0)).toBe(true);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    expect(fr.join(' ')).toContain(`${SECONDES_SANS_CODE} secondes`);
    // La page et Claude donnent le numéro AVEC +44 : l'étape parle des chiffres qui le suivent, pas d'un « sans ».
    expect(fr.join(' ')).toMatch(/chiffres qui suivent \+44/);
    // Chaque étape existe dans les deux langues de la console.
    expect(ETAPES_NUMERO_FOURNI.every((e) => e.fr.length > 0 && e.en.length > 0)).toBe(true);
  });

  it('🔴 la page du parcours affiche CES étapes, et plus aucune consigne écrite à part', () => {
    const page = readFileSync('web/components/ParcoursNumero.tsx', 'utf8');
    expect(page).toContain('ETAPES_NUMERO_FOURNI');
    expect(page).not.toMatch(/Phone call|par appel/);
  });

  it('🔴 Claude les redit toutes, encadrées : le lien, le paiement, puis revenir seulement après « Finish »', async () => {
    for (const inclusDansLePro of [false, true]) {
      const r = await outil('start_whatsapp_connection').executer(deps({ ...VIDE, inclusDansLePro }), 't1', { mode: 'fourni' }, { userId: 'u' }) as Record<string, string>;
      for (const e of ETAPES_NUMERO_FOURNI) expect(r.consigne).toContain(e.fr);
      expect(r.consigne).toMatch(/Cliquer sur le lien/);
      expect(r.consigne).toMatch(/Revenir te voir seulement une fois l’écran « Finish » passé/);
      expect(r.consigne).toMatch(inclusDansLePro ? /Obtenir mon numéro/ : /Payer 3,50 € HT par mois/);
    }
  });

  it('🔴 numéro attribué, sans code : la suite redonne les mêmes étapes', async () => {
    const r = await outil('watch_whatsapp_connection').executer(deps({ ...VIDE, fourni: '+441873901030' }), 't1', {}, { userId: 'u' }) as Record<string, string>;
    for (const e of ETAPES_NUMERO_FOURNI) expect(r.suite).toContain(e.fr);
  });
});
