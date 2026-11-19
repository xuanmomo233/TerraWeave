import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PROJECT=fileURLToPath(new URL('../',import.meta.url)).replace(/[\\/]$/,'');
export const ROOT=process.env.TERRAWEAVE_STATE?path.resolve(PROJECT,process.env.TERRAWEAVE_STATE):path.join(PROJECT,'project-state','workbench');
