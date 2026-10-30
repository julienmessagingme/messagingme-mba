import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEXTES_TUNNEL } from '../scripts/vitrine/tunnel-textes';
import { FAQ } from '../scripts/plugin/faq';
import { ISSUE_API, ISSUE_TELECHARGER, META_BUSINESS_URL, QUESTION_APPLICATION, QUESTION_COMPTE } from '../web/lib/questions-numero';

/**
 * LA CONSOLE POSE LES QUESTIONS DE LA VITRINE (2026-10-30, plan `docs/superpowers/plans/2026-10-30-tunnel-numero-console-plugin.md`).
 * L'arbre de Julien vit dans `scripts/vitrine/tunnel-textes.ts` ; la page « Connecter WhatsApp » en reprend les questions 2
 * et 3 (`web/lib/questions-numero.ts`), qui ne peut pas importer la vitrine. Retoucher l'une sans l'autre ferait poser
 * deux arbres différents : ce test compare au mot près, balises et espaces insécables de la vitrine retirés.
 */
const texte = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');

describe('la console pose les questions du tunnel de la vitrine', () => {
  for (const langue of ['fr', 'en'] as const) {
    const v = TEXTES_TUNNEL[langue];
    const question = (id: string) => v.questions.find((q) => q.id === id)!;
    const issue = (id: string) => v.issues.find((x) => x.id === id)!;

    it(`${langue} : « Avez-vous un compte Meta Business ? », ses trois réponses et leurs notes`, () => {
      const q = question('compte');
      expect(QUESTION_COMPTE.texte[langue]).toBe(texte(q.texte));
      expect(QUESTION_COMPTE.precision[langue]).toBe(texte(q.precision!));
      expect([QUESTION_COMPTE.oui, QUESTION_COMPTE.non, QUESTION_COMPTE.nsp].map((r) => r[langue])).toEqual(q.reponses.map((r) => r.libelle));
      // Oui mène au numéro API, Non et « Je ne sais pas » à la question de l'application.
      expect(q.reponses.map((r) => r.vers)).toEqual(['api', 'application', 'application']);
      expect(QUESTION_COMPTE.noteNon[langue]).toBe(texte(q.reponses[1]!.note!));
      const n = QUESTION_COMPTE.noteNsp;
      expect(`${n.avant[langue]}business.facebook.com${n.apres[langue]}`).toBe(texte(q.reponses[2]!.note!));
      expect(q.reponses[2]!.note).toContain(`href="${META_BUSINESS_URL}"`);
    });

    it(`${langue} : « Avez-vous déjà l’application WhatsApp Business ? », Oui la garde, Non la fait télécharger`, () => {
      const q = question('application');
      expect(QUESTION_APPLICATION.texte[langue]).toBe(texte(q.texte));
      expect(QUESTION_APPLICATION.precision[langue]).toBe(texte(q.precision!));
      expect([QUESTION_APPLICATION.oui, QUESTION_APPLICATION.non].map((r) => r[langue])).toEqual(q.reponses.map((r) => r.libelle));
      expect(q.reponses.map((r) => r.vers)).toEqual(['garder', 'telecharger']);
    });

    it(`${langue} : les issues que la console reprend`, () => {
      const api = issue('api');
      expect(ISSUE_API.titre[langue]).toBe(texte(api.titre));
      expect(ISSUE_API.garder[langue]).toBe(texte(api.autre!.question));
      expect(ISSUE_API.lien[langue]).toBe(texte(api.autre!.lien));
      const t = issue('telecharger');
      expect(ISSUE_TELECHARGER.titre[langue]).toBe(texte(t.titre));
      // Brancher tout de suite, puis le numéro trop neuf : la première et la dernière phrase de l'issue de la vitrine.
      expect(ISSUE_TELECHARGER.textes.map((x) => x[langue])).toEqual([texte(t.textes[0]!), texte(t.textes[t.textes.length - 1]!)]);
    });
  }

  it('🔴 aucun chiffre de jours pour le numéro trop neuf : Meta n’en publie aucun', () => {
    for (const x of ISSUE_TELECHARGER.textes) expect(`${x.fr} ${x.en}`).not.toMatch(/\d/);
  });
});

describe('le plugin pose les mêmes questions, sans QR code', () => {
  const lire = (chemin: string) => readFileSync(join(process.cwd(), chemin), 'utf8');
  const en = TEXTES_TUNNEL.en;
  const q = (id: string) => texte(en.questions.find((x) => x.id === id)!.texte);

  it('🔴 la skill de mise en service : l’offre, le compte Meta Business, puis l’application, dans cet ordre', () => {
    const skill = lire('plugin/skills/mise-en-service/SKILL.md');
    const rangs = ['**The plan: Free or Pro?**', `**"${q('compte')}"**`, `**"${q('application')}"**`].map((m) => skill.indexOf(m));
    expect(rangs.every((r) => r > 0), rangs.join(',')).toBe(true);
    expect([...rangs].sort((a, b) => a - b)).toEqual(rangs);
    // Le numéro trop neuf se dit sans chiffre, et le QR code n'est plus nommé que pour dire qu'il n'est plus proposé.
    expect(skill).toContain('Never give a number of days');
    expect(skill).toContain('**The QR code link is no longer offered**');
    expect(skill).not.toMatch(/On the QR code track|By QR code, to answer/);
  });

  it('🔴 ni le README ni la FAQ ne proposent le QR code ou l’appareil lié', () => {
    expect(lire('plugin/README.md')).not.toMatch(/QR|linked device/i);
    for (const e of FAQ) {
      expect(`${e.question.fr} ${e.question.en} ${e.reponse.fr} ${e.reponse.en}`, e.id).not.toMatch(/QR|appareil lié|linked device/i);
    }
  });
});
