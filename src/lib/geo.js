/**
 * Dependency-free Geohash utilities for Cloudflare Workers and the PWA.
 *
 * Companies store seven-character hashes. Radar scans query the target's
 * six-character cell plus its eight cardinal/intercardinal neighboring cells.
 */

export const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

const BITS = [16, 8, 4, 2, 1];
const MIN_PRECISION = 1;
const MAX_PRECISION = 12;
const POLAR_EPSILON = 1e-12;

/**
 * Neighbor order is stable and is part of the public contract:
 * north, north-east, east, south-east, south, south-west, west, north-west.
 */
const NEIGHBOR_OFFSETS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1]
];

function assertCoordinate(value, name, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }

  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

function assertPrecision(precision) {
  if (typeof precision !== 'number' || !Number.isInteger(precision)) {
    throw new TypeError('precision must be an integer');
  }

  if (precision < MIN_PRECISION || precision > MAX_PRECISION) {
    throw new RangeError(
      `precision must be between ${MIN_PRECISION} and ${MAX_PRECISION}`
    );
  }
}

function normalizeGeohash(geohash) {
  if (typeof geohash !== 'string') {
    throw new TypeError('geohash must be a string');
  }

  const normalized = geohash.trim().toLowerCase();

  if (
    normalized.length < MIN_PRECISION
    || normalized.length > MAX_PRECISION
  ) {
    throw new RangeError(
      `geohash length must be between ${MIN_PRECISION} and ${MAX_PRECISION}`
    );
  }

  for (const character of normalized) {
    if (!GEOHASH_BASE32.includes(character)) {
      throw new RangeError(`geohash contains invalid character: ${character}`);
    }
  }

  return normalized;
}

function wrapLongitude(longitude) {
  const wrapped = (
    ((longitude + 180) % 360 + 360) % 360
  ) - 180;

  return Object.is(wrapped, -0) ? 0 : wrapped;
}

function clampLatitude(latitude) {
  return Math.max(
    -90 + POLAR_EPSILON,
    Math.min(90 - POLAR_EPSILON, latitude)
  );
}

/**
 * Encode WGS84 coordinates as a standard lowercase Geohash.
 *
 * @param {number} latitude WGS84 latitude in the inclusive range [-90, 90].
 * @param {number} longitude WGS84 longitude in the inclusive range [-180, 180].
 * @param {number} [precision=7] Number of Geohash characters, from 1 through 12.
 * @returns {string}
 * @throws {TypeError} For non-numeric/non-finite coordinates or non-integer precision.
 * @throws {RangeError} For coordinates or precision outside their valid ranges.
 */
export function encodeGeohash(latitude, longitude, precision = 7) {
  assertCoordinate(latitude, 'latitude', -90, 90);
  assertCoordinate(longitude, 'longitude', -180, 180);
  assertPrecision(precision);

  let latitudeMinimum = -90;
  let latitudeMaximum = 90;
  let longitudeMinimum = -180;
  let longitudeMaximum = 180;

  let useLongitude = true;
  let bitCount = 0;
  let characterValue = 0;
  let geohash = '';

  while (geohash.length < precision) {
    let highHalf;

    if (useLongitude) {
      const midpoint = (longitudeMinimum + longitudeMaximum) / 2;
      highHalf = longitude >= midpoint;

      if (highHalf) {
        longitudeMinimum = midpoint;
      } else {
        longitudeMaximum = midpoint;
      }
    } else {
      const midpoint = (latitudeMinimum + latitudeMaximum) / 2;
      highHalf = latitude >= midpoint;

      if (highHalf) {
        latitudeMinimum = midpoint;
      } else {
        latitudeMaximum = midpoint;
      }
    }

    characterValue = (characterValue << 1) | (highHalf ? 1 : 0);
    bitCount += 1;
    useLongitude = !useLongitude;

    if (bitCount === 5) {
      geohash += GEOHASH_BASE32[characterValue];
      bitCount = 0;
      characterValue = 0;
    }
  }

  return geohash;
}

/**
 * Decode a Geohash into its bounding cell.
 *
 * Uppercase input and surrounding whitespace are normalized. Returned hashes
 * and all encoder output remain lowercase.
 *
 * @param {string} geohash A 1-12 character standard Geohash.
 * @returns {{
 *   geohash: string,
 *   minLatitude: number,
 *   maxLatitude: number,
 *   minLongitude: number,
 *   maxLongitude: number,
 *   centerLatitude: number,
 *   centerLongitude: number,
 *   latitudeSpan: number,
 *   longitudeSpan: number
 * }}
 */
export function decodeGeohashBounds(geohash) {
  const normalized = normalizeGeohash(geohash);

  let minLatitude = -90;
  let maxLatitude = 90;
  let minLongitude = -180;
  let maxLongitude = 180;
  let useLongitude = true;

  for (const character of normalized) {
    const characterValue = GEOHASH_BASE32.indexOf(character);

    for (const mask of BITS) {
      if (useLongitude) {
        const midpoint = (minLongitude + maxLongitude) / 2;

        if ((characterValue & mask) !== 0) {
          minLongitude = midpoint;
        } else {
          maxLongitude = midpoint;
        }
      } else {
        const midpoint = (minLatitude + maxLatitude) / 2;

        if ((characterValue & mask) !== 0) {
          minLatitude = midpoint;
        } else {
          maxLatitude = midpoint;
        }
      }

      useLongitude = !useLongitude;
    }
  }

  return {
    geohash: normalized,
    minLatitude,
    maxLatitude,
    minLongitude,
    maxLongitude,
    centerLatitude: (minLatitude + maxLatitude) / 2,
    centerLongitude: (minLongitude + maxLongitude) / 2,
    latitudeSpan: maxLatitude - minLatitude,
    longitudeSpan: maxLongitude - minLongitude
  };
}

/**
 * Return the eight cells surrounding a Geohash.
 *
 * The output order is:
 * N, NE, E, SE, S, SW, W, NW.
 *
 * Longitude wraps across the antimeridian. Latitude is clamped at the poles;
 * callers still receive eight directional entries, although extreme polar
 * cells can map more than one direction to the same physical Geohash.
 *
 * @param {string} geohash
 * @returns {string[]}
 */
export function getGeohashNeighbors(geohash) {
  const bounds = decodeGeohashBounds(geohash);
  const precision = bounds.geohash.length;

  return NEIGHBOR_OFFSETS.map(([latitudeOffset, longitudeOffset]) => {
    const latitude = clampLatitude(
      bounds.centerLatitude + latitudeOffset * bounds.latitudeSpan
    );
    const longitude = wrapLongitude(
      bounds.centerLongitude + longitudeOffset * bounds.longitudeSpan
    );

    return encodeGeohash(latitude, longitude, precision);
  });
}

/**
 * Generate the nine prefixes bound to the radar D1 `IN` query.
 *
 * Index zero is the target cell. Indexes 1-8 follow the documented neighbor
 * order from getGeohashNeighbors().
 *
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} [precision=6]
 * @returns {string[]} Exactly nine entries.
 */
export function getGeohashQueryCells(
  latitude,
  longitude,
  precision = 6
) {
  const center = encodeGeohash(latitude, longitude, precision);
  return [center, ...getGeohashNeighbors(center)];
}