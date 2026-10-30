import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * L'INVENTAIRE DU CRÉDIT WHATSAPP (plan du Crédit WhatsApp, tâches 4 et 5). La garde vit dans la fabrique d'envoi : elle
 * ne protège que si TOUT client Meta passe par elle, et son refus ne se lit bien que si chaque chemin qui attrape déjà un
 * numéro bloqué l'attrape aussi. Les deux listes se dérivent du code : un chemin neuf qui n'y est pas rend ce test rouge.
 * Que les neuf méthodes `send*` soient gardées, sans aucun appel à Meta, est tenu par `tests/credit-whatsapp-garde.test.ts`.
 */
const SRC = new URL('../src/', import.meta.url);

function fichiers(dossier: URL, prefixe = 'src/'): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return fichiers(new URL(`${e.name}/`, dossier), `${prefixe}${e.name}/`);
    return e.name.endsWith('.ts') ? [`${prefixe}${e.name}`] : [];
  });
}
const lire = (chemin: string): string => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8');
const TOUS = fichiers(SRC);

/**
 * Les fichiers qui attrapent `NumeroBloqueError` SANS attraper `CreditWhatsappRefus`, chacun avec sa raison. Une raison
 * se relit : plus de soixante caractères, pour qu'elle dise pourquoi et pas seulement « non ».
 */
const EXEMPTES: Record<string, string> = {
  'src/campaign/run-job.ts': 'Il attrape le numéro bloqué à la CONSTRUCTION du client ; la garde du crédit agit envoi par envoi, et le moteur l’attrape en route (arreterSurCredit).',
  'src/http/v1-messages.ts': 'Il relance tout refus qu’il ne traduit pas lui-même au gestionnaire commun, qui traduit le refus du crédit sur toute route (src/server.ts).',
  'src/numero/suspension.ts': 'La question « numéro bloqué » du tour et du fil ; le crédit a la sienne (creditWhatsappBloque), que le fil ne pose pas pour laisser parler l’agent de Meta.',
};

describe('l’inventaire du Crédit WhatsApp', () => {
  it('🔴 un client Meta ne se construit QUE dans la fabrique d’envoi : aucun envoi n’échappe à la garde', () => {
    const constructeurs = TOUS.filter((f) => /new MetaClient\(/.test(lire(f)));
    expect(constructeurs).toEqual(['src/meta/factory.ts']);
  });

  it('🔴 chaque chemin qui attrape un numéro bloqué attrape aussi le refus du crédit, ou dit pourquoi', () => {
    const attrapent = TOUS.filter((f) => /instanceof NumeroBloqueError/.test(lire(f)));
    expect(attrapent.length).toBeGreaterThan(5);
    const oublies = attrapent.filter((f) => !/CreditWhatsappRefus/.test(lire(f)) && EXEMPTES[f] === undefined);
    expect(oublies).toEqual([]);
  });

  it('🔴 l’index partiel de la franchise est un contrat avec SA requête : le prédicat de l’un est le where de l’autre', () => {
    const migration = lire('db/migrations/0264_credit_whatsapp.sql');
    expect(migration).toContain("on credit_whatsapp_provisions (phone_number_id, cree_le) where categorie = 'service' and etat <> 'rendu';");
    const store = lire('src/credit-whatsapp/credit.pg.ts');
    const requete = store.slice(store.indexOf('async serviceDuMois'), store.indexOf('async historique'));
    expect(requete).toContain('where phone_number_id = $1');
    expect(requete).toContain("and categorie = 'service' and etat <> 'rendu'");
  });

  it('chaque exemption a sa raison, et aucune n’est fantôme', () => {
    for (const [f, raison] of Object.entries(EXEMPTES)) {
      expect(raison.length, f).toBeGreaterThan(60);
      const texte = lire(f);
      expect(/instanceof NumeroBloqueError/.test(texte), `${f} n’attrape plus de numéro bloqué : retirer l’exemption`).toBe(true);
      expect(/CreditWhatsappRefus/.test(texte), `${f} attrape désormais le crédit : retirer l’exemption`).toBe(false);
    }
  });
});
