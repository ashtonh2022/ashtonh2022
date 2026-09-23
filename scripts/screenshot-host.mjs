// Where scripts/screenshots.mjs points the browser: a public-looking origin with no port, so the
// invite links in the shots read like a real deployment's (http://landlord.example/room/CODE).

export const HOSTNAME = 'landlord.example';
export const ORIGIN = `http://${HOSTNAME}`;

/**
 * Chromium launch options that send every request for HOSTNAME to the server on
 * 127.0.0.1:`port`. The resolver rule maps the port as well, so pages keep the origin ORIGIN
 * (port 80) whatever port the server listens on: no need for port 80 itself, which takes root on
 * Linux and may be taken.
 */
export function browserOptions(port) {
  return {
    args: [`--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1:${port}`],
    // Everything here is local. Chromium takes a proxy from these variables for WebSockets even
    // with --no-proxy-server, and a proxy cannot reach landlord.example.
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/_proxy$/i.test(name))),
  };
}

/** What is wrong with the invite link shown for room `code`; empty when it is right. */
export function inviteLinkProblems(link, code) {
  const problems = [];
  const expected = `${ORIGIN}/room/${code}`;
  if (link !== expected)
    problems.push(`invite link is ${JSON.stringify(link)}, expected ${expected}`);
  let url = null;
  try {
    url = new URL(link);
  } catch {
    problems.push('invite link is not a URL');
  }
  if (url !== null) {
    if (url.port !== '') problems.push(`invite link shows port ${url.port}`);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
      problems.push(`invite link shows ${url.hostname}`);
    }
  }
  return problems;
}
