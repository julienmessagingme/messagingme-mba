import { describe, it, expect } from 'vitest';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { OFFRES_RECHARGE } from '../src/stripe/offres';
import { TEXTES_BOUTIQUES } from '../scripts/vitrine/boutique-textes';
import { PRIX_NUMERO_AFFICHE_HT_CENTIMES } from '../scripts/vitrine/tunnel-textes';
import { ENTREES } from '../web/lib/registre-vitrine';
import { fichierDe } from '../scripts/vitrine/cas';
import { lire, pagesHtml, texte } from './vitrine-lecture';
import { FAQ } from '../scripts/plugin/faq';
import { OUTILS } from '../src/mcp/outils';
import { DROITS, ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES, type Offre } from '../src/offres/offres';
import { etiquetteDOffre } from '../scripts/vitrine/offres-outils';
import type { Langue } from '../scripts/vitrine/cas-textes';

/**
 * LA PAGE « BOUTIQUES SHOPIFY » (plan `docs/superpowers/plans/2026-10-24-boutiques-shopify.md`). Qu'elle soit égale à sa
 * génération, `tests/vitrine-cas.test.ts` le tient ; ici, ce qu'elle PROMET. Son tunnel du numéro, commun à d'autres
 * pages depuis le 2026-10-30, se teste dans `tests/vitrine-tunnel.test.ts`.
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

  it('« Tout faire depuis la console » mène à la souscription du Pro : la console est celle du Pro (Julien, 2026-10-28)', () => {
    for (const e of boutiques) {
      for (const [langue, adresse] of [['fr', e.fr.adresse], ['en', e.en.adresse]] as const) {
        const html = lire(fichierDe(adresse));
        const libelle = TEXTES_BOUTIQUES.shopify![langue].boutonConsole;
        const liens = [...html.matchAll(/<a class="bouton bouton-trait" href="([^"]+)">([^<]+)<\/a>/g)].filter((m) => m[2] === libelle).map((m) => m[1]);
        // En haut de la page, et dans l'appel final.
        expect(liens, langue).toHaveLength(2);
        for (const l of liens) expect(l, langue).toBe(`https://console.messagingme.app/signup?offre=pro${langue === 'en' ? '&amp;lang=en' : ''}`);
      }
    }
  });

  describe('tout ce que Claude fait pour la boutique (plan `2026-10-28-vitrine-cas-mcp.md`)', () => {
    const html = (langue: Langue) => lire(fichierDe(langue === 'fr' ? boutiques[0]!.fr.adresse : boutiques[0]!.en.adresse));
    const section = (langue: Langue, id: string) =>
      html(langue).match(new RegExp(`<section class="[^"]*" id="${id}">[\\s\\S]*?</section>`))?.[0] ?? '';
    // Le texte visible de chaque étiquette, écrit ici en littéral : un nom d'offre faussé dans le module se verrait.
    const LIBELLES: Readonly<Record<Langue, Readonly<Record<Offre, string>>>> = {
      fr: { base: 'Offre Free', pro: 'Offre Pro', business: 'Offre Business', entreprise: 'Offre Entreprise' },
      en: { base: 'Free plan', pro: 'Pro plan', business: 'Business plan', entreprise: 'Enterprise plan' },
    };
    const etiquette = (langue: Langue, offre: Offre) => `<span class="bt-offre" data-etiquette="${offre}">${LIBELLES[langue][offre]}</span>`;
    it('l’étiquette du module est celle que les tests lisent', () => {
      for (const langue of ['fr', 'en'] as const) for (const o of ['base', 'pro', 'business', 'entreprise'] as const) expect(etiquetteDOffre(o, langue)).toBe(etiquette(langue, o));
    });

    it('chaque outil cité par une carte existe au catalogue du serveur MCP', () => {
      const catalogue = new Set(OUTILS.map((o) => o.nom));
      for (const langue of ['fr', 'en'] as const) {
        for (const b of TEXTES_BOUTIQUES.shopify![langue].claude.besoins) {
          for (const c of b.cartes) for (const o of c.outils) expect(catalogue.has(o), `${langue} : ${c.titre} cite ${o}`).toBe(true);
        }
      }
    });

    it('🔴 chaque carte porte l’étiquette de la plus haute offre de ses outils, lue dans leur fonction', () => {
      for (const langue of ['fr', 'en'] as const) {
        const cartes = section(langue, 'claude').split('<li').slice(1).filter((x) => x.includes('<h4>'));
        const attendues = TEXTES_BOUTIQUES.shopify![langue].claude.besoins.flatMap((b) => b.cartes);
        expect(cartes.length, langue).toBe(attendues.length);
        attendues.forEach((c, i) => {
          // La fonction de chaque outil, relue ici sans le module de la page : `null` = la Free.
          const rangs = ['base', 'pro', 'business', 'entreprise'] as const;
          const fonctions = [...c.outils.map((o) => OUTILS.find((x) => x.nom === o)!.fonction), ...(c.fonction ? [c.fonction] : [])];
          const offre = rangs[Math.max(...fonctions.map((f) => rangs.findIndex((r) => f === null || DROITS[r].fonctions.has(f))))]!;
          expect(cartes[i], `${langue} : ${c.titre}`).toContain(etiquette(langue, offre));
          expect(cartes[i]!.startsWith(offre === 'base' ? '>' : ' class="bt-payante">'), `${langue} : ${c.titre}`).toBe(true);
          for (const o of c.outils) expect(cartes[i], `${langue} : ${c.titre}`).toContain(`<code>${o}</code>`);
        });
        // La page montre bien les trois offres : une étiquette qui ne varie jamais ne prouverait rien.
        for (const offre of ['base', 'pro', 'entreprise'] as const) expect(section(langue, 'claude'), langue).toContain(etiquette(langue, offre));
      }
    });

    it('🔴 la liste repliée porte chaque outil du catalogue une fois et une seule, avec son offre', () => {
      for (const langue of ['fr', 'en'] as const) {
        const liste = section(langue, 'outils');
        expect(liste, langue).toMatch(/<details><summary>/);
        expect(liste, langue).not.toMatch(/<details open/);
        const cites = [...liste.matchAll(/<li><code>([a-z_]+)<\/code>(<span class="bt-offre" data-etiquette="[a-z]+">[^<]*<\/span>)/g)];
        expect(cites.map((m) => m[1]).sort(), langue).toEqual(OUTILS.map((o) => o.nom).sort());
        for (const [, nom, span] of cites) {
          const f = OUTILS.find((o) => o.nom === nom)!.fonction;
          const offre = (['base', 'pro', 'business', 'entreprise'] as const).find((r) => f === null || DROITS[r].fonctions.has(f))!;
          expect(span, `${langue} : ${nom}`).toBe(etiquette(langue, offre));
        }
        expect(liste, langue).toContain(`https://console.messagingme.app/developers/mcp${langue === 'en' ? '?lang=en' : ''}`);
      }
    });

    it('🔴 une ligne « Offre Free » qui nomme une fonction payante dit son offre (relecture du 2026-10-29)', () => {
      const payant = {
        fr: /agent de Meta|scénario|analyse|confi\w* (un|des) fils?|campagne|Inbox|(?<!passer par )la console/i,
        en: /Meta’s agent|scenario|analysis|assign threads|campaign|Inbox|(?<!without )the console/i,
      };
      const offreNommee = /\b(Pro|Business|Entreprise|Enterprise)\b/;
      for (const langue of ['fr', 'en'] as const) {
        const lignes = [...section(langue, 'outils').matchAll(/<li><code>([a-z_]+)<\/code><span class="bt-offre" data-etiquette="base">[^<]*<\/span><span class="bt-quoi">([^<]*)<\/span>/g)];
        expect(lignes.length, langue).toBeGreaterThan(40);
        for (const [, nom, phrase] of lignes) {
          if (payant[langue].test(texte(phrase!))) expect(texte(phrase!), `${langue} : ${nom}`).toMatch(offreNommee);
        }
      }
    });

    it('la phrase d’un outil ne finit jamais sur une abréviation (« excl. »)', () => {
      for (const langue of ['fr', 'en'] as const) {
        for (const [, phrase] of section(langue, 'outils').matchAll(/<span class="bt-quoi">([^<]*)<\/span>/g)) {
          expect(phrase, langue).not.toMatch(/\b(excl|incl|approx|cf|etc)\.$/);
        }
      }
      expect(texte(section('en', 'outils'))).toContain('€3.50 excl. VAT a month');
    });

    it('🔴 le bloc « Ce que le Pro ajoute » dit les chiffres de la grille, et son bouton mène à l’essai du Pro', () => {
      // Ce que le bloc affirme sans chiffre : le relire si la grille change.
      expect(DROITS.pro.limites.badge).toBe(false);
      expect(DROITS.pro.limites.numeroInclus).toBe(true);
      expect(DROITS.pro.limites.envoisModelesMois).toBeNull();
      for (const [langue, contacts, utilisateurs, prix] of [
        ['fr', `${DROITS.pro.limites.contacts!.toLocaleString('fr-FR').replace(/\s/g, ' ')} contacts créés`, `${DROITS.pro.limites.utilisateurs} utilisateurs`, `${PRIX_PRO_HT_CENTIMES.mois / 100} € HT par mois, ${ESSAI_PRO_JOURS} jours d’essai`],
        ['en', `${DROITS.pro.limites.contacts!.toLocaleString('en-US')} contacts created`, `${DROITS.pro.limites.utilisateurs} users`, `€${PRIX_PRO_HT_CENTIMES.mois / 100} excl. VAT a month, a ${ESSAI_PRO_JOURS}-day trial`],
      ] as const) {
        const bloc = section(langue, 'claude').match(/<div class="bt-pro">[\s\S]*?<\/div>/)?.[0] ?? '';
        const lu = texte(bloc);
        expect(lu, langue).toContain(contacts);
        expect(lu, langue).toContain(utilisateurs);
        expect(lu, langue).toContain(prix);
        expect(bloc, langue).toContain(`href="https://console.messagingme.app/signup?offre=pro${langue === 'en' ? '&amp;lang=en' : ''}"`);
      }
    });

    it('la une mène à la section, et la section à la liste repliée', () => {
      for (const langue of ['fr', 'en'] as const) {
        expect(html(langue).match(/<section class="cadre f-une bt-une">[\s\S]*?<\/section>/)?.[0], langue).toContain('href="#claude"');
        expect(section(langue, 'claude'), langue).toContain('href="#outils"');
      }
    });
  });

  it('🔴 la page ne dit jamais « bientôt » : une fonction décidée se dit incluse (Julien)', () => {
    for (const e of boutiques) {
      for (const [adresse, motif] of [[e.fr.adresse, /bientôt|prochainement/i], [e.en.adresse, /\bsoon\b|\bcoming\b/i]] as const) {
        expect(corps(lire(fichierDe(adresse))), adresse).not.toMatch(motif);
      }
    }
  });

  it('les textes des deux langues ont la même forme', () => {
    const { fr, en } = TEXTES_BOUTIQUES.shopify!;
    expect(en.scenario.etapes.length).toBe(fr.scenario.etapes.length);
    expect(en.faq.questions.map((q) => q.id)).toEqual(fr.faq.questions.map((q) => q.id));
    // Les mêmes cartes, avec les mêmes outils : l'étiquette d'offre en dérive, elle est donc la même dans les deux langues.
    const cartesClaude = (t: typeof fr) => t.claude.besoins.map((b) => b.cartes.map((c) => `${c.outils.join(',')}|${c.fonction ?? ''}|${c.icone}`));
    expect(cartesClaude(en)).toEqual(cartesClaude(fr));
    expect(en.claude.pro.liste.length).toBe(fr.claude.pro.liste.length);
  });
});
