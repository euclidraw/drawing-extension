const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const identifier = value =>
  typeof value === 'string'
  && value.length <= 160
  && /^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(value)
  && !value.split('.').some(part => reserved.has(part));
const safeName = value =>
  typeof value === 'string'
  && value.length <= 160
  && /^[\w.:-]+$/.test(value)
  && !value.split(/[.:]/).some(part => !part || reserved.has(part));
const record = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function release(value) {
  const match = typeof value === 'string' && releasePattern.exec(value);
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`Expected release SemVer MAJOR.MINOR.PATCH: ${value}`);
  }
}

/** Match the host's release-only grammar; the host resolves version compatibility. */
export function validateRange(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) {
    throw new Error('Dependency ranges must be nonempty strings of at most 200 characters.');
  }
  for (const branch of value.split('||')) {
    const source = branch.trim();
    if (!source) throw new Error(`Invalid SemVer range: ${value}`);
    const token = /(\^|~|>=|<=|>|<|=)?\s*(\*|(?:0|[1-9]\d*|[xX])(?:\.(?:0|[1-9]\d*|[xX*])){0,2})(?=\s|$)/y;
    let index = 0;
    while (index < source.length) {
      token.lastIndex = index;
      const match = token.exec(source);
      if (!match) throw new Error(`Invalid or unsupported SemVer range: ${value}`);
      const parts = match[2].split('.');
      const wildcard = parts.findIndex(part => /^[xX*]$/.test(part));
      if (wildcard < 0) {
        release(match[2]);
      } else if (
        (match[1] && match[1] !== '=')
        || parts.slice(wildcard).some(part => !/^[xX*]$/.test(part))
        || parts.slice(0, wildcard).some(part => !Number.isSafeInteger(Number(part)))
      ) {
        throw new Error(`Invalid SemVer range: ${value}`);
      }
      index = token.lastIndex;
      while (index < source.length && /\s/.test(source[index])) index++;
    }
  }
}

function list(value, name, valid = safeName) {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !valid(item)) || new Set(value).size !== value.length) {
    throw new Error(`extension.json requires a valid unique ${name} array.`);
  }
}

export function validateConfig(metadata) {
  if (!record(metadata) || !identifier(metadata.id) || /^(core|computed|script)\./.test(metadata.id)) {
    throw new Error('extension.json id must be a nonreserved dotted namespace, e.g. drawing.freehand.');
  }
  if (!identifier(`${metadata.id}.stroke`)) {
    throw new Error('The generated stroke aspect ID must be at most 160 characters.');
  }
  for (const [key, limit] of [['title', 120], ['summary', 600]]) {
    if (typeof metadata[key] !== 'string' || !metadata[key].trim() || metadata[key].length > limit) {
      throw new Error(`extension.json requires ${key} (at most ${limit} characters).`);
    }
  }
  release(metadata.version);
  validateRange(metadata.engine);
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (!record(metadata[key]) || Object.keys(metadata[key]).length > 100) {
      throw new Error(`extension.json requires a ${key} object.`);
    }
    for (const [id, range] of Object.entries(metadata[key])) {
      if (!identifier(id) || id === metadata.id) throw new Error(`Invalid ${key} extension ID: ${id}`);
      validateRange(range);
    }
  }
  for (const id of Object.keys(metadata.dependencies)) {
    if (Object.hasOwn(metadata.optionalDependencies, id)) {
      throw new Error(`Dependency ${id} cannot be required and optional.`);
    }
  }
  list(metadata.conflicts, 'conflicts', identifier);
  if (metadata.conflicts.includes(metadata.id)) {
    throw new Error('An extension cannot conflict with itself.');
  }
  if (!record(metadata.provides) || Object.keys(metadata.provides).some(key => !['services', 'hsmSlots'].includes(key))) {
    throw new Error('extension.json provides must declare services and hsmSlots; aspect IDs are generated in src/manifest.js.');
  }
  list(metadata.provides.services, 'provides.services');
  list(metadata.provides.hsmSlots, 'provides.hsmSlots');
  return metadata;
}
