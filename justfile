[group('workspace')]
install:
	pnpm install

[group('cloudflare-conformance')]
conformance-generate:
	pnpm --filter @open-orange/cloudflare-conformance generate

[group('cloudflare-conformance')]
conformance-check:
	pnpm --filter @open-orange/cloudflare-conformance check

[group('cloudflare-conformance')]
conformance-upstream *args:
	pnpm --filter @open-orange/cloudflare-conformance upstream {{args}}
