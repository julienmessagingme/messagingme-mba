import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { sha256Hex } from '../src/lib/signature';
import type { ApiKeyLookup } from '../src/auth/api-key-store.pg';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import {
  DEVENIR_AGENT_A_VENIR, LIMITE_WIDGETS_PAR_ESPACE, SCENARIO_NON_PUBLIE, WIDGET_INCONNU,
  saisieDeCreation, saisieDeModification, type DepsGestionWidgets,
} from '../src/widgets/gestion';
import type { NumeroDuWidget } from '../src/widgets/adresses';
import type { WidgetInput, WidgetRow } from '../src/widgets/store.pg';
import { newTrackingCode } from '../src/ids/code';
import { lienWaMe } from '../src/lib/wa-me';
import { cleApiDeTest } from './aide/cle-api';
import { contactsV1Muets } from './aide/contacts-v1';
import { jamaisDesabonne } from './consentement';
import { mcpInerte } from './routes-inertes';

/**
 * Les outils MCP des widgets WhatsApp (lot 5 de docs/superpowers/plans/2026-10-02-widget-whatsapp.md), montés par
 * `buildServer` derrière une vraie garde de clé d'API.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *  1. 🔴 L'espace vient de la CLÉ : un widget d'un autre espace se refuse comme un inconnu, et un `tenantId` glissé
 *     dans les arguments est une clé inconnue, refusée.
 *  2. 🔴 Aucun contrôle n'est recopié : les refus viennent de `src/widgets/gestion.ts`, avec la phrase que l'écran
 *     montre, en RÉSULTAT `isError` lisible par le modèle et jamais en panne de protocole.
 *  3. 🔴 Toute borne que la saisie applique est annoncée dans le schéma d'entrée, avec la même valeur : un modèle ne
 *     respecte que ce qu'on lui a dit. Dérivé de Zod, pas relu à la main.
 *  4. Une clé de lecture ne voit pas les outils qui écrivent, et ne peut pas les appeler.
 */
class FakeApiKeys implements ApiKeyLookup {
  private readonly byHash = new Map<string, { id: string; tenantId: string; scopes: string[] }>();
  add(raw: string, rec: { id: string; tenantId: string; scopes: string[] }) { this.byHash.set(sha256Hex(raw), rec); return this; }
  async findActiveByHash(hash: string) { return this.byHash.get(hash) ?? null; }
  async touchLastUsed() { /* rien */ }
}

const CLE_TOUT = cleApiDeTest('widgets-tout');
const CLE_LECTURE = cleApiDeTest('widgets-lecture');
const CLE_AUTRE_ESPACE = cleApiDeTest('widgets-autre');

const WF_T1 = '11111111-1111-4111-8111-111111111111';
const WF_T1_NON_PUBLIE = '33333333-3333-4333-8333-333333333333';
const WF_T2 = '22222222-2222-4222-8222-222222222222';
const BASE_API = 'https://api.exemple.test';
const NUMERO: NumeroDuWidget = { displayPhoneNumber: '+33 5 25 68 02 50', delieLe: null };

function ligne(sur: Partial<WidgetRow> = {}): WidgetRow {
  return {
    id: randomUUID(), tenantId: 't1', code: newTrackingCode(), nom: 'Site vitrine', phrase: 'Bonjour, je viens du site',
    devenir: null, agentId: null, workflowId: null, couleur: '#25d366', position: 'bas_droite', libelle: null,
    avatarUrl: null, badge: true, actif: true, maxParHeure: null,
    createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
    ...sur,
  };
}

/** Ce qu'aucun outil des widgets ne doit toucher : les conversations, les envois, les contacts. */
const jamais = (nom: string) => async (): Promise<never> => {
  throw new Error(`${nom} ne devrait pas être appelée par un outil des widgets`);
};

function monter(o: { widgets?: WidgetRow[]; liens?: string[]; scenarios?: Array<{ tenant: string; id: string; name: string; nodeCount: number }> } = {}) {
  const lignes = [...(o.widgets ?? [])];
  const cap = {
    creations: [] as Array<{ tenant: string; w: WidgetInput }>,
    modifications: [] as Array<{ tenant: string; id: string; w: WidgetInput }>,
    listes: [] as string[],
    listesScenarios: [] as string[],
  };
  const gestion: DepsGestionWidgets = {
    widgets: {
      lister: async (t) => { cap.listes.push(t); return lignes.filter((w) => w.tenantId === t); },
      creer: async (t, w) => {
        cap.creations.push({ tenant: t, w });
        const cree = ligne({ ...w, tenantId: t });
        lignes.unshift(cree);
        return cree;
      },
      modifier: async (t, id, w) => {
        cap.modifications.push({ tenant: t, id, w });
        const i = lignes.findIndex((x) => x.id === id && x.tenantId === t);
        if (i < 0) return null;
        lignes[i] = { ...lignes[i]!, ...w };
        return lignes[i]!;
      },
      supprimer: jamais('supprimer'),
    },
    phrasesDesLiens: async () => o.liens ?? [],
    messagesContenantLaPhrase: async () => 0,
    scenarioEtat: async (t, id) => {
      if ((t === 't1' && id === WF_T1) || (t === 't2' && id === WF_T2)) return 'ok';
      return t === 't1' && id === WF_T1_NON_PUBLIE ? 'vide' : 'inconnu';
    },
  };
  const mcp: DepsMcp = {
    estDesabonne: jamaisDesabonne,
    inbox: {
      ...mcpInerte,
      listConversations: jamais('listConversations'),
      getConversationContext: jamais('getConversationContext'),
      getMessages: jamais('getMessages'),
      recordOutbound: jamais('recordOutbound'),
    },
    repo: { getTenantPhoneNumberId: jamais('getTenantPhoneNumberId') },
    sendReply: jamais('sendReply'),
    takeControl: jamais('takeControl'),
    contacts: {
      query: jamais('query'),
      findByPhone: jamais('findByPhone'),
      addTagsByPhoneReturningNew: jamais('addTagsByPhoneReturningNew'),
      analysesEtResumes: jamais('analysesEtResumes'),
    },
    listerMembres: jamais('listerMembres'),
    widgets: { gestion, numero: async () => NUMERO, baseApi: BASE_API },
    scenarios: {
      listResume: async (t) => {
        cap.listesScenarios.push(t);
        return (o.scenarios ?? []).filter((s) => s.tenant === t);
      },
    },
  };
  const keys = new FakeApiKeys()
    .add(CLE_TOUT, { id: 'k1', tenantId: 't1', scopes: ['mcp:read', 'mcp:write'] })
    .add(CLE_LECTURE, { id: 'k2', tenantId: 't1', scopes: ['mcp:read'] })
    .add(CLE_AUTRE_ESPACE, { id: 'k3', tenantId: 't2', scopes: ['mcp:read', 'mcp:write'] });
  const server = buildServer({ queue: new FakeQueue(), v1: { apiKeys: keys, contacts: contactsV1Muets(), mcp } });
  return { server, cap, lignes };
}

const auth = (cle: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${cle}` } });
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

/** Appelle un outil et rend son contenu, reparsé quand c'est du JSON. */
async function appeler(server: ReturnType<typeof monter>['server'], cle: string, nom: string, args: Record<string, unknown> = {}) {
  const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(cle), payload: rpc('tools/call', { name: nom, arguments: args }) });
  const b = res.json<{ result?: { content?: Array<{ text: string }>; isError?: boolean }; error?: { message: string } }>();
  const texte = b.result?.content?.[0]?.text ?? '';
  return { texte, isError: b.result?.isError === true, erreurRpc: b.error?.message, json: () => JSON.parse(texte) as Record<string, any> };
}

describe('le catalogue', () => {
  it('🔴 les quatre outils y sont, et seuls create et update exigent le droit d’écrire', () => {
    const scope = (nom: string) => OUTILS.find((o) => o.nom === nom)?.scope;
    expect(scope('list_widgets')).toBe('mcp:read');
    expect(scope('list_scenarios')).toBe('mcp:read');
    expect(scope('create_widget')).toBe('mcp:write');
    expect(scope('update_widget')).toBe('mcp:write');
    // Pas de suppression : le plan n'en prévoit pas, et une balise posée ne doit pas disparaître sur un mot d'un modèle.
    expect(OUTILS.map((o) => o.nom)).not.toContain('delete_widget');
  });

  it('🔴 une clé de LECTURE ne voit que les outils de lecture, et ne peut pas créer', async () => {
    const { server, cap } = monter();
    const res = await server.inject({ method: 'POST', url: '/mcp', ...auth(CLE_LECTURE), payload: rpc('tools/list') });
    const noms = res.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((t) => t.name).sort();
    expect(noms).toEqual(OUTILS.filter((o) => o.scope === 'mcp:read').map((o) => o.nom).sort());
    expect(noms).toContain('list_widgets');
    expect(noms).not.toContain('create_widget');
    const r = await appeler(server, CLE_LECTURE, 'create_widget', { nom: 'Blog', phrase: 'Je viens du blog' });
    expect(r.erreurRpc).toMatch(/inconnu ou non autorisé/);
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('la description de create_widget dit quoi faire de la balise, et que le visiteur écrit la phrase', () => {
    const d = OUTILS.find((o) => o.nom === 'create_widget')!.description;
    expect(d).toContain('</body>');
    expect(d).toMatch(/visiteur/);
    expect(d).toContain(`${LIMITE_WIDGETS_PAR_ESPACE} widgets au plus`);
  });
});

describe('create_widget', () => {
  it('🔴 crée dans l’espace de la clé, par la gestion de la console, et rend la balise à coller', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, CLE_TOUT, 'create_widget', { nom: 'Blog', phrase: 'Je viens du blog' });
    expect(r.isError).toBe(false);
    expect(cap.creations).toEqual([{ tenant: 't1', w: expect.objectContaining({ nom: 'Blog', phrase: 'Je viens du blog', devenir: null, badge: true }) }]);
    const { widget } = r.json();
    expect(widget.balise).toBe(`<script src="${BASE_API}/widget/${widget.code}.js" async></script>`);
    expect(widget.waMeUrl).toBe(lienWaMe(NUMERO.displayPhoneNumber, 'Je viens du blog'));
    // La vue de la console, champ par champ : ni l'espace ni l'agent.
    expect(widget).not.toHaveProperty('tenantId');
    expect(widget).not.toHaveProperty('agentId');
    await server.close();
  });

  it('🔴 un refus de la gestion est un RÉSULTAT isError avec SA phrase, jamais une panne', async () => {
    const cinq = Array.from({ length: LIMITE_WIDGETS_PAR_ESPACE }, (_, i) => ligne({ phrase: `Phrase numero ${i} du site` }));
    const cas: Array<[ReturnType<typeof monter>, Record<string, unknown>, string]> = [
      [monter(), { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'agent' }, DEVENIR_AGENT_A_VENIR],
      [monter(), { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: WF_T1_NON_PUBLIE }, SCENARIO_NON_PUBLIE],
      [monter({ liens: ['Je veux le guide'] }), { nom: 'Blog', phrase: 'Je veux le guide 2026' }, 'lien de chaîne'],
      [monter({ widgets: cinq }), { nom: 'Sixième', phrase: 'Une toute autre phrase' }, `${LIMITE_WIDGETS_PAR_ESPACE} widgets`],
      [monter(), { nom: 'Blog', phrase: 'x'.repeat(301) }, 'la phrase (1 à 300 caractères)'],
    ];
    for (const [{ server, cap }, args, attendu] of cas) {
      const r = await appeler(server, CLE_TOUT, 'create_widget', args);
      expect(r.erreurRpc, JSON.stringify(args)).toBeUndefined();
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.texte, JSON.stringify(args)).toContain(attendu);
      expect(cap.creations).toEqual([]);
      await server.close();
    }
  });

  it('🔴 un `tenantId` glissé dans les arguments est REFUSÉ : l’espace vient de la clé, jamais d’un paramètre', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, CLE_AUTRE_ESPACE, 'create_widget', { nom: 'Blog', phrase: 'Je viens du blog', tenantId: 't1' });
    expect(r.isError).toBe(true);
    expect(r.texte).toBe('Champ inconnu : tenantId.');
    expect(cap.creations).toEqual([]);
    await server.close();
  });

  it('🔴 le scénario d’un AUTRE espace est refusé comme un inconnu', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, CLE_TOUT, 'create_widget', { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: WF_T2 });
    expect(r.isError).toBe(true);
    expect(r.texte).toContain('n’existe pas dans cet espace');
    expect(cap.creations).toEqual([]);
    // Le pendant : le scénario publié de l'espace passe, sinon le refus ne prouverait rien.
    const ok = await appeler(server, CLE_TOUT, 'create_widget', { nom: 'Blog', phrase: 'Je viens du blog', devenir: 'scenario', workflowId: WF_T1 });
    expect(ok.isError).toBe(false);
    expect(cap.creations[0]).toMatchObject({ tenant: 't1', w: { devenir: 'scenario', workflowId: WF_T1 } });
    await server.close();
  });
});

describe('update_widget', () => {
  it('modifie PARTIELLEMENT le widget de l’espace, sans transmettre widget_id à la saisie', async () => {
    const w = ligne({ phrase: 'Je viens du blog' });
    const { server, cap } = monter({ widgets: [w] });
    const r = await appeler(server, CLE_TOUT, 'update_widget', { widget_id: w.id, couleur: '#123abc' });
    // `.strict()` refuserait `widget_id` s'il partait avec la saisie : le succès prouve qu'il est retiré.
    expect(r.isError).toBe(false);
    expect(cap.modifications).toEqual([{ tenant: 't1', id: w.id, w: expect.objectContaining({ couleur: '#123abc', phrase: 'Je viens du blog' }) }]);
    expect(r.json().widget.code).toBe(w.code);
    await server.close();
  });

  it('🔴 le widget d’un AUTRE espace est refusé comme un inconnu, et rien n’est écrit', async () => {
    const chezT1 = ligne();
    const { server, cap } = monter({ widgets: [chezT1] });
    const r = await appeler(server, CLE_AUTRE_ESPACE, 'update_widget', { widget_id: chezT1.id, actif: false });
    expect(r.isError).toBe(true);
    expect(r.texte).toBe(WIDGET_INCONNU);
    // Le même message qu'un identifiant qui n'existe nulle part : rien ne dit que celui-ci existe ailleurs.
    const fantome = await appeler(server, CLE_TOUT, 'update_widget', { widget_id: randomUUID(), actif: false });
    expect(fantome.texte).toBe(r.texte);
    expect(cap.modifications).toEqual([]);
    expect(cap.listes).toEqual(['t2', 't1']);
    await server.close();
  });

  it('un widget inerte (scénario supprimé) se modifie sans choisir de scénario', async () => {
    const w = ligne({ devenir: 'scenario', workflowId: null });
    const { server } = monter({ widgets: [w] });
    expect((await appeler(server, CLE_TOUT, 'update_widget', { widget_id: w.id, couleur: '#000000' })).isError).toBe(false);
    // Le CHOISIR exige un scénario publié de l'espace.
    const nonPublie = await appeler(server, CLE_TOUT, 'update_widget', { widget_id: w.id, workflowId: WF_T1_NON_PUBLIE });
    expect(nonPublie.texte).toBe(SCENARIO_NON_PUBLIE);
    await server.close();
  });

  it('sans widget_id : refusé avant toute lecture', async () => {
    const { server, cap } = monter();
    const r = await appeler(server, CLE_TOUT, 'update_widget', { actif: false });
    expect(r.isError).toBe(true);
    expect(r.texte).toContain('widget_id');
    expect(cap.listes).toEqual([]);
    await server.close();
  });
});

describe('list_widgets et list_scenarios', () => {
  it('🔴 list_widgets ne rend que les widgets de l’espace de la clé, avec la limite', async () => {
    const { server, cap } = monter({ widgets: [ligne({ tenantId: 't1' }), ligne({ tenantId: 't2', phrase: 'Ailleurs' })] });
    const r = await appeler(server, CLE_AUTRE_ESPACE, 'list_widgets');
    expect(r.json().widgets.map((w: { phrase: string }) => w.phrase)).toEqual(['Ailleurs']);
    expect(r.json().limite).toBe(LIMITE_WIDGETS_PAR_ESPACE);
    expect(cap.listes).toEqual(['t2']);
    await server.close();
  });

  it('🔴 list_scenarios dit lesquels sont publiés, dans l’espace de la clé, borné', async () => {
    const scenarios = [
      { tenant: 't1', id: WF_T1, name: 'Accueil', nodeCount: 4 },
      { tenant: 't1', id: WF_T1_NON_PUBLIE, name: 'Brouillon', nodeCount: 0 },
      { tenant: 't2', id: WF_T2, name: 'Chez le voisin', nodeCount: 2 },
    ];
    const { server, cap } = monter({ scenarios });
    const r = await appeler(server, CLE_LECTURE, 'list_scenarios');
    expect(r.json()).toEqual({
      scenarios: [{ id: WF_T1, nom: 'Accueil', publie: true }, { id: WF_T1_NON_PUBLIE, nom: 'Brouillon', publie: false }],
      tronque: false,
    });
    expect(cap.listesScenarios).toEqual(['t1']);
    // ⚠️ Sans `tronque`, un modèle qui reçoit exactement `limit` scénarios conclurait qu'il les a tous.
    expect((await appeler(server, CLE_LECTURE, 'list_scenarios', { limit: 1 })).json()).toMatchObject({ tronque: true });
    await server.close();
  });
});

/**
 * 🔴 CE QUE LA SAISIE REFUSE, LE MODÈLE EN A ÉTÉ PRÉVENU (règle du dépôt, 2026-09-17). L'extracteur lit les
 * internes de Zod : il pourrait devenir MUET à la prochaine version majeure, d'où le compte plancher, et toute
 * forme de borne qu'il ne connaît pas le fait échouer au lieu de passer à vide.
 */
describe('🔴 les bornes de la saisie sont annoncées dans les schémas d’entrée, avec leur valeur', () => {
  type Borne = [champ: string, cle: string, valeur: unknown];

  function bornes(champ: string, s: any, out: Borne[]): Borne[] {
    const d = s?._zod?.def;
    if (!d) return out;
    for (const c of d.checks ?? []) {
      const cd = c?._zod?.def ?? c;
      if (cd.check === 'overwrite') continue; // le `trim`, une transformation et pas une borne
      else if (cd.check === 'min_length') { if (cd.minimum > 0) out.push([champ, 'minLength', cd.minimum]); }
      else if (cd.check === 'max_length') out.push([champ, 'maxLength', cd.maximum]);
      else if (cd.check === 'string_format' && cd.format === 'regex') out.push([champ, 'pattern', cd.pattern.source]);
      else if (cd.check === 'string_format' && cd.format === 'uuid') out.push([champ, 'format', 'uuid']);
      else if (cd.check === 'number_format' && cd.format === 'safeint') out.push([champ, 'type', 'integer']);
      else if (cd.check === 'greater_than' && cd.inclusive) out.push([champ, 'minimum', cd.value]);
      else if (cd.check === 'less_than' && cd.inclusive) out.push([champ, 'maximum', cd.value]);
      else if (cd.check === 'custom') out.push([champ, 'pattern', '(raffinement)']);
      else out.push([champ, `forme inconnue de l’extracteur : ${String(cd.check)}/${String(cd.format)}`, null]);
    }
    if (['optional', 'nonoptional', 'default'].includes(d.type)) return bornes(champ, d.innerType, out);
    if (d.type === 'nullable') { out.push([champ, 'null', true]); return bornes(champ, d.innerType, out); }
    if (d.type === 'pipe') return bornes(champ, d.in, out);
    if (d.type === 'enum') out.push([champ, 'enum', Object.values(d.entries)]);
    if (d.type === 'boolean') out.push([champ, 'type', 'boolean']);
    return out;
  }

  const schemaDe = (nom: string) => OUTILS.find((o) => o.nom === nom)!.entree;

  function muettes(zod: any, nomOutil: string): string[] {
    const annonce = schemaDe(nomOutil).properties as Record<string, any>;
    const appliquees = Object.entries<any>(zod._zod.def.shape).flatMap(([champ, s]) => bornes(champ, s, []));
    expect(appliquees.length, 'l’extracteur ne lit plus les bornes de Zod : c’est LUI qu’il faut réparer').toBeGreaterThanOrEqual(15);
    const types = (p: any): string[] => (Array.isArray(p?.type) ? p.type : [p?.type]);
    return appliquees.filter(([champ, cle, valeur]) => {
      const p = annonce[champ];
      if (!p) return true;
      switch (cle) {
        case 'null': return !types(p).includes('null');
        case 'type': return !types(p).includes(valeur as string);
        // Une énumération annoncée doit être INCLUSE dans celle que Zod accepte : plus stricte, jamais plus large.
        // `agent` passe Zod pour être refusé avec sa raison, et n'est pas proposé au modèle.
        case 'enum': {
          const proposees = (p.enum ?? []).filter((v: unknown) => v !== null);
          return proposees.length === 0 || proposees.some((v: string) => !(valeur as string[]).includes(v));
        }
        case 'pattern': return valeur === '(raffinement)' ? typeof p.pattern !== 'string' : p.pattern !== valeur;
        default: return p[cle] !== valeur;
      }
    }).map(([champ, cle, valeur]) => `${champ}/${cle}=${JSON.stringify(valeur)}`);
  }

  it('create_widget : chaque borne, avec sa valeur ; les champs requis ; aucune clé inconnue acceptée', () => {
    expect(muettes(saisieDeCreation, 'create_widget')).toEqual([]);
    const s = schemaDe('create_widget');
    expect([...(s.required ?? [])].sort()).toEqual(['nom', 'phrase']);
    expect(Object.keys(s.properties).sort()).toEqual(Object.keys((saisieDeCreation as any)._zod.def.shape).sort());
    expect(s.additionalProperties).toBe(false);
  });

  it('update_widget : les mêmes bornes, et seul widget_id est requis', () => {
    expect(muettes(saisieDeModification, 'update_widget')).toEqual([]);
    const s = schemaDe('update_widget');
    expect(s.required).toEqual(['widget_id']);
    expect(Object.keys(s.properties).sort()).toEqual(['widget_id', ...Object.keys((saisieDeModification as any)._zod.def.shape)].sort());
    expect(s.additionalProperties).toBe(false);
  });

  it('🔴 le devenir « agent » n’est pas PROPOSÉ au modèle, même si la saisie l’accepte pour le refuser avec sa raison', () => {
    expect(schemaDe('create_widget').properties.devenir!.enum).toEqual(['mba', 'scenario', null]);
  });

  it('les schémas sont bien formés pour un client MCP : JSON pur, objet, propriétés décrites', () => {
    for (const nom of ['list_widgets', 'list_scenarios', 'create_widget', 'update_widget']) {
      const s = schemaDe(nom);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      expect(s.type).toBe('object');
      for (const p of Object.values(s.properties)) expect(p.description.trim(), nom).not.toBe('');
    }
  });
});
