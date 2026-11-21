const codePattern = /^YAL-[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/;
const escape = value => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const storePattern = /^https:\/\/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[\w%-]+\/)?id\d+\/?$/i;

export async function invitePage(rawCode, env, fetcher = fetch) {
  const code = typeof rawCode === 'string' ? rawCode.toUpperCase() : '';
  let status = 404;
  let nickname;
  if (codePattern.test(code)) {
    status = 503;
    try {
      const base = new URL(env.FRIENDS_API_ORIGIN);
      if (base.protocol !== 'https:' || base.origin !== env.FRIENDS_API_ORIGIN) throw Error('Invalid API origin');
      const response = await fetcher(new URL('/invites/' + code, base), {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4500),
      });
      if (response.status === 404) status = 404;
      if (response.ok) {
        const result = await response.json();
        if (result.code === code && typeof result.nickname === 'string' && result.nickname.length > 0) {
          status = 200;
          nickname = result.nickname.slice(0,100);
        }
      }
    } catch { /* The visitor can copy the code while the backend is unavailable. */ }
  }

  const appStore = storePattern.test(env.APP_STORE_URL ?? '') ? env.APP_STORE_URL : null;
  const title = nickname ? `${escape(nickname)} invited you` : status === 404 ? 'Invite not found' : 'Join your friend';
  const codeMarkup = status !== 404 ? `
    <p class="code-label">Friend code</p>
    <div class="code-line"><code id="friend-code">${code}</code><button type="button" id="copy">Copy code</button></div>
    <p id="copy-status" role="status"></p>` : '';
  const installMarkup = appStore ? `<a class="store" href="${escape(appStore)}">Download on the App Store</a>` : '';
  const details = status === 404
    ? '<p>Ask your friend to share their invite again.</p>'
    : `<p>Match predictions, cross desert villages and compare your weekly distance with friends.</p>
       ${codeMarkup}${installMarkup}
       <p class="instructions">After installing, reopen this link or enter the code under <strong>Friends</strong> in the game menu.</p>
       ${status === 503 ? '<p class="notice">The inviter’s name is temporarily unavailable.</p>' : ''}`;
  return { status, html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#172235">
  <title>Yalla Journey · Friend invite</title>
  <link rel="stylesheet" href="/assets/invite.css">
  <script src="/assets/invite.js" defer></script>
</head>
<body>
  <main class="hero">
    <div class="invite">
      <img class="logo" src="/assets/yalla-logo.png" alt="Yalla Journey">
      <h1>${title}</h1>
      ${details}
    </div>
  </main>
</body>
</html>` };
}

export default async function handler(req, res) {
  const {status,html} = await invitePage(req.query.code,process.env);
  res.statusCode = status;
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',"default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.end(html);
}
