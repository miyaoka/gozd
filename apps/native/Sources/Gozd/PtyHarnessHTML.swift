import Foundation

// `swift run` 直叩きなど `.app` バンドル無し起動時の fallback。renderer の Vite dist /
// 開発 server がどちらも無いとき、xterm.js + 単一 PTY + UTF-8 境界ストレステスト +
// Socket inbound 検証用の最小 HTML harness をロードする。Phase 3 (PTY) 検証用の遺産で、
// production code path では呼ばれない。

func ptyHarnessHTML(socketPath: String) -> String {
  let userHome = FileManager.default.homeDirectoryForCurrentUser.path
  return """
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
      <style>
        body { font-family: -apple-system, sans-serif; margin: 0; padding: 12px; background: #1e1e1e; color: #eee; }
        .row { margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        button { padding: 6px 10px; font-size: 13px; }
        #term { background: #000; padding: 4px; height: 380px; }
        .status { font-size: 12px; color: #888; }
        h2 { font-size: 13px; margin: 16px 0 4px; color: #aaa; text-transform: uppercase; letter-spacing: 0.05em; }
        #socketLog { background: #111; border: 1px solid #333; padding: 6px; font-family: Menlo, monospace; font-size: 11px; height: 140px; overflow: auto; white-space: pre-wrap; }
        code { background: #111; padding: 2px 4px; border-radius: 3px; font-size: 11px; }
      </style>
    </head>
    <body>
      <h2>PTY</h2>
      <div class="row">
        <button onclick="ptySpawn()">spawn /bin/zsh</button>
        <button onclick="ptyKill()" id="killBtn" disabled>kill (SIGHUP)</button>
        <span class="status" id="status">no pty</span>
      </div>
      <div class="row">
        <button onclick="stress('emoji')">stress: 100k 🍣</button>
        <button onclick="stress('mixed')">stress: 50k mixed</button>
        <button onclick="stress('cjk')">stress: 100k CJK</button>
        <button onclick="echoMb()">echo 日本語🍣</button>
      </div>
      <div id="term"></div>

      <h2>Socket inbound (Unix Domain Socket NDJSON)</h2>
      <div class="row">
        <span class="status">socket: <code id="sockPath">\(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"hook":{"event":"session-start","ptyId":1}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div class="row">
        <span class="status">test: <code>echo '{"open":{"targetPath":"/path/to/repo"}}' | nc -w 1 -U \(socketPath)</code></span>
      </div>
      <div id="socketLog"></div>

      <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
      <script>
        const term = new Terminal({
          fontFamily: 'Menlo, monospace',
          fontSize: 12,
          theme: { background: '#000000', foreground: '#dddddd' },
          cursorBlink: true,
          convertEol: false,
          scrollback: 10000,
        });
        const fit = new FitAddon.FitAddon();
        term.loadAddon(fit);
        const termEl = document.getElementById('term');
        term.open(termEl);
        fit.fit();
        term.focus();
        termEl.addEventListener('click', () => term.focus());

        let currentPtyId = null;

        async function rpc(path, body) {
          const res = await fetch(`gozd-rpc://localhost${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`RPC ${path} failed: ${res.status} ${text}`);
          }
          return res.json();
        }

        async function ptySpawn() {
          if (currentPtyId !== null) return;
          term.reset();
          term.options.cursorBlink = true;
          const env = {
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            HOME: '\(userHome)',
            PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          };
          const out = await rpc('/pty/spawn', {
            dir: '\(userHome)',
            executable: '/bin/zsh',
            args: ['/bin/zsh', '-i'],
            env,
            rows: term.rows,
            cols: term.cols,
          });
          currentPtyId = Number(out.ptyId);
          document.getElementById('status').textContent = 'pty id=' + currentPtyId;
          document.getElementById('killBtn').disabled = false;
        }

        async function ptyKill() {
          if (currentPtyId === null) return;
          await rpc('/pty/kill', { ptyId: currentPtyId });
        }

        async function ptyWriteText(s) {
          if (currentPtyId === null) return;
          const bytes = new TextEncoder().encode(s);
          let bin = '';
          for (const b of bytes) bin += String.fromCharCode(b);
          await rpc('/pty/write', { ptyId: currentPtyId, data: btoa(bin) });
        }

        term.onData((s) => { ptyWriteText(s); });

        async function echoMb() {
          await ptyWriteText('echo 日本語あいうえお🍣🍱🍙🍡\\n');
        }

        async function stress(kind) {
          let cmd = '';
          if (kind === 'emoji') {
            cmd = `python3 -c "import sys; sys.stdout.write('🍣' * 100000)"\\n`;
          } else if (kind === 'mixed') {
            cmd = `python3 -c "import sys; sys.stdout.write(('あいうえお🍣 sushi 寿司🍱🍙🍡🍵 hello world\\\\n') * 50000)"\\n`;
          } else if (kind === 'cjk') {
            cmd = `python3 -c "import sys; sys.stdout.write('一二三四五六七八九十' * 10000)"\\n`;
          }
          await ptyWriteText(cmd);
        }

        const socketLog = document.getElementById('socketLog');
        function logSocket(line) {
          const ts = new Date().toISOString().slice(11, 23);
          socketLog.textContent = `[${ts}] ${line}\\n` + socketLog.textContent;
        }

        window.__gozdReceive = function(type, payload) {
          if (type === 'ptyText') {
            if (payload.id !== currentPtyId) return;
            term.write(payload.text);
          } else if (type === 'ptyExit') {
            const r = payload.reason;
            const desc = r.kind === 'exited'
              ? `exit code ${r.exitCode}`
              : r.kind === 'signaled'
                ? `killed by signal ${r.signal}${r.coreDumped ? ' (core)' : ''}`
                : `stopped`;
            term.write(`\\r\\n\\x1b[33m[pty:${payload.id} ${desc}]\\x1b[0m\\r\\n`);
            term.options.cursorBlink = false;
            if (payload.id === currentPtyId) {
              currentPtyId = null;
              document.getElementById('status').textContent = 'no pty';
              document.getElementById('killBtn').disabled = true;
            }
          } else if (type === 'hook') {
            logSocket('hook ' + JSON.stringify(payload));
          } else if (type === 'gozdOpen') {
            logSocket('gozdOpen ' + JSON.stringify(payload));
          }
        };

        window.addEventListener('resize', () => {
          fit.fit();
          if (currentPtyId !== null) {
            rpc('/pty/resize', { ptyId: currentPtyId, rows: term.rows, cols: term.cols });
          }
        });
      </script>
    </body>
    </html>
    """
}
