import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OUTILS } from '../src/mcp/outils';
import { CATALOGUE_MCP } from '../web/lib/partage/catalogue-mcp';
import { API_PUBLIQUE, COMMANDE_DEMARRAGE, COMMANDES_PLUGIN, SERVEUR_PLUGIN_MCP } from '../web/lib/demarrer';
import { AVERTISSEMENTS, OUTILS_DE_L_ETAPE, etatMiseEnService } from '../src/mcp/mise-en-service';
import { STATUT_PAR_CODE } from '../src/api/erreurs';
import { OUTILS_SURS } from '../src/agent/reglages';
import { QUOTAS_API_DEFAUT } from '../src/api/quotas';

/**
 * LE PLUGIN CLAUDE CODE (lot 10), tel qu'il part dans `julienmessagingme/messagingme-plugin` : ce dossier est copié tel
 * quel par `.github/workflows/plugin.yml`. Ce que la doc de Claude Code exige (lue le 2026-10-12) et ce que nos outils
 * permettent, vérifié ici parce qu'un plugin faux ne se voit qu'à l'installation, chez quelqu'un d'autre.
 */
const PLUGIN = resolve(__dirname, '..', 'plugin');
const json = <T>(p: string): T => JSON.parse(readFileSync(resolve(PLUGIN, p), 'utf8')) as T;
const NOM = 'messagingme';
const PREFIXE = `mcp__plugin_${NOM}_${NOM}__`;

const SKILLS = readdirSync(resolve(PLUGIN, 'skills')).map((nom) => {
  const texte = readFileSync(resolve(PLUGIN, 'skills', nom, 'SKILL.md'), 'utf8');
  const [, entete = '', corps = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(texte) ?? [];
  const champ = (c: string) => new RegExp(`^${c}: (.*)$`, 'm').exec(entete)?.[1]?.trim();
  return { nom, entete, corps, champ };
});

describe('la fiche du répertoire de Claude (spec 2026-10-14-repertoire-claude-design.md)', () => {
  const manifeste = () => json<Record<string, string> & { icon: string }>('.claude-plugin/plugin.json');

  it('🔴 le manifeste porte la licence, l’icône et les liens que la fiche du répertoire exige, en https', () => {
    // La licence est BLOQUANTE à la soumission ; le reste alimente la fiche (Claude Code ignore ces champs).
    const p = manifeste();
    expect(p.license).toBe('MIT');
    expect(existsSync(resolve(PLUGIN, 'LICENSE'))).toBe(true);
    expect(p.icon).toMatch(/^\.\/[a-z-]+\.(svg|png)$/);
    expect(existsSync(resolve(PLUGIN, p.icon))).toBe(true);
    expect(p.displayName).toBe('Messaging Me');
    for (const champ of ['homepage', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']) {
      expect(p[champ], champ).toMatch(/^https:\/\/[a-z.]+\//);
    }
  });

  it('le README dit ce que le plugin envoie et récupère, avec les mêmes liens, en plus de 40 mots hors code', () => {
    const p = manifeste();
    const lisezmoi = readFileSync(resolve(PLUGIN, 'README.md'), 'utf8');
    const horsCode = lisezmoi.replace(/```[\s\S]*?```/g, '');
    expect(horsCode.split(/\s+/).filter(Boolean).length).toBeGreaterThan(40);
    expect(lisezmoi).toMatch(/^## Data and privacy$/m);
    expect(lisezmoi).toContain(p.privacyPolicyUrl);
    expect(lisezmoi).toContain(p.termsOfServiceUrl);
  });
});

describe('les manifestes', () => {
  it('le plugin, son entrée au catalogue et le serveur portent le même nom', () => {
    const plugin = json<{ name: string; version: string; author: { name: string } }>('.claude-plugin/plugin.json');
    const catalogue = json<{ name: string; owner: { name: string }; plugins: Array<{ name: string; source: string }> }>('.claude-plugin/marketplace.json');
    expect(plugin.name).toBe(NOM);
    expect(catalogue.name).toBe(NOM);
    expect(catalogue.plugins).toEqual([expect.objectContaining({ name: NOM, source: './' })]);
    // Face au public, l'éditeur est SmartLink (CLAUDE.md global).
    expect(plugin.author.name).toBe('SmartLink');
    expect(catalogue.owner.name).toBe('SmartLink');
    // La version fige les installations jusqu'à son changement : la publication refuse un contenu neuf sans elle.
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('🔴 le serveur est l’API publique, sans clé ni en-tête : l’autorisation passe par OAuth', () => {
    const mcp = json<{ mcpServers: Record<string, { type: string; url: string; headers?: unknown }> }>('.mcp.json');
    expect(Object.keys(mcp.mcpServers)).toEqual([NOM]);
    expect(mcp.mcpServers[NOM]).toEqual({ type: 'http', url: `${API_PUBLIQUE}/mcp` });
  });
});

describe('🔴 ce que la console et la vitrine font taper (lot 10, B) est ce que le plugin publie', () => {
  it('les deux commandes, le lancement et le nom du serveur dans /mcp viennent des manifestes', () => {
    const plugin = json<{ name: string; repository: string }>('.claude-plugin/plugin.json');
    const catalogue = json<{ name: string }>('.claude-plugin/marketplace.json');
    const [serveur] = Object.keys(json<{ mcpServers: Record<string, unknown> }>('.mcp.json').mcpServers);
    const depot = new URL(plugin.repository).pathname.replace(/^\/|\.git$/g, '');
    expect(COMMANDES_PLUGIN).toEqual([`/plugin marketplace add ${depot}`, `/plugin install ${plugin.name}@${catalogue.name}`]);
    expect(COMMANDE_DEMARRAGE).toBe(`/${plugin.name}:demarrer`);
    expect(SKILLS.map((s) => s.nom)).toContain('demarrer');
    expect(SERVEUR_PLUGIN_MCP).toBe(`plugin:${plugin.name}:${serveur}`);
    // Le README publié dit les mêmes.
    const lisezmoi = readFileSync(resolve(PLUGIN, 'README.md'), 'utf8');
    for (const c of [...COMMANDES_PLUGIN, COMMANDE_DEMARRAGE, SERVEUR_PLUGIN_MCP]) expect(lisezmoi, c).toContain(c);
  });
});

describe('les skills', () => {
  it('chacune a son nom, celui de son dossier, et une description', () => {
    expect(SKILLS.map((s) => s.nom).sort()).toEqual(['demarrer', 'faq', 'mise-en-service', 'regles-whatsapp']);
    for (const s of SKILLS) {
      expect(s.champ('name'), s.nom).toBe(s.nom);
      expect((s.champ('description') ?? '').length, s.nom).toBeGreaterThan(40);
    }
  });

  it('/messagingme:demarrer est réservé à la personne : Claude ne le lance pas de lui-même', () => {
    expect(SKILLS.find((s) => s.nom === 'demarrer')!.champ('disable-model-invocation')).toBe('true');
  });

  it('🔴 chaque nom en code d’une skill existe : un outil du catalogue, ou un nom que le code porte', () => {
    // Ce qu'une skill peut nommer d'autre qu'un outil, DÉRIVÉ du code : renommer une étape, un champ de get_setup_state,
    // un argument d'outil ou un code de refus laisse sinon la skill périmée et ce test vert.
    const clesRendues = (o: unknown): string[] => (o !== null && typeof o === 'object')
      ? Object.entries(o).flatMap(([k, v]) => [k, ...clesRendues(Array.isArray(v) ? v[0] : v)]) : [];
    const exemple = etatMiseEnService({
      offre: { offre: 'free', fonctions: [] }, soldeMicroEur: 0,
      // Bloqué pour sa carte : l'exemple rend aussi `etapes_carte_meta`, que la skill nomme.
      numero: { fourni: '+44', code: null, connecte: { chiffres: '44', aActiver: false, paiementBloque: true }, abonnement: null, inclusDansLePro: false },
      agents: [{ id: 'a', label: 'A', status: 'draft', nbManques: 1 }, { id: 'b', label: 'B', status: 'active', nbManques: null },
        { id: 'c', label: 'C', status: 'disabled', nbManques: null }],
      reglages: { mbaEnabled: false, repondeurMode: 'equipe', repondeurAgentId: null, repondeurWorkflowId: null, repondeurAdresseId: null },
      widgets: [{ id: 'w', nom: 'W', actif: true }],
    });
    const arguments_ = OUTILS.flatMap((o) => Object.keys((o.entree as { properties?: object }).properties ?? {}));
    // Les valeurs permises d'un argument (le mode `business_hours` de set_transfer_mode, par exemple).
    const valeurs = OUTILS.flatMap((o) => Object.values((o.entree as { properties?: Record<string, { enum?: unknown[] }> }).properties ?? {})
      .flatMap((p) => (p.enum ?? []).filter((v): v is string => typeof v === 'string')));
    const connus = new Set<string>([
      ...Object.keys(CATALOGUE_MCP), ...Object.keys(OUTILS_DE_L_ETAPE), ...AVERTISSEMENTS, ...clesRendues(exemple),
      ...arguments_, ...valeurs, ...OUTILS_SURS, ...Object.keys(STATUT_PAR_CODE),
    ]);
    for (const s of SKILLS) {
      for (const m of s.corps.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) expect(connus.has(m[1]!), `${s.nom} : ${m[1]}`).toBe(true);
    }
  });

  it('🔴 aucune skill ne chiffre un prix de Meta (des centimes par message) : seule la FAQ en parle, par la grille', () => {
    for (const s of SKILLS) expect(s.corps, s.nom).not.toMatch(/\b0[,.]\d|\bcts?\b|centimes?|\bcents?\b|\$\s*\d|\d\s*\$/);
  });

  it('🔴 la skill des règles dit le quota du jour de l’API sans le chiffrer (une limite invisible, spec offres v2)', () => {
    const corps = SKILLS.find((s) => s.nom === 'regles-whatsapp')!.corps;
    expect(corps).not.toContain(`${QUOTAS_API_DEFAUT.envois.toLocaleString('en-US')} sends a day`);
    expect(corps).not.toMatch(/\d[\d,]* (sends|templates|replies) a day/);
    expect(corps).toMatch(/templates and free-form\s+replies are counted separately/i);
    expect(corps).toContain('quota_exceeded');
  });

  it('🔴 les étapes nommées par la skill de mise en service sont celles de get_setup_state', async () => {
    const { OUTILS_DE_L_ETAPE } = await import('../src/mcp/mise-en-service');
    const corps = SKILLS.find((s) => s.nom === 'mise-en-service')!.corps;
    for (const etape of Object.keys(OUTILS_DE_L_ETAPE)) expect(corps, etape).toContain(etape);
  });

  it('🔴 allowed-tools ne pré-autorise que des lectures et l’attente du numéro, sous leur nom complet', () => {
    const lectures = new Set(OUTILS.filter((o) => o.annotations.readOnlyHint === true).map((o) => o.nom));
    for (const s of SKILLS) {
      const permis = s.champ('allowed-tools');
      if (permis === undefined) continue;
      for (const nom of permis.split(',').map((x) => x.trim())) {
        expect(nom.startsWith(PREFIXE), nom).toBe(true);
        const outil = nom.slice(PREFIXE.length);
        expect(Object.keys(CATALOGUE_MCP), nom).toContain(outil);
        expect(lectures.has(outil) || outil === 'watch_whatsapp_connection', `${outil} écrit : jamais pré-autorisé`).toBe(true);
      }
    }
  });
});
