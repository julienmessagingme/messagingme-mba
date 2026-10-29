import { describe, it, expect } from 'vitest';
import { PRIX_NUMERO_HT_CENTIMES } from '../src/stripe/abonnement';
import { OFFRES_RECHARGE } from '../src/stripe/offres';
import { PRIX_NUMERO_AFFICHE_HT_CENTIMES, TEXTES_BOUTIQUES } from '../scripts/vitrine/boutique-textes';
import { ENTREES } from '../web/lib/registre-vitrine';
import { fichierDe } from '../scripts/vitrine/cas';
import { lire, pagesHtml, texte } from './vitrine-lecture';
import { FAQ } from '../scripts/plugin/faq';
import { DEPOT_PLUGIN } from '../web/lib/demarrer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTILS } from '../src/mcp/outils';
import { DROITS, ESSAI_PRO_JOURS, PRIX_PRO_HT_CENTIMES, type Offre } from '../src/offres/offres';
import { etiquetteDOffre } from '../scripts/vitrine/offres-outils';
import type { Langue } from '../scripts/vitrine/cas-textes';

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

  it('🔴 la page ne dit plus « QR code » : face au client, c’est le numéro WhatsApp Business (Julien, 2026-10-27)', () => {
    for (const e of boutiques) {
      for (const adresse of [e.fr.adresse, e.en.adresse]) expect(corps(lire(fichierDe(adresse))), adresse).not.toMatch(/QR/);
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

  it('le chapeau et l’étape du guide annoncent le nombre de questions du plus long parcours de l’arbre', () => {
    for (const [langue, mots] of [['fr', ['', 'une', 'deux', 'trois', 'quatre', 'cinq']], ['en', ['', 'one', 'two', 'three', 'four', 'five']]] as const) {
      const { questions, chapeau } = TEXTES_BOUTIQUES.shopify![langue].numero;
      const profondeur = (id: string): number => {
        const q = questions.find((x) => x.id === id);
        return q ? 1 + Math.max(...q.reponses.map((r) => (r.vers ? profondeur(r.vers) : 0))) : 0;
      };
      const max = profondeur(questions[0]!.id);
      expect(chapeau, langue).toContain(`${mots[max]} question`);
      // « Question n sur … » et la jauge lisent le même maximum, calculé par la génération (`data-max`).
      const html = lire(fichierDe(langue === 'fr' ? boutiques[0]!.fr.adresse : boutiques[0]!.en.adresse));
      expect(html, langue).toContain(`data-max="${max}"`);
      expect(html, langue).toContain(langue === 'fr' ? `Question 1 sur ${max} au plus` : `Question 1 of ${max} at most`);
    }
  });

  it('🔴 le numéro WhatsApp Business (l’application reliée comme un appareil) ne promet aucun message qui part, et dit que rien ne part en premier', () => {
    for (const [langue, part, rien, mot] of [
      ['fr', /partent|envoie/i, /rien ne part en premier/i, /numéro WhatsApp Business/],
      ['en', /go out|sends/i, /nothing goes out first/i, /WhatsApp Business number/],
    ] as const) {
      const { questions, issues, lexique } = TEXTES_BOUTIQUES.shopify![langue].numero;
      // Sa carte : celle dont le bouton mène à l'issue `qr`.
      const choix = questions.find((q) => q.reponses.some((r) => r.vers === 'qr'));
      expect(choix?.voies, langue).toBeDefined();
      const carte = choix!.voies![choix!.reponses.filter((r) => r.vers).findIndex((r) => r.vers === 'qr')]!;
      for (const ligne of carte.plus) expect(ligne, `${langue} : ${carte.titre}`).not.toMatch(part);
      expect(carte.moins.some((l) => rien.test(l)), `${langue} : ${carte.titre}`).toBe(true);
      // Son issue, et son mot du lexique, le disent aussi.
      expect(issues.find((x) => x.id === 'qr')!.textes.some((t) => rien.test(t)), langue).toBe(true);
      expect(lexique.termes.find((t) => mot.test(t.terme))!.definition, langue).toMatch(rien);
      // Et la demande à coller ne lui fait envoyer aucun message de la boutique.
      expect(issues.find((x) => x.id === 'qr')!.demande, langue).not.toMatch(/relance|confirmation|expédition|reminder|shipping/i);
    }
  });

  it('🔴 seule la Free mène au numéro WhatsApp Business : le Pro demande un numéro API (Julien, 2026-10-27)', () => {
    for (const langue of ['fr', 'en'] as const) {
      const { questions, issues } = TEXTES_BOUTIQUES.shopify![langue].numero;
      const depuis = (offre: 'free' | 'pro'): Set<string> => {
        const atteints = new Set<string>();
        const aller = (id: string): void => {
          if (atteints.has(id)) return;
          atteints.add(id);
          for (const r of questions.find((x) => x.id === id)?.reponses ?? []) if (r.vers) aller(r.vers);
        };
        aller(questions[0]!.reponses.find((r) => r.offre === offre)!.vers!);
        return atteints;
      };
      expect(depuis('pro').has('qr'), langue).toBe(false);
      expect(depuis('free').has('qr'), langue).toBe(true);
      // Le bout du tunnel en Pro (la console et le pas-à-pas) existe exactement pour les issues que le Pro atteint.
      const pro = depuis('pro');
      for (const x of issues) expect(Boolean(x.pasAPas), `${langue} : ${x.id}`).toBe(pro.has(x.id));
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
        // Le Pro porte la sienne : le compte Meta Business qu'il demande se crée en chemin.
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
        // Les mots du guide se déplient sous le tunnel, sans script aussi.
        expect(html).toContain('<details class="bt-lexique">');
        expect(html).toMatch(/<div class="bt-questions" hidden>/);
        // L'étape et sa jauge n'ont de sens qu'avec le script : cachées sans lui (`.bt-guide [hidden]` dans site.css).
        expect(html).toMatch(/<div class="bt-progression"[^>]*\shidden>/);
        for (const x of TEXTES_BOUTIQUES.shopify![langue].numero.issues) {
          expect(html).toMatch(new RegExp(`data-chemin="${x.id}"[^>]*>\\s*<p class="bt-situation">`));
        }
      }
    }
    expect(lire('site.js')).toContain("querySelectorAll('[data-guide-numero]')");
    expect(lire('site.css')).toContain('.bt-guide [hidden]{display:none}');
  });

  it('une question à cartes porte, sous chaque carte, le bouton de même rang (Julien, 2026-10-27)', () => {
    for (const e of boutiques) {
      for (const [langue, adresse] of [['fr', e.fr.adresse], ['en', e.en.adresse]] as const) {
        const html = lire(fichierDe(adresse));
        const aCartes = TEXTES_BOUTIQUES.shopify![langue].numero.questions.filter((q) => q.voies);
        // L'offre, puis le numéro de la Free.
        expect(aCartes.map((q) => q.id), langue).toEqual(['offre', 'type-numero']);
        for (const q of aCartes) {
          const menent = q.reponses.filter((r) => r.vers);
          expect(menent.length, `${langue} : ${q.id}`).toBe(q.voies!.length);
          const fieldset = html.match(new RegExp(`<fieldset class="bt-question" data-question="${q.id}"[\\s\\S]*?</fieldset>`))?.[0] ?? '';
          const cartes = fieldset.split('<div class="bt-voie-choix">').slice(1);
          expect(cartes.length, `${langue} : ${q.id}`).toBe(q.voies!.length);
          cartes.forEach((c, i) => {
            expect(c, `${langue} : ${q.id}, carte ${i + 1}`).toContain('<section class="bt-voie">');
            expect(c.match(/data-vers="([^"]+)"/)?.[1], `${langue} : ${q.id}, carte ${i + 1}`).toBe(menent[i]!.vers);
          });
        }
      }
    }
  });

  it('chaque issue finit sur les boutons de son offre : en Free le plugin, son dépôt et la demande à coller, en Pro la console et le pas-à-pas', () => {
    for (const e of boutiques) {
      for (const [langue, adresse, plugin, offre] of [
        ['fr', e.fr.adresse, '/developpeurs/installer-le-plugin/', /offre Free/],
        ['en', e.en.adresse, '/en/developers/install-the-plugin/', /Free plan/],
      ] as const) {
        const html = lire(fichierDe(adresse));
        for (const x of TEXTES_BOUTIQUES.shopify![langue].numero.issues) {
          const article = html.match(new RegExp(`<article class="bt-chemin" data-chemin="${x.id}"[\\s\\S]*?</article>`))?.[0] ?? '';
          const blocs = new Map(article.split('<div class="bt-appels" data-offre="').slice(1).map((b) => [b.slice(0, b.indexOf('"')), b] as const));
          const free = blocs.get('free') ?? '';
          expect(free, `${langue} : ${x.id}`).toContain(`href="${plugin}"`);
          expect(free, `${langue} : ${x.id}`).toContain(`href="${DEPOT_PLUGIN}"`);
          expect(free, `${langue} : ${x.id}`).toContain(`<p id="demande-${x.id}">`);
          expect(free, `${langue} : ${x.id}`).toContain(`data-copier="demande-${x.id}"`);
          // La demande reprend ce que le tunnel a déduit, l'offre la première.
          expect(x.demande, `${langue} : ${x.id}`).toMatch(offre);
          if (x.pasAPas) {
            const pro = blocs.get('pro') ?? '';
            // `?offre=pro` : l'inscription mène à la souscription du Pro, pas au tunnel de la Free (`web/lib/session.ts`).
            expect(pro, `${langue} : ${x.id}`).toContain(`href="https://console.messagingme.app/signup?offre=pro${langue === 'en' ? '&amp;lang=en' : ''}"`);
            expect(pro, `${langue} : ${x.id}`).toContain(`href="${x.pasAPas}"`);
            expect(existsSync(join(process.cwd(), 'site', x.pasAPas, 'index.html')), x.pasAPas).toBe(true);
          } else {
            expect(blocs.has('pro'), `${langue} : ${x.id} n'existe pas en Pro`).toBe(false);
          }
        }
      }
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
    const offres = (t: typeof fr) => t.numero.questions.flatMap((q) => q.reponses.map((r) => r.offre ?? ''));
    expect(offres(en)).toEqual(offres(fr));
    expect(en.numero.issues.map((x) => Boolean(x.pasAPas))).toEqual(fr.numero.issues.map((x) => Boolean(x.pasAPas)));
  });
});
