/**
 * `npm run sdk:contrat` : recopie le contrat OpenAPI dans le SDK (`sdk/openapi.json`) et en génère les types
 * (`sdk/src/schema.ts`, par `openapi-typescript`, dépendance de développement à version exacte). À relancer après toute
 * modification du contrat (`src/api/openapi/`) : `tests/sdk-contrat.test.ts` refait les deux à partir du code et exige
 * l'égalité au caractère près, donc un SDK en retard sur l'API rend la CI rouge.
 *
 * Le contrat recopié porte l'adresse de PRODUCTION, celle que le SDK appelle par défaut : jamais `PUBLIC_API_URL`, qui
 * changerait le fichier selon le poste qui lance le script.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { contratOpenapi } from '../src/api/openapi/index';

export const BASE_SDK = 'https://api.messagingme.app';

const ENTETE_SCHEMA = [
  '// GÉNÉRÉ par `npm run sdk:contrat` depuis `sdk/openapi.json` (openapi-typescript) : ne pas modifier à la main.',
  '// `tests/sdk-contrat.test.ts` le régénère et exige l\'égalité.',
  '',
].join('\n');

/** Le contrat tel que le SDK l'embarque, et son texte (indenté, terminé par un saut de ligne). */
export function contratDuSdk(): { contrat: Record<string, unknown>; texte: string } {
  const contrat = contratOpenapi(BASE_SDK);
  return { contrat, texte: `${JSON.stringify(contrat, null, 2)}\n` };
}

/** Les types du SDK, générés depuis le contrat. */
export async function schemaDuSdk(contrat: Record<string, unknown>): Promise<string> {
  // Notre propre document, typé `Record` par le code : la conversion ne fait que le nommer pour openapi-typescript. Il
  // ne refuse qu'une référence cassée (mesuré : un document sans `info` passe) ; la forme du document est tenue par
  // `tests/openapi.test.ts`.
  const ast = await openapiTS(contrat as unknown as Parameters<typeof openapiTS>[0]);
  return ENTETE_SCHEMA + astToString(ast);
}

async function main(): Promise<void> {
  const { contrat, texte } = contratDuSdk();
  writeFileSync(fileURLToPath(new URL('../sdk/openapi.json', import.meta.url)), texte);
  writeFileSync(fileURLToPath(new URL('../sdk/src/schema.ts', import.meta.url)), await schemaDuSdk(contrat));
  console.log('sdk/openapi.json et sdk/src/schema.ts réécrits');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
