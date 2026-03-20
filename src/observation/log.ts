import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';

const observationDir = path.resolve(process.cwd(), 'data');
const observationFile = path.join(observationDir, 'observations.ndjson');

export function logObservation(event: Record<string, unknown>) {
  mkdirSync(observationDir, { recursive: true });
  appendFileSync(
    observationFile,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
    'utf8'
  );
}
