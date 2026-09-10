import { describe, it, expect } from 'vitest';
import { calculerCompletion, type EntreeCompletion } from '../src/mba/completion';

/**
 * L'état de configuration de l'agent Meta.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE, ce n'est pas un compteur : ce sont les DEUX endroits où notre lecture est
 * volontairement plus stricte que la coche verte de Meta, et le troisième où elle refuse de trancher.
 * Chacun vient d'une mesure du 2026-09-10 sur notre propre numéro, pas d'une précaution théorique.
 */
const vide: EntreeCompletion = { settings: null, businessInfo: null, faqs: null, skills: null, websites: null, files: null };
const tache = (c: ReturnType<typeof calculerCompletion>, cle: string) => c.taches.find((t) => t.cle === cle)!;

describe('calculerCompletion — ce qui compte comme fait', () => {
  it('🔴 une compétence en RELECTURE ne compte pas, et la raison le dit', () => {
    // Meta relit les compétences. Entre l'écriture et l'activation, elle existe et n'agit pas : une coche
    // verte à ce moment-là dirait « c'est réglé » sur un agent qui répond encore sans elle.
    const c = calculerCompletion({ ...vide, skills: [{ title: 'a', description: 'd', skill: 's', status: 'pending_review' }] });
    expect(tache(c, 'competences').etat).toBe('a_faire');
    expect(tache(c, 'competences').raison).toMatch(/relecture/);
  });

  it('une compétence ACTIVE compte, même s’il en reste en relecture à côté', () => {
    const c = calculerCompletion({
      ...vide,
      skills: [
        { title: 'a', description: 'd', skill: 's', status: 'active' },
        { title: 'b', description: 'd', skill: 's', status: 'pending_review' },
      ],
    });
    expect(tache(c, 'competences').etat).toBe('faite');
  });

  it('🔴 une compétence REFUSÉE se dit refusée, pas « en relecture »', () => {
    // Les deux états mènent au même verdict mais appellent des gestes opposés : on attend l'un, on réécrit
    // l'autre. Les confondre laisserait le client attendre indéfiniment une compétence que Meta a rejetée.
    const c = calculerCompletion({ ...vide, skills: [{ title: 'a', description: 'd', skill: 's', status: 'blocked' }] });
    expect(tache(c, 'competences').raison).toMatch(/refusée|refusee/i);
    expect(tache(c, 'competences').raison).not.toMatch(/relecture/);
  });

  it('🔴 un site à ZÉRO page aspirée ne compte pas, là où Meta affiche une coche verte', () => {
    // Mesuré sur notre numéro : `messagingme.fr`, `crawl_status: "completed"`, `pages_crawled: 0`. Le crawl
    // s'est « terminé » sans rien récolter. Une source de connaissance vide n'en est pas une.
    const c = calculerCompletion({ ...vide, websites: [{ url: 'https://x.fr', crawl_status: 'completed', pages_crawled: 0 }] });
    expect(tache(c, 'sites').etat).toBe('a_faire');
    expect(tache(c, 'sites').raison).toMatch(/AUCUNE page aspirée/);
  });

  it('un site réellement aspiré compte', () => {
    const c = calculerCompletion({ ...vide, websites: [{ url: 'https://x.fr', crawl_status: 'completed', pages_crawled: 12 }] });
    expect(tache(c, 'sites').etat).toBe('faite');
  });

  it('🔴 « pas lu » n’est pas « vide » : une lecture en échec ne réclame pas du travail', () => {
    // Chaque lecture est un aller-retour chez Meta qui peut échouer seul. Traiter un échec comme un tableau
    // vide afficherait « FAQ à faire » sur un agent qui en a trente, et enverrait le client en écrire une.
    const c = calculerCompletion(vide);
    expect(tache(c, 'faq').etat).toBe('inconnue');
    expect(tache(c, 'faq').raison).toMatch(/Lecture impossible/);
    expect(tache(c, 'faq').etat).not.toBe('a_faire');
  });
});

describe('calculerCompletion — le compte', () => {
  const complet: EntreeCompletion = {
    settings: { rollout: { enabled: true } },
    businessInfo: { business_description: 'Nous faisons des choses.' },
    faqs: [{ question: 'q', answer: 'a' }],
    skills: [{ title: 'a', description: 'd', skill: 's', status: 'active' }],
    websites: [{ url: 'https://x.fr', pages_crawled: 3 }],
    files: [],
  };

  it('🔴 le moyen de paiement sort du DÉNOMINATEUR, il ne se devine pas', () => {
    // Meta ne l'expose par aucune route. Le déduire de « l'agent est allumé » serait faux dans les deux
    // sens : une audience restreinte n'en exige pas, et un paiement peut exister sans agent allumé.
    const c = calculerCompletion(complet);
    expect(tache(c, 'paiement').etat).toBe('inconnue');
    expect(c.faites).toBe(4);
    expect(c.total).toBe(4); // business_info, faq, competences, activation
    expect(c.indeterminees).toBe(1); // le paiement
  });

  it('l’agent éteint fait tomber le compte, et la raison nomme la conséquence', () => {
    const c = calculerCompletion({ ...complet, settings: { rollout: { enabled: false } } });
    expect(c.faites).toBe(3);
    expect(tache(c, 'activation').raison).toMatch(/personne ne répond/);
  });

  it('les tâches FACULTATIVES ne pèsent jamais sur le ratio', () => {
    const sansOptions = calculerCompletion({ ...complet, files: [], websites: [] });
    expect(sansOptions.faites).toBe(4);
    expect(sansOptions.total).toBe(4);
  });

  it('connecteurs et outils sont dits INCONNUS, avec où les régler', () => {
    // On ne les pilote pas encore. Les taire sous-déclarerait la configuration par rapport à l'écran de
    // Meta ; les marquer « à faire » serait un reproche pour une fonction qu'on n'a pas construite.
    const c = calculerCompletion(complet);
    for (const cle of ['connecteurs', 'outils']) {
      expect(tache(c, cle).etat).toBe('inconnue');
      expect(tache(c, cle).raison).toMatch(/WhatsApp Manager/);
      expect(tache(c, cle).requise).toBe(false);
    }
  });

  it('l’inventaire des tâches est FIGÉ, et il vaut celui de l’écran de Meta moins « Tester »', () => {
    // Un inventaire écrit à la main dérive dès qu'on ajoute une ligne. Celui-ci se compare, et il dit
    // pourquoi « Tester » n'y est pas : « avoir testé » n'est pas un état de la configuration.
    const c = calculerCompletion(complet);
    expect(c.taches.map((t) => t.cle).sort()).toEqual(
      ['activation', 'business_info', 'competences', 'connecteurs', 'faq', 'fichiers', 'outils', 'paiement', 'sites'],
    );
  });
});
