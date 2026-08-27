import { describe, it, expect } from 'vitest';
import { toolParamsToJsonSchema } from '../src/agent/llm/tool-schema';

describe('toolParamsToJsonSchema (tâche 15)', () => {
  it('🔴 n expose au modèle QUE les paramètres de source « modele »', () => {
    // LA garde du module. Sans elle, un connecteur client serait un IDOR offert au premier venu qui écrit
    // sur le numéro : il suffirait de demander à l'agent la commande de quelqu'un d'autre.
    const s = toolParamsToJsonSchema([
      { name: 'reference', type: 'string', source: 'modele', required: true, description: 'la reference' },
      { name: 'wa_id', type: 'string', source: 'contact', required: true, description: 'le numero' },
      { name: 'boutique', type: 'string', source: 'fixe', required: true, description: 'le code boutique' },
    ]);
    expect(Object.keys(s.properties)).toEqual(['reference']);
    expect(s.required).toEqual(['reference']);
  });

  it('🔴 un paramètre « contact » REQUIS ne fuit pas non plus dans required', () => {
    const s = toolParamsToJsonSchema([
      { name: 'wa_id', type: 'string', source: 'contact', required: true },
    ]);
    expect(s.properties).toEqual({});
    expect(s.required).toEqual([]);
  });

  it('rend les types, la description et l énumération', () => {
    const s = toolParamsToJsonSchema([
      { name: 'ref', type: 'string', source: 'modele', required: true, description: 'la référence' },
      { name: 'quantite', type: 'integer', source: 'modele' },
      { name: 'canal', type: 'string', source: 'modele', enum: ['sms', 'email'] },
      { name: 'urgent', type: 'boolean', source: 'modele' },
    ]);
    expect(s.properties.ref).toEqual({ type: 'string', description: 'la référence' });
    expect(s.properties.quantite).toEqual({ type: 'integer' });
    expect(s.properties.canal).toEqual({ type: 'string', enum: ['sms', 'email'] });
    expect(s.properties.urgent).toEqual({ type: 'boolean' });
    expect(s.required).toEqual(['ref']); // seuls les requis
  });

  it('🔴 aucun $schema, et AUCUNE borne numérique parasite sur un entier', () => {
    // Ce bruit se paierait à CHAQUE tour, dans le prompt. Il n'existe pas parce que le schéma est construit
    // directement ; ce test l'ancre pour qu'une future dérivation depuis Zod ne le réintroduise pas en
    // silence (`z.number().int()` émet minimum: -9007199254740991).
    const s = toolParamsToJsonSchema([{ name: 'n', type: 'integer', source: 'modele' }]);
    expect(s).not.toHaveProperty('$schema');
    expect(s.properties.n).toEqual({ type: 'integer' });
    expect(JSON.stringify(s)).not.toContain('minimum');
    expect(JSON.stringify(s)).not.toContain('maximum');
  });

  it('pose additionalProperties: false (portabilité, et mode strict d OpenAI)', () => {
    expect(toolParamsToJsonSchema([]).additionalProperties).toBe(false);
  });

  it('aucun paramètre exposé -> un schéma d objet VIDE valide, jamais undefined', () => {
    const s = toolParamsToJsonSchema([{ name: 'wa_id', type: 'string', source: 'contact' }]);
    expect(s).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  });

  it('entrées mal formées ignorées, sans lever (params est du jsonb, donc opaque)', () => {
    const s = toolParamsToJsonSchema([
      null,
      'pas un objet',
      { name: '', type: 'string', source: 'modele' }, // nom vide
      { name: 'x', type: 'objet_imbrique', source: 'modele' }, // type inconnu
      { name: 'y', type: 'string', source: 'inventee' }, // source inconnue
      { name: 'bon', type: 'string', source: 'modele' },
    ]);
    expect(Object.keys(s.properties)).toEqual(['bon']);
  });

  it('params qui n est pas un tableau -> schéma vide, sans lever', () => {
    expect(toolParamsToJsonSchema(null).properties).toEqual({});
    expect(toolParamsToJsonSchema({ name: 'x' }).properties).toEqual({});
    expect(toolParamsToJsonSchema(undefined).properties).toEqual({});
  });

  it('une énumération vide ou non textuelle est ignorée plutôt que rendue vide', () => {
    const s = toolParamsToJsonSchema([
      { name: 'a', type: 'string', source: 'modele', enum: [] },
      { name: 'b', type: 'string', source: 'modele', enum: [1, 2] },
      { name: 'c', type: 'string', source: 'modele', enum: ['ok', 3, ''] },
    ]);
    expect(s.properties.a).toEqual({ type: 'string' });
    expect(s.properties.b).toEqual({ type: 'string' });
    expect(s.properties.c).toEqual({ type: 'string', enum: ['ok'] });
  });
});
