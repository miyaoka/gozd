// Electron shell が preload の contextBridge で renderer に公開する RPC ブリッジの契約。
// renderer (`shared/rpc/client.ts`) と Electron preload の両方が import する SSOT。
// renderer は `window.__gozdElectronRpc` の有無でシェルを判定し、存在すればこの経路、
// 無ければ Swift shell の fetch(gozd-rpc://) 経路を使う（エラー時の fallback ではなく
// 起動シェルによる静的な二者択一）。

export interface ElectronRpcBridge {
  /**
   * proto3 JSON 文字列の request body を送り、response の proto3 JSON 文字列を受け取る。
   * ハンドラ未実装・処理失敗は reject（Swift shell の HTTP 4xx/5xx → throw と同じ扱い）
   */
  request: (path: string, bodyJson: string) => Promise<string>;
  /**
   * main → renderer push の購読。type / payload は Swift shell の
   * `window.__gozdReceive(type, payload)` と同一契約
   */
  onPush: (cb: (type: string, payload: unknown) => void) => void;
}
