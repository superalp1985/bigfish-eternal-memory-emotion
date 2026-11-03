import { createMemoryServer } from './server.mjs';
import { createDshAdapter } from './dsh-adapter.mjs';
import { createAnalysis } from './analysis.mjs';

export const name = 'fame-memory';
export const inject = ['agents', 'sessions', 'llm'];

export function apply(ctx, config = {}) {
  const settings = {
    root: 'E:/FAME-DSH-Memory/data', port: 5196,
    provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 4096,
    maxActiveEvents: 600, maxActiveChars: 64000, recentChars: 16000, ...config,
  };
  ctx.effect(async () => {
    const app = await createMemoryServer({
      root: settings.root, port: settings.port,
      adapterFactory: async store => {
        const analysis = createAnalysis(ctx, store, settings);
        return createDshAdapter(ctx, store, { ...settings, ...analysis });
      },
    });
    console.log(`BigFish Eternal Memory & Emotion ready: ${app.url}`);
    return () => app.close();
  });
}
