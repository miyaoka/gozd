// preload の contextBridge で renderer に公開する RPC ブリッジの契約。
// renderer (`shared/rpc/client.ts`) と preload の両方が import する SSOT。
// renderer は `window.__gozdElectronRpc` 経由で request / push 購読を行う。

export interface ElectronRpcBridge {
  /**
   * `@gozd/rpc` の型の request body を送り、response を受け取る。ワイヤは Electron IPC の
   * structured clone（push 方向の `webContents.send` と同一の意味論）。
   *
   * body / response は plain data（JSON 形のオブジェクト / 配列 / プリミティブ + `Uint8Array`）
   * に限る。Vue の reactive proxy 等の exotic object は structured clone できず
   * `An object could not be cloned` で reject するため、呼び出し側が plain data を渡す
   * （laundering する変換層は持たない。混入は呼び出し側のバグとして即時に顕在化させる）。
   * main 側が返す `Buffer` は renderer には `Uint8Array` として届く。
   *
   * ハンドラ未実装・処理失敗は reject（renderer 側で throw に変換する契約）
   */
  request: (path: string, body: unknown) => Promise<unknown>;
  /**
   * main → renderer push の購読。type / payload は Swift shell 期の
   * `window.__gozdReceive(type, payload)` と同一契約（ワイヤ互換を維持）
   */
  onPush: (cb: (type: string, payload: unknown) => void) => void;
}
