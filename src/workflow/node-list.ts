import type { WorkflowNodeType } from './graph';
import type { WorkflowRow } from './store.pg';

/**
 * Un node aplati depuis les graphes de workflows, pour l'affichage « Contenu > Blocs ».
 * `code` = code public `nod_<client>_<ulid>` (dans `node.data.code`), null pour un node jamais re-sauvegardé
 * depuis l'arrivée des codes (Lot 4b) : la liste tolère l'absence de code, elle ne le fabrique pas.
 */
export interface NodeListItem {
  code: string | null;
  type: WorkflowNodeType;
  /** Nom libre donné par l'utilisateur au bloc (`data.name`), borné. Vide si non renseigné. */
  name: string;
  workflowId: string;
  workflowName: string;
  /** Résumé humain, dérivé de `data` selon le type (même logique que le builder). Borné, jamais null. */
  summary: string;
}

const NOD_RE = /^nod_[0-9a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Résumé court d'un node selon son type. `data` est opaque : tout est coercé + borné, jamais de throw. */
export function summarize(type: WorkflowNodeType, data: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
  let out: string;
  switch (type) {
    case 'template': out = s(data.templateName); break;
    case 'quick_message': out = s(data.body); break;
    // Aligné sur le résumé du canevas (`summaryOf`, web/components/WorkflowBuilder.tsx, qui lit `data.text`) :
    // sans ce cas, les blocs RCS tombaient sur `default` et s'affichaient ici avec un résumé VIDE, donc
    // indistinguables les uns des autres. C'est l'incident déjà vécu pour le bloc `wait` plus bas.
    case 'rcs_message': out = s(data.text); break;
    // Bloc QUESTION : la question, plus le nombre de choix quand il y a un menu. Même résumé que le canevas
    // (`summaryOf`). Sans ce cas il tomberait sur `default` et s'afficherait VIDE : c'est exactement ce qui
    // est arrivé au bloc Attente, puis au bloc RCS, chacun à son tour.
    case 'question': {
      const q = s(data.body);
      const n = Array.isArray(data.rows) ? data.rows.filter((r) => s((r as { title?: unknown })?.title) !== '').length : 0;
      out = q === '' ? '' : n === 0 ? q : `${q} (${n} choix)`;
      break;
    }
    case 'flow': out = s(data.flowName); break;
    case 'tag': out = s(data.tag); break;
    case 'field': {
      // Le builder persiste `fieldLabel` (libellé affiché) + `fieldKey` (clé) ; `key` n'est qu'un fallback
      // pour d'éventuelles très vieilles données. Même logique que summaryOf / engine (fieldKey ?? key).
      const key = s(data.fieldLabel ?? data.fieldKey ?? data.key);
      const val = s(data.value);
      out = key === '' ? '' : val === '' ? key : `${key} = ${val}`;
      break;
    }
    case 'wait': {
      // Aligné sur le résumé du builder : sans ce cas, « Contenu > Blocs » listait des blocs Attente au
      // résumé VIDE (branche default), donc impossibles à distinguer les uns des autres. Les trois modes y
      // sont, sinon une attente datée retomberait dans le résumé vide qu'on venait de corriger.
      const mode = String(data.waitMode ?? 'delai');
      if (mode === 'heures_ouvrees') { out = 'jusqu’aux heures ouvrées'; break; }
      if (mode === 'date') {
        const brut = String(data.waitDate ?? '').trim();
        out = brut === '' ? '' : `jusqu’au ${brut.replace('T', ' ')}`;
        break;
      }
      const n = Number(data.delay ?? 0);
      const u = String(data.unit ?? 'hours');
      const lib = u === 'minutes' ? 'min' : u === 'days' ? 'j' : 'h';
      out = !Number.isFinite(n) || n <= 0 ? '' : `attendre ${n} ${lib}`;
      break;
    }
    case 'condition': {
      const clauses = Array.isArray(data.clauses) ? data.clauses.length : 0;
      const combineur = data.match === 'any' ? 'au moins une' : 'toutes';
      out = clauses === 0 ? 'Condition' : `Si ${combineur} de ${clauses} condition${clauses > 1 ? 's' : ''}`;
      break;
    }
    case 'action': {
      const kind = String(data.actionKind ?? '');
      const tag = s(data.tag);
      const key = s(data.fieldLabel ?? data.fieldKey ?? data.key);
      if (kind === 'add_tag') out = tag === '' ? '' : `+ ${tag}`;
      else if (kind === 'remove_tag') out = tag === '' ? '' : `− ${tag}`;
      else if (kind === 'set_field') { const val = data.valueKind === 'now' ? 'maintenant' : data.valueKind === 'derniere_saisie' ? 'dernier message' : s(data.value); out = key === '' ? '' : val === '' ? key : `${key} = ${val}`; }
      else if (kind === 'clear_field') out = key === '' ? '' : `${key} (vidé)`;
      else if (kind === 'set_optin') out = 'passer en opt-in';
      else if (kind === 'set_optout') out = 'passer en opt-out';
      else out = '';
      break;
    }
    case 'email': {
      // Même contrat que les autres blocs de config : non configuré -> chaîne vide (pas de placeholder).
      // ⚠️ Lit les DEUX formes de `to` (objet avant le 2026-08-25, liste depuis), comme le moteur et le
      // canevas : n'en lire qu'une afficherait un résumé vide sur des blocs qui envoient très bien.
      type Dest = { kind?: unknown; value?: unknown; field?: unknown };
      const bruts: Dest[] = Array.isArray(data.to) ? (data.to as Dest[]) : [data.to as Dest];
      const cibles = bruts
        .map((dst) => (dst?.kind === 'field' ? (s(dst.field) === '' ? '' : `{{${s(dst.field)}}}`) : s(dst?.value)))
        .filter((x) => x !== '');
      const reste = cibles.length - 1;
      out = cibles.length === 0 ? '' : reste === 0 ? `Mail vers ${cibles[0]}` : `Mail vers ${cibles[0]} +${reste}`;
      break;
    }
    case 'inbox': out = ''; break;
    // Ce que la liste des blocs montre d'un appel HTTP : le champ où la réponse atterrit. L'appel lui-même
    // est nommé dans la bibliothèque, pas ici : un identifiant n'apprendrait rien à qui lit la liste.
    case 'http': out = s(data.champCible) === '' ? '' : `-> ${s(data.champCible)}`; break;
    // Les deux champs, pas le code : une liste de blocs doit tenir sur une ligne, et le code n'y tiendrait pas.
    case 'js': out = s(data.champSource) === '' || s(data.champCible) === '' ? '' : `${s(data.champSource)} -> ${s(data.champCible)}`; break;
    case 'agent': out = s(data.label); break;
    default: out = '';
  }
  return out.slice(0, 120);
}

/**
 * Aplati tous les nodes des workflows d'un tenant en une liste requêtable par type. PUR (aucune IO).
 * Filtré optionnellement par `type`. Ordre : par workflow (comme reçu), puis par ordre des nodes dans le graphe.
 * Un `code` présent mais non conforme au motif `nod_..._<ulid>` est traité comme absent (null).
 */
export function collectNodes(workflows: WorkflowRow[], type?: WorkflowNodeType): NodeListItem[] {
  const out: NodeListItem[] = [];
  for (const wf of workflows) {
    for (const n of wf.graph.nodes) {
      if (type !== undefined && n.type !== type) continue;
      const raw = typeof n.data.code === 'string' ? n.data.code : '';
      out.push({
        code: NOD_RE.test(raw) ? raw : null,
        type: n.type,
        name: String(n.data.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 64),
        workflowId: wf.id,
        workflowName: wf.name,
        summary: summarize(n.type, n.data),
      });
    }
  }
  return out;
}
