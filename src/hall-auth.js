'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');

const TOKEN_HEADER = 'X-HC-Token';
const EXHIBITION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const PLACEHOLDER_TOKEN_PATTERN = /^(?:example-|replace[_-]?with|change[_-]?me)/i;

function parseTokenMap(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('HC_TOKEN_MAP must contain at least one token:exhibitionId entry');
  }

  const tokenMap = new Map();
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value) throw new Error('HC_TOKEN_MAP contains an empty entry');

    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('HC_TOKEN_MAP entries must use token:exhibitionId format');
    }

    const token = value.slice(0, separator).trim();
    const exhibitionId = value.slice(separator + 1).trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error('HC_TOKEN_MAP contains an invalid token (16-512 chars, no whitespace or comma)');
    }
    if (PLACEHOLDER_TOKEN_PATTERN.test(token)) {
      throw new Error('HC_TOKEN_MAP contains a placeholder token; replace it with a real secret');
    }
    if (!EXHIBITION_ID_PATTERN.test(exhibitionId)) {
      throw new Error('HC_TOKEN_MAP contains an invalid exhibitionId');
    }
    if (tokenMap.has(token)) throw new Error('HC_TOKEN_MAP contains a duplicate token');
    tokenMap.set(token, exhibitionId);
  }

  if (tokenMap.size === 0) throw new Error('HC_TOKEN_MAP must contain at least one token:exhibitionId entry');
  return tokenMap;
}

function tokenDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function resolveExhibitionId(presentedToken, tokenMap) {
  if (typeof presentedToken !== 'string') return null;
  const token = presentedToken.trim();
  if (!TOKEN_PATTERN.test(token)) return null;

  const presentedDigest = tokenDigest(token);
  let matched = null;
  for (const [configuredToken, exhibitionId] of tokenMap) {
    if (timingSafeEqual(presentedDigest, tokenDigest(configuredToken))) {
      matched = exhibitionId;
    }
  }
  return matched;
}

function readTokenHeader(request) {
  const value = request && request.headers ? request.headers[TOKEN_HEADER.toLowerCase()] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function authenticateRequest(request, tokenMap) {
  return resolveExhibitionId(readTokenHeader(request), tokenMap);
}

module.exports = {
  TOKEN_HEADER,
  parseTokenMap,
  resolveExhibitionId,
  readTokenHeader,
  authenticateRequest
};
