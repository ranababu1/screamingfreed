import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSeedUrls,
  parseUrlList,
} from '../src/ingestion/urlLoader.js';

describe('parseUrlList', () => {
  it('splits on commas and newlines and drops empty entries', () => {
    expect(
      parseUrlList('https://a.com\nhttps://b.com, https://c.com\n\n,https://d.com'),
    ).toEqual(['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com']);
  });
});

describe('loadSeedUrls', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sf-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers --urls over --file', async () => {
    const file = join(dir, 'seeds.txt');
    await writeFile(file, 'https://file.example.com/1\n', 'utf8');
    const urls = await loadSeedUrls({
      urls: 'https://urls.example.com/1,https://urls.example.com/2',
      file,
    });
    expect(urls).toEqual(['https://urls.example.com/1', 'https://urls.example.com/2']);
  });

  it('loads a .txt file, skipping blank lines and trimming entries', async () => {
    const file = join(dir, 'seeds.txt');
    await writeFile(file, '\nhttps://a.com/1\n\n  https://b.com/2  \n', 'utf8');
    await expect(loadSeedUrls({ file })).resolves.toEqual([
      'https://a.com/1',
      'https://b.com/2',
    ]);
  });

  it('uses the first CSV column for .csv files', async () => {
    const file = join(dir, 'seeds.csv');
    await writeFile(
      file,
      'url,label\nhttps://a.com/1,Home\nhttps://b.com/2,"Quoted, name"\n',
      'utf8',
    );
    await expect(loadSeedUrls({ file })).resolves.toEqual([
      'url',
      'https://a.com/1',
      'https://b.com/2',
    ]);
  });

  it('rejects a missing file with a helpful error', async () => {
    const missing = join(dir, 'does-not-exist.txt');
    await expect(loadSeedUrls({ file: missing })).rejects.toThrow(
      /Unable to read seed file/,
    );
  });
});