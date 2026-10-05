import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 🔴 L'ASTERISK DU PONT N'EXÉCUTE JAMAIS CE QUE L'APPELANT ÉCRIT (relecture du lot 3a). Deux verrous, lus dans les
 * fichiers du montage, parce qu'aucun test d'exécution ne voit une configuration d'Asterisk :
 *  - le plan de numérotation : une variable de l'appel (`EXTEN`, venue de la R-URI de l'INVITE) ne va jamais dans
 *    `System()`, que `sh -c` exécute, sans être passée par `FILTER` ; « 1;commande; » y serait exécuté ;
 *  - le point d'entrée SIP : sans authentification, il n'est reconnu que par l'ADRESSE (`identify_by = ip`), jamais par
 *    le nom d'utilisateur d'un `From` qu'un scanneur peut écrire.
 */
const DOSSIER = resolve(__dirname, '..', 'ops', 'otp-asterisk');
const lire = (f: string) => readFileSync(resolve(DOSSIER, f), 'utf8');

/** Les lignes actives d'un fichier de configuration d'Asterisk (sans les commentaires `;`). */
function lignes(texte: string): string[] {
  return texte.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter((l) => l !== '');
}

describe('le plan de numérotation du pont', () => {
  const conf = lignes(lire('extensions.conf'));

  it('🔴 aucune variable de l’appel dans `System()` : seuls des noms filtrés y passent', () => {
    const appels = conf.filter((l) => l.includes('System('));
    expect(appels.length).toBeGreaterThan(0);
    for (const l of appels) {
      const variables = [...l.matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
      expect(variables, l).not.toContain('EXTEN');
      expect(variables, l).not.toContain('CALLERID');
      expect(variables, l).not.toContain('UNIQUEID');
    }
  });

  it('🔴 chaque variable passée à `System()` est posée par un `FILTER` de chiffres, ou bâtie sur elles seules', () => {
    const poses = new Map<string, string>();
    for (const l of conf) {
      const m = /Set\(([A-Z_]+)=(.*)\)$/.exec(l);
      if (m) poses.set(m[1]!, m[2]!);
    }
    const sures = new Set<string>();
    for (const [nom, valeur] of poses) {
      if (/^\$\{FILTER\([0-9.]+,\$\{[A-Z_]+\}\)\}$/.test(valeur)) sures.add(nom);
    }
    // Un chemin bâti uniquement de texte fixe et de variables déjà filtrées est sûr aussi.
    for (const [nom, valeur] of poses) {
      const refs = [...valeur.matchAll(/\$\{([A-Z_]+)\}/g)].map((x) => x[1]!);
      if (!valeur.includes('FILTER(') && refs.length > 0 && refs.every((r) => sures.has(r)) && /^[A-Za-z0-9/._${}-]+$/.test(valeur)) sures.add(nom);
    }
    const appel = conf.find((l) => l.includes('System('))!;
    const passees = [...appel.slice(appel.indexOf('System(')).matchAll(/\$\{([A-Z_]+)\}/g)].map((m) => m[1]!);
    expect(passees.length).toBeGreaterThan(0);
    for (const v of passees) expect(sures.has(v), `${v} n’est pas filtrée`).toBe(true);
  });
});

describe('le point d’entrée SIP du pont', () => {
  it('🔴 sans mot de passe exigé, il n’est reconnu que par l’adresse', () => {
    const conf = lignes(lire('pjsip.conf.example'));
    const debut = conf.indexOf('type = endpoint');
    expect(debut).toBeGreaterThan(-1);
    const fin = conf.findIndex((l, i) => i > debut && l.startsWith('['));
    const section = conf.slice(debut, fin === -1 ? undefined : fin);
    expect(section).toContain('identify_by = ip');
    expect(section.some((l) => /^auth\s*=/.test(l))).toBe(false);
  });

  it('🔴 aucun autre canal n’écoute : l’IAX2 n’est pas chargé, et le fichier qui le dit est bien monté', () => {
    // En network_mode host, chan_iax2 (chargé par défaut) ouvrait 4569/udp au monde (relecture RSSI, 2026-10-05).
    const modules = lignes(lire('modules.conf'));
    expect(modules).toContain('noload = chan_iax2.so');
    expect(modules).toContain('noload = chan_sip.so');
    expect(lire('docker-compose.yml')).toContain('./modules.conf:/etc/asterisk/modules.conf:ro');
  });
});
