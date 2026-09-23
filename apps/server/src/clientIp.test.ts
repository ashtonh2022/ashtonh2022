import { describe, expect, it } from 'vitest';

import { clientIp, clientIpKey, ipLimitKey, parseIp } from './clientIp';

describe('clientIp', () => {
  it('ignores X-Forwarded-For entirely when no proxy is trusted (clients can spoof it)', () => {
    expect(clientIp('203.0.113.9', '198.51.100.1', 0)).toBe('198.51.100.1');
    expect(clientIp('203.0.113.9, 192.0.2.4', '198.51.100.1', 0)).toBe('198.51.100.1');
    expect(clientIp(undefined, '198.51.100.1', 0)).toBe('198.51.100.1');
  });

  it('takes the last entry behind one proxy and the second to last behind two', () => {
    // A client-supplied entry comes first; each proxy appends the address it saw.
    expect(clientIp('6.6.6.6, 203.0.113.9', '10.0.0.2', 1)).toBe('203.0.113.9');
    expect(clientIp('6.6.6.6, 203.0.113.9, 10.0.0.1', '10.0.0.2', 2)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', '10.0.0.2', 1)).toBe('203.0.113.9');
    // Several header lines are read in order.
    expect(clientIp(['6.6.6.6', '203.0.113.9'], '10.0.0.2', 1)).toBe('203.0.113.9');
  });

  it('clamps to the first hop when there are fewer hops than trusted proxies', () => {
    expect(clientIp(undefined, '198.51.100.1', 1)).toBe('198.51.100.1');
    expect(clientIp('203.0.113.9', '10.0.0.2', 5)).toBe('203.0.113.9');
    expect(clientIp('', '198.51.100.1', 3)).toBe('198.51.100.1');
  });

  it('treats a fractional or negative TRUST_PROXY as a whole number of at least 0', () => {
    expect(clientIp('203.0.113.9', '10.0.0.2', 1.7)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9', '10.0.0.2', -1)).toBe('10.0.0.2');
    expect(clientIp('203.0.113.9', '10.0.0.2', Number.NaN)).toBe('10.0.0.2');
  });

  it('skips empty entries and falls back towards the server past malformed ones', () => {
    // Stray commas are not hops.
    expect(clientIp(' , 203.0.113.9 ,, ', '10.0.0.2', 1)).toBe('203.0.113.9');
    expect(clientIp('203.0.113.9,,10.0.0.1', '10.0.0.2', 2)).toBe('203.0.113.9');
    // A proxy that writes something that is not an address: count under the next hop instead,
    // never under anything further left (which the client controls).
    expect(clientIp('203.0.113.9, unknown', '10.0.0.2', 1)).toBe('10.0.0.2');
    expect(clientIp('203.0.113.9, 999.1.1.1', '10.0.0.2', 1)).toBe('10.0.0.2');
    expect(clientIp('203.0.113.9, garbage, 10.0.0.1', '10.0.0.2', 2)).toBe('10.0.0.1');
    expect(clientIp(undefined, undefined, 0)).toBeNull();
    expect(clientIp('nonsense', undefined, 1)).toBeNull();
  });

  it('reads ports, brackets and zones the way proxies and sockets write them', () => {
    expect(parseIp('203.0.113.9:4711')).toBe('203.0.113.9');
    expect(parseIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(parseIp('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(parseIp('fe80::1%eth0')).toBe('fe80::1');
    expect(parseIp(' 198.51.100.1 ')).toBe('198.51.100.1');
    expect(parseIp('')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('01.2.3.4')).toBeNull();
    expect(parseIp('example.com')).toBeNull();
    expect(parseIp('[1.2.3.4]')).toBeNull();
  });

  it('turns IPv4-mapped IPv6 into plain IPv4', () => {
    expect(parseIp('::ffff:198.51.100.1')).toBe('198.51.100.1');
    expect(parseIp('::FFFF:c633:6401')).toBe('198.51.100.1');
    expect(parseIp('[::ffff:198.51.100.1]:80')).toBe('198.51.100.1');
    expect(clientIp(undefined, '::ffff:127.0.0.1', 0)).toBe('127.0.0.1');
    expect(clientIp('::ffff:203.0.113.9', '::ffff:10.0.0.2', 1)).toBe('203.0.113.9');
    expect(clientIpKey(undefined, '::ffff:198.51.100.1', 0)).toBe(
      clientIpKey(undefined, '198.51.100.1', 0),
    );
  });

  it('keys IPv4 by the whole address and IPv6 by its /64 prefix', () => {
    expect(ipLimitKey('198.51.100.1')).toBe('198.51.100.1');
    expect(ipLimitKey('198.51.100.2')).not.toBe(ipLimitKey('198.51.100.1'));
    const home = ipLimitKey('2001:db8:aa:bb::1');
    expect(home).toBe('2001:db8:aa:bb::/64');
    // Rotating addresses inside one /64 does not give a new key, however they are written.
    expect(ipLimitKey('2001:db8:aa:bb:ffff:1234:5678:9abc')).toBe(home);
    expect(ipLimitKey('2001:0db8:00aa:00bb:0:0:0:2')).toBe(home);
    expect(ipLimitKey('2001:DB8:AA:BB::7')).toBe(home);
    // The neighbouring /64 is somebody else.
    expect(ipLimitKey('2001:db8:aa:bc::1')).not.toBe(home);
    expect(ipLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(ipLimitKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
    expect(clientIpKey('2001:db8:aa:bb::9', '10.0.0.2', 1)).toBe(home);
    expect(clientIpKey('[2001:db8:aa:bb::9]:1234', '10.0.0.2', 1)).toBe(home);
  });

  it('gives every connection without a readable address one shared key', () => {
    expect(clientIpKey(undefined, undefined, 0)).toBe('unknown');
    expect(clientIpKey('garbage', undefined, 1)).toBe('unknown');
  });
});
