"use strict";
// Minimal READ-ONLY client for SAP Credential Store — used by the manager to
// fetch the technical CF management user ("option B": no passcode).
//
// Facts (proven live in the figaf-platform playground, 2026-08-31):
//   - Binding (VCAP_SERVICES.credstore[0].credentials): url, username, password,
//     encryption.client_private_key (PKCS8), encryption.server_public_key (SPKI),
//     both base64-DER (PEM tolerated).
//   - Every call carries Basic auth + the `sapcp-credstore-namespace` header.
//   - With basic auth, payload encryption is mandatory: responses are compact
//     JWE strings (RSA-OAEP-256 + A256GCM) decrypted with the client private key.
//   - A "password" credential JSON carries { name, value, username?, ... }.
//
// The manager only READS (one credential, at login time), so this client
// implements JWE decryption with plain node:crypto — no extra dependency.
// No secret value or key material is ever logged.

const crypto = require("node:crypto");

const MANAGEMENT_NAMESPACE = "figaf-manager";
const MANAGEMENT_CREDENTIAL = "cf-management-user";

/** VCAP_SERVICES credstore binding, or null. */
function findCredstoreBinding(env = process.env) {
  try {
    const vcap = JSON.parse(env.VCAP_SERVICES || "{}");
    const entries = vcap.credstore || [];
    return (entries[0] && entries[0].credentials) || null;
  } catch {
    return null;
  }
}

/** Accepts PEM or base64-DER key material (PKCS8 private / SPKI public). */
function loadKey(material, isPrivate) {
  const text = String(material || "").trim();
  if (!text) throw new Error(`credstore binding is missing the ${isPrivate ? "client private" : "server public"} key`);
  if (text.includes("BEGIN")) {
    return isPrivate ? crypto.createPrivateKey(text) : crypto.createPublicKey(text);
  }
  const der = Buffer.from(text, "base64");
  return isPrivate
    ? crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    : crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * Decrypt a compact JWE (RSA-OAEP-256 key wrap + A256GCM content encryption)
 * with node:crypto. AAD is the ASCII bytes of the protected-header segment,
 * per RFC 7516 §5.1 step 14.
 */
function decryptJweCompact(token, privateKey) {
  const parts = String(token).trim().split(".");
  if (parts.length !== 5) throw new Error("response is not a compact JWE");
  const [h, k, iv, c, tag] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")); }
  catch { throw new Error("JWE protected header is not valid JSON"); }
  if (header.alg !== "RSA-OAEP-256" || header.enc !== "A256GCM") {
    throw new Error(`unsupported JWE algorithms: ${header.alg}/${header.enc}`);
  }
  const cek = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(k, "base64url")
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", cek, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(h, "ascii"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(c, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Encrypt a payload as a compact JWE the way the store requires for writes:
 * RSA-OAEP-256 key wrap + A256GCM, and the mandatory `iat` protected-header
 * claim in SECONDS (milliseconds are rejected with a generic HTTP 400 —
 * learned the hard way in the playground trial).
 */
function encryptJweCompact(payloadObject, publicKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM", iat: Math.floor(Date.now() / 1000) })
  ).toString("base64url");
  const cek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cek, iv);
  cipher.setAAD(Buffer.from(header, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payloadObject), "utf8"), cipher.final()]);
  const encKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    cek
  );
  return [
    header,
    encKey.toString("base64url"),
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/**
 * Create/replace one password-type credential ({ name, value, username }).
 * Used by the manager's own "set up management user" UI flow. Throws on
 * failure with a safe (secret-free) message.
 */
async function writeCredential(binding, opts = {}, fetchImpl = fetch) {
  const namespace = opts.namespace || MANAGEMENT_NAMESPACE;
  const name = opts.name || MANAGEMENT_CREDENTIAL;
  const baseUrl = String(binding.url || "").replace(/\/+$/, "");
  if (!baseUrl || !binding.username || !binding.password) {
    throw new Error("credstore binding is missing url/username/password (was the instance created with basic authentication?)");
  }
  const serverPublicKey = loadKey(binding.encryption && binding.encryption.server_public_key, false);
  const body = encryptJweCompact({ name, value: String(opts.value), username: opts.username }, serverPublicKey);
  const response = await fetchImpl(`${baseUrl}/password`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${binding.username}:${binding.password}`).toString("base64"),
      "sapcp-credstore-namespace": namespace,
      "Content-Type": "application/jose",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `credstore write failed: HTTP ${response.status}` +
      (response.status === 429 ? " (rate limit — wait a minute and retry)" : "")
    );
  }
}

/**
 * Read one password-type credential. Returns { name, value, username } or
 * null when the credential does not exist (HTTP 404). Throws on any other
 * failure with a safe (secret-free) message.
 *
 * @param {object} binding   credstore binding (url/username/password/encryption)
 * @param {object} [opts]    { namespace, name }
 * @param {Function} [fetchImpl]  injectable for tests; defaults to global fetch
 */
async function readCredential(binding, opts = {}, fetchImpl = fetch) {
  const namespace = opts.namespace || MANAGEMENT_NAMESPACE;
  const name = opts.name || MANAGEMENT_CREDENTIAL;
  const baseUrl = String(binding.url || "").replace(/\/+$/, "");
  if (!baseUrl || !binding.username || !binding.password) {
    throw new Error("credstore binding is missing url/username/password (was the instance created with basic authentication?)");
  }
  const privateKey = loadKey(binding.encryption && binding.encryption.client_private_key, true);
  const response = await fetchImpl(`${baseUrl}/password?name=${encodeURIComponent(name)}`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${binding.username}:${binding.password}`).toString("base64"),
      "sapcp-credstore-namespace": namespace,
    },
  });
  if (response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `credstore read failed: HTTP ${response.status}` +
      (response.status === 429 ? " (rate limit — wait a minute and retry)" : "")
    );
  }
  const credential = JSON.parse(decryptJweCompact(text, privateKey));
  return {
    name: credential.name || name,
    value: credential.value != null ? String(credential.value) : null,
    username: credential.username != null ? String(credential.username) : null,
  };
}

/**
 * Delete one password-type credential. A missing credential (HTTP 404) is
 * treated as success — delete is idempotent. Throws on any other failure
 * with a safe (secret-free) message.
 */
async function deleteCredential(binding, opts = {}, fetchImpl = fetch) {
  const namespace = opts.namespace || MANAGEMENT_NAMESPACE;
  const name = opts.name || MANAGEMENT_CREDENTIAL;
  const baseUrl = String(binding.url || "").replace(/\/+$/, "");
  if (!baseUrl || !binding.username || !binding.password) {
    throw new Error("credstore binding is missing url/username/password (was the instance created with basic authentication?)");
  }
  const response = await fetchImpl(`${baseUrl}/password?name=${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: {
      Authorization: "Basic " + Buffer.from(`${binding.username}:${binding.password}`).toString("base64"),
      "sapcp-credstore-namespace": namespace,
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `credstore delete failed: HTTP ${response.status}` +
      (response.status === 429 ? " (rate limit — wait a minute and retry)" : "")
    );
  }
}

module.exports = {
  MANAGEMENT_NAMESPACE,
  MANAGEMENT_CREDENTIAL,
  findCredstoreBinding,
  loadKey,
  decryptJweCompact,
  encryptJweCompact,
  readCredential,
  writeCredential,
  deleteCredential,
};
