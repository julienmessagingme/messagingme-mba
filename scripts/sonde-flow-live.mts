/**
 * Sonde LIVE de non-régression du générateur Flow JSON (gate T6 du Lot 7, réutilisable).
 * Génère un flow_json via LE CODE PRODUIT (deriveScreens + buildFlowScreens : multi-écrans + conditions),
 * le POSTe en DRAFT sur le WABA réel, exige validation_errors == [], puis SUPPRIME le draft.
 *
 * Usage (token jamais loggé) :
 *   MBA_TOKEN=$(ssh ubuntu@VPS "grep '^META_ACCESS_TOKEN=' /home/ubuntu/mba/.env.prod | cut -d= -f2-") \
 *   WABA_ID=<waba> npx tsx scripts/sonde-flow-live.mts
 * Env optionnel : GRAPH_V (défaut v25.0), FLOW_JSON_V (défaut 7.2).
 */
import { buildFlowScreens, deriveScreens } from '../src/meta/flow-json';

const TOKEN = process.env.MBA_TOKEN;
const WABA = process.env.WABA_ID;
const V = process.env.GRAPH_V || 'v25.0';
const FJV = process.env.FLOW_JSON_V || '7.2';
if (!TOKEN || !WABA) {
  console.error('MBA_TOKEN et WABA_ID requis');
  process.exit(1);
}
const BASE = `https://graph.facebook.com/${V}`;

// Fixture représentative : 2 écrans, conditions radio ET optin, tous les genres d'éléments sauf image
// (l'image base64 gonflerait la sonde sans rien prouver de plus sur la structure).
const screens = deriveScreens([
  {
    title: 'Vos coordonnées',
    cta: 'Étape suivante',
    elements: [
      { kind: 'heading', text: 'Parlons de vous' },
      { kind: 'field', label: 'Prénom', type: 'text', required: true },
      { kind: 'field', label: 'Souhaitez-vous être rappelé ?', type: 'radio', required: true, options: ['Oui', 'Non'] },
      { kind: 'field', label: 'Téléphone', type: 'phone', required: true, visibleIf: { field: 'Souhaitez-vous être rappelé ?', op: 'eq', value: 'Oui' } },
      { kind: 'body', text: 'Merci, on vous rappelle vite.', visibleIf: { field: 'Souhaitez-vous être rappelé ?', op: 'eq', value: 'Oui' } },
    ],
  },
  {
    title: 'Votre demande',
    elements: [
      { kind: 'field', label: 'Sujet', type: 'dropdown', required: true, options: ['Devis', 'Support', 'Autre'] },
      { kind: 'field', label: 'Précisez', type: 'textarea', required: false, visibleIf: { field: 'Sujet', op: 'eq', value: 'Autre' } },
      { kind: 'field', label: 'Consentement', type: 'optin', required: true },
      { kind: 'field', label: 'Email', type: 'email', required: false, visibleIf: { field: 'Consentement', op: 'eq', value: true } },
    ],
  },
]);
const flowJson = buildFlowScreens('sonde-t6-generateur', screens, FJV, 'sonde-ref-t6', 'Envoyer');

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const create = await fetch(`${BASE}/${WABA}/flows`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: `sonde-t6-${Math.random().toString(36).slice(2, 8)}`, categories: ['LEAD_GENERATION'], flow_json: JSON.stringify(flowJson) }),
});
const created = (await create.json()) as { id?: string; validation_errors?: unknown[]; error?: unknown };
const errs = created.validation_errors ?? [];
console.log(JSON.stringify({ status: create.status, id: created.id ?? null, validation_errors: errs, error: created.error ?? null }, null, 2));

if (created.id) {
  const del = await fetch(`${BASE}/${created.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log(JSON.stringify({ cleanup: del.status, ...(await del.json()) as object }));
}

// Verdict : créé + zéro validation_error = générateur accepté par Meta tel quel.
process.exit(created.id && errs.length === 0 ? 0 : 1);
