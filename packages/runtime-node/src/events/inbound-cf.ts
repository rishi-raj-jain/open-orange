import type { IncomingMessage } from "node:http";

// Local dev has no Cloudflare edge, so every inbound request gets the same
// placeholder request.cf object that Miniflare uses when it cannot download
// the real one.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/cf.ts#L55-L108
const fallbackCf = {
	asOrganization: "",
	asn: 395747,
	botManagement: {
		corporateProxy: false,
		detectionIds: [],
		ja3Hash: "25b4882c2bcb50cd6b469ff28c596742",
		score: 99,
		staticResource: false,
		verifiedBot: false,
	},
	city: "Austin",
	clientTcpRtt: 0,
	clientTrustScore: 99,
	colo: "DFW",
	continent: "NA",
	country: "US",
	edgeRequestKeepAliveStatus: 0,
	latitude: "30.27130",
	longitude: "-97.74260",
	metroCode: "635",
	postalCode: "78701",
	region: "Texas",
	regionCode: "TX",
	requestPriority: "weight=192;exclusive=0",
	timezone: "America/Chicago",
	tlsCipher: "AEAD-AES128-GCM-SHA256",
	tlsClientAuth: {
		certChainRFC9440: "",
		certChainRFC9440TooLarge: false,
		certFingerprintSHA1: "",
		certFingerprintSHA256: "",
		certIssuerDN: "",
		certIssuerDNLegacy: "",
		certIssuerDNRFC2253: "",
		certIssuerSKI: "",
		certIssuerSerial: "",
		certNotAfter: "",
		certNotBefore: "",
		certPresented: "0",
		certRFC9440: "",
		certRFC9440TooLarge: false,
		certRevoked: "0",
		certSKI: "",
		certSerial: "",
		certSubjectDN: "",
		certSubjectDNLegacy: "",
		certSubjectDNRFC2253: "",
		certVerified: "NONE",
	},
	tlsVersion: "TLSv1.3",
} as const;

export function inboundRequestCf(request: IncomingMessage): Record<string, unknown> {
	return {
		...structuredClone(fallbackCf),
		httpProtocol: `HTTP/${request.httpVersion}`,
	};
}

// Miniflare sets CF-Connecting-IP to the client address unless the request
// already carries one.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/core/entry.worker.ts#L133-L142
export function connectingIp(request: IncomingMessage): string | undefined {
	const address = request.socket.remoteAddress;
	if (address === undefined) return undefined;
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}
