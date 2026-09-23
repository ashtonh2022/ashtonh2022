import { isIP, isIPv4 } from 'node:net';

/**
 * Where a connection comes from, for the per-IP limits in server.ts and the hub. Only this module
 * reads X-Forwarded-For; the hub is handed the resulting key.
 *
 * Behind reverse proxies the socket's address is the nearest proxy's, and each proxy appends the
 * address it received the request from to X-Forwarded-For. So the hops, oldest first, are the
 * header's entries followed by the socket's address, and with `trustProxy` proxies in front the
 * client is the entry `trustProxy` places left of the socket. Anything further left was written
 * by the client itself and proves nothing. With `trustProxy` 0 the header is not read at all.
 */

/** Reverse proxies in front of the server unless configured otherwise (env TRUST_PROXY). */
export const DEFAULT_TRUST_PROXY = 0;
/** The key of connections whose address cannot be read (they share one allowance). */
export const UNKNOWN_IP_KEY = 'unknown';

const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const BRACKETED = /^\[([^\]]*)\](?::\d{1,5})?$/;

/**
 * Normalises one address as a socket reports it or a proxy writes it: surrounding whitespace, a
 * port, brackets and an IPv6 zone are dropped, IPv6 is lower-cased and IPv4-mapped IPv6
 * (`::ffff:1.2.3.4`) becomes the IPv4 address. Null when it is not an IP address.
 */
export function parseIp(raw: string): string | null {
  let text = raw.trim();
  const bracketed = BRACKETED.exec(text);
  if (bracketed !== null) {
    text = bracketed[1] as string;
    if (!text.includes(':')) return null;
  } else {
    const withPort = IPV4_WITH_PORT.exec(text);
    if (withPort !== null) text = withPort[1] as string;
  }
  if (text.includes(':')) {
    const zone = text.indexOf('%');
    if (zone !== -1) text = text.slice(0, zone);
  }
  const version = isIP(text);
  if (version === 4) return text;
  if (version !== 6) return null;
  const groups = ipv6Groups(text);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] as number;
    const low = groups[7] as number;
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  }
  return text.toLowerCase();
}

/** The request's hops, oldest first: X-Forwarded-For entries, then the socket's address. */
/** Every hop the request came through: the X-Forwarded-For entries, then the socket's address. */
export function forwardedHops(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
): string[] {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  // Stray commas (`a,,b`, a trailing comma) are not hops.
  const entries = header
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  entries.push(remoteAddress ?? '');
  return entries;
}

/**
 * The client's address, given `trustProxy` reverse proxies in front of the server: the hop that
 * many places left of the socket's address (the first hop when there are fewer). When that hop
 * is not an address (a proxy wrote `unknown`, say) the nearest address to its right counts
 * instead, never one further left. Null when no hop from there on is an address.
 */
export function clientIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: number,
): string | null {
  const trusted = Number.isFinite(trustProxy) ? Math.max(0, Math.floor(trustProxy)) : 0;
  const list = trusted === 0 ? [remoteAddress ?? ''] : forwardedHops(forwardedFor, remoteAddress);
  for (let index = Math.max(0, list.length - 1 - trusted); index < list.length; index++) {
    const ip = parseIp(list[index] as string);
    if (ip !== null) return ip;
  }
  return null;
}

/**
 * The key per-IP limits are counted under: an IPv4 address as it is, an IPv6 address by its /64
 * prefix (one household or server gets a whole /64, so rotating addresses inside it must not
 * give anyone a fresh allowance). Expects an address from `parseIp`.
 */
export function ipLimitKey(ip: string): string {
  if (isIPv4(ip)) return ip;
  const groups = isIP(ip) === 6 ? ipv6Groups(ip) : null;
  if (groups === null) return ip;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

/** `ipLimitKey(clientIp(...))`, or UNKNOWN_IP_KEY when there is no address to go by. */
export function clientIpKey(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustProxy: number,
): string {
  const ip = clientIp(forwardedFor, remoteAddress, trustProxy);
  return ip === null ? UNKNOWN_IP_KEY : ipLimitKey(ip);
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, a dotted IPv4 tail split). */
function ipv6Groups(ip: string): number[] | null {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0] as string);
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = parse(halves[1] as string);
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}
