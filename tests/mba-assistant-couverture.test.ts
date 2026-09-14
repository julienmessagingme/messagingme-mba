import { describe, it, expect } from 'vitest';
import { calculerCompletion, type EntreeCompletion } from '../src/mba/completion';
import { accueilMba, ordreDuJourMba, prochainPointMba } from '../src/mba/assistant/couverture';

/**
 * L'ORDRE DU JOUR DE L'ASSISTANT MBA EST DÉRIVÉ DE LA COMPLÉTUDE, jamais réécrit à côté.
 *
 * 🔴 CE QUE CETTE DÉRIVATION ACHÈTE : `calculerCompletion` sait des choses qu'une liste écrite à la main ne
 * saurait pas, et qui ont chacune coûté cher. Une compétence en relecture chez Meta existe et n'agit pas ;
 * un site aspiré à zéro page n'est pas une source de connaissance. Une seconde liste divergerait au premier
 * ajout, et l'écran aurait raison pendant que l'assistant aurait tort.
 */
const vide: EntreeCompletion = {
  settings: null, businessInfo: null, faqs: null, skills: null, websites: null, files: null,
};

describe('l’ordre du jour du MBA dérive de la complétude', () => {
  it('ne contient QUE des tâches à faire, requises OU NON', () => {
    // 🔴 `requise` N'EST PAS LE CRITÈRE : les sites et les fichiers sont facultatifs pour Meta, et l'exiger
    // les aurait exclus, donc l'assistant n'aurait jamais posé la question des sites. C'est une demande
    // explicite de Julien, et ce cas l'a attrapée.
    const c = calculerCompletion({ ...vide, businessInfo: { business_description: '' } as never, faqs: [], skills: [], websites: [], files: [], settings: {} as never });
    for (const p of ordreDuJourMba(c)) expect(c.taches.find((x) => x.cle === p.cle)?.etat).toBe('a_faire');
    expect(ordreDuJourMba(c).map((p) => p.cle)).toContain('sites');
  });

  it('🔴 une tâche INCONNUE n’est jamais une question', () => {
    // « Inconnue » veut dire que la lecture chez Meta a échoué, pas que ce n'est pas fait. En faire une
    // question ferait demander au client de régler quelque chose qui l'est peut-être déjà.
    const c = calculerCompletion(vide);
    const inconnues = c.taches.filter((t) => t.etat === 'inconnue').map((t) => t.cle);
    expect(inconnues.length).toBeGreaterThan(0);
    for (const cle of inconnues) expect(ordreDuJourMba(c).map((p) => p.cle)).not.toContain(cle);
  });

  it('🔴 reprend la RAISON mesurée, sans la réécrire', () => {
    // Le cas qui a coûté le plus cher : quatre compétences écrites, aucune active. Dire « aucune
    // compétence » serait faux, et le client irait en écrire une cinquième.
    const c = calculerCompletion({
      ...vide, settings: {} as never, businessInfo: { business_description: '' } as never,
      faqs: [], websites: [], files: [],
      skills: [{ id: 's1', name: 'x', status: 'pending_review' }] as never,
    });
    const point = ordreDuJourMba(c).find((p) => p.cle === 'competences');
    const tache = c.taches.find((t) => t.cle === 'competences');
    expect(point?.raison).toBe(tache?.raison);
    expect(point?.raison).toMatch(/relecture/i);
  });

  it('🔴 « on met en service ? » ferme TOUJOURS la marche', () => {
    // Décision de Julien : la mise en service est la DERNIÈRE question du setup initial. La poser plus tôt
    // reviendrait à proposer d'allumer un agent qui n'a rien à dire.
    const c = calculerCompletion({ ...vide, settings: {} as never, businessInfo: { business_description: '' } as never, faqs: [], skills: [], websites: [], files: [] });
    const cles = ordreDuJourMba(c).map((p) => p.cle);
    expect(cles).toContain('activation');
    expect(cles[cles.length - 1]).toBe('activation');
  });

  it('⚠️ l’assistant ne devine JAMAIS une adresse de site : aucune piste', () => {
    const c = calculerCompletion({ ...vide, settings: {} as never, businessInfo: { business_description: '' } as never, faqs: [], skills: [], websites: [], files: [] });
    expect(ordreDuJourMba(c).find((p) => p.cle === 'sites')?.pistes).toEqual([]);
  });
});

describe('le point du tour', () => {
  const partiel = calculerCompletion({
    ...vide, settings: {} as never, businessInfo: { business_description: '' } as never,
    faqs: [], skills: [], websites: [], files: [],
  });

  it('prend le premier point non encore posé', () => {
    const p1 = prochainPointMba(partiel, []);
    expect(p1).not.toBeNull();
    const p2 = prochainPointMba(partiel, [p1!.cle]);
    expect(p2?.cle).not.toBe(p1!.cle);
  });

  it('⚠️ repose le dernier point plutôt que de se taire', () => {
    // Un client qui n'a pas répondu doit pouvoir se le voir redemander : sinon l'entretien s'arrête sans
    // avoir couvert ce qu'il annonce.
    const tous = ordreDuJourMba(partiel).map((p) => p.cle);
    expect(prochainPointMba(partiel, tous)).not.toBeNull();
  });

  it('🔴 rend `null` quand tout est couvert : c’est LA bascule vers l’écoute', () => {
    const complet = calculerCompletion({
      ...vide,
      settings: { rollout: { enabled: true } } as never,
      businessInfo: { business_description: 'Un garage à Lyon.' } as never,
      faqs: [{ id: 'f1' }] as never,
      skills: [{ id: 's1', status: 'active' }] as never,
      websites: [{ id: 'w1', pages_crawled: 12 }] as never,
      files: [{ id: 'd1' }] as never,
    });
    expect(prochainPointMba(complet, [])).toBeNull();
  });
});

describe('la phrase d’accueil', () => {
  it('🔴 nomme ce qui est en place ET ce qui manque', () => {
    const c = calculerCompletion({
      ...vide, settings: {} as never,
      businessInfo: { business_description: 'Un garage à Lyon.' } as never,
      faqs: [{ id: 'f1' }] as never, skills: [], websites: [], files: [],
    });
    const phrase = accueilMba(c);
    expect(phrase).toMatch(/c’est en place/);
    expect(phrase).toMatch(/Il reste/);
  });

  it('⚠️ tout couvert : elle passe à l’écoute, elle ne relance pas un entretien', () => {
    const complet = calculerCompletion({
      ...vide,
      settings: { rollout: { enabled: true } } as never,
      businessInfo: { business_description: 'Un garage à Lyon.' } as never,
      faqs: [{ id: 'f1' }] as never,
      skills: [{ id: 's1', status: 'active' }] as never,
      websites: [{ id: 'w1', pages_crawled: 12 }] as never,
      files: [{ id: 'd1' }] as never,
    });
    expect(accueilMba(complet)).toMatch(/ce que vous voulez changer/i);
  });
});
