import { createHash, randomInt } from 'node:crypto';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { ApiError } from './repository.js';
export const color = z.enum(['RED', 'GOLD', 'BLUE']);
export const symbol = z.enum(['Y', 'A', 'L', 'Star', 'Crown', 'Camel']);
export const outcomeSchema = z.strictObject({ ball: z.string().regex(/^Ball(00[1-9]|01\d|02[0-5])$/), color, symbol });
export type Outcome = z.infer<typeof outcomeSchema>;
const row = outcomeSchema.extend({ setId: z.number().int().positive(), order: z.array(z.number().int().min(0).max(24)).length(25)
  .refine(a => new Set(a).size === 25) });
export interface AssignedSet { poolFileId: string; poolVersion: string; setId: number; setKey: string;
  seed: number; physicsVersion: string; order: number[]; expected: Outcome }
export function validatePool(text: string, file: string): AssignedSet[] {
  const rows = z.array(row).length(1_000).parse(JSON.parse(text));
  if (new Set(rows.map(r => r.setId)).size !== rows.length) throw new Error('Duplicate set IDs');
  const mapping = new Map<string, string>();
  const poolVersion = createHash('sha256').update(text).digest('hex');
  return rows.map(({ setId, order, ...expected }) => {
    const pair = `${expected.color}/${expected.symbol}`;
    if (mapping.has(expected.ball) && mapping.get(expected.ball) !== pair) throw new Error('Conflicting ball mapping');
    mapping.set(expected.ball, pair);
    return { poolFileId: file, poolVersion, setId, setKey: `${file}:${setId}`, seed: 12345,
      physicsVersion: process.env.PHYSICS_VERSION ?? 'fixed-fresh-round-v1', order, expected };
  });
}
export interface PoolSource { pick(): Promise<AssignedSet> }
export class ResultPools implements PoolSource {
  private cached: AssignedSet[] = []; private expires = 0; private loading?: Promise<void>;
  constructor(private s3 = new S3Client({}), private bucket = process.env.RESULT_POOL_BUCKET ?? '',
    private prefix = process.env.RESULT_POOL_PREFIX ?? 'result-pools/v1/', private clock = Date.now) {}
  async pick(): Promise<AssignedSet> {
    if (this.clock() >= this.expires) {
      this.loading ??= this.refresh().finally(() => { this.loading = undefined; });
      await this.loading;
    }
    if (!this.cached.length) throw new ApiError(503, 'RESULT_POOL_UNAVAILABLE');
    return structuredClone(this.cached[randomInt(this.cached.length)]!);
  }
  private async refresh() {
    const sets: AssignedSet[] = []; let token: string | undefined;
    // A failed listing must not serve an indefinitely stale pool after deletion/change.
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }));
      for (const file of page.Contents ?? []) {
        const key = file.Key;
        if (!key || key !== `${this.prefix}result_pool_1000.json`) continue;
        try {
          if (!file.Size || file.Size > 1_000_000) throw new Error('Invalid pool size');
          const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
          if (!object.Body) throw new Error('Missing pool body');
          sets.push(...validatePool(await object.Body.transformToString(), key));
        } catch { console.warn(JSON.stringify({ event: 'RESULT_POOL_EXCLUDED', key })); }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    this.cached = sets; this.expires = this.clock() + 60_000;
  }
}
