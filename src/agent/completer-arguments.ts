import type { ParamOutil } from './llm/tool-schema';
import { champDuContact } from './champs-contact';

/**
 * COMPLÉTER LES ARGUMENTS D'UN OUTIL : ceux du modèle, PUIS les valeurs que le runtime pose lui-même (la fiche du contact,
 * un champ personnalisé, une constante). Un seul point de passage pour l'exécuteur d'un agent IA (`executerOutil`, étape
 * 4) et pour le relais de l'agent de Meta (`src/http/mba-relais.ts`), qui appelle les outils MCP depuis 2026-10-02.
 *
 * 🔴 C'EST LA GARDE D'IDENTITÉ, ET L'ORDRE EN EST LA MOITIÉ : l'injection écrit EN DERNIER, après les arguments du modèle,
 * donc une valeur du runtime n'est jamais écrasée. Sans cette séparation, un connecteur serait un IDOR offert à qui
 * écrit sur le numéro : il lui suffirait de demander la donnée d'un autre en changeant la valeur. Deux copies de cette
 * boucle dériveraient, et c'est pour ça qu'elle vit ici.
 *
 * Le numéro vient du tour (`waId`, authentifié : la signature du webhook de Meta pour un agent IA, l'en-tête que Meta
 * pose pour le relais), pas de la projection du contact, qui ne le porte pas.
 */
export function completerArguments(
  params: readonly ParamOutil[],
  argsModele: Readonly<Record<string, unknown>>,
  ctx: { waId: string; contact: Record<string, unknown> | null },
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...argsModele };
  for (const p of params) {
    if (p.source === 'contact') {
      const chemin = p.contactPath ?? p.name;
      args[p.name] = chemin === 'wa_id' ? ctx.waId : (ctx.contact ? (ctx.contact[chemin] ?? null) : null);
    } else if (p.source === 'champ') {
      // Un champ personnalisé que le modèle ne voit pas : il cloue un identifiant (e-mail, référence) à la fiche du
      // contact qui écrit. Absent, il rend `null` et l'appel part quand même : le serveur décide.
      args[p.name] = champDuContact(ctx.contact, p.cle ?? '');
    } else if (p.source === 'fixe') {
      args[p.name] = p.value ?? null;
    }
  }
  return args;
}
