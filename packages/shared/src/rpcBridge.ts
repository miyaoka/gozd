// preload の contextBridge で renderer に公開する RPC ブリッジの契約。
// renderer (`shared/rpc/client.ts`) と preload の両方が import する SSOT。
// renderer は `window.__gozdElectronRpc` 経由で request / push 購読を行う。

export interface ElectronRpcBridge {
  /**
   * `@gozd/rpc` の型を JSON.stringify した request body を送り、response の JSON 文字列を受け取る。
   * ハンドラ未実装・処理失敗は reject（renderer 側で throw に変換する契約）
   */
  request: (path: string, bodyJson: string) => Promise<string>;
  /**
   * main → renderer push の購読。type / payload は Swift shell 期の
   * `window.__gozdReceive(type, payload)` と同一契約（ワイヤ互換を維持）
   */
  onPush: (cb: (type: string, payload: unknown) => void) => void;
}
