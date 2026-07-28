/**
 * Access-token verification — the direct-mode auth contract.
 *
 * The PLATFORM mints short-lived RS256 tokens (backend/core/security.py
 * `create_game_access_token`) with claims: iss `usion-backend`,
 * aud `usion-game-service:<service_id>`, sub `<user_id>`, `room_id`,
 * `session_id`, `permissions ['play']`. A world server only VERIFIES — it
 * never issues tokens and never trusts anything the client says about its own
 * identity or which room it is in.
 *
 * Keys come from the platform JWKS. `publicKeyPem` replaces it for tests and
 * local dev so the whole loop runs with no backend.
 */
import { createRemoteJWKSet, importSPKI, jwtVerify } from 'jose';

const JWKS_TIMEOUT_MS = 15000;
const JWKS_CACHE_MAX_AGE_MS = 300000;
const JWKS_COOLDOWN_MS = 1000;

function isKeyRotationError(err) {
  const name = err?.name || '';
  const msg = String(err?.message || '');
  return (
    name === 'JWSSignatureVerificationFailed' ||
    name === 'JWKSNoMatchingKey' ||
    msg.includes('signature verification failed') ||
    msg.includes('no applicable key')
  );
}

export function createVerifier({
  serviceId,
  jwksUrl = null,
  publicKeyPem = null,
  issuer = 'usion-backend',
  audiencePrefix = 'usion-game-service:',
}) {
  if (!serviceId) throw new Error('createVerifier: serviceId is required');
  if (!jwksUrl && !publicKeyPem) throw new Error('createVerifier: need jwksUrl or publicKeyPem');

  let remoteJwks = null;
  let localKeyPromise = null;

  function getRemoteJwks(forceRefresh = false) {
    if (forceRefresh || !remoteJwks) {
      remoteJwks = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: JWKS_TIMEOUT_MS,
        cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
        cooldownDuration: JWKS_COOLDOWN_MS,
      });
    }
    return remoteJwks;
  }

  const verifyOptions = {
    issuer,
    audience: `${audiencePrefix}${serviceId}`,  // a token minted for another game is rejected
    algorithms: ['RS256'],                      // RS256 only — no alg-confusion downgrade
    clockTolerance: 60,
  };

  async function verifyRaw(token) {
    if (publicKeyPem) {
      if (!localKeyPromise) localKeyPromise = importSPKI(publicKeyPem, 'RS256');
      return jwtVerify(token, await localKeyPromise, verifyOptions);
    }
    try {
      return await jwtVerify(token, getRemoteJwks(), verifyOptions);
    } catch (err) {
      // A backend restart can rotate key material under the same kid: refresh
      // the JWKS once before failing the player's connection.
      if (!isKeyRotationError(err)) throw err;
      return jwtVerify(token, getRemoteJwks(true), verifyOptions);
    }
  }

  return {
    async verify(token) {
      const { payload } = await verifyRaw(token);
      if (!Array.isArray(payload.permissions) || !payload.permissions.includes('play')) {
        throw new Error("Token missing 'play' permission");
      }
      if (!payload.sub) throw new Error('Token missing sub');
      if (!payload.room_id) throw new Error('Token missing room_id');
      if (!payload.session_id) throw new Error('Token missing session_id');
      if (payload.service_id && String(payload.service_id) !== serviceId) {
        throw new Error(`Token service_id mismatch: ${payload.service_id}`);
      }
      return {
        userId: String(payload.sub),
        name: String(payload.name || payload.preferred_username || payload.username || 'Player').slice(0, 24),
        roomId: String(payload.room_id),   // the PLATFORM owns membership — never the client envelope
        sessionId: String(payload.session_id),
        serviceId,
      };
    },
  };
}
