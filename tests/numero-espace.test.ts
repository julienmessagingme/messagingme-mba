import { describe, it, expect } from 'vitest';
import { creerNumeroDeLEspace, creerWabaDeLEspace, NUMERO_ESPACE_TTL_MS } from '../src/meta/numero-espace';
import { creerNoteDeQualite, NOTE_QUALITE_TTL_MS } from '../src/campaign/note-qualite';
import type { QualityRating } from '../src/campaign/types';
import { config } from '../src/config';

/**
 * LE NUMÉRO DE L'ESPACE, DEMANDÉ UNE FOIS ET PAS UNE FOIS PAR DESTINATAIRE.
 *
 * 🔴 CE QUI SE JOUE ICI EST UNE FACTURE, PAS UNE ÉLÉGANCE. Cinq sites du câblage du runtime lisaient ce
 * numéro DANS la boucle d'envoi : 5 000 destinataires valaient 5 000 requêtes pour une réponse qui ne bouge
 * pas, prises sur un pool de 8 connexions partagé avec les tours d'agent et les webhooks.
 *
 * 🔴 ET LE CAS QUI DÉCIDE DE LA SÛRETÉ DU CACHE EST CELUI DE LA RÉPONSE NULLE. Un espace sans numéro qu'on
 * mettrait en cache verrait « aucun numéro » gelé pendant toute la durée de vie, dans le WORKER, alors que
 * le numéro se branche depuis l'API : les deux process ont chacun leur cache et rien ne les synchronise.
 * Un client qui vient de connecter son premier numéro verrait sa campagne échouer sans comprendre.
 */
describe('le numéro Meta de l’espace, mis en cache', () => {
  /** Un banc qui compte les lectures en base. */
  function banc(reponses: Array<string | null>, ttl = NUMERO_ESPACE_TTL_MS) {
    let lectures = 0;
    let horloge = 1_000;
    const numero = creerNumeroDeLEspace(
      async () => {
        const r = reponses[Math.min(lectures, reponses.length - 1)];
        lectures += 1;
        return r ?? null;
      },
      ttl,
      () => horloge,
    );
    return { numero, lectures: () => lectures, avancer: (ms: number) => { horloge += ms; } };
  }

  it('🔴 dix envois d’affilée ne coûtent QU’UNE lecture', async () => {
    const b = banc(['pn-1']);
    for (let i = 0; i < 10; i += 1) expect(await b.numero('t1')).toBe('pn-1');
    expect(b.lectures(), 'le numéro est relu par envoi, la campagne paie une requête par destinataire').toBe(1);
  });

  it('🔴 les appels SIMULTANÉS sont mutualisés, pas seulement les successifs', async () => {
    // Sans la mutualisation des appels en vol, quatre campagnes qui démarrent dans la même milliseconde
    // trouvent toutes le cache vide et partent toutes en base : exactement le moment où ça fait mal.
    const b = banc(['pn-1']);
    const tous = await Promise.all([b.numero('t1'), b.numero('t1'), b.numero('t1'), b.numero('t1')]);
    expect(tous).toEqual(['pn-1', 'pn-1', 'pn-1', 'pn-1']);
    expect(b.lectures()).toBe(1);
  });

  it('🔴 une réponse NULLE n’est JAMAIS mise en cache', async () => {
    // C'est ce qui rend ce cache acceptable sur une décision : l'instant où la réponse change est celui où
    // un client branche son premier numéro, et aucune invalidation ne peut traverser les deux process.
    const b = banc([null]);
    expect(await b.numero('t1')).toBeNull();
    expect(await b.numero('t1')).toBeNull();
    expect(await b.numero('t1')).toBeNull();
    expect(b.lectures(), 'un « aucun numéro » a été gelé en cache').toBe(3);
  });

  it('🔴 et le numéro branché juste après est vu TOUT DE SUITE', async () => {
    // Le pendant du cas précédent, et le seul qui prouve ce qu'on cherchait vraiment : pas « null n'est pas
    // en cache », mais « le client qui vient de brancher son numéro peut envoyer ».
    const b = banc([null, 'pn-neuf']);
    expect(await b.numero('t1')).toBeNull();
    expect(await b.numero('t1'), 'le client a branché son numéro et le worker ne le voit pas').toBe('pn-neuf');
  });

  it('⚠️ passé la durée de vie, on relit', async () => {
    const b = banc(['pn-1']);
    await b.numero('t1');
    b.avancer(NUMERO_ESPACE_TTL_MS + 1);
    await b.numero('t1');
    expect(b.lectures()).toBe(2);
  });

  it('⚠️ deux espaces ne se partagent pas une entrée', async () => {
    // Le pire défaut possible pour ce cache : servir à un client le numéro d'un autre.
    let vus: string[] = [];
    const numero = creerNumeroDeLEspace(async (t) => { vus.push(t); return `pn-${t}`; });
    expect(await numero('t1')).toBe('pn-t1');
    expect(await numero('t2')).toBe('pn-t2');
    expect(vus).toEqual(['t1', 't2']);
  });
});

/**
 * LA NOTE DE QUALITÉ, ET POURQUOI LA METTRE EN CACHE NE DÉSARME PAS L'ARRÊT D'URGENCE.
 *
 * 🔴 Elle commande une MISE EN PAUSE de la campagne quand Meta passe le numéro au ROUGE. Mettre en cache une
 * valeur qui commande un arrêt demande une justification mesurée, et la voici : la colonne n'est pas écrite en
 * temps réel, elle est rafraîchie par le balayage `statut-numeros` toutes les VINGT MINUTES. Un cache de
 * trente secondes ne peut donc pas devenir la raison d'un retard.
 */
describe('la note de qualité du numéro, mise en cache', () => {
  function banc(notes: QualityRating[], ttl = NOTE_QUALITE_TTL_MS) {
    let lectures = 0;
    let horloge = 1_000;
    const note = creerNoteDeQualite(async () => {
      const n = notes[Math.min(lectures, notes.length - 1)] ?? 'UNKNOWN';
      lectures += 1;
      return n;
    }, ttl, () => horloge);
    return { note, lectures: () => lectures, avancer: (ms: number) => { horloge += ms; } };
  }

  it('🔴 cinq mille envois ne coûtent QU’UNE lecture', async () => {
    const b = banc(['GREEN']);
    for (let i = 0; i < 50; i += 1) expect(await b.note('pn-1')).toBe('GREEN');
    expect(b.lectures()).toBe(1);
  });

  it('🔴 et le ROUGE est vu dès que la durée de vie expire, donc bien avant le balayage qui l’écrit', async () => {
    // C'est le cas qui prouve que le garde-fou n'est pas désarmé : la note bascule, et le cache ne la retient
    // que trente secondes, contre vingt minutes pour la cadence du balayage qui alimente la colonne.
    const b = banc(['GREEN', 'RED']);
    expect(await b.note('pn-1')).toBe('GREEN');
    b.avancer(NOTE_QUALITE_TTL_MS + 1);
    expect(await b.note('pn-1'), 'une note au ROUGE reste invisible : la campagne continue d’envoyer').toBe('RED');
  });

  it('⚠️ deux numéros ne se partagent pas une note', async () => {
    const vus: string[] = [];
    const note = creerNoteDeQualite(async (pn) => { vus.push(pn); return pn === 'pn-2' ? 'RED' : 'GREEN'; });
    expect(await note('pn-1')).toBe('GREEN');
    expect(await note('pn-2'), 'le ROUGE d’un numéro a été masqué par le vert d’un autre').toBe('RED');
    expect(vus).toEqual(['pn-1', 'pn-2']);
  });
});

describe('le WABA de l’espace, mis en cache', () => {
  it('🔴 il suit la MÊME règle : positives en cache, nulles relues', async () => {
    let lectures = 0;
    const reponses: Array<string | null> = [null, 'waba-1', 'waba-1'];
    const waba = creerWabaDeLEspace(async () => { const r = reponses[lectures] ?? null; lectures += 1; return r; });
    expect(await waba('t1')).toBeNull();
    expect(await waba('t1'), 'le WABA branché juste après reste invisible').toBe('waba-1');
    expect(await waba('t1')).toBe('waba-1');
    expect(lectures, 'le WABA positif est relu alors qu’il est en cache').toBe(2);
  });
});

/**
 * 🔴 L'INVARIANT QUI NE VIT DANS AUCUN DES DEUX FICHIERS : L'ÉCART ENTRE DEUX CONSTANTES.
 *
 * Les cas ci-dessus vérifient le MÉCANISME (la note expire, donc le ROUGE finit par être vu) et pas la
 * VALEUR. Mesuré par mutation : porter la durée de vie à vingt-quatre heures ne les fait pas échouer, parce
 * qu'ils avancent l'horloge de la constante elle-même. Or ici c'est la valeur qui porte la sûreté, puisque
 * tout le raisonnement tient à ce qu'elle soit très inférieure à la cadence du balayage qui écrit la colonne.
 *
 * ⚠️ C'est le motif « deux constantes de deux fichiers dont c'est l'ÉCART qui porte l'invariant » : chacune
 * est plausible seule, et aucun des deux fichiers ne peut le voir.
 */
describe('la durée de vie du cache de qualité reste loin sous le balayage qui l’alimente', () => {
  it('🔴 au moins dix fois plus courte que la cadence du balayage de statut', () => {
    expect(
      NOTE_QUALITE_TTL_MS * 10,
      `la note de qualité est mise en cache ${NOTE_QUALITE_TTL_MS} ms alors que le balayage qui l’écrit passe toutes les ${config.PHONE_STATUS_SWEEP_INTERVAL_MS} ms : le cache devient la raison pour laquelle un ROUGE est vu en retard`,
    ).toBeLessThanOrEqual(config.PHONE_STATUS_SWEEP_INTERVAL_MS);
  });
});
