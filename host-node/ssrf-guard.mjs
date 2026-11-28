// The outbound `fetch` of the Node host (#43). The BFF's URL guard rejects IP literals and
// private suffixes but never sees the address a name resolves to (`127.0.0.1.nip.io`). This
// guard checks the address at connect time, through undici's connector, so the IP that is
// checked is the IP that is dialled: DNS rebinding between a check and a fetch is impossible.

import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";

import { Agent, buildConnector } from "undici";

const blocked = new BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC 1918, Docker bridges
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
]) {
  blocked.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["fc00::", 7], // ULA
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
]) {
  blocked.addSubnet(prefix, bits, "ipv6");
}

/** Prefixes whose last 32 bits are an IPv4 address that is judged as such: IPv4-mapped, NAT64. */
const EMBEDS_IPV4 = /^(?:::ffff:(?:0:)?|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/i;

/** Hex-written embedded IPv4 (`::ffff:7f00:1`), as `dns.lookup` and `URL` may print it. */
const EMBEDS_IPV4_HEX = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/** Whether the host must never dial `address` (an IPv4 or IPv6 literal). */
export const isBlockedAddress = (address) => {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family !== 6) return true;
  const dotted = bare.match(EMBEDS_IPV4);
  if (dotted) return isIP(dotted[1]) !== 4 || blocked.check(dotted[1], "ipv4");
  const hex = bare.match(EMBEDS_IPV4_HEX);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return blocked.check(bare, "ipv6");
};

/** The error a blocked connect fails with. It names no address: only the host log sees it. */
export class BlockedAddressError extends Error {
  code = "ERR_SSRF_BLOCKED";
  constructor(hostname) {
    super(`Refusing to connect to ${hostname}: it resolves to a non-public address`);
  }
}

/**
 * A `net.connect` `lookup` that resolves every address of `hostname` and fails if any of them is
 * non-public (a mixed answer could otherwise be raced), then answers in the shape asked for.
 */
export const guardedLookup =
  (resolve = dnsLookup) =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(new BlockedAddressError(hostname));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };

/**
 * An undici connector that refuses blocked IP literals (no lookup runs for those) and dials
 * names through `guardedLookup`.
 */
export const guardedConnector = ({ resolve } = {}) => {
  const connect = buildConnector({ lookup: guardedLookup(resolve) });
  return (options, callback) => {
    if (isIP(options.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(options.hostname)) {
      return callback(new BlockedAddressError(options.hostname), null);
    }
    return connect(options, callback);
  };
};

/** The guarded `fetch` the Node host injects into the BFF. */
export const createGuardedFetch = ({ resolve } = {}) => {
  const dispatcher = new Agent({ connect: guardedConnector({ resolve }) });
  return (request) => fetch(request, { dispatcher });
};
