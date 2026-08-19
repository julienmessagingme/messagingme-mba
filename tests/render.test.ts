import { describe, it, expect } from 'vitest';
import { renderText, escapeHtml, contactVars } from '../src/crm/render';

describe('escapeHtml', () => {
  it('échappe les 5 caractères dangereux pour le HTML', () => {
    expect(escapeHtml(`<b>A & B "x" 'y'</b>`)).toBe('&lt;b&gt;A &amp; B &quot;x&quot; &#39;y&#39;&lt;/b&gt;');
  });

  it('laisse intact un texte sans caractère spécial', () => {
    expect(escapeHtml('Bonjour Léa')).toBe('Bonjour Léa');
  });
});

describe('renderText', () => {
  it('remplace les variables présentes et vide les absentes', () => {
    expect(renderText('Bonjour {{prenom}} {{nom}}', { prenom: 'Léa' }, { html: false })).toBe('Bonjour Léa ');
  });

  it('vide une variable explicitement null (pas seulement absente de la table)', () => {
    expect(renderText('Bonjour {{prenom}}', { prenom: null }, { html: false })).toBe('Bonjour ');
  });

  it('échappe les valeurs en HTML mais pas le corps du modèle', () => {
    expect(renderText('<b>{{v}}</b>', { v: '<script>x</script>' }, { html: true }))
      .toBe('<b>&lt;script&gt;x&lt;/script&gt;</b>');
  });

  it('n\'échappe pas en mode texte', () => {
    expect(renderText('{{v}}', { v: 'a & b' }, { html: false })).toBe('a & b');
  });

  it('tolère les espaces dans les accolades', () => {
    expect(renderText('{{ prenom }}', { prenom: 'Léa' }, { html: false })).toBe('Léa');
  });

  it('remplace plusieurs occurrences de la même variable', () => {
    expect(renderText('{{prenom}}, encore {{prenom}} !', { prenom: 'Léa' }, { html: false }))
      .toBe('Léa, encore Léa !');
  });

  it('laisse un texte sans variable inchangé', () => {
    expect(renderText('Bonjour, sans variable ici.', {}, { html: false })).toBe('Bonjour, sans variable ici.');
  });
});

/** Critical 1 : `vars[key]` sans garde remonte la chaîne de prototype. Pour une clef comme `toString` ou
 *  `constructor`, absente de `vars` mais héritée d'Object.prototype, l'ancien code résolvait vers la MÉTHODE
 *  héritée (une fonction) au lieu de `undefined` : texte parasite en mode texte (la fonction est convertie en
 *  chaîne à l'insertion), et `TypeError: s.replace is not a function` en mode HTML (escapeHtml reçoit une
 *  fonction, pas une chaîne). Le correctif ne lit que les clés PROPRES de `vars` via `hasOwnProperty`. */
describe('renderText — clés héritées de Object.prototype (Critical 1)', () => {
  it('{{toString}} rend une chaîne vide en mode texte, jamais la méthode héritée', () => {
    expect(renderText('{{toString}}', {}, { html: false })).toBe('');
  });

  it('{{constructor}} rend une chaîne vide en mode texte, jamais le constructeur hérité', () => {
    expect(renderText('{{constructor}}', {}, { html: false })).toBe('');
  });

  it('{{__proto__}} rend une chaîne vide en mode texte, jamais Object.prototype', () => {
    expect(renderText('{{__proto__}}', {}, { html: false })).toBe('');
  });

  it('{{hasOwnProperty}} rend une chaîne vide en mode texte, jamais la méthode héritée', () => {
    expect(renderText('{{hasOwnProperty}}', {}, { html: false })).toBe('');
  });

  it('{{toString}} ne lève pas en mode html et rend une chaîne vide (escapeHtml ne reçoit jamais un non-string)', () => {
    expect(() => renderText('{{toString}}', {}, { html: true })).not.toThrow();
    expect(renderText('{{toString}}', {}, { html: true })).toBe('');
  });

  it('{{constructor}} ne lève pas en mode html et rend une chaîne vide', () => {
    expect(() => renderText('{{constructor}}', {}, { html: true })).not.toThrow();
    expect(renderText('{{constructor}}', {}, { html: true })).toBe('');
  });

  it('{{__proto__}} ne lève pas en mode html et rend une chaîne vide', () => {
    expect(() => renderText('{{__proto__}}', {}, { html: true })).not.toThrow();
    expect(renderText('{{__proto__}}', {}, { html: true })).toBe('');
  });

  it('{{hasOwnProperty}} ne lève pas en mode html et rend une chaîne vide', () => {
    expect(() => renderText('{{hasOwnProperty}}', {}, { html: true })).not.toThrow();
    expect(renderText('{{hasOwnProperty}}', {}, { html: true })).toBe('');
  });

  it('même garde avec une table issue de contactVars (Object.create(null), défense en profondeur)', () => {
    const vars = contactVars({});
    expect(renderText('{{toString}}{{constructor}}{{__proto__}}{{hasOwnProperty}}', vars, { html: false })).toBe('');
    expect(() => renderText('{{toString}}', vars, { html: true })).not.toThrow();
    expect(renderText('{{toString}}', vars, { html: true })).toBe('');
  });
});

describe('contactVars', () => {
  it('expose les attributs système sous plusieurs clés (phone et phone_e164)', () => {
    const vars = contactVars({ phone_e164: '+33612345678', bsuid: 'bs-1', profile_name: 'Léa' });
    expect(vars.phone).toBe('+33612345678');
    expect(vars.phone_e164).toBe('+33612345678');
    expect(vars.bsuid).toBe('bs-1');
    expect(vars.profile_name).toBe('Léa');
  });

  it('attribut système absent -> null (pas undefined, pas de clé manquante)', () => {
    const vars = contactVars({});
    expect(vars.phone).toBeNull();
    expect(vars.bsuid).toBeNull();
    expect(vars.profile_name).toBeNull();
  });

  it('ajoute les champs libres et convertit les valeurs non-string en string', () => {
    const vars = contactVars({ fields: { entreprise: 'Acme', nb_commandes: 3, actif: true } });
    expect(vars.entreprise).toBe('Acme');
    expect(vars.nb_commandes).toBe('3');
    expect(vars.actif).toBe('true');
  });

  it('un champ libre null reste null (pas la chaîne "null")', () => {
    const vars = contactVars({ fields: { entreprise: null } });
    expect(vars.entreprise).toBeNull();
  });

  // Minor : une valeur non primitive (objet, tableau) ne doit jamais devenir "[object Object]"/"a,b".
  it('un champ libre non primitif (objet, tableau) devient null, jamais "[object Object]"', () => {
    const vars = contactVars({ fields: { meta: { a: 1 }, tags: ['x', 'y'] } });
    expect(vars.meta).toBeNull();
    expect(vars.tags).toBeNull();
  });
});
