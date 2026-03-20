import { existsSync, readFileSync } from 'fs';
import path from 'path';

const memoryDir = path.resolve(process.cwd(), 'memory');

function readMemoryFile(name: string, fallback: string) {
  const filePath = path.join(memoryDir, name);
  if (!existsSync(filePath)) {
    return fallback;
  }

  return readFileSync(filePath, 'utf8').trim() || fallback;
}

export function loadMemoryProfile() {
  return {
    role: readMemoryFile('ROLE.md', 'Umar is a full-stack developer covering product, frontend, backend, and delivery work.'),
    skill: readMemoryFile('SKILL.md', 'Default skills: answer engineering questions, break down tasks, create implementation plans, and handle low-risk development work.'),
    soul: readMemoryFile('SOUL.md', 'Voice: calm, practical, concise, collaborative, and ownership-oriented.'),
  };
}
