import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { compressionFetch } from './transport.mjs';

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    const ids = new Set(ctx.modelRegistry.getAll().map(model => model.provider));
    for (const id of ids) {
      const provider = ctx.modelRegistry.getProvider(id);
      if (!provider?.getModels().some(model => {
        try {
          const url = new URL(model.baseUrl);
          return url.protocol === 'https:' && ['www.gafeteria.com', 'sub2api.gapsee.com'].includes(url.hostname);
        } catch { return false; }
      })) continue;
      const optionsWithCompression = <T extends { fetch?: typeof globalThis.fetch }>(options?: T) => ({
        ...options,
        fetch: compressionFetch(options?.fetch ?? globalThis.fetch, metadata => {
          if (process.env.PI_COMPRESSION_DEBUG === '1') {
            process.stderr.write(`[request-compression] ${JSON.stringify(metadata)}\n`);
          }
        }),
      });
      pi.registerProvider({
        ...provider,
        stream: (model, context, options) => provider.stream(model, context, optionsWithCompression(options)),
        streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsWithCompression(options)),
      });
    }
  });
}