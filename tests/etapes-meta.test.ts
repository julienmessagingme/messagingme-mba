import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ETAPES_CARTE_META, PREREQUIS_META } from '../web/lib/partage/etapes-meta';
import { etatMiseEnService, type LecturesMiseEnService } from '../src/mcp/mise-en-service';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { signLienNumero } from '../src/auth/token';
import type { EtatConnexion } from '../src/otp/etat-connexion';

/**
 * CE QU'IL FAUT CHEZ META, UNE SEULE SOURCE POUR LA CONSOLE ET POUR CLAUDE (le guide « compte Meta », 2026-10-13). La
 * page « Connecter WhatsApp » dit les prérequis avant la fenêtre de Meta, l'Accueil et `get_setup_state` disent la carte
 * dès que Meta bloque le compte pour son moyen de paiement (erreur 141006, mesurée le même jour).
 */
const SECRET = randomBytes(32).toString('hex');
const outil = (nom: string) => OUTILS.find((o) => o.nom === nom)!;
const VIDE: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null, inclusDansLePro: false };
const CONNECTE: EtatConnexion = { ...VIDE, connecte: { chiffres: '33612345678', aActiver: false } };
const PRET: LecturesMiseEnService = {
  offre: { offre: 'free', fonctions: [] },
  soldeMicroEur: 1_000_000,
  numero: CONNECTE,
  agents: [{ id: 'a1', label: 'Accueil', status: 'active', nbManques: null }],
  reglages: { mbaEnabled: false, repondeurMode: 'agent', repondeurAgentId: 'a1', repondeurWorkflowId: null, repondeurAdresseId: null },
  widgets: [{ id: 'w1', nom: 'Site', actif: true }],
};

function deps(): DepsMcp {
  return {
    numero: {
      signerLien: (l: Parameters<typeof signLienNumero>[0]) => signLienNumero(l, SECRET),
      etat: async () => VIDE,
      urlConsole: 'https://console.exemple.test',
      attendre: async () => {},
      maintenant: () => 1_000_000,
    },
  } as unknown as DepsMcp;
}

describe('ce qu’il faut chez Meta', () => {
  it('les prérequis nomment le compte Meta Business, le portefeuille et le numéro libre ; la carte, Visa ou Mastercard', () => {
    const avant = PREREQUIS_META.map((e) => e.fr).join(' ');
    expect(avant).toMatch(/compte Meta Business/);
    expect(avant).toMatch(/portefeuille/);
    expect(avant).toMatch(/business\.facebook\.com/);
    expect(avant).toMatch(/application WhatsApp/);
    const carte = ETAPES_CARTE_META.map((e) => e.fr).join(' ');
    expect(carte).toMatch(/Paramètres de paiement/);
    expect(carte).toMatch(/Visa ou Mastercard/);
    expect([...PREREQUIS_META, ...ETAPES_CARTE_META].every((e) => e.fr.length > 0 && e.en.length > 0)).toBe(true);
  });

  it('🔴 la fiche du bot d’aide reprend ces textes mot pour mot (elle ne peut pas importer la source)', () => {
    const plat = (t: string): string => t.replace(/\s+/g, ' ');
    const fiche = plat(readFileSync('docs/aide/fiches/ce-qu-il-faut-chez-meta.md', 'utf8'));
    for (const e of [...PREREQUIS_META, ...ETAPES_CARTE_META]) expect(fiche).toContain(plat(e.fr));
  });

  it('🔴 la page « Connecter WhatsApp » et l’Accueil lisent CES textes, rien d’écrit à part', () => {
    expect(readFileSync('web/components/ParcoursNumero.tsx', 'utf8')).toContain('PREREQUIS_META');
    expect(readFileSync('web/app/accueil/page.tsx', 'utf8')).toContain('ETAPES_CARTE_META');
  });

  it('🔴 Claude les dit avant le lien ; au numéro fourni, sans lui proposer un numéro qu’il vient de choisir', async () => {
    const apporte = await outil('start_whatsapp_connection').executer(deps(), 't1', { mode: 'apporte' }, { userId: 'u' }) as Record<string, string>;
    for (const e of PREREQUIS_META) expect(apporte.consigne).toContain(e.fr);
    const fourni = await outil('start_whatsapp_connection').executer(deps(), 't1', { mode: 'fourni' }, { userId: 'u' }) as Record<string, string>;
    for (const e of PREREQUIS_META.slice(0, 2)) expect(fourni.consigne).toContain(e.fr);
    expect(fourni.consigne).not.toContain(PREREQUIS_META[2]!.fr);
  });

  it('🔴 dès la connexion, la suite de watch_whatsapp_connection donne le chemin de la carte (le drapeau n’est pas encore lu)', async () => {
    const d = deps();
    (d.numero as unknown as { etat: () => Promise<EtatConnexion> }).etat = async () => ({ ...VIDE, connecte: { chiffres: '336', aActiver: false } });
    const r = await outil('watch_whatsapp_connection').executer(d, 't1', {}, { userId: 'u' }) as Record<string, string>;
    for (const e of ETAPES_CARTE_META) expect(r.suite).toContain(e.fr);
  });

  it('🔴 get_setup_state : la carte à régler chez Meta, avec ses étapes, seulement sur un numéro connecté bloqué', () => {
    const bloque = etatMiseEnService({ ...PRET, numero: { ...CONNECTE, connecte: { chiffres: '336', aActiver: false, paiementBloque: true } } });
    expect(bloque.avertissements).toContain('carte_meta_a_regler');
    expect(bloque.etapes_carte_meta).toEqual(ETAPES_CARTE_META.map((e) => e.fr));
    const sain = etatMiseEnService(PRET);
    expect(sain.avertissements).not.toContain('carte_meta_a_regler');
    expect(sain.etapes_carte_meta).toBeUndefined();
    // Sans numéro connecté, rien à dire de la carte : la connexion vient d'abord.
    expect(etatMiseEnService({ ...PRET, numero: VIDE }).avertissements).not.toContain('carte_meta_a_regler');
  });
});
