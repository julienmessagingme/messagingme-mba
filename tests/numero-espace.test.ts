import { describe, it, expect } from 'vitest';
import { creerNumeroDeLEspace, NUMERO_ESPACE_TTL_MS } from '../src/meta/numero-espace';

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
