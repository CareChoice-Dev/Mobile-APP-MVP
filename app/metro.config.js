const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js (>= ~2.50) ships an *optional* dynamic import of
// `@opentelemetry/api`, guarded at runtime by `.catch(() => null)`. The package
// is not a real dependency. Other bundlers skip it via the inline
// webpackIgnore/@vite-ignore comments, but Metro doesn't honor those and fails
// to resolve it. Stub it to an empty module so the optional import no-ops.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@opentelemetry/api') {
    return { type: 'empty' };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
