import { describe, it, expect } from 'vitest';
import { regenBot } from '../src/balance.js';
import { BotsConfigs, DEFAULT_BOTS } from '../src/bots-config.js';
import type { S3Client } from '@aws-sdk/client-s3';
const h=3600000, start='2026-01-01T00:00:00.000Z', t=Date.parse(start);
describe('raid bot shield regeneration',()=>{
  it('accumulates complete intervals, caps at three, and discards excess',()=>{
    const b={shieldCount:0,shieldRegenAt:start};
    expect(regenBot(b,t+3*h,3).shieldCount).toBe(1);
    expect(regenBot(b,t+6*h,3).shieldCount).toBe(2);
    expect(regenBot(b,t+9*h,3)).toEqual({shieldCount:3,shieldRegenAt:null});
    expect(regenBot({shieldCount:3,shieldRegenAt:null},t+100*h,3)).toEqual({shieldCount:3,shieldRegenAt:null});
    expect(regenBot(b,t+4*h,3).shieldRegenAt).toBe(new Date(t+3*h).toISOString());
  });
  it('starts missing legacy timestamps without changing shields and honors a new interval',()=>{
    expect(regenBot({shieldCount:1},t,3)).toEqual({shieldCount:1,shieldRegenAt:start});
    expect(regenBot({shieldCount:1,shieldRegenAt:start},t+3*h,6).shieldCount).toBe(1);
    expect(regenBot({shieldCount:1,shieldRegenAt:start},t+6*h,6).shieldCount).toBe(2);
  });
  it('caches valid S3 updates and retains the last valid value on errors or invalid data',async()=>{
    let now=0, value:any=3, calls=0;
    const s3={send:async()=>{calls++;if(value==='error')throw Error();return {ContentLength:50,Body:{transformToString:async()=>JSON.stringify({...DEFAULT_BOTS,shield:{maximum:3,regenHours:value}})}};}} as unknown as S3Client;
    const c=new BotsConfigs(s3,'bucket','dev',()=>now);
    expect((await c.load()).shield.regenHours).toBe(3);value=6;expect((await c.load()).shield.regenHours).toBe(3);
    now+=60001;expect((await c.load()).shield.regenHours).toBe(6);value=-1;now+=60001;expect((await c.load()).shield.regenHours).toBe(6);
    value='error';now+=60001;expect((await c.load()).shield.regenHours).toBe(6);expect(calls).toBe(4);
    const fallback=new BotsConfigs(s3,'bucket','dev',()=>now);expect((await fallback.load()).shield.regenHours).toBe(3);
  });
});
