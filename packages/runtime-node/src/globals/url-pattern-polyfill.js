// Plain JavaScript so TypeScript does not load the polyfill's global types,
// which clash with @types/node. Sets URLPattern only where it is missing.
import "urlpattern-polyfill";
