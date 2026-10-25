import { describe, it, expect } from 'vitest';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { OFFRES_RECHARGE } from '../src/stripe/offres';
import { PRIX_NUMERO_AFFICHE_HT_CENTIMES, TEXTES_BOUTIQUES } from '../scripts/vitrine/boutique-textes';
import { ENTREES } from '../web/lib/registre-vitrine';
import { fichierDe } from '../scripts/vitrine/cas';
import { lire, pagesHtml, texte } from './vitrine-lecture';
import { FAQ } from '../scripts/plugin/faq';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * LA PAGE « BOUTIQUES SHOPIFY » (plan `docs/superpowers/plans/2026-10-24-boutiques-shopify.md`). Qu'elle soit égale à sa
 * génération, `tests/vitrine-cas.test.ts` le tient ; ici, ce qu'elle PROMET.
 *
 * 🔴 Un numéro relié par QR code ne fait que RÉPONDRE (décision de Julien du 2026-10-24, après la mesure : écrire en
 * premier à un inconnu depuis un tel numéro le fait couper). Toute phrase de la page qui nomme le QR code dit donc qu'il
 * sert à répondre ; une phrase qui lui promettrait les messages de la boutique sans le dire rend ce test rouge.
 */
const boutiques = ENTREES.filter((e) => e.enLigne && e.nature === 'boutique');
const corps = (html: string): string => texte(html
  .replace(/<header class="cadre entete">[\s\S]*?<\/header>/, '')
  .replace(/<footer class="pied">[\s\S]*?<\/footer>/, '')
  .replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, ''));
const phrases = (t: string): string[] => t.split(/(?<=[.!?])\s+|\n/).map((x) => x.trim()).filter((x) => x !== '');

describe('la page Boutiques Shopify', () => {
  it('existe dans les deux langues, au menu Solutions de chaque page', () => {
    expect(boutiques.map((e) => e.cle)).toEqual(['shopify']);
    for (const e of boutiques) {
      expect(lire(fichierDe(e.fr.adresse))).toContain('<html lang="fr"');
      expect(lire(fichierDe(e.en.adresse))).toContain('<html lang="en"');
      for (const p of pagesHtml().filter((x) => lire(x).includes('<header class="cadre entete">'))) {
        const anglaise = p.startsWith('en/');
        expect(lire(p), p).toContain(`href="${anglaise ? e.en.adresse : e.fr.adresse}"`);
      }
    }
  });

  it('cite les prix du code : le numéro fourni et la recharge la plus petite du crédit IA', () => {
    expect(PRIX_NUMERO_AFFICHE_HT_CENTIMES).toBe(PRIX_NUMERO_HT_CENTIMES);
    expect(OFFRES_RECHARGE).toContain('refill_5');
    const fr = corps(lire(fichierDe(boutiques[0]!.fr.adresse)));
    expect(fr).toContain('3,50 € HT par mois');
    expect(fr).toContain('dès 5 € HT');
  });

  it('🔴 toute phrase qui nomme le QR code dit qu’il sert à RÉPONDRE, dans les deux langues', () => {
    for (const e of boutiques) {
      for (const [langue, adresse, verbe] of [['fr', e.fr.adresse, /répond/i], ['en', e.en.adresse, /answer/i]] as const) {
        const qr = phrases(corps(lire(fichierDe(adresse)))).filter((x) => /QR/.test(x) && !x.endsWith('?'));
        expect(qr.length, `${langue} : la page parle du QR code`).toBeGreaterThan(0);
        for (const x of qr) expect(x, `${langue} : ${x}`).toMatch(verbe);
      }
    }
  });

  it('le guide du numéro est un arbre : chaque réponse mène quelque part, tout se rejoint, rien ne boucle', () => {
    for (const langue of ['fr', 'en'] as const) {
      const { questions, issues } = TEXTES_BOUTIQUES.shopify![langue].numero;
      const qIds = questions.map((q) => q.id);
      const iIds = issues.map((x) => x.id);
      expect(new Set([...qIds, ...iIds]).size, `${langue} : identifiants uniques`).toBe(qIds.length + iIds.length);
      const atteints = new Set<string>();
      const parcourir = (id: string, chemin: readonly string[]): void => {
        expect(chemin, `${langue} : boucle sur ${id}`).not.toContain(id);
        atteints.add(id);
        const q = questions.find((x) => x.id === id);
        if (!q) {
          expect(iIds, `${langue} : ${id} n'est ni une question ni une issue`).toContain(id);
          return;
        }
        // Une seule réponse sans destination, et seulement si la question a une aide à déplier.
        const sansVers = q.reponses.filter((r) => !r.vers);
        expect(sansVers.length, `${langue} : ${id}`).toBeLessThanOrEqual(q.aide ? 1 : 0);
        for (const r of q.reponses) if (r.vers) parcourir(r.vers, [...chemin, id]);
      };
      parcourir(qIds[0]!, []);
      expect([...atteints].sort(), `${langue} : une question ou une issue que rien n'atteint`).toEqual([...qIds, ...iIds].sort());
    }
    // Les deux langues ont le même arbre.
    const forme = (l: 'fr' | 'en') => TEXTES_BOUTIQUES.shopify![l].numero.questions.map((q) => `${q.id}:${q.reponses.map((r) => r.vers ?? '?').join(',')}`);
    expect(forme('en')).toEqual(forme('fr'));
  });

  it('le chapeau du guide annonce le nombre de questions du plus long parcours de l’arbre', () => {
    for (const [langue, mots] of [['fr', ['', 'une', 'deux', 'trois', 'quatre', 'cinq']], ['en', ['', 'one', 'two', 'three', 'four', 'five']]] as const) {
      const { questions, chapeau } = TEXTES_BOUTIQUES.shopify![langue].numero;
      const profondeur = (id: string): number => {
        const q = questions.find((x) => x.id === id);
        return q ? 1 + Math.max(...q.reponses.map((r) => (r.vers ? profondeur(r.vers) : 0))) : 0;
      };
      expect(chapeau, langue).toContain(`${mots[profondeur(questions[0]!.id)]} question`);
    }
  });

  it('🔴 la voie QR code d’une issue à choix ne promet aucun message qui part, et dit que rien ne part en premier', () => {
    for (const [langue, part, rien] of [['fr', /partent|envoie/i, /rien ne part en premier/i], ['en', /go out|sends/i, /nothing goes out first/i]] as const) {
      const { issues, lexique } = TEXTES_BOUTIQUES.shopify![langue].numero;
      const choix = issues.filter((x) => x.voies);
      expect(choix.length, langue).toBeGreaterThan(0);
      for (const x of choix) {
        const qr = x.voies!.filter((v) => /QR/.test(v.titre));
        expect(qr.length, `${langue} : ${x.id}`).toBe(1);
        for (const ligne of qr[0]!.plus) expect(ligne, `${langue} : ${x.id}`).not.toMatch(part);
        expect(qr[0]!.moins.some((l) => rien.test(l)), `${langue} : ${x.id}`).toBe(true);
      }
      // Le mot « QR code » du lexique le dit aussi.
      expect(lexique.termes.find((t) => /QR/.test(t.terme))!.definition, langue).toMatch(rien);
    }
  });

  it('🔴 l’agent IA n’est jamais dit gratuit, ni sur la page ni dans la FAQ du plugin : il consomme le crédit prépayé', () => {
    const fr = /agent IA[^.]*gratuit|gratuit[^.]*agent IA/i;
    const en = /AI agent[^.]*(for free|free of charge)|(for free|free of charge)[^.]*AI agent/i;
    for (const e of boutiques) {
      for (const [adresse, motif] of [[e.fr.adresse, fr], [e.en.adresse, en]] as const) {
        for (const x of phrases(corps(lire(fichierDe(adresse))))) expect(x, adresse).not.toMatch(motif);
      }
    }
    for (const q of FAQ) {
      for (const x of phrases(q.reponse.fr)) expect(x, q.id).not.toMatch(fr);
      for (const x of phrases(q.reponse.en)) expect(x, q.id).not.toMatch(en);
    }
  });

  it('🔴 la page ne dit jamais « coexistence » : face au client, c’est « garder votre application » (Julien, 2026-10-25)', () => {
    for (const e of boutiques) {
      for (const adresse of [e.fr.adresse, e.en.adresse]) expect(corps(lire(fichierDe(adresse))), adresse).not.toMatch(/coexist/i);
    }
    // Ni le README du dépôt public du plugin, ni la FAQ qu'il publie (aussi sur les pages développeurs).
    expect(readFileSync(join(process.cwd(), 'plugin/README.md'), 'utf8')).not.toMatch(/coexist/i);
    for (const q of FAQ) expect(`${q.question.fr} ${q.question.en} ${q.reponse.fr} ${q.reponse.en}`, q.id).not.toMatch(/coexist/i);
  });

  it('chaque note de réponse est reliée à son bouton, et seulement sur une réponse qui mène quelque part', () => {
    for (const e of boutiques) {
      for (const [langue, adresse] of [['fr', e.fr.adresse], ['en', e.en.adresse]] as const) {
        const html = lire(fichierDe(adresse));
        // Le « Non » au compte Meta Business porte la sienne : rien n'est à préparer.
        expect(TEXTES_BOUTIQUES.shopify![langue].numero.questions.some((q) => q.reponses.some((r) => r.note)), langue).toBe(true);
        for (const q of TEXTES_BOUTIQUES.shopify![langue].numero.questions) {
          q.reponses.forEach((r, k) => {
            if (!r.note) return;
            expect(r.vers, `${langue} : ${q.id}`).toBeTruthy();
            expect(html).toContain(`data-note="note-${q.id}-${k}"`);
            expect(html).toContain(`<p class="bt-note-reponse" id="note-${q.id}-${k}" role="status" hidden>`);
          });
        }
      }
    }
  });

  it('le guide du numéro se lit sans script : les questions cachées, chaque issue avec sa situation', () => {
    for (const e of boutiques) {
      for (const [langue, adresse] of [['fr', e.fr.adresse], ['en', e.en.adresse]] as const) {
        const html = lire(fichierDe(adresse));
        expect(html).toContain('data-guide-numero');
        expect(html).toContain('<div class="bt-lexique">');
        expect(html).toMatch(/<div class="bt-questions" hidden>/);
        for (const x of TEXTES_BOUTIQUES.shopify![langue].numero.issues) {
          expect(html).toMatch(new RegExp(`data-chemin="${x.id}"[^>]*>\\s*<p class="bt-situation">`));
        }
      }
    }
    expect(lire('site.js')).toContain("querySelectorAll('[data-guide-numero]')");
  });

  it('les textes des deux langues ont la même forme', () => {
    const { fr, en } = TEXTES_BOUTIQUES.shopify!;
    expect(en.scenario.etapes.length).toBe(fr.scenario.etapes.length);
    expect(en.faq.questions.map((q) => q.id)).toEqual(fr.faq.questions.map((q) => q.id));
    expect(en.ensuite.cartes.map((c) => Boolean(c.offre))).toEqual(fr.ensuite.cartes.map((c) => Boolean(c.offre)));
  });
});
