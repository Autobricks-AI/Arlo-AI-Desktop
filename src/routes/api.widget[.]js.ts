import { createFileRoute } from '@tanstack/react-router'

/**
 * The embeddable widget, served as one script.
 *
 *   <script src="https://arlo.example.com/api/widget.js?key=WIDGET_KEY" defer></script>
 *
 * One tag, no build step on the customer's site, no npm package to keep in sync with this
 * server. The script reads its own `src` for the key and the origin, so there is nothing
 * else to configure and nothing that can be configured wrongly.
 *
 * Everything is inline: styles in a shadow root so the host page's CSS cannot reach in and
 * ours cannot leak out, and no external requests beyond this origin's own /api/chat.
 *
 * ponytail: polls every two seconds while open. See channels/web.ts for why that is the
 * right amount of machinery for a support chat.
 */

const script = (origin: string) => `(function () {
  var tag = document.currentScript || document.querySelector('script[src*="/api/widget.js"]');
  if (!tag) return;
  var key = new URL(tag.src, location.href).searchParams.get('key');
  if (!key) return console.error('[arlo] no key in the widget script URL');
  var base = ${JSON.stringify(origin)};
  var api = base + '/api/chat?key=' + encodeURIComponent(key);

  // The visitor's own id. Kept in localStorage, so clearing it starts a fresh
  // conversation — which is what somebody on a shared computer should be able to do.
  var visitor;
  try {
    visitor = localStorage.getItem('arlo.visitor');
    if (!visitor) {
      visitor = Array.from(crypto.getRandomValues(new Uint8Array(18)))
        .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      localStorage.setItem('arlo.visitor', visitor);
    }
  } catch (e) {
    // Storage refused (private mode, blocked cookies). Still usable, just not across reloads.
    visitor = String(Date.now()) + Math.random().toString(16).slice(2, 10);
  }

  var host = document.createElement('div');
  host.setAttribute('data-arlo', '');
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Inter,system-ui,-apple-system,sans-serif}',
    '.launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;',
    '  border-radius:28px;border:0;background:#171717;color:#fff;font-size:22px;cursor:pointer;',
    '  box-shadow:0 6px 24px rgba(0,0,0,.22)}',
    '.panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:360px;max-width:calc(100vw - 40px);',
    '  height:480px;max-height:calc(100vh - 120px);display:none;flex-direction:column;background:#fff;',
    '  border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.24)}',
    '.panel.open{display:flex}',
    '.head{background:#171717;color:#fff;padding:12px 16px;font-weight:600;font-size:15px}',
    '.head small{display:block;font-weight:400;opacity:.75;font-size:12px}',
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#fafafa}',
    '.m{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;',
    '  overflow-wrap:anywhere}',
    '.m.in{align-self:flex-end;background:#171717;color:#fff;border-bottom-right-radius:3px}',
    '.m.out{align-self:flex-start;background:#fff;color:#171717;border:1px solid #ebebeb;border-bottom-left-radius:3px}',
    '.m.sys{align-self:center;background:none;color:#737373;font-size:12px;max-width:100%}',
    '.m .file{display:block;margin-top:6px;font-size:13px;font-weight:500;color:#2f6b5f;text-decoration:none;',
    '  overflow-wrap:anywhere}',
    '.m .file:hover{text-decoration:underline}',
    '.ask{display:flex;gap:8px;padding:10px;border-top:1px solid #ebebeb;background:#fff}',
    '.ask input{flex:1;padding:9px 11px;font-size:14px;border:1px solid #d4d4d4;border-radius:8px;color:#171717}',
    '.ask button{padding:9px 14px;font-size:14px;font-weight:500;border:0;border-radius:8px;background:#171717;',
    '  color:#fff;cursor:pointer}',
    '.ask button:disabled{opacity:.5;cursor:default}',
    '</style>',
    '<button class="launch" aria-label="Chat with us" aria-expanded="false">&#128172;</button>',
    '<div class="panel" role="dialog" aria-label="Chat">',
    '  <div class="head">Chat with us<small>Answers come from our own documentation.</small></div>',
    '  <div class="log" aria-live="polite"></div>',
    '  <form class="ask"><input placeholder="Ask a question" aria-label="Your message" autocomplete="off" required>',
    '  <button type="submit">Send</button></form>',
    '</div>'
  ].join('');

  var launch = root.querySelector('.launch');
  var panel = root.querySelector('.panel');
  var log = root.querySelector('.log');
  var form = root.querySelector('.ask');
  var input = form.querySelector('input');
  var button = form.querySelector('button');
  var seen = 0, timer = null, open = false;

  function bubble(kind, text, files) {
    var el = document.createElement('div');
    el.className = 'm ' + kind;
    el.textContent = text;
    // Built as nodes, never as markup. textContent is why nothing in a message can inject,
    // and a filename somebody uploaded must not become the one exception to that.
    (files || []).forEach(function (f) {
      var a = document.createElement('a');
      a.className = 'file';
      a.href = base + f.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = '\u{1F4CE} ' + f.name;
      el.appendChild(a);
    });
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function poll() {
    fetch(api + '&visitor=' + visitor + '&since=' + seen)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        (d.messages || []).forEach(function (m) {
          if (m.id <= seen) return;
          seen = m.id;
          // Our own sent message is already on screen; only render what came back.
          if (m.direction === 'out') bubble('out', m.body, m.files);
        });
        if (d.status === 'human' && !log.querySelector('[data-handoff]')) {
          bubble('sys', 'A person is picking this up.').setAttribute('data-handoff', '');
        }
      })
      .catch(function () { /* offline, or the tab slept. The next tick tries again. */ });
  }

  function toggle() {
    open = !open;
    panel.classList.toggle('open', open);
    launch.setAttribute('aria-expanded', String(open));
    clearInterval(timer);
    if (open) { poll(); timer = setInterval(poll, 2000); input.focus(); }
  }
  launch.addEventListener('click', toggle);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) toggle(); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    button.disabled = true;
    bubble('in', text);
    fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitor: visitor, text: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) bubble('sys', d.error); })
      .catch(function () { bubble('sys', 'That did not send. Try again?'); })
      .finally(function () { button.disabled = false; poll(); input.focus(); });
  });
})();`

export const Route = createFileRoute('/api/widget.js')({
  server: {
    handlers: {
      GET: ({ request }) => {
        // The origin the browser actually reached us on, so the widget calls back to the
        // same host it was loaded from — behind a proxy that is not what this process sees.
        const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
        const url = new URL(request.url)
        /*
 * `||`, not `??`. An empty `x-forwarded-proto` is not nullish, so `??` kept it and built
 * `://host` — not a URL — and every embedded widget silently failed to initialise. nginx
 * sends exactly that when configured as `proxy_set_header X-Forwarded-Proto $http_x_...`
 * and the inbound request had no such header. auth.ts:408 already gets this right.
 */
        const origin = process.env.PUBLIC_URL || `${forwarded || url.protocol.slice(0, -1)}://${url.host}`

        return new Response(script(origin.replace(/\/+$/, '')), {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'access-control-allow-origin': '*',
            // Short, because the key is in the URL and the script is not: a fix ships
            // within the hour without anybody clearing a cache.
            'cache-control': 'public, max-age=3600',
          },
        })
      },
    },
  },
})
