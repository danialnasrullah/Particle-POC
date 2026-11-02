// POC stub for redox-backend-nest/src/rule-categorization/engine/paths.ts. Only
// body_system_lookup.json is copied, so this points straight at the files/ folder
// (copied to dist by the nest-cli assets entry). On merge: delete this file.
import { join } from 'node:path';

export const FILES_DIR: string = join(__dirname, '..', 'files');
