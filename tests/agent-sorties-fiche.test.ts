import { describe, it, expect } from 'vitest';
import { sortiesDeLaFiche } from '../src/agent/agent-store.pg';
import { ficheAgentSchema, fichePatchSchema } from '../src/agent/fiche';

/**
 * Lecture des règles d'arrêt d'une fiche d'agent. `fiche` est du jsonb écrit par l'IA de construction, donc
 * opaque : c'est la logique la plus subtile du lot, et elle décide de ce que le builder dessine.
 *
 * Deux exigences opposées, et l'ordre entre elles est le sujet. TOLÉRER une fiche mal formée, parce qu'une
 * seule ligne bancale ne doit pas rendre tout un scénario inéditable. Mais REJETER un code qui ne peut pas
 * servir de handle d'arête, parce qu'un handle exotique produit des écarts silencieux entre ce que le builder
 * dessine et ce que le moteur route.
 */
describe('sortiesDeLaFiche', () => {
  it('lit les règles bien formées, dans l ordre', () => {
    expect(sortiesDeLaFiche({ sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'hors_sujet', label: 'Hors sujet' }] }))
      .toEqual([{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'hors_sujet', label: 'Hors sujet' }]);
  });

  it('un libellé absent ou vide retombe sur le code, jamais sur une ligne muette', () => {
    // Une sortie sans nom serait un point à relier dont personne ne saurait ce qu'il fait.
    expect(sortiesDeLaFiche({ sorties: [{ code: 'rdv' }, { code: 'devis', label: '   ' }] }))
      .toEqual([{ code: 'rdv', label: 'rdv' }, { code: 'devis', label: 'devis' }]);
  });

  it('🔴 un code qui ne peut pas servir de handle est REJETÉ', () => {
    // Espaces, accents, majuscules, ponctuation : tout ce qui rendrait `sortie:<code>` ambigu d'un côté ou de
    // l'autre. La casse, elle, est ramenée en bas plutôt que rejetée : c'est une faute de saisie courante.
    const s = sortiesDeLaFiche({
      sorties: [
        { code: 'Besoin Cerné' }, { code: 'avec espace' }, { code: 'ponctuation!' }, { code: '' },
        { code: 'a'.repeat(33) }, { code: 42 }, { code: 'BESOIN', label: 'Besoin' },
      ],
    });
    expect(s).toEqual([{ code: 'besoin', label: 'Besoin' }]);
  });

  it('les doublons sont écartés : deux sorties du même code en cacheraient une', () => {
    // Deux poignées du même nom sur un bloc : la seconde serait inatteignable, et l'arête tirée dessus
    // désignerait la première.
    expect(sortiesDeLaFiche({ sorties: [{ code: 'rdv', label: 'Premier' }, { code: 'RDV', label: 'Second' }] }))
      .toEqual([{ code: 'rdv', label: 'Premier' }]);
  });

  it('une fiche vide, absente ou d une forme inattendue ne LÈVE jamais', () => {
    // Le builder tomberait, et le client ne pourrait plus éditer AUCUN bloc de son scénario.
    for (const fiche of [null, undefined, {}, { sorties: null }, { sorties: 'texte' }, { sorties: [null, 3, 'x'] }, 'pas un objet', 42]) {
      expect(sortiesDeLaFiche(fiche)).toEqual([]);
    }
  });
});

/**
 * Les DEUX schémas de fiche, et le piège qui les sépare.
 *
 * 🔴 CE TEST EXISTE PARCE QUE LE PIÈGE A DÉJÀ COÛTÉ UNE FOIS. La tâche 19a avait corrigé le patch de fiche
 * en fusion jsonb plus verrou de version, contre un défaut réel : enregistrer l'objectif effaçait les règles
 * d'arrêt. La correction ne fermait pas le cas, et rien ne le voyait. `ficheAgentSchema.partial()` NE REND
 * PAS un objet partiel : `.partial()` rend le champ optionnel, mais le `.default()` qui est dessous
 * s'applique quand même à l'absence. Le patch ressortait donc en fiche ENTIÈRE, et la fusion `fiche || $n`
 * n'avait plus aucune clé absente à protéger. Aucun test ne pouvait s'en apercevoir parce que le formulaire
 * renvoie toujours la fiche entière ; c'est la conversation de construction (tâche 19d), qui écrit par
 * petites touches, qui a mis le nez dessus.
 */
describe('ficheAgentSchema contre fichePatchSchema', () => {
  it('🔴 le PATCH ne remplit AUCUN champ absent', () => {
    const r = fichePatchSchema.safeParse({ objectif: 'Cerner le besoin.' });
    expect(r.success).toBe(true);
    // Une seule clé. Toute autre serait écrite dans la fusion jsonb et effacerait ce qu'elle recouvre.
    expect(Object.keys(r.success ? r.data : {})).toEqual(['objectif']);
  });

  it('🔴 `ficheAgentSchema.partial()` en remplit SIX : c est le piège, on l ancre pour ne pas y retomber', () => {
    const piege = ficheAgentSchema.partial().safeParse({ objectif: 'Cerner le besoin.' });
    expect(Object.keys(piege.success ? piege.data : {}).length).toBe(6);
  });

  it('la LECTURE, elle, remplit bien les champs absents', () => {
    // Sens inverse et tout aussi voulu : une ligne écrite par une version antérieure doit rester éditable.
    const r = ficheAgentSchema.safeParse({});
    expect(r.success && r.data).toEqual({ nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] });
  });

  it('les deux schémas portent exactement les mêmes champs, et les mêmes bornes', () => {
    expect(Object.keys(fichePatchSchema.shape).sort()).toEqual(Object.keys(ficheAgentSchema.shape).sort());
    const trop = 'x'.repeat(4001);
    expect(fichePatchSchema.safeParse({ objectif: trop }).success).toBe(false);
    expect(ficheAgentSchema.safeParse({ objectif: trop }).success).toBe(false);
  });

  it('le patch garde les refus de la fiche : code hors alphabet, doublon, trop de sorties', () => {
    expect(fichePatchSchema.safeParse({ sorties: [{ code: 'Majuscule', label: 'x' }] }).success).toBe(false);
    expect(fichePatchSchema.safeParse({ sorties: [{ code: 'rdv', label: 'a' }, { code: 'rdv', label: 'b' }] }).success).toBe(false);
    const treize = Array.from({ length: 13 }, (_, i) => ({ code: `s${i}`, label: `S${i}` }));
    expect(fichePatchSchema.safeParse({ sorties: treize }).success).toBe(false);
  });

  it('un patch vide est valide, et ne porte rien', () => {
    // C'est ce que rend une proposition de l'assistant qui ne touche pas à la fiche : elle ne doit pas
    // faire échouer le tour, elle doit juste n'écrire nulle part.
    const r = fichePatchSchema.safeParse({});
    expect(r.success && Object.keys(r.data)).toEqual([]);
  });
});
