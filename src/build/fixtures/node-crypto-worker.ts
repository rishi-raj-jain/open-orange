import {
	constants,
	createPublicKey,
	generateKeyPairSync,
	KeyObject,
	type KeyObject as NodeKeyObject,
	privateDecrypt,
	publicEncrypt,
} from "node:crypto";

// openauth encrypts through jose, whose Node.js build turns JWKs and CryptoKeys into KeyObjects
// and calls publicEncrypt with RSA-OAEP.
const oaep = {
	oaepHash: "sha256",
	padding: constants.RSA_PKCS1_OAEP_PADDING,
};

function roundTrip(publicKey: NodeKeyObject, privateKey: NodeKeyObject): string {
	const ciphertext = publicEncrypt(
		{ key: publicKey, ...oaep },
		new TextEncoder().encode("secret"),
	);
	return privateDecrypt({ key: privateKey, ...oaep }, ciphertext).toString();
}

export default {
	async fetch(): Promise<Response> {
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const jwk = publicKey.export({ format: "jwk" });
		const fromJwk = createPublicKey({ key: jwk, format: "jwk" });
		const cryptoKey = await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSA-OAEP", hash: "SHA-256" },
			true,
			["encrypt"],
		);
		const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
		let wrongKey = "decrypted";
		try {
			roundTrip(fromJwk, otherKey);
		} catch (error) {
			wrongKey = String(Reflect.get(Object(error), "code"));
		}
		return Response.json({
			fromJwk: roundTrip(fromJwk, privateKey),
			fromCryptoKey: roundTrip(KeyObject.from(cryptoKey), privateKey),
			wrongKey,
		});
	},
};
