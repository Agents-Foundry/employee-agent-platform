import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ArtifactRetentionPolicy } from '@agents-foundry/contracts';
import type { ProducedArtifact } from './execution-provider.js';

/**
 * How long each kind of evidence is kept (ADR 0037). Reports are small and are what a defect
 * refers to; traces, screenshots and videos show page content and are kept for a month or less.
 */
export const EVIDENCE_RETENTION: Record<ProducedArtifact['type'], ArtifactRetentionPolicy> = {
  test_report: 'EXTENDED_365D',
  log: 'STANDARD_30D',
  console_log: 'STANDARD_30D',
  network_log: 'STANDARD_30D',
  screenshot: 'STANDARD_30D',
  playwright_trace: 'STANDARD_30D',
  video: 'EPHEMERAL',
};

interface Kind {
  type: ProducedArtifact['type'];
  mediaType: string;
  match: RegExp;
  maxBytes: number;
  maxFiles: number;
}

/** What is collected from a Playwright output directory, and how much of it. */
export const EVIDENCE_KINDS: readonly Kind[] = [
  {
    type: 'playwright_trace',
    mediaType: 'application/zip',
    match: /(^|[\\/])trace\.zip$/i,
    maxBytes: 48 * 1024 * 1024,
    maxFiles: 4,
  },
  {
    type: 'screenshot',
    mediaType: 'image/png',
    match: /\.png$/i,
    maxBytes: 4 * 1024 * 1024,
    maxFiles: 20,
  },
  {
    type: 'screenshot',
    mediaType: 'image/jpeg',
    match: /\.jpe?g$/i,
    maxBytes: 4 * 1024 * 1024,
    maxFiles: 20,
  },
  {
    type: 'video',
    mediaType: 'video/webm',
    match: /\.webm$/i,
    maxBytes: 24 * 1024 * 1024,
    maxFiles: 2,
  },
];
/** All browser evidence of one run together. */
export const MAX_EVIDENCE_BYTES = 160 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 6;

export interface CollectedEvidence {
  artifacts: ProducedArtifact[];
  /** Files that were there but over a limit, so the report can say evidence is incomplete. */
  omitted: number;
}

function artifactName(path: string): string {
  const flat = path
    .split(/[\\/]/)
    .join('-')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return flat.length > 120 ? flat.slice(flat.length - 120).replace(/^[._-]+/, '') : flat;
}

/**
 * Traces, screenshots and videos Playwright left in `directory`. Regular files only, which
 * really are inside the directory; each kind is limited in size and count, and so is the
 * whole. The test code controls these files, so nothing here trusts their names or sizes.
 */
export async function collectPlaywrightEvidence(directory: string): Promise<CollectedEvidence> {
  let root: string;
  try {
    root = await realpath(directory);
  } catch {
    return { artifacts: [], omitted: 0 };
  }
  const files: { path: string; size: number }[] = [];
  let entries = 0;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const names = await readdir(current).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if ((entries += 1) > MAX_ENTRIES) return;
      const path = join(current, name);
      const info = await lstat(path).catch(() => null);
      if (!info || info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(path, depth + 1);
      else if (info.isFile()) files.push({ path, size: info.size });
    }
  };
  await walk(root, 0);

  const artifacts: ProducedArtifact[] = [];
  const taken = new Map<Kind, number>();
  const names = new Set<string>();
  let total = 0;
  let omitted = 0;
  for (const file of files) {
    const local = relative(root, file.path);
    const kind = EVIDENCE_KINDS.find((candidate) => candidate.match.test(local));
    if (!kind) continue;
    const count = taken.get(kind) ?? 0;
    if (
      file.size === 0 ||
      file.size > kind.maxBytes ||
      count >= kind.maxFiles ||
      total + file.size > MAX_EVIDENCE_BYTES
    ) {
      omitted += 1;
      continue;
    }
    // Read what is there now; a file that grew past its limit meanwhile is left out.
    const real = await realpath(file.path).catch(() => null);
    if (!real || !(real === root || real.startsWith(root + sep))) continue;
    const content = await readFile(real).catch(() => null);
    if (!content || content.byteLength > kind.maxBytes) {
      omitted += 1;
      continue;
    }
    let name = artifactName(local);
    for (let index = 2; names.has(name); index += 1) name = `${index}-${artifactName(local)}`;
    names.add(name);
    taken.set(kind, count + 1);
    total += content.byteLength;
    artifacts.push({
      name,
      type: kind.type,
      mediaType: kind.mediaType,
      content,
      retention: EVIDENCE_RETENTION[kind.type],
    });
  }
  return { artifacts, omitted };
}
