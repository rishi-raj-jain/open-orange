import nodeCrypto from "node:crypto";

import { ERR_METHOD_NOT_IMPLEMENTED } from "../node-internal/errors.js";

// esbuild's code splitting drops a star re-export of an external module when the re-exporting
// module is shared by several entries. Each entry re-exports `node:crypto` itself, and names the
// Orange additions explicitly so they take precedence over the star.
export * from "node:crypto";

// workerd's node:crypto exports names that Node.js does not: the KeyObject subclasses, the
// global CryptoKey, an alias of randomBytes, and, until the remove_nodejs_compat_eol_v22 flag,
// Cipher and createCipher stubs that throw. A missing export fails a whole module at import.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/crypto.ts#L532-L555

// Node.js keeps its KeyObject subclasses internal, so they are read from instances.
const keyPair = nodeCrypto.generateKeyPairSync("ed25519");
export const PublicKeyObject = keyPair.publicKey.constructor;
export const PrivateKeyObject = keyPair.privateKey.constructor;
export const SecretKeyObject = nodeCrypto.createSecretKey(Buffer.alloc(1)).constructor;

export const CryptoKey: unknown = Reflect.get(globalThis, "CryptoKey");
export const pseudoRandomBytes = nodeCrypto.randomBytes;

export function createCipher(): never {
	throw new ERR_METHOD_NOT_IMPLEMENTED("createCipher");
}
export function createDecipher(): never {
	throw new ERR_METHOD_NOT_IMPLEMENTED("createDecipher");
}
export function Cipher(): never {
	throw new ERR_METHOD_NOT_IMPLEMENTED("Cipher");
}
export function Decipher(): never {
	throw new ERR_METHOD_NOT_IMPLEMENTED("Decipher");
}

const additions = {
	Cipher,
	CryptoKey,
	Decipher,
	PrivateKeyObject,
	PublicKeyObject,
	SecretKeyObject,
	createCipher,
	createDecipher,
	pseudoRandomBytes,
};

// Descriptors keep Node.js's lazy getters, such as the deprecated `fips`, from running at import.
const cryptoModule: object = Object.defineProperties(
	Object.defineProperties({}, Object.getOwnPropertyDescriptors(nodeCrypto)),
	Object.getOwnPropertyDescriptors(additions),
);
// SAFETY: the object has every own property of node:crypto and of `additions`, so it has both types.
export default cryptoModule as typeof nodeCrypto & typeof additions;
