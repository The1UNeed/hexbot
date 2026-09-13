// Prints a private ES256 JWK on one line for CONNECT_SIGNING_KEY_JWK.
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
jwk.kid = await calculateJwkThumbprint(await exportJWK(publicKey));
console.log(JSON.stringify(jwk));
