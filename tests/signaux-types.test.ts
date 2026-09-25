import { describe, it, expect } from 'vitest';
import {
  NOMS_EVENEMENTS, NOMS_ATTRIBUTS, NOM_DICTIONNAIRE_RE, CHAMP_RE, CHAMPS_EVENEMENT, CHAMP_ID_EVENEMENT,
  MORCEAUX_RESUME, TEXTE_SIGNAL_MAX, SIGNAUX_PAR_JOB, NOM_APPEL_SIGNAUX,
  borneTexte, morceauxDuResume, idSignal, schemaSignal, schemaJobSignaux,
} from '../src/signaux/types';
import { llmOutputSchema } from '../src/analysis/schema';

const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const C = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const LE = '2026-09-24T10:00:00.000Z';

describe('le dictionnaire des signaux', () => {
  it('🔴 chaque nom tient la règle la plus stricte des outils connus : em_, 30 caractères, [a-z0-9_]', () => {
    for (const n of [...NOMS_EVENEMENTS, ...NOMS_ATTRIBUTS]) {
      expect(n, n).toMatch(NOM_DICTIONNAIRE_RE);
      expect(n.length, n).toBeLessThanOrEqual(30);
    }
  });

  it('aucun nom en double entre événements et attributs', () => {
    const tous = [...NOMS_EVENEMENTS, ...NOMS_ATTRIBUTS];
    expect(new Set(tous).size).toBe(tous.length);
  });

  it('la règle refuse ce qu’un outil strict refuserait', () => {
    expect('em_Majuscule').not.toMatch(NOM_DICTIONNAIRE_RE);
    expect(`em_${'x'.repeat(28)}`).not.toMatch(NOM_DICTIONNAIRE_RE);
    expect('sans_prefixe').not.toMatch(NOM_DICTIONNAIRE_RE);
    expect('em_tiret-bas').not.toMatch(NOM_DICTIONNAIRE_RE);
  });

  it('🔴 les champs de CHAQUE événement sont fixés ici, et tiennent la même règle de nom', () => {
    expect(Object.keys(CHAMPS_EVENEMENT).sort()).toEqual([...NOMS_EVENEMENTS].sort());
    for (const [nom, champs] of Object.entries(CHAMPS_EVENEMENT)) {
      expect(new Set(champs).size, nom).toBe(champs.length);
      for (const c of champs) {
        expect(c, `${nom}.${c}`).toMatch(CHAMP_RE);
        // L'identifiant d'événement est COMMUN : il ne se redéclare pas dans un événement.
        expect(c, `${nom}.${c}`).not.toBe(CHAMP_ID_EVENEMENT);
      }
    }
    expect(CHAMP_ID_EVENEMENT).toMatch(CHAMP_RE);
  });

  it('🔴 le libellé du journal des erreurs ne nomme aucun outil (spec § 10)', () => {
    expect(NOM_APPEL_SIGNAUX).not.toMatch(/\b(batch|brevo|splio|sfmc|salesforce|hubspot|klaviyo|braze)\b/i);
  });
});

describe('les textes : une borne, et le résumé en morceaux', () => {
  it('🔴 le résumé le plus long que l’analyse produit tient ENTIER dans les morceaux (dérivé, pas recopié)', () => {
    const maxAnalyse = llmOutputSchema.shape.summary.unwrap().maxLength ?? Number.POSITIVE_INFINITY;
    // `- 1` : un morceau peut s'arrêter un caractère plus tôt pour ne pas couper un emoji.
    expect(MORCEAUX_RESUME.length * (TEXTE_SIGNAL_MAX - 1)).toBeGreaterThanOrEqual(maxAnalyse);
    const resume = 'Le client demande où en est sa livraison. '.repeat(40).slice(0, maxAnalyse);
    const morceaux = morceauxDuResume(resume);
    expect(morceaux.join('')).toBe(resume);
    expect(morceaux.length).toBeLessThanOrEqual(MORCEAUX_RESUME.length);
    for (const m of morceaux) expect(m.length).toBeLessThanOrEqual(TEXTE_SIGNAL_MAX);
  });

  it('un résumé court : un seul morceau, et rien pour un résumé vide', () => {
    expect(morceauxDuResume('Court.')).toEqual(['Court.']);
    expect(morceauxDuResume('')).toEqual([]);
  });

  it('🔴 borneTexte ne coupe pas un emoji en deux (un demi-caractère serait refusé par l’outil)', () => {
    const v = `${'x'.repeat(TEXTE_SIGNAL_MAX - 1)}😀fin`;
    const b = borneTexte(v);
    expect(b).toBe('x'.repeat(TEXTE_SIGNAL_MAX - 1));
    expect(borneTexte('court')).toBe('court');
  });
});

describe('idSignal : l’em_event_id', () => {
  it('🔴 avec une clé naturelle, il est STABLE : un webhook redélivré donne le même identifiant', () => {
    expect(idSignal('em_message_delivered', 'wamid.X')).toBe(idSignal('em_message_delivered', 'wamid.X'));
  });

  it('deux événements du même message ne se confondent pas', () => {
    expect(idSignal('em_message_delivered', 'wamid.X')).not.toBe(idSignal('em_message_read', 'wamid.X'));
  });

  it('🔴 il ne laisse pas sortir la clé : un identifiant de message WhatsApp encode le numéro', () => {
    const id = idSignal('em_message_delivered', 'wamid.HBgLMzM2MTIzNDU2NzgVAgARGBI');
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain('wamid');
  });

  it('sans clé naturelle, un identifiant neuf à chaque émission (figé ensuite dans le job)', () => {
    expect(idSignal('em_opted_out')).not.toBe(idSignal('em_opted_out'));
  });
});

describe('schemaJobSignaux : le job se relit comme une entrée externe', () => {
  const reponse = { nom: 'em_replied', id: idSignal('em_replied', 'wamid.R'), le: LE, waId: '33612345678', canal: 'whatsapp', bouton: 'Oui' };
  const ok = { tenantId: T, signaux: [reponse] };

  it('accepte un job bien formé', () => {
    expect(schemaJobSignaux.safeParse(ok).success).toBe(true);
  });

  it('🔴 refuse une clé en trop, même dans un signal (le texte d’un message n’a pas de place ici)', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, texte: 'bonjour' }] }).success).toBe(false);
  });

  it('refuse un nom hors dictionnaire, un canal inconnu, un espace qui n’est pas un uuid', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, nom: 'em_inconnu' }] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [{ ...reponse, canal: 'sms' }] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, tenantId: 't1' }).success).toBe(false);
  });

  it('🔴 un job porte de 1 à SIGNAUX_PAR_JOB signaux, jamais zéro, jamais plus', () => {
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: [] }).success).toBe(false);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: Array.from({ length: SIGNAUX_PAR_JOB }, () => reponse) }).success).toBe(true);
    expect(schemaJobSignaux.safeParse({ ...ok, signaux: Array.from({ length: SIGNAUX_PAR_JOB + 1 }, () => reponse) }).success).toBe(false);
  });

  it('accepte un cas de CHAQUE nom du dictionnaire, ni plus ni moins', () => {
    const signaux = [
      { nom: 'em_message_delivered', id: idSignal('em_message_delivered', 'm1'), le: LE, waId: '336', canal: 'rcs', messageId: 'm1' },
      { nom: 'em_message_read', id: idSignal('em_message_read', 'm1'), le: LE, waId: '336', canal: 'whatsapp', messageId: 'm1' },
      { nom: 'em_message_failed', id: idSignal('em_message_failed', 'm1'), le: LE, waId: '336', canal: 'whatsapp', messageId: 'm1', motif: '131026 Message undeliverable', codeMeta: 131026 },
      { nom: 'em_replied', id: idSignal('em_replied', 'm2'), le: LE, waId: '336', canal: 'rcs', bouton: null },
      { nom: 'em_link_clicked', id: idSignal('em_link_clicked'), le: LE, contactId: C, lien: 'ab12cd34ef56' },
      { nom: 'em_opted_out', id: idSignal('em_opted_out'), le: LE, waId: '336', canal: 'whatsapp' },
      { nom: 'em_conversation_analyzed', id: idSignal('em_conversation_analyzed'), le: LE, conversationId: C },
      { nom: 'em_risk_changed', id: idSignal('em_risk_changed', `${C}:${LE}`), le: LE, contactId: C, niveau: 'eleve', ancienNiveau: 'moyen', score: 70, raisons: ['silence_60j', 'sans_reponse', 'non_lu'] },
    ];
    for (const s of signaux) expect(schemaSignal.safeParse(s).success, s.nom).toBe(true);
    expect(signaux.map((s) => s.nom).sort()).toEqual([...NOMS_EVENEMENTS].sort());
  });

  it('🔴 un changement de risque : niveaux et codes FERMÉS, score de 0 à 100 ou absent, trois raisons au plus', () => {
    const risque = { nom: 'em_risk_changed', id: idSignal('em_risk_changed', 'x'), le: LE, contactId: C, niveau: 'inconnu', ancienNiveau: null, score: null, raisons: [] };
    expect(schemaSignal.safeParse(risque).success, 'premier calcul, inconnu sans score').toBe(true);
    expect(schemaSignal.safeParse({ ...risque, niveau: 'critique' }).success).toBe(false);
    expect(schemaSignal.safeParse({ ...risque, raisons: ['fatigue'] }).success).toBe(false);
    expect(schemaSignal.safeParse({ ...risque, niveau: 'eleve', score: 101 }).success).toBe(false);
    expect(schemaSignal.safeParse({ ...risque, niveau: 'eleve', score: 100, raisons: ['stop', 'bloque', 'negatif', 'injoignable'] }).success).toBe(false);
    // Aucune donnée de la personne n'a sa place dans ce signal.
    expect(schemaSignal.safeParse({ ...risque, waId: '33612345678' }).success).toBe(false);
  });
});
