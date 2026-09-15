import { describe, it, expect } from 'vitest';
import { pastillesDe, lireGabarit } from './gabarit-pastilles';

/**
 * 🔴 LE CAS RÉEL QUI A MOTIVÉ CE MODULE (Julien, 2026-09-15) : un corps d'appel UChat écrit avec les
 * pastilles HORS guillemets, et un écran qui répondait « Ce n'est pas du JSON valide » sans nommer la cause.
 */
const CAS_JULIEN = '{\n  "user_ns": {{user_ns}},\n  "tag_ns": {{tag_ns}}\n}';

describe('les pastilles d’un texte', () => {
  it('les trouve, sans doublon et dans l’ordre', () => {
    expect(pastillesDe('{{a}} et {{b}} et encore {{a}}')).toEqual(['a', 'b']);
  });

  it('accepte les espaces intérieurs et les noms pointés, comme le serveur', () => {
    expect(pastillesDe('{{ ville }} {{contact.nom}} {{ref-1}}')).toEqual(['ville', 'contact.nom', 'ref-1']);
  });

  it('⚠️ un texte sans pastille n’en invente pas', () => {
    expect(pastillesDe('{ "a": 1 }')).toEqual([]);
    expect(pastillesDe('')).toEqual([]);
  });
});

describe('les pastilles mal placées dans un gabarit JSON', () => {
  it('🔴 repère celles qui sont hors guillemets, et rend un gabarit qui PARSE', () => {
    const r = lireGabarit(CAS_JULIEN);
    expect(r.horsGuillemets).toEqual(['user_ns', 'tag_ns']);
    expect(() => JSON.parse(r.repare)).not.toThrow();
    expect(JSON.parse(r.repare)).toEqual({ user_ns: '{{user_ns}}', tag_ns: '{{tag_ns}}' });
  });

  it('🔴 une pastille DÉJÀ entre guillemets n’est pas touchée', () => {
    // La re-guillemeter produirait `""{{x}}""`, donc casserait un gabarit qui marchait.
    const bon = '{"ville": "{{ville}}"}';
    const r = lireGabarit(bon);
    expect(r.horsGuillemets).toEqual([]);
    expect(r.repare).toBe(bon);
  });

  it('🔴 une pastille NOYÉE dans du texte est légitime et reste intacte', () => {
    // `"Bonjour {{prenom}}"` est une interpolation valide côté serveur : la signaler serait un faux positif.
    const r = lireGabarit('{"msg": "Bonjour {{prenom}}, ça va ?"}');
    expect(r.horsGuillemets).toEqual([]);
    expect(r.repare).toBe('{"msg": "Bonjour {{prenom}}, ça va ?"}');
  });

  it('🔴 un guillemet ÉCHAPPÉ ne fait pas sortir de la chaîne', () => {
    // Sans la gestion de l'échappement, tout ce qui suit serait analysé à l'envers et une pastille
    // parfaitement placée serait déclarée fautive.
    const src = '{"a": "il dit \\"{{mot}}\\" souvent"}';
    const r = lireGabarit(src);
    expect(r.horsGuillemets).toEqual([]);
    expect(r.repare).toBe(src);
  });

  it('⚠️ un mélange : seule la fautive bouge', () => {
    const r = lireGabarit('{"a": "{{a}}", "b": {{b}}}');
    expect(r.horsGuillemets).toEqual(['b']);
    expect(JSON.parse(r.repare)).toEqual({ a: '{{a}}', b: '{{b}}' });
  });

  it('⚠️ le même nom deux fois hors guillemets n’est signalé qu’une fois', () => {
    expect(lireGabarit('{"a": {{x}}, "b": {{x}}}').horsGuillemets).toEqual(['x']);
  });

  it('⚠️ un gabarit cassé POUR UNE AUTRE RAISON n’est pas réparé, et ne prétend pas l’être', () => {
    // Accolade manquante : la lecture ne signale aucune pastille fautive, et `JSON.parse` refuse toujours.
    // C'est voulu, ce module ne répond qu'à la question qu'il sait nommer.
    const r = lireGabarit('{"a": "{{x}}"');
    expect(r.horsGuillemets).toEqual([]);
    expect(() => JSON.parse(r.repare)).toThrow();
  });
});
